import { z } from "zod";
import { PlatformExecutionContextSnapshotSchema } from "../decision/contracts.js";
import {
  OutcomeContractSchema,
  QualificationExecutionContractSchema,
  QualificationLowConfidenceStrategySchema,
  RequestedEvidenceKindSchema,
} from "../decision/qualification-contract.js";
import type { DecisionTrace } from "../decision/trace.js";
import { DeliverableSpecSchema, ProducedArtifactSchema } from "../produce/registry.js";
import { ArtifactKindSchema } from "../schemas/artifact.js";

export const PlatformRuntimeBoundarySchema = z.enum([
  "exec_approval",
  "bootstrap",
  "artifact_publish",
  "machine_control",
  "privileged_tool",
]);
export type PlatformRuntimeBoundary = z.infer<typeof PlatformRuntimeBoundarySchema>;

export const PlatformRuntimeCheckpointStatusSchema = z.enum([
  "blocked",
  "approved",
  "resumed",
  "completed",
  "denied",
  "cancelled",
]);
export type PlatformRuntimeCheckpointStatus = z.infer<typeof PlatformRuntimeCheckpointStatusSchema>;

export const PlatformRuntimeNextActionSchema = z
  .object({
    method: z.string().min(1),
    label: z.string().min(1),
    phase: z.enum(["approve", "deny", "resume", "retry", "inspect"]).optional(),
  })
  .strict();
export type PlatformRuntimeNextAction = z.infer<typeof PlatformRuntimeNextActionSchema>;

export const PlatformRuntimeContinuationKindSchema = z.enum([
  "bootstrap_run",
  "artifact_transition",
  "closure_recovery",
]);
export type PlatformRuntimeContinuationKind = z.infer<typeof PlatformRuntimeContinuationKindSchema>;

export const PlatformRuntimeContinuationStateSchema = z.enum([
  "idle",
  "running",
  "completed",
  "failed",
]);
export type PlatformRuntimeContinuationState = z.infer<
  typeof PlatformRuntimeContinuationStateSchema
>;

export const PlatformRuntimeContinuationSchema = z
  .object({
    kind: PlatformRuntimeContinuationKindSchema,
    autoDispatch: z.boolean().optional(),
    input: z.unknown().optional(),
    state: PlatformRuntimeContinuationStateSchema.optional(),
    attempts: z.number().int().nonnegative().optional(),
    lastError: z.string().min(1).optional(),
    lastDispatchedAtMs: z.number().int().nonnegative().optional(),
    lastCompletedAtMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type PlatformRuntimeContinuation = z.infer<typeof PlatformRuntimeContinuationSchema>;

export const PlatformRuntimeContinuationSummarySchema = PlatformRuntimeContinuationSchema.omit({
  input: true,
});
export type PlatformRuntimeContinuationSummary = z.infer<
  typeof PlatformRuntimeContinuationSummarySchema
>;

export const PlatformRuntimeTargetSchema = z
  .object({
    approvalId: z.string().min(1).optional(),
    artifactId: z.string().min(1).optional(),
    bootstrapRequestId: z.string().min(1).optional(),
    nodeId: z.string().min(1).optional(),
    toolName: z.string().min(1).optional(),
    operation: z.string().min(1).optional(),
  })
  .strict();
export type PlatformRuntimeTarget = z.infer<typeof PlatformRuntimeTargetSchema>;

export const PlatformRuntimeOperatorActorSchema = z
  .object({
    id: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    deviceId: z.string().min(1).optional(),
    connId: z.string().min(1).optional(),
  })
  .strict();
export type PlatformRuntimeOperatorActor = z.infer<typeof PlatformRuntimeOperatorActorSchema>;

export const PlatformRuntimeOperatorDecisionSchema = z
  .object({
    action: z.string().min(1),
    atMs: z.number().int().nonnegative(),
    actor: PlatformRuntimeOperatorActorSchema.optional(),
    source: z.string().min(1).optional(),
  })
  .strict();
export type PlatformRuntimeOperatorDecision = z.infer<typeof PlatformRuntimeOperatorDecisionSchema>;

export const PlatformRuntimeCheckpointSchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    sessionKey: z.string().min(1).optional(),
    boundary: PlatformRuntimeBoundarySchema,
    status: PlatformRuntimeCheckpointStatusSchema,
    blockedReason: z.string().min(1).optional(),
    policyReasons: z.array(z.string().min(1)).optional(),
    deniedReasons: z.array(z.string().min(1)).optional(),
    nextActions: z.array(PlatformRuntimeNextActionSchema).optional(),
    target: PlatformRuntimeTargetSchema.optional(),
    continuation: PlatformRuntimeContinuationSchema.optional(),
    executionContext: PlatformExecutionContextSnapshotSchema.optional(),
    createdAtMs: z.number().int().nonnegative(),
    updatedAtMs: z.number().int().nonnegative(),
    approvedAtMs: z.number().int().nonnegative().optional(),
    resumedAtMs: z.number().int().nonnegative().optional(),
    completedAtMs: z.number().int().nonnegative().optional(),
    lastOperatorDecision: PlatformRuntimeOperatorDecisionSchema.optional(),
  })
  .strict();
