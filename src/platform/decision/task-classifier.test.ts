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
      allowHeuristicFallback: true,
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

  it("keeps heuristics as a fallback when the adapter fails", async () => {
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            taskClassifier: {
              backend: "stub-backend",
              allowHeuristicFallback: true,
            },
          },
        },
      },
    } as OpenClawConfig;

    const classified = await classifyTaskForDecision({
      prompt: "Publish to GitHub after running the checks.",
      cfg,
      adapterRegistry: {
        "stub-backend": {
          classify: vi.fn().mockRejectedValue(new Error("classifier unavailable")),
        },
      },
    });

    expect(classified.source).toBe("heuristic");
    expect(classified.plannerInput).toEqual(
      expect.objectContaining({
        contractFirst: true,
        intent: "publish",
        publishTargets: ["external"],
        requestedTools: ["exec", "process"],
      }),
    );
    expect(classified.taskContract.primaryOutcome).toBe("external_delivery");
    expect(classified.taskContract.requiredCapabilities).toEqual(
      expect.arrayContaining([
        "needs_external_delivery",
        "needs_repo_execution",
        "needs_local_runtime",
      ]),
    );
    expect(classified.taskContract.requiredCapabilities).toEqual(
      expect.not.arrayContaining(["needs_workspace_mutation"]),
    );
  });

  it("surfaces classifier failures when heuristic fallback is disabled", async () => {
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            taskClassifier: {
              backend: "stub-backend",
              allowHeuristicFallback: false,
            },
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      classifyTaskForDecision({
        prompt: "Publish to GitHub after running the checks.",
        cfg,
        adapterRegistry: {
          "stub-backend": {
            classify: vi.fn().mockRejectedValue(new Error("classifier unavailable")),
          },
        },
      }),
    ).rejects.toThrow("classifier unavailable");
  });

  it("emits debug events when adapter output falls back to heuristics", async () => {
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            taskClassifier: {
              backend: "stub-backend",
              allowHeuristicFallback: true,
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

    expect(classified.source).toBe("heuristic");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "fallback",
          message: "adapter returned null; using heuristic fallback",
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

  it("promotes extraction prompts with attachments back to document extraction", async () => {
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

    expect(classified.taskContract).toEqual(
      expect.objectContaining({
        primaryOutcome: "document_extraction",
        interactionMode: "tool_execution",
        requiredCapabilities: ["needs_document_extraction"],
      }),
    );
  });

  it("keeps browser observation prompts observational instead of mutating the workspace", async () => {
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

    expect(classified.taskContract.primaryOutcome).toBe("comparison_report");
    expect(classified.taskContract.interactionMode).toBe("tool_execution");
    expect(classified.taskContract.requiredCapabilities).toEqual(["needs_interactive_browser"]);
  });

  it("keeps standalone visual generation artifact-first", async () => {
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

    expect(classified.taskContract.primaryOutcome).toBe("document_package");
    expect(classified.taskContract.interactionMode).toBe("artifact_iteration");
    expect(classified.taskContract.requiredCapabilities).toEqual(["needs_visual_composition"]);
  });

  it("keeps explicit production delivery delivery-first even when the classifier drifts", async () => {
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

    expect(classified.taskContract.primaryOutcome).toBe("external_delivery");
    expect(classified.taskContract.interactionMode).toBe("tool_execution");
    expect(classified.taskContract.requiredCapabilities).toEqual(
      expect.arrayContaining([
        "needs_external_delivery",
        "needs_repo_execution",
        "needs_local_runtime",
        "needs_high_reliability_provider",
      ]),
    );
    expect(classified.taskContract.requiredCapabilities).toEqual(
      expect.not.arrayContaining(["needs_workspace_mutation"]),
    );
  });

  it("normalizes russian production delivery prompts to the same delivery-first capability set", async () => {
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
            requiredCapabilities: ["needs_external_delivery", "needs_repo_execution"],
            interactionMode: "tool_execution",
            confidence: 0.78,
            ambiguities: [],
          }),
        },
      },
    });

    expect(classified.taskContract.requiredCapabilities).toEqual(
      expect.arrayContaining([
        "needs_external_delivery",
        "needs_repo_execution",
        "needs_local_runtime",
        "needs_high_reliability_provider",
      ]),
    );
  });

  it("does not promote xlsx comparison into document extraction drift", async () => {
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
    expect(classified.taskContract.requiredCapabilities).toEqual(["needs_tabular_reasoning"]);
  });

  it("normalizes heuristic fallback to the same abstract visual contract", async () => {
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

    expect(classified.source).toBe("heuristic");
    expect(classified.taskContract.primaryOutcome).toBe("document_package");
    expect(classified.taskContract.interactionMode).toBe("artifact_iteration");
    expect(classified.taskContract.requiredCapabilities).toEqual(["needs_visual_composition"]);
    expect(classified.plannerInput.requestedTools).toEqual(["image_generate"]);
  });
});

describe("contract-first task contract routing", () => {
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
});
