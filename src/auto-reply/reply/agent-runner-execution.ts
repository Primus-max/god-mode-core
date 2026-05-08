import crypto from "node:crypto";
import fs from "node:fs";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import { runCliAgent } from "../../agents/cli-runner.js";
import { getCliSessionId } from "../../agents/cli-session.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { deriveTurnModalityRequirements } from "../../agents/model-fallback-modality.js";
import { isCliProvider } from "../../agents/model-selection.js";
import {
  BILLING_ERROR_USER_MESSAGE,
  isCompactionFailureError,
  isContextOverflowError,
  isBillingErrorMessage,
  isFailoverErrorMessage,
  isLikelyContextOverflowError,
  isTransientHttpError,
  sanitizeUserFacingText,
} from "../../agents/pi-embedded-helpers.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import { userFacingToolPolicyOrTransientMessage } from "../../agents/tool-error-sanitizer.js";
import {
  resolveGroupSessionKey,
  resolveSessionTranscriptPath,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { emitAgentEvent, registerAgentRunContext } from "../../infra/agent-events.js";
import type { ConcurrentTurnBroker } from "../../platform/broker/index.js";
import { getProcessConcurrentTurnBroker } from "../../server/concurrent-turn-broker-bootstrap.js";
import { asIdentityId, type IdentityId } from "../../platform/identity/identity-id.js";
import { toPluginHookPlatformExecutionContext } from "../../platform/recipe/runtime-adapter.js";
import { defaultRuntime } from "../../runtime.js";
import {
  isMarkdownCapableMessageChannel,
  resolveMessageChannel,
} from "../../utils/message-channel.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import {
  HEARTBEAT_TOKEN,
  isSilentReplyPrefixText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
} from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  filterWebSearchFromTools,
  hasWebSearchSignal,
  maybeFetchWebEvidence,
} from "../../platform/decision/web-evidence-prefetch.js";
import {
  buildEmbeddedRunExecutionParams,
  resolveRoutingSnapshotForTemplateRun,
  resolveModelFallbackOptions,
} from "./agent-runner-utils.js";
import { type BlockReplyPipeline } from "./block-reply-pipeline.js";
import { dispatchTurnViaBroker } from "./dispatch-turn-via-broker.js";
import {
  deriveBrokerRetryAfterMs,
  formatBrokerOverflowReply,
} from "./format-broker-overflow-reply.js";
import type { FollowupRun } from "./queue.js";
import { createBlockReplyDeliveryHandler } from "./reply-delivery.js";
import { createReplyMediaPathNormalizer } from "./reply-media-paths.runtime.js";
import type { TypingSignaler } from "./typing-mode.js";

export type RuntimeFallbackAttempt = {
  provider: string;
  model: string;
  error: string;
  reason?: string;
  status?: number;
  code?: string;
};

export type AgentRunLoopResult =
  | {
      kind: "success";
      runId: string;
      runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
      fallbackProvider?: string;
      fallbackModel?: string;
      fallbackAttempts: RuntimeFallbackAttempt[];
      didLogHeartbeatStrip: boolean;
      autoCompactionCount: number;
      /** Payload keys sent directly (not via pipeline) during tool flush. */
      directlySentBlockKeys?: Set<string>;
    }
  | { kind: "final"; payload: ReplyPayload };

