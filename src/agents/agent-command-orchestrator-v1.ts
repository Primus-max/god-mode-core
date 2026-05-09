/**
 * V1-CUTOVER S9.5 — Universal `agentCommandFromIngress` short-circuit.
 *
 * S9 (Telegram) and S10 (plugin-sdk inbound-reply-dispatch) put the
 * orchestrator-v1 short-circuit at two specific entry points. Four
 * direct callers of `agentCommandFromIngress` are NOT covered by those:
 *
 *   - `src/gateway/server-methods/agent.ts` (gateway JSON-RPC `agent`
 *     method — web UI / CLI control plane)
 *   - `src/gateway/server-node-events.ts` (node spawn events)
 *   - `extensions/discord/src/voice/manager.ts` (Discord voice ingestion)
 *   - `extensions/acpx/src/runtime.ts` (ACPx control-plane MCP host)
 *
 * S9.5 puts a single env-gated short-circuit AT the entry of
 * `agentCommandFromIngress` so every caller routes through
 * orchestrator-v1 with the same flag. Mirrors S9/S10 pattern — same
 * env flag (`OPENCLAW_USE_V1_ORCHESTRATOR=1`), same telemetry
 * (`[orch-v1] turn started/completed`), same fail-closed scheduling
 * placeholders, same `cfg + agentDir` threading (S9.1 mirror).
 *
 * Caller-shape compatibility: all four callers consume the result as
 * `{ payloads: Array<{ text?: ...}>, meta: { durationMs, ... } }`
 * (the shape `agentCommandInternal -> deliverAgentCommandResult`
 * returns). The short-circuit synthesises that exact shape from the
 * orchestrator's `result.reply` so callers do not need to change.
 */

import { loadConfig as loadConfigImplBase, type OpenClawConfig } from "../config/config.js";
import { resolveAgentIdFromSessionKey } from "../config/sessions.js";
import { sendMessage as sendMessageImplBase } from "../infra/outbound/message.js";
import {
  DEFAULT_STAGE_A_MODEL,
  type StageAModelRef,
} from "../orchestrator-v1/classifier-stage-a.js";
import { callConversationLLM as callConversationLLMImplBase } from "../orchestrator-v1/diagnostic.js";
import type { RunConversationLLMFn, RunToolFn } from "../orchestrator-v1/dispatcher.js";
import {
  runOrchestratorTurn as runOrchestratorTurnImplBase,
  type RunOrchestratorTurnResult,
} from "../orchestrator-v1/orchestrator.js";
import {
  buildRunToolFromRegistry as buildRunToolFromRegistryImplBase,
  type RegistryDeps,
} from "../orchestrator-v1/tool-runner-registry.js";
import type {
  CreatePersistentWorkerFn,
  ScheduleCronFn,
} from "../orchestrator-v1/tool-runners/scheduling.js";
import type { SessionsSendFn } from "../orchestrator-v1/tool-runners/sessions.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveAgentDir as resolveAgentDirImplBase } from "./agent-scope.js";
import type { AgentCommandIngressOpts } from "./command/types.js";

/** The shape `agentCommandFromIngress` legacy path returns (subset). */
export type AgentCommandIngressResult = {
  payloads: Array<{
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    replyToId?: string;
    isError?: boolean;
  }>;
  meta: {
    durationMs?: number;
    [key: string]: unknown;
  };
};

/**
 * Test-only seam mirroring S9/S10. Lets unit tests inject stubs for
 * the orchestrator-v1 surface, agent-scope, config, and outbound
 * primitives without `vi.mock("openclaw/...")`, which is fragile when
 * the agent-command import graph is heavy. Production callers omit
 * this parameter entirely.
 */
export type AgentCommandOrchestratorV1Overrides = {
  runOrchestratorTurn?: typeof runOrchestratorTurnImplBase;
  buildRunToolFromRegistry?: typeof buildRunToolFromRegistryImplBase;
  callConversationLLM?: typeof callConversationLLMImplBase;
  resolveAgentDir?: typeof resolveAgentDirImplBase;
  loadConfig?: typeof loadConfigImplBase;
  sendMessage?: typeof sendMessageImplBase;
  /**
   * Optional now() seam for deterministic `meta.durationMs` in tests.
   */
  now?: () => number;
};

