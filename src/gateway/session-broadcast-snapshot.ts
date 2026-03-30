import type { GatewaySessionRow } from "./session-utils.types.js";

export type BuildGatewaySessionBroadcastSnapshotOptions = {
  /** When true, includes `session: row` for consumers that expect the full row object. */
  includeFullSession?: boolean;
};

/**
 * Flat fields aligned with `GatewaySessionRow` for WebSocket `sessions.changed` and related
 * payloads (parity with RPC `sessions.list` / session rows for closure, recovery, and handoff).
 */
export function buildGatewaySessionBroadcastSnapshot(
  row: GatewaySessionRow | null | undefined,
  options?: BuildGatewaySessionBroadcastSnapshotOptions,
): Record<string, unknown> {
  if (!row) {
    return {};
  }

  const flat: Record<string, unknown> = {
    updatedAt: row.updatedAt ?? undefined,
    sessionId: row.sessionId,
    kind: row.kind,
    channel: row.channel,
    label: row.label,
    displayName: row.displayName,
    deliveryContext: row.deliveryContext,
    parentSessionKey: row.parentSessionKey,
    childSessions: row.childSessions,
    thinkingLevel: row.thinkingLevel,
    systemSent: row.systemSent,
    abortedLastRun: row.abortedLastRun,
    lastChannel: row.lastChannel,
    lastTo: row.lastTo,
    lastAccountId: row.lastAccountId,
    totalTokens: row.totalTokens,
    totalTokensFresh: row.totalTokensFresh,
    contextTokens: row.contextTokens,
    estimatedCostUsd: row.estimatedCostUsd,
    modelProvider: row.modelProvider,
    model: row.model,
    status: row.status,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    runtimeMs: row.runtimeMs,
    runClosureSummary: row.runClosureSummary,
    recoveryCheckpointId: row.recoveryCheckpointId,
    recoveryStatus: row.recoveryStatus,
    recoveryContinuationState: row.recoveryContinuationState,
    recoveryOperation: row.recoveryOperation,
    recoveryBlockedReason: row.recoveryBlockedReason,
    recoveryUpdatedAt: row.recoveryUpdatedAt,
    recoveryAttempts: row.recoveryAttempts,
    recoveryOperatorHint: row.recoveryOperatorHint,
    handoffRequestRunId: row.handoffRequestRunId,
    handoffRunId: row.handoffRunId,
    handoffTruthSource: row.handoffTruthSource,
    handoffHint: row.handoffHint,
  };

  if (options?.includeFullSession) {
    return { ...flat, session: row };
  }
  return flat;
}
