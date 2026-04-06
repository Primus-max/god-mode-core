import { randomUUID } from "node:crypto";
import { resolveStateDir } from "../../config/paths.js";
import {
  emitAgentEvent,
  emitRuntimeRecoveryTelemetry,
  registerAgentRunContext,
} from "../../infra/agent-events.js";
import type { FollowupRun } from "../../auto-reply/reply/queue.js";
import { buildExecutionDecisionInput } from "../decision/input.js";
import type { PolicyContext } from "../policy/types.js";
import {
  buildPolicyContextFromExecutionContext,
  resolvePlatformRuntimePlan,
} from "../recipe/runtime-adapter.js";
import { createCapabilityRegistry } from "../registry/capability-registry.js";
import type { CapabilityRegistry } from "../registry/types.js";
import {
  getPlatformRuntimeCheckpointService,
  type PlatformRuntimeOperatorDecision,
} from "../runtime/index.js";
import type { CapabilityInstallMethod } from "../schemas/capability.js";
import { appendBootstrapAuditEvent, rehydrateBootstrapRequestRecords } from "./audit.js";
import {
  BootstrapAuditEventSchema,
  BootstrapRequestRecordDetailSchema,
  BootstrapRequestRecordSchema,
  BootstrapRequestRecordSummarySchema,
  type BootstrapOrchestrationResult,
  type BootstrapAuditEventType,
  type BootstrapBlockedRunResume,
  type BootstrapRequest,
  type BootstrapRequestDecision,
  type BootstrapRequestRecord,
  type BootstrapRequestRecordDetail,
  type BootstrapRequestRecordSummary,
} from "./contracts.js";
import { TRUSTED_CAPABILITY_CATALOG } from "./defaults.js";
import type { BootstrapInstaller } from "./installers.js";
import { orchestrateBootstrapRequest } from "./orchestrator.js";
import { resolveBootstrapAuditPath } from "./paths.js";

export type BootstrapRequestService = {
  configure: (params: { stateDir?: string }) => void;
  getAuditPath: () => string | null;
  create: (request: BootstrapRequest) => BootstrapRequestRecord;
  list: () => BootstrapRequestRecordSummary[];
  get: (id: string) => BootstrapRequestRecordDetail | undefined;
  resolve: (
    id: string,
    decision: BootstrapRequestDecision,
    opts?: { operatorDecision?: PlatformRuntimeOperatorDecision },
  ) => BootstrapRequestRecordDetail | undefined;
  run: (params: {
    id: string;
    operatorDecision?: PlatformRuntimeOperatorDecision;
    installers?: Partial<Record<CapabilityInstallMethod, BootstrapInstaller>>;
    availableBins?: string[];
    availableEnv?: string[];
    runHealthCheckCommand?: (command: string) => Promise<boolean> | boolean;
  }) => Promise<BootstrapRequestRecordDetail | undefined>;
  rehydrate: () => number;
  pendingCount: () => number;
  reset: () => void;
};

function toSummary(record: BootstrapRequestRecord): BootstrapRequestRecordSummary {
  return BootstrapRequestRecordSummarySchema.parse({
    id: record.id,
    capabilityId: record.request.capabilityId,
    installMethod: record.request.installMethod,
    reason: record.request.reason,
    sourceDomain: record.request.sourceDomain,
    ...(record.request.sourceRecipeId ? { sourceRecipeId: record.request.sourceRecipeId } : {}),
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.result ? { lastResultStatus: record.result.status } : {}),
    hasResult: Boolean(record.result),
    ...(record.reasons?.[0] ? { lastError: record.reasons[0] } : {}),
  });
}

function appendAuditRecord(
  stateDir: string | undefined,
  type: BootstrapAuditEventType,
  record: BootstrapRequestRecord,
): void {
  appendBootstrapAuditEvent(
    stateDir,
    BootstrapAuditEventSchema.parse({
      version: 1,
      ts: record.updatedAt,
      requestId: record.id,
      type,
      record,
    }),
  );
}

function buildRecordSignature(request: BootstrapRequest): string {
  return [
    request.capabilityId,
    request.installMethod,
    request.reason,
    request.sourceDomain,
    request.sourceRecipeId ?? "",
    request.blockedRunResume?.blockedRunId ?? "",
  ].join("::");
}

