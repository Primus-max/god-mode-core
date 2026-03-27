import { updateSessionStoreEntry, type SessionEntry } from "../config/sessions.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import {
  PlatformRuntimeRunClosureSummarySchema,
  type PlatformRuntimeRunClosureSummary,
} from "../platform/runtime/index.js";
import { resolveSessionRunStatusFromClosureSummary } from "./session-closure-summary.js";
import { loadSessionEntry } from "./session-utils.js";
import type { GatewaySessionRow, SessionRunStatus } from "./session-utils.types.js";

type LifecyclePhase = "start" | "blocked" | "approved" | "resumed" | "end" | "error";

type SessionLifecycleEventLike = Pick<AgentEventPayload, "ts"> & {
  stream?: AgentEventPayload["stream"];
  data?: {
    phase?: unknown;
    startedAt?: unknown;
    endedAt?: unknown;
    aborted?: unknown;
    stopReason?: unknown;
    summary?: unknown;
  };
};

type LifecycleSessionShape = Pick<
  GatewaySessionRow,
  | "updatedAt"
  | "status"
  | "startedAt"
  | "endedAt"
  | "runtimeMs"
  | "abortedLastRun"
  | "runClosureSummary"
>;

type PersistedLifecycleSessionShape = Pick<
  SessionEntry,
  | "updatedAt"
  | "status"
  | "startedAt"
  | "endedAt"
  | "runtimeMs"
  | "abortedLastRun"
  | "runClosureSummary"
>;

export type GatewaySessionLifecycleSnapshot = Partial<LifecycleSessionShape>;

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function resolveLifecyclePhase(event: SessionLifecycleEventLike): LifecyclePhase | null {
  const phase = typeof event.data?.phase === "string" ? event.data.phase : "";
  return phase === "start" ||
    phase === "blocked" ||
    phase === "approved" ||
    phase === "resumed" ||
    phase === "end" ||
    phase === "error"
    ? phase
    : null;
}

function resolveRunClosureSummary(
  event: SessionLifecycleEventLike,
): PlatformRuntimeRunClosureSummary | undefined {
  if (event.stream !== "runtime" || event.data?.phase !== "closure") {
    return undefined;
  }
  const parsed = PlatformRuntimeRunClosureSummarySchema.safeParse(event.data?.summary);
  return parsed.success ? parsed.data : undefined;
}

function resolveLifecycleTerminalStatus(event: SessionLifecycleEventLike): SessionRunStatus {
  const phase = resolveLifecyclePhase(event);
  if (phase === "error") {
    return "failed";
  }

  const stopReason = typeof event.data?.stopReason === "string" ? event.data.stopReason : "";
  if (stopReason === "aborted") {
    return "killed";
  }

  return event.data?.aborted === true ? "timeout" : "done";
}

function resolveLifecycleStartedAt(
  existingStartedAt: number | undefined,
  event: SessionLifecycleEventLike,
): number | undefined {
  if (isFiniteTimestamp(event.data?.startedAt)) {
    return event.data.startedAt;
  }
  if (isFiniteTimestamp(existingStartedAt)) {
    return existingStartedAt;
  }
  return isFiniteTimestamp(event.ts) ? event.ts : undefined;
}

function resolveLifecycleEndedAt(event: SessionLifecycleEventLike): number | undefined {
  if (isFiniteTimestamp(event.data?.endedAt)) {
    return event.data.endedAt;
  }
  return isFiniteTimestamp(event.ts) ? event.ts : undefined;
}

function resolveRuntimeMs(params: {
  startedAt?: number;
  endedAt?: number;
  existingRuntimeMs?: number;
}): number | undefined {
  const { startedAt, endedAt, existingRuntimeMs } = params;
  if (isFiniteTimestamp(startedAt) && isFiniteTimestamp(endedAt)) {
    return Math.max(0, endedAt - startedAt);
  }
  if (
    typeof existingRuntimeMs === "number" &&
    Number.isFinite(existingRuntimeMs) &&
    existingRuntimeMs >= 0
  ) {
    return existingRuntimeMs;
  }
  return undefined;
}

