import type { VerboseLevel } from "../auto-reply/thinking.js";
import {
  PlatformRuntimeRunClosureSummarySchema,
  type PlatformRuntimeRunClosureSummary,
} from "../platform/runtime/contracts.js";
import type { PlatformRuntimeContinuationKind } from "../platform/runtime/contracts.js";
import type { PluginHookPlatformExecutionContext } from "../plugins/types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";

export type AgentEventStream = "lifecycle" | "tool" | "assistant" | "error" | (string & {});

export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: AgentEventStream;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
};

export type AgentRunContext = {
  sessionKey?: string;
  verboseLevel?: VerboseLevel;
  platformExecution?: PluginHookPlatformExecutionContext;
  requestRunId?: string;
  parentRunId?: string;
  runtimeState?: "queued" | "running" | "blocked" | "approved" | "resumed" | "completed" | "failed";
  runtimeCheckpointId?: string;
  runtimeBoundary?: string;
  awaitingRunClosure?: boolean;
  runClosureSummary?: PlatformRuntimeRunClosureSummary;
  isHeartbeat?: boolean;
  /** Whether control UI clients should receive chat/agent updates for this run. */
  isControlUiVisible?: boolean;
};

type AgentEventState = {
  seqByRun: Map<string, number>;
  listeners: Set<(evt: AgentEventPayload) => void>;
  runContextById: Map<string, AgentRunContext>;
};

const AGENT_EVENT_STATE_KEY = Symbol.for("openclaw.agentEvents.state");

const state = resolveGlobalSingleton<AgentEventState>(AGENT_EVENT_STATE_KEY, () => ({
  seqByRun: new Map<string, number>(),
  listeners: new Set<(evt: AgentEventPayload) => void>(),
  runContextById: new Map<string, AgentRunContext>(),
}));

export function registerAgentRunContext(runId: string, context: AgentRunContext) {
  if (!runId) {
    return;
  }
  const existing = state.runContextById.get(runId);
  if (!existing) {
    state.runContextById.set(runId, { ...context });
    return;
  }
  if (context.sessionKey && existing.sessionKey !== context.sessionKey) {
    existing.sessionKey = context.sessionKey;
  }
  if (context.verboseLevel && existing.verboseLevel !== context.verboseLevel) {
    existing.verboseLevel = context.verboseLevel;
  }
  if (context.platformExecution) {
    existing.platformExecution = {
      ...existing.platformExecution,
      ...context.platformExecution,
    };
  }
  if (context.requestRunId && existing.requestRunId !== context.requestRunId) {
    existing.requestRunId = context.requestRunId;
  }
  if (context.parentRunId && existing.parentRunId !== context.parentRunId) {
    existing.parentRunId = context.parentRunId;
  }
  if (context.runtimeState && existing.runtimeState !== context.runtimeState) {
    existing.runtimeState = context.runtimeState;
  }
  if (context.runtimeCheckpointId && existing.runtimeCheckpointId !== context.runtimeCheckpointId) {
    existing.runtimeCheckpointId = context.runtimeCheckpointId;
  }
  if (context.runtimeBoundary && existing.runtimeBoundary !== context.runtimeBoundary) {
    existing.runtimeBoundary = context.runtimeBoundary;
  }
  if (context.awaitingRunClosure !== undefined) {
    existing.awaitingRunClosure = context.awaitingRunClosure;
  }
  if (context.runClosureSummary) {
    existing.runClosureSummary = PlatformRuntimeRunClosureSummarySchema.parse(
      context.runClosureSummary,
    );
  }
  if (context.isControlUiVisible !== undefined) {
    existing.isControlUiVisible = context.isControlUiVisible;
  }
  if (context.isHeartbeat !== undefined && existing.isHeartbeat !== context.isHeartbeat) {
    existing.isHeartbeat = context.isHeartbeat;
  }
}

export function getAgentRunContext(runId: string) {
  return state.runContextById.get(runId);
}

export function clearAgentRunContext(runId: string) {
  state.runContextById.delete(runId);
}

export function resetAgentRunContextForTest() {
  state.runContextById.clear();
}

export function emitAgentEvent(event: Omit<AgentEventPayload, "seq" | "ts">) {
  const nextSeq = (state.seqByRun.get(event.runId) ?? 0) + 1;
  state.seqByRun.set(event.runId, nextSeq);
  const context = state.runContextById.get(event.runId);
  const isControlUiVisible = context?.isControlUiVisible ?? true;
  const eventSessionKey =
    typeof event.sessionKey === "string" && event.sessionKey.trim() ? event.sessionKey : undefined;
  const sessionKey = isControlUiVisible ? (eventSessionKey ?? context?.sessionKey) : undefined;
  const enriched: AgentEventPayload = {
    ...event,
    sessionKey,
    seq: nextSeq,
    ts: Date.now(),
  };
  notifyListeners(state.listeners, enriched);
}

export function onAgentEvent(listener: (evt: AgentEventPayload) => void) {
  return registerListener(state.listeners, listener);
}

/** Milestones for `stream: runtime`, `data.phase: recovery` (closure_recovery pipeline). */
export type RecoveryTelemetryMilestone =
  | "continuation_dispatch_start"
  | "continuation_dispatch_failed"
  | "continuation_dispatch_handler_done"
  | "followup_enqueued"
  | "recovery_checkpoint_resumed"
  | "recovery_checkpoint_terminal";

export function emitRuntimeRecoveryTelemetry(params: {
  runId: string;
  sessionKey?: string;
  milestone: RecoveryTelemetryMilestone;
  checkpointId: string;
  continuationKind: PlatformRuntimeContinuationKind;
  approvalId?: string;
  queueKey?: string;
  error?: string;
  terminalStatus?: string;
  continuationState?: string;
}): void {
  emitAgentEvent({
    runId: params.runId,
    stream: "runtime",
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    data: {
      phase: "recovery",
      milestone: params.milestone,
      checkpointId: params.checkpointId,
      continuationKind: params.continuationKind,
      ...(params.approvalId ? { approvalId: params.approvalId } : {}),
      ...(params.queueKey ? { queueKey: params.queueKey } : {}),
      ...(params.error ? { error: params.error } : {}),
      ...(params.terminalStatus ? { terminalStatus: params.terminalStatus } : {}),
      ...(params.continuationState ? { continuationState: params.continuationState } : {}),
    },
  });
}

export function emitRunClosureSummary(summary: PlatformRuntimeRunClosureSummary) {
  const parsed = PlatformRuntimeRunClosureSummarySchema.parse(summary);
  registerAgentRunContext(parsed.runId, {
    ...(parsed.sessionKey ? { sessionKey: parsed.sessionKey } : {}),
    ...(parsed.requestRunId ? { requestRunId: parsed.requestRunId } : {}),
    ...(parsed.parentRunId ? { parentRunId: parsed.parentRunId } : {}),
    awaitingRunClosure: false,
    runClosureSummary: parsed,
    runtimeState: parsed.action === "close" ? "completed" : "failed",
  });
  emitAgentEvent({
    runId: parsed.runId,
    stream: "runtime",
    ...(parsed.sessionKey ? { sessionKey: parsed.sessionKey } : {}),
    data: {
      phase: "closure",
      summary: parsed,
    },
  });
}

export function resetAgentEventsForTest() {
  state.seqByRun.clear();
  state.listeners.clear();
  state.runContextById.clear();
}
