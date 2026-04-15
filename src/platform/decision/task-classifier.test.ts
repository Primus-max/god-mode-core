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
        intent: "publish",
        publishTargets: ["github"],
        requestedTools: ["exec", "apply_patch", "process"],
      }),
    );
    expect(classified.plannerInput.contractFirst).toBeUndefined();
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
