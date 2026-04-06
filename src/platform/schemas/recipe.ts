import { z } from "zod";
import { ProfileIdSchema } from "./profile.js";

export const RiskLevelSchema = z.enum(["none", "low", "medium", "high", "critical"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const RecipeInputSchema = z
  .object({
    type: z.string().min(1),
    required: z.boolean().optional(),
    description: z.string().min(1).optional(),
  })
  .strict();

export type RecipeInput = z.infer<typeof RecipeInputSchema>;

export const RecipeOutputSchema = z
  .object({
    type: z.string().min(1),
    description: z.string().min(1).optional(),
  })
  .strict();

export type RecipeOutput = z.infer<typeof RecipeOutputSchema>;

export const ExecutionRecipeSchema = z
  .object({
    id: z.string().min(1),
    purpose: z.string().min(1),
    summary: z.string().min(1).optional(),
    acceptedInputs: z.array(RecipeInputSchema).min(1),
    producedArtifacts: z.array(RecipeOutputSchema).optional(),
    requiredCapabilities: z.array(z.string().min(1)).optional(),
    /** Admission control for recipe selection against a profile id; does not grant policy permissions. */
    allowedProfiles: z.array(ProfileIdSchema).optional(),
    riskLevel: RiskLevelSchema,
    defaultModel: z.string().min(1).optional(),
    fallbackModels: z.array(z.string().min(1)).optional(),
    systemPrompt: z.string().min(1).optional(),
    testSuite: z.string().min(1).optional(),
    healthCheck: z.string().min(1).optional(),
    publishTargets: z.array(z.string().min(1)).optional(),
    timeoutSeconds: z.number().positive().optional(),
  })
  .strict();

export type ExecutionRecipe = z.infer<typeof ExecutionRecipeSchema>;

export const PlannerOutputSchema = z
  .object({
    selectedRecipeId: z.string().min(1),
    reasoning: z.string().min(1).optional(),
    inputMapping: z.record(z.string(), z.unknown()).optional(),
    overrides: z
      .object({
        model: z.string().min(1).optional(),
        timeoutSeconds: z.number().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;
