import { resolveAgentDir } from "../agents/agent-scope.js";
import { withReplyDispatcher } from "../auto-reply/dispatch.js";
import {
  dispatchReplyFromConfig,
  type DispatchFromConfigResult,
} from "../auto-reply/reply/dispatch-from-config.js";
import type { ReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { GetReplyOptions } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { sendMessage } from "../infra/outbound/message.js";
import { callConversationLLM, diagnoseTurn } from "../orchestrator-v1/diagnostic.js";
import {
  DEFAULT_STAGE_A_MODEL,
  type StageAModelRef,
} from "../orchestrator-v1/classifier-stage-a.js";
import {
  runOrchestratorTurn,
  type RunOrchestratorTurnResult,
} from "../orchestrator-v1/orchestrator.js";
import {
  buildRunToolFromRegistry,
  type RegistryDeps,
} from "../orchestrator-v1/tool-runner-registry.js";
import { getProcessTurnStateStore } from "../orchestrator-v1/turn-state/index.js";
import type {
  RunConversationLLMFn,
  RunToolFn,
} from "../orchestrator-v1/dispatcher.js";
import type {
  CreatePersistentWorkerFn,
  ScheduleCronFn,
} from "../orchestrator-v1/tool-runners/scheduling.js";
import type { SessionsSendFn } from "../orchestrator-v1/tool-runners/sessions.js";
import { createChannelReplyPipeline } from "./channel-reply-pipeline.js";
import { createNormalizedOutboundDeliverer, type OutboundReplyPayload } from "./reply-payload.js";

type ReplyOptionsWithoutModelSelected = Omit<
  Omit<GetReplyOptions, "onToolResult" | "onBlockReply">,
  "onModelSelected"
>;
type RecordInboundSessionFn = typeof import("../channels/session.js").recordInboundSession;
type DispatchReplyWithBufferedBlockDispatcherFn =
  typeof import("../auto-reply/reply/provider-dispatcher.js").dispatchReplyWithBufferedBlockDispatcher;

type ReplyDispatchFromConfigOptions = Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;

/**
 * V1-CUTOVER S10 — Production short-circuit for the V1-CONTRACT-ONLY
 * orchestrator on the universal (non-Telegram) inbound dispatch path.
 *
 * Mirrors `executeOrchestratorV1ShortCircuit` in
 * `extensions/telegram/src/bot-message-dispatch.ts` (S9): when
 * `OPENCLAW_USE_V1_ORCHESTRATOR=1` is set, inbound messages from any
 * channel that funnels through `recordInboundSessionAndDispatchReply`
 * route through `runOrchestratorTurn(...)` (Stage A classifier + Stage B
 * arg extraction + dispatcher with the real tool-runner registry from
 * S8) instead of the previous `diagnoseTurn` (read-only) short-circuit.
 *
 * Returns:
 *   - `false` when the env flag is unset OR the user message is empty,
 *     so the caller falls through to the legacy reply pipeline.
 *   - `true` when the orchestrator handled the turn (success OR caught
 *     error → `onDispatchError` + generic error reply via `deliver`).
 *     Caller MUST `return` immediately to skip the legacy pipeline.
 *
 * Production wiring (per S10 acceptance):
 *   - `runTool` = `buildRunToolFromRegistry(registryDeps)`.
 *     `registryDeps`:
 *       - `send`: forwards to `infra/outbound/message.sendMessage(...)`,
 *         the universal cross-channel outbound primitive. The classifier-
 *         extracted `channel` arg is treated as the destination address
 *         (`to`); the inbound channel name + accountId scope the
 *         outbound to the same transport that received the user
 *         message.
 *       - `scheduling.scheduleCron` / `scheduling.createPersistentWorker`:
 *         PLACEHOLDER (mirrors S9). Real CronService and persistent-
 *         worker bootstrap live in gateway scope; the universal dispatch
 *         module does not currently access them. Returning a clear
 *         failure here is preferable to dragging in commitment-kernel
 *         deps (forbidden by V1-CUTOVER invariant #1) — the dispatcher
 *         renders a truthful failure template.
 *
 *   - `runConversationLLM` = `callConversationLLM(text, classifierModel,
 *     { cfg, agentDir })` — re-uses the same simple-completion helper
 *     S9 + diagnostic mode use. `CONVERSATION_SYSTEM_PROMPT_GUARD` is
 *     injected by `callConversationLLM` itself.
 *
 *   - `cfg` + `agentDir`: REQUIRED to be forwarded to
 *     `runOrchestratorTurn`. Without these, Stage A model resolution
 *     falls back to a global config that lacks the agent-scoped
 *     provider table (the S9.1 hotfix that this slice mirrors). The
 *     test `inbound-reply-dispatch-orchestrator-v1.test.ts` asserts
 *     these are forwarded as truthy values.
 *
 * Telemetry contract:
 *   - `[orch-v1] turn started chatKey=<id> userMessageLen=<n>`
 *   - `[orch-v1] turn completed contractIntent=<x> allOk=<bool> replyLen=<n>`
 *   - written to `process.stderr` so the live-verifier monitor on
 *     `*.err.log` sees them. Plus the registry already emits
 *     `[tool-runner]` lines.
 *
 * Error safety: a thrown `runOrchestratorTurn` (which it is supposed to
 * catch internally — defensive only) is reported via `onDispatchError`
 * and a generic Russian error message is delivered to the originating
 * channel via `deliver`. The helper never throws.
 */
export type ExecuteOrchestratorV1UniversalShortCircuitArgs = {
  /** Inbound user text (already extracted from RawBody/CommandBody/Body). */
  userText: string;
  /** Stable chat identifier for the chat lock + telemetry. */
  chatKey: string;
  /** Loaded `OpenClawConfig` (required for classifier model resolution). */
  cfg: OpenClawConfig;
  /** Agent id used to resolve `agentDir` for agent-scoped model providers. */
  agentId: string;
  /** Inbound channel name (e.g. "discord", "irc"). Forwarded to outbound `sendMessage`. */
  channel: string;
  /** Optional account id scoping outbound delivery. */
  accountId?: string;
  /** Inbound deliverer — used for both success and error replies. */
  deliver: (payload: OutboundReplyPayload) => Promise<void>;
  /** Optional dispatcher error sink (mirrors the legacy `onDispatchError`). */
  onDispatchError?: (err: unknown, info: { kind: string }) => void;
  /** Optional Stage-A/B model override. */
  classifierModel?: StageAModelRef;
};

/**
 * Test-only seam: lets a unit test inject stubs for the orchestrator-v1
 * surface + `resolveAgentDir` without going through `vi.mock("openclaw/...")`,
 * which is fragile against the dispatch module's heavy import graph.
 * Production callers omit this parameter.
 */
export type ExecuteOrchestratorV1UniversalShortCircuitOverrides = {
  runOrchestratorTurn?: typeof runOrchestratorTurn;
  buildRunToolFromRegistry?: typeof buildRunToolFromRegistry;
  callConversationLLM?: typeof callConversationLLM;
  resolveAgentDir?: typeof resolveAgentDir;
  /**
   * Optional outbound override for the `sessions_send` binding. Tests pass a
   * stub to avoid hitting the real channel-resolution + delivery stack.
   */
  sendMessage?: typeof sendMessage;
  getProcessTurnStateStore?: typeof getProcessTurnStateStore;
};

export async function executeOrchestratorV1UniversalShortCircuit(
  args: ExecuteOrchestratorV1UniversalShortCircuitArgs,
  overrides: ExecuteOrchestratorV1UniversalShortCircuitOverrides = {},
): Promise<boolean> {
  const runTurnImpl = overrides.runOrchestratorTurn ?? runOrchestratorTurn;
  const buildRegistryImpl =
    overrides.buildRunToolFromRegistry ?? buildRunToolFromRegistry;
  const callLLMImpl = overrides.callConversationLLM ?? callConversationLLM;
  const resolveAgentDirImpl = overrides.resolveAgentDir ?? resolveAgentDir;
  const sendMessageImpl = overrides.sendMessage ?? sendMessage;
  const turnStateStoreImpl =
    overrides.getProcessTurnStateStore ?? getProcessTurnStateStore;
  if (process.env.OPENCLAW_USE_V1_ORCHESTRATOR !== "1") {
    return false;
  }
  const userText = args.userText;
  if (!userText || userText.trim().length === 0) {
    return false;
  }
  const { chatKey, cfg, agentId, channel, accountId, deliver, onDispatchError } = args;
  // S9.1 mirror: thread the same `cfg` + `agentDir` the caller's stack
  // already uses so Stage A model resolution sees the agent-scoped
  // provider table. Resolved here (not at module load) so each turn
  // picks up live config edits.
  const agentDir = resolveAgentDirImpl(cfg, agentId);

  // Production binding: universal cross-channel outbound for `sessions_send`.
  // The classifier-extracted `channel` arg is the destination address
  // (chat id / room id / etc.); the inbound `channel` + `accountId`
  // scope the transport. Throw on failure so the runner reports
  // `{ ok: false }` and the dispatcher renders the failure template.
  const send: SessionsSendFn = async (destination, text) => {
    await sendMessageImpl({
      to: destination,
      content: text,
      channel,
      accountId,
      agentId,
      cfg,
    });
  };

  // S10 placeholders for cron + persistent_worker_push (mirrors S9).
  // Real CronService + persistent-worker bootstrap require gateway-
  // scoped handles which the universal dispatch module does not
  // currently receive. Fail-closed surfaces the gap honestly.
  const scheduleCron: ScheduleCronFn = async () => {
    throw new Error("cron not yet wired in S10 — operator follow-up");
  };
  const createPersistentWorker: CreatePersistentWorkerFn = async () => {
    throw new Error(
      "persistent_worker_push not yet wired in S10 — operator follow-up",
    );
  };

  const runTool: RunToolFn = buildRegistryImpl({
    send,
    scheduling: { scheduleCron, createPersistentWorker },
  } satisfies RegistryDeps);

  const classifierModel = args.classifierModel ?? DEFAULT_STAGE_A_MODEL;
  const runConversationLLM: RunConversationLLMFn = async (userMessage) => {
    return callLLMImpl(userMessage, classifierModel, { cfg, agentDir });
  };

  process.stderr.write(
    `[orch-v1] turn started chatKey=${chatKey} userMessageLen=${userText.length}\n`,
  );
  try {
    // Multi-turn activation (PR #349 wiring): pass the process-scoped
    // singleton store so a Stage-B `missing_field` refuse stashes a
    // pending plan for the next inbound on this chat. Shared with the
    // Telegram and agent-command short-circuits via `getProcessTurnStateStore`.
    const result: RunOrchestratorTurnResult = await runTurnImpl({
      userMessage: userText,
      chatKey,
      runTool,
      runConversationLLM,
      cfg,
      agentDir,
      classifierModel: args.classifierModel,
      turnState: turnStateStoreImpl(),
    });
    process.stderr.write(
      `[orch-v1] turn completed contractIntent=${result.contract.intent} allOk=${result.dispatch.allOk} replyLen=${result.reply.length}\n`,
    );
    try {
      await deliver({ text: result.reply });
    } catch (sendErr) {
      process.stderr.write(
        `[orch-v1] outbound deliver failed chatKey=${chatKey}: ${String(sendErr)}\n`,
      );
      onDispatchError?.(sendErr, { kind: "orchestrator-v1-deliver" });
    }
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[orch-v1] turn failed chatKey=${chatKey}: ${message}\n`);
    onDispatchError?.(err, { kind: "orchestrator-v1" });
    try {
      await deliver({ text: `(orchestrator-v1 ошибка: ${message})` });
    } catch {
      // Surface fallback failure but don't propagate.
    }
    return true;
  }
}

/** Run `dispatchReplyFromConfig` with a dispatcher that always gets its settled callback. */
export async function dispatchReplyFromConfigWithSettledDispatcher(params: {
  cfg: OpenClawConfig;
  ctxPayload: FinalizedMsgContext;
  dispatcher: ReplyDispatcher;
  onSettled: () => void | Promise<void>;
  replyOptions?: ReplyDispatchFromConfigOptions;
}): Promise<DispatchFromConfigResult> {
  return await withReplyDispatcher({
    dispatcher: params.dispatcher,
    onSettled: params.onSettled,
    run: () =>
      dispatchReplyFromConfig({
        ctx: params.ctxPayload,
        cfg: params.cfg,
        dispatcher: params.dispatcher,
        replyOptions: params.replyOptions,
      }),
  });
}

/** Assemble the common inbound reply dispatch dependencies for a resolved route. */
export function buildInboundReplyDispatchBase(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  route: {
    agentId: string;
    sessionKey: string;
  };
  storePath: string;
  ctxPayload: FinalizedMsgContext;
  core: {
    channel: {
      session: {
        recordInboundSession: RecordInboundSessionFn;
      };
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcherFn;
      };
    };
  };
}) {
  return {
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    agentId: params.route.agentId,
    routeSessionKey: params.route.sessionKey,
    storePath: params.storePath,
    ctxPayload: params.ctxPayload,
    recordInboundSession: params.core.channel.session.recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher:
      params.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
  };
}

type BuildInboundReplyDispatchBaseParams = Parameters<typeof buildInboundReplyDispatchBase>[0];
type RecordInboundSessionAndDispatchReplyParams = Parameters<
  typeof recordInboundSessionAndDispatchReply
>[0];

/** Resolve the shared dispatch base and immediately record + dispatch one inbound reply turn. */
export async function dispatchInboundReplyWithBase(
  params: BuildInboundReplyDispatchBaseParams &
    Pick<
      RecordInboundSessionAndDispatchReplyParams,
      "deliver" | "onRecordError" | "onDispatchError" | "replyOptions"
    >,
): Promise<void> {
  const dispatchBase = buildInboundReplyDispatchBase(params);
  await recordInboundSessionAndDispatchReply({
    ...dispatchBase,
    deliver: params.deliver,
    onRecordError: params.onRecordError,
    onDispatchError: params.onDispatchError,
    replyOptions: params.replyOptions,
  });
}

/** Record the inbound session first, then dispatch the reply using normalized outbound delivery. */
export async function recordInboundSessionAndDispatchReply(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  agentId: string;
  routeSessionKey: string;
  storePath: string;
  ctxPayload: FinalizedMsgContext;
  recordInboundSession: RecordInboundSessionFn;
  dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcherFn;
  deliver: (payload: OutboundReplyPayload) => Promise<void>;
  onRecordError: (err: unknown) => void;
  onDispatchError: (err: unknown, info: { kind: string }) => void;
  replyOptions?: ReplyOptionsWithoutModelSelected;
}): Promise<void> {
  await params.recordInboundSession({
    storePath: params.storePath,
    sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
    ctx: params.ctxPayload,
    onRecordError: params.onRecordError,
  });

  // V1-CUTOVER S10 — env-gated production short-circuit (universal entry).
  // Works for ALL non-Telegram channels (discord, irc, nextcloud-talk,
  // matrix, msteams, web UI, etc.) since every channel funnels through
  // `recordInboundSessionAndDispatchReply`. When
  // `OPENCLAW_USE_V1_ORCHESTRATOR=1`, route the inbound through the
  // orchestrator-v1 pipeline (Stage A + Stage B + dispatcher + real
  // tool-runner registry from S8) and skip the legacy reply pipeline.
  // Legacy flow remains the default when the flag is unset, so a restart
  // without the env var rolls cutover back without code changes. Note:
  // the previous diagnostic helper (`diagnoseTurn`) is kept in imports
  // for the post-Phase-2 cleanup slice — DO NOT delete it before live-
  // verify confirms cutover across all channels.
  void diagnoseTurn;
  if (process.env.OPENCLAW_USE_V1_ORCHESTRATOR === "1") {
    const userText =
      params.ctxPayload.RawBody ??
      params.ctxPayload.CommandBody ??
      params.ctxPayload.Body ??
      "";
    process.stderr.write(
      `[orch-v1-debug] universal dispatch entry channel=${params.channel} userTextLen=${userText.length}\n`,
    );
    const handled = await executeOrchestratorV1UniversalShortCircuit({
      userText,
      chatKey: `${params.channel}:${params.ctxPayload.SessionKey ?? params.routeSessionKey}`,
      cfg: params.cfg,
      agentId: params.agentId,
      channel: params.channel,
      accountId: params.accountId,
      deliver: params.deliver,
      onDispatchError: params.onDispatchError,
    });
    if (handled) {
      return;
    }
  }

  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: params.channel,
    accountId: params.accountId,
  });
  const deliver = createNormalizedOutboundDeliverer(params.deliver);

  await params.dispatchReplyWithBufferedBlockDispatcher({
    ctx: params.ctxPayload,
    cfg: params.cfg,
    dispatcherOptions: {
      ...replyPipeline,
      deliver,
      onError: params.onDispatchError,
    },
    replyOptions: {
      ...params.replyOptions,
      onModelSelected,
    },
  });
}
