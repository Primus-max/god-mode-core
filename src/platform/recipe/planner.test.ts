import { describe, expect, it } from "vitest";
import { planExecutionRecipe } from "./planner.js";

describe("planExecutionRecipe", () => {
  it("selects doc_ingest from document extraction contract fields", () => {
    const plan = planExecutionRecipe({
      prompt: "Extract tables from this PDF estimate and summarize it",
      contractFirst: true,
      artifactKinds: ["document", "report"],
      outcomeContract: "structured_artifact",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: true,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: true,
      },
      resolutionContract: {
        selectedFamily: "document_render",
        candidateFamilies: ["document_render"],
        toolBundles: ["document_extraction"],
        routing: {
          localEligible: false,
          remoteProfile: "strong",
          preferRemoteFirst: true,
          needsVision: false,
        },
      },
    });

    expect(plan.profile.selectedProfile.id).toBe("builder");
    expect(plan.recipe.id).toBe("doc_ingest");
    expect(plan.plannerOutput.selectedRecipeId).toBe("doc_ingest");
  });

  it("selects code_build_publish for repository publish contracts", () => {
    const plan = planExecutionRecipe({
      prompt: "Fix the failing TypeScript build and publish to GitHub",
      contractFirst: true,
      artifactKinds: ["site", "release"],
      outcomeContract: "workspace_change",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: true,
        requiresLocalProcess: true,
        requiresArtifactEvidence: false,
        requiresDeliveryEvidence: true,
        mayNeedBootstrap: false,
      },
      resolutionContract: {
        selectedFamily: "code_build",
        candidateFamilies: ["code_build"],
        toolBundles: ["repo_mutation", "repo_run", "external_delivery"],
        routing: {
          localEligible: false,
          remoteProfile: "code",
          preferRemoteFirst: true,
          needsVision: false,
        },
      },
    });

    expect(plan.profile.selectedProfile.id).toBe("developer");
    expect(plan.recipe.id).toBe("code_build_publish");
    expect(plan.plannerOutput.overrides?.model).toBe("hydra/gpt-5.4");
  });

  it("does not infer ocr_extract without classifier-derived extraction subtype", () => {
    const plan = planExecutionRecipe({
      prompt: "Run OCR on this scanned invoice image and extract the totals",
      contractFirst: true,
      artifactKinds: ["document"],
      outcomeContract: "structured_artifact",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: true,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: true,
      },
      resolutionContract: {
        selectedFamily: "document_render",
        candidateFamilies: ["document_render"],
        toolBundles: ["document_extraction"],
        routing: {
          localEligible: false,
          remoteProfile: "strong",
          preferRemoteFirst: true,
          needsVision: true,
        },
      },
    });

    expect(plan.profile.selectedProfile.id).toBe("builder");
    expect(plan.recipe.id).toBe("doc_ingest");
  });

  it("does not infer table_extract from spreadsheet wording alone", () => {
    const plan = planExecutionRecipe({
      prompt: "Extract the table rows from this spreadsheet and export them",
      contractFirst: true,
      artifactKinds: ["document", "data"],
      outcomeContract: "structured_artifact",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: true,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: true,
      },
      resolutionContract: {
        selectedFamily: "document_render",
        candidateFamilies: ["document_render"],
        toolBundles: ["document_extraction"],
        routing: {
          localEligible: false,
          remoteProfile: "strong",
          preferRemoteFirst: true,
          needsVision: false,
        },
      },
    });

    expect(plan.profile.selectedProfile.id).toBe("builder");
    expect(plan.recipe.id).toBe("doc_ingest");
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

  it("keeps builder-profile greetings on general_reasoning with respond-only contract", () => {
    const plan = planExecutionRecipe({
      prompt: "Привет! Как дела? Просто поздоровайся.",
      contractFirst: true,
      sessionProfile: "builder",
      outcomeContract: "text_response",
      executionContract: {
        requiresTools: false,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: false,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: false,
      },
      resolutionContract: {
        selectedFamily: "general_assistant",
        candidateFamilies: ["general_assistant"],
        toolBundles: ["respond_only"],
        routing: {
          localEligible: true,
          remoteProfile: "cheap",
          preferRemoteFirst: false,
          needsVision: false,
        },
      },
    });

    expect(plan.profile.selectedProfile.id).toBe("builder");
    expect(plan.recipe.id).toBe("general_reasoning");
  });

  it("selects integration_delivery for integration-heavy contracts", () => {
    const plan = planExecutionRecipe({
      prompt: "Validate the webhook integration, sync OAuth config, and roll out the connector",
      contractFirst: true,
      outcomeContract: "external_operation",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: false,
        requiresDeliveryEvidence: true,
        mayNeedBootstrap: false,
      },
      resolutionContract: {
        selectedFamily: "ops_execution",
        candidateFamilies: ["ops_execution"],
        toolBundles: ["external_delivery"],
        routing: {
          localEligible: false,
          remoteProfile: "strong",
          preferRemoteFirst: true,
          needsVision: false,
        },
      },
    });

    expect(plan.profile.selectedProfile.id).toBe("integrator");
    expect(plan.recipe.id).toBe("integration_delivery");
  });

  it("selects ops_orchestration for guarded operator contracts", () => {
    const plan = planExecutionRecipe({
      prompt: "Check the linked machine, inspect logs, and bootstrap the missing capability",
      contractFirst: true,
      outcomeContract: "interactive_local_result",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: true,
        requiresArtifactEvidence: false,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: true,
      },
      resolutionContract: {
        selectedFamily: "ops_execution",
        candidateFamilies: ["ops_execution"],
        toolBundles: ["repo_run"],
        routing: {
          localEligible: true,
          remoteProfile: "strong",
          preferRemoteFirst: false,
          needsVision: false,
        },
      },
    });

    expect(plan.profile.selectedProfile.id).toBe("operator");
    expect(plan.recipe.id).toBe("ops_orchestration");
  });

  it("keeps browser-observation contracts out of general_reasoning", () => {
    const plan = planExecutionRecipe({
      prompt: "Open the local app in a browser, inspect the signup flow, and report visible issues.",
      contractFirst: true,
      outcomeContract: "text_response",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: false,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: false,
      },
      resolutionContract: {
        selectedFamily: "general_assistant",
        candidateFamilies: ["general_assistant"],
        toolBundles: ["interactive_browser"],
        routing: {
          localEligible: false,
          remoteProfile: "strong",
          preferRemoteFirst: true,
          needsVision: true,
        },
      },
    });

    expect(plan.recipe.id).not.toBe("general_reasoning");
  });

  it("keeps public-web research contracts analytical instead of artifact-authoring", () => {
    const plan = planExecutionRecipe({
      prompt: "Research current public GPU pricing and summarize the best options.",
      contractFirst: true,
      outcomeContract: "text_response",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: false,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: false,
      },
      resolutionContract: {
        selectedFamily: "analysis_transform",
        candidateFamilies: ["analysis_transform"],
        toolBundles: ["public_web_lookup"],
        routing: {
          localEligible: false,
          remoteProfile: "strong",
          preferRemoteFirst: true,
          needsVision: false,
        },
      },
    });

    expect(["table_compare", "calculation_report", "general_reasoning"]).toContain(plan.recipe.id);
    expect(plan.recipe.id).not.toBe("doc_authoring");
    expect(plan.recipe.id).not.toBe("media_production");
  });

  it("selects media_production for multimodal media contracts", () => {
    const plan = planExecutionRecipe({
      prompt: "Generate a thumbnail image, caption the audio track, and package the media output",
      contractFirst: true,
      artifactKinds: ["image", "audio"],
      outcomeContract: "structured_artifact",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: true,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: false,
      },
      resolutionContract: {
        selectedFamily: "media_generation",
        candidateFamilies: ["media_generation"],
        toolBundles: ["artifact_authoring"],
        routing: {
          localEligible: false,
          remoteProfile: "presentation",
          preferRemoteFirst: true,
          needsVision: false,
        },
      },
    });

    expect(plan.profile.selectedProfile.id).toBe("media_creator");
    expect(plan.recipe.id).toBe("media_production");
    expect(plan.plannerOutput.overrides?.model).toBe("hydra/gpt-5.4");
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
    const plan = planExecutionRecipe({
      prompt:
        "Надо сделать pdf файл, с инфографикой о жизни городского котика, это просто прикол, но надо пару страниц, красивый формат, можно добавить пару картинок.",
      contractFirst: true,
      artifactKinds: ["document", "image"],
      requestedTools: ["pdf", "image_generate"],
      outcomeContract: "structured_artifact",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: true,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: false,
      },
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

    expect(plan.profile.selectedProfile.id).toBe("builder");
    expect(plan.recipe.id).not.toBe("media_production");
    expect(plan.recipe.id).toBe("doc_authoring");
  });

  it("selects doc_authoring for document-authoring contracts", () => {
    const plan = planExecutionRecipe({
      prompt: "Сделай красивый PDF-отчет на 2 страницы с диаграммами и краткими выводами.",
      contractFirst: true,
      artifactKinds: ["document"],
      outcomeContract: "structured_artifact",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: true,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: false,
      },
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

    expect(plan.profile.selectedProfile.id).toBe("builder");
    expect(plan.recipe.id).toBe("doc_authoring");
  });

  it("selects table_compare for analytical comparison contracts", () => {
    const plan = planExecutionRecipe({
      prompt:
        "Compare these two Excel exports for SKU and price differences, then summarize mismatches.",
      contractFirst: true,
      artifactKinds: ["data", "report"],
      outcomeContract: "text_response",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: false,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: false,
      },
      resolutionContract: {
        selectedFamily: "analysis_transform",
        candidateFamilies: ["analysis_transform"],
        toolBundles: ["public_web_lookup"],
        routing: {
          localEligible: false,
          remoteProfile: "strong",
          preferRemoteFirst: true,
          needsVision: false,
        },
      },
    });

    expect(plan.profile.selectedProfile.id).toBe("builder");
    expect(plan.recipe.id).toBe("table_compare");
    expect(plan.plannerOutput.selectedRecipeId).toBe("table_compare");
  });

  it("selects table_compare from analytical comparison contract fields", () => {
    const plan = planExecutionRecipe({
      prompt: "Сравни два CSV с ценами и покажи расхождения по артикулам.",
      contractFirst: true,
      sessionProfile: "builder",
      artifactKinds: ["data", "report"],
      outcomeContract: "text_response",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: false,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: false,
      },
      resolutionContract: {
        selectedFamily: "analysis_transform",
        candidateFamilies: ["analysis_transform"],
        toolBundles: ["public_web_lookup"],
        routing: {
          localEligible: false,
          remoteProfile: "strong",
          preferRemoteFirst: true,
          needsVision: false,
        },
      },
    });

    expect(plan.recipe.id).toBe("table_compare");
  });

  it("selects calculation_report from calculation-style contract fields", () => {
    const plan = planExecutionRecipe({
      prompt:
        "Compute required ventilation CFM for a 420 sq ft room with 8 ft ceilings and give a short written report with assumptions.",
      contractFirst: true,
      sessionProfile: "general",
      artifactKinds: [],
      outcomeContract: "text_response",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: false,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: false,
      },
      resolutionContract: {
        selectedFamily: "analysis_transform",
        candidateFamilies: ["analysis_transform"],
        toolBundles: ["public_web_lookup"],
        routing: {
          localEligible: false,
          remoteProfile: "strong",
          preferRemoteFirst: true,
          needsVision: false,
        },
      },
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

  it("prefers analysis-scoped contract routing over broader document scoring", () => {
    const plan = planExecutionRecipe({
      prompt: "Compare these two CSV exports and summarize row-level differences.",
      contractFirst: true,
      sessionProfile: "builder",
      artifactKinds: ["data", "report"],
      outcomeContract: "text_response",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: false,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: false,
      },
      candidateFamilies: ["document_render", "analysis_transform"],
      resolutionContract: {
        selectedFamily: "analysis_transform",
        candidateFamilies: ["analysis_transform", "document_render"],
        toolBundles: ["public_web_lookup"],
        routing: {
          localEligible: false,
          remoteProfile: "strong",
          preferRemoteFirst: true,
          needsVision: false,
        },
      },
    });

    expect(plan.recipe.id).toBe("table_compare");
    expect(plan.plannerOutput.reasoning).toContain("Family: analysis_transform.");
  });

  it("falls back to legacy scoring only when candidateFamilies are absent and a specialist is pinned", () => {
    const plan = planExecutionRecipe({
      prompt: "Generate a thumbnail image and caption the audio track",
      sessionProfile: "media_creator",
      artifactKinds: ["image", "audio"],
      publishTargets: ["site"],
    });

    expect(plan.recipe.id).toBe("media_production");
  });

  it("uses clarify strategy to avoid forced execution on ambiguous publish prompts", () => {
    const plan = planExecutionRecipe({
      prompt: "Ship it.",
      contractFirst: true,
      outcomeContract: "external_operation",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: false,
        requiresDeliveryEvidence: true,
        mayNeedBootstrap: false,
      },
      confidence: "medium",
      lowConfidenceStrategy: "clarify",
      ambiguityReasons: ["external operation is inferred without an explicit publish target"],
      resolutionContract: {
        selectedFamily: "ops_execution",
        candidateFamilies: ["ops_execution"],
        toolBundles: ["external_delivery"],
        routing: {
          localEligible: false,
          remoteProfile: "code",
          preferRemoteFirst: true,
          needsVision: false,
        },
      },
    });

    expect(plan.recipe.id).toBe("general_reasoning");
    expect(plan.plannerOutput.reasoning).toContain("Low-confidence strategy: clarify.");
    expect(plan.plannerOutput.reasoning).toContain(
      "external operation is inferred without an explicit publish target",
    );
  });
});