async function dispatchBlockedRunResumeAfterBootstrap(params: {
  bootstrapRequestId: string;
  capabilityId: string;
  resume: BootstrapBlockedRunResume;
}): Promise<boolean> {
  const { enqueueFollowupRun, scheduleFollowupDrain } = await import(
    "../../auto-reply/reply/queue.js"
  );
  const [{ createFollowupRunner }, { createTypingController }] = await Promise.all([
    import("../../auto-reply/reply/followup-runner.js"),
    import("../../auto-reply/reply/typing.js"),
  ]);
  const runFollowup = createFollowupRunner({
    typing: createTypingController({}),
    typingMode: "never",
    queueKey: params.resume.queueKey,
    resolvedQueue: params.resume.settings,
    defaultModel: params.resume.sourceRun.run.model,
  });
  const resumeLead = `Capability "${params.capabilityId}" was installed and verified. Continue the interrupted task from the approved bootstrap; do not ask for another bootstrap for this capability.\n\n`;
  const sessionKey = params.resume.sourceRun.run.sessionKey ?? params.resume.sessionKey;
  const followupRun: FollowupRun = {
    ...(params.resume.sourceRun as FollowupRun),
    prompt: `${resumeLead}${params.resume.sourceRun.prompt}`,
    enqueuedAt: Date.now(),
    requestRunId: params.resume.sourceRun.requestRunId ?? params.resume.blockedRunId,
    parentRunId: params.resume.blockedRunId,
    automation: {
      source: "closure_recovery",
      retryCount: params.resume.sourceRun.automation?.retryCount ?? 0,
      persisted: true,
      runtimeCheckpointId: params.bootstrapRequestId,
      reasonCode: "bootstrap_install_verified",
      reasonSummary: `Resumed after bootstrap ${params.bootstrapRequestId} (${params.capabilityId})`,
    },
  };
  const enqueued = enqueueFollowupRun(
    params.resume.queueKey,
    followupRun,
    params.resume.settings,
    "prompt",
  );
  scheduleFollowupDrain(params.resume.queueKey, runFollowup);
  registerAgentRunContext(params.resume.blockedRunId, {
    ...(sessionKey ? { sessionKey } : {}),
    runtimeState: "resumed",
    runtimeCheckpointId: params.bootstrapRequestId,
    runtimeBoundary: "bootstrap",
  });
  emitAgentEvent({
    runId: params.resume.blockedRunId,
    ...(sessionKey ? { sessionKey } : {}),
    stream: "lifecycle",
    data: {
      phase: "resumed",
      checkpointId: params.bootstrapRequestId,
      boundary: "bootstrap",
      detail: "blocked followup re-queued after bootstrap",
    },
  });
  if (enqueued) {
    emitRuntimeRecoveryTelemetry({
      runId: params.resume.blockedRunId,
      ...(sessionKey ? { sessionKey } : {}),
      milestone: "followup_enqueued",
      checkpointId: params.bootstrapRequestId,
      continuationKind: "bootstrap_run",
      queueKey: params.resume.queueKey,
    });
    return true;
  }
  emitRuntimeRecoveryTelemetry({
    runId: params.resume.blockedRunId,
    ...(sessionKey ? { sessionKey } : {}),
    milestone: "continuation_dispatch_failed",
    checkpointId: params.bootstrapRequestId,
    continuationKind: "bootstrap_run",
    error: "followup queue rejected duplicate or drop policy skipped resume",
    queueKey: params.resume.queueKey,
  });
  return false;
}

function resolveBootstrapRunActionId(requestId: string): string {
  return `bootstrap:${requestId}:run`;
}

function resolveBootstrapDecisionPrompt(request: BootstrapRequest): string {
  if (request.sourceDomain === "document") {
    return `Bootstrap capability ${request.capabilityId} for document processing workflow.`;
  }
  if (request.sourceDomain === "developer") {
    return `Bootstrap capability ${request.capabilityId} for repository build and delivery workflow.`;
  }
  return `Bootstrap capability ${request.capabilityId} for platform execution workflow.`;
}

