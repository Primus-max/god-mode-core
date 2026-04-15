import { describe, expect, it } from "vitest";
import { planExecutionRecipe } from "./planner.js";
import { buildExecutionDecisionInput } from "../decision/input.js";

describe("planExecutionRecipe", () => {
  it("selects doc_ingest for document-first work", () => {
    const plan = planExecutionRecipe({
      prompt: "Extract tables from this PDF estimate and summarize it",
      fileNames: ["estimate.pdf"],
      artifactKinds: ["document", "report"],
      intent: "document",
    });

    expect(plan.profile.selectedProfile.id).toBe("builder");
    expect(plan.recipe.id).toBe("doc_ingest");
    expect(plan.plannerOutput.selectedRecipeId).toBe("doc_ingest");
  });

  it("selects code_build_publish for repository publish work", () => {
    const plan = planExecutionRecipe({
      prompt: "Fix the failing TypeScript build and publish to GitHub",
      fileNames: ["app.ts"],
      publishTargets: ["github"],
      requestedTools: ["exec"],
      intent: "publish",
    });

    expect(plan.profile.selectedProfile.id).toBe("developer");
    expect(plan.recipe.id).toBe("code_build_publish");
    expect(plan.plannerOutput.overrides?.model).toBe("openai/gpt-5.4");
  });

  it("selects ocr_extract for scan-heavy document work", () => {
    const plan = planExecutionRecipe({
      prompt: "Run OCR on this scanned invoice image and extract the totals",
      fileNames: ["invoice-scan.png"],
      artifactKinds: ["document"],
      intent: "document",
    });

    expect(plan.profile.selectedProfile.id).toBe("builder");
    expect(plan.recipe.id).toBe("ocr_extract");
  });

  it("selects table_extract for spreadsheet-heavy document work", () => {
    const plan = planExecutionRecipe({
      prompt: "Extract the table rows from this spreadsheet and export them",
      fileNames: ["estimate.xlsx"],
      artifactKinds: ["document", "data"],
      intent: "document",
    });

    expect(plan.profile.selectedProfile.id).toBe("builder");
    expect(plan.recipe.id).toBe("table_extract");
  });

  it("keeps explicit specialist overrides active for lightweight chat", () => {
    const plan = planExecutionRecipe({
      prompt: "Tell me a joke about robots",
      sessionProfile: "developer",
      intent: "general",
    });

    expect(plan.profile.selectedProfile.id).toBe("developer");
    expect(plan.profile.activeProfile.sessionProfile).toBe("developer");
  });

  it("keeps builder-profile greetings on general_reasoning", () => {
    const plan = planExecutionRecipe({
      prompt: "Привет! Как дела? Просто поздоровайся.",
      sessionProfile: "builder",
      intent: "general",
    });

    expect(plan.profile.selectedProfile.id).toBe("builder");
    expect(plan.recipe.id).toBe("general_reasoning");
  });

  it("selects integration_delivery for integration-heavy work", () => {
    const plan = planExecutionRecipe({
      prompt: "Validate the webhook integration, sync OAuth config, and roll out the connector",
      integrations: ["slack", "webhook"],
      requestedTools: ["exec"],
      intent: "publish",
    });

    expect(plan.profile.selectedProfile.id).toBe("integrator");
    expect(plan.recipe.id).toBe("integration_delivery");
  });

  it("selects ops_orchestration for guarded operator work", () => {
    const plan = planExecutionRecipe({
      prompt: "Check the linked machine, inspect logs, and bootstrap the missing capability",
      requestedTools: ["exec", "process"],
    });

    expect(plan.profile.selectedProfile.id).toBe("operator");
    expect(plan.recipe.id).toBe("ops_orchestration");
  });

  it("selects media_production for multimodal media work", () => {
    const plan = planExecutionRecipe({
      prompt: "Generate a thumbnail image, caption the audio track, and package the media output",
      artifactKinds: ["image", "audio"],
      publishTargets: ["site"],
    });

    expect(plan.profile.selectedProfile.id).toBe("media_creator");
    expect(plan.recipe.id).toBe("media_production");
    expect(plan.plannerOutput.overrides?.model).toBe("openai/gpt-5.4");
  });

  it("selects code_build_publish for website work even when the specialist profile is media_creator", () => {
    const plan = planExecutionRecipe({
      prompt: "Сделай сайт на Vue и Vite, запущу на localhost",
      sessionProfile: "media_creator",
      intent: "code",
      artifactKinds: ["site"],
    });

    expect(plan.profile.selectedProfile.id).toBe("media_creator");
    expect(plan.recipe.id).toBe("code_build_publish");
  });

  it("avoids code_build_publish for PDF-only artifact requests", () => {
    const plan = planExecutionRecipe({
      prompt: "Create a one-page PDF report with Stage 86 test results.",
      artifactKinds: ["document"],
      intent: "document",
    });

    expect(plan.recipe.id).not.toBe("code_build_publish");
  });

  it("does not route mixed pdf plus images requests into media_production", () => {
    const plan = planExecutionRecipe(
      buildExecutionDecisionInput({
        prompt:
          "Надо сделать pdf файл, с инфографикой о жизни городского котика, это просто прикол, но надо пару страниц, красивый формат, можно добавить пару картинок.",
      }),
    );

    expect(plan.profile.selectedProfile.id).toBe("builder");
    expect(plan.recipe.id).not.toBe("media_production");
    expect(plan.recipe.id).toBe("doc_authoring");
  });

  it("selects doc_authoring for prompt-only PDF creation requests", () => {
    const plan = planExecutionRecipe({
      prompt: "Сделай красивый PDF-отчет на 2 страницы с диаграммами и краткими выводами.",
      artifactKinds: ["document"],
      requestedTools: ["pdf"],
      intent: "document",
    });

    expect(plan.profile.selectedProfile.id).toBe("builder");
    expect(plan.recipe.id).toBe("doc_authoring");
  });

  it("selects table_compare for two spreadsheet price comparison prompts", () => {
    const plan = planExecutionRecipe({
      prompt:
        "Compare these two Excel exports for SKU and price differences, then summarize mismatches.",
      fileNames: ["vendor_prices.xlsx", "internal_prices.xlsx"],
      artifactKinds: ["data", "report"],
      intent: "compare",
    });

    expect(plan.profile.selectedProfile.id).toBe("builder");
    expect(plan.recipe.id).toBe("table_compare");
    expect(plan.plannerOutput.selectedRecipeId).toBe("table_compare");
  });

  it("selects table_compare for Russian CSV comparison prompts", () => {
    const plan = planExecutionRecipe({
      prompt: "Сравни два CSV с ценами и покажи расхождения по артикулам.",
      fileNames: ["jan.csv", "feb.csv"],
      intent: "compare",
    });

    expect(plan.recipe.id).toBe("table_compare");
  });

  it("selects calculation_report for ventilation and dimensions prompts", () => {
    const plan = planExecutionRecipe({
      prompt:
        "Compute required ventilation CFM for a 420 sq ft room with 8 ft ceilings and give a short written report with assumptions.",
      artifactKinds: ["report"],
      intent: "calculation",
    });

    expect(plan.recipe.id).toBe("calculation_report");
  });

  it("selects calculation_report for Russian unit and sizing language", () => {
    const plan = planExecutionRecipe({
      prompt:
        "Рассчитай кубатуру помещения 4x5 м при высоте 2.7 м и переведи в кубические футы в отчёте.",
      intent: "calculation",
    });

    expect(plan.recipe.id).toBe("calculation_report");
  });

  it("uses candidateFamilies as the primary family-selection input", () => {
    const plan = planExecutionRecipe({
      prompt: "Fix the failing build and publish to GitHub",
      fileNames: ["app.ts"],
      publishTargets: ["github"],
      requestedTools: ["exec"],
      intent: "publish",
      candidateFamilies: ["general_assistant", "ops_execution"],
      outcomeContract: "external_operation",
    });

    expect(plan.recipe.id).toBe("integration_delivery");
    expect(plan.plannerOutput.reasoning).toContain("Family: ops_execution.");
  });

  it("prefers resolution-contract family selection over legacy cross-family scoring", () => {
    const plan = planExecutionRecipe({
      prompt: "Create a PDF infographic with generated images.",
      contractFirst: true,
      artifactKinds: ["document", "image"],
      requestedTools: ["pdf", "image_generate"],
      intent: "document",
      candidateFamilies: ["document_render", "media_generation"],
      outcomeContract: "structured_artifact",
      resolutionContract: {
        selectedFamily: "document_render",
        candidateFamilies: ["document_render", "media_generation"],
        toolBundles: ["artifact_authoring"],
        routing: {
          localEligible: false,
          remoteProfile: "presentation",
          preferRemoteFirst: true,
          needsVision: false,
        },
      },
    });

    expect(plan.recipe.id).toBe("doc_authoring");
    expect(plan.plannerOutput.reasoning).toContain("Family: document_render.");
  });

  it("does not let prompt-level heuristics override classifier-selected document routing", () => {
    const plan = planExecutionRecipe({
      prompt: "Run OCR on this scanned invoice image and extract the totals.",
      contractFirst: true,
      fileNames: ["invoice-scan.png"],
      artifactKinds: ["document"],
      requestedTools: ["pdf"],
      intent: "document",
      outcomeContract: "structured_artifact",
      candidateFamilies: ["document_render"],
      resolutionContract: {
        selectedFamily: "document_render",
        candidateFamilies: ["document_render"],
        toolBundles: ["artifact_authoring"],
        routing: {
          localEligible: false,
          remoteProfile: "presentation",
          preferRemoteFirst: true,
          needsVision: false,
        },
      },
    });

    expect(plan.recipe.id).toBe("doc_authoring");
    expect(plan.recipe.id).not.toBe("ocr_extract");
  });

  it("does not fall back to family labels in contract-first mode when tool bundles already select authoring", () => {
    const plan = planExecutionRecipe({
      prompt: "Create a polished PDF brief with generated supporting visuals.",
      contractFirst: true,
      artifactKinds: ["document", "image"],
      requestedTools: ["pdf", "image_generate"],
      intent: "document",
      outcomeContract: "structured_artifact",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: true,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: false,
      },
      candidateFamilies: ["analysis_transform"],
      resolutionContract: {
        selectedFamily: "analysis_transform",
        candidateFamilies: ["analysis_transform"],
        toolBundles: ["artifact_authoring"],
        routing: {
          localEligible: false,
          remoteProfile: "presentation",
          preferRemoteFirst: true,
          needsVision: false,
        },
      },
    });

    expect(plan.recipe.id).toBe("doc_authoring");
  });

  it("keeps contract-first document-authoring routing stable across paraphrases", () => {
    const baseInput = {
      contractFirst: true as const,
      artifactKinds: ["document", "image"] as const,
      requestedTools: ["pdf", "image_generate"] as const,
      intent: "document" as const,
      outcomeContract: "structured_artifact" as const,
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: true,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: false,
      },
      resolutionContract: {
        selectedFamily: "analysis_transform" as const,
        candidateFamilies: ["analysis_transform"] as const,
        toolBundles: ["artifact_authoring"] as const,
        routing: {
          localEligible: false,
          remoteProfile: "presentation" as const,
          preferRemoteFirst: true,
          needsVision: false,
        },
      },
    };

    const clean = planExecutionRecipe({
      ...baseInput,
      prompt: "Create a polished infographic PDF from these notes with supporting visuals.",
    });
    const noisy = planExecutionRecipe({
      ...baseInput,
      prompt:
        "Собери визуальный PDF из заметок с инфографикой и иллюстрациями, без правок репозитория.",
    });

    expect(clean.recipe.id).toBe("doc_authoring");
    expect(noisy.recipe.id).toBe("doc_authoring");
    expect(clean.recipe.id).toBe(noisy.recipe.id);
  });

  it("keeps contract-first workspace-change routing stable across paraphrases", () => {
    const baseInput = {
      contractFirst: true as const,
      artifactKinds: ["binary"] as const,
      requestedTools: ["apply_patch", "exec", "process"] as const,
      intent: "code" as const,
      outcomeContract: "workspace_change" as const,
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: true,
        requiresLocalProcess: true,
        requiresArtifactEvidence: false,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: true,
      },
      resolutionContract: {
        selectedFamily: "general_assistant" as const,
        candidateFamilies: ["general_assistant"] as const,
        toolBundles: ["repo_mutation", "repo_run"] as const,
        routing: {
          localEligible: false,
          remoteProfile: "code" as const,
          preferRemoteFirst: false,
          needsVision: false,
        },
      },
    };

    const clean = planExecutionRecipe({
      ...baseInput,
      prompt: "Fix failing behavior in this repository and run local validation checks.",
    });
    const noisy = planExecutionRecipe({
      ...baseInput,
      prompt: "Поправь код в репозитории и прогони нужные проверки локально перед завершением.",
    });

    expect(clean.recipe.id).toBe("code_build_publish");
    expect(noisy.recipe.id).toBe("code_build_publish");
    expect(clean.recipe.id).toBe(noisy.recipe.id);
  });

  it("prefers the simplest valid family instead of a broader execution family", () => {
    const plan = planExecutionRecipe({
      prompt: "Compare these two CSV exports and summarize row-level differences.",
      fileNames: ["old.csv", "new.csv"],
      artifactKinds: ["data", "report"],
      intent: "compare",
      outcomeContract: "structured_artifact",
      candidateFamilies: ["document_render", "analysis_transform"],
    });

    expect(plan.recipe.id).toBe("table_compare");
    expect(plan.plannerOutput.reasoning).toContain("Family: analysis_transform.");
  });

  it("falls back to legacy scoring only when candidateFamilies are absent", () => {
    const plan = planExecutionRecipe({
      prompt: "Generate a thumbnail image and caption the audio track",
      artifactKinds: ["image", "audio"],
      publishTargets: ["site"],
    });

    expect(plan.recipe.id).toBe("media_production");
  });

  it("uses clarify strategy to avoid forced execution on ambiguous publish prompts", () => {
    const plan = planExecutionRecipe(
      buildExecutionDecisionInput({
        prompt: "Ship it.",
      }),
    );

    expect(plan.recipe.id).toBe("general_reasoning");
    expect(plan.plannerOutput.reasoning).toContain("Low-confidence strategy: clarify.");
    expect(plan.plannerOutput.reasoning).toContain(
      "external operation is inferred without an explicit publish target",
    );
  });
});
