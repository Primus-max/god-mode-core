import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { parseModelRef } from "../../agents/model-selection.js";
import type { RecipePlannerInput } from "./planner.js";
import { planExecutionRecipe, type ExecutionPlan } from "./planner.js";

export type RecipeRuntimePlan = {
  selectedRecipeId: string;
  selectedProfileId: string;
  providerOverride?: string;
  modelOverride?: string;
  fallbackModels?: string[];
  timeoutSeconds?: number;
  prependSystemContext?: string;
  prependContext?: string;
};

export type ResolvedPlatformRuntimePlan = ExecutionPlan & {
  runtime: RecipeRuntimePlan;
};

function buildSystemContext(plan: ExecutionPlan): string {
  return [
    `Execution recipe: ${plan.recipe.id}.`,
    plan.recipe.summary ? `Recipe summary: ${plan.recipe.summary}` : undefined,
    plan.recipe.systemPrompt,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildPrependContext(plan: ExecutionPlan): string {
  return [
    `Profile: ${plan.profile.selectedProfile.label}.`,
    plan.profile.effective.taskOverlay?.label
      ? `Task overlay: ${plan.profile.effective.taskOverlay.label}.`
      : undefined,
    plan.plannerOutput.reasoning ? `Planner reasoning: ${plan.plannerOutput.reasoning}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

export function adaptExecutionPlanToRuntime(plan: ExecutionPlan): RecipeRuntimePlan {
  const overrideModel = plan.plannerOutput.overrides?.model;
  const parsedModel = overrideModel ? parseModelRef(overrideModel, DEFAULT_PROVIDER) : null;
  const prependSystemContext = buildSystemContext(plan);
  const prependContext = buildPrependContext(plan);

  return {
    selectedRecipeId: plan.recipe.id,
    selectedProfileId: plan.profile.selectedProfile.id,
    ...(parsedModel?.provider ? { providerOverride: parsedModel.provider } : {}),
    ...(parsedModel?.model ? { modelOverride: parsedModel.model } : {}),
    ...(plan.recipe.fallbackModels?.length ? { fallbackModels: plan.recipe.fallbackModels } : {}),
    ...(plan.plannerOutput.overrides?.timeoutSeconds
      ? { timeoutSeconds: plan.plannerOutput.overrides.timeoutSeconds }
      : {}),
    ...(prependSystemContext ? { prependSystemContext } : {}),
    ...(prependContext ? { prependContext } : {}),
  };
}

export function resolvePlatformRuntimePlan(input: RecipePlannerInput): ResolvedPlatformRuntimePlan {
  const plan = planExecutionRecipe(input);
  return {
    ...plan,
    runtime: adaptExecutionPlanToRuntime(plan),
  };
}