export type PlatformRuntimeCheckpoint = z.infer<typeof PlatformRuntimeCheckpointSchema>;

export const PlatformRuntimeCheckpointSummarySchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    sessionKey: z.string().min(1).optional(),
    boundary: PlatformRuntimeBoundarySchema,
    status: PlatformRuntimeCheckpointStatusSchema,
    blockedReason: z.string().min(1).optional(),
    nextActions: z.array(PlatformRuntimeNextActionSchema).optional(),
    target: PlatformRuntimeTargetSchema.optional(),
    continuation: PlatformRuntimeContinuationSummarySchema.optional(),
    executionContext: PlatformExecutionContextSnapshotSchema.optional(),
    createdAtMs: z.number().int().nonnegative(),
    updatedAtMs: z.number().int().nonnegative(),
    approvedAtMs: z.number().int().nonnegative().optional(),
    resumedAtMs: z.number().int().nonnegative().optional(),
    completedAtMs: z.number().int().nonnegative().optional(),
    lastOperatorDecision: PlatformRuntimeOperatorDecisionSchema.optional(),
  })
  .strict();
export type PlatformRuntimeCheckpointSummary = z.infer<
  typeof PlatformRuntimeCheckpointSummarySchema
>;

export const PlatformRuntimeCheckpointStoreSchema = z
  .object({
    version: z.literal(1),
    checkpoints: z.array(PlatformRuntimeCheckpointSchema),
  })
  .strict();
export type PlatformRuntimeCheckpointStore = z.infer<typeof PlatformRuntimeCheckpointStoreSchema>;

export const PlatformRuntimeActionKindSchema = z.enum([
  "messaging_delivery",
  "bootstrap",
  "artifact_publish",
  "machine_control",
  "privileged_tool",
  "node_invoke",
]);
export type PlatformRuntimeActionKind = z.infer<typeof PlatformRuntimeActionKindSchema>;

export const PlatformRuntimeActionStateSchema = z.enum([
  "staged",
  "attempted",
  "confirmed",
  "partial",
  "failed",
]);
export type PlatformRuntimeActionState = z.infer<typeof PlatformRuntimeActionStateSchema>;

