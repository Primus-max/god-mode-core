import { describe, expect, it } from "vitest";
import { planExecutionRecipe, type RecipePlannerInput } from "../recipe/planner.js";
import { adaptExecutionPlanToRuntime } from "../recipe/runtime-adapter.js";
import { buildExecutionDecisionInput } from "../decision/input.js";
import {
  buildExecutionIntentSeedFromRecipeRuntimePlan,
  deriveExecutionContractExpectationsFromRuntimePlan,
} from "./execution-intent-from-plan.js";
import { createPlatformRuntimeCheckpointService, resetPlatformRuntimeCheckpointService } from "./index.js";

describe("execution intent from recipe runtime plan", () => {
  it("requires output when intent is non-general or artifacts/publish targets exist", () => {
    const generalInput = { prompt: "hi", intent: "general" as const };
    const generalPlan = planExecutionRecipe(generalInput);
    const generalRuntime = adaptExecutionPlanToRuntime(generalPlan, { input: generalInput });
    expect(deriveExecutionContractExpectationsFromRuntimePlan(generalRuntime)).toEqual({});

    const codeInput = {
      prompt: "fix tests",
      intent: "code" as const,
      requestedTools: ["exec"],
    };
    const codePlan = planExecutionRecipe(codeInput);
    const codeRuntime = adaptExecutionPlanToRuntime(codePlan, { input: codeInput });
    expect(deriveExecutionContractExpectationsFromRuntimePlan(codeRuntime)).toEqual({
      requiresOutput: true,
    });
  });

  it("builds a seed compatible with buildExecutionIntent", () => {
    resetPlatformRuntimeCheckpointService();
    const docInput: RecipePlannerInput = {
      prompt: "Parse this PDF estimate into a report",
      fileNames: ["estimate.pdf"],
      artifactKinds: ["document", "report"],
      intent: "document",
    };
    const plan = planExecutionRecipe(docInput);
    const runtime = adaptExecutionPlanToRuntime(plan, { input: docInput });
    const seed = buildExecutionIntentSeedFromRecipeRuntimePlan(runtime);
    const service = createPlatformRuntimeCheckpointService();
    const intent = service.buildExecutionIntent({
      runId: "run-test",
      executionIntent: seed,
    });
    expect(intent.profileId).toBe(runtime.selectedProfileId);
    expect(intent.recipeId).toBe(runtime.selectedRecipeId);
    expect(intent.deliverable).toEqual(runtime.deliverable);
    expect(intent.outcomeContract).toBe("structured_artifact");
    expect(intent.executionContract).toEqual(
      expect.objectContaining({
        requiresArtifactEvidence: true,
      }),
    );
    expect(intent.requestedEvidence).toEqual(["tool_receipt", "artifact_descriptor"]);
    expect(intent.expectations.requiresOutput).toBe(true);
  });

  it("keeps clarify as a follow-up mode instead of rewriting the qualified contract", () => {
    const runtime = adaptExecutionPlanToRuntime(
      planExecutionRecipe(
        buildExecutionDecisionInput({
          prompt: "Ship it.",
        }),
      ),
      {
        input: buildExecutionDecisionInput({
          prompt: "Ship it.",
        }),
      },
    );
    const seed = buildExecutionIntentSeedFromRecipeRuntimePlan(runtime);

    expect(seed.outcomeContract).toBe("text_response");
    expect(seed.lowConfidenceStrategy).toBeUndefined();
    expect(seed.expectations).toEqual({ requiresOutput: true });
  });
});
