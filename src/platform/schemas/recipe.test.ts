import { describe, expect, it } from "vitest";
import { ExecutionRecipeSchema, PlannerOutputSchema } from "./recipe.js";

describe("ExecutionRecipeSchema", () => {
  const minimal = {
    id: "general_reasoning",
    purpose: "General-purpose chat and reasoning",
    acceptedInputs: [{ type: "text" }],
    riskLevel: "none",
  } as const;

  it("accepts a minimal recipe", () => {
    expect(ExecutionRecipeSchema.parse(minimal)).toEqual(minimal);
  });

  it("accepts a full recipe", () => {
    const full = {
      id: "code_build_publish",
      purpose: "Build, test, and publish code artifacts",
      summary: "Repository-first execution flow",
      acceptedInputs: [
        { type: "text", required: true, description: "Task description" },
        { type: "file", required: false, description: "Source files" },
      ],
      producedArtifacts: [
        { type: "binary", description: "Built artifact" },
        { type: "release", description: "Published release" },
      ],
      requiredCapabilities: ["node", "git"],
      allowedProfiles: ["developer"],
      riskLevel: "high",
      defaultModel: "openai/gpt-4o-mini",
      fallbackModels: ["anthropic/claude-sonnet-4.6"],
      systemPrompt: "Run the smallest safe set of checks before publishing.",
      testSuite: "test/recipes/code-build.test.ts",
      healthCheck: "node --version && git --version",
      publishTargets: ["github", "npm"],
      timeoutSeconds: 600,
    };
    expect(ExecutionRecipeSchema.parse(full)).toEqual(full);
  });

  it("rejects empty acceptedInputs", () => {
    expect(ExecutionRecipeSchema.safeParse({ ...minimal, acceptedInputs: [] }).success).toBe(false);
  });

  it("rejects unknown riskLevel", () => {
    expect(ExecutionRecipeSchema.safeParse({ ...minimal, riskLevel: "extreme" }).success).toBe(
      false,
    );
  });

  it("rejects extra fields (strict)", () => {
    expect(ExecutionRecipeSchema.safeParse({ ...minimal, bonus: true }).success).toBe(false);
  });

  it("rejects empty requiredCapabilities entries", () => {
    expect(
      ExecutionRecipeSchema.safeParse({
        ...minimal,
        requiredCapabilities: ["node", ""],
      }).success,
    ).toBe(false);
  });
});

describe("PlannerOutputSchema", () => {
  it("accepts minimal output", () => {
    const output = { selectedRecipeId: "general_reasoning" };
    expect(PlannerOutputSchema.parse(output)).toEqual(output);
  });

  it("accepts output with overrides", () => {
    const output = {
      selectedRecipeId: "doc_ingest",
      reasoning: "User uploaded a PDF",
      inputMapping: { file: "upload.pdf" },
      overrides: { model: "openai/gpt-4o", timeoutSeconds: 120 },
    };
    expect(PlannerOutputSchema.parse(output)).toEqual(output);
  });

  it("rejects empty selectedRecipeId", () => {
    expect(PlannerOutputSchema.safeParse({ selectedRecipeId: "" }).success).toBe(false);
  });

  it("rejects empty reasoning string", () => {
    expect(
      PlannerOutputSchema.safeParse({ selectedRecipeId: "general_reasoning", reasoning: "" })
        .success,
    ).toBe(false);
  });

  it("rejects empty override model string", () => {
    expect(
      PlannerOutputSchema.safeParse({
        selectedRecipeId: "general_reasoning",
        overrides: { model: "" },
      }).success,
    ).toBe(false);
  });
});