export const PlatformRuntimeActionDeliveryResultSchema = z
  .object({
    channel: z.string().min(1),
    messageId: z.string().min(1),
    chatId: z.string().min(1).optional(),
    channelId: z.string().min(1).optional(),
    roomId: z.string().min(1).optional(),
    conversationId: z.string().min(1).optional(),
    timestamp: z.number().int().nonnegative().optional(),
    toJid: z.string().min(1).optional(),
    pollId: z.string().min(1).optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type PlatformRuntimeActionDeliveryResult = z.infer<
  typeof PlatformRuntimeActionDeliveryResultSchema
>;

export const PlatformRuntimeNodeInvokeReceiptSchema = z
  .object({
    ok: z.boolean(),
    payload: z.unknown().optional(),
    payloadJSON: z.string().nullable().optional(),
    error: z
      .object({
        code: z.string().min(1).optional(),
        message: z.string().min(1).optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
export type PlatformRuntimeNodeInvokeReceipt = z.infer<
  typeof PlatformRuntimeNodeInvokeReceiptSchema
>;

export const PlatformRuntimeActionReceiptSchema = z
  .object({
    deliveryResults: z.array(PlatformRuntimeActionDeliveryResultSchema).optional(),
    bootstrapRequestId: z.string().min(1).optional(),
    capabilityId: z.string().min(1).optional(),
    artifactId: z.string().min(1).optional(),
    nodeId: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    operation: z.string().min(1).optional(),
    resultStatus: z.string().min(1).optional(),
    nodeInvokeResult: PlatformRuntimeNodeInvokeReceiptSchema.optional(),
    operatorDecision: PlatformRuntimeOperatorDecisionSchema.optional(),
  })
  .strict();
export type PlatformRuntimeActionReceipt = z.infer<typeof PlatformRuntimeActionReceiptSchema>;

export const PlatformRuntimeActionSchema = z
  .object({
    actionId: z.string().min(1),
    runId: z.string().min(1).optional(),
    sessionKey: z.string().min(1).optional(),
    kind: PlatformRuntimeActionKindSchema,
    state: PlatformRuntimeActionStateSchema,
    boundary: PlatformRuntimeBoundarySchema.optional(),
    checkpointId: z.string().min(1).optional(),
    idempotencyKey: z.string().min(1).optional(),
    target: PlatformRuntimeTargetSchema.optional(),
    receipt: PlatformRuntimeActionReceiptSchema.optional(),
    attemptCount: z.number().int().nonnegative(),
    retryable: z.boolean().optional(),
    lastError: z.string().min(1).optional(),
    createdAtMs: z.number().int().nonnegative(),
    updatedAtMs: z.number().int().nonnegative(),
    stagedAtMs: z.number().int().nonnegative().optional(),
    attemptedAtMs: z.number().int().nonnegative().optional(),
    confirmedAtMs: z.number().int().nonnegative().optional(),
    failedAtMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type PlatformRuntimeAction = z.infer<typeof PlatformRuntimeActionSchema>;

export const PlatformRuntimeActionSummarySchema = PlatformRuntimeActionSchema.pick({
  actionId: true,
  runId: true,
  sessionKey: true,
  kind: true,
  state: true,
  boundary: true,
  checkpointId: true,
  idempotencyKey: true,
  target: true,
  attemptCount: true,
  retryable: true,
  lastError: true,
  createdAtMs: true,
  updatedAtMs: true,
  stagedAtMs: true,
  attemptedAtMs: true,
  confirmedAtMs: true,
  failedAtMs: true,
});
export type PlatformRuntimeActionSummary = z.infer<typeof PlatformRuntimeActionSummarySchema>;

export const PlatformRuntimeActionStoreSchema = z
  .object({
    version: z.literal(1),
    actions: z.array(PlatformRuntimeActionSchema),
  })
  .strict();
export type PlatformRuntimeActionStore = z.infer<typeof PlatformRuntimeActionStoreSchema>;

export const PlatformRuntimeExecutionReceiptKindSchema = z.enum([
  "tool",
  "provider_model",
  "messaging_delivery",
  "platform_action",
  "capability",
  "readiness",
]);
export type PlatformRuntimeExecutionReceiptKind = z.infer<
  typeof PlatformRuntimeExecutionReceiptKindSchema
>;

export const PlatformRuntimeExecutionReceiptStatusSchema = z.enum([
  "success",
  "partial",
  "failed",
  "degraded",
  "warning",
  "blocked",
]);
export type PlatformRuntimeExecutionReceiptStatus = z.infer<
  typeof PlatformRuntimeExecutionReceiptStatusSchema
>;

export const PlatformRuntimeExecutionReceiptProofSchema = z.enum([
  "derived",
  "reported",
  "verified",
]);
export type PlatformRuntimeExecutionReceiptProof = z.infer<
  typeof PlatformRuntimeExecutionReceiptProofSchema
>;

export const PlatformRuntimeExecutionReceiptSchema = z
  .object({
    kind: PlatformRuntimeExecutionReceiptKindSchema,
    name: z.string().min(1),
    status: PlatformRuntimeExecutionReceiptStatusSchema,
    proof: PlatformRuntimeExecutionReceiptProofSchema,
    summary: z.string().min(1).optional(),
    reasons: z.array(z.string().min(1)).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    producedArtifacts: z.array(ProducedArtifactSchema).optional(),
  })
  .strict();
export type PlatformRuntimeExecutionReceipt = z.infer<typeof PlatformRuntimeExecutionReceiptSchema>;

export const PlatformRuntimeExecutionContractExpectationSchema = z
  .object({
    requiresOutput: z.boolean().optional(),
    requiresMessagingDelivery: z.boolean().optional(),
    requiresConfirmedAction: z.boolean().optional(),
    requireStructuredReceipts: z.boolean().optional(),
    minimumVerifiedReceiptCount: z.number().int().nonnegative().optional(),
    requiredReceiptKinds: z.array(PlatformRuntimeExecutionReceiptKindSchema).optional(),
    allowStandaloneEvidence: z.boolean().optional(),
    allowWarnings: z.boolean().optional(),
    allowPartial: z.boolean().optional(),
  })
  .strict();
export type PlatformRuntimeExecutionContractExpectation = z.infer<
  typeof PlatformRuntimeExecutionContractExpectationSchema
>;

export const PlatformRuntimeExecutionContractSchema = z
  .object({
    runId: z.string().min(1),
    receipts: z.array(PlatformRuntimeExecutionReceiptSchema),
    expectations: PlatformRuntimeExecutionContractExpectationSchema.optional(),
    checkedAtMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type PlatformRuntimeExecutionContract = z.infer<
  typeof PlatformRuntimeExecutionContractSchema
>;

export const PlatformRuntimeExecutionVerificationStatusSchema = z.enum([
  "verified",
  "warning",
  "mismatch",
  "no_progress",
  "failed",
  "degraded",
]);
export type PlatformRuntimeExecutionVerificationStatus = z.infer<
  typeof PlatformRuntimeExecutionVerificationStatusSchema
>;

export const PlatformRuntimeExecutionReceiptCountsSchema = z
  .object({
    success: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative(),
    partial: z.number().int().nonnegative(),
    degraded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
  })
  .strict();
export type PlatformRuntimeExecutionReceiptCounts = z.infer<
  typeof PlatformRuntimeExecutionReceiptCountsSchema
>;

export const PlatformRuntimeExecutionReceiptProofCountsSchema = z
  .object({
    derived: z.number().int().nonnegative(),
    reported: z.number().int().nonnegative(),
    verified: z.number().int().nonnegative(),
  })
  .strict();
export type PlatformRuntimeExecutionReceiptProofCounts = z.infer<
  typeof PlatformRuntimeExecutionReceiptProofCountsSchema
>;

export const PlatformRuntimeExecutionVerificationSchema = z
  .object({
    runId: z.string().min(1),
    status: PlatformRuntimeExecutionVerificationStatusSchema,
    reasons: z.array(z.string().min(1)),
    receipts: z.array(PlatformRuntimeExecutionReceiptSchema),
    receiptCounts: PlatformRuntimeExecutionReceiptCountsSchema,
    receiptProofCounts: PlatformRuntimeExecutionReceiptProofCountsSchema,
    missingReceiptKinds: z.array(PlatformRuntimeExecutionReceiptKindSchema).optional(),
    usedStandaloneEvidence: z.boolean().optional(),
    checkedAtMs: z.number().int().nonnegative(),
  })
  .strict();
export type PlatformRuntimeExecutionVerification = z.infer<
  typeof PlatformRuntimeExecutionVerificationSchema
>;

export const PlatformRuntimeExecutionSurfaceStatusSchema = z.enum([
  "ready",
  "bootstrap_required",
  "approval_required",
  "degraded",
  "unavailable",
]);
export type PlatformRuntimeExecutionSurfaceStatus = z.infer<
  typeof PlatformRuntimeExecutionSurfaceStatusSchema
>;

export const PlatformRuntimeExecutionSurfaceSchema = z
  .object({
    status: PlatformRuntimeExecutionSurfaceStatusSchema,
    ready: z.boolean(),
    checkedAtMs: z.number().int().nonnegative(),
    cacheTtlMs: z.number().int().nonnegative().optional(),
    reasons: z.array(z.string().min(1)),
    bootstrapRequiredCapabilities: z.array(z.string().min(1)).optional(),
    unresolvedCapabilities: z.array(z.string().min(1)).optional(),
    failingChannels: z.array(z.string().min(1)).optional(),
    failingTools: z.array(z.string().min(1)).optional(),
    modelFallbackActive: z.boolean().optional(),
    approvalRequired: z.boolean().optional(),
    unattendedBoundary: z.enum(["bootstrap", "exec_approval"]).optional(),
  })
  .strict();
export type PlatformRuntimeExecutionSurface = z.infer<typeof PlatformRuntimeExecutionSurfaceSchema>;

export const PlatformRuntimeRunOutcomeStatusSchema = z.enum([
  "completed",
  "blocked",
  "partial",
  "failed",
]);
export type PlatformRuntimeRunOutcomeStatus = z.infer<typeof PlatformRuntimeRunOutcomeStatusSchema>;

export const PlatformRuntimeRunOutcomeSchema = z
  .object({
    runId: z.string().min(1),
    status: PlatformRuntimeRunOutcomeStatusSchema,
    checkpointIds: z.array(z.string().min(1)),
    blockedCheckpointIds: z.array(z.string().min(1)),
    completedCheckpointIds: z.array(z.string().min(1)),
    deniedCheckpointIds: z.array(z.string().min(1)),
    pendingApprovalIds: z.array(z.string().min(1)),
    artifactIds: z.array(z.string().min(1)),
    bootstrapRequestIds: z.array(z.string().min(1)),
    actionIds: z.array(z.string().min(1)),
    attemptedActionIds: z.array(z.string().min(1)),
    confirmedActionIds: z.array(z.string().min(1)),
    failedActionIds: z.array(z.string().min(1)),
    boundaries: z.array(PlatformRuntimeBoundarySchema),
  })
  .strict();
export type PlatformRuntimeRunOutcome = z.infer<typeof PlatformRuntimeRunOutcomeSchema>;

export const PlatformRuntimeAcceptanceStatusSchema = z.enum([
  "satisfied",
  "partial",
  "retryable",
  "needs_human",
  "failed",
]);
export type PlatformRuntimeAcceptanceStatus = z.infer<typeof PlatformRuntimeAcceptanceStatusSchema>;

export const PlatformRuntimeAcceptanceActionSchema = z.enum(["close", "retry", "escalate", "stop"]);
export type PlatformRuntimeAcceptanceAction = z.infer<typeof PlatformRuntimeAcceptanceActionSchema>;

export const PlatformRuntimeRemediationSchema = z.enum([
  "none",
  "semantic_retry",
  "delivery_retry",
  "bootstrap",
  "provider_fallback",
  "auth_refresh",
  "needs_human",
  "stop",
]);
export type PlatformRuntimeRemediation = z.infer<typeof PlatformRuntimeRemediationSchema>;

export const PlatformRuntimeRecoveryCadenceSchema = z.enum([
  "none",
  "immediate",
  "backoff",
  "manual",
]);
export type PlatformRuntimeRecoveryCadence = z.infer<typeof PlatformRuntimeRecoveryCadenceSchema>;

export const PlatformRuntimeRecoveryExhaustedActionSchema = z.enum(["escalate", "stop"]);
export type PlatformRuntimeRecoveryExhaustedAction = z.infer<
  typeof PlatformRuntimeRecoveryExhaustedActionSchema
>;

export const PlatformRuntimeRecoveryClassSchema = z.enum([
  "none",
  "semantic",
  "delivery",
  "bootstrap",
  "provider",
  "auth",
  "human",
  "stop",
]);
export type PlatformRuntimeRecoveryClass = z.infer<typeof PlatformRuntimeRecoveryClassSchema>;

export const PlatformRuntimeRecoveryPolicySchema = z
  .object({
    remediation: PlatformRuntimeRemediationSchema,
    recoveryClass: PlatformRuntimeRecoveryClassSchema,
    cadence: PlatformRuntimeRecoveryCadenceSchema,
    continuous: z.boolean(),
    attemptCount: z.number().int().nonnegative(),
    maxAttempts: z.number().int().nonnegative(),
    remainingAttempts: z.number().int().nonnegative(),
    exhausted: z.boolean(),
    exhaustedAction: PlatformRuntimeRecoveryExhaustedActionSchema,
    nextAttemptDelayMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type PlatformRuntimeRecoveryPolicy = z.infer<typeof PlatformRuntimeRecoveryPolicySchema>;

export const ClassifierTelemetrySchema = z
  .object({
    /**
     * `provenance_guard` is emitted by the typed-provenance short-circuit in
     * `src/platform/decision/input.ts::buildClassifiedExecutionDecisionInput`
     * and propagates through `buildPlannerInputFromTaskContract` into the
     * runtime intent. Diagnostic-only — `runtime` consumers should not branch
     * on this value.
     */
    source: z.enum(["llm", "fail_closed", "provenance_guard"]),
    backend: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    primaryOutcome: z.string().min(1).optional(),
    interactionMode: z.string().min(1).optional(),
    confidence: z.number().optional(),
    deliverableKind: z.string().min(1).optional(),
    deliverableFormats: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type ClassifierTelemetry = z.infer<typeof ClassifierTelemetrySchema>;

/**
 * Structured routing status produced by the recipe planner. Threaded through
 * the runtime so downstream layers (reply, evidence, observability) can see
 * exactly whether the planner actually matched a recipe to the contract.
 *
 * `matched` — recipe satisfies the contract; safe to execute.
 * `low_confidence_clarify` — classifier said confidence is low and clarify
 *     is the preferred strategy; recipe is a safe default.
 * `contract_unsatisfiable` — planner could not find a recipe capable of
 *     satisfying the declared contract; a safe fallback is still set on the
 *     plan, but callers must NOT claim successful execution.
 */
export const RoutingOutcomeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("matched"),
      source: z.enum(["ranked", "contract_first_fallback"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("low_confidence_clarify"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("contract_unsatisfiable"),
      reasons: z.array(z.string().min(1)).min(1),
    })
    .strict(),
]);
export type RoutingOutcome = z.infer<typeof RoutingOutcomeSchema>;

const DecisionTraceSchema = z.custom<DecisionTrace>(
  (value) =>
    typeof value === "object" && value !== null && (value as { version?: unknown }).version === 1,
);

export const PlatformRuntimeExecutionIntentSchema = z
  .object({
    runId: z.string().min(1),
    profileId: z.string().min(1).optional(),
    recipeId: z.string().min(1).optional(),
    taskOverlayId: z.string().min(1).optional(),
    plannerReasoning: z.string().min(1).optional(),
    intent: z.enum(["general", "document", "compare", "calculation", "code", "publish"]).optional(),
    publishTargets: z.array(z.string().min(1)).optional(),
    artifactKinds: z.array(ArtifactKindSchema).optional(),
    requestedToolNames: z.array(z.string().min(1)).optional(),
    deliverable: DeliverableSpecSchema.optional(),
    outcomeContract: OutcomeContractSchema.optional(),
    executionContract: QualificationExecutionContractSchema.optional(),
    requestedEvidence: z.array(RequestedEvidenceKindSchema).optional(),
    lowConfidenceStrategy: QualificationLowConfidenceStrategySchema.optional(),
    requiredCapabilities: z.array(z.string().min(1)).optional(),
    bootstrapRequiredCapabilities: z.array(z.string().min(1)).optional(),
    requireExplicitApproval: z.boolean().optional(),
    policyAutonomy: z.enum(["chat", "assist", "guarded"]).optional(),
    classifierTelemetry: ClassifierTelemetrySchema.optional(),
    routingOutcome: RoutingOutcomeSchema.optional(),
    decisionTrace: DecisionTraceSchema.optional(),
    expectations: PlatformRuntimeExecutionContractExpectationSchema,
  })
  .strict();
export type PlatformRuntimeExecutionIntent = z.infer<typeof PlatformRuntimeExecutionIntentSchema>;

export const PlatformRuntimeAcceptanceReasonCodeSchema = z.enum([
  "completed_with_output",
  "completed_with_artifacts",
  "completed_with_confirmed_delivery",
  "completed_with_warnings",
  "completed_without_evidence",
  "contract_mismatch",
  "execution_no_progress",
  "execution_degraded",
  "bootstrap_required",
  "provider_fallback_exhausted",
  "provider_auth_required",
  "delivery_failed",
  "delivery_partial",
  "pending_approval",
  "runtime_blocked",
  "runtime_failed",
  "runtime_partial",
]);
export type PlatformRuntimeAcceptanceReasonCode = z.infer<
  typeof PlatformRuntimeAcceptanceReasonCodeSchema
>;

export const PlatformRuntimeAcceptanceEvidenceSchema = z
  .object({
    hadToolError: z.boolean().optional(),
    deterministicApprovalPromptSent: z.boolean().optional(),
    didSendViaMessagingTool: z.boolean().optional(),
    hasOutput: z.boolean().optional(),
    hasStructuredReplyPayload: z.boolean().optional(),
    deliveredReplyCount: z.number().int().nonnegative().optional(),
    stagedReplyCount: z.number().int().nonnegative().optional(),
    attemptedDeliveryCount: z.number().int().nonnegative().optional(),
    confirmedDeliveryCount: z.number().int().nonnegative().optional(),
    failedDeliveryCount: z.number().int().nonnegative().optional(),
    partialDelivery: z.boolean().optional(),
    artifactReceiptCount: z.number().int().nonnegative().optional(),
    bootstrapReceiptCount: z.number().int().nonnegative().optional(),
    attemptedActionCount: z.number().int().nonnegative().optional(),
    confirmedActionCount: z.number().int().nonnegative().optional(),
    failedActionCount: z.number().int().nonnegative().optional(),
    executionReceiptCount: z.number().int().nonnegative().optional(),
    structuredExecutionReceiptCount: z.number().int().nonnegative().optional(),
    verifiedExecutionReceiptCount: z.number().int().nonnegative().optional(),
    verifiedExecution: z.boolean().optional(),
    executionWarningCount: z.number().int().nonnegative().optional(),
    executionPartialCount: z.number().int().nonnegative().optional(),
    degradedExecutionCount: z.number().int().nonnegative().optional(),
    executionContractMismatch: z.boolean().optional(),
    noProgressSignals: z.number().int().nonnegative().optional(),
    executionSurfaceStatus: PlatformRuntimeExecutionSurfaceStatusSchema.optional(),
    executionSurfaceDegraded: z.boolean().optional(),
    executionUnattendedBoundary: z.enum(["bootstrap", "exec_approval"]).optional(),
    modelFallbackAttemptCount: z.number().int().nonnegative().optional(),
    modelFallbackExhausted: z.boolean().optional(),
    modelFallbackFinalReason: z.string().min(1).optional(),
    modelFallbackFinalStatus: z.number().int().nonnegative().optional(),
    modelFallbackFinalCode: z.string().min(1).optional(),
    providerAuthFailed: z.boolean().optional(),
    providerRateLimited: z.boolean().optional(),
    providerModelNotFound: z.boolean().optional(),
    successfulCronAdds: z.number().int().nonnegative().optional(),
    declaredProfileId: z.string().min(1).optional(),
    declaredRecipeId: z.string().min(1).optional(),
    declaredIntent: PlatformRuntimeExecutionIntentSchema.shape.intent.optional(),
    declaredArtifactKinds: z.array(ArtifactKindSchema).optional(),
    declaredOutcomeContract: OutcomeContractSchema.optional(),
    declaredExecutionContract: QualificationExecutionContractSchema.optional(),
    declaredRequestedEvidence: z.array(RequestedEvidenceKindSchema).optional(),
    declaredLowConfidenceStrategy: QualificationLowConfidenceStrategySchema.optional(),
    declaredRequiresOutput: z.boolean().optional(),
    declaredRequiresMessagingDelivery: z.boolean().optional(),
    declaredRequiresConfirmedAction: z.boolean().optional(),
    recoveryAttemptCount: z.number().int().nonnegative().optional(),
    recoveryMaxAttempts: z.number().int().nonnegative().optional(),
    recoveryBudgetRemaining: z.number().int().nonnegative().optional(),
    recoveryBudgetExhausted: z.boolean().optional(),
    recoveryNextAttemptDelayMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type PlatformRuntimeAcceptanceEvidence = z.infer<
  typeof PlatformRuntimeAcceptanceEvidenceSchema
>;

export const PlatformRuntimeSupervisorVerdictReasonCodeSchema = z.enum([
  "verified_execution",
  "contract_mismatch",
  "execution_no_progress",
  "execution_degraded",
  "recovery_budget_exhausted",
  "bootstrap_recovery",
  "provider_recovery",
  "auth_recovery",
  "transient_recoverable",
  "needs_human",
  "runtime_failed",
]);
export type PlatformRuntimeSupervisorVerdictReasonCode = z.infer<
  typeof PlatformRuntimeSupervisorVerdictReasonCodeSchema
>;

export const PlatformRuntimeAcceptanceResultSchema = z
  .object({
    runId: z.string().min(1),
    status: PlatformRuntimeAcceptanceStatusSchema,
    action: PlatformRuntimeAcceptanceActionSchema,
    remediation: PlatformRuntimeRemediationSchema,
    reasonCode: PlatformRuntimeAcceptanceReasonCodeSchema,
    reasons: z.array(z.string().min(1)),
    outcome: PlatformRuntimeRunOutcomeSchema,
    evidence: PlatformRuntimeAcceptanceEvidenceSchema,
    recoveryPolicy: PlatformRuntimeRecoveryPolicySchema,
  })
  .strict();
export type PlatformRuntimeAcceptanceResult = z.infer<typeof PlatformRuntimeAcceptanceResultSchema>;

export const PlatformRuntimeSupervisorVerdictSchema = z
  .object({
    runId: z.string().min(1),
    status: PlatformRuntimeAcceptanceStatusSchema,
    action: PlatformRuntimeAcceptanceActionSchema,
    remediation: PlatformRuntimeRemediationSchema,
    reasonCode: PlatformRuntimeSupervisorVerdictReasonCodeSchema,
    reasons: z.array(z.string().min(1)),
    acceptance: PlatformRuntimeAcceptanceResultSchema.optional(),
    verification: PlatformRuntimeExecutionVerificationSchema.optional(),
    surface: PlatformRuntimeExecutionSurfaceSchema.optional(),
    recoveryPolicy: PlatformRuntimeRecoveryPolicySchema,
  })
  .strict();
export type PlatformRuntimeSupervisorVerdict = z.infer<
  typeof PlatformRuntimeSupervisorVerdictSchema
>;

export const PlatformRuntimeRunClosureSchema = z
  .object({
    runId: z.string().min(1),
    requestRunId: z.string().min(1).optional(),
    parentRunId: z.string().min(1).optional(),
    sessionKey: z.string().min(1).optional(),
    updatedAtMs: z.number().int().nonnegative(),
    outcome: PlatformRuntimeRunOutcomeSchema,
    executionIntent: PlatformRuntimeExecutionIntentSchema,
    executionSurface: PlatformRuntimeExecutionSurfaceSchema.optional(),
    executionVerification: PlatformRuntimeExecutionVerificationSchema,
    acceptanceOutcome: PlatformRuntimeAcceptanceResultSchema,
    supervisorVerdict: PlatformRuntimeSupervisorVerdictSchema,
  })
  .strict();
export type PlatformRuntimeRunClosure = z.infer<typeof PlatformRuntimeRunClosureSchema>;

export const PlatformRuntimeRunClosureSummarySchema = z
  .object({
    runId: z.string().min(1),
    requestRunId: z.string().min(1).optional(),
    parentRunId: z.string().min(1).optional(),
    sessionKey: z.string().min(1).optional(),
    updatedAtMs: z.number().int().nonnegative(),
    outcomeStatus: PlatformRuntimeRunOutcomeStatusSchema,
    verificationStatus: PlatformRuntimeExecutionVerificationStatusSchema,
    acceptanceStatus: PlatformRuntimeAcceptanceStatusSchema,
    action: PlatformRuntimeAcceptanceActionSchema,
    remediation: PlatformRuntimeRemediationSchema,
    reasonCode: PlatformRuntimeSupervisorVerdictReasonCodeSchema,
    reasons: z.array(z.string().min(1)),
    declaredIntent: PlatformRuntimeExecutionIntentSchema.shape.intent.optional(),
    declaredOutcomeContract: OutcomeContractSchema.optional(),
    declaredProfileId: z.string().min(1).optional(),
    declaredRecipeId: z.string().min(1).optional(),
    requiresOutput: z.boolean().optional(),
    requiresMessagingDelivery: z.boolean().optional(),
    requiresConfirmedAction: z.boolean().optional(),
    surfaceStatus: PlatformRuntimeExecutionSurfaceStatusSchema.optional(),
  })
  .strict();
export type PlatformRuntimeRunClosureSummary = z.infer<
  typeof PlatformRuntimeRunClosureSummarySchema
>;

export const PlatformRuntimeRunClosureStoreSchema = z
  .object({
    version: z.literal(1),
    closures: z.array(PlatformRuntimeRunClosureSchema),
  })
  .strict();
export type PlatformRuntimeRunClosureStore = z.infer<typeof PlatformRuntimeRunClosureStoreSchema>;
