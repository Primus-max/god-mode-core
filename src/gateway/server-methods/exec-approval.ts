import { emitAgentEvent, registerAgentRunContext } from "../../infra/agent-events.js";
import { sanitizeExecApprovalDisplayText } from "../../infra/exec-approval-command-display.js";
import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import {
  DEFAULT_EXEC_APPROVAL_TIMEOUT_MS,
  type ExecApprovalDecision,
} from "../../infra/exec-approvals.js";
import {
  buildSystemRunApprovalBinding,
  buildSystemRunApprovalEnvBinding,
} from "../../infra/system-run-approval-binding.js";
import { resolveSystemRunApprovalRequestContext } from "../../infra/system-run-approval-context.js";
import { getPlatformMachineControlService } from "../../platform/machine/index.js";
import { getPlatformRuntimeCheckpointService } from "../../platform/runtime/index.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateExecApprovalRequestParams,
  validateExecApprovalResolveParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function normalizeRuntimeBoundary(value: unknown, machineControlRequired: boolean): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return machineControlRequired ? "machine_control" : "exec_approval";
}

export function createExecApprovalHandlers(
  manager: ExecApprovalManager,
  opts?: { forwarder?: ExecApprovalForwarder },
): GatewayRequestHandlers {
  return {
    "exec.approval.request": async ({ params, respond, context, client }) => {
      if (!validateExecApprovalRequestParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid exec.approval.request params: ${formatValidationErrors(
              validateExecApprovalRequestParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = params as {
        id?: string;
        command: string;
        commandArgv?: string[];
        env?: Record<string, string>;
        cwd?: string;
        systemRunPlan?: unknown;
        nodeId?: string;
        host?: string;
        security?: string;
        ask?: string;
        agentId?: string;
        resolvedPath?: string;
        sessionKey?: string;
        turnSourceChannel?: string;
        turnSourceTo?: string;
        turnSourceAccountId?: string;
        turnSourceThreadId?: string | number;
        runtimeRunId?: string;
        runtimeCheckpointId?: string;
        runtimeBoundary?: string;
        blockedReason?: string;
        timeoutMs?: number;
        twoPhase?: boolean;
      };
      const twoPhase = p.twoPhase === true;
      const timeoutMs =
        typeof p.timeoutMs === "number" ? p.timeoutMs : DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;
      const explicitId = typeof p.id === "string" && p.id.trim().length > 0 ? p.id.trim() : null;
      const host = typeof p.host === "string" ? p.host.trim() : "";
      const nodeId = typeof p.nodeId === "string" ? p.nodeId.trim() : "";
      const approvalContext = resolveSystemRunApprovalRequestContext({
        host,
        command: p.command,
        commandArgv: p.commandArgv,
        systemRunPlan: p.systemRunPlan,
        cwd: p.cwd,
        agentId: p.agentId,
        sessionKey: p.sessionKey,
      });
      const effectiveCommandArgv = approvalContext.commandArgv;
      const effectiveCwd = approvalContext.cwd;
      const effectiveAgentId = approvalContext.agentId;
      const effectiveSessionKey = approvalContext.sessionKey;
      const effectiveCommandText = approvalContext.commandText;
      if (host === "node" && !nodeId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "nodeId is required for host=node"),
        );
        return;
      }
      if (host === "node" && !approvalContext.plan) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "systemRunPlan is required for host=node"),
        );
        return;
      }
      if (!effectiveCommandText) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "command is required"));
        return;
      }
      if (
        host === "node" &&
        (!Array.isArray(effectiveCommandArgv) || effectiveCommandArgv.length === 0)
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "commandArgv is required for host=node"),
        );
        return;
      }
      const machineControlAccess =
        host === "node"
          ? getPlatformMachineControlService().evaluateDeviceAccess(client?.connect?.device?.id)
          : null;
      if (machineControlAccess && !machineControlAccess.allowed) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, machineControlAccess.message),
        );
        return;
      }
      const envBinding = buildSystemRunApprovalEnvBinding(p.env);
      const systemRunBinding =
        host === "node"
          ? buildSystemRunApprovalBinding({
              argv: effectiveCommandArgv,
              cwd: effectiveCwd,
              agentId: effectiveAgentId,
              sessionKey: effectiveSessionKey,
              env: p.env,
            })
          : null;
      if (explicitId && manager.getSnapshot(explicitId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "approval id already pending"),
        );
        return;
      }
      const request = {
        command: sanitizeExecApprovalDisplayText(effectiveCommandText),
        commandPreview:
          host === "node" || !approvalContext.commandPreview
            ? undefined
            : sanitizeExecApprovalDisplayText(approvalContext.commandPreview),
        commandArgv: host === "node" ? undefined : effectiveCommandArgv,
        envKeys: envBinding.envKeys.length > 0 ? envBinding.envKeys : undefined,
        systemRunBinding: systemRunBinding?.binding ?? null,
        systemRunPlan: approvalContext.plan,
        cwd: effectiveCwd ?? null,
        nodeId: host === "node" ? nodeId : null,
        host: host || null,
        security: p.security ?? null,
        ask: p.ask ?? null,
        agentId: effectiveAgentId ?? null,
        resolvedPath: p.resolvedPath ?? null,
        sessionKey: effectiveSessionKey ?? null,
        turnSourceChannel:
          typeof p.turnSourceChannel === "string" ? p.turnSourceChannel.trim() || null : null,
        turnSourceTo: typeof p.turnSourceTo === "string" ? p.turnSourceTo.trim() || null : null,
        turnSourceAccountId:
          typeof p.turnSourceAccountId === "string" ? p.turnSourceAccountId.trim() || null : null,
        turnSourceThreadId: p.turnSourceThreadId ?? null,
        machineControl:
          host === "node"
            ? {
                required: true,
                requestedByDeviceId: client?.connect?.device?.id ?? null,
                linkedAtMs: machineControlAccess?.link?.linkedAtMs ?? null,
              }
            : null,
        runtimeRunId: typeof p.runtimeRunId === "string" ? p.runtimeRunId.trim() || null : null,
        runtimeCheckpointId:
          typeof p.runtimeCheckpointId === "string" ? p.runtimeCheckpointId.trim() || null : null,
        runtimeBoundary: normalizeRuntimeBoundary(p.runtimeBoundary, host === "node"),
        blockedReason:
          typeof p.blockedReason === "string"
            ? p.blockedReason.trim() || null
            : "approval required",
      };
      const record = manager.create(request, timeoutMs, explicitId);
      const runtimeRunId = request.runtimeRunId ?? record.id;
      const runtimeCheckpointService = getPlatformRuntimeCheckpointService();
      const checkpoint = runtimeCheckpointService.createCheckpoint({
        id: request.runtimeCheckpointId ?? record.id,
        runId: runtimeRunId,
        ...(request.sessionKey ? { sessionKey: request.sessionKey } : {}),
        boundary:
          request.runtimeBoundary === "machine_control" ? "machine_control" : "exec_approval",
        blockedReason: request.blockedReason ?? undefined,
        nextActions: [
          {
            method: "exec.approval.resolve",
            label: "Approve or deny exec request",
            phase: "approve",
          },
          {
            method: "exec.approval.waitDecision",
            label: "Inspect pending exec decision",
            phase: "inspect",
          },
        ],
        target: {
          approvalId: record.id,
          ...(request.nodeId ? { nodeId: request.nodeId } : {}),
          operation: "system.run",
        },
      });
      record.requestedByConnId = client?.connId ?? null;
      record.requestedByDeviceId = client?.connect?.device?.id ?? null;
      record.requestedByClientId = client?.connect?.client?.id ?? null;
      registerAgentRunContext(runtimeRunId, {
        ...(request.sessionKey ? { sessionKey: request.sessionKey } : {}),
        runtimeState: "blocked",
        runtimeCheckpointId: checkpoint.id,
        runtimeBoundary: checkpoint.boundary,
      });
      emitAgentEvent({
        runId: runtimeRunId,
        stream: "lifecycle",
        ...(request.sessionKey ? { sessionKey: request.sessionKey } : {}),
        data: {
          phase: "blocked",
          checkpointId: checkpoint.id,
          boundary: checkpoint.boundary,
          startedAt: record.createdAtMs,
          blockedReason: checkpoint.blockedReason,
        },
      });
      // Use register() to synchronously add to pending map before sending any response.
      // This ensures the approval ID is valid immediately after the "accepted" response.
      let decisionPromise: Promise<
        import("../../infra/exec-approvals.js").ExecApprovalDecision | null
      >;
      try {
        decisionPromise = manager.register(record, timeoutMs);
      } catch (err) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `registration failed: ${String(err)}`),
        );
        return;
      }
      context.broadcast(
        "exec.approval.requested",
        {
          id: record.id,
          request: record.request,
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
        },
        { dropIfSlow: true },
      );
      const hasExecApprovalClients = context.hasExecApprovalClients?.() ?? false;
      let forwarded = false;
      if (opts?.forwarder) {
        try {
          forwarded = await opts.forwarder.handleRequested({
            id: record.id,
            request: record.request,
            createdAtMs: record.createdAtMs,
            expiresAtMs: record.expiresAtMs,
          });
        } catch (err) {
          context.logGateway?.error?.(`exec approvals: forward request failed: ${String(err)}`);
        }
      }

      if (!hasExecApprovalClients && !forwarded) {
        manager.expire(record.id, "no-approval-route");
        respond(
          true,
          {
            id: record.id,
            decision: null,
            createdAtMs: record.createdAtMs,
            expiresAtMs: record.expiresAtMs,
          },
          undefined,
        );
        return;
      }

      // Only send immediate "accepted" response when twoPhase is requested.
      // This preserves single-response semantics for existing callers.
      if (twoPhase) {
        respond(
          true,
          {
            status: "accepted",
            id: record.id,
            createdAtMs: record.createdAtMs,
            expiresAtMs: record.expiresAtMs,
          },
          undefined,
        );
      }

      const decision = await decisionPromise;
      // Send final response with decision for callers using expectFinal:true.
      respond(
        true,
        {
          id: record.id,
          decision,
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
        },
        undefined,
      );
    },
    "exec.approval.waitDecision": async ({ params, respond }) => {
      const p = params as { id?: string };
      const id = typeof p.id === "string" ? p.id.trim() : "";
      if (!id) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
        return;
      }
      const decisionPromise = manager.awaitDecision(id);
      if (!decisionPromise) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "approval expired or not found"),
        );
        return;
      }
      // Capture snapshot before await (entry may be deleted after grace period)
      const snapshot = manager.getSnapshot(id);
      const decision = await decisionPromise;
      // Return decision (can be null on timeout) - let clients handle via askFallback
      respond(
        true,
        {
          id,
          decision,
          createdAtMs: snapshot?.createdAtMs,
          expiresAtMs: snapshot?.expiresAtMs,
        },
        undefined,
      );
    },
    "exec.approval.resolve": async ({ params, respond, client, context }) => {
      if (!validateExecApprovalResolveParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid exec.approval.resolve params: ${formatValidationErrors(
              validateExecApprovalResolveParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = params as { id: string; decision: string };
      const decision = p.decision as ExecApprovalDecision;
      if (decision !== "allow-once" && decision !== "allow-always" && decision !== "deny") {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid decision"));
        return;
      }
      const resolvedId = manager.lookupPendingId(p.id);
      if (resolvedId.kind === "none") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "unknown or expired approval id"),
        );
        return;
      }
      if (resolvedId.kind === "ambiguous") {
        const candidates = resolvedId.ids.slice(0, 3).join(", ");
        const remainder = resolvedId.ids.length > 3 ? ` (+${resolvedId.ids.length - 3} more)` : "";
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `ambiguous approval id prefix; matches: ${candidates}${remainder}. Use the full id.`,
          ),
        );
        return;
      }
      const approvalId = resolvedId.id;
      const snapshot = manager.getSnapshot(approvalId);
      const resolvedBy = client?.connect?.client?.displayName ?? client?.connect?.client?.id;
      const ok = manager.resolve(approvalId, decision, resolvedBy ?? null);
      if (!ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "unknown or expired approval id"),
        );
        return;
      }
      const runtimeRunId = snapshot?.request.runtimeRunId ?? approvalId;
      const runtimeCheckpointService = getPlatformRuntimeCheckpointService();
      const checkpoint = snapshot
        ? runtimeCheckpointService.updateCheckpoint(
            snapshot.request.runtimeCheckpointId ?? approvalId,
            {
              status: decision === "deny" ? "denied" : "approved",
              approvedAtMs: decision === "deny" ? undefined : Date.now(),
              completedAtMs: decision === "deny" ? Date.now() : undefined,
            },
          )
        : undefined;
      registerAgentRunContext(runtimeRunId, {
        ...(snapshot?.request.sessionKey ? { sessionKey: snapshot.request.sessionKey } : {}),
        runtimeState: decision === "deny" ? "failed" : "approved",
        runtimeCheckpointId: checkpoint?.id ?? snapshot?.request.runtimeCheckpointId ?? approvalId,
        runtimeBoundary: checkpoint?.boundary ?? snapshot?.request.runtimeBoundary ?? undefined,
      });
      emitAgentEvent({
        runId: runtimeRunId,
        stream: "lifecycle",
        ...(snapshot?.request.sessionKey ? { sessionKey: snapshot.request.sessionKey } : {}),
        data: {
          phase: decision === "deny" ? "error" : "approved",
          checkpointId: checkpoint?.id ?? snapshot?.request.runtimeCheckpointId ?? approvalId,
          boundary: checkpoint?.boundary ?? snapshot?.request.runtimeBoundary ?? undefined,
          ...(decision === "deny" ? { error: "approval denied by operator" } : {}),
        },
      });
      context.broadcast(
        "exec.approval.resolved",
        { id: approvalId, decision, resolvedBy, ts: Date.now(), request: snapshot?.request },
        { dropIfSlow: true },
      );
      void opts?.forwarder
        ?.handleResolved({
          id: approvalId,
          decision,
          resolvedBy,
          ts: Date.now(),
          request: snapshot?.request,
        })
        .catch((err) => {
          context.logGateway?.error?.(`exec approvals: forward resolve failed: ${String(err)}`);
        });
      respond(true, { ok: true }, undefined);
    },
  };
}
