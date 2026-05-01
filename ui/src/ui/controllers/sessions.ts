import { toNumber } from "../format.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  GatewaySessionChangedPayload,
  GatewaySessionRow,
  SessionsListResult,
} from "../types.ts";

export type SessionsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionsLoading: boolean;
  sessionsResult: SessionsListResult | null;
  sessionsError: string | null;
  sessionsFilterActive: string;
  sessionsFilterLimit: string;
  sessionsIncludeGlobal: boolean;
  sessionsIncludeUnknown: boolean;
};

const SESSION_KIND_VALUES = new Set<GatewaySessionRow["kind"]>([
  "direct",
  "group",
  "global",
  "unknown",
]);

const SESSION_ROW_FIELDS = [
  "spawnedBy",
  "kind",
  "label",
  "displayName",
  "surface",
  "subject",
  "room",
  "space",
  "updatedAt",
  "sessionId",
  "systemSent",
  "abortedLastRun",
  "thinkingLevel",
  "fastMode",
  "verboseLevel",
  "reasoningLevel",
  "elevatedLevel",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "totalTokensFresh",
  "estimatedCostUsd",
  "status",
  "startedAt",
  "endedAt",
  "runtimeMs",
  "parentSessionKey",
  "childSessions",
  "model",
  "modelProvider",
  "contextTokens",
  "runClosureSummary",
  "handoffRequestRunId",
  "handoffRunId",
  "handoffTruthSource",
  "handoffHint",
  "recoveryCheckpointId",
  "recoveryStatus",
  "recoveryContinuationState",
  "recoveryOperation",
  "recoveryBlockedReason",
  "recoveryUpdatedAt",
  "recoveryAttempts",
  "recoveryOperatorHint",
] as const satisfies readonly (keyof GatewaySessionRow)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasDefinedOwn(
  source: Record<string, unknown> | undefined,
  key: (typeof SESSION_ROW_FIELDS)[number] | "key",
): boolean {
  return Boolean(
    source && Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined,
  );
}

function readSessionField(
  payload: Record<string, unknown> | undefined,
  nested: Record<string, unknown> | undefined,
  key: (typeof SESSION_ROW_FIELDS)[number],
): unknown {
  if (hasDefinedOwn(payload, key)) {
    return payload?.[key];
  }
  if (hasDefinedOwn(nested, key)) {
    return nested?.[key];
  }
  return undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return undefined;
  }
  return value;
}

function hasAuthoritativeSessionSnapshot(
  payload: Record<string, unknown> | undefined,
  nested: Record<string, unknown> | undefined,
): boolean {
  return hasDefinedOwn(payload, "kind") || hasDefinedOwn(payload, "updatedAt") || Boolean(nested);
}