export function deriveGatewaySessionLifecycleSnapshot(params: {
  session?: Partial<LifecycleSessionShape> | null;
  event: SessionLifecycleEventLike;
}): GatewaySessionLifecycleSnapshot {
  const runtimeClosureSummary = resolveRunClosureSummary(params.event);
  if (runtimeClosureSummary) {
    const updatedAt = runtimeClosureSummary.updatedAtMs;
    return {
      updatedAt,
      status: resolveSessionRunStatusFromClosureSummary(runtimeClosureSummary),
      startedAt: params.session?.startedAt,
      endedAt: params.session?.endedAt,
      runtimeMs: params.session?.runtimeMs,
      abortedLastRun: params.session?.abortedLastRun,
      runClosureSummary: runtimeClosureSummary,
    };
  }
  const phase = resolveLifecyclePhase(params.event);
  if (!phase) {
    return {};
  }

  const existing = params.session ?? undefined;
  if (phase === "start") {
    const startedAt = resolveLifecycleStartedAt(existing?.startedAt, params.event);
    const updatedAt = startedAt ?? existing?.updatedAt;
    return {
      updatedAt,
      status: "running",
      startedAt,
      endedAt: undefined,
      runtimeMs: undefined,
      abortedLastRun: false,
      runClosureSummary: undefined,
    };
  }
  if (phase === "blocked" || phase === "approved") {
    const startedAt = resolveLifecycleStartedAt(existing?.startedAt, params.event);
    const updatedAt = isFiniteTimestamp(params.event.ts) ? params.event.ts : existing?.updatedAt;
    return {
      updatedAt,
      status: "blocked",
      startedAt,
      endedAt: undefined,
      runtimeMs: existing?.runtimeMs,
      abortedLastRun: false,
      runClosureSummary: undefined,
    };
  }
  if (phase === "resumed") {
    const startedAt = resolveLifecycleStartedAt(existing?.startedAt, params.event);
    const updatedAt =
      (isFiniteTimestamp(params.event.data?.startedAt) ? params.event.data.startedAt : undefined) ??
      (isFiniteTimestamp(params.event.ts) ? params.event.ts : existing?.updatedAt);
    return {
      updatedAt,
      status: "running",
      startedAt,
      endedAt: undefined,
      runtimeMs: existing?.runtimeMs,
      abortedLastRun: false,
      runClosureSummary: undefined,
    };
  }

  const startedAt = resolveLifecycleStartedAt(existing?.startedAt, params.event);
  const endedAt = resolveLifecycleEndedAt(params.event);
  const updatedAt = endedAt ?? existing?.updatedAt;
  return {
    updatedAt,
    status: resolveLifecycleTerminalStatus(params.event),
    startedAt,
    endedAt,
    runtimeMs: resolveRuntimeMs({
      startedAt,
      endedAt,
      existingRuntimeMs: existing?.runtimeMs,
    }),
    abortedLastRun: resolveLifecycleTerminalStatus(params.event) === "killed",
    runClosureSummary: undefined,
  };
}

export function derivePersistedSessionLifecyclePatch(params: {
  entry?: Partial<PersistedLifecycleSessionShape> | null;
  event: SessionLifecycleEventLike;
}): Partial<PersistedLifecycleSessionShape> {
  const snapshot = deriveGatewaySessionLifecycleSnapshot({
    session: params.entry ?? undefined,
    event: params.event,
  });
  return {
    ...snapshot,
    updatedAt: typeof snapshot.updatedAt === "number" ? snapshot.updatedAt : undefined,
  };
}

export async function persistGatewaySessionLifecycleEvent(params: {
  sessionKey: string;
  event: SessionLifecycleEventLike;
}): Promise<void> {
  const runtimeClosureSummary = resolveRunClosureSummary(params.event);
  const phase = resolveLifecyclePhase(params.event);
  if (!runtimeClosureSummary && !phase) {
    return;
  }

  const sessionEntry = loadSessionEntry(params.sessionKey);
  if (!sessionEntry.entry) {
    return;
  }

  await updateSessionStoreEntry({
    storePath: sessionEntry.storePath,
    sessionKey: sessionEntry.canonicalKey,
    update: async (entry) =>
      derivePersistedSessionLifecyclePatch({
        entry,
        event: params.event,
      }),
  });
}
