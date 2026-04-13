import { describe, expect, it } from "vitest";
import { TRUSTED_CAPABILITY_CATALOG } from "../bootstrap/defaults.js";
import { buildExecutionDecisionInput } from "../decision/input.js";
import { applySessionSpecialistOverrideToPlannerInput } from "../profile/index.js";
import { createCapabilityRegistry } from "../registry/capability-registry.js";
import type { ExecutionRecipe } from "../schemas/index.js";
import { planExecutionRecipe } from "./planner.js";
import {
  adaptExecutionPlanToRuntime,
  buildRecipePlannerInputFromRuntimePlan,
  resolvePlatformRuntimePlan,
} from "./runtime-adapter.js";

describe("resolvePlatformRuntimePlan", () => {
  it("projects recipe timeout and prompt context into runtime hints", () => {
    const resolved = resolvePlatformRuntimePlan({
      prompt: "Parse this PDF estimate into a report",
      fileNames: ["estimate.pdf"],
      artifactKinds: ["document", "report"],
      intent: "document",
    });

    expect(resolved.runtime.selectedRecipeId).toBe("doc_ingest");
    expect(resolved.runtime.selectedProfileId).toBe("builder");
    expect(resolved.runtime.taskOverlayId).toBe("document_first");
    expect(resolved.runtime.plannerReasoning).toContain("doc_ingest");
    expect(resolved.runtime.outcomeContract).toBe("structured_artifact");
    expect(resolved.runtime.executionContract).toEqual(
      expect.objectContaining({
        requiresArtifactEvidence: true,
      }),
    );
    expect(resolved.runtime.requestedEvidence).toEqual(["tool_receipt", "artifact_descriptor"]);
    expect(resolved.runtime.timeoutSeconds).toBe(180);
    expect(resolved.runtime.requiredCapabilities).toEqual(["pdf-parser"]);
    expect(resolved.capabilitySummary.requirements).toEqual([
      expect.objectContaining({
        capabilityId: "pdf-parser",
      }),
    ]);
    expect(resolved.capabilitySummary.bootstrapResolutions[0]?.request?.executionContext).toEqual(
      expect.objectContaining({
        profileId: "builder",
        recipeId: "doc_ingest",
        requiredCapabilities: ["pdf-parser"],
      }),
    );
    expect(resolved.runtime.prependSystemContext).toContain("Execution recipe: doc_ingest.");
    expect(resolved.runtime.prependSystemContext).toContain(
      "Reply in the same language as the user's latest message",
    );
    expect(resolved.runtime.prependSystemContext).toContain(
      "do not claim completion without producing a real artifact or attachment",
    );
    expect(resolved.runtime.prependContext).toContain("Planner reasoning:");
    expect(resolved.runtime.prependContext).toContain(
      "Language continuity: Reply in the same language as the user's latest message",
    );
    expect(resolved.runtime.prependContext).toContain("Builder domain context:");
    expect(resolved.runtime.prependContext).toMatch(/SNiP\/SP\/GOST/i);
    expect(resolved.runtime.prependContext).toMatch(/assumptions/i);
    expect(resolved.runtime.prependContext).toMatch(/formulas/i);
    expect(resolved.runtime.prependContext).toMatch(/60 m3\/h per person/i);
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
      intent: "publish",
      recipes: [generalRecipe, customRecipe],
    });
    const runtime = adaptExecutionPlanToRuntime(planned);

    expect(runtime.prependContext).not.toContain("Builder domain context:");
    expect(runtime.providerOverride).toBe("openai");
    expect(runtime.modelOverride).toBe("gpt-4o-mini");
    expect(runtime.fallbackModels).toEqual(["anthropic/claude-sonnet-4.6"]);
  });

  it("lets persisted specialist overrides change the selected profile and recipe", () => {
    const autoResolved = resolvePlatformRuntimePlan({
      prompt: "Parse this PDF estimate into a report",
      fileNames: ["estimate.pdf"],
      artifactKinds: ["document", "report"],
      intent: "document",
    });
    const overridden = resolvePlatformRuntimePlan(
      applySessionSpecialistOverrideToPlannerInput(
        {
          prompt: "Parse this PDF estimate into a report",
          fileNames: ["estimate.pdf"],
          artifactKinds: ["document", "report"],
          intent: "document",
        },
        {
          specialistOverrideMode: "session",
          specialistSessionProfileId: "developer",
        },
      ),
    );

    expect(autoResolved.runtime.selectedProfileId).toBe("builder");
    expect(autoResolved.runtime.selectedRecipeId).toBe("doc_ingest");
    expect(overridden.runtime.selectedProfileId).toBe("developer");
    expect(overridden.runtime.selectedRecipeId).not.toBe("doc_ingest");
  });

  it("projects integration and media specialist routes into runtime", () => {
    const integrationResolved = resolvePlatformRuntimePlan({
      prompt: "Validate the webhook integration and roll out the connector",
      integrations: ["webhook", "slack"],
      requestedTools: ["exec"],
      intent: "publish",
    });
    const mediaResolved = resolvePlatformRuntimePlan({
      prompt: "Generate a thumbnail image and caption the audio track",
      artifactKinds: ["image", "audio"],
      publishTargets: ["site"],
    });

    expect(integrationResolved.runtime.selectedProfileId).toBe("integrator");
    expect(integrationResolved.runtime.selectedRecipeId).toBe("integration_delivery");
    expect(mediaResolved.runtime.selectedProfileId).toBe("media_creator");
    expect(mediaResolved.runtime.selectedRecipeId).toBe("media_production");
  });

  it("adds explicit tool-use guardrails for image and pdf artifact turns", () => {
    const resolved = resolvePlatformRuntimePlan({
      prompt: "Сделай веселый банан и собери презентацию в PDF.",
      artifactKinds: ["image", "document"],
      requestedTools: ["image_generate", "pdf"],
    });

    expect(resolved.runtime.prependSystemContext).toContain("must call image_generate before your first final answer");
    expect(resolved.runtime.prependSystemContext).toContain("must use the pdf tool before your first final answer");
    expect(resolved.runtime.prependSystemContext).toContain(
      "pass the requested document content in the pdf tool's `prompt` argument",
    );
    expect(resolved.runtime.prependSystemContext).toContain(
      "Do not call `pdf` with an empty object for a prompt-only PDF task.",
    );
    expect(resolved.runtime.prependSystemContext).toContain(
      "Do not fake PDF output, manually write PDF bytes, or bypass the pdf tool with write/exec",
    );
  });

  it("adds policy preview and bootstrap hints to the execution decision", () => {
    const resolved = resolvePlatformRuntimePlan({
      prompt: "Fix the failing TypeScript build and publish to GitHub",
      fileNames: ["app.ts"],
      publishTargets: ["github"],
      requestedTools: ["exec"],
      intent: "publish",
    });

    expect(resolved.policyContext.requestedCapabilities).toBeUndefined();
    expect(resolved.policyPreview.requireExplicitApproval).toBe(true);
    expect(resolved.runtime.policyAutonomy).toBe("assist");
    expect(resolved.runtime.requireExplicitApproval).toBe(true);
    expect(resolved.runtime.readinessStatus).toBe("approval_required");
    expect(resolved.runtime.readinessReasons?.join(" ")).toContain("Explicit approval");
  });

  it("marks bootstrap-required document flows as ready for unattended continuation", () => {
    const resolved = resolvePlatformRuntimePlan({
      prompt: "Parse this PDF into a report and repair the renderer if needed",
      fileNames: ["estimate.pdf"],
      artifactKinds: ["document", "report"],
      intent: "document",
    });

    expect(resolved.runtime.readinessStatus).toBe("bootstrap_required");
    expect(resolved.runtime.unattendedBoundary).toBe("bootstrap");
    expect(resolved.runtime.readinessReasons?.join(" ")).toContain("Bootstrap required");
  });

  it("keeps compare flows ready when the required table parser is already available", () => {
    const capabilityRegistry = createCapabilityRegistry([], TRUSTED_CAPABILITY_CATALOG);
    const resolved = resolvePlatformRuntimePlan(
      {
        prompt: "Сравни два CSV-прайс-листа и дай короткий отчет по расхождениям.",
        fileNames: ["offer-a.csv", "offer-b.csv"],
        artifactKinds: ["data", "report"],
        intent: "compare",
      },
      { capabilityRegistry },
    );

    expect(resolved.runtime.selectedRecipeId).toBe("table_compare");
    expect(resolved.policyPreview.requireExplicitApproval).toBe(false);
    expect(resolved.runtime.readinessStatus).toBe("ready");
    expect(resolved.runtime.requiredCapabilities).toBeUndefined();
    expect(resolved.runtime.bootstrapRequiredCapabilities).toBeUndefined();
  });

  it("marks compare flows as bootstrap-resumable when table parser is missing", () => {
    const resolved = resolvePlatformRuntimePlan({
      prompt: "Сравни два прайс-листа и дай короткий отчет по расхождениям.",
      fileNames: ["offer-a.xlsx", "offer-b.xlsx"],
      artifactKinds: ["data", "report"],
      intent: "compare",
    });

    expect(resolved.runtime.selectedRecipeId).toBe("table_compare");
    expect(resolved.runtime.readinessStatus).toBe("bootstrap_required");
    expect(resolved.runtime.unattendedBoundary).toBe("bootstrap");
    expect(resolved.runtime.bootstrapRequiredCapabilities).toEqual(["table-parser"]);
  });

  it("does not require pdf-parser for prompt-only PDF generation", () => {
    const resolved = resolvePlatformRuntimePlan({
      prompt: "Create a one-page PDF with a short summary.",
      artifactKinds: ["document"],
      intent: "document",
    });

    expect(resolved.runtime.selectedRecipeId).toBe("doc_ingest");
    expect(resolved.runtime.requiredCapabilities).toBeUndefined();
    expect(resolved.runtime.bootstrapRequiredCapabilities).toBeUndefined();
    expect(resolved.runtime.readinessStatus).toBe("ready");
  });
});