function buildSessionRowFromChangedPayload(
  payload: GatewaySessionChangedPayload | undefined,
): GatewaySessionRow | null {
  const source = isRecord(payload) ? payload : undefined;
  const nested = isRecord(source?.session) ? source.session : undefined;
  const sessionKey =
    (typeof source?.sessionKey === "string" && source.sessionKey.trim()) ||
    (typeof nested?.key === "string" && nested.key.trim()) ||
    "";
  if (!sessionKey || !hasAuthoritativeSessionSnapshot(source, nested)) {
    return null;
  }
  const kind = readSessionField(source, nested, "kind");
  if (!SESSION_KIND_VALUES.has(kind as GatewaySessionRow["kind"])) {
    return null;
  }
  return {
    key: sessionKey,
    kind: kind as GatewaySessionRow["kind"],
    spawnedBy: asOptionalString(readSessionField(source, nested, "spawnedBy")),
    label: asOptionalString(readSessionField(source, nested, "label")),
    displayName: asOptionalString(readSessionField(source, nested, "displayName")),
    surface: asOptionalString(readSessionField(source, nested, "surface")),
    subject: asOptionalString(readSessionField(source, nested, "subject")),
    room: asOptionalString(readSessionField(source, nested, "room")),
    space: asOptionalString(readSessionField(source, nested, "space")),
    updatedAt: asOptionalNumber(readSessionField(source, nested, "updatedAt")) ?? null,
    sessionId: asOptionalString(readSessionField(source, nested, "sessionId")),
    systemSent: asOptionalBoolean(readSessionField(source, nested, "systemSent")),
    abortedLastRun: asOptionalBoolean(readSessionField(source, nested, "abortedLastRun")),
    thinkingLevel: asOptionalString(readSessionField(source, nested, "thinkingLevel")),
    fastMode: asOptionalBoolean(readSessionField(source, nested, "fastMode")),
    verboseLevel: asOptionalString(readSessionField(source, nested, "verboseLevel")),
    reasoningLevel: asOptionalString(readSessionField(source, nested, "reasoningLevel")),
    elevatedLevel: asOptionalString(readSessionField(source, nested, "elevatedLevel")),
    inputTokens: asOptionalNumber(readSessionField(source, nested, "inputTokens")),
    outputTokens: asOptionalNumber(readSessionField(source, nested, "outputTokens")),
    totalTokens: asOptionalNumber(readSessionField(source, nested, "totalTokens")),
    totalTokensFresh: asOptionalBoolean(readSessionField(source, nested, "totalTokensFresh")),
    estimatedCostUsd: asOptionalNumber(readSessionField(source, nested, "estimatedCostUsd")),
    status: readSessionField(source, nested, "status") as GatewaySessionRow["status"],
    startedAt: asOptionalNumber(readSessionField(source, nested, "startedAt")),
    endedAt: asOptionalNumber(readSessionField(source, nested, "endedAt")),
    runtimeMs: asOptionalNumber(readSessionField(source, nested, "runtimeMs")),
    parentSessionKey: asOptionalString(readSessionField(source, nested, "parentSessionKey")),
    childSessions: asOptionalStringArray(readSessionField(source, nested, "childSessions")),
    model: asOptionalString(readSessionField(source, nested, "model")),
    modelProvider: asOptionalString(readSessionField(source, nested, "modelProvider")),
    contextTokens: asOptionalNumber(readSessionField(source, nested, "contextTokens")),
    runClosureSummary: readSessionField(source, nested, "runClosureSummary") as
      | GatewaySessionRow["runClosureSummary"]
      | undefined,
    handoffRequestRunId: asOptionalString(readSessionField(source, nested, "handoffRequestRunId")),
    handoffRunId: asOptionalString(readSessionField(source, nested, "handoffRunId")),
    handoffTruthSource: readSessionField(source, nested, "handoffTruthSource") as
      | GatewaySessionRow["handoffTruthSource"]
      | undefined,
    handoffHint: asOptionalString(readSessionField(source, nested, "handoffHint")),
    recoveryCheckpointId: asOptionalString(
      readSessionField(source, nested, "recoveryCheckpointId"),
    ),
    recoveryStatus: readSessionField(source, nested, "recoveryStatus") as
      | GatewaySessionRow["recoveryStatus"]
      | undefined,
    recoveryContinuationState: readSessionField(source, nested, "recoveryContinuationState") as
      | GatewaySessionRow["recoveryContinuationState"]
      | undefined,
    recoveryOperation: asOptionalString(readSessionField(source, nested, "recoveryOperation")),
    recoveryBlockedReason: asOptionalString(
      readSessionField(source, nested, "recoveryBlockedReason"),
    ),
    recoveryUpdatedAt: asOptionalNumber(readSessionField(source, nested, "recoveryUpdatedAt")),
    recoveryAttempts: asOptionalNumber(readSessionField(source, nested, "recoveryAttempts")),
    recoveryOperatorHint: asOptionalString(
      readSessionField(source, nested, "recoveryOperatorHint"),
    ),
  };
}