function buildBootstrapPolicyContext(
  request: BootstrapRequest,
  explicitApproval: boolean,
): PolicyContext {
  if (request.executionContext) {
    const fromDecision = buildPolicyContextFromExecutionContext(request.executionContext, {
      explicitApproval,
    });
    if (fromDecision) {
      return {
        ...fromDecision,
        requestedCapabilities: Array.from(
          new Set([...(fromDecision.requestedCapabilities ?? []), request.capabilityId]),
        ),
        requestedToolNames: Array.from(
          new Set([
            ...(fromDecision.requestedToolNames ?? []),
            ...(request.installMethod === "builtin" ? [] : ["exec", "process"]),
          ]),
        ),
      };
    }
  }
  const intent =
    request.sourceDomain === "document"
      ? "document"
      : request.sourceDomain === "developer"
        ? "code"
        : "general";
  const requestedTools = request.installMethod === "builtin" ? [] : ["exec", "process"];
  const resolved = resolvePlatformRuntimePlan(
    buildExecutionDecisionInput({
      prompt: resolveBootstrapDecisionPrompt(request),
      intent,
      requestedTools,
    }),
    { explicitApproval },
  );
  return {
    ...resolved.policyContext,
    explicitApproval,
    requestedCapabilities: Array.from(
      new Set([...(resolved.policyContext.requestedCapabilities ?? []), request.capabilityId]),
    ),
    requestedToolNames: Array.from(
      new Set([...(resolved.policyContext.requestedToolNames ?? []), ...requestedTools]),
    ),
  };
}

function shouldAutoContinueBootstrapRequest(request: BootstrapRequest): boolean {
  if (
    request.executionContext?.unattendedBoundary !== "bootstrap" ||
    request.executionContext.policyAutonomy !== "assist"
  ) {
    return false;
  }
  if (!request.catalogEntry.capability.trusted) {
    return false;
  }
  return request.sourceDomain === "document" || request.sourceDomain === "developer";
}

