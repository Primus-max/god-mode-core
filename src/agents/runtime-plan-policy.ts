import type { RecipeRuntimePlan } from "../platform/recipe/runtime-adapter.js";

export function resolveRuntimePlanFallbackOverride(params: {
  runtimePlan: Pick<RecipeRuntimePlan, "fallbackModels">;
  configuredFallbacks?: string[];
}): string[] | undefined {
  return params.runtimePlan.fallbackModels ?? params.configuredFallbacks;
}

export function resolveRuntimePlanTimeoutSeconds(params: {
  runtimePlan?: Pick<RecipeRuntimePlan, "timeoutSeconds">;
  explicitTimeoutSeconds?: number;
}): number | undefined {
  return params.explicitTimeoutSeconds ?? params.runtimePlan?.timeoutSeconds;
}

export function joinRuntimePlanSystemPrompt(params: {
  runtimePlan?: Pick<RecipeRuntimePlan, "prependSystemContext">;
  extraSystemPrompt?: string;
}): string | undefined {
  const parts = [
    params.runtimePlan?.prependSystemContext?.trim(),
    params.extraSystemPrompt?.trim(),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export function prependRuntimePlanContextToPrompt(params: {
  runtimePlan?: Pick<RecipeRuntimePlan, "prependContext">;
  prompt: string;
}): string {
  const runtimeContext = params.runtimePlan?.prependContext?.trim();
  if (!runtimeContext) {
    return params.prompt;
  }
  return [runtimeContext, params.prompt].filter(Boolean).join("\n\n");
}
