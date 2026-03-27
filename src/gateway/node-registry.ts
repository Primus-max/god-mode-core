import { randomUUID } from "node:crypto";
import { emitAgentEvent, registerAgentRunContext } from "../infra/agent-events.js";
import { getPlatformRuntimeCheckpointService } from "../platform/runtime/index.js";
import type { GatewayWsClient } from "./server/ws-types.js";

export type NodeSession = {
  nodeId: string;
  connId: string;
  client: GatewayWsClient;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  remoteIp?: string;
  caps: string[];
  commands: string[];
  permissions?: Record<string, boolean>;
  pathEnv?: string;
  connectedAtMs: number;
};

type PendingInvoke = {
  nodeId: string;
  command: string;
  runtimeCheckpointId?: string;
  resolve: (value: NodeInvokeResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type NodeInvokeResult = {
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string | null;
  error?: { code?: string; message?: string } | null;
};

export class NodeRegistry {
  private nodesById = new Map<string, NodeSession>();
  private nodesByConn = new Map<string, string>();
  private pendingInvokes = new Map<string, PendingInvoke>();

  register(client: GatewayWsClient, opts: { remoteIp?: string | undefined }) {
    const connect = client.connect;
    const nodeId = connect.device?.id ?? connect.client.id;
    const caps = Array.isArray(connect.caps) ? connect.caps : [];
    const commands = Array.isArray((connect as { commands?: string[] }).commands)
      ? ((connect as { commands?: string[] }).commands ?? [])
      : [];
    const permissions =
      typeof (connect as { permissions?: Record<string, boolean> }).permissions === "object"
        ? ((connect as { permissions?: Record<string, boolean> }).permissions ?? undefined)
        : undefined;
    const pathEnv =
      typeof (connect as { pathEnv?: string }).pathEnv === "string"
        ? (connect as { pathEnv?: string }).pathEnv
        : undefined;
    const session: NodeSession = {
      nodeId,
      connId: client.connId,
      client,
      displayName: connect.client.displayName,
      platform: connect.client.platform,
      version: connect.client.version,
      coreVersion: (connect as { coreVersion?: string }).coreVersion,
      uiVersion: (connect as { uiVersion?: string }).uiVersion,
      deviceFamily: connect.client.deviceFamily,
      modelIdentifier: connect.client.modelIdentifier,
      remoteIp: opts.remoteIp,
      caps,
      commands,
      permissions,
      pathEnv,
      connectedAtMs: Date.now(),
    };
    this.nodesById.set(nodeId, session);
    this.nodesByConn.set(client.connId, nodeId);
    return session;
  }

  unregister(connId: string): string | null {
    const nodeId = this.nodesByConn.get(connId);
    if (!nodeId) {
      return null;
    }
    this.nodesByConn.delete(connId);
    this.nodesById.delete(nodeId);
    for (const [id, pending] of this.pendingInvokes.entries()) {
      if (pending.nodeId !== nodeId) {
        continue;
      }
      clearTimeout(pending.timer);
      pending.reject(new Error(`node disconnected (${pending.command})`));
      this.pendingInvokes.delete(id);
    }
    return nodeId;
  }

  listConnected(): NodeSession[] {
    return [...this.nodesById.values()];
  }

  get(nodeId: string): NodeSession | undefined {
    return this.nodesById.get(nodeId);
  }

  async invoke(params: {
    nodeId: string;
    command: string;
    params?: unknown;
    timeoutMs?: number;
    idempotencyKey?: string;
  }): Promise<NodeInvokeResult> {
    const node = this.nodesById.get(params.nodeId);
    if (!node) {
      return {
        ok: false,
        error: { code: "NOT_CONNECTED", message: "node not connected" },
      };
    }
    const requestId = randomUUID();
    const payload = {
      id: requestId,
      nodeId: params.nodeId,
      command: params.command,
      paramsJSON:
        "params" in params && params.params !== undefined ? JSON.stringify(params.params) : null,
      timeoutMs: params.timeoutMs,
      idempotencyKey: params.idempotencyKey,
    };
    const runtimeCheckpointId =
      params.command === "system.run" &&
      params.params &&
      typeof params.params === "object" &&
      !Array.isArray(params.params) &&
      (params.params as { approved?: unknown }).approved === true &&
      typeof (params.params as { runId?: unknown }).runId === "string"
        ? ((params.params as { runId: string }).runId ?? "")
        : undefined;
    const runtimeService = getPlatformRuntimeCheckpointService();
    const actionId = runtimeCheckpointId ? `node-invoke:${runtimeCheckpointId}` : undefined;
    if (actionId) {
      const existingAction = runtimeService.getAction(actionId);
      const cachedResult = existingAction?.receipt?.nodeInvokeResult;
      if (existingAction?.state === "confirmed" && cachedResult) {
        return {
          ok: cachedResult.ok,
          payload: cachedResult.payload,
          payloadJSON: cachedResult.payloadJSON ?? null,
          error: cachedResult.error ?? null,
        };
      }
      runtimeService.stageAction({
        actionId,
        runId: runtimeCheckpointId,
        kind: "node_invoke",
        boundary: "privileged_tool",
        checkpointId: runtimeCheckpointId,
        ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
        target: {
          nodeId: params.nodeId,
          operation: params.command,
        },
      });
      runtimeService.markActionAttempted(actionId, { retryable: true });
    }
    const ok = this.sendEventToSession(node, "node.invoke.request", payload);
    if (!ok) {
      if (actionId) {
        runtimeService.markActionFailed(actionId, {
          lastError: "failed to send invoke to node",
          retryable: true,
        });
      }
      return {
        ok: false,
        error: { code: "UNAVAILABLE", message: "failed to send invoke to node" },
      };
    }
    const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 30_000;
    return await new Promise<NodeInvokeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingInvokes.delete(requestId);
        if (actionId) {
          runtimeService.markActionFailed(actionId, {
            lastError: "node invoke timed out",
            retryable: true,
          });
        }
        resolve({
          ok: false,
          error: { code: "TIMEOUT", message: "node invoke timed out" },
        });
      }, timeoutMs);
      this.pendingInvokes.set(requestId, {
        nodeId: params.nodeId,
        command: params.command,
        ...(runtimeCheckpointId ? { runtimeCheckpointId } : {}),
        resolve,
        reject,
        timer,
      });
    });
  }

  handleInvokeResult(params: {
    id: string;
    nodeId: string;
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string | null;
    error?: { code?: string; message?: string } | null;
  }): boolean {
    const pending = this.pendingInvokes.get(params.id);
    if (!pending) {
      return false;
    }
    if (pending.nodeId !== params.nodeId) {
      return false;
    }
    clearTimeout(pending.timer);
    this.pendingInvokes.delete(params.id);
    if (pending.runtimeCheckpointId) {
      const checkpointService = getPlatformRuntimeCheckpointService();
      const actionId = `node-invoke:${pending.runtimeCheckpointId}`;
      const checkpoint = checkpointService.updateCheckpoint(pending.runtimeCheckpointId, {
        status: params.ok ? "completed" : "denied",
        completedAtMs: Date.now(),
      });
      if (params.ok) {
        checkpointService.markActionConfirmed(actionId, {
          receipt: {
            nodeId: params.nodeId,
            command: pending.command,
            operation: pending.command,
            nodeInvokeResult: {
              ok: params.ok,
              ...(params.payload !== undefined ? { payload: params.payload } : {}),
              payloadJSON: params.payloadJSON ?? null,
              error: params.error ?? null,
            },
          },
        });
      } else {
        checkpointService.markActionFailed(actionId, {
          lastError:
            params.error?.message ?? params.error?.code ?? "node invoke completed with an error",
          retryable: true,
          receipt: {
            nodeId: params.nodeId,
            command: pending.command,
            operation: pending.command,
            nodeInvokeResult: {
              ok: params.ok,
              ...(params.payload !== undefined ? { payload: params.payload } : {}),
              payloadJSON: params.payloadJSON ?? null,
              error: params.error ?? null,
            },
          },
        });
      }
      if (checkpoint) {
        registerAgentRunContext(checkpoint.runId, {
          ...(checkpoint.sessionKey ? { sessionKey: checkpoint.sessionKey } : {}),
          runtimeState: params.ok ? "completed" : "failed",
          runtimeCheckpointId: checkpoint.id,
          runtimeBoundary: checkpoint.boundary,
        });
        emitAgentEvent({
          runId: checkpoint.runId,
          stream: "lifecycle",
          ...(checkpoint.sessionKey ? { sessionKey: checkpoint.sessionKey } : {}),
          data: {
            phase: params.ok ? "end" : "error",
            checkpointId: checkpoint.id,
            boundary: checkpoint.boundary,
            endedAt: Date.now(),
            ...(params.ok
              ? {}
              : {
                  error:
                    params.error?.message ??
                    params.error?.code ??
                    "node invoke completed with an error",
                }),
          },
        });
      }
    }
    pending.resolve({
      ok: params.ok,
      payload: params.payload,
      payloadJSON: params.payloadJSON ?? null,
      error: params.error ?? null,
    });
    return true;
  }

  sendEvent(nodeId: string, event: string, payload?: unknown): boolean {
    const node = this.nodesById.get(nodeId);
    if (!node) {
      return false;
    }
    return this.sendEventToSession(node, event, payload);
  }

  private sendEventInternal(node: NodeSession, event: string, payload: unknown): boolean {
    try {
      node.client.socket.send(
        JSON.stringify({
          type: "event",
          event,
          payload,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  private sendEventToSession(node: NodeSession, event: string, payload: unknown): boolean {
    return this.sendEventInternal(node, event, payload);
  }
}
