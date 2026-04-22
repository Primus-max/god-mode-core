import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { emitRunClosureSummary, emitRuntimeRecoveryTelemetry } from "../../infra/agent-events.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import {
  OutcomeContractSchema,
  QualificationExecutionContractSchema,
  RequestedEvidenceKindSchema,
} from "../decision/qualification-contract.js";
import {
  PlatformRuntimeAcceptanceResultSchema,
  PlatformRuntimeActionSchema,
  PlatformRuntimeActionStoreSchema,
  PlatformRuntimeActionSummarySchema,
  PlatformRuntimeCheckpointSchema,
  PlatformRuntimeCheckpointStoreSchema,
  PlatformRuntimeCheckpointSummarySchema,
  PlatformRuntimeExecutionContractSchema,
  PlatformRuntimeExecutionIntentSchema,
  PlatformRuntimeExecutionReceiptCountsSchema,
  PlatformRuntimeExecutionReceiptProofCountsSchema,
  PlatformRuntimeExecutionReceiptSchema,
  PlatformRuntimeRunClosureSchema,
  PlatformRuntimeRunClosureSummarySchema,
  PlatformRuntimeRunClosureStoreSchema,
  PlatformRuntimeRecoveryPolicySchema,
  PlatformRuntimeExecutionSurfaceSchema,
  PlatformRuntimeExecutionVerificationSchema,
  PlatformRuntimeRunOutcomeSchema,
  PlatformRuntimeSupervisorVerdictSchema,
  type PlatformRuntimeAcceptanceEvidence,
  type PlatformRuntimeAcceptanceResult,
  type PlatformRuntimeAction,
  type PlatformRuntimeActionKind,
  type PlatformRuntimeActionReceipt,
  type PlatformRuntimeActionState,
  type PlatformRuntimeActionSummary,
  type PlatformRuntimeBoundary,
  type PlatformRuntimeCheckpoint,
  type PlatformRuntimeContinuation,
  type PlatformRuntimeContinuationKind,
  type PlatformRuntimeCheckpointStatus,
  type PlatformRuntimeCheckpointSummary,
  type PlatformRuntimeExecutionContract,
  type PlatformRuntimeExecutionIntent,
  type PlatformRuntimeExecutionReceipt,
  type PlatformRuntimeExecutionReceiptCounts,
  type PlatformRuntimeExecutionReceiptKind,
  type PlatformRuntimeExecutionReceiptProofCounts,
  type PlatformRuntimeExecutionSurface,
  type PlatformRuntimeExecutionVerification,
  type PlatformRuntimeNextAction,
  type PlatformRuntimeRecoveryCadence,
  type PlatformRuntimeRecoveryClass,
  type PlatformRuntimeRecoveryPolicy,
  type PlatformRuntimeRunOutcome,
  type PlatformRuntimeRunClosure,
  type PlatformRuntimeRunClosureSummary,
  type PlatformRuntimeSupervisorVerdict,
  type PlatformRuntimeTarget,
} from "./contracts.js";
import {
  hasStructuredArtifactToolOutputReceipt,
  isCompletionEvidenceSufficient,
  mapQualificationToEvidenceRequirements,
  requiresStructuredEvidence,
} from "./evidence-sufficiency.js";

const PLATFORM_RUNTIME_SERVICE_KEY = Symbol.for("openclaw.platform.runtime.service");
const PLATFORM_RUNTIME_CHECKPOINTS_FILENAME = "platform-runtime-checkpoints.json";
const PLATFORM_RUNTIME_ACTIONS_FILENAME = "platform-runtime-actions.json";
const PLATFORM_RUNTIME_CLOSURES_FILENAME = "platform-runtime-closures.json";
const WINDOWS_PERSIST_RETRY_DELAYS_MS = [10, 25, 50] as const;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isRetryableRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EBUSY";
}

function renameWithRetry(tmpPath: string, targetPath: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(tmpPath, targetPath);
      return;
    } catch (error) {
      if (attempt >= WINDOWS_PERSIST_RETRY_DELAYS_MS.length || !isRetryableRenameError(error)) {
        throw error;
      }
      sleepSync(WINDOWS_PERSIST_RETRY_DELAYS_MS[attempt]);
    }
  }
}

export type PlatformRuntimeCheckpointService = {
  configure: (params: { stateDir?: string }) => void;
  createCheckpoint: (params: {
    id?: string;
    runId: string;
    sessionKey?: string;
    boundary: PlatformRuntimeBoundary;
    blockedReason?: string;
    policyReasons?: string[];
    deniedReasons?: string[];
    nextActions?: PlatformRuntimeNextAction[];
    target?: PlatformRuntimeTarget;
    continuation?: PlatformRuntimeContinuation;
    executionContext?: PlatformRuntimeCheckpoint["executionContext"];
  }) => PlatformRuntimeCheckpoint;
  updateCheckpoint: (
    id: string,
    patch: Partial<Omit<PlatformRuntimeCheckpoint, "id" | "createdAtMs">>,
  ) => PlatformRuntimeCheckpoint | undefined;
  get: (id: string) => PlatformRuntimeCheckpoint | undefined;
  stageAction: (params: {
    actionId: string;
    runId?: string;
    sessionKey?: string;
    kind: PlatformRuntimeActionKind;
    boundary?: PlatformRuntimeBoundary;
    checkpointId?: string;
    idempotencyKey?: string;
    target?: PlatformRuntimeTarget;
    receipt?: PlatformRuntimeActionReceipt;
  }) => PlatformRuntimeAction;
  updateAction: (
    actionId: string,
    patch: Partial<Omit<PlatformRuntimeAction, "actionId" | "createdAtMs">>,
  ) => PlatformRuntimeAction | undefined;
  markActionAttempted: (
    actionId: string,
    patch?: Partial<Pick<PlatformRuntimeAction, "receipt" | "lastError" | "retryable">>,
  ) => PlatformRuntimeAction | undefined;
  markActionConfirmed: (
    actionId: string,
    patch?: Partial<Pick<PlatformRuntimeAction, "receipt" | "lastError" | "retryable">>,
  ) => PlatformRuntimeAction | undefined;
  markActionFailed: (
    actionId: string,
    patch?: Partial<Pick<PlatformRuntimeAction, "receipt" | "lastError" | "retryable">>,
  ) => PlatformRuntimeAction | undefined;
  getAction: (actionId: string) => PlatformRuntimeAction | undefined;
  listActions: (params?: {
    runId?: string;
    sessionKey?: string;
    kind?: PlatformRuntimeActionKind;
    state?: PlatformRuntimeActionState;
    checkpointId?: string;
    idempotencyKey?: string;
  }) => PlatformRuntimeActionSummary[];
  findByApprovalId: (approvalId: string) => PlatformRuntimeCheckpoint | undefined;
  list: (params?: {
    sessionKey?: string;
    runId?: string;
    status?: PlatformRuntimeCheckpointStatus;
  }) => PlatformRuntimeCheckpointSummary[];
  buildRunOutcome: (runId: string) => PlatformRuntimeRunOutcome | undefined;
  buildAcceptanceEvidence: (params: {
    outcome: PlatformRuntimeRunOutcome;
    evidence?: PlatformRuntimeAcceptanceEvidence;
    executionVerification?: PlatformRuntimeExecutionVerification;
    executionSurface?: PlatformRuntimeExecutionSurface;
    executionIntent?: PlatformRuntimeExecutionIntent;
  }) => PlatformRuntimeAcceptanceEvidence;
  buildExecutionIntent: (params: {
    runId: string;
    executionIntent?: Partial<PlatformRuntimeExecutionIntent>;
  }) => PlatformRuntimeExecutionIntent;
  buildExecutionContract: (params: {
    runId: string;
    outcome?: PlatformRuntimeRunOutcome;
    receipts?: PlatformRuntimeExecutionReceipt[];
    evidence?: PlatformRuntimeAcceptanceEvidence;
    executionIntent?: PlatformRuntimeExecutionIntent;
  }) => PlatformRuntimeExecutionContract;
  buildExecutionReceipts: (params: {
    runId: string;
    outcome?: PlatformRuntimeRunOutcome;
    receipts?: PlatformRuntimeExecutionReceipt[];
  }) => PlatformRuntimeExecutionReceipt[];
  buildRunClosure: (params: {
    runId: string;
    requestRunId?: string;
    parentRunId?: string;
    sessionKey?: string;
    outcome?: PlatformRuntimeRunOutcome;
    receipts?: PlatformRuntimeExecutionReceipt[];
    evidence?: PlatformRuntimeAcceptanceEvidence;
    executionSurface?: PlatformRuntimeExecutionSurface;
    executionIntent?: PlatformRuntimeExecutionIntent;
  }) => PlatformRuntimeRunClosure;
  verifyExecutionContract: (params: {
    contract: PlatformRuntimeExecutionContract;
    outcome?: PlatformRuntimeRunOutcome;
    evidence?: PlatformRuntimeAcceptanceEvidence;
  }) => PlatformRuntimeExecutionVerification;
  evaluateAcceptance: (params: {
    runId: string;
    outcome: PlatformRuntimeRunOutcome;
    evidence?: PlatformRuntimeAcceptanceEvidence;
    receipts?: PlatformRuntimeExecutionReceipt[];
  }) => PlatformRuntimeAcceptanceResult;
  evaluateSupervisorVerdict: (params: {
    runId: string;
    acceptance?: PlatformRuntimeAcceptanceResult;
    verification?: PlatformRuntimeExecutionVerification;
    surface?: PlatformRuntimeExecutionSurface;
  }) => PlatformRuntimeSupervisorVerdict;
  recordRunClosure: (closure: PlatformRuntimeRunClosure) => PlatformRuntimeRunClosure;
  getRunClosure: (runId: string) => PlatformRuntimeRunClosure | undefined;
  listRunClosures: (params?: {
    sessionKey?: string;
    requestRunId?: string;
  }) => PlatformRuntimeRunClosure[];
  registerContinuationHandler: (
    kind: PlatformRuntimeContinuationKind,
    handler: (checkpoint: PlatformRuntimeCheckpoint) => Promise<void> | void,
  ) => void;
  dispatchContinuation: (checkpointId: string) => Promise<PlatformRuntimeCheckpoint | undefined>;
  rehydrate: () => number;
  reset: () => void;
};

function resolveRuntimeCheckpointStorePath(stateDir: string): string {
  return path.join(stateDir, PLATFORM_RUNTIME_CHECKPOINTS_FILENAME);
}

function resolveRuntimeActionStorePath(stateDir: string): string {
  return path.join(stateDir, PLATFORM_RUNTIME_ACTIONS_FILENAME);
}

function resolveRuntimeClosureStorePath(stateDir: string): string {
  return path.join(stateDir, PLATFORM_RUNTIME_CLOSURES_FILENAME);
}

function buildStorePayload(checkpoints: Map<string, PlatformRuntimeCheckpoint>) {
  return PlatformRuntimeCheckpointStoreSchema.parse({
    version: 1,
    checkpoints: Array.from(checkpoints.values()).toSorted(
      (left, right) => right.updatedAtMs - left.updatedAtMs,
    ),
  });
}

function buildActionStorePayload(actions: Map<string, PlatformRuntimeAction>) {
  return PlatformRuntimeActionStoreSchema.parse({
    version: 1,
    actions: Array.from(actions.values()).toSorted(
      (left, right) => right.updatedAtMs - left.updatedAtMs,
    ),
  });
}

function buildClosureStorePayload(closures: Map<string, PlatformRuntimeRunClosure>) {
  return PlatformRuntimeRunClosureStoreSchema.parse({
    version: 1,
    closures: Array.from(closures.values()).toSorted(
      (left, right) => right.updatedAtMs - left.updatedAtMs,
    ),
  });
}

