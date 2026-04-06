import type { RecipeRuntimePlan } from "../recipe/runtime-adapter.js";
import type {
  PlatformRuntimeExecutionContractExpectation,
  PlatformRuntimeExecutionIntent,
} from "./contracts.js";

/**
 * Seed object for `PlatformRuntimeCheckpointService.buildExecutionIntent` built from a resolved
 * `RecipeRuntimePlan`. Centralizes the field mapping so `run.ts` and other callers stay thin.
 */
export type PlatformRuntimeExecutionIntentSeed = Partial<
  Omit<PlatformRuntimeExecutionIntent, "runId" | "expectations">
> & {
  expectations: PlatformRuntimeExecutionContractExpectation;
};

export function deriveExecutionContractExpectationsFromRuntimePlan(
  runtime: RecipeRuntimePlan,
): PlatformRuntimeExecutionContractExpectation {
  const declaredRequiresOutput =
    runtime.intent !== "general" ||
    (runtime.publishTargets?.length ?? 0) > 0 ||
    (runtime.artifactKinds?.length ?? 0) > 0;
  return declaredRequiresOutput ? { requiresOutput: true } : {};
}

/** Maps a recipe runtime plan into execution-intent seed fields (no `runId`). */
export function buildExecutionIntentSeedFromRecipeRuntimePlan(
  runtime: RecipeRuntimePlan,
): PlatformRuntimeExecutionIntentSeed {
  const expectations = deriveExecutionContractExpectationsFromRuntimePlan(runtime);
  return {
    profileId: runtime.selectedProfileId,
    recipeId: runtime.selectedRecipeId,
    ...(runtime.taskOverlayId ? { taskOverlayId: runtime.taskOverlayId } : {}),
    ...(runtime.plannerReasoning ? { plannerReasoning: runtime.plannerReasoning } : {}),
    ...(runtime.intent ? { intent: runtime.intent } : {}),
    ...(runtime.publishTargets?.length ? { publishTargets: runtime.publishTargets } : {}),
    ...(runtime.artifactKinds?.length ? { artifactKinds: runtime.artifactKinds } : {}),
    ...(runtime.requestedToolNames?.length
      ? { requestedToolNames: runtime.requestedToolNames }
      : {}),
    ...(runtime.requiredCapabilities?.length
      ? { requiredCapabilities: runtime.requiredCapabilities }
      : {}),
    ...(runtime.bootstrapRequiredCapabilities?.length
      ? { bootstrapRequiredCapabilities: runtime.bootstrapRequiredCapabilities }
      : {}),
    ...(runtime.requireExplicitApproval !== undefined
      ? { requireExplicitApproval: runtime.requireExplicitApproval }
      : {}),
    ...(runtime.policyAutonomy ? { policyAutonomy: runtime.policyAutonomy } : {}),
    expectations,
  };
}