export function applySessionsChangedEvent(
  state: Pick<SessionsState, "sessionsResult">,
  payload: GatewaySessionChangedPayload | undefined,
): { applied: boolean; shouldReload: boolean } {
  const reason =
    isRecord(payload) && typeof payload.reason === "string" ? payload.reason : undefined;
  if (
    reason === "create" ||
    reason === "delete" ||
    reason === "deleted" ||
    reason === "new" ||
    reason === "reset" ||
    reason === "session-delete" ||
    reason === "session-reset"
  ) {
    return { applied: false, shouldReload: true };
  }
  const sessionRow = buildSessionRowFromChangedPayload(payload);
  if (!state.sessionsResult || !sessionRow) {
    return { applied: false, shouldReload: true };
  }
  const index = state.sessionsResult.sessions.findIndex((row) => row.key === sessionRow.key);
  if (index < 0) {
    return { applied: false, shouldReload: true };
  }
  const sessions = state.sessionsResult.sessions.slice();
  sessions[index] = sessionRow;
  state.sessionsResult = {
    ...state.sessionsResult,
    sessions,
  };
  return { applied: true, shouldReload: false };
}

export async function subscribeSessions(state: SessionsState) {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    await state.client.request("sessions.subscribe", {});
  } catch (err) {
    state.sessionsError = String(err);
  }
}

export async function loadSessions(
  state: SessionsState,
  overrides?: {
    activeMinutes?: number;
    limit?: number;
    includeGlobal?: boolean;
    includeUnknown?: boolean;
  },
) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.sessionsLoading) {
    return;
  }
  state.sessionsLoading = true;
  state.sessionsError = null;
  try {
    const includeGlobal = overrides?.includeGlobal ?? state.sessionsIncludeGlobal;
    const includeUnknown = overrides?.includeUnknown ?? state.sessionsIncludeUnknown;
    const activeMinutes = overrides?.activeMinutes ?? toNumber(state.sessionsFilterActive, 0);
    const limit = overrides?.limit ?? toNumber(state.sessionsFilterLimit, 0);
    const params: Record<string, unknown> = {
      includeGlobal,
      includeUnknown,
    };
    if (activeMinutes > 0) {
      params.activeMinutes = activeMinutes;
    }
    if (limit > 0) {
      params.limit = limit;
    }
    const res = await state.client.request<SessionsListResult | undefined>("sessions.list", params);
    if (res) {
      state.sessionsResult = res;
    }
  } catch (err) {
    state.sessionsError = String(err);
  } finally {
    state.sessionsLoading = false;
  }
}

export async function patchSession(
  state: SessionsState,
  key: string,
  patch: {
    label?: string | null;
    thinkingLevel?: string | null;
    fastMode?: boolean | null;
    verboseLevel?: string | null;
    reasoningLevel?: string | null;
  },
) {
  if (!state.client || !state.connected) {
    return;
  }
  const params: Record<string, unknown> = { key };
  if ("label" in patch) {
    params.label = patch.label;
  }
  if ("thinkingLevel" in patch) {
    params.thinkingLevel = patch.thinkingLevel;
  }
  if ("fastMode" in patch) {
    params.fastMode = patch.fastMode;
  }
  if ("verboseLevel" in patch) {
    params.verboseLevel = patch.verboseLevel;
  }
  if ("reasoningLevel" in patch) {
    params.reasoningLevel = patch.reasoningLevel;
  }
  try {
    await state.client.request("sessions.patch", params);
    await loadSessions(state);
  } catch (err) {
    state.sessionsError = String(err);
  }
}

export async function deleteSessionsAndRefresh(
  state: SessionsState,
  keys: string[],
): Promise<string[]> {
  if (!state.client || !state.connected || keys.length === 0) {
    return [];
  }
  if (state.sessionsLoading) {
    return [];
  }
  const noun = keys.length === 1 ? "session" : "sessions";
  const confirmed = window.confirm(
    `Delete ${keys.length} ${noun}?\n\nThis will delete the session entries and archive their transcripts.`,
  );
  if (!confirmed) {
    return [];
  }
  state.sessionsLoading = true;
  state.sessionsError = null;
  const deleted: string[] = [];
  const deleteErrors: string[] = [];
  try {
    for (const key of keys) {
      try {
        await state.client.request("sessions.delete", { key, deleteTranscript: true });
        deleted.push(key);
      } catch (err) {
        deleteErrors.push(String(err));
      }
    }
  } finally {
    state.sessionsLoading = false;
  }
  if (deleted.length > 0) {
    await loadSessions(state);
  }
  if (deleteErrors.length > 0) {
    state.sessionsError = deleteErrors.join("; ");
  }
  return deleted;
}
