import type { GatewayRequestContext } from "./server-methods/types.js";
import { buildGatewaySessionBroadcastSnapshot } from "./session-broadcast-snapshot.js";
import { deriveGatewaySessionLifecycleSnapshot } from "./session-lifecycle-state.js";
import { loadGatewaySessionRow } from "./session-utils.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

type SessionEventHubContext = Pick<
  GatewayRequestContext,
  "broadcastToConnIds" | "getSessionEventSubscriberConnIds"
>;

type SessionLifecycleEventLike = Parameters<
  typeof deriveGatewaySessionLifecycleSnapshot
>[0]["event"];

type SessionBroadcastOverrides = Partial<
  Pick<GatewaySessionRow, "parentSessionKey" | "label" | "displayName">
>;

type SessionBroadcastSurfaceParams = {
  sessionKey?: string;
  row?: GatewaySessionRow | null;
  includeFullSession: boolean;
  lifecycleEvent?: SessionLifecycleEventLike;
  overrides?: SessionBroadcastOverrides;
};

export type BuildSessionsChangedMutationEventParams = {
  sessionKey?: string;
  reason: string;
  compacted?: boolean;
  ts?: number;
  row?: GatewaySessionRow | null;
};

export type BuildSessionsChangedLifecycleEventParams = {
  sessionKey: string;
  phase?: string;
  reason?: string;
  runId?: string;
  ts?: number;
  row?: GatewaySessionRow | null;
  lifecycleEvent?: SessionLifecycleEventLike;
  overrides?: SessionBroadcastOverrides;
};

export type BuildSessionsChangedTranscriptEventParams = {
  sessionKey: string;
  ts?: number;
  messageId?: string;
  messageSeq?: number;
  row?: GatewaySessionRow | null;
};

export type BuildSessionMessageSnapshotParams = {
  sessionKey: string;
  message: unknown;
  messageId?: string;
  messageSeq?: number;
  row?: GatewaySessionRow | null;
};

function resolveSessionRow(params: {
  sessionKey?: string;
  row?: GatewaySessionRow | null;
}): GatewaySessionRow | null {
  if (params.row !== undefined) {
    return params.row ?? null;
  }
  return params.sessionKey ? loadGatewaySessionRow(params.sessionKey) : null;
}

function buildSessionBroadcastSurface(
  params: SessionBroadcastSurfaceParams,
): Record<string, unknown> {
  const row = resolveSessionRow(params);
  const lifecyclePatch = params.lifecycleEvent
    ? deriveGatewaySessionLifecycleSnapshot({
        session: row ?? undefined,
        event: params.lifecycleEvent,
      })
    : {};

  const snapshotRow =
    row || Object.keys(lifecyclePatch).length > 0 || params.overrides
      ? row
        ? {
            ...row,
            ...lifecyclePatch,
            ...params.overrides,
          }
        : null
      : row;

  const snapshot = buildGatewaySessionBroadcastSnapshot(snapshotRow, {
    includeFullSession: params.includeFullSession,
  });

  if (row) {
    return snapshot;
  }

  return {
    ...lifecyclePatch,
    ...params.overrides,
    ...snapshot,
  };
}

export function buildSessionsChangedMutationEvent(
  params: BuildSessionsChangedMutationEventParams,
): Record<string, unknown> {
  return {
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    reason: params.reason,
    ...(typeof params.compacted === "boolean" ? { compacted: params.compacted } : {}),
    ts: params.ts ?? Date.now(),
    ...buildSessionBroadcastSurface({
      sessionKey: params.sessionKey,
      row: params.row,
      includeFullSession: false,
    }),
  };
}

export function buildSessionsChangedLifecycleEvent(
  params: BuildSessionsChangedLifecycleEventParams,
): Record<string, unknown> {
  return {
    sessionKey: params.sessionKey,
    ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
    ...(typeof params.phase === "string" ? { phase: params.phase } : {}),
    ...(typeof params.runId === "string" ? { runId: params.runId } : {}),
    ts: params.ts ?? Date.now(),
    ...buildSessionBroadcastSurface({
      sessionKey: params.sessionKey,
      row: params.row,
      includeFullSession: false,
      lifecycleEvent: params.lifecycleEvent,
      overrides: params.overrides,
    }),
  };
}

export function buildSessionsChangedTranscriptEvent(
  params: BuildSessionsChangedTranscriptEventParams,
): Record<string, unknown> {
  return {
    sessionKey: params.sessionKey,
    phase: "message",
    ts: params.ts ?? Date.now(),
    ...(typeof params.messageId === "string" ? { messageId: params.messageId } : {}),
    ...(typeof params.messageSeq === "number" ? { messageSeq: params.messageSeq } : {}),
    ...buildSessionBroadcastSurface({
      sessionKey: params.sessionKey,
      row: params.row,
      includeFullSession: true,
    }),
  };
}

export function buildSessionMessageSnapshot(
  params: BuildSessionMessageSnapshotParams,
): Record<string, unknown> {
  return {
    sessionKey: params.sessionKey,
    message: params.message,
    ...(typeof params.messageId === "string" ? { messageId: params.messageId } : {}),
    ...(typeof params.messageSeq === "number" ? { messageSeq: params.messageSeq } : {}),
    ...buildSessionBroadcastSurface({
      sessionKey: params.sessionKey,
      row: params.row,
      includeFullSession: true,
    }),
  };
}

export function broadcastSessionsChangedMutationEvent(
  params: BuildSessionsChangedMutationEventParams & { context: SessionEventHubContext },
): void {
  const connIds = params.context.getSessionEventSubscriberConnIds();
  if (connIds.size === 0) {
    return;
  }

  params.context.broadcastToConnIds(
    "sessions.changed",
    buildSessionsChangedMutationEvent(params),
    connIds,
    { dropIfSlow: true },
  );
}