export async function runAgentTurnWithFallback(params: {
  commandBody: string;
  followupRun: FollowupRun;
  sessionCtx: TemplateContext;
  opts?: GetReplyOptions;
  typingSignals: TypingSignaler;
  blockReplyPipeline: BlockReplyPipeline | null;
  blockStreamingEnabled: boolean;
  blockReplyChunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
    flushOnParagraph?: boolean;
  };
  resolvedBlockStreamingBreak: "text_end" | "message_end";
  applyReplyToMode: (payload: ReplyPayload) => ReplyPayload;
  shouldEmitToolResult: () => boolean;
  shouldEmitToolOutput: () => boolean;
  pendingToolTasks: Set<Promise<void>>;
  resetSessionAfterCompactionFailure: (reason: string) => Promise<boolean>;
  resetSessionAfterRoleOrderingConflict: (reason: string) => Promise<boolean>;
  isHeartbeat: boolean;
  sessionKey?: string;
  getActiveSessionEntry: () => SessionEntry | undefined;
  activeSessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  resolvedVerboseLevel: VerboseLevel;
  /** Structural hook before tool flush — external block buffering (PR-A.2); no text inspection. */
  onStructuralToolExecutionStarting?: () => void | Promise<void>;
  /**
   * Invoked once, right after the routing snapshot is resolved, when the
   * planner flagged this turn as `ackThenDefer` (P1.4 D.2). Implementations
   * are expected to:
   *   - emit a `ack_deferred` progress frame,
   *   - deliver an immediate "принял, работаю" ack reply,
   *   - mark the run as a deferred bg-job on the follow-up queue.
   * The async contract is awaited so the immediate reply races ahead of any
   * downstream agent call. Errors are swallowed — a failed ack must never
   * block the actual work.
   */
  onAckThenDefer?: (context: {
    runId: string;
    estimatedDurationMs?: number;
    requiredCapabilities?: string[];
    requestedToolNames?: string[];
  }) => Promise<void> | void;
  /**
   * Slice "PR-MT concurrent broker" — Phase 5 wiring.
   *
   * Optional process-scoped `ConcurrentTurnBroker` instance. When supplied
   * (Phase 5b/6 will bind a default at bootstrap), the entire turn body is
   * routed through `dispatchTurnViaBroker(...)` so per-`(identityId,
   * channelKey)` FIFO + cross-key concurrency apply. When undefined, the
   * helper bypasses to a direct invocation that is byte-identical to the
   * pre-broker dispatch path — no behavior change for existing callers
   * and tests. See `extensions/AUDIT-pr-mt-concurrent-broker.md` §8.3 for
   * the wiring rationale.
   */
  concurrentBroker?: ConcurrentTurnBroker;
  /**
   * Optional identity brand resolved by the caller via
   * `resolveIdentityFromSessionKey(...)`. Required when `concurrentBroker`
   * is supplied — composes the `BrokerQueueKey` with the channel tuple.
   * When `concurrentBroker` is undefined this field is ignored (broker
   * bypass path does not need it). When `concurrentBroker` is supplied
   * but `identityId` is undefined, the helper still bypasses (the
   * regression guard) — Phase 5b/6 wiring sites MUST supply both fields
   * together.
   */
  identityId?: IdentityId;
}): Promise<AgentRunLoopResult> {
  // Slice "PR-MT concurrent broker" — Phase 5 wiring entry. Routes the
  // whole turn body through `dispatchTurnViaBroker(...)` so per-(identity,
  // channel) FIFO + cross-key concurrency can apply once Phase 5b/6 binds
  // a default broker at bootstrap. Today (Phase 5) every caller passes
  // `concurrentBroker: undefined` (or omits it) and the helper falls back
  // to direct invocation — byte-identical to the pre-broker path.
  //
  // The broker requires a routing tuple at submit time; we read it from
  // `params.followupRun` (populated upstream at `get-reply-run.ts:529-532`)
  // and the `params.identityId` brand (resolved by the caller via
  // `resolveIdentityFromSessionKey(...)`). When either the broker or the
  // identityId is missing we explicitly bypass — see `dispatch-turn-via-
  // broker.ts` for the regression-guard contract.
  //
  // Phase 6 — when `params.concurrentBroker` is undefined we consult the
  // process-scoped bootstrap (`getProcessConcurrentTurnBroker()`). Once
  // gateway startup calls `bindProcessConcurrentTurnBroker(...)` (see
  // `src/server/concurrent-turn-broker-bootstrap.ts`), production turns
  // route through the broker by default. Tests still override via
  // `params.concurrentBroker` so they observe deterministic behaviour.
  const broker = params.concurrentBroker ?? getProcessConcurrentTurnBroker();
  const identityId = params.identityId;
  const followupRun = params.followupRun;
  const turnId =
    params.opts?.runId ??
    params.followupRun.requestRunId ??
    crypto.randomUUID();
  let outerResult: AgentRunLoopResult | undefined;
  // When either broker or identityId is missing we bypass the broker and the
  // routing-tuple fields are ignored by the helper — see
  // `dispatch-turn-via-broker.ts`. `identityId` is brand-validated upstream;
  // the bypass-only fallback uses a syntactically valid placeholder that is
  // never actually read on the bypass path (broker undefined → direct
  // invocation of runTurn).
  const placeholderIdentity = asIdentityId("identity:bypass");
  const dispatchResult = await dispatchTurnViaBroker({
    broker: broker !== undefined && identityId !== undefined ? broker : undefined,
    turnId,
    identityId: identityId ?? placeholderIdentity,
    originatingChannel: followupRun.originatingChannel ?? "",
    originatingTo: followupRun.originatingTo ?? "",
    originatingAccountId: followupRun.originatingAccountId,
    originatingThreadId:
      followupRun.originatingThreadId == null
        ? undefined
        : String(followupRun.originatingThreadId),
    runTurn: async () => {
      outerResult = await runAgentTurnBody(params);
    },
  });

  if (dispatchResult.kind === "rejected") {
    // Phase 6 — translate the structured rejection envelope into a
    // user-facing Russian-locale reply with a deterministic retry hint.
    // The retry-after derivation walks the broker's introspection
    // surface (`getActiveKeys()` + `getQueueDepth(...)`); for the bypass
    // branch the helper falls back to a static default per reason. The
    // `[broker] rejected ...` telemetry was already emitted by the broker
    // itself; here we log the user-notification step so ops can correlate.
    const retryAfterMs =
      broker !== undefined
        ? deriveBrokerRetryAfterMs(broker, dispatchResult.reason)
        : undefined;
    const userReplyText = formatBrokerOverflowReply(
      dispatchResult.reason,
      retryAfterMs,
    );
    defaultRuntime.log(
      `[broker] user_notified queueKey=${dispatchResult.queueKey} reason=${dispatchResult.reason} retryAfterMs=${retryAfterMs ?? "none"} turnId=${turnId}`,
    );
    return {
      kind: "final",
      payload: {
        text: userReplyText,
      },
    };
  }

  if (outerResult === undefined) {
    // Defensive — runTurn always sets outerResult before resolving.
    throw new Error("dispatchTurnViaBroker resolved without setting outerResult");
  }
  return outerResult;
}