function buildRunClosureSummary(
  closure: PlatformRuntimeRunClosure,
): PlatformRuntimeRunClosureSummary {
  return PlatformRuntimeRunClosureSummarySchema.parse({
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
    ...(closure.executionIntent.outcomeContract
      ? { declaredOutcomeContract: closure.executionIntent.outcomeContract }
      : {}),
    ...(closure.executionIntent.profileId
      ? { declaredProfileId: closure.executionIntent.profileId }
      : {}),
    ...(closure.executionIntent.recipeId
      ? { declaredRecipeId: closure.executionIntent.recipeId }
      : {}),
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
  });
}

function normalizeRunOutcome(
  outcome:
    | PlatformRuntimeRunOutcome
    | (PlatformRuntimeRunOutcome & Record<string, unknown>)
    | undefined,
): PlatformRuntimeRunOutcome | undefined {
  if (!outcome) {
    return undefined;
  }
  return PlatformRuntimeRunOutcomeSchema.parse({
    runId: outcome.runId,
    status: outcome.status,
    checkpointIds: outcome.checkpointIds,
    blockedCheckpointIds: outcome.blockedCheckpointIds,
    completedCheckpointIds: outcome.completedCheckpointIds,
    deniedCheckpointIds: outcome.deniedCheckpointIds,
    pendingApprovalIds: outcome.pendingApprovalIds,
    artifactIds: outcome.artifactIds,
    bootstrapRequestIds: outcome.bootstrapRequestIds,
    actionIds: outcome.actionIds,
    attemptedActionIds: outcome.attemptedActionIds,
    confirmedActionIds: outcome.confirmedActionIds,
    failedActionIds: outcome.failedActionIds,
    boundaries: outcome.boundaries,
  });
}

function normalizeReasons(values: string[] | undefined): string[] | undefined {
  if (!values?.length) {
    return undefined;
  }
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
}

function buildExecutionReceiptCounts(
  receipts: PlatformRuntimeExecutionReceipt[],
): PlatformRuntimeExecutionReceiptCounts {
  const counts = {
    success: 0,
    warning: 0,
    partial: 0,
    degraded: 0,
    failed: 0,
    blocked: 0,
  } satisfies PlatformRuntimeExecutionReceiptCounts;
  for (const receipt of receipts) {
    counts[receipt.status] += 1;
  }
  return PlatformRuntimeExecutionReceiptCountsSchema.parse(counts);
}

function buildExecutionReceiptProofCounts(
  receipts: PlatformRuntimeExecutionReceipt[],
): PlatformRuntimeExecutionReceiptProofCounts {
  const counts = {
    derived: 0,
    reported: 0,
    verified: 0,
  } satisfies PlatformRuntimeExecutionReceiptProofCounts;
  for (const receipt of receipts) {
    counts[receipt.proof] += 1;
  }
  return PlatformRuntimeExecutionReceiptProofCountsSchema.parse(counts);
}

function classifyProviderEvidence(
  evidence: PlatformRuntimeAcceptanceEvidence,
): "auth_refresh" | "provider_fallback" | undefined {
  if (evidence.providerAuthFailed === true || evidence.modelFallbackFinalReason === "auth") {
    return "auth_refresh";
  }
  if (
    evidence.modelFallbackExhausted === true ||
    evidence.providerRateLimited === true ||
    evidence.providerModelNotFound === true
  ) {
    return "provider_fallback";
  }
  const finalReason = evidence.modelFallbackFinalReason;
  if (
    finalReason === "rate_limit" ||
    finalReason === "overloaded" ||
    finalReason === "model_not_found" ||
    finalReason === "billing" ||
    finalReason === "no_profiles_available"
  ) {
    return "provider_fallback";
  }
  return undefined;
}

function resolveAcceptanceRemediation(params: {
  action: PlatformRuntimeAcceptanceResult["action"];
  reasonCode: PlatformRuntimeAcceptanceResult["reasonCode"];
  evidence: PlatformRuntimeAcceptanceEvidence;
}): PlatformRuntimeAcceptanceResult["remediation"] {
  if (
    params.reasonCode === "pending_approval" ||
    params.reasonCode === "runtime_blocked" ||
    params.action === "escalate"
  ) {
    return "needs_human";
  }
  if (
    params.reasonCode === "bootstrap_required" ||
    params.evidence.executionSurfaceStatus === "bootstrap_required" ||
    params.evidence.executionUnattendedBoundary === "bootstrap"
  ) {
    return "bootstrap";
  }
  const providerRecovery = classifyProviderEvidence(params.evidence);
  if (providerRecovery) {
    return providerRecovery;
  }
  if (params.reasonCode === "delivery_failed" || params.reasonCode === "delivery_partial") {
    return "delivery_retry";
  }
  if (params.action === "stop") {
    return "stop";
  }
  if (params.action === "close") {
    return "none";
  }
  return "semantic_retry";
}

function resolveRecoveryPolicyDefaults(
  remediation: PlatformRuntimeAcceptanceResult["remediation"],
): {
  recoveryClass: PlatformRuntimeRecoveryClass;
  cadence: PlatformRuntimeRecoveryCadence;
  continuous: boolean;
  maxAttempts: number;
  exhaustedAction: "escalate" | "stop";
  nextAttemptDelayMs?: number;
} {
  switch (remediation) {
    case "semantic_retry":
      return {
        recoveryClass: "semantic",
        cadence: "immediate",
        continuous: false,
        maxAttempts: 1,
        exhaustedAction: "stop",
        nextAttemptDelayMs: 0,
      };
    case "delivery_retry":
      return {
        recoveryClass: "delivery",
        cadence: "backoff",
        continuous: true,
        maxAttempts: 5,
        exhaustedAction: "stop",
      };
    case "bootstrap":
      return {
        recoveryClass: "bootstrap",
        cadence: "manual",
        continuous: false,
        maxAttempts: 2,
        exhaustedAction: "escalate",
      };
    case "provider_fallback":
      return {
        recoveryClass: "provider",
        cadence: "immediate",
        continuous: false,
        maxAttempts: 2,
        exhaustedAction: "escalate",
        nextAttemptDelayMs: 0,
      };
    case "auth_refresh":
      return {
        recoveryClass: "auth",
        cadence: "manual",
        continuous: false,
        maxAttempts: 1,
        exhaustedAction: "escalate",
      };
    case "needs_human":
      return {
        recoveryClass: "human",
        cadence: "manual",
        continuous: false,
        maxAttempts: 0,
        exhaustedAction: "escalate",
      };
    case "stop":
      return {
        recoveryClass: "stop",
        cadence: "none",
        continuous: false,
        maxAttempts: 0,
        exhaustedAction: "stop",
      };
    case "none":
    default:
      return {
        recoveryClass: "none",
        cadence: "none",
        continuous: false,
        maxAttempts: 0,
        exhaustedAction: "stop",
      };
  }
}

function buildRecoveryPolicy(params: {
  action: PlatformRuntimeAcceptanceResult["action"];
  remediation: PlatformRuntimeAcceptanceResult["remediation"];
  evidence: PlatformRuntimeAcceptanceEvidence;
}): PlatformRuntimeRecoveryPolicy {
  const defaults = resolveRecoveryPolicyDefaults(params.remediation);
  const attemptCount = Math.max(0, params.evidence.recoveryAttemptCount ?? 0);
  const maxAttempts = Math.max(0, params.evidence.recoveryMaxAttempts ?? defaults.maxAttempts);
  const remainingAttempts = params.action === "retry" ? Math.max(maxAttempts - attemptCount, 0) : 0;
  const exhausted =
    params.action === "retry"
      ? params.evidence.recoveryBudgetExhausted === true || remainingAttempts === 0
      : params.evidence.recoveryBudgetExhausted === true;
  return PlatformRuntimeRecoveryPolicySchema.parse({
    remediation: params.remediation,
    recoveryClass: defaults.recoveryClass,
    cadence: defaults.cadence,
    continuous: defaults.continuous,
    attemptCount,
    maxAttempts,
    remainingAttempts,
    exhausted,
    exhaustedAction: defaults.exhaustedAction,
    ...(params.evidence.recoveryNextAttemptDelayMs !== undefined
      ? { nextAttemptDelayMs: params.evidence.recoveryNextAttemptDelayMs }
      : defaults.nextAttemptDelayMs !== undefined
        ? { nextAttemptDelayMs: defaults.nextAttemptDelayMs }
        : {}),
  });
}

function parseAcceptanceResult(params: {
  runId: string;
  status: PlatformRuntimeAcceptanceResult["status"];
  action: PlatformRuntimeAcceptanceResult["action"];
  reasonCode: PlatformRuntimeAcceptanceResult["reasonCode"];
  reasons: string[];
  outcome: PlatformRuntimeRunOutcome;
  evidence: PlatformRuntimeAcceptanceEvidence;
}): PlatformRuntimeAcceptanceResult {
  const remediation = resolveAcceptanceRemediation({
    action: params.action,
    reasonCode: params.reasonCode,
    evidence: params.evidence,
  });
  return PlatformRuntimeAcceptanceResultSchema.parse({
    ...params,
    remediation,
    recoveryPolicy: buildRecoveryPolicy({
      action: params.action,
      remediation,
      evidence: params.evidence,
    }),
  });
}

function resolveSupervisorReasonCode(params: {
  acceptance?: PlatformRuntimeAcceptanceResult;
  verification?: PlatformRuntimeExecutionVerification;
  surface?: PlatformRuntimeExecutionSurface;
  fallbackReasonCode:
    | "verified_execution"
    | "contract_mismatch"
    | "execution_no_progress"
    | "execution_degraded"
    | "transient_recoverable"
    | "needs_human"
    | "runtime_failed";
}): PlatformRuntimeSupervisorVerdict["reasonCode"] {
  const remediation =
    params.acceptance?.remediation ??
    resolveAcceptanceRemediation({
      action: params.acceptance?.action ?? "close",
      reasonCode: params.acceptance?.reasonCode ?? "completed_with_output",
      evidence: params.acceptance?.evidence ?? {},
    });
  if (remediation === "bootstrap") {
    return "bootstrap_recovery";
  }
  if (remediation === "auth_refresh") {
    return "auth_recovery";
  }
  if (remediation === "provider_fallback") {
    return "provider_recovery";
  }
  return params.fallbackReasonCode;
}

function parseSupervisorVerdict(params: {
  runId: string;
  status: PlatformRuntimeSupervisorVerdict["status"];
  action: PlatformRuntimeSupervisorVerdict["action"];
  reasonCode: PlatformRuntimeSupervisorVerdict["reasonCode"];
  reasons: string[];
  acceptance?: PlatformRuntimeAcceptanceResult;
  verification?: PlatformRuntimeExecutionVerification;
  surface?: PlatformRuntimeExecutionSurface;
}): PlatformRuntimeSupervisorVerdict {
  const remediation =
    params.acceptance?.remediation ??
    resolveAcceptanceRemediation({
      action: params.action,
      reasonCode: params.acceptance?.reasonCode ?? "completed_with_output",
      evidence: params.acceptance?.evidence ?? {},
    });
  return PlatformRuntimeSupervisorVerdictSchema.parse({
    ...params,
    remediation,
    recoveryPolicy:
      params.acceptance?.recoveryPolicy ??
      buildRecoveryPolicy({
        action: params.action,
        remediation,
        evidence: params.acceptance?.evidence ?? {},
      }),
  });
}

function normalizeOptionalStringArray(values: string[] | undefined): string[] | undefined {
  if (!values?.length) {
    return undefined;
  }
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
}

function deriveRequiredReceiptKinds(params: {
  outcome: PlatformRuntimeRunOutcome;
  evidence: PlatformRuntimeAcceptanceEvidence;
  executionIntent?: PlatformRuntimeExecutionIntent;
}): PlatformRuntimeExecutionReceiptKind[] | undefined {
  const kinds = new Set<PlatformRuntimeExecutionReceiptKind>();
  const requiresMessagingDelivery = params.evidence.didSendViaMessagingTool === true;
  if (requiresMessagingDelivery) {
    kinds.add("messaging_delivery");
  }
  if (params.outcome.bootstrapRequestIds.length > 0) {
    kinds.add("capability");
  }
  if (
    params.outcome.actionIds.length > 0 &&
    !requiresMessagingDelivery &&
    !allowsExecOnlyContractClosure(params.executionIntent)
  ) {
    kinds.add("platform_action");
  }
  return kinds.size > 0 ? Array.from(kinds) : undefined;
}

