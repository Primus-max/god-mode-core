export type ExecApprovalRequestPayload = {
  command: string;
  cwd?: string | null;
  nodeId?: string | null;
  envKeys?: string[] | null;
  host?: string | null;
  security?: string | null;
  ask?: string | null;
  agentId?: string | null;
  resolvedPath?: string | null;
  sessionKey?: string | null;
  machineControl?: {
    required: boolean;
    requestedByDeviceId?: string | null;
    linkedAtMs?: number | null;
  } | null;
  runtimeRunId?: string | null;
  runtimeCheckpointId?: string | null;
  runtimeBoundary?: string | null;
  blockedReason?: string | null;
};

export type ExecApprovalRequest = {
  id: string;
  request: ExecApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
};

export type ExecApprovalResolved = {
  id: string;
  decision?: string | null;
  resolvedBy?: string | null;
  ts?: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseExecApprovalRequested(payload: unknown): ExecApprovalRequest | null {
  if (!isRecord(payload)) {
    return null;
  }
  const id = typeof payload.id === "string" ? payload.id.trim() : "";
  const request = payload.request;
  if (!id || !isRecord(request)) {
    return null;
  }
  const command = typeof request.command === "string" ? request.command.trim() : "";
  if (!command) {
    return null;
  }
  const createdAtMs = typeof payload.createdAtMs === "number" ? payload.createdAtMs : 0;
  const expiresAtMs = typeof payload.expiresAtMs === "number" ? payload.expiresAtMs : 0;
  if (!createdAtMs || !expiresAtMs) {
    return null;
  }
  return {
    id,
    request: {
      command,
      cwd: typeof request.cwd === "string" ? request.cwd : null,
      nodeId: typeof request.nodeId === "string" ? request.nodeId : null,
      envKeys: Array.isArray(request.envKeys)
        ? request.envKeys.filter((entry): entry is string => typeof entry === "string")
        : null,
      host: typeof request.host === "string" ? request.host : null,
      security: typeof request.security === "string" ? request.security : null,
      ask: typeof request.ask === "string" ? request.ask : null,
      agentId: typeof request.agentId === "string" ? request.agentId : null,
      resolvedPath: typeof request.resolvedPath === "string" ? request.resolvedPath : null,
      sessionKey: typeof request.sessionKey === "string" ? request.sessionKey : null,
      machineControl:
        isRecord(request.machineControl) && request.machineControl.required === true
          ? {
              required: true,
              requestedByDeviceId:
                typeof request.machineControl.requestedByDeviceId === "string"
                  ? request.machineControl.requestedByDeviceId
                  : null,
              linkedAtMs:
                typeof request.machineControl.linkedAtMs === "number"
                  ? request.machineControl.linkedAtMs
                  : null,
            }
          : null,
      runtimeRunId: typeof request.runtimeRunId === "string" ? request.runtimeRunId : null,
      runtimeCheckpointId:
        typeof request.runtimeCheckpointId === "string" ? request.runtimeCheckpointId : null,
      runtimeBoundary: typeof request.runtimeBoundary === "string" ? request.runtimeBoundary : null,
      blockedReason: typeof request.blockedReason === "string" ? request.blockedReason : null,
    },
    createdAtMs,
    expiresAtMs,
  };
}

export function parseExecApprovalResolved(payload: unknown): ExecApprovalResolved | null {
  if (!isRecord(payload)) {
    return null;
  }
  const id = typeof payload.id === "string" ? payload.id.trim() : "";
  if (!id) {
    return null;
  }
  return {
    id,
    decision: typeof payload.decision === "string" ? payload.decision : null,
    resolvedBy: typeof payload.resolvedBy === "string" ? payload.resolvedBy : null,
    ts: typeof payload.ts === "number" ? payload.ts : null,
  };
}

export function pruneExecApprovalQueue(queue: ExecApprovalRequest[]): ExecApprovalRequest[] {
  const now = Date.now();
  return queue.filter((entry) => entry.expiresAtMs > now);
}

export function addExecApproval(
  queue: ExecApprovalRequest[],
  entry: ExecApprovalRequest,
): ExecApprovalRequest[] {
  const next = pruneExecApprovalQueue(queue).filter((item) => item.id !== entry.id);
  next.push(entry);
  return next;
}

export function removeExecApproval(
  queue: ExecApprovalRequest[],
  id: string,
): ExecApprovalRequest[] {
  return pruneExecApprovalQueue(queue).filter((entry) => entry.id !== id);
}
