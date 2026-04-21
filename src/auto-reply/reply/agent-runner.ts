import fs from "node:fs";
import { lookupCachedContextTokens } from "../../agents/context-cache.js";
import { lookupContextTokens } from "../../agents/context-tokens.runtime.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { resolveModelAuthMode } from "../../agents/model-auth.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { hasNonzeroUsage } from "../../agents/usage.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptPath,
} from "../../config/sessions/paths.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { TypingMode } from "../../config/types.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { emitDiagnosticEvent, isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { generateSecureUuid } from "../../infra/secure-random.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import {
  buildFallbackClearedNotice,
  buildFallbackNotice,
  resolveFallbackTransition,
} from "../fallback-state.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { OriginatingChannelType, TemplateContext } from "../templating.js";
import { resolveResponseUsageMode, type VerboseLevel } from "../thinking.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { runAgentTurnWithFallback } from "./agent-runner-execution.runtime.js";
import {
  buildAcceptanceFallbackPayload,
  captureMessagingDeliveryClosureCandidate,
  createShouldEmitToolOutput,
  createShouldEmitToolResult,
  enqueueSemanticRetryFollowup,
  finalizeWithFollowup,
  isAudioPayload,
  reevaluateMessagingDecisionForMessagingRun,
  signalTypingIfNeeded,
} from "./agent-runner-helpers.js";
import { runMemoryFlushIfNeeded } from "./agent-runner-memory.runtime.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import {
  appendUnscheduledReminderNote,
  hasSessionRelatedCronJobs,
  hasUnbackedReminderCommitment,
} from "./agent-runner-reminder-guard.js";
import { appendUsageLine, formatResponseUsageLine } from "./agent-runner-usage-line.js";
import { createAudioAsVoiceBuffer, createBlockReplyPipeline } from "./block-reply-pipeline.js";
import { resolveEffectiveBlockStreamingConfig } from "./block-streaming.js";
import { createFollowupRunner } from "./followup-runner.js";
import { resolveOriginMessageProvider, resolveOriginMessageTo } from "./origin-routing.js";
import { readPostCompactionContext } from "./post-compaction-context.js";
import { resolveActiveRunQueueAction } from "./queue-policy.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import { createReplyMediaPathNormalizer } from "./reply-media-paths.runtime.js";
import { createReplyToModeFilterForChannel, resolveReplyToMode } from "./reply-threading.js";
import { incrementRunCompactionCount, persistRunSessionUsage } from "./session-run-accounting.js";
import { createTypingSignaler } from "./typing-mode.js";
import type { TypingController } from "./typing.js";
import { intentLedger } from "../../platform/session/intent-ledger.js";
import {
  reconcilePromisesWithReceipts,
  type PromisedActionViolation,
} from "../../platform/session/execution-evidence.js";
import {
  createTurnProgressEmitter,
  withTurnProgressEmitter,
  type TurnProgressEmitter,
} from "../../platform/progress/progress-bus.js";

const BLOCK_REPLY_SEND_TIMEOUT_MS = 15_000;
const intentLedgerLog = createSubsystemLogger("intent-ledger");
let piEmbeddedQueueRuntimePromise: Promise<
  typeof import("../../agents/pi-embedded-queue.runtime.js")
> | null = null;
let usageCostRuntimePromise: Promise<typeof import("./usage-cost.runtime.js")> | null = null;
let sessionStoreRuntimePromise: Promise<
  typeof import("../../config/sessions/store.runtime.js")
> | null = null;
const DEBUG_REPLY_ROUTING_ENV = "OPENCLAW_DEBUG_REPLY_ROUTING";

function loadPiEmbeddedQueueRuntime() {
  piEmbeddedQueueRuntimePromise ??= import("../../agents/pi-embedded-queue.runtime.js");
  return piEmbeddedQueueRuntimePromise;
}

function loadUsageCostRuntime() {
  usageCostRuntimePromise ??= import("./usage-cost.runtime.js");
  return usageCostRuntimePromise;
}

function loadSessionStoreRuntime() {
  sessionStoreRuntimePromise ??= import("../../config/sessions/store.runtime.js");
  return sessionStoreRuntimePromise;
}

function isDebugReplyRoutingEnabled(): boolean {
  return process.env[DEBUG_REPLY_ROUTING_ENV] === "1";
}

function formatDebugTokenCount(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US") : "?";
}

function summarizePromptForDebug(prompt: string, maxLength = 180): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function dedupeDebugAttempts(
  attempts: Array<{
    provider: string;
    model: string;
    status?: string;
  }>,
): Array<{
  provider: string;
  model: string;
  status?: string;
}> {
  const deduped: Array<{ provider: string; model: string; status?: string }> = [];
  for (const attempt of attempts) {
    const previous = deduped[deduped.length - 1];
    if (
      previous &&
      previous.provider === attempt.provider &&
      previous.model === attempt.model &&
      previous.status === attempt.status
    ) {
      continue;
    }
    deduped.push(attempt);
  }
  return deduped;
}