function allowsExecOnlyContractClosure(
  executionIntent: PlatformRuntimeExecutionIntent | undefined,
): boolean {
  if (!executionIntent) {
    return false;
  }
  if (executionIntent.lowConfidenceStrategy === "clarify") {
    return false;
  }
  if (executionIntent.deliverable?.kind !== "repo_operation") {
    return false;
  }
  const acceptedFormats = executionIntent.deliverable.acceptedFormats.map((format) =>
    format.trim().toLowerCase(),
  );
  if (!acceptedFormats.includes("exec")) {
    return false;
  }
  return executionIntent.executionContract?.requiresWorkspaceMutation !== true;
}

function deriveExecutionContractExpectations(params: {
  outcome: PlatformRuntimeRunOutcome;
  evidence: PlatformRuntimeAcceptanceEvidence;
  executionIntent?: PlatformRuntimeExecutionIntent;
}): PlatformRuntimeExecutionContract["expectations"] {
  const declared = params.executionIntent?.expectations ?? {};
  const qualificationRequirements = mapQualificationToEvidenceRequirements({
    executionIntent: params.executionIntent,
    expectations: declared,
  });
  const execOnlyContractClosure = allowsExecOnlyContractClosure(params.executionIntent);
  const requiresMessagingDelivery =
    declared.requiresMessagingDelivery ?? params.evidence.didSendViaMessagingTool === true;
  const requiresStructuredReceipts =
    declared.requireStructuredReceipts ??
    ((params.outcome.actionIds.length > 0 ||
      params.outcome.artifactIds.length > 0 ||
      params.outcome.bootstrapRequestIds.length > 0) &&
      !execOnlyContractClosure);
  const requiredReceiptKinds =
    declared.requiredReceiptKinds ??
    deriveRequiredReceiptKinds({
      ...params,
      executionIntent: params.executionIntent,
    });
  return PlatformRuntimeExecutionContractSchema.shape.expectations.parse({
    requiresOutput:
      declared.requiresOutput ??
      (qualificationRequirements.requiresStructuredEvidence ||
        params.evidence.hasOutput === true ||
        params.evidence.hasStructuredReplyPayload === true),
    requiresMessagingDelivery,
    requiresConfirmedAction:
      declared.requiresConfirmedAction ??
      (params.outcome.actionIds.length > 0 && !execOnlyContractClosure),
    requireStructuredReceipts: requiresStructuredReceipts,
    minimumVerifiedReceiptCount:
      declared.minimumVerifiedReceiptCount ?? (requiresStructuredReceipts ? 1 : 0),
    ...(requiredReceiptKinds?.length ? { requiredReceiptKinds } : {}),
    allowStandaloneEvidence:
      declared.allowStandaloneEvidence ??
      (!requiresStructuredReceipts && !requiresMessagingDelivery),
    allowWarnings: declared.allowWarnings ?? true,
    ...(declared.allowPartial !== undefined ? { allowPartial: declared.allowPartial } : {}),
  });
}

function buildIntentAwareEvidence(params: {
  evidence: PlatformRuntimeAcceptanceEvidence;
  executionIntent?: PlatformRuntimeExecutionIntent;
}): PlatformRuntimeAcceptanceEvidence {
  if (!params.executionIntent) {
    return params.evidence;
  }
  const expectations = params.executionIntent.expectations;
  return {
    ...params.evidence,
    ...(params.executionIntent.profileId
      ? { declaredProfileId: params.executionIntent.profileId }
      : {}),
    ...(params.executionIntent.recipeId
      ? { declaredRecipeId: params.executionIntent.recipeId }
      : {}),
    ...(params.executionIntent.intent ? { declaredIntent: params.executionIntent.intent } : {}),
    ...(params.executionIntent.artifactKinds?.length
      ? { declaredArtifactKinds: params.executionIntent.artifactKinds }
      : {}),
    ...(params.executionIntent.outcomeContract
      ? { declaredOutcomeContract: params.executionIntent.outcomeContract }
      : {}),
    ...(params.executionIntent.executionContract
      ? { declaredExecutionContract: params.executionIntent.executionContract }
      : {}),
    ...(params.executionIntent.requestedEvidence?.length
      ? { declaredRequestedEvidence: params.executionIntent.requestedEvidence }
      : {}),
    ...(params.executionIntent.lowConfidenceStrategy
      ? { declaredLowConfidenceStrategy: params.executionIntent.lowConfidenceStrategy }
      : {}),
    ...(expectations.requiresOutput !== undefined
      ? { declaredRequiresOutput: expectations.requiresOutput }
      : {}),
    ...(expectations.requiresMessagingDelivery !== undefined
      ? { declaredRequiresMessagingDelivery: expectations.requiresMessagingDelivery }
      : {}),
    ...(expectations.requiresConfirmedAction !== undefined
      ? { declaredRequiresConfirmedAction: expectations.requiresConfirmedAction }
      : {}),
  };
}

function buildExecutionIntentFromEvidence(params: {
  runId: string;
  evidence: PlatformRuntimeAcceptanceEvidence;
  expectations?: PlatformRuntimeExecutionContract["expectations"];
}): PlatformRuntimeExecutionIntent {
  return PlatformRuntimeExecutionIntentSchema.parse({
    runId: params.runId.trim(),
    ...(params.evidence.declaredProfileId ? { profileId: params.evidence.declaredProfileId } : {}),
    ...(params.evidence.declaredRecipeId ? { recipeId: params.evidence.declaredRecipeId } : {}),
    ...(params.evidence.declaredIntent ? { intent: params.evidence.declaredIntent } : {}),
    ...(params.evidence.declaredArtifactKinds?.length
      ? { artifactKinds: params.evidence.declaredArtifactKinds }
      : {}),
    ...(params.evidence.declaredOutcomeContract
      ? { outcomeContract: OutcomeContractSchema.parse(params.evidence.declaredOutcomeContract) }
      : {}),
    ...(params.evidence.declaredExecutionContract
      ? {
          executionContract: QualificationExecutionContractSchema.parse(
            params.evidence.declaredExecutionContract,
          ),
        }
      : {}),
    ...(params.evidence.declaredRequestedEvidence?.length
      ? {
          requestedEvidence: params.evidence.declaredRequestedEvidence.map((kind) =>
            RequestedEvidenceKindSchema.parse(kind),
          ),
        }
      : {}),
    ...(params.evidence.declaredLowConfidenceStrategy
      ? { lowConfidenceStrategy: params.evidence.declaredLowConfidenceStrategy }
      : {}),
    expectations: PlatformRuntimeExecutionContractSchema.shape.expectations.parse(
      params.expectations ?? {
        ...(params.evidence.declaredRequiresOutput !== undefined
          ? { requiresOutput: params.evidence.declaredRequiresOutput }
          : {}),
        ...(params.evidence.declaredRequiresMessagingDelivery !== undefined
          ? {
              requiresMessagingDelivery: params.evidence.declaredRequiresMessagingDelivery,
            }
          : {}),
        ...(params.evidence.declaredRequiresConfirmedAction !== undefined
          ? {
              requiresConfirmedAction: params.evidence.declaredRequiresConfirmedAction,
            }
          : {}),
      },
    ),
  });
}

function describeDeclaredIntent(evidence: PlatformRuntimeAcceptanceEvidence): string | undefined {
  if (evidence.declaredRecipeId) {
    return `recipe ${evidence.declaredRecipeId}`;
  }
  if (evidence.declaredIntent) {
    return `${evidence.declaredIntent} intent`;
  }
  return undefined;
}

function buildExecutionReceiptKey(receipt: PlatformRuntimeExecutionReceipt): string {
  const actionId =
    receipt.metadata && typeof receipt.metadata.actionId === "string"
      ? receipt.metadata.actionId
      : "";
  return [receipt.kind, receipt.name, receipt.status, receipt.proof, actionId].join("::");
}

function resolveActionExecutionReceiptKind(
  action: PlatformRuntimeAction,
): PlatformRuntimeExecutionReceiptKind {
  if (action.kind === "messaging_delivery") {
    return "messaging_delivery";
  }
  if (action.kind === "bootstrap") {
    return "capability";
  }
  return "platform_action";
}

function resolveActionExecutionReceiptName(action: PlatformRuntimeAction): string {
  if (action.kind === "bootstrap") {
    return action.receipt?.operation?.trim() || "bootstrap.run";
  }
  if (action.kind === "artifact_publish") {
    const operation = action.receipt?.operation?.trim() || action.target?.operation?.trim();
    return operation ? `artifact.${operation}` : "artifact.transition";
  }
  if (action.kind === "messaging_delivery") {
    const deliveryChannel = action.receipt?.deliveryResults?.[0]?.channel?.trim();
    return deliveryChannel ? `delivery.${deliveryChannel}` : "delivery";
  }
  if (action.kind === "node_invoke") {
    return action.receipt?.operation?.trim() || "node.invoke";
  }
  if (action.kind === "machine_control") {
    return action.receipt?.operation?.trim() || "machine.control";
  }
  if (action.kind === "privileged_tool") {
    return (
      action.receipt?.command?.trim() || action.receipt?.operation?.trim() || "privileged_tool"
    );
  }
  return action.kind;
}

function hasStructuredActionReceipt(action: PlatformRuntimeAction): boolean {
  if (!action.receipt) {
    return false;
  }
  if ((action.receipt.deliveryResults?.length ?? 0) > 0) {
    return true;
  }
  if (
    action.kind === "bootstrap" &&
    action.receipt.bootstrapRequestId &&
    action.receipt.capabilityId &&
    action.receipt.operation &&
    action.receipt.resultStatus
  ) {
    return true;
  }
  if (
    action.kind === "artifact_publish" &&
    action.receipt.artifactId &&
    action.receipt.operation &&
    action.receipt.resultStatus
  ) {
    return true;
  }
  if (
    action.kind === "node_invoke" &&
    (action.receipt.nodeId || action.receipt.nodeInvokeResult || action.receipt.operation)
  ) {
    return true;
  }
  if (
    (action.kind === "machine_control" || action.kind === "privileged_tool") &&
    (action.receipt.command || action.receipt.operation || action.receipt.resultStatus)
  ) {
    return true;
  }
  return false;
}

function buildExecutionReceiptFromAction(
  action: PlatformRuntimeAction,
): PlatformRuntimeExecutionReceipt | undefined {
  if (action.state === "staged") {
    return undefined;
  }
  const reasons: string[] = [];
  const structuredReceipt = hasStructuredActionReceipt(action);
  const proof = structuredReceipt ? "verified" : "derived";
  let status: PlatformRuntimeExecutionReceipt["status"];
  if (action.state === "failed") {
    status = "failed";
  } else if (action.state === "partial" || action.state === "attempted") {
    status = structuredReceipt ? "partial" : "warning";
  } else {
    status = structuredReceipt ? "success" : "warning";
  }
  if (!structuredReceipt) {
    reasons.push("runtime action completed without a structured receipt payload");
  }
  if (action.lastError) {
    reasons.push(action.lastError);
  }
  if (action.state === "attempted") {
    reasons.push("runtime action was attempted but not yet confirmed");
  }
  return PlatformRuntimeExecutionReceiptSchema.parse({
    kind: resolveActionExecutionReceiptKind(action),
    name: resolveActionExecutionReceiptName(action),
    status,
    proof,
    summary:
      action.state === "confirmed"
        ? "runtime action confirmed"
        : action.state === "failed"
          ? "runtime action failed"
          : "runtime action remains in progress",
    ...(normalizeReasons(reasons) ? { reasons: normalizeReasons(reasons) } : {}),
    metadata: {
      actionId: action.actionId,
      actionKind: action.kind,
      actionState: action.state,
      ...(action.checkpointId ? { checkpointId: action.checkpointId } : {}),
      ...(action.boundary ? { boundary: action.boundary } : {}),
      ...(action.receipt?.artifactId ? { artifactId: action.receipt.artifactId } : {}),
      ...(action.receipt?.bootstrapRequestId
        ? { bootstrapRequestId: action.receipt.bootstrapRequestId }
        : {}),
      ...(action.receipt?.capabilityId ? { capabilityId: action.receipt.capabilityId } : {}),
      ...(action.receipt?.nodeId ? { nodeId: action.receipt.nodeId } : {}),
      ...(action.receipt?.operation ? { operation: action.receipt.operation } : {}),
      ...(action.receipt?.resultStatus ? { resultStatus: action.receipt.resultStatus } : {}),
    },
  });
}

