import { emitAgentEvent, registerAgentRunContext } from "../../infra/agent-events.js";
import { DEFAULT_EXEC_APPROVAL_TIMEOUT_MS } from "../../infra/exec-approvals.js";
import {
  TRUSTED_CAPABILITY_CATALOG,
  getPlatformBootstrapService,
  resolveBootstrapRequests,
  type BootstrapReason,
  type BootstrapRequest,
  type BootstrapSourceDomain,
} from "../../platform/bootstrap/index.js";
import type { PlatformExecutionContextSnapshot } from "../../platform/decision/contracts.js";
import { createCapabilityRegistry } from "../../platform/registry/capability-registry.js";
import {
  getPlatformRuntimeCheckpointService,
  type PlatformRuntimeAcceptanceResult,
  type PlatformRuntimeExecutionIntent,
  type PlatformRuntimeRunOutcome,
  type PlatformRuntimeSupervisorVerdict,
} from "../../platform/runtime/index.js";
import { getSharedExecApprovalManager } from "../../gateway/exec-approval-manager.js";
import { enqueueFollowupRun, type FollowupRun, type QueueSettings } from "./queue.js";

type MessagingClosureDecision =
  | PlatformRuntimeAcceptanceResult
  | PlatformRuntimeSupervisorVerdict;

export type MessagingClosureOutcomeDispatchResult = {
  queuedSemanticRetry: boolean;
  approvalId?: string;
  bootstrapRequestIds?: string[];
};

const CLOSURE_APPROVAL_TIMEOUT_MS = Math.max(
  DEFAULT_EXEC_APPROVAL_TIMEOUT_MS,
  24 * 60 * 60 * 1000,
);

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
  if (intent?.intent === "document") {
    return "document";
  }
  if (intent?.intent === "code") {
    return "developer";
  }
  return "platform";
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
    readinessReasons: Array.from(new Set(params.decision.reasons)),
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
}): string | undefined {
  const outcome = resolveDecisionOutcome(params.decision);
  if ((outcome?.pendingApprovalIds.length ?? 0) > 0) {
    return outcome?.pendingApprovalIds[0];
  }

  const approvalId = resolveClosureApprovalId(params.decision);
  const manager = getSharedExecApprovalManager();
  const existing = manager.getSnapshot(approvalId);
  const runtimeCheckpointService = getPlatformRuntimeCheckpointService();
  if (!existing || existing.resolvedAtMs !== undefined) {
    const request = {
      command: `Review closure outcome for run ${params.decision.runId}`,
      commandPreview: params.decision.reasons[0] ?? null,
      cwd: params.sourceRun.run.workspaceDir,
      host: "gateway",
      security: "deny",
      ask: "always",
      agentId: params.sourceRun.run.agentId,
      sessionKey: params.sourceRun.run.sessionKey ?? null,
      turnSourceChannel: params.sourceRun.originatingChannel ?? params.sourceRun.run.messageProvider ?? null,
      turnSourceTo: params.sourceRun.originatingTo ?? null,
      turnSourceAccountId:
        params.sourceRun.originatingAccountId ?? params.sourceRun.run.agentAccountId ?? null,
      turnSourceThreadId: params.sourceRun.originatingThreadId ?? null,
      runtimeRunId: params.decision.runId,
      runtimeCheckpointId: approvalId,
      runtimeBoundary: "exec_approval",
      blockedReason: resolveApprovalBlockedReason(params.decision),
    };
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
        })
      : [];
  const approvalId =
    bootstrapRequestIds.length === 0 && shouldCreateHumanApproval(decision)
      ? ensureClosureApprovalRequest({
          decision,
          sourceRun: params.sourceRun,
        })
      : undefined;

  return {
    queuedSemanticRetry: false,
    ...(approvalId ? { approvalId } : {}),
    ...(bootstrapRequestIds.length > 0 ? { bootstrapRequestIds } : {}),
  };
}
