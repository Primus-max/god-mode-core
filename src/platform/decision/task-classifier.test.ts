import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  classifyTaskForDecision,
  resolveTaskClassifierConfig,
  type TaskClassifierAdapter,
} from "./task-classifier.js";

describe("task classifier config", () => {
  it("uses gpt-5-mini defaults with the built-in backend", () => {
    const cfg = {} as OpenClawConfig;

    expect(resolveTaskClassifierConfig({ cfg })).toEqual({
      enabled: true,
      backend: "pi-simple",
      model: "openai/gpt-5-mini",
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
});
