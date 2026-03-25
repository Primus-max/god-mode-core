import { z } from "zod";
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

export const BootstrapRequestSchema = z
  .object({
    capabilityId: z.string().min(1),
    installMethod: CapabilityInstallMethodSchema,
    rollbackStrategy: CapabilityRollbackStrategySchema.optional(),
    reason: BootstrapReasonSchema,
    sourceDomain: BootstrapSourceDomainSchema,
    sourceRecipeId: z.string().min(1).optional(),
    approvalMode: BootstrapApprovalModeSchema,
    catalogEntry: CapabilityCatalogEntrySchema,
  })
  .strict();
export type BootstrapRequest = z.infer<typeof BootstrapRequestSchema>;

export const BootstrapResolutionSchema = z
  .object({
    status: z.enum(["available", "request", "unknown", "untrusted"]),
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
