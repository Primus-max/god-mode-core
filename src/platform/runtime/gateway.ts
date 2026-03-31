import type { GatewayRequestHandler } from "../../gateway/server-methods/types.js";
import {
  PlatformRuntimeActionSchema,
  PlatformRuntimeCheckpointSummarySchema,
} from "./contracts.js";
import { deriveRecoveryOperatorHint } from "./recovery-operator-hint.js";
import type { PlatformRuntimeCheckpointService } from "./service.js";

function toRuntimeCheckpointSummary(
  checkpoint: NonNullable<ReturnType<PlatformRuntimeCheckpointService["get"]>>,
) {
  return PlatformRuntimeCheckpointSummarySchema.parse({
    id: checkpoint.id,
    runId: checkpoint.runId,
    ...(checkpoint.sessionKey ? { sessionKey: checkpoint.sessionKey } : {}),
    boundary: checkpoint.boundary,
    status: checkpoint.status,
    ...(checkpoint.blockedReason ? { blockedReason: checkpoint.blockedReason } : {}),
    ...(checkpoint.nextActions?.length ? { nextActions: checkpoint.nextActions } : {}),
    ...(checkpoint.target ? { target: checkpoint.target } : {}),
    ...(checkpoint.continuation
      ? {
          continuation: {
            kind: checkpoint.continuation.kind,
            ...(checkpoint.continuation.autoDispatch !== undefined
              ? { autoDispatch: checkpoint.continuation.autoDispatch }
              : {}),
            ...(checkpoint.continuation.state ? { state: checkpoint.continuation.state } : {}),
            ...(checkpoint.continuation.attempts !== undefined
              ? { attempts: checkpoint.continuation.attempts }
              : {}),
            ...(checkpoint.continuation.lastError
              ? { lastError: checkpoint.continuation.lastError }
              : {}),
            ...(checkpoint.continuation.lastDispatchedAtMs !== undefined
              ? { lastDispatchedAtMs: checkpoint.continuation.lastDispatchedAtMs }
              : {}),
            ...(checkpoint.continuation.lastCompletedAtMs !== undefined
              ? { lastCompletedAtMs: checkpoint.continuation.lastCompletedAtMs }
              : {}),
          },
        }
      : {}),
    createdAtMs: checkpoint.createdAtMs,
    updatedAtMs: checkpoint.updatedAtMs,
    ...(checkpoint.approvedAtMs !== undefined ? { approvedAtMs: checkpoint.approvedAtMs } : {}),
    ...(checkpoint.resumedAtMs !== undefined ? { resumedAtMs: checkpoint.resumedAtMs } : {}),
    ...(checkpoint.completedAtMs !== undefined ? { completedAtMs: checkpoint.completedAtMs } : {}),
  });
}

export function createRuntimeCheckpointListGatewayMethod(
  service: PlatformRuntimeCheckpointService,
): GatewayRequestHandler {
  return ({ params, respond }) => {
    const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : undefined;
    const runId = typeof params.runId === "string" ? params.runId.trim() : undefined;
    const status = typeof params.status === "string" ? params.status.trim() : undefined;
    const checkpoints = service.list({
      ...(sessionKey ? { sessionKey } : {}),
      ...(runId ? { runId } : {}),
      ...(status ? { status: status as never } : {}),
    });
    respond(true, {
      checkpoints: checkpoints.map((cp) => ({
        ...cp,
        operatorHint: deriveRecoveryOperatorHint(cp),
      })),
    });
  };
}

export function createRuntimeCheckpointGetGatewayMethod(
  service: PlatformRuntimeCheckpointService,
): GatewayRequestHandler {
  return ({ params, respond }) => {
    const checkpointId = typeof params.checkpointId === "string" ? params.checkpointId.trim() : "";
    if (!checkpointId) {
      respond(false, { error: "checkpointId required" });
      return;
    }
    const checkpoint = service.get(checkpointId);
    if (!checkpoint) {
      respond(false, { error: "checkpoint not found" });
      return;
    }
    const summary = toRuntimeCheckpointSummary(checkpoint);
    respond(true, {
      checkpoint: {
        ...summary,
        operatorHint: deriveRecoveryOperatorHint(summary),
      },
    });
  };
}

