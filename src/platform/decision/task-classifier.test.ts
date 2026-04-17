import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolvePlatformRuntimePlan } from "../recipe/runtime-adapter.js";
import {
  buildPlannerInputFromTaskContract,
  classifyTaskForDecision,
  resolveTaskClassifierConfig,
  type TaskClassifierAdapter,
  type TaskContract,
} from "./task-classifier.js";

describe("task classifier config", () => {
  it("uses gpt-5-mini defaults with the built-in backend", () => {
    const cfg = {} as OpenClawConfig;

    expect(resolveTaskClassifierConfig({ cfg })).toEqual({
      enabled: true,
      backend: "pi-simple",
      model: "hydra/gpt-5-mini",
      timeoutMs: 20_000,
      maxTokens: 450,
    });
  });
});

describe("classifyTaskForDecision", () => {
  it("routes through a replaceable configured backend adapter", async () => {
    const classify = vi.fn<TaskClassifierAdapter["classify"]>().mockResolvedValue({
      primaryOutcome: "comparison_report",
      requiredCapabilities: ["needs_web_research"],
      interactionMode: "tool_execution",
      confidence: 0.91,
      ambiguities: [],
    });
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            taskClassifier: {
              backend: "stub-backend",
              model: "ollama/qwen3:14b",
              timeoutMs: 9_000,
              maxTokens: 321,
            },
          },
        },
      },
    } as OpenClawConfig;

    const classified = await classifyTaskForDecision({
      prompt: "Compare the latest public cloud GPU pricing and summarize the differences.",
      cfg,
      adapterRegistry: {
        "stub-backend": {
          classify,
        },
      },
    });

    expect(classified.source).toBe("llm");
    expect(classify).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Compare the latest public cloud GPU pricing and summarize the differences.",
        fileNames: [],
        config: expect.objectContaining({
          backend: "stub-backend",
          model: "ollama/qwen3:14b",
          timeoutMs: 9_000,
          maxTokens: 321,
        }),
      }),
    );
    expect(classified.plannerInput).toEqual(
      expect.objectContaining({
        contractFirst: true,
        intent: "compare",
        requestedTools: ["web_search"],
        outcomeContract: "text_response",
        resolutionContract: expect.objectContaining({
          selectedFamily: "analysis_transform",
          toolBundles: expect.arrayContaining(["public_web_lookup"]),
        }),
      }),
    );
  });

  it("retries once on classifier runtime failure and succeeds without fallback guessing", async () => {
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            taskClassifier: {
              backend: "stub-backend",
            },
          },
        },
      },
    } as OpenClawConfig;
    const classify = vi
      .fn<TaskClassifierAdapter["classify"]>()
      .mockRejectedValueOnce(new Error("temporary upstream failure"))
      .mockResolvedValueOnce({
        primaryOutcome: "comparison_report",
        requiredCapabilities: ["needs_web_research"],
        interactionMode: "tool_execution",
        confidence: 0.81,
        ambiguities: [],
      });

    const classified = await classifyTaskForDecision({
      prompt: "Research current public pricing for three hosted vector databases.",
      cfg,
      adapterRegistry: {
        "stub-backend": {
          classify,
        },
      },
    });

    expect(classify).toHaveBeenCalledTimes(2);
    expect(classified.source).toBe("llm");
    expect(classified.plannerInput).toEqual(
      expect.objectContaining({
        contractFirst: true,
        intent: "compare",
        outcomeContract: "text_response",
        requestedTools: ["web_search"],
      }),
    );
    expect(classified.taskContract.primaryOutcome).toBe("comparison_report");
    expect(classified.taskContract.interactionMode).toBe("tool_execution");
    expect(classified.taskContract.requiredCapabilities).toEqual(["needs_web_research"]);
  });

  it("returns fail-closed when the adapter keeps failing after retry", async () => {
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            taskClassifier: {
              backend: "stub-backend",
            },
          },
        },
      },
    } as OpenClawConfig;

    const classify = vi
      .fn<TaskClassifierAdapter["classify"]>()
      .mockRejectedValue(new Error("classifier unavailable"));

    const classified = await classifyTaskForDecision({
      prompt: "Publish to GitHub after running the checks.",
      cfg,
      adapterRegistry: {
        "stub-backend": {
          classify,
        },
      },
    });

    expect(classify).toHaveBeenCalledTimes(2);
    expect(classified.source).toBe("fail_closed");
    expect(classified.taskContract).toEqual({
      primaryOutcome: "clarification_needed",
      requiredCapabilities: [],
      interactionMode: "clarify_first",
      confidence: 0,
      ambiguities: ["task classifier unavailable"],
    });
    expect(classified.plannerInput).toEqual(
      expect.objectContaining({
        contractFirst: true,
        intent: "general",
        outcomeContract: "text_response",
        lowConfidenceStrategy: "clarify",
        requestedEvidence: ["assistant_text"],
      }),
    );
  });

  it("returns fail-closed when adapter output is null instead of using heuristic fallback", async () => {
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            taskClassifier: {
              backend: "stub-backend",
            },
          },
        },
      },
    } as OpenClawConfig;
    const events: Array<{ stage: string; message?: string; parseResult?: string }> = [];

    const classified = await classifyTaskForDecision({
      prompt: "Publish to GitHub after running the checks.",
      cfg,
      adapterRegistry: {
        "stub-backend": {
          classify: vi.fn().mockResolvedValue(null),
        },
      },
      onDebugEvent: (event) => {
        events.push({
          stage: event.stage,
          message: event.message,
          parseResult: event.parseResult,
        });
      },
    });

    expect(classified.source).toBe("fail_closed");
    expect(classified.taskContract.primaryOutcome).toBe("clarification_needed");
    expect(classified.taskContract.requiredCapabilities).toEqual([]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "fallback",
          message: "classifier returned no valid contract; returning fail-closed clarification contract",
        }),
      ]),
    );
  });

  it("accepts near-valid JSON classifier output with unicode punctuation", async () => {
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            taskClassifier: {
              backend: "stub-backend",
            },
          },
        },
      },
    } as OpenClawConfig;

    const classified = await classifyTaskForDecision({
      prompt: "Create a polished infographic PDF from these notes.",
      cfg,
      adapterRegistry: {
        "stub-backend": {
          classify: vi.fn().mockResolvedValue({
            primaryOutcome: "document_package",
            requiredCapabilities: ["needs_multimodal_authoring"],
            interactionMode: "artifact_iteration",
            confidence: 0.8,
            ambiguities: [],
          }),
        },
      },
    });

    expect(classified.source).toBe("llm");
    expect(classified.taskContract.primaryOutcome).toBe("document_package");
  });

  it("drops high-reliability-provider drift for non-delivery workspace changes", async () => {
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            taskClassifier: {
              backend: "stub-backend",
            },
          },
        },
      },
    } as OpenClawConfig;

    const classified = await classifyTaskForDecision({
      prompt: "Patch the repo, run the checks, and leave the local validation passing.",
      cfg,
      adapterRegistry: {
        "stub-backend": {
          classify: vi.fn().mockResolvedValue({
            primaryOutcome: "workspace_change",
            requiredCapabilities: [
              "needs_workspace_mutation",
              "needs_repo_execution",
              "needs_local_runtime",
              "needs_high_reliability_provider",
            ],
            interactionMode: "tool_execution",
            confidence: 0.73,
            ambiguities: [],
          }),
        },
      },
    });

    expect(classified.source).toBe("llm");
    expect(classified.taskContract.primaryOutcome).toBe("workspace_change");
    expect(classified.taskContract.requiredCapabilities).toEqual(
      expect.not.arrayContaining(["needs_high_reliability_provider"]),
    );
    expect(classified.taskContract.requiredCapabilities).toEqual(
      expect.arrayContaining([
        "needs_workspace_mutation",
        "needs_repo_execution",
        "needs_local_runtime",
      ]),
    );
  });

  it("drops tabular-reasoning drift from document extraction contracts", async () => {
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            taskClassifier: {
              backend: "stub-backend",
            },
          },
        },
      },
    } as OpenClawConfig;

    const classified = await classifyTaskForDecision({
      prompt: "Extract vendor names, invoice dates, and totals from the attached PDF packet.",
      fileNames: ["invoice-pack.pdf"],
      cfg,
      adapterRegistry: {
        "stub-backend": {
          classify: vi.fn().mockResolvedValue({
            primaryOutcome: "document_extraction",
            requiredCapabilities: ["needs_document_extraction", "needs_tabular_reasoning"],
            interactionMode: "tool_execution",
            confidence: 0.95,
            ambiguities: [],
          }),
        },
      },
    });

    expect(classified.source).toBe("llm");
    expect(classified.taskContract.requiredCapabilities).toEqual(["needs_document_extraction"]);
  });

  it("drops workspace-mutation drift for external delivery contracts", async () => {
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            taskClassifier: {
              backend: "stub-backend",
            },
          },
        },
      },
    } as OpenClawConfig;

    const classified = await classifyTaskForDecision({
      prompt: "Run the release checks and publish the already-prepared build to production once validation passes.",
      cfg,
      adapterRegistry: {
        "stub-backend": {
          classify: vi.fn().mockResolvedValue({
            primaryOutcome: "external_delivery",
            requiredCapabilities: [
              "needs_workspace_mutation",
              "needs_repo_execution",
              "needs_external_delivery",
            ],
            interactionMode: "tool_execution",
            confidence: 0.88,
            ambiguities: [],
          }),
        },
      },
    });

    expect(classified.source).toBe("llm");
    expect(classified.taskContract.requiredCapabilities).toEqual([
      "needs_external_delivery",
      "needs_repo_execution",
    ]);
  });

  it("drops tabular-reasoning drift from web-research contracts", async () => {
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            taskClassifier: {
              backend: "stub-backend",
            },
          },
        },
      },
    } as OpenClawConfig;

    const classified = await classifyTaskForDecision({
      prompt: "Research current public pricing for three hosted vector databases and compare the tradeoffs.",
      cfg,
      adapterRegistry: {
        "stub-backend": {
          classify: vi.fn().mockResolvedValue({
            primaryOutcome: "comparison_report",
            requiredCapabilities: ["needs_web_research", "needs_tabular_reasoning"],
            interactionMode: "respond_only",
            confidence: 0.72,
            ambiguities: [],
          }),
        },
      },
    });

    expect(classified.source).toBe("llm");
    expect(classified.taskContract.interactionMode).toBe("tool_execution");
    expect(classified.taskContract.requiredCapabilities).toEqual(["needs_web_research"]);
  });

  it("normalizes analytical outcomes to respond-only when no tool capability remains", async () => {
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            taskClassifier: {
              backend: "stub-backend",
            },
          },
        },
      },
    } as OpenClawConfig;

    const classified = await classifyTaskForDecision({
      prompt: "Compare the attached pricing sheets and summarize SKU-level price differences.",
      fileNames: ["vendor-a.xlsx", "vendor-b.xlsx"],
      cfg,
      adapterRegistry: {
        "stub-backend": {
          classify: vi.fn().mockResolvedValue({
            primaryOutcome: "comparison_report",
            requiredCapabilities: ["needs_tabular_reasoning"],
            interactionMode: "tool_execution",
            confidence: 0.9,
            ambiguities: [],
          }),
        },
      },
    });

    expect(classified.source).toBe("llm");
    expect(classified.taskContract.interactionMode).toBe("respond_only");
    expect(classified.taskContract.requiredCapabilities).toEqual(["needs_tabular_reasoning"]);
  });

  it("drops external-delivery drift for non-delivery document authoring", async () => {
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            taskClassifier: {
              backend: "stub-backend",
            },
          },
        },
      },
    } as OpenClawConfig;

    const classified = await classifyTaskForDecision({
      prompt: "Create a polished infographic PDF from these notes with supporting visuals.",
      cfg,
      adapterRegistry: {
        "stub-backend": {
          classify: vi.fn().mockResolvedValue({
            primaryOutcome: "document_package",
            requiredCapabilities: [
              "needs_multimodal_authoring",
              "needs_external_delivery",
              "needs_high_reliability_provider",
            ],
            interactionMode: "artifact_iteration",
            confidence: 0.83,
            ambiguities: [],
          }),
        },
      },
    });

    expect(classified.source).toBe("llm");
    expect(classified.taskContract.primaryOutcome).toBe("document_package");
    expect(classified.taskContract.interactionMode).toBe("artifact_iteration");
    expect(classified.taskContract.requiredCapabilities).toEqual(["needs_multimodal_authoring"]);
  });

  it("drops multimodal-authoring drift for pure visual document packages", async () => {
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            taskClassifier: {
              backend: "stub-backend",
            },
          },
        },
      },
    } as OpenClawConfig;

    const classified = await classifyTaskForDecision({
      prompt: "Create a cartoon poster image with bright colors and clean composition.",
      cfg,
      adapterRegistry: {
        "stub-backend": {
          classify: vi.fn().mockResolvedValue({
            primaryOutcome: "document_package",
            requiredCapabilities: ["needs_visual_composition", "needs_multimodal_authoring"],
            interactionMode: "artifact_iteration",
            confidence: 0.9,
            ambiguities: [],
          }),
        },
      },
    });

    expect(classified.source).toBe("llm");
    expect(classified.taskContract.requiredCapabilities).toEqual([
      "needs_multimodal_authoring",
      "needs_visual_composition",
    ]);
  });

  it("does not reinterpret extraction prompts with attachments after llm classification", async () => {
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            taskClassifier: {
              backend: "stub-backend",
            },
          },
        },
      },
    } as OpenClawConfig;

    const classified = await classifyTaskForDecision({
      prompt: "Extract vendor names, invoice dates, and totals from the attached PDF packet.",
      fileNames: ["invoice-pack.pdf"],
      cfg,
      adapterRegistry: {
        "stub-backend": {
          classify: vi.fn().mockResolvedValue({
            primaryOutcome: "document_package",
            requiredCapabilities: ["needs_multimodal_authoring", "needs_visual_composition"],
            interactionMode: "artifact_iteration",
            confidence: 0.79,
            ambiguities: [],
          }),
        },
      },
    });

    expect(classified.taskContract).toEqual({
      primaryOutcome: "document_package",
      interactionMode: "artifact_iteration",
      requiredCapabilities: ["needs_multimodal_authoring", "needs_visual_composition"],
      confidence: 0.79,
      ambiguities: [],
    });
  });

  it("does not reinterpret browser observation prompts after llm classification", async () => {
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            taskClassifier: {
              backend: "stub-backend",
            },
          },
        },
      },
    } as OpenClawConfig;

    const classified = await classifyTaskForDecision({
      prompt: "Open the local app, click through the signup flow, and report any visible UI or console issues.",
      cfg,
      adapterRegistry: {
        "stub-backend": {
          classify: vi.fn().mockResolvedValue({
            primaryOutcome: "workspace_change",
            requiredCapabilities: ["needs_workspace_mutation", "needs_repo_execution"],
            interactionMode: "tool_execution",
            confidence: 0.71,
            ambiguities: [],
          }),
        },
      },
    });

    expect(classified.taskContract.primaryOutcome).toBe("workspace_change");
    expect(classified.taskContract.interactionMode).toBe("tool_execution");
    expect(classified.taskContract.requiredCapabilities).toEqual([
      "needs_repo_execution",
      "needs_workspace_mutation",
    ]);
  });

  it("does not reinterpret standalone visual generation prompts after llm classification", async () => {
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            taskClassifier: {
              backend: "stub-backend",
            },
          },
        },
      },
    } as OpenClawConfig;

    const classified = await classifyTaskForDecision({
      prompt: "Create a cartoon poster image of a rasta cat with bright colors and clean composition.",
      cfg,
      adapterRegistry: {
        "stub-backend": {
          classify: vi.fn().mockResolvedValue({
            primaryOutcome: "answer",
            requiredCapabilities: [],
            interactionMode: "respond_only",
            confidence: 0.76,
            ambiguities: [],
          }),
        },
      },
    });

    expect(classified.taskContract).toEqual({
      primaryOutcome: "answer",
      interactionMode: "respond_only",
      requiredCapabilities: [],
      confidence: 0.76,
      ambiguities: [],
      deliverable: { kind: "answer", acceptedFormats: ["text"] },
    });
  });

  it("does not promote explicit delivery prompts after llm classification", async () => {
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            taskClassifier: {
              backend: "stub-backend",
            },
          },
        },
      },
    } as OpenClawConfig;

    const classified = await classifyTaskForDecision({
      prompt: "Run the release checks and publish the already-prepared build to production once validation passes.",
      cfg,
      adapterRegistry: {
        "stub-backend": {
          classify: vi.fn().mockResolvedValue({
            primaryOutcome: "workspace_change",
            requiredCapabilities: ["needs_workspace_mutation", "needs_repo_execution"],
            interactionMode: "tool_execution",
            confidence: 0.82,
            ambiguities: [],
          }),
        },
      },
    });

    expect(classified.taskContract.primaryOutcome).toBe("workspace_change");
    expect(classified.taskContract.interactionMode).toBe("tool_execution");
    expect(classified.taskContract.requiredCapabilities).toEqual([
      "needs_repo_execution",
      "needs_workspace_mutation",
    ]);
  });

  it("dedupes arrays and clamps confidence during canonicalization", async () => {
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            taskClassifier: {
              backend: "stub-backend",
            },
          },
        },
      },
    } as OpenClawConfig;

    const classified = await classifyTaskForDecision({
      prompt:
        "Нужно именно выпустить уже готовую сборку в прод: сначала прогони релизные проверки, потом публикуй, без правок исходников.",
      cfg,
      adapterRegistry: {
        "stub-backend": {
          classify: vi.fn().mockResolvedValue({
            primaryOutcome: "external_delivery",
            requiredCapabilities: [
              "needs_repo_execution",
              "needs_external_delivery",
              "needs_repo_execution",
            ],
            interactionMode: "tool_execution",
            confidence: 1.78,
            ambiguities: ["missing target", "missing target"],
          }),
        },
      },
    });

    expect(classified.taskContract).toEqual({
      primaryOutcome: "external_delivery",
      interactionMode: "tool_execution",
      requiredCapabilities: ["needs_external_delivery", "needs_repo_execution"],
      confidence: 1,
      ambiguities: ["missing target"],
      deliverable: { kind: "external_delivery", acceptedFormats: ["receipt"] },
    });
  });

  it("does not reinterpret xlsx attachments after llm classification", async () => {
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            taskClassifier: {
              backend: "stub-backend",
            },
          },
        },
      },
    } as OpenClawConfig;

    const classified = await classifyTaskForDecision({
      prompt: "Compare the attached pricing sheets and summarize SKU-level price differences.",
      fileNames: ["vendor-a.xlsx", "vendor-b.xlsx"],
      cfg,
      adapterRegistry: {
        "stub-backend": {
          classify: vi.fn().mockResolvedValue({
            primaryOutcome: "comparison_report",
            requiredCapabilities: ["needs_document_extraction", "needs_tabular_reasoning"],
            interactionMode: "respond_only",
            confidence: 0.86,
            ambiguities: [],
          }),
        },
      },
    });

    expect(classified.taskContract.primaryOutcome).toBe("comparison_report");
    expect(classified.taskContract.interactionMode).toBe("respond_only");
    expect(classified.taskContract.requiredCapabilities).toEqual([
      "needs_document_extraction",
      "needs_tabular_reasoning",
    ]);
  });

  it("returns fail-closed when the classifier is disabled", async () => {
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            taskClassifier: {
              enabled: false,
            },
          },
        },
      },
    } as OpenClawConfig;

    const classified = await classifyTaskForDecision({
      prompt: "Create a cartoon poster image of a rasta cat with bright colors and clean composition.",
      cfg,
    });

    expect(classified.source).toBe("fail_closed");
    expect(classified.taskContract.primaryOutcome).toBe("clarification_needed");
    expect(classified.taskContract.interactionMode).toBe("clarify_first");
    expect(classified.taskContract.requiredCapabilities).toEqual([]);
    expect(classified.taskContract.ambiguities).toEqual(["task classifier unavailable"]);
    expect(classified.plannerInput.outcomeContract).toBe("text_response");
    expect(classified.plannerInput.lowConfidenceStrategy).toBe("clarify");
  });
});

