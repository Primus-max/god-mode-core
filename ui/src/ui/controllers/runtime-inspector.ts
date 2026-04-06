import type { ArtifactOperation } from "../../../../src/platform/schemas/artifact.js";
import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  RuntimeActionDetail,
  RuntimeActionSummary,
  RuntimeCheckpointSummary,
  RuntimeClosureDetail,
  RuntimeClosureSummary,
} from "../types.ts";

type RuntimeCheckpointListResult = {
  checkpoints?: RuntimeCheckpointSummary[];
};

type RuntimeCheckpointDetailResult = {
  checkpoint?: RuntimeCheckpointSummary;
};

type RuntimeActionListResult = {
  actions?: RuntimeActionSummary[];
};

type RuntimeActionDetailResult = {
  action?: RuntimeActionDetail;
};

type RuntimeClosureListResult = {
  closures?: RuntimeClosureSummary[];
};

type RuntimeClosureDetailResult = {
  closure?: RuntimeClosureDetail;
};

export type RuntimeInspectorState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  runtimeLoading: boolean;
  runtimeDetailLoading: boolean;
  runtimeActionBusy: boolean;
  runtimeError: string | null;
  runtimeSessionKey: string | null;
  runtimeRunId: string | null;
  runtimeStatus: string;
  runtimeCheckpoints: RuntimeCheckpointSummary[];
  runtimeSelectedCheckpointId: string | null;
  runtimeCheckpointDetail: RuntimeCheckpointSummary | null;
  runtimeActions: RuntimeActionSummary[];
  runtimeSelectedActionId: string | null;
  runtimeActionDetail: RuntimeActionDetail | null;
  runtimeClosures: RuntimeClosureSummary[];
  runtimeSelectedClosureRunId: string | null;
  runtimeClosureDetail: RuntimeClosureDetail | null;
};

export type RuntimeRecoveryAction =
  | {
      kind: "exec-approval-resolve";
      checkpointId: string;
      approvalId: string;
      decision: "allow-once" | "deny";
    }
  | {
      kind: "bootstrap-resolve";
      checkpointId: string;
      requestId: string;
      decision: "approve" | "deny";
    }
  | { kind: "bootstrap-run"; checkpointId: string; requestId: string }
  | {
      kind: "artifact-transition";
      checkpointId: string;
      artifactId: string;
      operation: ArtifactOperation;
    }
  | { kind: "dispatch-continuation"; checkpointId: string };

export type RuntimeRecoveryConfirmationKind =
  | "deny-recovery"
  | "deny-bootstrap"
  | "dispatch-continuation"
  | "artifact-approve"
  | "artifact-publish"
  | "artifact-delete";

export type RuntimeRecoveryGuardrail = {
  requiresConfirmation: boolean;
  confirmationKind?: RuntimeRecoveryConfirmationKind;
};

export function checkpointHasNextAction(
  checkpoint: RuntimeCheckpointSummary,
  method: string,
  phase?: "approve" | "deny" | "resume" | "retry" | "inspect",
): boolean {
  return (
    checkpoint.nextActions?.some(
      (action) => action.method === method && (phase ? action.phase === phase : true),
    ) ?? false
  );
}

/** Operator-facing phase for bootstrap boundary checkpoints (Sessions runtime inspector). */
export type BootstrapCheckpointUiPhase =
  | "pending_approval"
  | "pending_run"
  | "install_running"
  | "resume_dispatch"
  | "resume_failed"
  | "resume_complete"
  | "completed"
  | "denied"
  | "generic";

export function resolveBootstrapCheckpointUiPhase(
  checkpoint: RuntimeCheckpointSummary,
): BootstrapCheckpointUiPhase | null {
  if (checkpoint.boundary !== "bootstrap") {
    return null;
  }
  if (checkpoint.status === "denied") {
    return "denied";
  }
  if (checkpoint.status === "completed") {
    return "completed";
  }
  if (checkpoint.status === "cancelled") {
    return "generic";
  }
  if (checkpoint.status === "blocked") {
    if (checkpointHasNextAction(checkpoint, "platform.bootstrap.resolve", "approve")) {
      return "pending_approval";
    }
    return "generic";
  }
  if (checkpoint.status === "approved") {
    if (checkpointHasNextAction(checkpoint, "platform.bootstrap.run", "resume")) {
      return "pending_run";
    }
    if (
      checkpoint.continuation?.kind === "bootstrap_run" &&
      checkpoint.continuation.state === "running"
    ) {
      return "install_running";
    }
    return "generic";
  }
  if (checkpoint.status === "resumed") {
    if (checkpoint.continuation?.kind === "closure_recovery") {
      if (checkpoint.continuation.state === "failed") {
        return "resume_failed";
      }
      if (checkpoint.continuation.state === "completed") {
        return "resume_complete";
      }
      return "resume_dispatch";
    }
    if (
      checkpoint.continuation?.kind === "bootstrap_run" &&
      checkpoint.continuation.state === "running"
    ) {
      return "install_running";
    }
    return "generic";
  }
  return "generic";
}