async function runAgentTurnBody(params: {
  commandBody: string;
  followupRun: FollowupRun;
  sessionCtx: TemplateContext;
  opts?: GetReplyOptions;
  typingSignals: TypingSignaler;
  blockReplyPipeline: BlockReplyPipeline | null;
  blockStreamingEnabled: boolean;
  blockReplyChunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
    flushOnParagraph?: boolean;
  };
  resolvedBlockStreamingBreak: "text_end" | "message_end";
  applyReplyToMode: (payload: ReplyPayload) => ReplyPayload;
  shouldEmitToolResult: () => boolean;
  shouldEmitToolOutput: () => boolean;
  pendingToolTasks: Set<Promise<void>>;
  resetSessionAfterCompactionFailure: (reason: string) => Promise<boolean>;
  resetSessionAfterRoleOrderingConflict: (reason: string) => Promise<boolean>;
  isHeartbeat: boolean;
  sessionKey?: string;
  getActiveSessionEntry: () => SessionEntry | undefined;
  activeSessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  resolvedVerboseLevel: VerboseLevel;
  onStructuralToolExecutionStarting?: () => void | Promise<void>;
  onAckThenDefer?: (context: {
    runId: string;
    estimatedDurationMs?: number;
    requiredCapabilities?: string[];
    requestedToolNames?: string[];
  }) => Promise<void> | void;
  concurrentBroker?: ConcurrentTurnBroker;
  identityId?: IdentityId;
}): Promise<AgentRunLoopResult> {
  const TRANSIENT_HTTP_RETRY_DELAY_MS = 2_500;
  let didLogHeartbeatStrip = false;
  let autoCompactionCount = 0;
  // Track payloads sent directly (not via pipeline) during tool flush to avoid duplicates.
  const directlySentBlockKeys = new Set<string>();

  const runId = params.opts?.runId ?? crypto.randomUUID();
  const requestRunId =
    params.followupRun.requestRunId ??
    (typeof params.opts?.runId === "string" && params.opts.runId.trim()
      ? params.opts.runId.trim()
      : undefined) ??
    runId;
  // Slice D — DIAGNOSTIC-2026-05-08 Fix 3 plumbing.
  //
  // Derive the structural channel-key that activates the attempt.ts
  // streaming OutboundCoalescer wrap added in PR #310. PR #310 added
  // the seam, gated on both `outboundCoalescerStreamingTurnId` and
  // `outboundCoalescerStreamingChannelKey` being defined; without this
  // derivation production turns leave them undefined and the wrap is
  // dead code (gateway-dev-2026-05-07.log session 78ff2b60 turn 1 —
  // four `message_end` events shipped as four Telegram messages, two
  // of them CoT preambles).
  //
  // Format `${channel}:${accountId}:${target}` mirrors the upstream
  // `agent-runner.ts:644` coalescer wrap and the broker's queueKey
  // composition (`buildChannelKey` in `dispatch-turn-via-broker.ts`).
  // Bypass (both fields undefined) preserves byte-identical behaviour
  // with PR #310's pre-opt-in path for:
  //   - heartbeat turns (no outbound delivery surface)
  //   - internal/webchat channels (no real channel adapter)
  //   - missing originating channel or target (e.g. CLI/test fixtures)
  const outboundCoalescerStreamingChannelKey: string | undefined = (() => {
    if (params.isHeartbeat) {
      return undefined;
    }
    const channelPart = (params.followupRun.originatingChannel ?? "")
      .toString()
      .trim()
      .toLowerCase();
    if (!channelPart || isInternalMessageChannel(channelPart)) {
      return undefined;
    }
    const targetPart = (params.followupRun.originatingTo ?? "").toString().trim();
    if (!targetPart) {
      return undefined;
    }
    const accountPart =
      (params.followupRun.originatingAccountId ?? "").toString().trim() || "default";
    return `${channelPart}:${accountPart}:${targetPart}`;
  })();
  const outboundCoalescerStreamingTurnId: string | undefined =
    outboundCoalescerStreamingChannelKey !== undefined ? runId : undefined;
  const routingSnapshot = await resolveRoutingSnapshotForTemplateRun({
    prompt: params.commandBody,
    run: params.followupRun.run,
    sessionCtx: params.sessionCtx,
    storePath: params.storePath,
    sessionEntry: params.getActiveSessionEntry(),
  });
  let effectiveCommandBody = params.commandBody;
  defaultRuntime.log(
    `[web-evidence-prefetch] hook entered runId=${runId} requestedTools=[${(routingSnapshot.plannerInput.requestedTools ?? []).join(",")}] toolBundles=[${(routingSnapshot.plannerInput.resolutionContract?.toolBundles ?? []).join(",")}]`,
  );
  const webEvidencePrefetch = await maybeFetchWebEvidence({
    requestedTools: routingSnapshot.plannerInput.requestedTools,
    toolBundles: routingSnapshot.plannerInput.resolutionContract?.toolBundles,
    userPrompt: effectiveCommandBody,
    cfg: params.followupRun.run.config,
    agentDir: params.followupRun.run.agentDir,
    sessionId: params.sessionKey ?? params.followupRun.run.sessionKey ?? runId,
    turnId: runId,
    logger: (line) => defaultRuntime.log(line),
  });
  if (webEvidencePrefetch) {
    effectiveCommandBody = webEvidencePrefetch.enrichedPrompt;
    const filtered = filterWebSearchFromTools(routingSnapshot.plannerInput.requestedTools);
    if (filtered) {
      (routingSnapshot.plannerInput as { requestedTools?: string[] }).requestedTools = [...filtered];
    }
    defaultRuntime.log(
      `[web-evidence-prefetch] applied recordCount=${webEvidencePrefetch.recordCount} runId=${runId} promptDeltaChars=${webEvidencePrefetch.enrichedPrompt.length - params.commandBody.length}`,
    );
  } else {
    defaultRuntime.log(`[web-evidence-prefetch] not_applied runId=${runId}`);
  }
  const platformExecutionContext = routingSnapshot.runtimePlan;
  if (platformExecutionContext.ackThenDefer === true && params.onAckThenDefer && !params.isHeartbeat) {
    try {
      await params.onAckThenDefer({
        runId,
        ...(typeof platformExecutionContext.estimatedDurationMs === "number"
          ? { estimatedDurationMs: platformExecutionContext.estimatedDurationMs }
          : {}),
        ...(platformExecutionContext.requiredCapabilities?.length
          ? { requiredCapabilities: platformExecutionContext.requiredCapabilities }
          : {}),
        ...(platformExecutionContext.requestedToolNames?.length
          ? { requestedToolNames: platformExecutionContext.requestedToolNames }
          : {}),
      });
    } catch (ackError) {
      // Ack delivery must never block the actual work. Downstream logs
      // will surface this as a progress-bus error frame if wiring emits
      // one; here we just preserve the run.
      void ackError;
    }
  }
  const bootstrapContextMode =
    params.opts?.bootstrapContextMode ?? routingSnapshot.bootstrapContextMode;
  const normalizeReplyMediaPaths = createReplyMediaPathNormalizer({
    cfg: params.followupRun.run.config,
    sessionKey: params.sessionKey,
    workspaceDir: params.followupRun.run.workspaceDir,
  });
  let didNotifyAgentRunStart = false;
  const notifyAgentRunStart = () => {
    if (didNotifyAgentRunStart) {
      return;
    }
    didNotifyAgentRunStart = true;
    params.opts?.onAgentRunStart?.(runId);
  };
  const shouldSurfaceToControlUi = isInternalMessageChannel(
    params.followupRun.run.messageProvider ??
      params.sessionCtx.Surface ??
      params.sessionCtx.Provider,
  );
  if (params.sessionKey) {
    registerAgentRunContext(runId, {
      sessionKey: params.sessionKey,
      verboseLevel: params.resolvedVerboseLevel,
      isHeartbeat: params.isHeartbeat,
      platformExecution: toPluginHookPlatformExecutionContext(platformExecutionContext),
      isControlUiVisible: shouldSurfaceToControlUi,
      awaitingRunClosure: true,
    });
  }
  let runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
  let fallbackProvider = params.followupRun.run.provider;
  let fallbackModel = params.followupRun.run.model;
  let fallbackAttempts: RuntimeFallbackAttempt[] = [];
  let didResetAfterCompactionFailure = false;
  let didRetryTransientHttpError = false;
  let bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
    params.getActiveSessionEntry()?.systemPromptReport,
  );

  while (true) {
    try {
      const normalizeStreamingText = (payload: ReplyPayload): { text?: string; skip: boolean } => {
        let text = payload.text;
        const reply = resolveSendableOutboundReplyParts(payload);
        if (!params.isHeartbeat && text?.includes("HEARTBEAT_OK")) {
          const stripped = stripHeartbeatToken(text, {
            mode: "message",
          });
          if (stripped.didStrip && !didLogHeartbeatStrip) {
            didLogHeartbeatStrip = true;
            logVerbose("Stripped stray HEARTBEAT_OK token from reply");
          }
          if (stripped.shouldSkip && !reply.hasMedia) {
            return { skip: true };
          }
          text = stripped.text;
        }
        if (isSilentReplyText(text, SILENT_REPLY_TOKEN)) {
          return { skip: true };
        }
        if (
          isSilentReplyPrefixText(text, SILENT_REPLY_TOKEN) ||
          isSilentReplyPrefixText(text, HEARTBEAT_TOKEN)
        ) {
          return { skip: true };
        }
        if (!text) {
          // Allow media-only payloads (e.g. tool result screenshots) through.
          if (reply.hasMedia) {
            return { text: undefined, skip: false };
          }
          return { skip: true };
        }
        const sanitized = sanitizeUserFacingText(text, {
          errorContext: Boolean(payload.isError),
        });
        if (!sanitized.trim()) {
          return { skip: true };
        }
        return { text: sanitized, skip: false };
      };
      const handlePartialForTyping = async (payload: ReplyPayload): Promise<string | undefined> => {
        if (isSilentReplyPrefixText(payload.text, SILENT_REPLY_TOKEN)) {
          return undefined;
        }
        const { text, skip } = normalizeStreamingText(payload);
        if (skip || !text) {
          return undefined;
        }
        await params.typingSignals.signalTextDelta(text);
        return text;
      };
      const blockReplyPipeline = params.blockReplyPipeline;
      // Build the delivery handler once so both onAgentEvent (compaction start
      // notice) and the onBlockReply field share the same instance.  This
      // ensures replyToId threading (replyToMode=all|first) is applied to
      // compaction notices just like every other block reply.
      const blockReplyHandler = params.opts?.onBlockReply
        ? createBlockReplyDeliveryHandler({
            onBlockReply: params.opts.onBlockReply,
            currentMessageId: params.sessionCtx.MessageSidFull ?? params.sessionCtx.MessageSid,
            normalizeStreamingText,
            applyReplyToMode: params.applyReplyToMode,
            normalizeMediaPaths: normalizeReplyMediaPaths,
            typingSignals: params.typingSignals,
            blockStreamingEnabled: params.blockStreamingEnabled,
            blockReplyPipeline,
            directlySentBlockKeys,
          })
        : undefined;
      const onToolResult = params.opts?.onToolResult;
      // NEW-A Phase 5 — derive modality requirements for the current turn from
      // the structural inbound-images surface (`params.opts?.images`) plus the
      // planner's `needsVision` defense-in-depth flag. The audit
      // (`extensions/AUDIT-modality-aware-routing.md` §e/§f) confirms this is
      // the only inbound-image data reachable at this call site without
      // crossing into `src/platform/commitment/`. Each entry is mapped to a
      // structural `kind: 'image'` attachment and consumed by
      // `deriveTurnModalityRequirements` (which never reads raw user text —
      // invariant #5).
      const inboundImages = params.opts?.images ?? [];
      const inboundMediaSummary =
        inboundImages.length > 0
          ? {
              attachments: inboundImages.map(() => ({ kind: "image" as const })),
            }
          : undefined;
      const turnModalityRequirements = deriveTurnModalityRequirements({
        ...(inboundMediaSummary ? { inboundMediaSummary } : {}),
        ...(routingSnapshot.plannerInput.routing?.needsVision === true
          ? { needsVision: true }
          : {}),
      });
      const fallbackResult = await runWithModelFallback({
        ...resolveModelFallbackOptions(params.followupRun.run, {
          preflightPrompt: effectiveCommandBody,
        }),
        preflightPlannerInput: routingSnapshot.plannerInput,
        turnModalityRequirements,
        runId,
        run: (provider, model, runOptions) => {
          // Notify that model selection is complete (including after fallback).
          // This allows responsePrefix template interpolation with the actual model.
          params.opts?.onModelSelected?.({
            provider,
            model,
            thinkLevel: params.followupRun.run.thinkLevel,
          });

          if (isCliProvider(provider, params.followupRun.run.config)) {
            const startedAt = Date.now();
            notifyAgentRunStart();
            emitAgentEvent({
              runId,
              stream: "lifecycle",
              data: {
                phase: "start",
                startedAt,
              },
            });
            const cliSessionId = getCliSessionId(params.getActiveSessionEntry(), provider);
            return (async () => {
              let lifecycleTerminalEmitted = false;
              try {
                const result = await runCliAgent({
                  sessionId: params.followupRun.run.sessionId,
                  sessionKey: params.sessionKey ?? params.followupRun.run.sessionKey,
                  agentId: params.followupRun.run.agentId,
                  sessionFile: params.followupRun.run.sessionFile,
                  workspaceDir: params.followupRun.run.workspaceDir,
                  config: params.followupRun.run.config,
                  prompt: effectiveCommandBody,
                  provider,
                  model,
                  thinkLevel: params.followupRun.run.thinkLevel,
                  timeoutMs: params.followupRun.run.timeoutMs,
                  runId,
                  extraSystemPrompt: params.followupRun.run.extraSystemPrompt,
                  platformExecutionContext,
                  ownerNumbers: params.followupRun.run.ownerNumbers,
                  cliSessionId,
                  bootstrapPromptWarningSignaturesSeen,
                  bootstrapPromptWarningSignature:
                    bootstrapPromptWarningSignaturesSeen[
                      bootstrapPromptWarningSignaturesSeen.length - 1
                    ],
                  images: params.opts?.images,
                });
                bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
                  result.meta?.systemPromptReport,
                );

                // CLI backends don't emit streaming assistant events, so we need to
                // emit one with the final text so server-chat can populate its buffer
                // and send the response to TUI/WebSocket clients.
                const cliText = result.payloads?.[0]?.text?.trim();
                if (cliText) {
                  emitAgentEvent({
                    runId,
                    stream: "assistant",
                    data: { text: cliText },
                  });
                }

                emitAgentEvent({
                  runId,
                  stream: "lifecycle",
                  data: {
                    phase: "end",
                    startedAt,
                    endedAt: Date.now(),
                  },
                });
                lifecycleTerminalEmitted = true;

                return result;
              } catch (err) {
                emitAgentEvent({
                  runId,
                  stream: "lifecycle",
                  data: {
                    phase: "error",
                    startedAt,
                    endedAt: Date.now(),
                    error: String(err),
                  },
                });
                lifecycleTerminalEmitted = true;
                throw err;
              } finally {
                // Defensive backstop: never let a CLI run complete without a terminal
                // lifecycle event, otherwise downstream consumers can hang.
                if (!lifecycleTerminalEmitted) {
                  emitAgentEvent({
                    runId,
                    stream: "lifecycle",
                    data: {
                      phase: "error",
                      startedAt,
                      endedAt: Date.now(),
                      error: "CLI run completed without lifecycle terminal event",
                    },
                  });
                }
              }
            })();
          }
          const { embeddedContext, senderContext, runBaseParams } = buildEmbeddedRunExecutionParams(
            {
              run: params.followupRun.run,
              sessionCtx: params.sessionCtx,
              hasRepliedRef: params.opts?.hasRepliedRef,
              provider,
              runId,
              allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
              model,
            },
          );
          return (async () => {
            let attemptCompactionCount = 0;
            try {
              const result = await runEmbeddedPiAgent({
                ...embeddedContext,
                allowGatewaySubagentBinding: true,
                trigger: params.isHeartbeat ? "heartbeat" : "user",
                // Slice D — see derivation comment above. When both
                // fields are defined, attempt.ts wraps `onBlockReply`
                // with the OutboundCoalescer (PR #310). When either is
                // undefined (heartbeat / internal channel / missing
                // tuple) attempt.ts skips the wrap and the run is
                // byte-identical to PR #310's pre-opt-in path.
                ...(outboundCoalescerStreamingTurnId !== undefined
                  ? { outboundCoalescerStreamingTurnId }
                  : {}),
                ...(outboundCoalescerStreamingChannelKey !== undefined
                  ? { outboundCoalescerStreamingChannelKey }
                  : {}),
                groupId: resolveGroupSessionKey(params.sessionCtx)?.id,
                groupChannel:
                  params.sessionCtx.GroupChannel?.trim() ?? params.sessionCtx.GroupSubject?.trim(),
                groupSpace: params.sessionCtx.GroupSpace?.trim() ?? undefined,
                ...senderContext,
                ...runBaseParams,
                sessionKey: params.sessionKey ?? params.followupRun.run.sessionKey,
                requestRunId,
                parentRunId: params.followupRun.parentRunId,
                platformExecutionContext,
                prompt: effectiveCommandBody,
                disableWebSearchTool: hasWebSearchSignal({
                  requestedTools: routingSnapshot.plannerInput.requestedTools,
                  toolBundles: routingSnapshot.plannerInput.resolutionContract?.toolBundles,
                }),
                extraSystemPrompt: params.followupRun.run.extraSystemPrompt,
                toolResultFormat: (() => {
                  const channel = resolveMessageChannel(
                    params.sessionCtx.Surface,
                    params.sessionCtx.Provider,
                  );
                  if (!channel) {
                    return "markdown";
                  }
                  return isMarkdownCapableMessageChannel(channel) ? "markdown" : "plain";
                })(),
                suppressToolErrorWarnings: params.opts?.suppressToolErrorWarnings,
                bootstrapContextMode,
                bootstrapContextRunKind: params.opts?.isHeartbeat ? "heartbeat" : "default",
                images: params.opts?.images,
                abortSignal: params.opts?.abortSignal,
                blockReplyBreak: params.resolvedBlockStreamingBreak,
                blockReplyChunking: params.blockReplyChunking,
                onPartialReply: async (payload) => {
                  const textForTyping = await handlePartialForTyping(payload);
                  if (!params.opts?.onPartialReply || textForTyping === undefined) {
                    return;
                  }
                  await params.opts.onPartialReply({
                    text: textForTyping,
                    mediaUrls: payload.mediaUrls,
                  });
                },
                onAssistantMessageStart: async () => {
                  await params.typingSignals.signalMessageStart();
                  await params.opts?.onAssistantMessageStart?.();
                },
                onReasoningStream:
                  params.typingSignals.shouldStartOnReasoning || params.opts?.onReasoningStream
                    ? async (payload) => {
                        await params.typingSignals.signalReasoningDelta();
                        await params.opts?.onReasoningStream?.({
                          text: payload.text,
                          mediaUrls: payload.mediaUrls,
                        });
                      }
                    : undefined,
                onReasoningEnd: params.opts?.onReasoningEnd,
                onAgentEvent: async (evt) => {
                  // Signal run start only after the embedded agent emits real activity.
                  const hasLifecyclePhase =
                    evt.stream === "lifecycle" && typeof evt.data.phase === "string";
                  if (evt.stream !== "lifecycle" || hasLifecyclePhase) {
                    notifyAgentRunStart();
                  }
                  // Trigger typing when tools start executing.
                  // Must await to ensure typing indicator starts before tool summaries are emitted.
                  if (evt.stream === "tool") {
                    const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
                    const name = typeof evt.data.name === "string" ? evt.data.name : undefined;
                    if (phase === "start" || phase === "update") {
                      await params.typingSignals.signalToolStart();
                      await params.opts?.onToolStart?.({ name, phase });
                    }
                  }
                  // Track auto-compaction and notify higher layers.
                  if (evt.stream === "compaction") {
                    const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
                    if (phase === "start") {
                      if (params.opts?.onCompactionStart) {
                        await params.opts.onCompactionStart();
                      } else if (params.opts?.onBlockReply) {
                        // Send directly via opts.onBlockReply (bypassing the
                        // pipeline) so the notice does not cause final payloads
                        // to be discarded on non-streaming model paths.
                        const currentMessageId =
                          params.sessionCtx.MessageSidFull ?? params.sessionCtx.MessageSid;
                        const noticePayload = params.applyReplyToMode({
                          text: "🧹 Compacting context...",
                          replyToId: currentMessageId,
                          replyToCurrent: true,
                          isCompactionNotice: true,
                        });
                        try {
                          await params.opts.onBlockReply(noticePayload);
                        } catch (err) {
                          // Non-critical notice delivery failure should not
                          // bubble out of the fire-and-forget event handler.
                          logVerbose(
                            `compaction start notice delivery failed (non-fatal): ${String(err)}`,
                          );
                        }
                      }
                    }
                    const completed = evt.data?.completed === true;
                    if (phase === "end" && completed) {
                      attemptCompactionCount += 1;
                      await params.opts?.onCompactionEnd?.();
                    }
                  }
                },
                // Always pass onBlockReply so flushBlockReplyBuffer works before tool execution,
                // even when regular block streaming is disabled. The handler sends directly
                // via opts.onBlockReply when the pipeline isn't available.
                onBlockReply: blockReplyHandler,
                onBlockReplyFlush:
                  params.blockStreamingEnabled && blockReplyPipeline
                    ? async () => {
                        await blockReplyPipeline.flush({ force: true });
                      }
                    : undefined,
                onStructuralToolExecutionStarting: params.onStructuralToolExecutionStarting,
                shouldEmitToolResult: params.shouldEmitToolResult,
                shouldEmitToolOutput: params.shouldEmitToolOutput,
                bootstrapPromptWarningSignaturesSeen,
                bootstrapPromptWarningSignature:
                  bootstrapPromptWarningSignaturesSeen[
                    bootstrapPromptWarningSignaturesSeen.length - 1
                  ],
                onToolResult: onToolResult
                  ? (() => {
                      // Serialize tool result delivery to preserve message ordering.
                      // Without this, concurrent tool callbacks race through typing signals
                      // and message sends, causing out-of-order delivery to the user.
                      // See: https://github.com/openclaw/openclaw/issues/11044
                      let toolResultChain: Promise<void> = Promise.resolve();
                      return (payload: ReplyPayload) => {
                        toolResultChain = toolResultChain
                          .then(async () => {
                            const { text, skip } = normalizeStreamingText(payload);
                            if (skip) {
                              return;
                            }
                            await params.typingSignals.signalTextDelta(text);
                            await onToolResult({
                              ...payload,
                              text,
                            });
                          })
                          .catch((err) => {
                            // Keep chain healthy after an error so later tool results still deliver.
                            logVerbose(`tool result delivery failed: ${String(err)}`);
                          });
                        const task = toolResultChain.finally(() => {
                          params.pendingToolTasks.delete(task);
                        });
                        params.pendingToolTasks.add(task);
                      };
                    })()
                  : undefined,
              });
              bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
                result.meta?.systemPromptReport,
              );
              const resultCompactionCount = Math.max(
                0,
                result.meta?.agentMeta?.compactionCount ?? 0,
              );
              attemptCompactionCount = Math.max(attemptCompactionCount, resultCompactionCount);
              return result;
            } finally {
              autoCompactionCount += attemptCompactionCount;
            }
          })();
        },
      });
      runResult = fallbackResult.result;
      fallbackProvider = fallbackResult.provider;
      fallbackModel = fallbackResult.model;
      fallbackAttempts = Array.isArray(fallbackResult.attempts)
        ? fallbackResult.attempts.map((attempt) => ({
            provider: String(attempt.provider ?? ""),
            model: String(attempt.model ?? ""),
            error: String(attempt.error ?? ""),
            reason: attempt.reason ? String(attempt.reason) : undefined,
            status: typeof attempt.status === "number" ? attempt.status : undefined,
            code: attempt.code ? String(attempt.code) : undefined,
          }))
        : [];

      // Some embedded runs surface context overflow as an error payload instead of throwing.
      // Treat those as a session-level failure and auto-recover by starting a fresh session.
      const embeddedError = runResult.meta?.error;
      if (
        embeddedError &&
        isContextOverflowError(embeddedError.message) &&
        !didResetAfterCompactionFailure &&
        (await params.resetSessionAfterCompactionFailure(embeddedError.message))
      ) {
        didResetAfterCompactionFailure = true;
        return {
          kind: "final",
          payload: {
            text: "⚠️ Context limit exceeded. I've reset our conversation to start fresh - please try again.\n\nTo prevent this, increase your compaction buffer by setting `agents.defaults.compaction.reserveTokensFloor` to 20000 or higher in your config.",
          },
        };
      }
      if (embeddedError?.kind === "role_ordering") {
        const didReset = await params.resetSessionAfterRoleOrderingConflict(embeddedError.message);
        if (didReset) {
          return {
            kind: "final",
            payload: {
              text: "⚠️ Message ordering conflict. I've reset the conversation - please try again.",
            },
          };
        }
      }

      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isBilling = isBillingErrorMessage(message);
      const isContextOverflow = !isBilling && isLikelyContextOverflowError(message);
      const isCompactionFailure = !isBilling && isCompactionFailureError(message);
      const isSessionCorruption = /function call turn comes immediately after/i.test(message);
      const isRoleOrderingError = /incorrect role information|roles must alternate/i.test(message);
      const isTransientHttp = isTransientHttpError(message);
      const isFailoverMessage = isFailoverErrorMessage(message);
      const isModelFallbackExhausted = /^All (?:image )?models failed\b/i.test(message);

      if (
        isCompactionFailure &&
        !didResetAfterCompactionFailure &&
        (await params.resetSessionAfterCompactionFailure(message))
      ) {
        didResetAfterCompactionFailure = true;
        return {
          kind: "final",
          payload: {
            text: "⚠️ Context limit exceeded during compaction. I've reset our conversation to start fresh - please try again.\n\nTo prevent this, increase your compaction buffer by setting `agents.defaults.compaction.reserveTokensFloor` to 20000 or higher in your config.",
          },
        };
      }
      if (isRoleOrderingError) {
        const didReset = await params.resetSessionAfterRoleOrderingConflict(message);
        if (didReset) {
          return {
            kind: "final",
            payload: {
              text: "⚠️ Message ordering conflict. I've reset the conversation - please try again.",
            },
          };
        }
      }

      // Auto-recover from Gemini session corruption by resetting the session
      if (
        isSessionCorruption &&
        params.sessionKey &&
        params.activeSessionStore &&
        params.storePath
      ) {
        const sessionKey = params.sessionKey;
        const corruptedSessionId = params.getActiveSessionEntry()?.sessionId;
        defaultRuntime.error(
          `Session history corrupted (Gemini function call ordering). Resetting session: ${params.sessionKey}`,
        );

        try {
          // Delete transcript file if it exists
          if (corruptedSessionId) {
            const transcriptPath = resolveSessionTranscriptPath(corruptedSessionId);
            try {
              fs.unlinkSync(transcriptPath);
            } catch {
              // Ignore if file doesn't exist
            }
          }

          // Keep the in-memory snapshot consistent with the on-disk store reset.
          delete params.activeSessionStore[sessionKey];

          // Remove session entry from store using a fresh, locked snapshot.
          await updateSessionStore(params.storePath, (store) => {
            delete store[sessionKey];
          });
        } catch (cleanupErr) {
          defaultRuntime.error(
            `Failed to reset corrupted session ${params.sessionKey}: ${String(cleanupErr)}`,
          );
        }

        return {
          kind: "final",
          payload: {
            text: "⚠️ Session history was corrupted. I've reset the conversation - please try again!",
          },
        };
      }

      if (isTransientHttp && !didRetryTransientHttpError) {
        didRetryTransientHttpError = true;
        // Retry the full runWithModelFallback() cycle — transient errors
        // (502/521/etc.) typically affect the whole provider, so falling
        // back to an alternate model first would not help. Instead we wait
        // and retry the complete primary→fallback chain.
        defaultRuntime.error(
          `Transient HTTP provider error before reply (${message}). Retrying once in ${TRANSIENT_HTTP_RETRY_DELAY_MS}ms.`,
        );
        await new Promise<void>((resolve) => {
          setTimeout(resolve, TRANSIENT_HTTP_RETRY_DELAY_MS);
        });
        continue;
      }

      defaultRuntime.error(`Embedded agent failed before reply: ${message}`);
      const policyOrTransientCopy = userFacingToolPolicyOrTransientMessage(message);
      const safeMessage =
        policyOrTransientCopy ??
        sanitizeUserFacingText(message, { errorContext: true });
      const trimmedMessage = safeMessage.replace(/\.\s*$/, "");
      const fallbackText = isBilling
        ? BILLING_ERROR_USER_MESSAGE
        : isContextOverflow
          ? "⚠️ Context overflow — prompt too large for this model. Try a shorter message or a larger-context model."
          : isRoleOrderingError
            ? "⚠️ Message ordering conflict - please try again. If this persists, use /new to start a fresh session."
            : isModelFallbackExhausted
              ? "⚠️ No available model could complete this request right now. Please try again in a moment."
              : isFailoverMessage && trimmedMessage
                ? trimmedMessage
                : `⚠️ Agent failed before reply: ${trimmedMessage}.\nLogs: openclaw logs --follow`;

      return {
        kind: "final",
        payload: {
          text: fallbackText,
        },
      };
    }
  }

  // If the run completed but with an embedded context overflow error that
  // wasn't recovered from (e.g. compaction reset already attempted), surface
  // the error to the user instead of silently returning an empty response.
  // See #26905: Slack DM sessions silently swallowed messages when context
  // overflow errors were returned as embedded error payloads.
  const finalEmbeddedError = runResult?.meta?.error;
  const hasPayloadText = runResult?.payloads?.some((p) => p.text?.trim());
  if (finalEmbeddedError && isContextOverflowError(finalEmbeddedError.message) && !hasPayloadText) {
    return {
      kind: "final",
      payload: {
        text: "⚠️ Context overflow — this conversation is too large for the model. Use /new to start a fresh session.",
      },
    };
  }

  return {
    kind: "success",
    runId,
    runResult,
    fallbackProvider,
    fallbackModel,
    fallbackAttempts,
    didLogHeartbeatStrip,
    autoCompactionCount,
    directlySentBlockKeys: directlySentBlockKeys.size > 0 ? directlySentBlockKeys : undefined,
  };
}