export function createRuntimeCheckpointDispatchGatewayMethod(
  service: PlatformRuntimeCheckpointService,
): GatewayRequestHandler {
  return async ({ params, respond }) => {
    const checkpointId = typeof params.checkpointId === "string" ? params.checkpointId.trim() : "";
    if (!checkpointId) {
      respond(false, { error: "checkpointId required" });
      return;
    }
    const checkpoint = service.get(checkpointId);
    if (!checkpoint) {
      respond(false, { error: "checkpoint not found" });
      return;
    }
    if (!checkpoint.continuation?.kind) {
      respond(false, { error: "checkpoint continuation not found" });
      return;
    }
    if (
      checkpoint.status === "completed" ||
      checkpoint.status === "denied" ||
      checkpoint.status === "cancelled"
    ) {
      respond(false, { error: "checkpoint already closed" });
      return;
    }
    if (checkpoint.continuation.state === "running") {
      respond(false, { error: "checkpoint continuation already running" });
      return;
    }
    if (checkpoint.target?.approvalId && checkpoint.status === "blocked") {
      respond(false, { error: "checkpoint still requires explicit approval" });
      return;
    }
    if (checkpoint.continuation.kind === "closure_recovery") {
      await import("../../auto-reply/reply/closure-outcome-dispatcher.js");
    }
    const updated = await service.dispatchContinuation(checkpointId);
    if (!updated) {
      respond(false, { error: "checkpoint dispatch failed" });
      return;
    }
    const summary = toRuntimeCheckpointSummary(updated);
    respond(true, {
      checkpoint: {
        ...summary,
        operatorHint: deriveRecoveryOperatorHint(summary),
      },
    });
  };
}

export function createRuntimeActionListGatewayMethod(
  service: PlatformRuntimeCheckpointService,
): GatewayRequestHandler {
  return ({ params, respond }) => {
    const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : undefined;
    const runId = typeof params.runId === "string" ? params.runId.trim() : undefined;
    const kind = typeof params.kind === "string" ? params.kind.trim() : undefined;
    const state = typeof params.state === "string" ? params.state.trim() : undefined;
    const checkpointId =
      typeof params.checkpointId === "string" ? params.checkpointId.trim() : undefined;
    const idempotencyKey =
      typeof params.idempotencyKey === "string" ? params.idempotencyKey.trim() : undefined;
    respond(true, {
      actions: service.listActions({
        ...(sessionKey ? { sessionKey } : {}),
        ...(runId ? { runId } : {}),
        ...(kind ? { kind: kind as never } : {}),
        ...(state ? { state: state as never } : {}),
        ...(checkpointId ? { checkpointId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }),
    });
  };
}

export function createRuntimeActionGetGatewayMethod(
  service: PlatformRuntimeCheckpointService,
): GatewayRequestHandler {
  return ({ params, respond }) => {
    const actionId = typeof params.actionId === "string" ? params.actionId.trim() : "";
    if (!actionId) {
      respond(false, { error: "actionId required" });
      return;
    }
    const action = service.getAction(actionId);
    if (!action) {
      respond(false, { error: "action not found" });
      return;
    }
    respond(true, {
      action: PlatformRuntimeActionSchema.parse(action),
    });
  };
}

export function createRuntimeClosureListGatewayMethod(
  service: PlatformRuntimeCheckpointService,
): GatewayRequestHandler {
  return ({ params, respond }) => {
    const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : undefined;
    const requestRunId =
      typeof params.requestRunId === "string" ? params.requestRunId.trim() : undefined;
    respond(true, {
      closures: service.listRunClosures({
        ...(sessionKey ? { sessionKey } : {}),
        ...(requestRunId ? { requestRunId } : {}),
      }),
    });
  };
}

export function createRuntimeClosureGetGatewayMethod(
  service: PlatformRuntimeCheckpointService,
): GatewayRequestHandler {
  return ({ params, respond }) => {
    const runId = typeof params.runId === "string" ? params.runId.trim() : "";
    if (!runId) {
      respond(false, { error: "runId required" });
      return;
    }
    const closure = service.getRunClosure(runId);
    if (!closure) {
      respond(false, { error: "run closure not found" });
      return;
    }
    respond(true, { closure });
  };
}