describe("buildRecipePlannerInputFromRuntimePlan", () => {
  it("copies structured runtime fields onto the prompt without prompt-only inference", () => {
    const input = {
      prompt: "Ship the preview to production",
      publishTargets: ["vercel"],
      requestedTools: ["exec"],
      intent: "publish" as const,
      candidateFamilies: ["ops_execution"] as const,
    };
    const plan = planExecutionRecipe(input);
    const runtime = adaptExecutionPlanToRuntime(plan, { input });
    const replay = buildRecipePlannerInputFromRuntimePlan(runtime, "hello", {
      fileNames: ["app.ts"],
    });
    expect(replay.prompt).toBe("hello");
    expect(replay.intent).toBe("publish");
    expect(replay.candidateFamilies).toEqual(["ops_execution"]);
    expect(replay.outcomeContract).toBe("external_operation");
    expect(replay.executionContract).toEqual(
      expect.objectContaining({
        requiresTools: true,
      }),
    );
    expect(replay.requestedEvidence).toEqual(["tool_receipt", "capability_receipt"]);
    expect(replay.publishTargets).toEqual(["vercel"]);
    expect(replay.requestedTools).toEqual(["exec"]);
    expect(replay.fileNames).toEqual(["app.ts"]);
  });

  it("preserves low-confidence clarification state across runtime replay", () => {
    const input = buildExecutionDecisionInput({
      prompt: "Ship it.",
    });
    const plan = planExecutionRecipe(input);
    const runtime = adaptExecutionPlanToRuntime(plan, { input });
    const replay = buildRecipePlannerInputFromRuntimePlan(runtime, "continue");

    expect(replay.confidence).toBe("medium");
    expect(replay.ambiguityReasons).toEqual([
      "external operation is inferred without an explicit publish target",
    ]);
    expect(replay.lowConfidenceStrategy).toBe("clarify");
    expect(replay.outcomeContract).toBe("external_operation");
    expect(replay.requestedTools ?? []).toEqual(["exec", "apply_patch", "process"]);
  });

  it("keeps qualified publish semantics in runtime while switching clarify turns into follow-up mode", () => {
    const input = buildExecutionDecisionInput({
      prompt: "Ship it.",
    });
    const resolved = resolvePlatformRuntimePlan(input);

    expect(resolved.runtime.outcomeContract).toBe("external_operation");
    expect(resolved.runtime.executionContract).toEqual(
      expect.objectContaining({
        requiresTools: true,
        requiresLocalProcess: true,
      }),
    );
    expect(resolved.runtime.requestedToolNames).toEqual(["exec", "apply_patch", "process"]);
    expect(resolved.runtime.prependSystemContext).toContain("Clarification path:");
    expect(resolved.runtime.prependSystemContext).not.toContain(
      "must call image_generate before your first final answer",
    );
  });
});
