import { z } from "zod";

export const PlatformExecutionContextIntentSchema = z.enum([
  "general",
  "document",
  "code",
  "publish",
]);
export type PlatformExecutionContextIntent = z.infer<typeof PlatformExecutionContextIntentSchema>;

export const PlatformExecutionContextPolicyAutonomySchema = z.enum([
  "chat",
  "assist",
  "guarded",
]);
export type PlatformExecutionContextPolicyAutonomy = z.infer<
  typeof PlatformExecutionContextPolicyAutonomySchema
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
  })
  .strict();
export type PlatformExecutionContextSnapshot = z.infer<typeof PlatformExecutionContextSnapshotSchema>;
