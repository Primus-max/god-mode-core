import { z } from "zod";

/**
 * Snapshot fields such as `requestedToolNames`, `modelOverride`, and `fallbackModels` are execution hints
 * for routing and planning. Effective tooling and autonomy remain governed by policy, not by profile
 * scoring or recipe selection alone. See `PLATFORM_PROFILE_HINTS_ARE_NON_AUTHORITATIVE` in `schemas/profile.ts`.
 */

export const PlatformExecutionContextIntentSchema = z.enum([
  "general",
  "document",
  "code",
  "publish",
]);
export type PlatformExecutionContextIntent = z.infer<typeof PlatformExecutionContextIntentSchema>;

export const PlatformExecutionContextPolicyAutonomySchema = z.enum(["chat", "assist", "guarded"]);
export type PlatformExecutionContextPolicyAutonomy = z.infer<
  typeof PlatformExecutionContextPolicyAutonomySchema
>;

export const PlatformExecutionContextReadinessStatusSchema = z.enum([
  "ready",
  "bootstrap_required",
  "approval_required",
]);
export type PlatformExecutionContextReadinessStatus = z.infer<
  typeof PlatformExecutionContextReadinessStatusSchema
>;

export const PlatformExecutionContextUnattendedBoundarySchema = z.enum([
  "bootstrap",
  "artifact_publish",
]);
export type PlatformExecutionContextUnattendedBoundary = z.infer<
  typeof PlatformExecutionContextUnattendedBoundarySchema
>;

export const PlatformExecutionContextSnapshotSchema = z
  .object({
    profileId: z.string().min(1),
    recipeId: z.string().min(1),
    taskOverlayId: z.string().min(1).optional(),
    plannerReasoning: z.string().min(1).optional(),
    intent: PlatformExecutionContextIntentSchema.optional(),
    providerOverride: z.string().min(1).optional(),
    modelOverride: z.string().min(1).optional(),
    timeoutSeconds: z.number().positive().optional(),
    fallbackModels: z.array(z.string().min(1)).optional(),
    requestedToolNames: z.array(z.string().min(1)).optional(),
    publishTargets: z.array(z.string().min(1)).optional(),
    requiredCapabilities: z.array(z.string().min(1)).optional(),
    bootstrapRequiredCapabilities: z.array(z.string().min(1)).optional(),
    requireExplicitApproval: z.boolean().optional(),
    policyAutonomy: PlatformExecutionContextPolicyAutonomySchema.optional(),
    readinessStatus: PlatformExecutionContextReadinessStatusSchema.optional(),
    readinessReasons: z.array(z.string().min(1)).optional(),
    unattendedBoundary: PlatformExecutionContextUnattendedBoundarySchema.optional(),
  })
  .strict();
export type PlatformExecutionContextSnapshot = z.infer<
  typeof PlatformExecutionContextSnapshotSchema
>;