function buildDebugReplyBlock(params: {
  userMessage: string;
  selectedProvider: string;
  selectedModel: string;
  activeProvider: string;
  activeModel: string;
  fallbackAttempts: Array<{
    provider: string;
    model: string;
    reason?: string;
    error?: string;
    code?: string;
  }>;
  usage?:
    | {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total?: number;
      }
    | undefined;
  lastCallUsage?:
    | {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total?: number;
      }
    | undefined;
  executionIntent?: string;
  classifierTelemetry?: {
    source: "llm" | "fail_closed";
    backend?: string;
    model?: string;
    primaryOutcome?: string;
    interactionMode?: string;
    confidence?: number;
    deliverableKind?: string;
    deliverableFormats?: string[];
  };
  routingOutcome?:
    | { kind: "matched"; source: "ranked" | "contract_first_fallback" }
    | { kind: "low_confidence_clarify" }
    | { kind: "contract_unsatisfiable"; reasons: string[] };
}): string | undefined {
  if (!isDebugReplyRoutingEnabled()) {
    return undefined;
  }
  const attemptEntries: Array<{ provider: string; model: string; status?: string }> = [];
  const addAttempt = (provider: string, model: string, status?: string) => {
    attemptEntries.push({ provider, model, status });
  };

  addAttempt(params.selectedProvider, params.selectedModel, "selected");
  for (const attempt of params.fallbackAttempts) {
    addAttempt(
      attempt.provider,
      attempt.model,
      attempt.reason === "unknown"
        ? undefined
        : (attempt.reason ?? attempt.code ?? (attempt.error ? "failed" : undefined)),
    );
  }
  addAttempt(params.activeProvider, params.activeModel, "used");
  const attempts = dedupeDebugAttempts(attemptEntries);
  const attemptParts = attempts.map((attempt) =>
    attempt.status
      ? `${attempt.provider}/${attempt.model} (${attempt.status})`
      : `${attempt.provider}/${attempt.model}`,
  );

  const usage = params.usage;
  const totalTokens =
    usage?.total ??
    (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
  const lastCall = params.lastCallUsage;
  const summary = [
    "[debug]",
    `used \`${params.activeProvider}/${params.activeModel}\``,
    usage ? `${formatDebugTokenCount(totalTokens)} tok` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  const classifierLine = (() => {
    const tele = params.classifierTelemetry;
    if (!tele) {
      return undefined;
    }
    const backendModel =
      tele.backend && tele.model
        ? `${tele.backend}/${tele.model}`
        : (tele.model ?? tele.backend ?? "?");
    const deliverable = tele.deliverableKind
      ? `${tele.deliverableKind}${(tele.deliverableFormats?.length ?? 0) > 0 ? `/${tele.deliverableFormats!.join(",")}` : ""}`
      : "n/a";
    const confidence =
      typeof tele.confidence === "number" && Number.isFinite(tele.confidence)
        ? tele.confidence.toFixed(2)
        : "?";
    const outcome = tele.primaryOutcome ?? "?";
    const mode = tele.interactionMode ?? "?";
    return `classifier: \`${backendModel}\` [${tele.source}] -> ${outcome}·${mode}·${confidence} · deliverable=${deliverable}`;
  })();

  const routingLine = (() => {
    const outcome = params.routingOutcome;
    if (!outcome) {
      return undefined;
    }
    if (outcome.kind === "matched") {
      return `routing: \`matched:${outcome.source}\``;
    }
    if (outcome.kind === "low_confidence_clarify") {
      return "routing: `low_confidence_clarify`";
    }
    return `routing: \`contract_unsatisfiable\` reasons=${outcome.reasons.join(",")}`;
  })();

  const details = [
    classifierLine,
    routingLine,
    params.executionIntent ? `intent: \`${params.executionIntent}\`` : undefined,
    `selected: \`${params.selectedProvider}/${params.selectedModel}\``,
    attemptParts.length > 1 ? `attempts: ${attemptParts.join(" -> ")}` : undefined,
    usage
      ? `tokens: in ${formatDebugTokenCount(usage.input)} / out ${formatDebugTokenCount(usage.output)} / total ${formatDebugTokenCount(totalTokens)}`
      : undefined,
    lastCall
      ? `last-call: in ${formatDebugTokenCount(lastCall.input)} / out ${formatDebugTokenCount(lastCall.output)} / total ${formatDebugTokenCount(lastCall.total)}`
      : undefined,
    `msg: ${summarizePromptForDebug(params.userMessage, 96)}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join(" | ");

  // Two root-level blockquotes (blank line between) so Telegram can render the details
  // as <blockquote expandable> instead of <tg-spoiler> (spoiler UX is a noisy static mask).
  return details ? `> ${summary}\n\n> ${details}` : `> ${summary}`;
}

function shouldSuppressDeferredSemanticRetryReply(params: {
  deferDeliveryClosure: boolean;
  replyPayloads?: ReplyPayload[];
  artifactKinds?: string[];
  acceptanceOutcome?:
    | {
        action?: string;
        remediation?: string;
        recoveryPolicy?: { exhausted?: boolean };
      }
    | undefined;
  supervisorVerdict?:
    | {
        action?: string;
        remediation?: string;
        recoveryPolicy?: { exhausted?: boolean };
      }
    | undefined;
}): boolean {
  if (!params.deferDeliveryClosure) {
    return false;
  }
  const expectsArtifact = (params.artifactKinds?.length ?? 0) > 0;
  const hasMediaPayload =
    params.replyPayloads?.some((payload) =>
      Boolean(payload.mediaUrl || payload.mediaUrls?.length),
    ) ?? false;
  const decision = params.supervisorVerdict ?? params.acceptanceOutcome;
  return (
    expectsArtifact &&
    !hasMediaPayload &&
    decision?.action === "retry" &&
    decision.remediation === "semantic_retry" &&
    decision.recoveryPolicy?.exhausted !== true
  );
}

const EVIDENCE_HARD_REPLAN_REASON_CODE = "evidence_hard_replan";
const evidenceLog = createSubsystemLogger("evidence");

function buildEvidenceHardReplanPrompt(params: {
  originalPrompt: string;
  violation: PromisedActionViolation;
}): string {
  const { violation } = params;
  const toolNames = violation.expectedToolNames ?? [];
  const kinds = violation.expectedReceiptKinds.join(", ");
  const toolHint =
    toolNames.length > 0
      ? `Execute the promised action now using the \`${toolNames.join("`/`")}\` tool. Do not reply with acknowledgement text only.`
      : `Execute the promised action now via the appropriate runtime tool (${kinds}). Do not reply with acknowledgement text only.`;
  const corrective = [
    "The previous turn promised to execute an action but produced no matching execution receipt.",
    `Expected receipt kinds: ${kinds}.`,
    toolNames.length > 0 ? `Expected tool(s): ${toolNames.join(", ")}.` : undefined,
    toolHint,
    `Promise summary: "${violation.summary}".`,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
  const originalPrompt = params.originalPrompt.trim();
  return [corrective, "[Original task]", originalPrompt].join("\n\n");
}

function enqueueEvidenceHardReplan(params: {
  queueKey: string;
  sourceRun: FollowupRun;
  settings: QueueSettings;
  violation: PromisedActionViolation;
}): boolean {
  if (!params.queueKey) {
    return false;
  }
  const retryCount = params.sourceRun.automation?.retryCount ?? 0;
  const prompt = buildEvidenceHardReplanPrompt({
    originalPrompt: params.sourceRun.prompt,
    violation: params.violation,
  });
  return enqueueFollowupRun(
    params.queueKey,
    {
      ...params.sourceRun,
      requestRunId: params.sourceRun.requestRunId,
      parentRunId: params.sourceRun.requestRunId ?? params.sourceRun.parentRunId,
      prompt,
      messageId: undefined,
      summaryLine: "evidence hard replan",
      enqueuedAt: Date.now(),
      automation: {
        source: "acceptance_retry",
        retryCount: retryCount + 1,
        persisted: false,
        reasonCode: EVIDENCE_HARD_REPLAN_REASON_CODE,
        reasonSummary: `Promised action had no matching ${params.violation.expectedReceiptKinds.join("|")} receipt${params.violation.expectedToolNames?.length ? ` (tools: ${params.violation.expectedToolNames.join(", ")})` : ""}`,
      },
    },
    params.settings,
    "prompt",
  );
}

function summarizeFinalAssistantText(payloads: ReplyPayload[]): string {
  for (const payload of payloads) {
    if (payload.isError || typeof payload.text !== "string") {
      continue;
    }
    const normalized = payload.text.replace(/\s+/g, " ").trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

export async function runReplyAgent(params: {
  commandBody: string;
  followupRun: FollowupRun;
  queueKey: string;
  resolvedQueue: QueueSettings;
  shouldSteer: boolean;
  shouldFollowup: boolean;
  isActive: boolean;
  isStreaming: boolean;
  opts?: GetReplyOptions;
  typing: TypingController;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  defaultModel: string;
  agentCfgContextTokens?: number;
  resolvedVerboseLevel: VerboseLevel;
  isNewSession: boolean;
  blockStreamingEnabled: boolean;
  blockReplyChunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
    flushOnParagraph?: boolean;
  };
  resolvedBlockStreamingBreak: "text_end" | "message_end";
  sessionCtx: TemplateContext;
  shouldInjectGroupIntro: boolean;
  typingMode: TypingMode;
}): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const {
    commandBody,
    followupRun,
    queueKey,
    resolvedQueue,
    shouldSteer,
    shouldFollowup,
    isActive,
    isStreaming,
    opts,
    typing,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens,
    resolvedVerboseLevel,
    isNewSession,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    sessionCtx,
    shouldInjectGroupIntro,
    typingMode,
  } = params;

  let activeSessionEntry = sessionEntry;
  const activeSessionStore = sessionStore;
  let activeIsNewSession = isNewSession;
  const requestRunId =
    followupRun.requestRunId ??
    (typeof opts?.runId === "string" && opts.runId.trim() ? opts.runId.trim() : undefined);
  const correlationSourceRun =
    requestRunId && followupRun.requestRunId !== requestRunId
      ? { ...followupRun, requestRunId }
      : followupRun;

  const isHeartbeat = opts?.isHeartbeat === true;
  const typingSignals = createTypingSignaler({
    typing,
    mode: typingMode,
    isHeartbeat,
  });

  const shouldEmitToolResult = createShouldEmitToolResult({
    sessionKey,
    storePath,
    resolvedVerboseLevel,
  });
  const shouldEmitToolOutput = createShouldEmitToolOutput({
    sessionKey,
    storePath,
    resolvedVerboseLevel,
  });

  const pendingToolTasks = new Set<Promise<void>>();
  const blockReplyTimeoutMs = opts?.blockReplyTimeoutMs ?? BLOCK_REPLY_SEND_TIMEOUT_MS;

  const replyToChannel = resolveOriginMessageProvider({
    originatingChannel: sessionCtx.OriginatingChannel,
    provider: sessionCtx.Surface ?? sessionCtx.Provider,
  }) as OriginatingChannelType | undefined;
  const replyToMode = resolveReplyToMode(
    followupRun.run.config,
    replyToChannel,
    sessionCtx.AccountId,
    sessionCtx.ChatType,
  );
  const applyReplyToMode = createReplyToModeFilterForChannel(replyToMode, replyToChannel);
  const cfg = followupRun.run.config;
  const normalizeReplyMediaPaths = createReplyMediaPathNormalizer({
    cfg,
    sessionKey,
    workspaceDir: followupRun.run.workspaceDir,
  });
  const progressSessionId =
    typeof followupRun.run.sessionId === "string" ? followupRun.run.sessionId : "";
  const progressChannelId = (
    replyToChannel ??
    sessionCtx.Surface ??
    sessionCtx.Provider ??
    sessionCtx.OriginatingChannel ??
    ""
  )
    .toString()
    .trim()
    .toLowerCase();
  const progressTurnId =
    (typeof opts?.runId === "string" && opts.runId.trim()) ||
    (typeof requestRunId === "string" && requestRunId.trim()) ||
    generateSecureUuid();
  const turnProgressEmitter: TurnProgressEmitter | null =
    progressSessionId && progressChannelId
      ? createTurnProgressEmitter({
          sessionId: progressSessionId,
          channelId: progressChannelId,
          turnId: progressTurnId,
        })
      : null;
  let progressStreamingEmitted = false;
  const originalOnBlockReply = opts?.onBlockReply;
  const streamingAwareBlockReply: NonNullable<GetReplyOptions["onBlockReply"]> | undefined =
    originalOnBlockReply
      ? (payload, options) => {
          if (turnProgressEmitter && !progressStreamingEmitted) {
            progressStreamingEmitted = true;
            turnProgressEmitter.emit("streaming");
          }
          return originalOnBlockReply(payload, options);
        }
      : undefined;
  const blockReplyCoalescing =
    blockStreamingEnabled && streamingAwareBlockReply
      ? resolveEffectiveBlockStreamingConfig({
          cfg,
          provider: sessionCtx.Provider,
          accountId: sessionCtx.AccountId,
          chunking: blockReplyChunking,
        }).coalescing
      : undefined;
  const blockReplyPipeline =
    blockStreamingEnabled && streamingAwareBlockReply
      ? createBlockReplyPipeline({
          onBlockReply: streamingAwareBlockReply,
          timeoutMs: blockReplyTimeoutMs,
          coalescing: blockReplyCoalescing,
          buffer: createAudioAsVoiceBuffer({ isAudioPayload }),
        })
      : null;
  const touchActiveSessionEntry = async () => {
    if (!activeSessionEntry || !activeSessionStore || !sessionKey) {
      return;
    }
    const updatedAt = Date.now();
    activeSessionEntry.updatedAt = updatedAt;
    activeSessionStore[sessionKey] = activeSessionEntry;
    if (storePath) {
      const { updateSessionStoreEntry } = await loadSessionStoreRuntime();
      await updateSessionStoreEntry({
        storePath,
        sessionKey,
        update: async () => ({ updatedAt }),
      });
    }
  };

  if (shouldSteer && isStreaming) {
    const { queueEmbeddedPiMessage } = await loadPiEmbeddedQueueRuntime();
    const steered = queueEmbeddedPiMessage(followupRun.run.sessionId, followupRun.prompt);
    if (steered && !shouldFollowup) {
      await touchActiveSessionEntry();
      typing.cleanup();
      return undefined;
    }
  }

  const activeRunQueueAction = resolveActiveRunQueueAction({
    isActive,
    isHeartbeat,
    shouldFollowup,
    queueMode: resolvedQueue.mode,
  });

  if (activeRunQueueAction === "drop") {
    typing.cleanup();
    return undefined;
  }

  if (activeRunQueueAction === "enqueue-followup") {
    enqueueFollowupRun(queueKey, followupRun, resolvedQueue);
    await touchActiveSessionEntry();
    typing.cleanup();
    return undefined;
  }

  await typingSignals.signalRunStart();

  activeSessionEntry = await runMemoryFlushIfNeeded({
    cfg,
    followupRun,
    promptForEstimate: followupRun.prompt,
    sessionCtx,
    opts,
    defaultModel,
    agentCfgContextTokens,
    resolvedVerboseLevel,
    sessionEntry: activeSessionEntry,
    sessionStore: activeSessionStore,
    sessionKey,
    storePath,
    isHeartbeat,
  });

  const runFollowupTurn = createFollowupRunner({
    opts,
    typing,
    typingMode,
    queueKey,
    resolvedQueue,
    sessionEntry: activeSessionEntry,
    sessionStore: activeSessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens,
  });

  let responseUsageLine: string | undefined;
  type SessionResetOptions = {
    failureLabel: string;
    buildLogMessage: (nextSessionId: string) => string;
    cleanupTranscripts?: boolean;
  };
  const resetSession = async ({
    failureLabel,
    buildLogMessage,
    cleanupTranscripts,
  }: SessionResetOptions): Promise<boolean> => {
    if (!sessionKey || !activeSessionStore || !storePath) {
      return false;
    }
    const prevEntry = activeSessionStore[sessionKey] ?? activeSessionEntry;
    if (!prevEntry) {
      return false;
    }
    const prevSessionId = cleanupTranscripts ? prevEntry.sessionId : undefined;
    const nextSessionId = generateSecureUuid();
    const nextEntry: SessionEntry = {
      ...prevEntry,
      sessionId: nextSessionId,
      updatedAt: Date.now(),
      systemSent: false,
      abortedLastRun: false,
      modelProvider: undefined,
      model: undefined,
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
      totalTokensFresh: false,
      estimatedCostUsd: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
      contextTokens: undefined,
      systemPromptReport: undefined,
      fallbackNoticeSelectedModel: undefined,
      fallbackNoticeActiveModel: undefined,
      fallbackNoticeReason: undefined,
      memoryFlushContextHash: undefined,
    };
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const nextSessionFile = resolveSessionTranscriptPath(
      nextSessionId,
      agentId,
      sessionCtx.MessageThreadId,
    );
    nextEntry.sessionFile = nextSessionFile;
    activeSessionStore[sessionKey] = nextEntry;
    try {
      const { updateSessionStore } = await loadSessionStoreRuntime();
      await updateSessionStore(storePath, (store) => {
        store[sessionKey] = nextEntry;
      });
    } catch (err) {
      defaultRuntime.error(
        `Failed to persist session reset after ${failureLabel} (${sessionKey}): ${String(err)}`,
      );
    }
    followupRun.run.sessionId = nextSessionId;
    followupRun.run.sessionFile = nextSessionFile;
    activeSessionEntry = nextEntry;
    activeIsNewSession = true;
    defaultRuntime.error(buildLogMessage(nextSessionId));
    if (cleanupTranscripts && prevSessionId) {
      const transcriptCandidates = new Set<string>();
      const resolved = resolveSessionFilePath(
        prevSessionId,
        prevEntry,
        resolveSessionFilePathOptions({ agentId, storePath }),
      );
      if (resolved) {
        transcriptCandidates.add(resolved);
      }
      transcriptCandidates.add(resolveSessionTranscriptPath(prevSessionId, agentId));
      for (const candidate of transcriptCandidates) {
        try {
          fs.unlinkSync(candidate);
        } catch {
          // Best-effort cleanup.
        }
      }
    }
    return true;
  };
  const resetSessionAfterCompactionFailure = async (reason: string): Promise<boolean> =>
    resetSession({
      failureLabel: "compaction failure",
      buildLogMessage: (nextSessionId) =>
        `Auto-compaction failed (${reason}). Restarting session ${sessionKey} -> ${nextSessionId} and retrying.`,
    });
  const resetSessionAfterRoleOrderingConflict = async (reason: string): Promise<boolean> =>
    resetSession({
      failureLabel: "role ordering conflict",
      buildLogMessage: (nextSessionId) =>
        `Role ordering conflict (${reason}). Restarting session ${sessionKey} -> ${nextSessionId}.`,
      cleanupTranscripts: true,
    });
  const maybeResetOversizedSession = async (): Promise<boolean> => {
    if (!sessionKey || !activeSessionEntry || isHeartbeat) {
      return false;
    }
    const totalTokens = activeSessionEntry.totalTokens ?? activeSessionEntry.inputTokens ?? 0;
    const rawMessage =
      sessionCtx.BodyForCommands ??
      sessionCtx.CommandBody ??
      sessionCtx.RawBody ??
      sessionCtx.Body ??
      commandBody;
    const normalizedMessage = rawMessage.trim();
    const isDirectChat =
      sessionCtx.ChatType === "direct" ||
      sessionKey.includes(":telegram:direct:") ||
      sessionKey.includes(":whatsapp:direct:");
    const sessionLooksOversized =
      totalTokens >= 50_000 ||
      Boolean(
        activeSessionEntry.systemPromptReport?.systemPrompt?.chars &&
        activeSessionEntry.systemPromptReport.systemPrompt.chars >= 30_000,
      );
    const messageLooksSimple = normalizedMessage.length > 0 && normalizedMessage.length <= 600;
    if (!isDirectChat || !sessionLooksOversized || !messageLooksSimple) {
      return false;
    }
    return await resetSession({
      failureLabel: "oversized polluted session",
      buildLogMessage: (nextSessionId) =>
        `Oversized direct session detected (${sessionKey}, tokens=${String(totalTokens)}). Restarting session -> ${nextSessionId}.`,
      cleanupTranscripts: true,
    });
  };
  const runTurnBody = async (): Promise<ReplyPayload | ReplyPayload[] | undefined> => {
  try {
    await maybeResetOversizedSession();
    const runStartedAt = Date.now();
    const runOutcome = await runAgentTurnWithFallback({
      commandBody,
      followupRun,
      sessionCtx,
      opts,
      typingSignals,
      blockReplyPipeline,
      blockStreamingEnabled,
      blockReplyChunking,
      resolvedBlockStreamingBreak,
      applyReplyToMode,
      shouldEmitToolResult,
      shouldEmitToolOutput,
      pendingToolTasks,
      resetSessionAfterCompactionFailure,
      resetSessionAfterRoleOrderingConflict,
      isHeartbeat,
      sessionKey,
      getActiveSessionEntry: () => activeSessionEntry,
      activeSessionStore,
      storePath,
      resolvedVerboseLevel,
    });

    if (runOutcome.kind === "final") {
      return finalizeWithFollowup(runOutcome.payload, queueKey, runFollowupTurn);
    }

    const {
      runId,
      runResult,
      fallbackProvider,
      fallbackModel,
      fallbackAttempts,
      directlySentBlockKeys,
    } = runOutcome;
    let { didLogHeartbeatStrip, autoCompactionCount } = runOutcome;

    if (
      shouldInjectGroupIntro &&
      activeSessionEntry &&
      activeSessionStore &&
      sessionKey &&
      activeSessionEntry.groupActivationNeedsSystemIntro
    ) {
      const updatedAt = Date.now();
      activeSessionEntry.groupActivationNeedsSystemIntro = false;
      activeSessionEntry.updatedAt = updatedAt;
      activeSessionStore[sessionKey] = activeSessionEntry;
      if (storePath) {
        const { updateSessionStoreEntry } = await loadSessionStoreRuntime();
        await updateSessionStoreEntry({
          storePath,
          sessionKey,
          update: async () => ({
            groupActivationNeedsSystemIntro: false,
            updatedAt,
          }),
        });
      }
    }

    const payloadArray = runResult.payloads ?? [];

    if (blockReplyPipeline) {
      await blockReplyPipeline.flush({ force: true });
      blockReplyPipeline.stop();
    }

    // NOTE: The compaction completion notice for block-streaming mode is sent
    // further below — after incrementRunCompactionCount — so it can include
    // the `(count N)` suffix.  Sending it here (before the count is known)
    // would omit that information.
    if (pendingToolTasks.size > 0) {
      await Promise.allSettled(pendingToolTasks);
    }

    const usage = runResult.meta?.agentMeta?.usage;
    const promptTokens = runResult.meta?.agentMeta?.promptTokens;
    const modelUsed = runResult.meta?.agentMeta?.model ?? fallbackModel ?? defaultModel;
    const providerUsed =
      runResult.meta?.agentMeta?.provider ?? fallbackProvider ?? followupRun.run.provider;
    const verboseEnabled = resolvedVerboseLevel !== "off";
    const selectedProvider = followupRun.run.provider;
    const selectedModel = followupRun.run.model;
    const fallbackStateEntry =
      activeSessionEntry ?? (sessionKey ? activeSessionStore?.[sessionKey] : undefined);
    const fallbackTransition = resolveFallbackTransition({
      selectedProvider,
      selectedModel,
      activeProvider: providerUsed,
      activeModel: modelUsed,
      attempts: fallbackAttempts,
      state: fallbackStateEntry,
    });
    if (fallbackTransition.stateChanged) {
      if (fallbackStateEntry) {
        fallbackStateEntry.fallbackNoticeSelectedModel = fallbackTransition.nextState.selectedModel;
        fallbackStateEntry.fallbackNoticeActiveModel = fallbackTransition.nextState.activeModel;
        fallbackStateEntry.fallbackNoticeReason = fallbackTransition.nextState.reason;
        fallbackStateEntry.updatedAt = Date.now();
        activeSessionEntry = fallbackStateEntry;
      }
      if (sessionKey && fallbackStateEntry && activeSessionStore) {
        activeSessionStore[sessionKey] = fallbackStateEntry;
      }
      if (sessionKey && storePath) {
        const { updateSessionStoreEntry } = await loadSessionStoreRuntime();
        await updateSessionStoreEntry({
          storePath,
          sessionKey,
          update: async () => ({
            fallbackNoticeSelectedModel: fallbackTransition.nextState.selectedModel,
            fallbackNoticeActiveModel: fallbackTransition.nextState.activeModel,
            fallbackNoticeReason: fallbackTransition.nextState.reason,
          }),
        });
      }
    }
    const cliSessionId = isCliProvider(providerUsed, cfg)
      ? runResult.meta?.agentMeta?.sessionId?.trim()
      : undefined;
    const cachedContextTokens = lookupCachedContextTokens(modelUsed);
    const contextTokensUsed =
      agentCfgContextTokens ??
      cachedContextTokens ??
      lookupContextTokens(modelUsed, { allowAsyncLoad: false }) ??
      activeSessionEntry?.contextTokens ??
      DEFAULT_CONTEXT_TOKENS;

    await persistRunSessionUsage({
      storePath,
      sessionKey,
      cfg,
      usage,
      lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
      promptTokens,
      modelUsed,
      providerUsed,
      contextTokensUsed,
      systemPromptReport: runResult.meta?.systemPromptReport,
      cliSessionId,
    });

    // Drain any late tool/block deliveries before deciding there's "nothing to send".
    // Otherwise, a late typing trigger (e.g. from a tool callback) can outlive the run and
    // keep the typing indicator stuck.
    if (payloadArray.length === 0) {
      const closureDecision = reevaluateMessagingDecisionForMessagingRun({
        runResult,
        replyPayloads: [],
        runPayloadsForEvidence: payloadArray,
        sourceRun: followupRun,
      });
      const acceptanceOutcome = closureDecision?.acceptanceOutcome;
      const supervisorVerdict = closureDecision?.supervisorVerdict;
      const deferDeliveryClosure = Boolean(opts?.onDeliveryClosureCandidate);
      const queuedSemanticRetry = deferDeliveryClosure
        ? false
        : enqueueSemanticRetryFollowup({
            queueKey,
            sourceRun: correlationSourceRun,
            settings: resolvedQueue,
            acceptance: acceptanceOutcome,
            supervisorVerdict,
          });
      captureMessagingDeliveryClosureCandidate({
        onCandidate: opts?.onDeliveryClosureCandidate,
        runResult,
        sourceRun: correlationSourceRun,
        queueKey,
        settings: resolvedQueue,
      });
      const fallbackPayload = buildAcceptanceFallbackPayload(acceptanceOutcome, supervisorVerdict, {
        channel: replyToChannel,
      });
      if (fallbackPayload && !queuedSemanticRetry) {
        return finalizeWithFollowup(fallbackPayload, queueKey, runFollowupTurn);
      }
      return finalizeWithFollowup(undefined, queueKey, runFollowupTurn);
    }

    const payloadResult = await buildReplyPayloads({
      payloads: payloadArray,
      isHeartbeat,
      didLogHeartbeatStrip,
      blockStreamingEnabled,
      blockReplyPipeline,
      directlySentBlockKeys,
      replyToMode,
      replyToChannel,
      currentMessageId: sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
      messageProvider: followupRun.run.messageProvider,
      messagingToolSentTexts: runResult.messagingToolSentTexts,
      messagingToolSentMediaUrls: runResult.messagingToolSentMediaUrls,
      messagingToolSentTargets: runResult.messagingToolSentTargets,
      originatingChannel: sessionCtx.OriginatingChannel,
      originatingTo: resolveOriginMessageTo({
        originatingTo: sessionCtx.OriginatingTo,
        to: sessionCtx.To,
      }),
      accountId: sessionCtx.AccountId,
      normalizeMediaPaths: normalizeReplyMediaPaths,
    });
    const { replyPayloads, allReplyPayloadsAlreadyDelivered } = payloadResult;
    didLogHeartbeatStrip = payloadResult.didLogHeartbeatStrip;

    if (replyPayloads.length === 0) {
      if (allReplyPayloadsAlreadyDelivered) {
        captureMessagingDeliveryClosureCandidate({
          onCandidate: opts?.onDeliveryClosureCandidate,
          runResult,
          sourceRun: correlationSourceRun,
          queueKey,
          settings: resolvedQueue,
        });
        return finalizeWithFollowup(undefined, queueKey, runFollowupTurn);
      }
      const closureDecision = reevaluateMessagingDecisionForMessagingRun({
        runResult,
        replyPayloads: [],
        runPayloadsForEvidence: payloadArray,
        sourceRun: correlationSourceRun,
      });
      const acceptanceOutcome = closureDecision?.acceptanceOutcome;
      const supervisorVerdict = closureDecision?.supervisorVerdict;
      const deferDeliveryClosure = Boolean(opts?.onDeliveryClosureCandidate);
      const queuedSemanticRetry = deferDeliveryClosure
        ? false
        : enqueueSemanticRetryFollowup({
            queueKey,
            sourceRun: correlationSourceRun,
            settings: resolvedQueue,
            acceptance: acceptanceOutcome,
            supervisorVerdict,
          });
      captureMessagingDeliveryClosureCandidate({
        onCandidate: opts?.onDeliveryClosureCandidate,
        runResult,
        sourceRun: correlationSourceRun,
        queueKey,
        settings: resolvedQueue,
      });
      const fallbackPayload = buildAcceptanceFallbackPayload(acceptanceOutcome, supervisorVerdict, {
        channel: replyToChannel,
      });
      if (fallbackPayload && !queuedSemanticRetry) {
        return finalizeWithFollowup(fallbackPayload, queueKey, runFollowupTurn);
      }
      return finalizeWithFollowup(undefined, queueKey, runFollowupTurn);
    }

    const successfulCronAdds = runResult.successfulCronAdds ?? 0;
    const hasReminderCommitment = replyPayloads.some(
      (payload) =>
        !payload.isError &&
        typeof payload.text === "string" &&
        hasUnbackedReminderCommitment(payload.text),
    );
    // Suppress the guard note when an existing cron job (created in a prior
    // turn) already covers the commitment — avoids false positives (#32228).
    const coveredByExistingCron =
      hasReminderCommitment && successfulCronAdds === 0
        ? await hasSessionRelatedCronJobs({
            cronStorePath: cfg.cron?.store,
            sessionKey,
          })
        : false;
    const guardedReplyPayloads =
      hasReminderCommitment && successfulCronAdds === 0 && !coveredByExistingCron
        ? appendUnscheduledReminderNote(replyPayloads)
        : replyPayloads;
    const closureDecision = reevaluateMessagingDecisionForMessagingRun({
      runResult,
      replyPayloads: guardedReplyPayloads,
      runPayloadsForEvidence: payloadArray,
      sourceRun: correlationSourceRun,
    });
    const acceptanceOutcome = closureDecision?.acceptanceOutcome;
    const supervisorVerdict = closureDecision?.supervisorVerdict;
    const deferDeliveryClosure = Boolean(opts?.onDeliveryClosureCandidate);
    const queuedSemanticRetry = deferDeliveryClosure
      ? false
      : enqueueSemanticRetryFollowup({
          queueKey,
          sourceRun: correlationSourceRun,
          settings: resolvedQueue,
          acceptance: acceptanceOutcome,
          supervisorVerdict,
        });
    captureMessagingDeliveryClosureCandidate({
      onCandidate: opts?.onDeliveryClosureCandidate,
      runResult,
      sourceRun: correlationSourceRun,
      queueKey,
      settings: resolvedQueue,
    });
    if (
      shouldSuppressDeferredSemanticRetryReply({
        deferDeliveryClosure,
        replyPayloads: guardedReplyPayloads,
        artifactKinds: runResult.meta?.executionIntent?.artifactKinds,
        acceptanceOutcome,
        supervisorVerdict,
      })
    ) {
      return finalizeWithFollowup(undefined, queueKey, runFollowupTurn);
    }

    await signalTypingIfNeeded(guardedReplyPayloads, typingSignals);

    if (isDiagnosticsEnabled(cfg) && hasNonzeroUsage(usage)) {
      const { estimateUsageCost, resolveModelCostConfig } = await loadUsageCostRuntime();
      const input = usage.input ?? 0;
      const output = usage.output ?? 0;
      const cacheRead = usage.cacheRead ?? 0;
      const cacheWrite = usage.cacheWrite ?? 0;
      const promptTokens = input + cacheRead + cacheWrite;
      const totalTokens = usage.total ?? promptTokens + output;
      const costConfig = resolveModelCostConfig({
        provider: providerUsed,
        model: modelUsed,
        config: cfg,
      });
      const costUsd = estimateUsageCost({ usage, cost: costConfig });
      emitDiagnosticEvent({
        type: "model.usage",
        sessionKey,
        sessionId: followupRun.run.sessionId,
        channel: replyToChannel,
        provider: providerUsed,
        model: modelUsed,
        usage: {
          input,
          output,
          cacheRead,
          cacheWrite,
          promptTokens,
          total: totalTokens,
        },
        lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
        context: {
          limit: contextTokensUsed,
          used: totalTokens,
        },
        costUsd,
        durationMs: Date.now() - runStartedAt,
      });
    }

    const responseUsageRaw =
      activeSessionEntry?.responseUsage ??
      (sessionKey ? activeSessionStore?.[sessionKey]?.responseUsage : undefined);
    const responseUsageMode = resolveResponseUsageMode(responseUsageRaw);
    if (responseUsageMode !== "off" && hasNonzeroUsage(usage)) {
      const { resolveModelCostConfig } = await loadUsageCostRuntime();
      const authMode = resolveModelAuthMode(providerUsed, cfg);
      const showCost = authMode === "api-key";
      const costConfig = showCost
        ? resolveModelCostConfig({
            provider: providerUsed,
            model: modelUsed,
            config: cfg,
          })
        : undefined;
      let formatted = formatResponseUsageLine({
        usage,
        showCost,
        costConfig,
      });
      if (formatted && responseUsageMode === "full" && sessionKey) {
        formatted = `${formatted} · session \`${sessionKey}\``;
      }
      if (formatted) {
        responseUsageLine = formatted;
      }
    }

    // If verbose is enabled, prepend operational run notices.
    let finalPayloads = guardedReplyPayloads;
    const verboseNotices: ReplyPayload[] = [];

    if (verboseEnabled && activeIsNewSession) {
      verboseNotices.push({ text: `🧭 New session: ${followupRun.run.sessionId}` });
    }

    if (fallbackTransition.fallbackTransitioned) {
      emitAgentEvent({
        runId,
        sessionKey,
        stream: "lifecycle",
        data: {
          phase: "fallback",
          selectedProvider,
          selectedModel,
          activeProvider: providerUsed,
          activeModel: modelUsed,
          reasonSummary: fallbackTransition.reasonSummary,
          attemptSummaries: fallbackTransition.attemptSummaries,
          attempts: fallbackAttempts,
        },
      });
      if (verboseEnabled) {
        const fallbackNotice = buildFallbackNotice({
          selectedProvider,
          selectedModel,
          activeProvider: providerUsed,
          activeModel: modelUsed,
          attempts: fallbackAttempts,
        });
        if (fallbackNotice) {
          verboseNotices.push({ text: fallbackNotice });
        }
      }
    }
    if (fallbackTransition.fallbackCleared) {
      emitAgentEvent({
        runId,
        sessionKey,
        stream: "lifecycle",
        data: {
          phase: "fallback_cleared",
          selectedProvider,
          selectedModel,
          activeProvider: providerUsed,
          activeModel: modelUsed,
          previousActiveModel: fallbackTransition.previousState.activeModel,
        },
      });
      if (verboseEnabled) {
        verboseNotices.push({
          text: buildFallbackClearedNotice({
            selectedProvider,
            selectedModel,
            previousActiveModel: fallbackTransition.previousState.activeModel,
          }),
        });
      }
    }

    if (autoCompactionCount > 0) {
      const count = await incrementRunCompactionCount({
        sessionEntry: activeSessionEntry,
        sessionStore: activeSessionStore,
        sessionKey,
        storePath,
        amount: autoCompactionCount,
        lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
        contextTokensUsed,
      });

      // Inject post-compaction workspace context for the next agent turn
      if (sessionKey) {
        const workspaceDir = process.cwd();
        readPostCompactionContext(workspaceDir, cfg)
          .then((contextContent) => {
            if (contextContent) {
              enqueueSystemEvent(contextContent, { sessionKey });
            }
          })
          .catch(() => {
            // Silent failure — post-compaction context is best-effort
          });
      }

      // Always notify the user when compaction completes — not just in verbose
      // mode. The "🧹 Compacting context..." notice was already sent at start,
      // so the completion message closes the loop for every user regardless of
      // their verbose setting.
      const suffix = typeof count === "number" ? ` (count ${count})` : "";
      const completionText = verboseEnabled
        ? `🧹 Auto-compaction complete${suffix}.`
        : `✅ Context compacted${suffix}.`;

      if (blockReplyPipeline && opts?.onBlockReply) {
        // In block-streaming mode, send the completion notice via
        // fire-and-forget *after* the pipeline has flushed (so it does not set
        // didStream()=true and cause buildReplyPayloads to discard the real
        // assistant reply).  Now that the count is known we can include it.
        const currentMessageId = sessionCtx.MessageSidFull ?? sessionCtx.MessageSid;
        const noticePayload = applyReplyToMode({
          text: completionText,
          replyToId: currentMessageId,
          replyToCurrent: true,
          isCompactionNotice: true,
        });
        void Promise.race([
          opts.onBlockReply(noticePayload),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error("compaction notice timeout")), blockReplyTimeoutMs),
          ),
        ]).catch(() => {
          // Intentionally swallowed — the notice is informational only.
        });
      } else {
        // Non-streaming: push into verboseNotices with full compaction metadata
        // so threading exemptions apply and replyToMode=first does not thread
        // the notice instead of the real assistant reply.
        const currentMessageId = sessionCtx.MessageSidFull ?? sessionCtx.MessageSid;
        verboseNotices.push(
          applyReplyToMode({
            text: completionText,
            replyToId: currentMessageId,
            replyToCurrent: true,
            isCompactionNotice: true,
          }),
        );
      }
    }
    if (verboseNotices.length > 0) {
      finalPayloads = [...verboseNotices, ...finalPayloads];
    }
    if (responseUsageLine) {
      finalPayloads = appendUsageLine(finalPayloads, responseUsageLine);
    }
    if (finalPayloads.length === 0) {
      const fallbackPayload = buildAcceptanceFallbackPayload(acceptanceOutcome, supervisorVerdict, {
        channel: replyToChannel,
      });
      if (fallbackPayload && !queuedSemanticRetry) {
        finalPayloads = [fallbackPayload];
      }
    }
    const debugReplyBlock = buildDebugReplyBlock({
      userMessage:
        sessionCtx.BodyForCommands ??
        sessionCtx.CommandBody ??
        sessionCtx.RawBody ??
        sessionCtx.Body ??
        commandBody,
      selectedProvider,
      selectedModel,
      activeProvider: providerUsed,
      activeModel: modelUsed,
      fallbackAttempts,
      usage,
      lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
      executionIntent: runResult.meta?.executionIntent?.intent,
      classifierTelemetry: runResult.meta?.executionIntent?.classifierTelemetry,
      routingOutcome: runResult.meta?.executionIntent?.routingOutcome,
    });
    if (debugReplyBlock) {
      finalPayloads = appendUsageLine(finalPayloads, debugReplyBlock);
    }

    const channelForLedger = (
      replyToChannel ??
      sessionCtx.Surface ??
      sessionCtx.Provider ??
      sessionCtx.OriginatingChannel
    )
      ?.trim()
      .toLowerCase();
    const ledgerSummary = summarizeFinalAssistantText(guardedReplyPayloads);
    if (followupRun.run.sessionId && channelForLedger && ledgerSummary) {
      const recordedLedgerEntry = intentLedger.recordFromBotTurn({
        turnId: runId,
        sessionId: followupRun.run.sessionId,
        channelId: channelForLedger,
        summary: ledgerSummary,
        planOutput: runResult.meta?.executionIntent,
        runtimeReceipts: runResult.meta?.executionVerification?.receipts,
      });
      intentLedgerLog.info(
        `[intent-ledger] recorded session=${followupRun.run.sessionId} channel=${channelForLedger}`,
      );

      const executionReceipts = runResult.meta?.executionVerification?.receipts ?? [];
      const executionVerification = runResult.meta?.executionVerification;
      if (turnProgressEmitter) {
        for (const receipt of executionReceipts) {
          if (receipt.kind === "tool") {
            const toolName =
              typeof receipt.name === "string" && receipt.name.trim()
                ? receipt.name.trim()
                : undefined;
            if (toolName) {
              turnProgressEmitter.emit("tool_call", toolName, { toolName });
            }
          }
        }
      }
      const pendingPromises = recordedLedgerEntry?.kind === "promised_action"
        ? [recordedLedgerEntry]
        : [];
      if (pendingPromises.length > 0) {
        const violations = reconcilePromisesWithReceipts({
          pendingPromises,
          receipts: executionReceipts,
          ...(executionVerification ? { verification: executionVerification } : {}),
        });
        const hardViolations = violations.filter((v) => v.severity === "hard");
        const softViolations = violations.filter((v) => v.severity === "soft");
        const alreadyEvidenceReplan =
          followupRun.automation?.reasonCode === EVIDENCE_HARD_REPLAN_REASON_CODE;
        let action: "none" | "soft" | "hard-replan" = "none";
        if (hardViolations.length > 0) {
          if (alreadyEvidenceReplan) {
            evidenceLog.warn("[evidence] replan-budget-exhausted");
            for (const violation of hardViolations) {
              intentLedger.recordViolatedPromise({
                turnId: violation.turnId,
                sessionId: followupRun.run.sessionId,
                channelId: channelForLedger,
                summary: violation.summary,
                ...(violation.expectedReceiptKinds || violation.expectedToolNames
                  ? {
                      receiptMatchers: {
                        ...(violation.expectedReceiptKinds.length > 0
                          ? { receiptKinds: [...violation.expectedReceiptKinds] }
                          : {}),
                        ...(violation.expectedToolNames?.length
                          ? { toolNames: [...violation.expectedToolNames] }
                          : {}),
                      },
                    }
                  : {}),
              });
            }
            action = "soft";
          } else {
            const firstHard = hardViolations[0]!;
            const enqueued = enqueueEvidenceHardReplan({
              queueKey,
              sourceRun: followupRun,
              settings: resolvedQueue,
              violation: firstHard,
            });
            action = enqueued ? "hard-replan" : "soft";
            if (!enqueued) {
              intentLedger.recordViolatedPromise({
                turnId: firstHard.turnId,
                sessionId: followupRun.run.sessionId,
                channelId: channelForLedger,
                summary: firstHard.summary,
                ...(firstHard.expectedReceiptKinds || firstHard.expectedToolNames
                  ? {
                      receiptMatchers: {
                        ...(firstHard.expectedReceiptKinds.length > 0
                          ? { receiptKinds: [...firstHard.expectedReceiptKinds] }
                          : {}),
                        ...(firstHard.expectedToolNames?.length
                          ? { toolNames: [...firstHard.expectedToolNames] }
                          : {}),
                      },
                    }
                  : {}),
              });
            }
          }
        } else if (softViolations.length > 0) {
          action = "soft";
          for (const violation of softViolations) {
            intentLedger.recordViolatedPromise({
              turnId: violation.turnId,
              sessionId: followupRun.run.sessionId,
              channelId: channelForLedger,
              summary: violation.summary,
              ...(violation.expectedReceiptKinds || violation.expectedToolNames
                ? {
                    receiptMatchers: {
                      ...(violation.expectedReceiptKinds.length > 0
                        ? { receiptKinds: [...violation.expectedReceiptKinds] }
                        : {}),
                      ...(violation.expectedToolNames?.length
                        ? { toolNames: [...violation.expectedToolNames] }
                        : {}),
                    },
                  }
                : {}),
            });
          }
        }
        evidenceLog.info(
          `[evidence] promises=${pendingPromises.length} receipts=${executionReceipts.length} violations=${violations.length} action=${action}`,
        );
        if (action !== "none" && turnProgressEmitter) {
          turnProgressEmitter.emit("evidence", action, { violationAction: action });
        }
      } else {
        evidenceLog.info(
          `[evidence] promises=0 receipts=${executionReceipts.length} violations=0 action=none`,
        );
      }
    }

    if (queuedSemanticRetry) {
      return finalizeWithFollowup(undefined, queueKey, runFollowupTurn);
    }

    return finalizeWithFollowup(
      finalPayloads.length === 0
        ? undefined
        : finalPayloads.length === 1
          ? finalPayloads[0]
          : finalPayloads,
      queueKey,
      runFollowupTurn,
    );
  } catch (error) {
    // Keep the followup queue moving even when an unexpected exception escapes
    // the run path; the caller still receives the original error.
    finalizeWithFollowup(undefined, queueKey, runFollowupTurn);
    throw error;
  } finally {
    blockReplyPipeline?.stop();
    typing.markRunComplete();
    // Safety net: the dispatcher's onIdle callback normally fires
    // markDispatchIdle(), but if the dispatcher exits early, errors,
    // or the reply path doesn't go through it cleanly, the second
    // signal never fires and the typing keepalive loop runs forever.
    // Calling this twice is harmless — cleanup() is guarded by the
    // `active` flag.  Same pattern as the followup runner fix (#26881).
    typing.markDispatchIdle();
  }
  };
  if (turnProgressEmitter) {
    try {
      const out = await withTurnProgressEmitter(turnProgressEmitter, runTurnBody);
      if (!turnProgressEmitter.finalized) {
        turnProgressEmitter.done();
      }
      return out;
    } catch (err) {
      if (!turnProgressEmitter.finalized) {
        turnProgressEmitter.error(err);
      }
      throw err;
    }
  }
  return runTurnBody();
}