function buildExecutionReceiptFromCheckpoint(
  checkpoint: PlatformRuntimeCheckpoint,
): PlatformRuntimeExecutionReceipt | undefined {
  if (checkpoint.boundary !== "bootstrap" || !checkpoint.target?.bootstrapRequestId) {
    return undefined;
  }
  const capabilityId =
    checkpoint.executionContext?.bootstrapRequiredCapabilities?.length === 1
      ? checkpoint.executionContext.bootstrapRequiredCapabilities[0]
      : undefined;
  let status: PlatformRuntimeExecutionReceipt["status"];
  if (checkpoint.status === "completed") {
    status = "success";
  } else if (checkpoint.status === "denied" || checkpoint.status === "cancelled") {
    status = "failed";
  } else if (checkpoint.status === "approved" || checkpoint.status === "resumed") {
    status = "partial";
  } else {
    status = "blocked";
  }
  return PlatformRuntimeExecutionReceiptSchema.parse({
    kind: "capability",
    name: checkpoint.target.operation ?? "bootstrap.run",
    status,
    proof: checkpoint.status === "completed" ? "verified" : "derived",
    summary:
      checkpoint.status === "completed"
        ? "bootstrap checkpoint completed"
        : checkpoint.status === "denied"
          ? "bootstrap checkpoint denied"
          : checkpoint.status === "cancelled"
            ? "bootstrap checkpoint cancelled"
            : checkpoint.status === "approved" || checkpoint.status === "resumed"
              ? "bootstrap checkpoint awaiting completion"
              : "bootstrap checkpoint blocked",
    metadata: {
      checkpointId: checkpoint.id,
      bootstrapRequestId: checkpoint.target.bootstrapRequestId,
      ...(capabilityId ? { capabilityId } : {}),
      ...(checkpoint.boundary ? { boundary: checkpoint.boundary } : {}),
    },
  });
}