export function createBootstrapRequestService(params?: {
  registry?: CapabilityRegistry;
  stateDir?: string;
}): BootstrapRequestService {
  const records = new Map<string, BootstrapRequestRecord>();
  const registry = params?.registry ?? createCapabilityRegistry([], TRUSTED_CAPABILITY_CATALOG);
  let stateDir = params?.stateDir;
  const runtimeCheckpointService = getPlatformRuntimeCheckpointService(
    params?.stateDir ? { stateDir: params.stateDir } : undefined,
  );
  const service: BootstrapRequestService = {
    configure(config) {
      if (config.stateDir) {
        stateDir = config.stateDir;
        runtimeCheckpointService.configure({ stateDir: config.stateDir });
      }
    },
    getAuditPath() {
      return stateDir ? resolveBootstrapAuditPath(stateDir) : null;
    },
    create(request) {
      const now = new Date().toISOString();
      const normalizedRequest = request;
      const signature = buildRecordSignature(normalizedRequest);
      const existing = Array.from(records.values()).find((record) => {
        return (
          buildRecordSignature(record.request) === signature &&
          (record.state === "pending" || record.state === "approved" || record.state === "running")
        );
      });
      if (existing) {
        const updated = BootstrapRequestRecordSchema.parse({
          ...existing,
          updatedAt: now,
        });
        records.set(updated.id, updated);
        return updated;
      }
      const record = BootstrapRequestRecordSchema.parse({
        id: randomUUID(),
        state: "pending",
        request: normalizedRequest,
        createdAt: now,
        updatedAt: now,
      });
      records.set(record.id, record);
      runtimeCheckpointService.createCheckpoint({
        id: record.id,
        runId: record.id,
        boundary: "bootstrap",
        blockedReason:
          "Bootstrap checkpoint: capability install is blocked until the operator approves (platform.bootstrap.resolve) and runs install/verify (platform.bootstrap.run).",
        nextActions: [
          {
            method: "platform.bootstrap.resolve",
            label: "Approve or deny capability bootstrap (install) request",
            phase: "approve",
          },
          {
            method: "platform.bootstrap.run",
            label: "Execute approved install, health verification, and resume blocked work if configured",
            phase: "resume",
          },
        ],
        target: {
          bootstrapRequestId: record.id,
          operation: "bootstrap.run",
        },
        continuation: {
          kind: "bootstrap_run",
          ...(shouldAutoContinueBootstrapRequest(record.request) ? { autoDispatch: true } : {}),
          state: "idle",
          attempts: 0,
          ...(record.request.blockedRunResume
            ? {
                input: {
                  blockedRunResume: true,
                  blockedRunId: record.request.blockedRunResume.blockedRunId,
                  queueKey: record.request.blockedRunResume.queueKey,
                },
              }
            : {}),
        },
        executionContext: record.request.executionContext,
      });
      appendAuditRecord(stateDir, "request.created", record);
      if (shouldAutoContinueBootstrapRequest(record.request)) {
        const approved = BootstrapRequestRecordSchema.parse({
          ...record,
          state: "approved",
          updatedAt: now,
          resolvedAt: now,
        });
        records.set(record.id, approved);
        runtimeCheckpointService.updateCheckpoint(record.id, {
          status: "approved",
          approvedAtMs: Date.now(),
        });
        appendAuditRecord(stateDir, "request.approved", approved);
        void runtimeCheckpointService.dispatchContinuation(record.id);
        return approved;
      }
      return record;
    },
    list() {
      return Array.from(records.values())
        .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((record) => toSummary(record));
    },
    get(id) {
      const record = records.get(id);
      return record ? BootstrapRequestRecordDetailSchema.parse(record) : undefined;
    },
    resolve(id, decision, opts) {
      const existing = records.get(id);
      if (!existing) {
        return undefined;
      }
      const now = new Date().toISOString();
      const updated = BootstrapRequestRecordSchema.parse({
        ...existing,
        state: decision === "approve" ? "approved" : "denied",
        updatedAt: now,
        resolvedAt: now,
        ...(decision === "deny"
          ? { reasons: ["operator denied bootstrap request"] }
          : { reasons: existing.reasons }),
      });
      records.set(id, updated);
      runtimeCheckpointService.updateCheckpoint(id, {
        status: decision === "approve" ? "approved" : "denied",
        approvedAtMs: decision === "approve" ? Date.now() : undefined,
        completedAtMs: decision === "deny" ? Date.now() : undefined,
        lastOperatorDecision: opts?.operatorDecision,
      });
      appendAuditRecord(
        stateDir,
        decision === "approve" ? "request.approved" : "request.denied",
        updated,
      );
      if (decision === "approve") {
        void runtimeCheckpointService.dispatchContinuation(id);
      }
      return BootstrapRequestRecordDetailSchema.parse(updated);
    },
    async run(runParams) {
      const existing = records.get(runParams.id);
      if (!existing) {
        return undefined;
      }
      const actionId = resolveBootstrapRunActionId(runParams.id);
      const existingAction = runtimeCheckpointService.getAction(actionId);
      if (existingAction?.state === "confirmed") {
        runtimeCheckpointService.updateCheckpoint(runParams.id, {
          status: "completed",
          completedAtMs: existingAction.confirmedAtMs ?? Date.now(),
          lastOperatorDecision: runParams.operatorDecision,
        });
        return BootstrapRequestRecordDetailSchema.parse(existing);
      }
      if (existing.state !== "approved") {
        const blocked = BootstrapRequestRecordSchema.parse({
          ...existing,
          updatedAt: new Date().toISOString(),
          reasons: [
            `Bootstrap run is blocked: request state is "${existing.state}"; operator must approve via platform.bootstrap.resolve before platform.bootstrap.run.`,
          ],
        });
        records.set(blocked.id, blocked);
        appendAuditRecord(stateDir, "request.run_blocked", blocked);
        return BootstrapRequestRecordDetailSchema.parse(blocked);
      }
      runtimeCheckpointService.stageAction({
        actionId,
        runId: existing.id,
        kind: "bootstrap",
        boundary: "bootstrap",
        checkpointId: existing.id,
        ...(runParams.operatorDecision
          ? {
              receipt: {
                operatorDecision: runParams.operatorDecision,
              },
            }
          : {}),
        target: {
          bootstrapRequestId: existing.id,
          operation: "bootstrap.run",
        },
      });
      const startedAt = new Date().toISOString();
      const running = BootstrapRequestRecordSchema.parse({
        ...existing,
        state: "running",
        updatedAt: startedAt,
        startedAt,
      });
      records.set(running.id, running);
      runtimeCheckpointService.updateCheckpoint(running.id, {
        status: "resumed",
        resumedAtMs: Date.now(),
        lastOperatorDecision: runParams.operatorDecision,
      });
      runtimeCheckpointService.markActionAttempted(actionId, { retryable: true });
      appendAuditRecord(stateDir, "request.started", running);
      let result: BootstrapOrchestrationResult;
      try {
        const policyContext = buildBootstrapPolicyContext(running.request, true);
        result = await orchestrateBootstrapRequest({
          request: running.request,
          policyContext,
          registry,
          stateDir,
          installers: runParams.installers,
          availableBins: runParams.availableBins,
          availableEnv: runParams.availableEnv,
          runHealthCheckCommand: runParams.runHealthCheckCommand,
        });
      } catch (error) {
        runtimeCheckpointService.markActionFailed(actionId, {
          lastError: error instanceof Error ? error.message : String(error),
          retryable: true,
          receipt: {
            bootstrapRequestId: running.id,
            capabilityId: running.request.capabilityId,
            operation: "bootstrap.run",
          },
        });
        throw error;
      }
      const completedAt = new Date().toISOString();
      const nextState = result.status === "bootstrapped" ? "available" : "degraded";
      const updated = BootstrapRequestRecordSchema.parse({
        ...running,
        state: nextState,
        updatedAt: completedAt,
        completedAt,
        result,
        reasons: result.reasons,
      });
      records.set(updated.id, updated);
      runtimeCheckpointService.updateCheckpoint(updated.id, {
        status: result.status === "bootstrapped" ? "completed" : "denied",
        completedAtMs: Date.now(),
      });
      if (result.status === "bootstrapped") {
        runtimeCheckpointService.markActionConfirmed(actionId, {
          receipt: {
            bootstrapRequestId: updated.id,
            capabilityId: updated.request.capabilityId,
            operation: "bootstrap.run",
            resultStatus: result.status,
          },
        });
      } else {
        runtimeCheckpointService.markActionFailed(actionId, {
          lastError: result.reasons?.[0] ?? "bootstrap degraded",
          retryable: true,
          receipt: {
            bootstrapRequestId: updated.id,
            capabilityId: updated.request.capabilityId,
            operation: "bootstrap.run",
            resultStatus: result.status,
          },
        });
      }
      appendAuditRecord(
        stateDir,
        result.status === "bootstrapped" ? "request.available" : "request.degraded",
        updated,
      );
      if (result.lifecycle?.rollbackStatus && result.lifecycle.rollbackStatus !== "not_needed") {
        appendAuditRecord(stateDir, "request.rolled_back", updated);
      }
      if (result.status === "bootstrapped" && running.request.blockedRunResume) {
        try {
          const resumeOk = await dispatchBlockedRunResumeAfterBootstrap({
            bootstrapRequestId: updated.id,
            capabilityId: updated.request.capabilityId,
            resume: running.request.blockedRunResume,
          });
          const resumeAuditRecord = BootstrapRequestRecordSchema.parse({
            ...updated,
            ...(resumeOk
              ? {}
              : {
                  reasons: [
                    ...(updated.reasons ?? []),
                    "Blocked task resume was not enqueued (duplicate prompt or queue drop policy).",
                  ],
                }),
          });
          if (!resumeOk) {
            records.set(updated.id, resumeAuditRecord);
          }
          appendAuditRecord(
            stateDir,
            resumeOk ? "request.resume_enqueued" : "request.resume_enqueue_failed",
            resumeAuditRecord,
          );
        } catch (error) {
          const failedResume = BootstrapRequestRecordSchema.parse({
            ...updated,
            reasons: [
              ...(updated.reasons ?? []),
              `Blocked task resume dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
            ],
          });
          records.set(updated.id, failedResume);
          appendAuditRecord(stateDir, "request.resume_enqueue_failed", failedResume);
        }
      }
      return BootstrapRequestRecordDetailSchema.parse(records.get(updated.id) ?? updated);
    },
    rehydrate() {
      records.clear();
      for (const record of rehydrateBootstrapRequestRecords(stateDir)) {
        records.set(record.id, BootstrapRequestRecordSchema.parse(record));
      }
      return records.size;
    },
    pendingCount() {
      return Array.from(records.values()).filter((record) => record.state === "pending").length;
    },
    reset() {
      records.clear();
    },
  };
  runtimeCheckpointService.registerContinuationHandler("bootstrap_run", async (checkpoint) => {
    const requestId = checkpoint.target?.bootstrapRequestId;
    if (!requestId) {
      return;
    }
    await service.run({ id: requestId });
  });
  return service;
}

let sharedBootstrapRequestService: BootstrapRequestService | null = null;

export function getPlatformBootstrapService(config?: {
  stateDir?: string;
  registry?: CapabilityRegistry;
}): BootstrapRequestService {
  if (!sharedBootstrapRequestService) {
    sharedBootstrapRequestService = createBootstrapRequestService({
      stateDir: config?.stateDir ?? resolveStateDir(process.env),
      registry: config?.registry,
    });
  } else if (config) {
    sharedBootstrapRequestService.configure(config);
  }
  return sharedBootstrapRequestService;
}

export function resetPlatformBootstrapService(): void {
  sharedBootstrapRequestService?.reset();
  sharedBootstrapRequestService = null;
}

export type { BootstrapOrchestrationResult };
