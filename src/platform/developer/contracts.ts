import { z } from "zod";

export const DeveloperFlowStageSchema = z.enum([
  "analyze",
  "build",
  "test",
  "preview",
  "release",
  "publish",
]);
export type DeveloperFlowStage = z.infer<typeof DeveloperFlowStageSchema>;

export const DeveloperPublishTargetSchema = z.enum([
  "github",
  "npm",
  "docker",
  "vercel",
  "netlify",
]);
export type DeveloperPublishTarget = z.infer<typeof DeveloperPublishTargetSchema>;

export const DeveloperExecutionIntentSchema = z.enum(["code", "publish"]);
export type DeveloperExecutionIntent = z.infer<typeof DeveloperExecutionIntentSchema>;

export const DeveloperRuntimeRequestSchema = z
  .object({
    intent: DeveloperExecutionIntentSchema,
    stages: z.array(DeveloperFlowStageSchema).min(1),
    publishTargets: z.array(DeveloperPublishTargetSchema).optional(),
    requestedArtifacts: z.array(z.enum(["preview", "binary", "release", "report"])).optional(),
  })
  .strict();
export type DeveloperRuntimeRequest = z.infer<typeof DeveloperRuntimeRequestSchema>;

export const DeveloperRuntimeExecutionPlanSchema = z
  .object({
    recipeId: z.literal("code_build_publish"),
    intent: DeveloperExecutionIntentSchema,
    stages: z.array(DeveloperFlowStageSchema).min(1),
    publishTargets: z.array(DeveloperPublishTargetSchema),
    requiredApproval: z.boolean(),
  })
  .strict();
export type DeveloperRuntimeExecutionPlan = z.infer<typeof DeveloperRuntimeExecutionPlanSchema>;
