import { z } from "zod";
import { PlatformExecutionContextSnapshotSchema } from "../decision/contracts.js";
import {
  CapabilityCatalogEntrySchema,
  CapabilityDescriptorSchema,
  CapabilityInstallMethodSchema,
  CapabilityRollbackStrategySchema,
} from "../schemas/capability.js";

export const BootstrapReasonSchema = z.enum([
  "missing_capability",
  "recipe_requirement",
  "renderer_unavailable",
]);
export type BootstrapReason = z.infer<typeof BootstrapReasonSchema>;

export const BootstrapLifecycleStateSchema = z.enum([
  "requested",
  "approved",
  "installing",
  "verifying",
  "available",
  "failed",
  "rolled_back",
  "degraded",
  "denied",
]);
export type BootstrapLifecycleState = z.infer<typeof BootstrapLifecycleStateSchema>;

export const BootstrapSourceDomainSchema = z.enum(["document", "developer", "platform"]);
export type BootstrapSourceDomain = z.infer<typeof BootstrapSourceDomainSchema>;

export const BootstrapApprovalModeSchema = z.enum(["explicit"]);
export type BootstrapApprovalMode = z.infer<typeof BootstrapApprovalModeSchema>;

export const BootstrapVerificationStatusSchema = z.enum(["not_run", "passed", "failed"]);
export type BootstrapVerificationStatus = z.infer<typeof BootstrapVerificationStatusSchema>;

export const BootstrapRollbackStatusSchema = z.enum([
  "not_needed",
  "restore_previous",
  "disable",
  "keep_failed",
]);
export type BootstrapRollbackStatus = z.infer<typeof BootstrapRollbackStatusSchema>;

/** Queue settings for post-bootstrap followup resume (mirrors closure recovery payload). */
const BootstrapResumeQueueSettingsSchema = z
  .object({
    mode: z.enum(["steer", "followup", "collect", "steer-backlog", "interrupt", "queue"]),
    debounceMs: z.number().int().nonnegative().optional(),
    cap: z.number().int().positive().optional(),
    dropPolicy: z.enum(["old", "new", "summarize"]).optional(),
  })
  .strict();

const BootstrapResumeFollowupAutomationSchema = z
  .object({
    source: z.enum(["acceptance_retry", "closure_recovery"]),
    retryCount: z.number().int().nonnegative(),
    persisted: z.boolean().optional(),
    runtimeCheckpointId: z.string().min(1).optional(),
    reasonCode: z.string().min(1).optional(),
    reasonSummary: z.string().min(1).optional(),
  })
  .strict();