export function createPlatformRuntimeCheckpointService(params?: {
  stateDir?: string;
}): PlatformRuntimeCheckpointService {
  const checkpoints = new Map<string, PlatformRuntimeCheckpoint>();
  const actions = new Map<string, PlatformRuntimeAction>();
  const closures = new Map<string, PlatformRuntimeRunClosure>();
  // Tracks consecutive completed_without_evidence failures per requestRunId so the
  // semantic_retry budget exhausts correctly even when callers (e.g. the embedded
  // runner) do not thread recoveryAttemptCount across separate buildRunClosure calls.
  const noEvidenceRetryCounters = new Map<string, number>();
  const continuationHandlers = new Map<
    PlatformRuntimeContinuationKind,
    (checkpoint: PlatformRuntimeCheckpoint) => Promise<void> | void
  >();
  let stateDir = params?.stateDir;

  const persist = () => {
    if (!stateDir) {
      return;
    }
    const filePath = resolveRuntimeCheckpointStorePath(stateDir);
    const actionPath = resolveRuntimeActionStorePath(stateDir);
    const closurePath = resolveRuntimeClosureStorePath(stateDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const persistId = randomUUID();
    const tmpPath = `${filePath}.${process.pid}.${persistId}.tmp`;
    const actionTmpPath = `${actionPath}.${process.pid}.${persistId}.tmp`;
    const closureTmpPath = `${closurePath}.${process.pid}.${persistId}.tmp`;
    const payload = buildStorePayload(checkpoints);
    const actionPayload = buildActionStorePayload(actions);
    const closurePayload = buildClosureStorePayload(closures);
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.writeFileSync(actionTmpPath, JSON.stringify(actionPayload, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.writeFileSync(closureTmpPath, JSON.stringify(closurePayload, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    renameWithRetry(tmpPath, filePath);
    renameWithRetry(actionTmpPath, actionPath);
    renameWithRetry(closureTmpPath, closurePath);
  };

  const saveAction = (action: PlatformRuntimeAction) => {
    actions.set(action.actionId, action);
    persist();
    return action;
  };

  const mergeAction = (
    actionId: string,
    patch: Partial<Omit<PlatformRuntimeAction, "actionId" | "createdAtMs">>,
  ): PlatformRuntimeAction | undefined => {
    const existing = actions.get(actionId);
    if (!existing) {
      return undefined;
    }
    const mergedReceipt =
      patch.receipt || existing.receipt
        ? {
            ...existing.receipt,
            ...patch.receipt,
          }
        : undefined;
    const next = PlatformRuntimeActionSchema.parse({
      ...existing,
      ...patch,
      actionId: existing.actionId,
      createdAtMs: existing.createdAtMs,
      updatedAtMs: typeof patch.updatedAtMs === "number" ? patch.updatedAtMs : Date.now(),
      ...(mergedReceipt ? { receipt: mergedReceipt } : {}),
    });
    return saveAction(next);
  };

  const saveClosure = (closure: PlatformRuntimeRunClosure) => {
    closures.set(closure.runId, closure);
    persist();
    return closure;
  };

  return {
    configure(config) {
      if (config.stateDir) {
        stateDir = config.stateDir;
      }
    },
    createCheckpoint(checkpointParams) {
      const now = Date.now();
      const id =
        typeof checkpointParams.id === "string" && checkpointParams.id.trim()
          ? checkpointParams.id.trim()
          : randomUUID();
      const existing = checkpoints.get(id);
      const checkpoint = PlatformRuntimeCheckpointSchema.parse({
        id,
        runId: checkpointParams.runId,
        ...(checkpointParams.sessionKey ? { sessionKey: checkpointParams.sessionKey } : {}),
        boundary: checkpointParams.boundary,
        status: "blocked",
        ...(checkpointParams.blockedReason
          ? { blockedReason: checkpointParams.blockedReason }
          : {}),
        ...(checkpointParams.policyReasons?.length
          ? { policyReasons: checkpointParams.policyReasons }
          : {}),
        ...(checkpointParams.deniedReasons?.length
          ? { deniedReasons: checkpointParams.deniedReasons }
          : {}),
        ...(checkpointParams.nextActions?.length
          ? { nextActions: checkpointParams.nextActions }
          : {}),
        ...(checkpointParams.target ? { target: checkpointParams.target } : {}),
        ...(checkpointParams.continuation ? { continuation: checkpointParams.continuation } : {}),
        ...(checkpointParams.executionContext
          ? { executionContext: checkpointParams.executionContext }
          : {}),
        createdAtMs: existing?.createdAtMs ?? now,
        updatedAtMs: now,
        approvedAtMs: existing?.approvedAtMs,
        resumedAtMs: existing?.resumedAtMs,
        completedAtMs: existing?.completedAtMs,
        lastOperatorDecision: existing?.lastOperatorDecision,
      });
      checkpoints.set(id, checkpoint);
      persist();
      return checkpoint;
    },
    updateCheckpoint(id, patch) {
      const existing = checkpoints.get(id);
      if (!existing) {
        return undefined;
      }
      const next = PlatformRuntimeCheckpointSchema.parse({
        ...existing,
        ...patch,
        id: existing.id,
        createdAtMs: existing.createdAtMs,
        updatedAtMs: typeof patch.updatedAtMs === "number" ? patch.updatedAtMs : Date.now(),
      });
      checkpoints.set(id, next);
      persist();
      return next;
    },
    get(id) {
      return checkpoints.get(id);
    },
    stageAction(actionParams) {
      const now = Date.now();
      const existing = actions.get(actionParams.actionId);
      const action = PlatformRuntimeActionSchema.parse({
        actionId: actionParams.actionId,
        ...(actionParams.runId
          ? { runId: actionParams.runId }
          : existing?.runId
            ? { runId: existing.runId }
            : {}),
        ...(actionParams.sessionKey
          ? { sessionKey: actionParams.sessionKey }
          : existing?.sessionKey
            ? { sessionKey: existing.sessionKey }
            : {}),
        kind: actionParams.kind,
        state: existing?.state ?? "staged",
        ...(actionParams.boundary ? { boundary: actionParams.boundary } : {}),
        ...(actionParams.checkpointId ? { checkpointId: actionParams.checkpointId } : {}),
        ...(actionParams.idempotencyKey ? { idempotencyKey: actionParams.idempotencyKey } : {}),
        ...(actionParams.target ? { target: actionParams.target } : {}),
        ...((actionParams.receipt ?? existing?.receipt)
          ? { receipt: actionParams.receipt ?? existing?.receipt }
          : {}),
        attemptCount: existing?.attemptCount ?? 0,
        retryable: existing?.retryable,
        lastError: existing?.lastError,
        createdAtMs: existing?.createdAtMs ?? now,
        updatedAtMs: now,
        stagedAtMs: existing?.stagedAtMs ?? now,
        attemptedAtMs: existing?.attemptedAtMs,
        confirmedAtMs: existing?.confirmedAtMs,
        failedAtMs: existing?.failedAtMs,
      });
      return saveAction(action);
    },
    updateAction(actionId, patch) {
      return mergeAction(actionId, patch);
    },
    markActionAttempted(actionId, patch) {
      const existing = actions.get(actionId);
      if (!existing) {
        return undefined;
      }
      return mergeAction(actionId, {
        state: "attempted",
        attemptCount: existing.attemptCount + 1,
        attemptedAtMs: Date.now(),
        lastError: patch?.lastError,
        retryable: patch?.retryable,
        ...(patch?.receipt ? { receipt: patch.receipt } : {}),
      });
    },
    markActionConfirmed(actionId, patch) {
      return mergeAction(actionId, {
        state: "confirmed",
        confirmedAtMs: Date.now(),
        retryable: false,
        lastError: patch?.lastError,
        ...(patch?.receipt ? { receipt: patch.receipt } : {}),
      });
    },
    markActionFailed(actionId, patch) {
      return mergeAction(actionId, {
        state: "failed",
        failedAtMs: Date.now(),
        retryable: patch?.retryable,
        lastError: patch?.lastError,
        ...(patch?.receipt ? { receipt: patch.receipt } : {}),
      });
    },
    getAction(actionId) {
      return actions.get(actionId);
    },
    listActions(listParams) {
      return Array.from(actions.values())
        .filter((action) => (listParams?.runId ? action.runId === listParams.runId : true))
        .filter((action) =>
          listParams?.sessionKey ? action.sessionKey === listParams.sessionKey : true,
        )
        .filter((action) => (listParams?.kind ? action.kind === listParams.kind : true))
        .filter((action) => (listParams?.state ? action.state === listParams.state : true))
        .filter((action) =>
          listParams?.checkpointId ? action.checkpointId === listParams.checkpointId : true,
        )
        .filter((action) =>
          listParams?.idempotencyKey ? action.idempotencyKey === listParams.idempotencyKey : true,
        )
        .toSorted((left, right) => right.updatedAtMs - left.updatedAtMs)
        .map((action) =>
          PlatformRuntimeActionSummarySchema.parse({
            actionId: action.actionId,
            runId: action.runId,
            sessionKey: action.sessionKey,
            kind: action.kind,
            state: action.state,
            boundary: action.boundary,
            checkpointId: action.checkpointId,
            idempotencyKey: action.idempotencyKey,
            target: action.target,
            attemptCount: action.attemptCount,
            retryable: action.retryable,
            lastError: action.lastError,
            createdAtMs: action.createdAtMs,
            updatedAtMs: action.updatedAtMs,
            stagedAtMs: action.stagedAtMs,
            attemptedAtMs: action.attemptedAtMs,
            confirmedAtMs: action.confirmedAtMs,
            failedAtMs: action.failedAtMs,
          }),
        );
    },
    findByApprovalId(approvalId) {
      const normalized = approvalId.trim();
      if (!normalized) {
        return undefined;
      }
      for (const checkpoint of checkpoints.values()) {
        if (checkpoint.target?.approvalId === normalized) {
          return checkpoint;
        }
      }
      return undefined;
    },
    list(listParams) {
      return Array.from(checkpoints.values())
        .filter((checkpoint) =>
          listParams?.sessionKey ? checkpoint.sessionKey === listParams.sessionKey : true,
        )
        .filter((checkpoint) => (listParams?.runId ? checkpoint.runId === listParams.runId : true))
        .filter((checkpoint) =>
          listParams?.status ? checkpoint.status === listParams.status : true,
        )
        .toSorted((left, right) => right.updatedAtMs - left.updatedAtMs)
        .map((checkpoint) =>
          PlatformRuntimeCheckpointSummarySchema.parse({
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
                    ...(checkpoint.continuation.state
                      ? { state: checkpoint.continuation.state }
                      : {}),
                    ...(checkpoint.continuation.attempts !== undefined
                      ? { attempts: checkpoint.continuation.attempts }
                      : {}),
                    ...(checkpoint.continuation.lastError
                      ? { lastError: checkpoint.continuation.lastError }
                      : {}),
                    ...(checkpoint.continuation.lastDispatchedAtMs !== undefined
                      ? {
                          lastDispatchedAtMs: checkpoint.continuation.lastDispatchedAtMs,
                        }
                      : {}),
                    ...(checkpoint.continuation.lastCompletedAtMs !== undefined
                      ? {
                          lastCompletedAtMs: checkpoint.continuation.lastCompletedAtMs,
                        }
                      : {}),
                  },
                }
              : {}),
            ...(checkpoint.executionContext
              ? {
                  executionContext: checkpoint.executionContext,
                }
              : {}),
            createdAtMs: checkpoint.createdAtMs,
            updatedAtMs: checkpoint.updatedAtMs,
            ...(checkpoint.approvedAtMs !== undefined
              ? { approvedAtMs: checkpoint.approvedAtMs }
              : {}),
            ...(checkpoint.resumedAtMs !== undefined
              ? { resumedAtMs: checkpoint.resumedAtMs }
              : {}),
            ...(checkpoint.completedAtMs !== undefined
              ? { completedAtMs: checkpoint.completedAtMs }
              : {}),
            ...(checkpoint.lastOperatorDecision
              ? { lastOperatorDecision: checkpoint.lastOperatorDecision }
              : {}),
          }),
        );
    },
    buildRunOutcome(runId) {
      const normalized = runId.trim();
      if (!normalized) {
        return undefined;
      }
      const runCheckpoints = Array.from(checkpoints.values()).filter(
        (checkpoint) => checkpoint.runId === normalized,
      );
      const runActions = Array.from(actions.values()).filter(
        (action) => action.runId === normalized,
      );
      if (runCheckpoints.length === 0 && runActions.length === 0) {
        return undefined;
      }
      const blockedCheckpointIds = runCheckpoints
        .filter(
          (checkpoint) =>
            checkpoint.status === "blocked" ||
            checkpoint.status === "approved" ||
            checkpoint.status === "resumed",
        )
        .map((checkpoint) => checkpoint.id);
      const completedCheckpointIds = runCheckpoints
        .filter((checkpoint) => checkpoint.status === "completed")
        .map((checkpoint) => checkpoint.id);
      const deniedCheckpointIds = runCheckpoints
        .filter((checkpoint) => checkpoint.status === "denied" || checkpoint.status === "cancelled")
        .map((checkpoint) => checkpoint.id);
      const pendingApprovalIds = runCheckpoints
        .filter(
          (checkpoint) =>
            checkpoint.status === "blocked" ||
            checkpoint.status === "approved" ||
            checkpoint.status === "resumed",
        )
        .map((checkpoint) => checkpoint.target?.approvalId)
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
      const artifactIds = runCheckpoints
        .map((checkpoint) => checkpoint.target?.artifactId)
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
      const bootstrapRequestIds = runCheckpoints
        .map((checkpoint) => checkpoint.target?.bootstrapRequestId)
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
      const actionIds = runActions.map((action) => action.actionId);
      const attemptedActionIds = runActions
        .filter((action) => action.state === "attempted" || action.state === "partial")
        .map((action) => action.actionId);
      const confirmedActionIds = runActions
        .filter((action) => action.state === "confirmed")
        .map((action) => action.actionId);
      const failedActionIds = runActions
        .filter((action) => action.state === "failed")
        .map((action) => action.actionId);
      const status =
        blockedCheckpointIds.length > 0
          ? "blocked"
          : deniedCheckpointIds.length > 0
            ? "failed"
            : completedCheckpointIds.length > 0 || confirmedActionIds.length > 0
              ? "completed"
              : "partial";
      return PlatformRuntimeRunOutcomeSchema.parse({
        runId: normalized,
        status,
        checkpointIds: runCheckpoints.map((checkpoint) => checkpoint.id),
        blockedCheckpointIds,
        completedCheckpointIds,
        deniedCheckpointIds,
        pendingApprovalIds: Array.from(new Set(pendingApprovalIds)),
        artifactIds: Array.from(new Set(artifactIds)),
        bootstrapRequestIds: Array.from(new Set(bootstrapRequestIds)),
        actionIds: Array.from(new Set(actionIds)),
        attemptedActionIds: Array.from(new Set(attemptedActionIds)),
        confirmedActionIds: Array.from(new Set(confirmedActionIds)),
        failedActionIds: Array.from(new Set(failedActionIds)),
        boundaries: Array.from(new Set(runCheckpoints.map((checkpoint) => checkpoint.boundary))),
      });
    },
    buildAcceptanceEvidence(params) {
      const merged = buildIntentAwareEvidence({
        evidence: {
          ...params.evidence,
        },
        executionIntent: params.executionIntent,
      });
      if (params.executionVerification) {
        const receiptCounts = params.executionVerification.receiptCounts;
        const proofCounts = params.executionVerification.receiptProofCounts;
        merged.executionReceiptCount = params.executionVerification.receipts.length;
        merged.structuredExecutionReceiptCount = proofCounts.reported + proofCounts.verified;
        merged.verifiedExecutionReceiptCount = proofCounts.verified;
        merged.verifiedExecution =
          params.executionVerification.status === "verified" ||
          params.executionVerification.status === "warning";
        merged.executionWarningCount = receiptCounts.warning;
        merged.executionPartialCount = receiptCounts.partial;
        merged.degradedExecutionCount = receiptCounts.degraded;
        merged.executionContractMismatch =
          params.executionVerification.status === "mismatch" ||
          params.executionVerification.status === "failed";
        merged.noProgressSignals =
          params.executionVerification.status === "no_progress"
            ? Math.max(receiptCounts.blocked, 1)
            : receiptCounts.blocked;
      }
      if (params.executionSurface) {
        merged.executionSurfaceStatus = params.executionSurface.status;
        merged.executionSurfaceDegraded =
          params.executionSurface.status === "degraded" ||
          params.executionSurface.status === "unavailable";
        if (params.executionSurface.unattendedBoundary) {
          merged.executionUnattendedBoundary = params.executionSurface.unattendedBoundary;
        }
      }
      if (
        params.executionVerification &&
        hasStructuredArtifactToolOutputReceipt({
          receipts: params.executionVerification.receipts,
          artifactKinds: merged.declaredArtifactKinds,
          requestedToolNames: params.executionIntent?.requestedToolNames,
        })
      ) {
        merged.hasOutput = true;
      }
      return merged;
    },
    buildExecutionIntent(params) {
      const seed = params.executionIntent ?? {};
      return PlatformRuntimeExecutionIntentSchema.parse({
        runId: params.runId.trim(),
        ...(seed.profileId ? { profileId: seed.profileId } : {}),
        ...(seed.recipeId ? { recipeId: seed.recipeId } : {}),
        ...(seed.taskOverlayId ? { taskOverlayId: seed.taskOverlayId } : {}),
        ...(seed.plannerReasoning ? { plannerReasoning: seed.plannerReasoning } : {}),
        ...(seed.intent ? { intent: seed.intent } : {}),
        ...(normalizeOptionalStringArray(seed.publishTargets)
          ? { publishTargets: normalizeOptionalStringArray(seed.publishTargets) }
          : {}),
        ...(normalizeOptionalStringArray(seed.artifactKinds)
          ? { artifactKinds: normalizeOptionalStringArray(seed.artifactKinds) }
          : {}),
        ...(normalizeOptionalStringArray(seed.requestedToolNames)
          ? { requestedToolNames: normalizeOptionalStringArray(seed.requestedToolNames) }
          : {}),
        ...(seed.deliverable ? { deliverable: seed.deliverable } : {}),
        ...(seed.outcomeContract ? { outcomeContract: seed.outcomeContract } : {}),
        ...(seed.executionContract ? { executionContract: seed.executionContract } : {}),
        ...(normalizeOptionalStringArray(seed.requestedEvidence)
          ? { requestedEvidence: normalizeOptionalStringArray(seed.requestedEvidence) }
          : {}),
        ...(seed.lowConfidenceStrategy
          ? { lowConfidenceStrategy: seed.lowConfidenceStrategy }
          : {}),
        ...(normalizeOptionalStringArray(seed.requiredCapabilities)
          ? { requiredCapabilities: normalizeOptionalStringArray(seed.requiredCapabilities) }
          : {}),
        ...(normalizeOptionalStringArray(seed.bootstrapRequiredCapabilities)
          ? {
              bootstrapRequiredCapabilities: normalizeOptionalStringArray(
                seed.bootstrapRequiredCapabilities,
              ),
            }
          : {}),
        ...(seed.requireExplicitApproval !== undefined
          ? { requireExplicitApproval: seed.requireExplicitApproval }
          : {}),
        ...(seed.policyAutonomy ? { policyAutonomy: seed.policyAutonomy } : {}),
        ...(seed.classifierTelemetry ? { classifierTelemetry: seed.classifierTelemetry } : {}),
        ...(seed.routingOutcome ? { routingOutcome: seed.routingOutcome } : {}),
        expectations: PlatformRuntimeExecutionContractSchema.shape.expectations.parse(
          seed.expectations ?? {},
        ),
      });
    },
    buildExecutionContract(params) {
      const outcome = normalizeRunOutcome(params.outcome) ?? this.buildRunOutcome(params.runId);
      const executionIntent = params.executionIntent
        ? this.buildExecutionIntent({
            runId: params.runId,
            executionIntent: params.executionIntent,
          })
        : undefined;
      const evidence = this.buildAcceptanceEvidence({
        outcome:
          outcome ??
          PlatformRuntimeRunOutcomeSchema.parse({
            runId: params.runId.trim(),
            status: "partial",
            checkpointIds: [],
            blockedCheckpointIds: [],
            completedCheckpointIds: [],
            deniedCheckpointIds: [],
            pendingApprovalIds: [],
            artifactIds: [],
            bootstrapRequestIds: [],
            actionIds: [],
            attemptedActionIds: [],
            confirmedActionIds: [],
            failedActionIds: [],
            boundaries: [],
          }),
        evidence: params.evidence,
        executionIntent,
      });
      return PlatformRuntimeExecutionContractSchema.parse({
        runId: params.runId.trim(),
        receipts: this.buildExecutionReceipts({
          runId: params.runId,
          outcome,
          receipts: params.receipts,
        }),
        expectations: deriveExecutionContractExpectations({
          outcome:
            outcome ??
            PlatformRuntimeRunOutcomeSchema.parse({
              runId: params.runId.trim(),
              status: "partial",
              checkpointIds: [],
              blockedCheckpointIds: [],
              completedCheckpointIds: [],
              deniedCheckpointIds: [],
              pendingApprovalIds: [],
              artifactIds: [],
              bootstrapRequestIds: [],
              actionIds: [],
              attemptedActionIds: [],
              confirmedActionIds: [],
              failedActionIds: [],
              boundaries: [],
            }),
          evidence,
          executionIntent,
        }),
      });
    },
    buildExecutionReceipts(params) {
      const normalizedRunId = params.runId.trim();
      if (!normalizedRunId) {
        return [];
      }
      const explicitReceipts = (params.receipts ?? []).map((receipt) =>
        PlatformRuntimeExecutionReceiptSchema.parse({
          ...receipt,
          ...(normalizeReasons(receipt.reasons)
            ? { reasons: normalizeReasons(receipt.reasons) }
            : {}),
        }),
      );
      const actionIds = new Set(params.outcome?.actionIds ?? []);
      const actionReceipts = Array.from(actions.values())
        .filter((action) => action.runId === normalizedRunId)
        .filter((action) => actionIds.size === 0 || actionIds.has(action.actionId))
        .map((action) => buildExecutionReceiptFromAction(action))
        .filter((receipt): receipt is PlatformRuntimeExecutionReceipt => Boolean(receipt));
      const checkpointIds = new Set(params.outcome?.checkpointIds ?? []);
      const checkpointReceipts = Array.from(checkpoints.values())
        .filter((checkpoint) => checkpoint.runId === normalizedRunId)
        .filter((checkpoint) => checkpointIds.size === 0 || checkpointIds.has(checkpoint.id))
        .map((checkpoint) => buildExecutionReceiptFromCheckpoint(checkpoint))
        .filter((receipt): receipt is PlatformRuntimeExecutionReceipt => Boolean(receipt));
      return [...explicitReceipts, ...actionReceipts, ...checkpointReceipts]
        .toSorted((left, right) =>
          buildExecutionReceiptKey(left).localeCompare(buildExecutionReceiptKey(right)),
        )
        .filter((receipt, index, all) => {
          if (index === 0) {
            return true;
          }
          return buildExecutionReceiptKey(receipt) !== buildExecutionReceiptKey(all[index - 1]);
        });
    },
    buildRunClosure(params) {
      // Derive the request-scoped no-evidence retry counter.
      // The embedded runner never threads recoveryAttemptCount across separate
      // closure calls, so we maintain the count internally and inject it here.
      // When a caller already supplies a higher count, we defer to the caller.
      const requestKey = (params.requestRunId ?? params.runId).trim();
      const trackedAttemptCount = noEvidenceRetryCounters.get(requestKey) ?? 0;
      const resolvedEvidence: PlatformRuntimeAcceptanceEvidence | undefined =
        params.evidence !== undefined
          ? {
              ...params.evidence,
              ...(trackedAttemptCount > 0 &&
              (params.evidence.recoveryAttemptCount === undefined ||
                params.evidence.recoveryAttemptCount < trackedAttemptCount)
                ? { recoveryAttemptCount: trackedAttemptCount }
                : {}),
            }
          : params.evidence;

      const outcome =
        normalizeRunOutcome(params.outcome) ??
        this.buildRunOutcome(params.runId) ??
        PlatformRuntimeRunOutcomeSchema.parse({
          runId: params.runId.trim(),
          status: "partial",
          checkpointIds: [],
          blockedCheckpointIds: [],
          completedCheckpointIds: [],
          deniedCheckpointIds: [],
          pendingApprovalIds: [],
          artifactIds: [],
          bootstrapRequestIds: [],
          actionIds: [],
          attemptedActionIds: [],
          confirmedActionIds: [],
          failedActionIds: [],
          boundaries: [],
        });
      const executionIntent = this.buildExecutionIntent({
        runId: params.runId,
        executionIntent: params.executionIntent,
      });
      const verificationEvidence = buildIntentAwareEvidence({
        evidence: resolvedEvidence ?? {},
        executionIntent,
      });
      const contract = this.buildExecutionContract({
        runId: params.runId,
        outcome,
        receipts: params.receipts,
        evidence: resolvedEvidence,
        executionIntent,
      });
      const executionVerification = this.verifyExecutionContract({
        contract,
        outcome,
        evidence: verificationEvidence,
      });
      const evidence = this.buildAcceptanceEvidence({
        outcome,
        evidence: resolvedEvidence,
        executionVerification,
        executionSurface: params.executionSurface,
        executionIntent,
      });
      const acceptanceOutcome = this.evaluateAcceptance({
        runId: params.runId,
        outcome,
        evidence,
        receipts: contract.receipts,
      });
      const supervisorVerdict = this.evaluateSupervisorVerdict({
        runId: params.runId,
        acceptance: acceptanceOutcome,
        verification: executionVerification,
        surface: params.executionSurface,
      });

      // Maintain the no-evidence retry counter for this request key.
      // Track both completed_without_evidence (direct evidence gate) and
      // contract_mismatch with semantic_retry (the full buildRunClosure path,
      // where contract verification fires first). Both indicate the model
      // replied with text but no tool evidence was observed.
      // Increment when the gate fired but the budget is not yet exhausted.
      // Clear when the run succeeds or reaches any terminal stop/escalate.
      const isNoEvidenceOutcome =
        acceptanceOutcome.reasonCode === "completed_without_evidence" ||
        (acceptanceOutcome.reasonCode === "contract_mismatch" &&
          acceptanceOutcome.remediation === "semantic_retry");
      if (
        isNoEvidenceOutcome &&
        supervisorVerdict.action !== "stop" &&
        supervisorVerdict.action !== "escalate"
      ) {
        noEvidenceRetryCounters.set(requestKey, trackedAttemptCount + 1);
      } else {
        noEvidenceRetryCounters.delete(requestKey);
      }

      return PlatformRuntimeRunClosureSchema.parse({
        runId: params.runId.trim(),
        ...(params.requestRunId ? { requestRunId: params.requestRunId } : {}),
        ...(params.parentRunId ? { parentRunId: params.parentRunId } : {}),
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        updatedAtMs: Date.now(),
        outcome,
        executionIntent,
        ...(params.executionSurface ? { executionSurface: params.executionSurface } : {}),
        executionVerification,
        acceptanceOutcome,
        supervisorVerdict,
      });
    },
    verifyExecutionContract(params) {
      const contract = PlatformRuntimeExecutionContractSchema.parse(params.contract);
      const receipts = contract.receipts.map((receipt) =>
        PlatformRuntimeExecutionReceiptSchema.parse({
          ...receipt,
          ...(normalizeReasons(receipt.reasons)
            ? { reasons: normalizeReasons(receipt.reasons) }
            : {}),
        }),
      );
      const evidence = params.evidence ?? {};
      const counts = buildExecutionReceiptCounts(receipts);
      const proofCounts = buildExecutionReceiptProofCounts(receipts);
      const reasons: string[] = [];
      const expectations = contract.expectations;
      const hasBlockedNoProgress = receipts.some((receipt) => receipt.status === "blocked");
      const hasFailedReceipt = counts.failed > 0;
      const hasTerminalFailedReceipt = receipts.some(
        (receipt) =>
          receipt.status === "failed" &&
          !receipts.some(
            (candidate) =>
              candidate.status === "success" &&
              candidate.kind === receipt.kind &&
              candidate.name === receipt.name &&
              (receipt.summary ? candidate.summary === receipt.summary : true),
          ),
      );
      const hasDegradedReceipt = counts.degraded > 0;
      const hasPartialReceipt = counts.partial > 0;
      const hasWarningReceipt = counts.warning > 0;
      const missingReceiptKinds = Array.from(
        new Set(
          (expectations?.requiredReceiptKinds ?? []).filter(
            (kind) =>
              !receipts.some((receipt) => receipt.kind === kind && receipt.proof === "verified"),
          ),
        ),
      );
      const allowStandaloneEvidence = expectations?.allowStandaloneEvidence === true;
      const verifiedConfirmedDeliveryCount = receipts.filter(
        (receipt) => receipt.kind === "messaging_delivery" && receipt.proof === "verified",
      ).length;
      const confirmedDeliveryCount = Math.max(
        evidence.confirmedDeliveryCount ?? 0,
        evidence.deliveredReplyCount ?? 0,
        verifiedConfirmedDeliveryCount,
      );
      const sufficiency = isCompletionEvidenceSufficient({
        executionIntent: buildExecutionIntentFromEvidence({
          runId: contract.runId,
          evidence,
          expectations,
        }),
        expectations,
        receipts,
        evidence,
        outcome: params.outcome,
      });
      const requiresStructuredOutput = requiresStructuredEvidence({
        outcomeContract: sufficiency.requirements.outcomeContract,
        artifactKinds: evidence.declaredArtifactKinds,
        executionContract: sufficiency.requirements.executionContract,
      });
      const hasOutput = requiresStructuredOutput
        ? sufficiency.observed.artifactDescriptor ||
          sufficiency.observed.toolReceipt ||
          sufficiency.observed.processReceipt
        : evidence.hasOutput === true || evidence.hasStructuredReplyPayload === true;
      const declaredIntent = describeDeclaredIntent(evidence);
      const confirmedActionCount =
        evidence.confirmedActionCount ?? params.outcome?.confirmedActionIds.length ?? 0;
      const hasStandaloneOutcomeEvidence =
        hasOutput ||
        confirmedDeliveryCount > 0 ||
        confirmedActionCount > 0 ||
        (params.outcome?.artifactIds.length ?? 0) > 0 ||
        (params.outcome?.bootstrapRequestIds.length ?? 0) > 0 ||
        (evidence.successfulCronAdds ?? 0) > 0;

      if (hasBlockedNoProgress) {
        reasons.push("Execution receipts show no_progress on one or more tool or runtime paths.");
      }
      if (hasTerminalFailedReceipt) {
        reasons.push("Execution receipts contain a failed outcome.");
      }
      if (requiresStructuredOutput && !sufficiency.sufficient) {
        reasons.push(...sufficiency.reasons);
      }
      if (expectations?.requiresMessagingDelivery && confirmedDeliveryCount === 0) {
        reasons.push(
          declaredIntent
            ? `Execution contract for ${declaredIntent} expected confirmed delivery, but no delivery receipt was verified.`
            : "Execution contract expected confirmed delivery, but no delivery receipt was verified.",
        );
      }
      if (expectations?.requiresOutput && !hasOutput) {
        reasons.push(
          declaredIntent
            ? `Execution contract for ${declaredIntent} expected output, but no output evidence was observed.`
            : "Execution contract expected output, but no output evidence was observed.",
        );
      }
      if (expectations?.requiresConfirmedAction && confirmedActionCount === 0) {
        reasons.push(
          declaredIntent
            ? `Execution contract for ${declaredIntent} expected a confirmed runtime action, but none was observed.`
            : "Execution contract expected a confirmed runtime action, but none was observed.",
        );
      }
      if (expectations?.requireStructuredReceipts && proofCounts.derived === receipts.length) {
        reasons.push(
          "Execution contract required structured receipts, but only derived or fallback receipts were available.",
        );
      }
      if (
        (expectations?.minimumVerifiedReceiptCount ?? 0) > 0 &&
        proofCounts.verified < (expectations?.minimumVerifiedReceiptCount ?? 0)
      ) {
        reasons.push(
          `Execution contract expected at least ${String(
            expectations?.minimumVerifiedReceiptCount ?? 0,
          )} verified receipt(s), but only ${String(proofCounts.verified)} were observed.`,
        );
      }
      if (missingReceiptKinds.length > 0) {
        reasons.push(
          `Execution contract is missing verified receipt kind(s): ${missingReceiptKinds.join(", ")}.`,
        );
      }

      let status: PlatformRuntimeExecutionVerification["status"] = "verified";
      if (hasBlockedNoProgress) {
        status = "no_progress";
      } else if (hasTerminalFailedReceipt || reasons.length > 0) {
        status = "mismatch";
      } else if (hasDegradedReceipt) {
        status = "degraded";
        reasons.push("Execution completed in a degraded state.");
      } else if (hasPartialReceipt) {
        status = expectations?.allowPartial ? "warning" : "mismatch";
        reasons.push(
          expectations?.allowPartial
            ? "Execution completed partially but the contract allows partial receipts."
            : "Execution contract was only partially satisfied.",
        );
      } else if (hasWarningReceipt) {
        status = expectations?.allowWarnings ? "warning" : "mismatch";
        reasons.push(
          expectations?.allowWarnings
            ? "Execution completed with warnings allowed by the contract."
            : "Execution receipts contain warnings that the contract does not allow.",
        );
      } else if (receipts.length === 0) {
        if (hasStandaloneOutcomeEvidence && allowStandaloneEvidence) {
          status = "verified";
          reasons.push(
            "Execution closed on standalone output or delivery evidence without explicit receipts.",
          );
        } else {
          status = "mismatch";
          reasons.push(
            allowStandaloneEvidence
              ? "Execution contract verification had no receipts to verify."
              : "Execution contract requires receipts and cannot close on standalone evidence alone.",
          );
        }
      } else if (proofCounts.verified === 0 && proofCounts.reported === 0) {
        if (allowStandaloneEvidence && hasStandaloneOutcomeEvidence) {
          status = "warning";
          reasons.push(
            "Execution relied on derived receipts plus standalone evidence instead of verified runtime receipts.",
          );
        } else {
          status = "mismatch";
          reasons.push(
            "Execution receipts were only derived and cannot verify closure on their own.",
          );
        }
      }

      return PlatformRuntimeExecutionVerificationSchema.parse({
        runId: contract.runId,
        status,
        reasons: Array.from(new Set(reasons)),
        receipts,
        receiptCounts: counts,
        receiptProofCounts: proofCounts,
        ...(missingReceiptKinds.length > 0 ? { missingReceiptKinds } : {}),
        ...(receipts.length === 0 && hasStandaloneOutcomeEvidence && allowStandaloneEvidence
          ? { usedStandaloneEvidence: true }
          : {}),
        checkedAtMs: contract.checkedAtMs ?? Date.now(),
      });
    },
    evaluateAcceptance(params) {
      const evidence = this.buildAcceptanceEvidence({
        outcome: params.outcome,
        evidence: params.evidence,
      });
      const sufficiency = isCompletionEvidenceSufficient({
        executionIntent: buildExecutionIntentFromEvidence({
          runId: params.runId,
          evidence,
        }),
        receipts: params.receipts ?? [],
        evidence,
        outcome: params.outcome,
      });
      const declaredIntent = describeDeclaredIntent(evidence);
      const reasons: string[] = [];
      if (params.outcome.pendingApprovalIds.length > 0) {
        reasons.push("Run still requires operator approval before the task can finish.");
        return parseAcceptanceResult({
          runId: params.runId,
          status: "needs_human",
          action: "escalate",
          reasonCode: "pending_approval",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      if (params.outcome.status === "blocked") {
        reasons.push("Run is blocked on a runtime boundary and cannot safely auto-complete.");
        return parseAcceptanceResult({
          runId: params.runId,
          status: "needs_human",
          action: "escalate",
          reasonCode: "runtime_blocked",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      if (params.outcome.status === "failed") {
        reasons.push("Run reached a failed runtime outcome.");
        return parseAcceptanceResult({
          runId: params.runId,
          status: "failed",
          action: "stop",
          reasonCode:
            classifyProviderEvidence(evidence) === "auth_refresh"
              ? "provider_auth_required"
              : classifyProviderEvidence(evidence) === "provider_fallback"
                ? "provider_fallback_exhausted"
                : "runtime_failed",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      if (evidence.noProgressSignals && evidence.noProgressSignals > 0) {
        reasons.push("Run hit a bounded no-progress path and needs supervisor recovery.");
        return parseAcceptanceResult({
          runId: params.runId,
          status: "retryable",
          action: "retry",
          reasonCode: "execution_no_progress",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      if (evidence.executionContractMismatch === true) {
        reasons.push(
          declaredIntent
            ? `Run completed, but the verified execution contract for ${declaredIntent} does not match the requested outcome.`
            : "Run completed, but the verified execution contract does not match the requested outcome.",
        );
        return parseAcceptanceResult({
          runId: params.runId,
          status: "retryable",
          action: "retry",
          reasonCode:
            evidence.executionSurfaceStatus === "bootstrap_required" ||
            evidence.executionUnattendedBoundary === "bootstrap" ||
            (evidence.bootstrapReceiptCount ?? params.outcome.bootstrapRequestIds.length) > 0
              ? "bootstrap_required"
              : classifyProviderEvidence(evidence) === "auth_refresh"
                ? "provider_auth_required"
                : classifyProviderEvidence(evidence) === "provider_fallback"
                  ? "provider_fallback_exhausted"
                  : "contract_mismatch",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      if (
        (evidence.degradedExecutionCount ?? 0) > 0 ||
        evidence.executionSurfaceDegraded === true
      ) {
        reasons.push("Run completed, but execution truth remained degraded.");
        return parseAcceptanceResult({
          runId: params.runId,
          status: "partial",
          action: "retry",
          reasonCode:
            evidence.executionSurfaceStatus === "bootstrap_required" ||
            evidence.executionUnattendedBoundary === "bootstrap" ||
            (evidence.bootstrapReceiptCount ?? params.outcome.bootstrapRequestIds.length) > 0
              ? "bootstrap_required"
              : classifyProviderEvidence(evidence) === "auth_refresh"
                ? "provider_auth_required"
                : classifyProviderEvidence(evidence) === "provider_fallback"
                  ? "provider_fallback_exhausted"
                  : "execution_degraded",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      // Block completion when execution contracts require real evidence but none was observed.
      // structured_artifact: requires matching tool receipt (pdf, image_generate, etc.)
      // interactive_local_result: requires process / local-execution evidence
      // workspace_change: requires at least one successful tool receipt (write/exec/apply_patch)
      // text_response: no gate — hasOutput alone is sufficient
      const requiresEvidencedCompletion =
        sufficiency.requirements.requiresStructuredEvidence ||
        sufficiency.requirements.executionContract.requiresLocalProcess === true ||
        sufficiency.requirements.executionContract.requiresWorkspaceMutation === true;
      if (requiresEvidencedCompletion && !sufficiency.sufficient) {
        reasons.push(...sufficiency.reasons);
        return parseAcceptanceResult({
          runId: params.runId,
          status: "retryable",
          action: "retry",
          reasonCode:
            evidence.executionSurfaceStatus === "bootstrap_required" ||
            evidence.executionUnattendedBoundary === "bootstrap" ||
            (evidence.bootstrapReceiptCount ?? params.outcome.bootstrapRequestIds.length) > 0
              ? "bootstrap_required"
              : "completed_without_evidence",
          reasons: Array.from(new Set(reasons)),
          outcome: params.outcome,
          evidence,
        });
      }
      if (params.outcome.status === "partial") {
        reasons.push("Run finished with only a partial runtime outcome.");
        return parseAcceptanceResult({
          runId: params.runId,
          status: "retryable",
          action: "retry",
          reasonCode: "runtime_partial",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      const confirmedDeliveryCount =
        evidence.confirmedDeliveryCount ?? evidence.deliveredReplyCount ?? 0;
      const attemptedDeliveryCount = evidence.attemptedDeliveryCount ?? 0;
      const failedDeliveryCount = evidence.failedDeliveryCount ?? 0;
      const attemptedActionCount =
        evidence.attemptedActionCount ?? params.outcome.attemptedActionIds.length;
      const confirmedActionCount =
        evidence.confirmedActionCount ?? params.outcome.confirmedActionIds.length;
      const failedActionCount = evidence.failedActionCount ?? params.outcome.failedActionIds.length;
      if (attemptedDeliveryCount > 0 && confirmedDeliveryCount === 0 && failedDeliveryCount > 0) {
        reasons.push(
          "Run completed, but delivery attempts failed before any message was confirmed.",
        );
        return parseAcceptanceResult({
          runId: params.runId,
          status: "retryable",
          action: "retry",
          reasonCode: "delivery_failed",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      if (
        evidence.partialDelivery === true ||
        (confirmedDeliveryCount > 0 && failedDeliveryCount > 0)
      ) {
        reasons.push("Run completed, but delivery only partially succeeded.");
        return parseAcceptanceResult({
          runId: params.runId,
          status: "partial",
          action: "retry",
          reasonCode: "delivery_partial",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      const artifactReceiptCount =
        evidence.artifactReceiptCount ?? params.outcome.artifactIds.length;
      const bootstrapReceiptCount =
        evidence.bootstrapReceiptCount ?? params.outcome.bootstrapRequestIds.length;
      const bootstrapStillRequired =
        evidence.executionSurfaceStatus === "bootstrap_required" ||
        evidence.executionUnattendedBoundary === "bootstrap" ||
        params.outcome.blockedCheckpointIds.length > 0 ||
        params.outcome.pendingApprovalIds.length > 0
          ? bootstrapReceiptCount
          : 0;
      const hasDeliverableEvidence =
        artifactReceiptCount > 0 ||
        evidence.didSendViaMessagingTool === true ||
        evidence.hasOutput === true ||
        evidence.hasStructuredReplyPayload === true ||
        confirmedDeliveryCount > 0 ||
        confirmedActionCount > 0 ||
        (evidence.successfulCronAdds ?? 0) > 0;
      const hasExecBackedProcessClosureEvidence =
        sufficiency.requirements.executionContract.requiresLocalProcess === true &&
        sufficiency.requirements.executionContract.requiresWorkspaceMutation !== true &&
        sufficiency.observed.toolReceipt &&
        sufficiency.observed.processReceipt;
      const requiresVerifiedNonMessagingClosure =
        attemptedDeliveryCount === 0 &&
        confirmedDeliveryCount === 0 &&
        !hasExecBackedProcessClosureEvidence &&
        (artifactReceiptCount > 0 ||
          bootstrapStillRequired > 0 ||
          attemptedActionCount > 0 ||
          confirmedActionCount > 0 ||
          failedActionCount > 0);
      if (
        attemptedDeliveryCount === 0 &&
        confirmedDeliveryCount === 0 &&
        attemptedActionCount > 0 &&
        confirmedActionCount === 0 &&
        failedActionCount > 0
      ) {
        reasons.push(
          "Run completed, but replay-sensitive actions failed before any receipt was confirmed.",
        );
        return parseAcceptanceResult({
          runId: params.runId,
          status: "retryable",
          action: "retry",
          reasonCode: "completed_without_evidence",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      if (
        requiresVerifiedNonMessagingClosure &&
        (evidence.verifiedExecutionReceiptCount ?? 0) === 0
      ) {
        reasons.push(
          declaredIntent
            ? `Run completed on a non-messaging execution path for ${declaredIntent}, but no verified structured receipt proved the final closure.`
            : "Run completed on a non-messaging execution path, but no verified structured receipt proved the final closure.",
        );
        return parseAcceptanceResult({
          runId: params.runId,
          status: "retryable",
          action: "retry",
          reasonCode:
            evidence.executionSurfaceStatus === "bootstrap_required" ||
            evidence.executionUnattendedBoundary === "bootstrap" ||
            bootstrapStillRequired > 0
              ? "bootstrap_required"
              : classifyProviderEvidence(evidence) === "auth_refresh"
                ? "provider_auth_required"
                : classifyProviderEvidence(evidence) === "provider_fallback"
                  ? "provider_fallback_exhausted"
                  : "contract_mismatch",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      if (bootstrapStillRequired > 0) {
        reasons.push("Run paused while capability bootstrap is still required before completion.");
        return parseAcceptanceResult({
          runId: params.runId,
          status: "retryable",
          action: "retry",
          reasonCode: "bootstrap_required",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      if (evidence.hadToolError === true && hasDeliverableEvidence) {
        reasons.push(
          "Run completed with deliverable evidence, but one or more tool errors were observed.",
        );
        return parseAcceptanceResult({
          runId: params.runId,
          status: "partial",
          action: "stop",
          reasonCode: "completed_with_warnings",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      if (artifactReceiptCount > 0) {
        reasons.push("Run completed and produced structured platform artifacts.");
        return parseAcceptanceResult({
          runId: params.runId,
          status: "satisfied",
          action: "close",
          reasonCode: "completed_with_artifacts",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      if (confirmedDeliveryCount > 0) {
        reasons.push("Run completed and delivery was confirmed by the outbound runtime.");
        return parseAcceptanceResult({
          runId: params.runId,
          status: "satisfied",
          action: "close",
          reasonCode: "completed_with_confirmed_delivery",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      if (hasDeliverableEvidence) {
        reasons.push(
          declaredIntent
            ? `Run completed with evidence matching the declared ${declaredIntent}.`
            : "Run completed with user-visible or automation-visible output.",
        );
        return parseAcceptanceResult({
          runId: params.runId,
          status: "satisfied",
          action: "close",
          reasonCode: "completed_with_output",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      reasons.push(
        declaredIntent
          ? `Run completed for ${declaredIntent}, but no machine-checkable delivery evidence was observed.`
          : "Run completed but no machine-checkable delivery evidence was observed.",
      );
      return parseAcceptanceResult({
        runId: params.runId,
        status: "retryable",
        action: "retry",
        reasonCode: "completed_without_evidence",
        reasons,
        outcome: params.outcome,
        evidence,
      });
    },
    evaluateSupervisorVerdict(params) {
      if (params.surface) {
        PlatformRuntimeExecutionSurfaceSchema.parse(params.surface);
      }
      const acceptance = params.acceptance;
      const verification = params.verification;
      const reasons: string[] = [];
      if (acceptance?.action === "retry" && acceptance.recoveryPolicy.exhausted) {
        const exhaustedAction = acceptance.recoveryPolicy.exhaustedAction;
        reasons.push(...acceptance.reasons);
        reasons.push(
          `Recovery budget exhausted after ${acceptance.recoveryPolicy.attemptCount}/${acceptance.recoveryPolicy.maxAttempts} attempts.`,
        );
        return parseSupervisorVerdict({
          runId: params.runId,
          status: exhaustedAction === "escalate" ? "needs_human" : "failed",
          action: exhaustedAction,
          reasonCode: "recovery_budget_exhausted",
          reasons: Array.from(new Set(reasons)),
          acceptance,
          verification,
          surface: params.surface,
        });
      }
      if (acceptance?.status === "needs_human") {
        return parseSupervisorVerdict({
          runId: params.runId,
          status: "needs_human",
          action: "escalate",
          reasonCode: "needs_human",
          reasons: acceptance.reasons,
          acceptance,
          verification,
          surface: params.surface,
        });
      }
      if (acceptance?.status === "failed") {
        return parseSupervisorVerdict({
          runId: params.runId,
          status: "failed",
          action: "stop",
          reasonCode: resolveSupervisorReasonCode({
            acceptance,
            verification,
            surface: params.surface,
            fallbackReasonCode: "runtime_failed",
          }),
          reasons: acceptance.reasons,
          acceptance,
          verification,
          surface: params.surface,
        });
      }
      if (verification?.status === "no_progress") {
        reasons.push(...verification.reasons);
        return parseSupervisorVerdict({
          runId: params.runId,
          status: "retryable",
          action: "retry",
          reasonCode: resolveSupervisorReasonCode({
            acceptance,
            verification,
            surface: params.surface,
            fallbackReasonCode: "execution_no_progress",
          }),
          reasons: Array.from(new Set(reasons)),
          acceptance,
          verification,
          surface: params.surface,
        });
      }
      if (verification?.status === "mismatch" || verification?.status === "failed") {
        reasons.push(...verification.reasons);
        return parseSupervisorVerdict({
          runId: params.runId,
          status: acceptance?.status ?? "retryable",
          action: acceptance?.action === "escalate" ? "escalate" : "retry",
          reasonCode: resolveSupervisorReasonCode({
            acceptance,
            verification,
            surface: params.surface,
            fallbackReasonCode: "contract_mismatch",
          }),
          reasons: Array.from(new Set(reasons)),
          acceptance,
          verification,
          surface: params.surface,
        });
      }
      if (
        verification?.status === "degraded" ||
        params.surface?.status === "degraded" ||
        params.surface?.status === "unavailable"
      ) {
        reasons.push(...(verification?.reasons ?? []));
        reasons.push(...(params.surface?.reasons ?? []));
        return parseSupervisorVerdict({
          runId: params.runId,
          status: "retryable",
          action: acceptance?.action === "escalate" ? "escalate" : "retry",
          reasonCode: resolveSupervisorReasonCode({
            acceptance,
            verification,
            surface: params.surface,
            fallbackReasonCode: "execution_degraded",
          }),
          reasons: Array.from(new Set(reasons)),
          acceptance,
          verification,
          surface: params.surface,
        });
      }
      return parseSupervisorVerdict({
        runId: params.runId,
        status: acceptance?.status ?? "satisfied",
        action: acceptance?.action ?? "close",
        reasonCode: resolveSupervisorReasonCode({
          acceptance,
          verification,
          surface: params.surface,
          fallbackReasonCode:
            acceptance && acceptance.action !== "close"
              ? "transient_recoverable"
              : "verified_execution",
        }),
        reasons: acceptance?.reasons ??
          verification?.reasons ?? ["Execution contract was verified before final closure."],
        acceptance,
        verification,
        surface: params.surface,
      });
    },
    recordRunClosure(closure) {
      const saved = saveClosure(PlatformRuntimeRunClosureSchema.parse(closure));
      emitRunClosureSummary(buildRunClosureSummary(saved));
      return saved;
    },
    getRunClosure(runId) {
      const normalized = runId.trim();
      return normalized ? closures.get(normalized) : undefined;
    },
    listRunClosures(listParams) {
      return Array.from(closures.values())
        .filter((closure) =>
          listParams?.sessionKey ? closure.sessionKey === listParams.sessionKey : true,
        )
        .filter((closure) =>
          listParams?.requestRunId ? closure.requestRunId === listParams.requestRunId : true,
        )
        .toSorted((left, right) => right.updatedAtMs - left.updatedAtMs);
    },
    registerContinuationHandler(kind, handler) {
      continuationHandlers.set(kind, handler);
    },
    async dispatchContinuation(checkpointId) {
      const checkpoint = checkpoints.get(checkpointId);
      if (!checkpoint?.continuation?.kind) {
        return checkpoint;
      }
      const handler = continuationHandlers.get(checkpoint.continuation.kind);
      if (!handler) {
        return checkpoint;
      }
      const currentContinuation = checkpoint.continuation;
      const kind = checkpoint.continuation.kind;
      const running = this.updateCheckpoint(checkpointId, {
        continuation: {
          ...currentContinuation,
          state: "running",
          attempts: (currentContinuation.attempts ?? 0) + 1,
          lastError: undefined,
          lastDispatchedAtMs: Date.now(),
        },
      });
      if (kind === "closure_recovery") {
        emitRuntimeRecoveryTelemetry({
          runId: checkpoint.runId,
          ...(checkpoint.sessionKey ? { sessionKey: checkpoint.sessionKey } : {}),
          milestone: "continuation_dispatch_start",
          checkpointId,
          continuationKind: kind,
          ...(checkpoint.target?.approvalId ? { approvalId: checkpoint.target.approvalId } : {}),
        });
      }
      try {
        await handler(running ?? checkpoint);
        if (kind === "closure_recovery") {
          emitRuntimeRecoveryTelemetry({
            runId: checkpoint.runId,
            ...(checkpoint.sessionKey ? { sessionKey: checkpoint.sessionKey } : {}),
            milestone: "continuation_dispatch_handler_done",
            checkpointId,
            continuationKind: kind,
            ...(checkpoint.target?.approvalId ? { approvalId: checkpoint.target.approvalId } : {}),
          });
        }
      } catch (error) {
        if (kind === "closure_recovery") {
          emitRuntimeRecoveryTelemetry({
            runId: checkpoint.runId,
            ...(checkpoint.sessionKey ? { sessionKey: checkpoint.sessionKey } : {}),
            milestone: "continuation_dispatch_failed",
            checkpointId,
            continuationKind: kind,
            error: error instanceof Error ? error.message : String(error),
            ...(checkpoint.target?.approvalId ? { approvalId: checkpoint.target.approvalId } : {}),
          });
        }
        return this.updateCheckpoint(checkpointId, {
          continuation: {
            ...(running?.continuation ?? currentContinuation),
            state: "failed",
            lastError: error instanceof Error ? error.message : String(error),
          },
        });
      }
      const latest = checkpoints.get(checkpointId);
      if (!latest?.continuation) {
        return latest;
      }
      const completed =
        latest.status === "completed" ||
        latest.status === "denied" ||
        latest.status === "cancelled";
      return this.updateCheckpoint(checkpointId, {
        continuation: {
          ...latest.continuation,
          state: completed ? "completed" : "idle",
          ...(completed ? { lastCompletedAtMs: Date.now() } : {}),
        },
      });
    },
    rehydrate() {
      if (!stateDir) {
        return 0;
      }
      let loaded = 0;
      try {
        const checkpointRaw = fs.readFileSync(resolveRuntimeCheckpointStorePath(stateDir), "utf8");
        const parsed = PlatformRuntimeCheckpointStoreSchema.parse(JSON.parse(checkpointRaw));
        checkpoints.clear();
        for (const checkpoint of parsed.checkpoints) {
          checkpoints.set(checkpoint.id, checkpoint);
          loaded += 1;
        }
      } catch {
        checkpoints.clear();
      }
      try {
        const actionRaw = fs.readFileSync(resolveRuntimeActionStorePath(stateDir), "utf8");
        const parsed = PlatformRuntimeActionStoreSchema.parse(JSON.parse(actionRaw));
        actions.clear();
        for (const action of parsed.actions) {
          actions.set(action.actionId, action);
          loaded += 1;
        }
      } catch {
        actions.clear();
      }
      try {
        const closureRaw = fs.readFileSync(resolveRuntimeClosureStorePath(stateDir), "utf8");
        const parsed = PlatformRuntimeRunClosureStoreSchema.parse(JSON.parse(closureRaw));
        closures.clear();
        for (const closure of parsed.closures) {
          closures.set(closure.runId, closure);
          loaded += 1;
        }
      } catch {
        closures.clear();
      }
      return loaded;
    },
    reset() {
      checkpoints.clear();
      actions.clear();
      closures.clear();
      continuationHandlers.clear();
      if (stateDir) {
        try {
          fs.rmSync(resolveRuntimeCheckpointStorePath(stateDir), { force: true });
        } catch {
          // Ignore reset cleanup failures in tests.
        }
        try {
          fs.rmSync(resolveRuntimeActionStorePath(stateDir), { force: true });
        } catch {
          // Ignore reset cleanup failures in tests.
        }
        try {
          fs.rmSync(resolveRuntimeClosureStorePath(stateDir), { force: true });
        } catch {
          // Ignore reset cleanup failures in tests.
        }
      }
    },
  };
}

export function getPlatformRuntimeCheckpointService(params?: {
  stateDir?: string;
}): PlatformRuntimeCheckpointService {
  const service = resolveGlobalSingleton(PLATFORM_RUNTIME_SERVICE_KEY, () =>
    createPlatformRuntimeCheckpointService({
      stateDir: params?.stateDir ?? resolveStateDir(process.env),
    }),
  );
  if (params?.stateDir) {
    service.configure({ stateDir: params.stateDir });
  }
  return service;
}

export function resetPlatformRuntimeCheckpointService() {
  getPlatformRuntimeCheckpointService().reset();
}