describe("contract-first task contract routing", () => {
  it("routes pure image-generation contracts into media production", () => {
    const taskContract: TaskContract = {
      primaryOutcome: "document_package",
      requiredCapabilities: ["needs_visual_composition"],
      interactionMode: "artifact_iteration",
      confidence: 0.93,
      ambiguities: [],
    };

    const imagePrompt = buildPlannerInputFromTaskContract({
      prompt: "Сделай яркую смешную cartoon-картинку банана без лишних вопросов.",
      taskContract,
    });
    const imageRuntime = resolvePlatformRuntimePlan(imagePrompt);

    expect(imagePrompt.contractFirst).toBe(true);
    expect(imagePrompt.intent).toBeUndefined();
    expect(imagePrompt.artifactKinds).toEqual(["image"]);
    expect(imagePrompt.requestedTools).toEqual(["image_generate"]);
    expect(imagePrompt.resolutionContract?.selectedFamily).toBe("media_generation");
    expect(imageRuntime.runtime.selectedProfileId).toBe("media_creator");
    expect(imageRuntime.runtime.selectedRecipeId).toBe("media_production");
  });

  it("keeps document authoring stable across two noisy prompt phrasings", () => {
    const taskContract: TaskContract = {
      primaryOutcome: "document_package",
      requiredCapabilities: ["needs_multimodal_authoring"],
      interactionMode: "artifact_iteration",
      confidence: 0.94,
      ambiguities: [],
    };

    const scannedInvoicePrompt = buildPlannerInputFromTaskContract({
      prompt:
        "Run OCR on this scanned invoice, pull the tables if needed, and make the final result a polished infographic PDF with visuals.",
      taskContract,
    });
    const cityCatPrompt = buildPlannerInputFromTaskContract({
      prompt:
        "Сделай красочный PDF про жизнь городского котика, с инфографикой, парой картинок и нормальной визуальной подачей.",
      taskContract,
    });

    const scannedInvoiceRuntime = resolvePlatformRuntimePlan(scannedInvoicePrompt);
    const cityCatRuntime = resolvePlatformRuntimePlan(cityCatPrompt);

    expect(scannedInvoicePrompt.contractFirst).toBe(true);
    expect(cityCatPrompt.contractFirst).toBe(true);
    expect(scannedInvoiceRuntime.runtime.selectedRecipeId).toBe("doc_authoring");
    expect(cityCatRuntime.runtime.selectedRecipeId).toBe("doc_authoring");
    expect(scannedInvoiceRuntime.runtime.selectedRecipeId).not.toBe("ocr_extract");
    expect(cityCatRuntime.runtime.selectedRecipeId).not.toBe("media_production");
  });

  it("keeps workspace-change routing stable across two different repo-edit phrasings", () => {
    const taskContract: TaskContract = {
      primaryOutcome: "workspace_change",
      requiredCapabilities: [
        "needs_workspace_mutation",
        "needs_repo_execution",
        "needs_local_runtime",
      ],
      interactionMode: "tool_execution",
      confidence: 0.89,
      ambiguities: [],
    };

    const sitePrompt = buildPlannerInputFromTaskContract({
      prompt: "Сделай сайт, поправь код в репозитории и подними локальный рантайм для проверки.",
      taskContract,
    });
    const repoPrompt = buildPlannerInputFromTaskContract({
      prompt: "Patch the repo, run the checks, and leave the local preview working before you finish.",
      taskContract,
    });

    const siteRuntime = resolvePlatformRuntimePlan(sitePrompt);
    const repoRuntime = resolvePlatformRuntimePlan(repoPrompt);

    expect(sitePrompt.contractFirst).toBe(true);
    expect(repoPrompt.contractFirst).toBe(true);
    expect(siteRuntime.runtime.selectedRecipeId).toBe("code_build_publish");
    expect(repoRuntime.runtime.selectedRecipeId).toBe("code_build_publish");
    expect(siteRuntime.runtime.outcomeContract).toBe("workspace_change");
    expect(repoRuntime.runtime.outcomeContract).toBe("workspace_change");
    expect(siteRuntime.runtime.requestedToolNames).toEqual(
      expect.arrayContaining(["apply_patch", "exec", "process"]),
    );
    expect(repoRuntime.runtime.requestedToolNames).toEqual(
      expect.arrayContaining(["apply_patch", "exec", "process"]),
    );
  });

  it("maps multimodal document packages to both pdf and image generation with structured evidence", () => {
    const taskContract: TaskContract = {
      primaryOutcome: "document_package",
      requiredCapabilities: ["needs_multimodal_authoring"],
      interactionMode: "artifact_iteration",
      confidence: 0.95,
      ambiguities: [],
      deliverable: {
        kind: "document",
        preferredFormat: "pdf",
        acceptedFormats: ["pdf"],
      },
    };

    const plannerInput = buildPlannerInputFromTaskContract({
      prompt: "Сделай PDF-отчёт с инфографикой и парой поддерживающих картинок.",
      taskContract,
    });

    expect(plannerInput.contractFirst).toBe(true);
    expect(plannerInput.artifactKinds).toEqual(["document", "image"]);
    expect(plannerInput.requestedTools).toEqual(expect.arrayContaining(["pdf", "image_generate"]));
    expect(plannerInput.outcomeContract).toBe("structured_artifact");
    expect(plannerInput.executionContract).toEqual(
      expect.objectContaining({
        requiresTools: true,
        requiresArtifactEvidence: true,
      }),
    );
  });

  it("preserves site artifacts as interactive local results instead of structured documents", () => {
    const plannerInput = buildPlannerInputFromTaskContract({
      prompt: "Сделай локальный сайт и оставь рабочий preview.",
      taskContract: {
        primaryOutcome: "workspace_change",
        requiredCapabilities: [
          "needs_workspace_mutation",
          "needs_repo_execution",
          "needs_local_runtime",
        ],
        interactionMode: "tool_execution",
        confidence: 0.91,
        ambiguities: [],
      },
    });

    const runtime = resolvePlatformRuntimePlan({
      ...plannerInput,
      artifactKinds: ["site"],
      outcomeContract: "interactive_local_result",
      executionContract: {
        ...plannerInput.executionContract,
        requiresTools: true,
        requiresWorkspaceMutation: true,
        requiresLocalProcess: true,
      },
    });

    expect(runtime.runtime.outcomeContract).toBe("interactive_local_result");
    expect(runtime.runtime.requestedToolNames).toEqual(
      expect.arrayContaining(["apply_patch", "exec", "process"]),
    );
  });
});