export function getRuntimeRecoveryGuardrail(
  action: RuntimeRecoveryAction,
): RuntimeRecoveryGuardrail {
  switch (action.kind) {
    case "exec-approval-resolve":
      return action.decision === "deny"
        ? { requiresConfirmation: true, confirmationKind: "deny-recovery" }
        : { requiresConfirmation: false };
    case "bootstrap-resolve":
      return action.decision === "deny"
        ? { requiresConfirmation: true, confirmationKind: "deny-bootstrap" }
        : { requiresConfirmation: false };
    case "artifact-transition":
      if (action.operation === "approve") {
        return { requiresConfirmation: true, confirmationKind: "artifact-approve" };
      }
      if (action.operation === "publish") {
        return { requiresConfirmation: true, confirmationKind: "artifact-publish" };
      }
      if (action.operation === "delete") {
        return { requiresConfirmation: true, confirmationKind: "artifact-delete" };
      }
      return { requiresConfirmation: false };
    case "dispatch-continuation":
      return { requiresConfirmation: true, confirmationKind: "dispatch-continuation" };
    case "bootstrap-run":
      return { requiresConfirmation: false };
  }
}

function asArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function getRuntimeScope(state: RuntimeInspectorState): {
  sessionKey?: string | null;
  runId?: string | null;
  checkpointId?: string | null;
} {
  return {
    ...(state.runtimeSessionKey ? { sessionKey: state.runtimeSessionKey } : {}),
    ...(state.runtimeRunId ? { runId: state.runtimeRunId } : {}),
    ...(state.runtimeSelectedCheckpointId
      ? { checkpointId: state.runtimeSelectedCheckpointId }
      : {}),
  };
}

export async function loadRuntimeInspector(
  state: RuntimeInspectorState,
  opts?: {
    sessionKey?: string | null;
    runId?: string | null;
    status?: string | null;
    checkpointId?: string | null;
  },
): Promise<void> {
  if (!state.client || !state.connected || state.runtimeLoading) {
    return;
  }
  if (opts && "sessionKey" in opts) {
    state.runtimeSessionKey = opts.sessionKey?.trim() || null;
  }
  if (opts && "runId" in opts) {
    state.runtimeRunId = opts.runId?.trim() || null;
  }
  if (opts && "status" in opts) {
    state.runtimeStatus = opts.status?.trim() || "";
  }
  state.runtimeLoading = true;
  state.runtimeError = null;
  try {
    const params: Record<string, unknown> = {};
    if (state.runtimeSessionKey) {
      params.sessionKey = state.runtimeSessionKey;
    }
    if (state.runtimeRunId) {
      params.runId = state.runtimeRunId;
    }
    if (state.runtimeStatus) {
      params.status = state.runtimeStatus;
    }
    const res = await state.client.request<RuntimeCheckpointListResult>(
      "platform.runtime.checkpoints.list",
      params,
    );
    const checkpoints = asArray(res?.checkpoints);
    state.runtimeCheckpoints = checkpoints;
    const selectedCheckpointId =
      (opts?.checkpointId && checkpoints.some((checkpoint) => checkpoint.id === opts.checkpointId)
        ? opts.checkpointId
        : undefined) ??
      (checkpoints.some((checkpoint) => checkpoint.id === state.runtimeSelectedCheckpointId)
        ? state.runtimeSelectedCheckpointId
        : checkpoints[0]?.id) ??
      null;
    state.runtimeSelectedCheckpointId = selectedCheckpointId;
    if (!selectedCheckpointId) {
      state.runtimeCheckpointDetail = null;
      state.runtimeActions = [];
      state.runtimeSelectedActionId = null;
      state.runtimeActionDetail = null;
      state.runtimeClosures = [];
      state.runtimeSelectedClosureRunId = null;
      state.runtimeClosureDetail = null;
      return;
    }
    await loadRuntimeCheckpointDetail(state, selectedCheckpointId);
  } catch (err) {
    state.runtimeError = String(err);
  } finally {
    state.runtimeLoading = false;
  }
}