/** Followup run snapshot for re-queueing the blocked task after bootstrap (aligned with closure recovery). */
const BootstrapResumeFollowupRunSnapshotSchema = z
  .object({
    prompt: z.string(),
    messageId: z.string().min(1).optional(),
    summaryLine: z.string().min(1).optional(),
    enqueuedAt: z.number().int().nonnegative(),
    requestRunId: z.string().min(1).optional(),
    parentRunId: z.string().min(1).optional(),
    automation: BootstrapResumeFollowupAutomationSchema.optional(),
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

/**
 * When present, a successful bootstrap (install + verify) re-queues the blocked followup run.
 * Only attached for a single pending capability from closure/bootstrap remediation to avoid duplicate resumes.
 */
export const BootstrapBlockedRunResumeSchema = z
  .object({
    blockedRunId: z.string().min(1),
    sessionKey: z.string().min(1).optional(),
    queueKey: z.string().min(1),
    settings: BootstrapResumeQueueSettingsSchema,
    sourceRun: BootstrapResumeFollowupRunSnapshotSchema,
  })
  .strict();
export type BootstrapBlockedRunResume = z.infer<typeof BootstrapBlockedRunResumeSchema>;

export const BootstrapRequestSchema = z
  .object({
    capabilityId: z.string().min(1),
    installMethod: CapabilityInstallMethodSchema,
    rollbackStrategy: CapabilityRollbackStrategySchema.optional(),
    reason: BootstrapReasonSchema,
    sourceDomain: BootstrapSourceDomainSchema,
    sourceRecipeId: z.string().min(1).optional(),
    executionContext: PlatformExecutionContextSnapshotSchema.optional(),
    blockedRunResume: BootstrapBlockedRunResumeSchema.optional(),
    approvalMode: BootstrapApprovalModeSchema,
    catalogEntry: CapabilityCatalogEntrySchema,
  })
  .strict();
export type BootstrapRequest = z.infer<typeof BootstrapRequestSchema>;

export const BootstrapResolutionStatusSchema = z.enum([
  "available",
  "request",
  "unknown",
  "untrusted",
]);
export type BootstrapResolutionStatus = z.infer<typeof BootstrapResolutionStatusSchema>;

export const BootstrapResolutionSchema = z
  .object({
    status: BootstrapResolutionStatusSchema,
    capability: CapabilityDescriptorSchema.optional(),
    catalogEntry: CapabilityCatalogEntrySchema.optional(),
    request: BootstrapRequestSchema.optional(),
    reasons: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type BootstrapResolution = z.infer<typeof BootstrapResolutionSchema>;

export const BootstrapLifecycleResultSchema = z
  .object({
    capabilityId: z.string().min(1),
    installMethod: CapabilityInstallMethodSchema,
    rollbackStrategy: CapabilityRollbackStrategySchema.optional(),
    verificationStatus: BootstrapVerificationStatusSchema,
    rollbackStatus: BootstrapRollbackStatusSchema,
    status: BootstrapLifecycleStateSchema,
    transitions: z.array(BootstrapLifecycleStateSchema).min(1),
    capability: CapabilityDescriptorSchema.optional(),
    reasons: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type BootstrapLifecycleResult = z.infer<typeof BootstrapLifecycleResultSchema>;

export const BootstrapPolicySummarySchema = z
  .object({
    allowCapabilityBootstrap: z.boolean(),
    allowPrivilegedTools: z.boolean(),
    requireExplicitApproval: z.boolean(),
    reasons: z.array(z.string().min(1)),
    deniedReasons: z.array(z.string().min(1)),
  })
  .strict();
export type BootstrapPolicySummary = z.infer<typeof BootstrapPolicySummarySchema>;

export const BootstrapOrchestrationStatusSchema = z.enum([
  "available",
  "bootstrapped",
  "denied",
  "degraded",
]);
export type BootstrapOrchestrationStatus = z.infer<typeof BootstrapOrchestrationStatusSchema>;

export const BootstrapOrchestrationResultSchema = z
  .object({
    capabilityId: z.string().min(1),
    status: BootstrapOrchestrationStatusSchema,
    request: BootstrapRequestSchema,
    policy: BootstrapPolicySummarySchema,
    lifecycle: BootstrapLifecycleResultSchema.optional(),
    capability: CapabilityDescriptorSchema.optional(),
    reasons: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type BootstrapOrchestrationResult = z.infer<typeof BootstrapOrchestrationResultSchema>;

export const BootstrapRequestDecisionSchema = z.enum(["approve", "deny"]);
export type BootstrapRequestDecision = z.infer<typeof BootstrapRequestDecisionSchema>;

export const BootstrapRequestRecordStateSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "running",
  "available",
  "degraded",
]);
export type BootstrapRequestRecordState = z.infer<typeof BootstrapRequestRecordStateSchema>;

export const BootstrapRequestRecordSchema = z
  .object({
    id: z.string().min(1),
    state: BootstrapRequestRecordStateSchema,
    request: BootstrapRequestSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    resolvedAt: z.string().datetime().optional(),
    startedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
    result: BootstrapOrchestrationResultSchema.optional(),
    reasons: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type BootstrapRequestRecord = z.infer<typeof BootstrapRequestRecordSchema>;

export const BootstrapRequestRecordSummarySchema = z
  .object({
    id: z.string().min(1),
    capabilityId: z.string().min(1),
    installMethod: CapabilityInstallMethodSchema,
    reason: BootstrapReasonSchema,
    sourceDomain: BootstrapSourceDomainSchema,
    sourceRecipeId: z.string().min(1).optional(),
    state: BootstrapRequestRecordStateSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    lastResultStatus: BootstrapOrchestrationStatusSchema.optional(),
    hasResult: z.boolean(),
    lastError: z.string().min(1).optional(),
  })
  .strict();
export type BootstrapRequestRecordSummary = z.infer<typeof BootstrapRequestRecordSummarySchema>;

export const BootstrapRequestRecordDetailSchema = BootstrapRequestRecordSchema;
export type BootstrapRequestRecordDetail = BootstrapRequestRecord;

export const BootstrapAuditEventTypeSchema = z.enum([
  "request.created",
  "request.approved",
  "request.denied",
  "request.run_blocked",
  "request.started",
  "request.available",
  "request.degraded",
  "request.rolled_back",
  "request.resume_enqueued",
  "request.resume_enqueue_failed",
]);
export type BootstrapAuditEventType = z.infer<typeof BootstrapAuditEventTypeSchema>;

export const BootstrapAuditEventSchema = z
  .object({
    version: z.literal(1),
    ts: z.string().datetime(),
    requestId: z.string().min(1),
    type: BootstrapAuditEventTypeSchema,
    record: BootstrapRequestRecordSchema,
  })
  .strict();
export type BootstrapAuditEvent = z.infer<typeof BootstrapAuditEventSchema>;
