import { z } from "zod";
import { getSharedExecApprovalManager } from "../../gateway/exec-approval-manager.js";
import {
  emitAgentEvent,
  emitRuntimeRecoveryTelemetry,
  registerAgentRunContext,
} from "../../infra/agent-events.js";
import { DEFAULT_EXEC_APPROVAL_TIMEOUT_MS } from "../../infra/exec-approvals.js";
import {
  BootstrapBlockedRunResumeSchema,
  TRUSTED_CAPABILITY_CATALOG,
  getPlatformBootstrapService,
  resolveBootstrapRequests,
  type BootstrapReason,
  type BootstrapRequest,
  type BootstrapSourceDomain,
} from "../../platform/bootstrap/index.js";
import type {
  PlatformExecutionContextModelRouteTier,
  PlatformExecutionContextSnapshot,
} from "../../platform/decision/contracts.js";
import { inferLocalRoutingEligibleFromPlannerInput } from "../../platform/decision/route-preflight.js";
import { createCapabilityRegistry } from "../../platform/registry/capability-registry.js";
import {
  getPlatformRuntimeCheckpointService,
  type PlatformRuntimeAcceptanceResult,
  type PlatformRuntimeExecutionIntent,
  type PlatformRuntimeRunOutcome,
  type PlatformRuntimeSupervisorVerdict,
} from "../../platform/runtime/index.js";
import {
  enqueueFollowupRun,
  scheduleFollowupDrain,
  type FollowupRun,
  type QueueSettings,
} from "./queue.js";

type MessagingClosureDecision = PlatformRuntimeAcceptanceResult | PlatformRuntimeSupervisorVerdict;

const QueueSettingsSchema = z
  .object({
    mode: z.enum(["steer", "followup", "collect", "steer-backlog", "interrupt", "queue"]),
    debounceMs: z.number().int().nonnegative().optional(),
    cap: z.number().int().positive().optional(),
    dropPolicy: z.enum(["old", "new", "summarize"]).optional(),
  })
  .strict();

const FollowupAutomationMetadataSchema = z
  .object({
    source: z.enum(["acceptance_retry", "closure_recovery"]),
    retryCount: z.number().int().nonnegative(),
    persisted: z.boolean().optional(),
    runtimeCheckpointId: z.string().min(1).optional(),
    reasonCode: z.string().min(1).optional(),
    reasonSummary: z.string().min(1).optional(),
  })
  .strict();