export async function loadRuntimeCheckpointDetail(
  state: RuntimeInspectorState,
  checkpointId: string,
): Promise<void> {
  if (!state.client || !state.connected || !checkpointId || state.runtimeDetailLoading) {
    return;
  }
  state.runtimeSelectedCheckpointId = checkpointId;
  state.runtimeDetailLoading = true;
  state.runtimeError = null;
  try {
    const detailRes = await state.client.request<RuntimeCheckpointDetailResult>(
      "platform.runtime.checkpoints.get",
      { checkpointId },
    );
    const checkpoint = detailRes?.checkpoint ?? null;
    state.runtimeCheckpointDetail = checkpoint;
    if (!checkpoint) {
      state.runtimeActions = [];
      state.runtimeSelectedActionId = null;
      state.runtimeActionDetail = null;
      state.runtimeClosures = [];
      state.runtimeSelectedClosureRunId = null;
      state.runtimeClosureDetail = null;
      return;
    }
    state.runtimeSessionKey = checkpoint.sessionKey ?? state.runtimeSessionKey;
    state.runtimeRunId = checkpoint.runId ?? state.runtimeRunId;

    const [actionsRes, closuresRes] = await Promise.all([
      state.client.request<RuntimeActionListResult>("platform.runtime.actions.list", {
        checkpointId: checkpoint.id,
        ...(checkpoint.runId ? { runId: checkpoint.runId } : {}),
      }),
      state.client.request<RuntimeClosureListResult>(
        "platform.runtime.closures.list",
        checkpoint.sessionKey ? { sessionKey: checkpoint.sessionKey } : {},
      ),
    ]);
    state.runtimeActions = asArray(actionsRes?.actions);
    state.runtimeClosures = asArray(closuresRes?.closures);

    const selectedActionId = state.runtimeActions.some(
      (action) => action.actionId === state.runtimeSelectedActionId,
    )
      ? state.runtimeSelectedActionId
      : (state.runtimeActions[0]?.actionId ?? null);
    state.runtimeSelectedActionId = selectedActionId;
    if (selectedActionId) {
      await loadRuntimeActionDetail(state, selectedActionId);
    } else {
      state.runtimeActionDetail = null;
    }

    const selectedClosureRunId =
      state.runtimeClosures.find((closure) => closure.runId === checkpoint.runId)?.runId ??
      (state.runtimeClosures.some((closure) => closure.runId === state.runtimeSelectedClosureRunId)
        ? state.runtimeSelectedClosureRunId
        : state.runtimeClosures[0]?.runId) ??
      null;
    state.runtimeSelectedClosureRunId = selectedClosureRunId;
    if (selectedClosureRunId) {
      await loadRuntimeClosureDetail(state, selectedClosureRunId);
    } else {
      state.runtimeClosureDetail = null;
    }
  } catch (err) {
    state.runtimeCheckpointDetail = null;
    state.runtimeActions = [];
    state.runtimeClosures = [];
    state.runtimeError = String(err);
  } finally {
    state.runtimeDetailLoading = false;
  }
}

export async function loadRuntimeActionDetail(
  state: RuntimeInspectorState,
  actionId: string,
): Promise<void> {
  if (!state.client || !state.connected || !actionId) {
    return;
  }
  state.runtimeSelectedActionId = actionId;
  try {
    const res = await state.client.request<RuntimeActionDetailResult>(
      "platform.runtime.actions.get",
      {
        actionId,
      },
    );
    state.runtimeActionDetail = res?.action ?? null;
  } catch (err) {
    state.runtimeActionDetail = null;
    state.runtimeError = String(err);
  }
}

export async function loadRuntimeClosureDetail(
  state: RuntimeInspectorState,
  runId: string,
): Promise<void> {
  if (!state.client || !state.connected || !runId) {
    return;
  }
  state.runtimeSelectedClosureRunId = runId;
  try {
    const res = await state.client.request<RuntimeClosureDetailResult>(
      "platform.runtime.closures.get",
      { runId },
    );
    state.runtimeClosureDetail = res?.closure ?? null;
  } catch (err) {
    state.runtimeClosureDetail = null;
    state.runtimeError = String(err);
  }
}

export async function executeRuntimeRecoveryAction(
  state: RuntimeInspectorState,
  action: RuntimeRecoveryAction,
): Promise<void> {
  if (!state.client || !state.connected || state.runtimeActionBusy) {
    return;
  }
  state.runtimeActionBusy = true;
  state.runtimeError = null;
  try {
    switch (action.kind) {
      case "exec-approval-resolve":
        await state.client.request("exec.approval.resolve", {
          id: action.approvalId,
          decision: action.decision,
        });
        break;
      case "bootstrap-resolve":
        await state.client.request("platform.bootstrap.resolve", {
          requestId: action.requestId,
          decision: action.decision,
        });
        break;
      case "bootstrap-run":
        await state.client.request("platform.bootstrap.run", {
          requestId: action.requestId,
        });
        break;
      case "artifact-transition":
        await state.client.request("platform.artifacts.transition", {
          artifactId: action.artifactId,
          operation: action.operation,
        });
        break;
      case "dispatch-continuation":
        await state.client.request("platform.runtime.checkpoints.dispatch", {
          checkpointId: action.checkpointId,
        });
        break;
    }
    await loadRuntimeInspector(state, {
      ...getRuntimeScope(state),
      checkpointId: action.checkpointId,
    });
  } catch (err) {
    state.runtimeError = String(err);
  } finally {
    state.runtimeActionBusy = false;
  }
}

export async function clearRuntimeInspectorScope(state: RuntimeInspectorState): Promise<void> {
  state.runtimeSessionKey = null;
  state.runtimeRunId = null;
  await loadRuntimeInspector(state);
}
