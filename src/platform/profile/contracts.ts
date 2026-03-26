import { z } from "zod";
import { ProfileIdSchema } from "../schemas/profile.js";
import { BootstrapResolutionStatusSchema } from "../bootstrap/contracts.js";

const PolicyAutonomySchema = z.enum(["chat", "assist", "guarded"]);

export const SpecialistOverrideModeSchema = z.enum(["auto", "base", "session"]);
export type SpecialistOverrideMode = z.infer<typeof SpecialistOverrideModeSchema>;

export const SpecialistSignalSnapshotSchema = z
  .object({
    source: z.enum(["channel", "file", "tool_usage", "artifact", "dialogue", "config"]),
    profileId: ProfileIdSchema,
    profileLabel: z.string().min(1),
    weight: z.number().min(0).max(1),
    reason: z.string().min(1).optional(),
  })
  .strict();
export type SpecialistSignalSnapshot = z.infer<typeof SpecialistSignalSnapshotSchema>;

export const SpecialistOverrideSnapshotSchema = z
  .object({
    supported: z.boolean(),
    mode: SpecialistOverrideModeSchema,
    baseProfileId: ProfileIdSchema.optional(),
    sessionProfileId: ProfileIdSchema.optional(),
    note: z.string().min(1).optional(),
  })
  .strict();
export type SpecialistOverrideSnapshot = z.infer<typeof SpecialistOverrideSnapshotSchema>;

export const SpecialistProfileOptionSchema = z
  .object({
    id: ProfileIdSchema,
    label: z.string().min(1),
  })
  .strict();
export type SpecialistProfileOption = z.infer<typeof SpecialistProfileOptionSchema>;

export const SpecialistCapabilityRequirementSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    status: BootstrapResolutionStatusSchema,
    requiresBootstrap: z.boolean(),
    reasons: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type SpecialistCapabilityRequirement = z.infer<typeof SpecialistCapabilityRequirementSchema>;

export const SpecialistRuntimeSnapshotSchema = z
  .object({
    sessionKey: z.string().min(1),
    availableProfiles: z.array(SpecialistProfileOptionSchema),
    selectedProfileId: ProfileIdSchema,
    selectedProfileLabel: z.string().min(1),
    activeProfileId: ProfileIdSchema,
    activeProfileLabel: z.string().min(1),
    activeProfileDescription: z.string().min(1).optional(),
    baseProfileId: ProfileIdSchema,
    sessionProfileId: ProfileIdSchema.optional(),
    taskOverlayId: z.string().min(1).optional(),
    taskOverlayLabel: z.string().min(1).optional(),
    recipeId: z.string().min(1),
    recipePurpose: z.string().min(1),
    recipeSummary: z.string().min(1).optional(),
    reasoningSummary: z.string().min(1),
    requiredCapabilities: z.array(z.string().min(1)),
    bootstrapRequiredCapabilities: z.array(z.string().min(1)),
    capabilityRequirements: z.array(SpecialistCapabilityRequirementSchema),
    policyAutonomy: PolicyAutonomySchema,
    requiresExplicitApproval: z.boolean(),
    confidence: z.number().min(0).max(1),
    preferredTools: z.array(z.string().min(1)),
    publishTargets: z.array(z.string().min(1)),
    providerOverride: z.string().min(1).optional(),
    modelOverride: z.string().min(1).optional(),
    timeoutSeconds: z.number().positive().optional(),
    draftApplied: z.boolean(),
    signals: z.array(SpecialistSignalSnapshotSchema),
    override: SpecialistOverrideSnapshotSchema,
  })
  .strict();
export type SpecialistRuntimeSnapshot = z.infer<typeof SpecialistRuntimeSnapshotSchema>;