const FollowupRunSnapshotSchema = z
  .object({
    prompt: z.string(),
    messageId: z.string().min(1).optional(),
    summaryLine: z.string().min(1).optional(),
    enqueuedAt: z.number().int().nonnegative(),
    requestRunId: z.string().min(1).optional(),
    parentRunId: z.string().min(1).optional(),
    automation: FollowupAutomationMetadataSchema.optional(),
    originatingChannel: z.string().min(1).optional(),
    originatingTo: z.string().min(1).optional(),
    originatingAccountId: z.string().min(1).optional(),
    originatingThreadId: z.union([z.string().min(1), z.number().int()]).optional(),
    originatingChatType: z.string().min(1).optional(),
    run: z
      .object({
        agentId: z.string().min(1),
        agentDir: z.string().min(1),
        sessionId: z.string().min(1),
        sessionKey: z.string().min(1).optional(),
        messageProvider: z.string().min(1).optional(),
        agentAccountId: z.string().min(1).optional(),
        groupId: z.string().min(1).optional(),
        groupChannel: z.string().min(1).optional(),
        groupSpace: z.string().min(1).optional(),
        senderId: z.string().min(1).optional(),
        senderName: z.string().min(1).optional(),
        senderUsername: z.string().min(1).optional(),
        senderE164: z.string().min(1).optional(),
        senderIsOwner: z.boolean().optional(),
        sessionFile: z.string().min(1),
        workspaceDir: z.string().min(1),
        config: z.record(z.string(), z.unknown()),
        skillsSnapshot: z.unknown().optional(),
        provider: z.string().min(1),
        model: z.string().min(1),
        authProfileId: z.string().min(1).optional(),
        authProfileIdSource: z.enum(["auto", "user"]).optional(),
        thinkLevel: z.string().min(1).optional(),
        verboseLevel: z.string().min(1).optional(),
        reasoningLevel: z.string().min(1).optional(),
        elevatedLevel: z.string().min(1).optional(),
        execOverrides: z
          .object({
            host: z.string().min(1).optional(),
            security: z.string().min(1).optional(),
            ask: z.string().min(1).optional(),
            node: z.string().min(1).optional(),
          })
          .strict()
          .optional(),
        bashElevated: z
          .object({
            enabled: z.boolean(),
            allowed: z.boolean(),
            defaultLevel: z.string().min(1),
          })
          .strict()
          .optional(),
        timeoutMs: z.number().int().positive(),
        blockReplyBreak: z.enum(["text_end", "message_end"]),
        ownerNumbers: z.array(z.string().min(1)).optional(),
        inputProvenance: z.unknown().optional(),
        extraSystemPrompt: z.string().min(1).optional(),
        enforceFinalTag: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

const ClosureRecoveryContinuationPayloadSchema = z
  .object({
    queueKey: z.string().min(1),
    settings: QueueSettingsSchema,
    sourceRun: FollowupRunSnapshotSchema,
  })
  .strict();

type ClosureRecoveryContinuationPayload = {
  queueKey: string;
  settings: QueueSettings;
  sourceRun: FollowupRun;
};

export type MessagingClosureOutcomeDispatchResult = {
  queuedSemanticRetry: boolean;
  approvalId?: string;
  bootstrapRequestIds?: string[];
};

export type ClosureRecoveryStartupReconcileResult = {
  restoredApprovalCount: number;
  redispatchedContinuationCount: number;
  staleCheckpointCount: number;
};

const CLOSURE_APPROVAL_TIMEOUT_MS = Math.max(DEFAULT_EXEC_APPROVAL_TIMEOUT_MS, 24 * 60 * 60 * 1000);

function isClosureRecoveryCheckpoint(checkpoint: {
  target?: { operation?: string };
  continuation?: { kind?: string };
}): boolean {
  return (
    checkpoint.target?.operation === "closure.recovery" &&
    checkpoint.continuation?.kind === "closure_recovery"
  );
}

function buildClosureApprovalRequestPayload(params: {
  approvalId: string;
  blockedReason: string;
  runId: string;
  sourceRun: FollowupRun;
}) {
  return {
    command: `Review closure outcome for run ${params.runId}`,
    commandPreview: params.blockedReason,
    cwd: params.sourceRun.run.workspaceDir,
    host: "gateway",
    security: "deny",
    ask: "always",
    agentId: params.sourceRun.run.agentId,
    sessionKey: params.sourceRun.run.sessionKey ?? null,
    turnSourceChannel:
      params.sourceRun.originatingChannel ?? params.sourceRun.run.messageProvider ?? null,
    turnSourceTo: params.sourceRun.originatingTo ?? null,
    turnSourceAccountId:
      params.sourceRun.originatingAccountId ?? params.sourceRun.run.agentAccountId ?? null,
    turnSourceThreadId: params.sourceRun.originatingThreadId ?? null,
    runtimeRunId: params.runId,
    runtimeCheckpointId: params.approvalId,
    runtimeBoundary: "exec_approval",
    blockedReason: params.blockedReason,
  };
}

function buildClosureRecoveryContinuationPayload(params: {
  queueKey?: string;
  settings: QueueSettings;
  sourceRun: FollowupRun;
}): ClosureRecoveryContinuationPayload | undefined {
  const queueKey = params.queueKey?.trim();
  if (!queueKey) {
    return undefined;
  }
  return ClosureRecoveryContinuationPayloadSchema.parse({
    queueKey,
    settings: params.settings,
    sourceRun: params.sourceRun,
  }) as ClosureRecoveryContinuationPayload;
}

function parseClosureRecoveryContinuationPayload(
  input: unknown,
): ClosureRecoveryContinuationPayload | undefined {
  const parsed = ClosureRecoveryContinuationPayloadSchema.safeParse(input);
  return parsed.success ? (parsed.data as ClosureRecoveryContinuationPayload) : undefined;
}

async function dispatchClosureRecoveryContinuation(
  checkpointId: string,
  payload: ClosureRecoveryContinuationPayload,
): Promise<void> {
  const checkpoint = getPlatformRuntimeCheckpointService().get(checkpointId);
  const queued = enqueueFollowupRun(
    payload.queueKey,
    {
      ...payload.sourceRun,
      enqueuedAt: Date.now(),
      requestRunId: payload.sourceRun.requestRunId ?? checkpoint?.runId,
      parentRunId: checkpoint?.runId ?? payload.sourceRun.parentRunId,
      automation: {
        source: "closure_recovery",
        retryCount: payload.sourceRun.automation?.retryCount ?? 0,
        persisted: true,
        runtimeCheckpointId: checkpointId,
        ...(payload.sourceRun.automation?.reasonCode
          ? { reasonCode: payload.sourceRun.automation.reasonCode }
          : {}),
        ...(payload.sourceRun.automation?.reasonSummary
          ? { reasonSummary: payload.sourceRun.automation.reasonSummary }
          : {}),
      },
    },
    payload.settings,
    "prompt",
  );
  const [{ createFollowupRunner }, { createTypingController }] = await Promise.all([
    import("./followup-runner.js"),
    import("./typing.js"),
  ]);
  const runFollowup = createFollowupRunner({
    typing: createTypingController({}),
    typingMode: "never",
    queueKey: payload.queueKey,
    resolvedQueue: payload.settings,
    defaultModel: payload.sourceRun.run.model,
  });
  scheduleFollowupDrain(payload.queueKey, runFollowup);
  if (queued) {
    const cp = getPlatformRuntimeCheckpointService().get(checkpointId);
    if (cp?.runId) {
      emitRuntimeRecoveryTelemetry({
        runId: cp.runId,
        ...(cp.sessionKey ? { sessionKey: cp.sessionKey } : {}),
        milestone: "followup_enqueued",
        checkpointId,
        continuationKind: "closure_recovery",
        ...(cp.target?.approvalId ? { approvalId: cp.target.approvalId } : {}),
        queueKey: payload.queueKey,
      });
    }
  }
}

function resolveClosureRecoveryCheckpointId(run: FollowupRun): string | undefined {
  const checkpointId = run.automation?.runtimeCheckpointId?.trim();
  return checkpointId ? checkpointId : undefined;
}

function resolveClosureRecoveryTerminalMessage(
  decision: MessagingClosureDecision | undefined,
  fallback: string,
): string {
  if (!decision) {
    return fallback;
  }
  return decision.reasons[0] ?? `${decision.action}:${decision.remediation}`;
}

export function markClosureRecoveryCheckpointFailed(params: {
  sourceRun?: FollowupRun;
  checkpointId?: string;
  error: string;
}): void {
  const checkpointId =
    params.checkpointId ??
    (params.sourceRun ? resolveClosureRecoveryCheckpointId(params.sourceRun) : undefined);
  if (!checkpointId) {
    return;
  }
  const runtimeCheckpointService = getPlatformRuntimeCheckpointService();
  const checkpoint = runtimeCheckpointService.get(checkpointId);
  if (!checkpoint || !isClosureRecoveryCheckpoint(checkpoint)) {
    return;
  }
  const now = Date.now();
  runtimeCheckpointService.updateCheckpoint(checkpointId, {
    status: "cancelled",
    completedAtMs: now,
    continuation: {
      ...(checkpoint.continuation ?? { kind: "closure_recovery" }),
      state: "failed",
      lastError: params.error,
      lastCompletedAtMs: now,
    },
  });
  emitRuntimeRecoveryTelemetry({
    runId: checkpoint.runId,
    ...(checkpoint.sessionKey ? { sessionKey: checkpoint.sessionKey } : {}),
    milestone: "recovery_checkpoint_terminal",
    checkpointId,
    continuationKind: "closure_recovery",
    terminalStatus: "cancelled",
    continuationState: "failed",
    error: params.error,
    ...(checkpoint.target?.approvalId ? { approvalId: checkpoint.target.approvalId } : {}),
  });
}

export function finalizeClosureRecoveryCheckpoint(params: {
  sourceRun: FollowupRun;
  acceptance: PlatformRuntimeAcceptanceResult | undefined;
  supervisorVerdict?: PlatformRuntimeSupervisorVerdict;
  queuedSemanticRetry: boolean;
}): void {
  const checkpointId = resolveClosureRecoveryCheckpointId(params.sourceRun);
  if (!checkpointId) {
    return;
  }
  const runtimeCheckpointService = getPlatformRuntimeCheckpointService();
  const checkpoint = runtimeCheckpointService.get(checkpointId);
  if (!checkpoint || !isClosureRecoveryCheckpoint(checkpoint)) {
    return;
  }

  if (params.queuedSemanticRetry) {
    runtimeCheckpointService.updateCheckpoint(checkpointId, {
      status: "resumed",
      continuation: {
        ...(checkpoint.continuation ?? { kind: "closure_recovery" }),
        state: "idle",
        lastError: undefined,
      },
    });
    emitRuntimeRecoveryTelemetry({
      runId: checkpoint.runId,
      ...(checkpoint.sessionKey ? { sessionKey: checkpoint.sessionKey } : {}),
      milestone: "recovery_checkpoint_resumed",
      checkpointId,
      continuationKind: "closure_recovery",
      terminalStatus: "resumed",
      continuationState: "idle",
      ...(checkpoint.target?.approvalId ? { approvalId: checkpoint.target.approvalId } : {}),
    });
    return;
  }

  const decision = params.supervisorVerdict ?? params.acceptance;
  const now = Date.now();
  if (decision?.action === "close") {
    runtimeCheckpointService.updateCheckpoint(checkpointId, {
      status: "completed",
      completedAtMs: now,
      continuation: {
        ...(checkpoint.continuation ?? { kind: "closure_recovery" }),
        state: "completed",
        lastError: undefined,
        lastCompletedAtMs: now,
      },
    });
    emitRuntimeRecoveryTelemetry({
      runId: checkpoint.runId,
      ...(checkpoint.sessionKey ? { sessionKey: checkpoint.sessionKey } : {}),
      milestone: "recovery_checkpoint_terminal",
      checkpointId,
      continuationKind: "closure_recovery",
      terminalStatus: "completed",
      continuationState: "completed",
      ...(checkpoint.target?.approvalId ? { approvalId: checkpoint.target.approvalId } : {}),
    });
    return;
  }

  const failMessage = resolveClosureRecoveryTerminalMessage(
    decision,
    "closure recovery finished without a terminal outcome",
  );
  runtimeCheckpointService.updateCheckpoint(checkpointId, {
    status: "cancelled",
    completedAtMs: now,
    continuation: {
      ...(checkpoint.continuation ?? { kind: "closure_recovery" }),
      state: "failed",
      lastError: failMessage,
      lastCompletedAtMs: now,
    },
  });
  emitRuntimeRecoveryTelemetry({
    runId: checkpoint.runId,
    ...(checkpoint.sessionKey ? { sessionKey: checkpoint.sessionKey } : {}),
    milestone: "recovery_checkpoint_terminal",
    checkpointId,
    continuationKind: "closure_recovery",
    terminalStatus: "cancelled",
    continuationState: "failed",
    error: failMessage,
    ...(checkpoint.target?.approvalId ? { approvalId: checkpoint.target.approvalId } : {}),
  });
}

function resolveMessagingClosureDecision(params: {
  acceptance: PlatformRuntimeAcceptanceResult | undefined;
  supervisorVerdict?: PlatformRuntimeSupervisorVerdict;
}): MessagingClosureDecision | undefined {
  return params.supervisorVerdict ?? params.acceptance;
}

function resolveDecisionOutcome(
  decision: MessagingClosureDecision,
): PlatformRuntimeRunOutcome | undefined {
  return "outcome" in decision ? decision.outcome : decision.acceptance?.outcome;
}

function resolveBootstrapReason(intent?: PlatformRuntimeExecutionIntent): BootstrapReason {
  return intent?.recipeId ? "recipe_requirement" : "missing_capability";
}

function resolveBootstrapSourceDomain(
  intent?: PlatformRuntimeExecutionIntent,
): BootstrapSourceDomain {
  if (
    intent?.intent === "document" ||
    intent?.intent === "compare" ||
    intent?.intent === "calculation"
  ) {
    return "document";
  }
  if (intent?.intent === "code") {
    return "developer";
  }
  return "platform";
}

/**
 * Maps runtime execution intent to a bootstrap UI / telemetry tier aligned with route-preflight heuristics.
 * @param intent - Active platform runtime execution intent (profile/recipe must be present for snapshots).
 * @returns Whether the turn is treated as local-first eligible vs requiring a stronger remote route.
 */
function resolveModelRouteTierFromIntent(
  intent: PlatformRuntimeExecutionIntent,
): PlatformExecutionContextModelRouteTier {
  const localEligible = inferLocalRoutingEligibleFromPlannerInput({
    intent: intent.intent,
    requestedTools: intent.requestedToolNames,
    fileNames: [],
    artifactKinds: intent.artifactKinds,
  });
  return localEligible ? "local_eligible" : "remote_required";
}

function buildBootstrapExecutionContext(params: {
  intent?: PlatformRuntimeExecutionIntent;
  decision: MessagingClosureDecision;
}): PlatformExecutionContextSnapshot | undefined {
  const intent = params.intent;
  if (!intent?.profileId || !intent.recipeId) {
    return undefined;
  }
  return {
    profileId: intent.profileId,
    recipeId: intent.recipeId,
    modelRouteTier: resolveModelRouteTierFromIntent(intent),
    ...(intent.taskOverlayId ? { taskOverlayId: intent.taskOverlayId } : {}),
    ...(intent.plannerReasoning ? { plannerReasoning: intent.plannerReasoning } : {}),
    ...(intent.intent ? { intent: intent.intent } : {}),
    ...(intent.publishTargets?.length ? { publishTargets: intent.publishTargets } : {}),
    ...(intent.requestedToolNames?.length ? { requestedToolNames: intent.requestedToolNames } : {}),
    ...(intent.requiredCapabilities?.length
      ? { requiredCapabilities: intent.requiredCapabilities }
      : {}),
    ...(intent.bootstrapRequiredCapabilities?.length
      ? { bootstrapRequiredCapabilities: intent.bootstrapRequiredCapabilities }
      : {}),
    ...(intent.requireExplicitApproval !== undefined
      ? { requireExplicitApproval: intent.requireExplicitApproval }
      : {}),
    ...(intent.policyAutonomy ? { policyAutonomy: intent.policyAutonomy } : {}),
    readinessStatus: "bootstrap_required",
    readinessReasons: Array.from(
      new Set([...params.decision.reasons, `blockedRunId=${params.decision.runId}`]),
    ),
    unattendedBoundary: "bootstrap",
  };
}

function resolveApprovalBlockedReason(decision: MessagingClosureDecision): string {
  if (decision.remediation === "auth_refresh") {
    return "provider authentication refresh requires operator attention";
  }
  if (decision.remediation === "provider_fallback") {
    return "provider fallback selection requires operator attention";
  }
  if (decision.remediation === "bootstrap") {
    return "bootstrap recovery requires operator approval";
  }
  return decision.reasons[0] ?? "closure outcome requires operator review";
}

function resolveClosureApprovalId(decision: MessagingClosureDecision): string {
  return `closure:${decision.runId}:${decision.remediation}:${decision.action}`;
}

function shouldCreateHumanApproval(decision: MessagingClosureDecision): boolean {
  return (
    decision.action === "escalate" ||
    decision.remediation === "auth_refresh" ||
    decision.remediation === "provider_fallback" ||
    decision.remediation === "needs_human"
  );
}

function ensureClosureApprovalRequest(params: {
  decision: MessagingClosureDecision;
  sourceRun: FollowupRun;
  queueKey?: string;
  settings: QueueSettings;
}): string | undefined {
  const outcome = resolveDecisionOutcome(params.decision);
  if ((outcome?.pendingApprovalIds.length ?? 0) > 0) {
    return outcome?.pendingApprovalIds[0];
  }

  const approvalId = resolveClosureApprovalId(params.decision);
  const manager = getSharedExecApprovalManager();
  const existing = manager.getSnapshot(approvalId);
  const runtimeCheckpointService = getPlatformRuntimeCheckpointService();
  const continuation = buildClosureRecoveryContinuationPayload({
    queueKey: params.queueKey,
    settings: params.settings,
    sourceRun: params.sourceRun,
  });
  if (!existing || existing.resolvedAtMs !== undefined) {
    const request = buildClosureApprovalRequestPayload({
      approvalId,
      blockedReason: resolveApprovalBlockedReason(params.decision),
      runId: params.decision.runId,
      sourceRun: params.sourceRun,
    });
    const record = manager.create(request, CLOSURE_APPROVAL_TIMEOUT_MS, approvalId);
    void manager.register(record, CLOSURE_APPROVAL_TIMEOUT_MS).catch(() => {});
  }

  const checkpoint = runtimeCheckpointService.createCheckpoint({
    id: approvalId,
    runId: params.decision.runId,
    ...(params.sourceRun.run.sessionKey ? { sessionKey: params.sourceRun.run.sessionKey } : {}),
    boundary: "exec_approval",
    blockedReason: resolveApprovalBlockedReason(params.decision),
    policyReasons: Array.from(new Set(params.decision.reasons)),
    nextActions: [
      {
        method: "exec.approval.resolve",
        label: "Approve or deny closure recovery",
        phase: "approve",
      },
      {
        method: "exec.approval.waitDecision",
        label: "Inspect pending closure recovery decision",
        phase: "inspect",
      },
    ],
    target: {
      approvalId,
      operation: "closure.recovery",
    },
    ...(continuation
      ? {
          continuation: {
            kind: "closure_recovery",
            state: "idle",
            attempts: 0,
            input: continuation,
          },
        }
      : {}),
  });
  registerAgentRunContext(params.decision.runId, {
    ...(params.sourceRun.run.sessionKey ? { sessionKey: params.sourceRun.run.sessionKey } : {}),
    runtimeState: "blocked",
    runtimeCheckpointId: checkpoint.id,
    runtimeBoundary: checkpoint.boundary,
  });
  emitAgentEvent({
    runId: params.decision.runId,
    ...(params.sourceRun.run.sessionKey ? { sessionKey: params.sourceRun.run.sessionKey } : {}),
    stream: "lifecycle",
    data: {
      phase: "blocked",
      checkpointId: checkpoint.id,
      boundary: checkpoint.boundary,
      blockedReason: checkpoint.blockedReason,
      startedAt: checkpoint.createdAtMs,
    },
  });
  return approvalId;
}

function ensureBootstrapRequests(params: {
  decision: MessagingClosureDecision;
  executionIntent?: PlatformRuntimeExecutionIntent;
  queueKey?: string;
  sourceRun?: FollowupRun;
  settings?: QueueSettings;
}): string[] {
  const outcome = resolveDecisionOutcome(params.decision);
  if ((outcome?.bootstrapRequestIds.length ?? 0) > 0) {
    return outcome?.bootstrapRequestIds ?? [];
  }
  const capabilityIds = Array.from(
    new Set(params.executionIntent?.bootstrapRequiredCapabilities ?? []),
  );
  if (capabilityIds.length === 0) {
    return [];
  }

  const queueKey = params.queueKey?.trim();
  const resumeCandidate =
    capabilityIds.length === 1 && queueKey && params.sourceRun && params.settings
      ? BootstrapBlockedRunResumeSchema.safeParse({
          blockedRunId: params.decision.runId,
          sessionKey: params.sourceRun.run.sessionKey,
          queueKey,
          settings: params.settings,
          sourceRun: params.sourceRun,
        })
      : undefined;
  const blockedRunResume = resumeCandidate?.success ? resumeCandidate.data : undefined;

  const registry = createCapabilityRegistry([], TRUSTED_CAPABILITY_CATALOG);
  const resolutions = resolveBootstrapRequests({
    capabilityIds,
    registry,
    reason: resolveBootstrapReason(params.executionIntent),
    sourceDomain: resolveBootstrapSourceDomain(params.executionIntent),
    sourceRecipeId: params.executionIntent?.recipeId,
    executionContext: buildBootstrapExecutionContext({
      intent: params.executionIntent,
      decision: params.decision,
    }),
    ...(blockedRunResume ? { blockedRunResume } : {}),
  });
  const service = getPlatformBootstrapService();
  return resolutions
    .map((resolution) => resolution.request)
    .filter((request): request is BootstrapRequest => request !== undefined)
    .map((request) => service.create(request).id);
}

export function enqueueSemanticRetryFollowup(params: {
  queueKey?: string;
  sourceRun: FollowupRun;
  settings: QueueSettings;
  acceptance: PlatformRuntimeAcceptanceResult | undefined;
  supervisorVerdict?: PlatformRuntimeSupervisorVerdict;
}): boolean {
  const decision = resolveMessagingClosureDecision(params);
  if (
    !params.queueKey ||
    decision?.action !== "retry" ||
    decision.remediation !== "semantic_retry" ||
    decision.recoveryPolicy.exhausted
  ) {
    return false;
  }
  const retryCount = params.sourceRun.automation?.retryCount ?? 0;
  const prompt = [
    "The previous run did not satisfy the task well enough.",
    decision.reasons.length > 0 ? `Observed issues: ${decision.reasons.join(" ")}` : undefined,
    "Continue the same task and return only the final completed result.",
    "Do not send an acknowledgement-only update.",
  ]
    .filter(Boolean)
    .join(" ");
  return enqueueFollowupRun(
    params.queueKey,
    {
      ...params.sourceRun,
      requestRunId: params.sourceRun.requestRunId ?? decision.runId,
      parentRunId: decision.runId,
      prompt,
      messageId: undefined,
      summaryLine: decision.reasons[0] ?? "semantic retry",
      enqueuedAt: Date.now(),
      automation: {
        source: "acceptance_retry",
        retryCount: retryCount + 1,
        persisted: true,
        reasonCode: "reasonCode" in decision ? decision.reasonCode : undefined,
        reasonSummary: decision.reasons.join(" "),
      },
    },
    params.settings,
    "prompt",
  );
}

export function dispatchMessagingClosureOutcome(params: {
  queueKey?: string;
  sourceRun: FollowupRun;
  settings: QueueSettings;
  acceptance: PlatformRuntimeAcceptanceResult | undefined;
  supervisorVerdict?: PlatformRuntimeSupervisorVerdict;
  executionIntent?: PlatformRuntimeExecutionIntent;
}): MessagingClosureOutcomeDispatchResult {
  const decision = resolveMessagingClosureDecision(params);
  if (!decision) {
    return { queuedSemanticRetry: false };
  }

  const queuedSemanticRetry = enqueueSemanticRetryFollowup(params);
  if (queuedSemanticRetry) {
    return { queuedSemanticRetry: true };
  }

  const bootstrapRequestIds =
    decision.remediation === "bootstrap"
      ? ensureBootstrapRequests({
          decision,
          executionIntent: params.executionIntent,
          queueKey: params.queueKey,
          sourceRun: params.sourceRun,
          settings: params.settings,
        })
      : [];
  const approvalId =
    bootstrapRequestIds.length === 0 && shouldCreateHumanApproval(decision)
      ? ensureClosureApprovalRequest({
          decision,
          sourceRun: params.sourceRun,
          queueKey: params.queueKey,
          settings: params.settings,
        })
      : undefined;

  return {
    queuedSemanticRetry: false,
    ...(approvalId ? { approvalId } : {}),
    ...(bootstrapRequestIds.length > 0 ? { bootstrapRequestIds } : {}),
  };
}

export async function reconcileClosureRecoveryOnStartup(): Promise<ClosureRecoveryStartupReconcileResult> {
  const runtimeCheckpointService = getPlatformRuntimeCheckpointService();
  const manager = getSharedExecApprovalManager();
  let restoredApprovalCount = 0;
  let redispatchedContinuationCount = 0;
  let staleCheckpointCount = 0;

  for (const summary of runtimeCheckpointService.list()) {
    const checkpoint = runtimeCheckpointService.get(summary.id);
    if (!checkpoint || !isClosureRecoveryCheckpoint(checkpoint)) {
      continue;
    }

    const approvalId = checkpoint.target?.approvalId?.trim();
    const payload = parseClosureRecoveryContinuationPayload(checkpoint.continuation?.input);
    if (checkpoint.status === "blocked") {
      if (!approvalId || !payload) {
        staleCheckpointCount += 1;
        markClosureRecoveryCheckpointFailed({
          checkpointId: checkpoint.id,
          error: "closure recovery approval could not be restored after restart",
        });
        continue;
      }
      if (!manager.getSnapshot(approvalId)) {
        const request = buildClosureApprovalRequestPayload({
          approvalId,
          blockedReason: checkpoint.blockedReason ?? "closure outcome requires operator review",
          runId: checkpoint.runId,
          sourceRun: payload.sourceRun,
        });
        const record = manager.create(request, CLOSURE_APPROVAL_TIMEOUT_MS, approvalId);
        record.createdAtMs = checkpoint.createdAtMs;
        record.expiresAtMs = Date.now() + CLOSURE_APPROVAL_TIMEOUT_MS;
        void manager.register(record, CLOSURE_APPROVAL_TIMEOUT_MS).catch(() => {});
        restoredApprovalCount += 1;
      }
      continue;
    }

    if (
      (checkpoint.status === "approved" || checkpoint.status === "resumed") &&
      payload &&
      checkpoint.continuation?.state !== "completed"
    ) {
      const resumedCheckpoint =
        checkpoint.status === "approved"
          ? runtimeCheckpointService.updateCheckpoint(checkpoint.id, {
              status: "resumed",
              resumedAtMs: checkpoint.resumedAtMs ?? Date.now(),
            })
          : checkpoint;
      if (resumedCheckpoint) {
        registerAgentRunContext(resumedCheckpoint.runId, {
          ...(resumedCheckpoint.sessionKey ? { sessionKey: resumedCheckpoint.sessionKey } : {}),
          runtimeState: "resumed",
          runtimeCheckpointId: resumedCheckpoint.id,
          runtimeBoundary: resumedCheckpoint.boundary,
        });
        emitAgentEvent({
          runId: resumedCheckpoint.runId,
          ...(resumedCheckpoint.sessionKey ? { sessionKey: resumedCheckpoint.sessionKey } : {}),
          stream: "lifecycle",
          data: {
            phase: "resumed",
            checkpointId: resumedCheckpoint.id,
            boundary: resumedCheckpoint.boundary,
          },
        });
        await runtimeCheckpointService.dispatchContinuation(resumedCheckpoint.id);
        redispatchedContinuationCount += 1;
      }
    }
  }

  return {
    restoredApprovalCount,
    redispatchedContinuationCount,
    staleCheckpointCount,
  };
}

getPlatformRuntimeCheckpointService().registerContinuationHandler(
  "closure_recovery",
  async (checkpoint) => {
    const payload = parseClosureRecoveryContinuationPayload(checkpoint.continuation?.input);
    if (!payload) {
      return;
    }
    await dispatchClosureRecoveryContinuation(checkpoint.id, payload);
  },
);
