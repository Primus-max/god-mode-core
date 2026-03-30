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

function asArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
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
      (opts?.checkpointId &&
      checkpoints.some((checkpoint) => checkpoint.id === opts.checkpointId)
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
      state.client.request<RuntimeClosureListResult>("platform.runtime.closures.list", {
        ...(checkpoint.sessionKey ? { sessionKey: checkpoint.sessionKey } : {}),
      }),
    ]);
    state.runtimeActions = asArray(actionsRes?.actions);
    state.runtimeClosures = asArray(closuresRes?.closures);

    const selectedActionId =
      state.runtimeActions.some((action) => action.actionId === state.runtimeSelectedActionId)
        ? state.runtimeSelectedActionId
        : state.runtimeActions[0]?.actionId ?? null;
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
    const res = await state.client.request<RuntimeActionDetailResult>("platform.runtime.actions.get", {
      actionId,
    });
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

export async function clearRuntimeInspectorScope(state: RuntimeInspectorState): Promise<void> {
  state.runtimeSessionKey = null;
  state.runtimeRunId = null;
  await loadRuntimeInspector(state);
}
