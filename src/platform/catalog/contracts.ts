import { z } from "zod";
import { SpecialistProfileOptionSchema } from "../profile/contracts.js";
import { CapabilityCatalogEntrySchema, CapabilityCatalogSourceSchema } from "../schemas/capability.js";
import { RecipeInputSchema, RecipeOutputSchema, RiskLevelSchema } from "../schemas/recipe.js";

export const RecipeCatalogSummarySchema = z
  .object({
    id: z.string().min(1),
    purpose: z.string().min(1),
    summary: z.string().min(1).optional(),
    riskLevel: RiskLevelSchema,
    allowedProfiles: z.array(SpecialistProfileOptionSchema),
    requiredCapabilities: z.array(z.string().min(1)),
    publishTargets: z.array(z.string().min(1)),
    producedArtifacts: z.array(RecipeOutputSchema),
    timeoutSeconds: z.number().positive().optional(),
  })
  .strict();
export type RecipeCatalogSummary = z.infer<typeof RecipeCatalogSummarySchema>;

export const RecipeCatalogDetailSchema = RecipeCatalogSummarySchema.extend({
  acceptedInputs: z.array(RecipeInputSchema),
  defaultModel: z.string().min(1).optional(),
  fallbackModels: z.array(z.string().min(1)).optional(),
  systemPrompt: z.string().min(1).optional(),
  testSuite: z.string().min(1).optional(),
  healthCheck: z.string().min(1).optional(),
}).strict();
export type RecipeCatalogDetail = z.infer<typeof RecipeCatalogDetailSchema>;

export const CapabilityRecipeReferenceSchema = z
  .object({
    id: z.string().min(1),
    purpose: z.string().min(1),
    summary: z.string().min(1).optional(),
  })
  .strict();
export type CapabilityRecipeReference = z.infer<typeof CapabilityRecipeReferenceSchema>;

export const CapabilityCatalogSummarySchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string().min(1).optional(),
    status: z.string().min(1),
    source: CapabilityCatalogSourceSchema,
    trusted: z.boolean(),
    installMethod: z.string().min(1).optional(),
    sandboxed: z.boolean().optional(),
    requiredBins: z.array(z.string().min(1)),
    requiredEnv: z.array(z.string().min(1)),
    healthCheckCommand: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)),
    requiredByRecipes: z.array(CapabilityRecipeReferenceSchema),
    requiredByRecipeCount: z.number().nonnegative(),
  })
  .strict();
export type CapabilityCatalogSummary = z.infer<typeof CapabilityCatalogSummarySchema>;

export const CapabilityCatalogDetailSchema = CapabilityCatalogSummarySchema.extend({
  catalogEntry: CapabilityCatalogEntrySchema,
}).strict();
export type CapabilityCatalogDetail = z.infer<typeof CapabilityCatalogDetailSchema>;