export type AgentCommandOrchestratorV1ShortCircuitOutcome =
  | {
      handled: false;
      /** When `handled === false`, callers fall through to the legacy code path. */
      reason: "env_flag_unset" | "empty_user_text";
    }
  | {
      handled: true;
      result: AgentCommandIngressResult;
    };

/**
 * Resolve the agent id used to scope `agentDir` for classifier model
 * resolution. Mirrors the legacy `prepareAgentCommandExecution` order:
 * explicit `opts.agentId` wins, otherwise derive from `sessionKey`.
 * Falls back to `undefined` so the orchestrator wiring uses the
 * default-agent path the legacy classifier already understood.
 */
function resolveIngressAgentId(opts: AgentCommandIngressOpts): string | undefined {
  const explicit = opts.agentId?.trim();
  if (explicit) {
    return normalizeAgentId(explicit);
  }
  if (opts.sessionKey) {
    try {
      return resolveAgentIdFromSessionKey(opts.sessionKey);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Build a stable per-channel chat key for `withChatLock`. Mirrors S10's
 * `<channel>:<sessionKey>` shape but accommodates ingress callers that
 * do not always have `messageChannel` set (e.g. server-methods/agent.ts
 * which spawns from JSON-RPC). Falls back to `runId` and finally a
 * synthetic key so chat-lock concurrency stays per-caller.
 */
function buildIngressChatKey(opts: AgentCommandIngressOpts): string {
  const channel = (opts.messageChannel ?? opts.channel ?? "ingress").trim() || "ingress";
  const session =
    opts.sessionKey?.trim() ||
    opts.sessionId?.trim() ||
    opts.runId?.trim() ||
    opts.to?.trim() ||
    "session-unknown";
  return `universal:${channel}:${session}`;
}

/**
 * V1-CUTOVER S9.5 — Universal short-circuit at the `agentCommandFromIngress`
 * entry point. Returns an outcome union the caller uses to decide
 * whether to short-circuit (`handled: true`) or fall through to the
 * legacy `agentCommandInternal` pipeline (`handled: false`).
 *
 * Production wiring (binding report — none touch `src/platform/commitment/**`):
 *   - `runTool`  ← `buildRunToolFromRegistry({ send, scheduling })`
 *     - `send`         ← `infra/outbound/message.sendMessage(...)` —
 *       universal cross-channel outbound primitive (mirrors S10).
 *     - `scheduling.scheduleCron` / `scheduling.createPersistentWorker`
 *       ← fail-closed placeholders that throw with an "S9.5 not yet
 *       wired — operator follow-up" message (mirrors S9/S10).
 *   - `runConversationLLM` ← `callConversationLLM(text, classifierModel,
 *     { cfg, agentDir })` from `src/orchestrator-v1/diagnostic.ts`
 *     (re-uses the same simple-completion helper S9/S10 use).
 *   - `cfg` ← `loadConfig()` (the same gateway-loaded config the legacy
 *     path resolves; ingress callers do not pass cfg explicitly today).
 *   - `agentDir` ← `resolveAgentDir(cfg, agentId)` from
 *     `src/agents/agent-scope.ts`.
 *
 * Telemetry contract (mirrors S9/S10, written to `process.stderr`):
 *   - `[orch-v1] turn started chatKey=universal:<channel>:<session> userMessageLen=<n>`
 *   - `[orch-v1] turn completed contractIntent=<x> allOk=<bool> replyLen=<n>`
 *
 * Error safety: the helper never throws. A thrown
 * `runOrchestratorTurn` (defensive — the orchestrator is supposed to
 * catch internally) is logged and a generic Russian error reply is
 * synthesised so the caller's `result.payloads[0].text` is non-empty
 * and downstream delivery (Discord voice, gateway JSON-RPC, etc.)
 * continues to render something.
 */
export async function executeOrchestratorV1AgentCommandShortCircuit(
  opts: AgentCommandIngressOpts,
  overrides: AgentCommandOrchestratorV1Overrides = {},
): Promise<AgentCommandOrchestratorV1ShortCircuitOutcome> {
  if (process.env.OPENCLAW_USE_V1_ORCHESTRATOR !== "1") {
    return { handled: false, reason: "env_flag_unset" };
  }
  const userText = (opts.message ?? "").toString();
  if (userText.trim().length === 0) {
    return { handled: false, reason: "empty_user_text" };
  }

  const runTurnImpl = overrides.runOrchestratorTurn ?? runOrchestratorTurnImplBase;
  const buildRegistryImpl = overrides.buildRunToolFromRegistry ?? buildRunToolFromRegistryImplBase;
  const callLLMImpl = overrides.callConversationLLM ?? callConversationLLMImplBase;
  const resolveAgentDirImpl = overrides.resolveAgentDir ?? resolveAgentDirImplBase;
  const loadConfigImpl = overrides.loadConfig ?? loadConfigImplBase;
  const sendMessageImpl = overrides.sendMessage ?? sendMessageImplBase;
  const nowImpl = overrides.now ?? Date.now;

  const cfg: OpenClawConfig = loadConfigImpl();
  const agentId = resolveIngressAgentId(opts);
  // S9.1 mirror: `cfg + agentDir` MUST both flow into runOrchestratorTurn
  // so Stage A model resolution sees the agent-scoped provider table.
  // When `agentId` cannot be resolved (no opts.agentId + no sessionKey
  // — happens with raw `agent` deep links from `node` events), pass
  // `undefined` — the orchestrator falls back to the global config
  // path. The dedicated regression test asserts truthy threading when
  // an agentId is present.
  const agentDir = agentId ? resolveAgentDirImpl(cfg, agentId) : undefined;
  const chatKey = buildIngressChatKey(opts);
  const channel = (opts.messageChannel ?? opts.channel ?? "ingress").trim() || "ingress";
  const accountId = opts.accountId?.trim() || undefined;

  // Production binding: universal cross-channel outbound for `sessions_send`.
  // The classifier-extracted `channel` arg is the destination address;
  // the inbound channel + accountId scope the transport so the reply
  // goes back via the same surface that received the user message.
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

  // S9.5 placeholders for cron + persistent_worker_push (mirrors S9/S10).
  // Real CronService + persistent-worker bootstrap require gateway-
  // scoped handles that the agent-command entry point does not own.
  // Fail-closed surfaces the gap honestly.
  const scheduleCron: ScheduleCronFn = async () => {
    throw new Error("cron not yet wired in S9.5 — operator follow-up");
  };
  const createPersistentWorker: CreatePersistentWorkerFn = async () => {
    throw new Error("persistent_worker_push not yet wired in S9.5 — operator follow-up");
  };

  const runTool: RunToolFn = buildRegistryImpl({
    send,
    scheduling: { scheduleCron, createPersistentWorker },
  } satisfies RegistryDeps);

  const classifierModel: StageAModelRef = DEFAULT_STAGE_A_MODEL;
  const runConversationLLM: RunConversationLLMFn = async (userMessage) => {
    return callLLMImpl(userMessage, classifierModel, { cfg, agentDir });
  };

  const startedAt = nowImpl();
  process.stderr.write(
    `[orch-v1] turn started chatKey=${chatKey} userMessageLen=${userText.length}\n`,
  );
  try {
    const result: RunOrchestratorTurnResult = await runTurnImpl({
      userMessage: userText,
      chatKey,
      runTool,
      runConversationLLM,
      cfg,
      agentDir,
    });
    process.stderr.write(
      `[orch-v1] turn completed contractIntent=${result.contract.intent} allOk=${result.dispatch.allOk} replyLen=${result.reply.length}\n`,
    );
    return {
      handled: true,
      result: {
        payloads: result.reply.length > 0 ? [{ text: result.reply }] : [],
        meta: {
          durationMs: nowImpl() - startedAt,
        },
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[orch-v1] turn failed chatKey=${chatKey}: ${message}\n`);
    // Defensive: the orchestrator is supposed to catch its own errors
    // and encode them into `reply`. Synthesise an error payload so the
    // ingress caller's downstream delivery (Discord voice TTS, gateway
    // JSON-RPC `result`, etc.) still has something to render rather
    // than an empty reply.
    return {
      handled: true,
      result: {
        payloads: [{ text: `(orchestrator-v1 ошибка: ${message})`, isError: true }],
        meta: {
          durationMs: nowImpl() - startedAt,
        },
      },
    };
  }
}
