import { describe, expect, it } from "vitest";
import type { ExecutionRecipe } from "../schemas/index.js";
import { planExecutionRecipe } from "./planner.js";
import { adaptExecutionPlanToRuntime, resolvePlatformRuntimePlan } from "./runtime-adapter.js";

describe("resolvePlatformRuntimePlan", () => {
  it("projects recipe timeout and prompt context into runtime hints", () => {
    const resolved = resolvePlatformRuntimePlan({
      prompt: "Parse this PDF estimate into a report",
      fileNames: ["estimate.pdf"],
      artifactKinds: ["document", "report"],
      baseProfile: "general",
      intent: "document",
    });

    expect(resolved.runtime.selectedRecipeId).toBe("doc_ingest");
    expect(resolved.runtime.timeoutSeconds).toBe(180);
    expect(resolved.runtime.prependSystemContext).toContain("Execution recipe: doc_ingest.");
    expect(resolved.runtime.prependContext).toContain("Planner reasoning:");
  });

  it("parses recipe model overrides and fallback chains", () => {
    const customRecipe: ExecutionRecipe = {
      id: "code_build_publish",
      purpose: "Build and publish code artifacts",
      acceptedInputs: [{ type: "text", required: true }],
      allowedProfiles: ["developer"],
      riskLevel: "high",
      defaultModel: "openai/gpt-4o-mini",
      fallbackModels: ["anthropic/claude-sonnet-4.6"],
      timeoutSeconds: 300,
    };
    const generalRecipe: ExecutionRecipe = {
      id: "general_reasoning",
      purpose: "General reasoning",
      acceptedInputs: [{ type: "text" }],
      riskLevel: "none",
    };

    const planned = planExecutionRecipe({
      prompt: "Fix the build and publish to GitHub",
      publishTargets: ["github"],
      fileNames: ["repo.ts"],
      requestedTools: ["exec"],
      baseProfile: "general",
      intent: "publish",
      recipes: [generalRecipe, customRecipe],
    });
    const runtime = adaptExecutionPlanToRuntime(planned);

    expect(runtime.providerOverride).toBe("openai");
    expect(runtime.modelOverride).toBe("gpt-4o-mini");
    expect(runtime.fallbackModels).toEqual(["anthropic/claude-sonnet-4.6"]);
  });
});
