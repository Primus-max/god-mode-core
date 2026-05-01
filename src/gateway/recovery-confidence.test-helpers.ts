import type { WebSocket } from "ws";
import type { SessionEntry } from "../config/sessions.js";
import {
  getPlatformRuntimeCheckpointService,
  type PlatformRuntimeActionReceipt,
  type PlatformRuntimeActionSummary,
  type PlatformRuntimeRunClosure,
} from "../platform/runtime/index.js";
import type { GatewaySessionRow } from "./session-utils.types.js";
import { rpcReq, testState, writeSessionStore } from "./test-helpers.js";

type RecoveryConfidenceCheckpointSnapshot = {
  id: string;
  runId: string;
  sessionKey?: string;
  status: string;
  continuation?: {
    kind?: string;
    state?: string;
    attempts?: number;
  };
  operatorHint?: string;
};

export type RecoveryConfidenceSnapshot = {
  row: GatewaySessionRow | undefined;
  actions: PlatformRuntimeActionSummary[];
  closures: PlatformRuntimeRunClosure[];
  checkpoints: RecoveryConfidenceCheckpointSnapshot[];
};

export function buildSessionRunClosureSummary(
  closure: PlatformRuntimeRunClosure,
): NonNullable<SessionEntry["runClosureSummary"]> {
  return {
    runId: closure.runId,
    ...(closure.requestRunId ? { requestRunId: closure.requestRunId } : {}),
    ...(closure.parentRunId ? { parentRunId: closure.parentRunId } : {}),
    ...(closure.sessionKey ? { sessionKey: closure.sessionKey } : {}),
    updatedAtMs: closure.updatedAtMs,
    outcomeStatus: closure.outcome.status,
    verificationStatus: closure.executionVerification.status,
    acceptanceStatus: closure.acceptanceOutcome.status,
    action: closure.supervisorVerdict.action,
    remediation: closure.supervisorVerdict.remediation,
    reasonCode: closure.supervisorVerdict.reasonCode,
    reasons: closure.supervisorVerdict.reasons,
    ...(closure.executionIntent.intent ? { declaredIntent: closure.executionIntent.intent } : {}),
    ...(closure.executionIntent.profileId
      ? { declaredProfileId: closure.executionIntent.profileId }
      : {}),
    ...(closure.executionIntent.recipeId ? { declaredRecipeId: closure.executionIntent.recipeId } : {}),
    ...(closure.executionIntent.expectations.requiresOutput !== undefined
      ? { requiresOutput: closure.executionIntent.expectations.requiresOutput }
      : {}),
    ...(closure.executionIntent.expectations.requiresMessagingDelivery !== undefined
      ? {
          requiresMessagingDelivery: closure.executionIntent.expectations.requiresMessagingDelivery,
        }
      : {}),
    ...(closure.executionIntent.expectations.requiresConfirmedAction !== undefined
      ? {
          requiresConfirmedAction: closure.executionIntent.expectations.requiresConfirmedAction,
        }
      : {}),
    ...(closure.executionSurface?.status ? { surfaceStatus: closure.executionSurface.status } : {}),
  };
}

export async function writeRecoverySessionStore(params: {
  storePath: string;
  entries: Record<string, Partial<SessionEntry>>;
  agentId?: string;
}) {
  testState.sessionStorePath = params.storePath;
  await writeSessionStore({
    storePath: params.storePath,
    entries: params.entries,
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
}

export function recordMessagingDeliveryAction(params: {
  actionId: string;
  runId: string;
  requestRunId: string;
  sessionKey: string;
  finalState: "confirmed" | "failed";
  receipt?: PlatformRuntimeActionReceipt;
  lastError?: string;
  retryable?: boolean;
}) {
  const service = getPlatformRuntimeCheckpointService();
  service.stageAction({
    actionId: params.actionId,
    runId: params.runId,
    sessionKey: params.sessionKey,
    kind: "messaging_delivery",
    idempotencyKey: params.requestRunId,
    target: {
      operation: "deliver",
    },
  });
  service.markActionAttempted(params.actionId, {
    retryable: params.finalState === "failed" ? (params.retryable ?? true) : false,
  });
  if (params.finalState === "confirmed") {
    service.markActionConfirmed(params.actionId, {
      ...(params.receipt ? { receipt: params.receipt } : {}),
      ...(params.lastError ? { lastError: params.lastError } : {}),
    });
  } else {
    service.markActionFailed(params.actionId, {
      retryable: params.retryable ?? true,
      ...(params.lastError ? { lastError: params.lastError } : {}),
      ...(params.receipt ? { receipt: params.receipt } : {}),
    });
  }
}

export function recordRunClosureFromEvidence(params: {
  runId: string;
  requestRunId: string;
  sessionKey: string;
  evidence: {
    hasOutput?: boolean;
    stagedReplyCount?: number;
    attemptedDeliveryCount?: number;
    confirmedDeliveryCount?: number;
    deliveredReplyCount?: number;
    failedDeliveryCount?: number;
  };
}) {
  const service = getPlatformRuntimeCheckpointService();
  const closure = service.buildRunClosure({
    runId: params.runId,
    requestRunId: params.requestRunId,
    sessionKey: params.sessionKey,
    outcome: service.buildRunOutcome(params.runId),
    evidence: params.evidence,
  });
  return service.recordRunClosure(closure);
}

export async function readRecoveryConfidenceSnapshot(params: {
  ws: WebSocket;
  sessionKey: string;
  requestRunId: string;
}): Promise<RecoveryConfidenceSnapshot> {
  const sessionsRes = await rpcReq<{ sessions: GatewaySessionRow[] }>(params.ws, "sessions.list", {
    includeGlobal: false,
    includeUnknown: false,
  });
  const service = getPlatformRuntimeCheckpointService();
  const sessions = sessionsRes.payload?.sessions ?? [];
  return {
    row: sessions.find((session) => session.key === params.sessionKey),
    actions: service.listActions({
      idempotencyKey: params.requestRunId,
      kind: "messaging_delivery",
    }),
    closures: service.listRunClosures({
      requestRunId: params.requestRunId,
    }),
    checkpoints: service.list({
      sessionKey: params.sessionKey,
    }) as RecoveryConfidenceCheckpointSnapshot[],
  };
}
