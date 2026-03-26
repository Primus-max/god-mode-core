import { z } from "zod";
import { PlatformExecutionContextSnapshotSchema } from "../decision/contracts.js";

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
]);
export type PlatformRuntimeContinuationKind = z.infer<
  typeof PlatformRuntimeContinuationKindSchema
>;

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
    state: PlatformRuntimeContinuationStateSchema.optional(),
    attempts: z.number().int().nonnegative().optional(),
    lastError: z.string().min(1).optional(),
    lastDispatchedAtMs: z.number().int().nonnegative().optional(),
    lastCompletedAtMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type PlatformRuntimeContinuation = z.infer<typeof PlatformRuntimeContinuationSchema>;

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
  })
  .strict();
export type PlatformRuntimeCheckpoint = z.infer<typeof PlatformRuntimeCheckpointSchema>;

export const PlatformRuntimeCheckpointSummarySchema = PlatformRuntimeCheckpointSchema.pick({
  id: true,
  runId: true,
  sessionKey: true,
  boundary: true,
  status: true,
  blockedReason: true,
  nextActions: true,
  target: true,
  createdAtMs: true,
  updatedAtMs: true,
  approvedAtMs: true,
  resumedAtMs: true,
  completedAtMs: true,
});
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

export const PlatformRuntimeAcceptanceActionSchema = z.enum([
  "close",
  "retry",
  "escalate",
  "stop",
]);
export type PlatformRuntimeAcceptanceAction = z.infer<typeof PlatformRuntimeAcceptanceActionSchema>;

export const PlatformRuntimeAcceptanceReasonCodeSchema = z.enum([
  "completed_with_output",
  "completed_with_artifacts",
  "completed_with_warnings",
  "completed_without_evidence",
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
    successfulCronAdds: z.number().int().nonnegative().optional(),
  })
  .strict();
export type PlatformRuntimeAcceptanceEvidence = z.infer<
  typeof PlatformRuntimeAcceptanceEvidenceSchema
>;

export const PlatformRuntimeAcceptanceResultSchema = z
  .object({
    runId: z.string().min(1),
    status: PlatformRuntimeAcceptanceStatusSchema,
    action: PlatformRuntimeAcceptanceActionSchema,
    reasonCode: PlatformRuntimeAcceptanceReasonCodeSchema,
    reasons: z.array(z.string().min(1)),
    outcome: PlatformRuntimeRunOutcomeSchema,
    evidence: PlatformRuntimeAcceptanceEvidenceSchema,
  })
  .strict();
export type PlatformRuntimeAcceptanceResult = z.infer<
  typeof PlatformRuntimeAcceptanceResultSchema
>;
