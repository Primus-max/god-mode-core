import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolvePlatformRuntimePlan } from "../recipe/runtime-adapter.js";
import {
  buildPlannerInputFromTaskContract,
  classifyTaskForDecision,
  composeClassifierUserRequestForTest,
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
  it("uses pending_commitments so awaiting_confirmation + 'ДА' does not stay in clarify mode", async () => {
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
    const classifyCalls: Parameters<TaskClassifierAdapter["classify"]>[0][] = [];
    const classify: TaskClassifierAdapter["classify"] = async (
      params,
    ): Promise<TaskContract | null> => {
      classifyCalls.push(params);
      const hasAwaitingConfirmation =
        typeof params.ledgerContext === "string" &&
        params.ledgerContext.includes("awaiting_confirmation");
      if (params.prompt.trim().toUpperCase() === "ДА" && hasAwaitingConfirmation) {
        return {
          primaryOutcome: "workspace_change",
          requiredCapabilities: ["needs_workspace_mutation", "needs_repo_execution"],
          interactionMode: "tool_execution",
          confidence: 0.9,
          ambiguities: [],
        };
      }
      return {
        primaryOutcome: "clarification_needed",
        requiredCapabilities: [],
        interactionMode: "clarify_first",
        confidence: 0.9,
        ambiguities: ["confirmation context missing"],
      };
    };

    const classified = await classifyTaskForDecision({
      prompt: "ДА",
      ledgerContext: '7af3c1d2 awaiting_confirmation: "начать авторизацию Trader"',
      cfg,
      adapterRegistry: {
        "stub-backend": {
          classify,
        },
      },
    });

    expect(classifyCalls[0]).toEqual(
      expect.objectContaining({
        prompt: "ДА",
        ledgerContext: expect.stringContaining("awaiting_confirmation"),
      }),
    );
    expect(classified.source).toBe("llm");
    expect(classified.taskContract.interactionMode).toBe("tool_execution");
    expect(classified.taskContract.primaryOutcome).not.toBe("clarification_needed");
  });

  it("keeps behavior identical to baseline when ledger context is missing or empty", async () => {
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
    const classify = vi.fn<TaskClassifierAdapter["classify"]>(async (params) => {
        const hasPending = Boolean(params.ledgerContext && params.ledgerContext.trim().length > 0);
        if (hasPending) {
          return {
            primaryOutcome: "workspace_change",
            requiredCapabilities: ["needs_workspace_mutation"],
            interactionMode: "tool_execution",
            confidence: 0.8,
            ambiguities: [],
          };
        }
        return {
          primaryOutcome: "clarification_needed",
          requiredCapabilities: [],
          interactionMode: "clarify_first",
          confidence: 0.75,
          ambiguities: ["baseline-clarify"],
        };
      });
    const adapter: TaskClassifierAdapter = { classify };

    const baseline = await classifyTaskForDecision({
      prompt: "ДА",
      cfg,
      adapterRegistry: { "stub-backend": adapter },
    });
    const emptyLedger = await classifyTaskForDecision({
      prompt: "ДА",
      ledgerContext: "",
      cfg,
      adapterRegistry: { "stub-backend": adapter },
    });

    expect(baseline.taskContract).toEqual(emptyLedger.taskContract);
    expect(baseline.taskContract.interactionMode).toBe("clarify_first");
  });

  it("passes clarify budget notice so repeated clarifications can be suppressed on the next call", async () => {
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
    const observedPrompts: string[] = [];
    const classify: TaskClassifierAdapter["classify"] = async (params) => {
      const composedPrompt = [
        (params.ledgerContext ?? "").trim(),
        (params.clarifyBudgetNotice ?? "").trim(),
        params.prompt,
      ]
        .filter(Boolean)
        .join("\n");
      observedPrompts.push(composedPrompt);
      return {
        primaryOutcome: "clarification_needed",
        requiredCapabilities: [],
        interactionMode: "clarify_first",
        confidence: 0.8,
        ambiguities: ["missing context"],
      };
    };

    await classifyTaskForDecision({
      prompt: "Продолжим как договаривались",
      cfg,
      adapterRegistry: {
        "stub-backend": {
          classify,
        },
      },
    });
    await classifyTaskForDecision({
      prompt: "Ну давай уже",
      cfg,
      adapterRegistry: {
        "stub-backend": {
          classify,
        },
      },
    });
    await classifyTaskForDecision({
      prompt: "Просто сделай что понимаешь",
      ledgerContext: 'abc clarifying: "формат receipt и platform action"',
      clarifyBudgetNotice: [
        "<clarify_budget_exceeded>",
        "You have already asked this same clarification 2 times in the last 5 min.",
        "Do NOT ask again.",
        "</clarify_budget_exceeded>",
      ].join("\n"),
      cfg,
      adapterRegistry: {
        "stub-backend": {
          classify,
        },
      },
    });

    expect(observedPrompts).toHaveLength(3);
    expect(observedPrompts[2]).toContain("<clarify_budget_exceeded>");
    expect(observedPrompts[2]).toContain("Do NOT ask again.");
  });

  // P1.6.1: env requirements are now attached to the deliverable's
  // provider/integration constraint, not to the `needs_repo_execution`
  // capability. The bundled catalog therefore no longer fires the gate
  // for plain scaffold work — only when the classifier emits a known
  // provider tag in `deliverable.constraints`.
  it("rewrites scaffold contracts to clarification when deliverable.constraints.provider declares a known provider with missing env", async () => {
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
    const classify: TaskClassifierAdapter["classify"] = async () => ({
      primaryOutcome: "workspace_change",
      requiredCapabilities: ["needs_repo_execution", "needs_workspace_mutation"],
      interactionMode: "tool_execution",
      confidence: 0.92,
      ambiguities: [],
      deliverable: {
        kind: "code_change",
        acceptedFormats: ["patch", "workspace"],
        preferredFormat: "patch",
        constraints: { operation: "scaffold_repo", provider: "bybit" },
      },
    });
    vi.stubEnv("TELEGRAM_API_HASH", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("BYBIT_API_KEY", "");
    try {
      const classified = await classifyTaskForDecision({
        prompt: "Сделай scaffold Bybit-бота с запуском.",
        cfg,
        adapterRegistry: {
          "stub-backend": {
            classify,
          },
        },
      });

      expect(classified.taskContract.primaryOutcome).toBe("clarification_needed");
      expect(classified.taskContract.interactionMode).toBe("clarify_first");
      expect(classified.taskContract.requiredCapabilities).toEqual([]);
      expect(classified.taskContract.ambiguities).toEqual(
        expect.arrayContaining(["missing_credentials: BYBIT_API_KEY"]),
      );
      expect(classified.plannerInput.executionContract).toEqual(
        expect.objectContaining({
          requiresTools: false,
          requiresWorkspaceMutation: false,
          requiresLocalProcess: false,
        }),
      );
      expect(classified.plannerInput.requestedTools ?? []).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // P1.6.1 regression guard: a scaffold/exec contract that does NOT
  // carry a provider tag must not be rewritten into a credentials
  // clarification, even when env is empty. This is the symptom that
  // P1.6.1 was introduced to fix (poems / pictures / `pnpm dev` /
  // generic scaffold no longer ask for Bybit / OpenAI / Telegram keys).
  it("does NOT rewrite scaffold contracts to clarification when deliverable carries no provider", async () => {
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
    const classify: TaskClassifierAdapter["classify"] = async () => ({
      primaryOutcome: "workspace_change",
      requiredCapabilities: ["needs_repo_execution", "needs_workspace_mutation"],
      interactionMode: "tool_execution",
      confidence: 0.92,
      ambiguities: [],
      deliverable: {
        kind: "code_change",
        acceptedFormats: ["patch", "workspace"],
        preferredFormat: "patch",
        constraints: { operation: "scaffold_repo" },
      },
    });
    vi.stubEnv("TELEGRAM_API_HASH", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("BYBIT_API_KEY", "");
    try {
      const classified = await classifyTaskForDecision({
        prompt: "Scaffold a fresh repo with README and CI",
        cfg,
        adapterRegistry: {
          "stub-backend": {
            classify,
          },
        },
      });

      expect(classified.taskContract.primaryOutcome).toBe("workspace_change");
      expect(classified.taskContract.interactionMode).toBe("tool_execution");
      expect(classified.taskContract.requiredCapabilities).toEqual(
        expect.arrayContaining(["needs_repo_execution", "needs_workspace_mutation"]),
      );
      const ambiguities = classified.taskContract.ambiguities ?? [];
      for (const entry of ambiguities) {
        expect(entry).not.toMatch(/^missing_credentials:/);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

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
    expect(plannerInput.executionContract).toBeDefined();

    const runtime = resolvePlatformRuntimePlan({
      ...plannerInput,
      artifactKinds: ["site"],
      outcomeContract: "interactive_local_result",
      executionContract: {
        ...plannerInput.executionContract!,
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

  it("P0.2: routes low-confidence workspace mutation with ambiguities through clarify", () => {
    const plannerInput = buildPlannerInputFromTaskContract({
      prompt: "Почини баг",
      taskContract: {
        primaryOutcome: "workspace_change",
        requiredCapabilities: ["needs_workspace_mutation", "needs_repo_execution"],
        interactionMode: "tool_execution",
        confidence: 0.35,
        ambiguities: ["Scope of the change is unclear.", "No target file was specified."],
      },
    });

    expect(plannerInput.lowConfidenceStrategy).toBe("clarify");
    expect(plannerInput.executionContract?.requiresTools).toBe(false);
    expect(plannerInput.executionContract?.requiresWorkspaceMutation).toBe(false);
    expect(plannerInput.requestedTools ?? []).toEqual([]);
    expect(plannerInput.outcomeContract).toBe("text_response");
  });

  it("P0.2: keeps high-confidence workspace mutation on the tool path", () => {
    const plannerInput = buildPlannerInputFromTaskContract({
      prompt: "Перепиши src/foo.ts под новую схему.",
      taskContract: {
        primaryOutcome: "workspace_change",
        requiredCapabilities: ["needs_workspace_mutation"],
        interactionMode: "tool_execution",
        confidence: 0.92,
        ambiguities: [],
      },
    });

    expect(plannerInput.lowConfidenceStrategy).toBeUndefined();
    expect(plannerInput.executionContract?.requiresWorkspaceMutation).toBe(true);
    expect(plannerInput.requestedTools).toEqual(expect.arrayContaining(["apply_patch"]));
  });

  it("P0.3: clarify_first turn never smuggles tool requests into the planner input", () => {
    const plannerInput = buildPlannerInputFromTaskContract({
      prompt: "Сделай PDF-отчёт.",
      taskContract: {
        primaryOutcome: "document_package",
        requiredCapabilities: ["needs_multimodal_authoring"],
        interactionMode: "clarify_first",
        confidence: 0.4,
        ambiguities: ["Audience and tone are not specified."],
        deliverable: {
          kind: "document",
          preferredFormat: "pdf",
          acceptedFormats: ["pdf"],
        },
      },
    });

    expect(plannerInput.lowConfidenceStrategy).toBe("clarify");
    expect(plannerInput.executionContract).toEqual(
      expect.objectContaining({
        requiresTools: false,
        requiresArtifactEvidence: false,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: false,
      }),
    );
    expect(plannerInput.requestedTools ?? []).toEqual([]);
    expect(plannerInput.artifactKinds ?? []).toEqual([]);
    expect(plannerInput.deliverable).toBeUndefined();
    expect(plannerInput.outcomeContract).toBe("text_response");
  });

  it("P1.3: repo_operation builds an exec-only bridge without apply_patch or workspace mutation", () => {
    const plannerInput = buildPlannerInputFromTaskContract({
      prompt: "Закоммить всё с сообщением feat: refresh recipe bindings",
      taskContract: {
        primaryOutcome: "workspace_change",
        requiredCapabilities: ["needs_repo_execution"],
        interactionMode: "tool_execution",
        confidence: 0.88,
        ambiguities: [],
        deliverable: {
          kind: "repo_operation",
          acceptedFormats: ["exec", "script"],
          preferredFormat: "exec",
          constraints: { operation: "run_command" },
        },
      },
    });

    expect(plannerInput.lowConfidenceStrategy).toBeUndefined();
    expect(plannerInput.outcomeContract).toBe("workspace_change");
    expect(plannerInput.executionContract?.requiresWorkspaceMutation).toBe(false);
    expect(plannerInput.executionContract?.requiresTools).toBe(true);
    expect(plannerInput.requestedTools).toEqual(expect.arrayContaining(["exec"]));
    expect(plannerInput.requestedTools).not.toEqual(expect.arrayContaining(["apply_patch"]));
    expect(plannerInput.deliverable?.kind).toBe("repo_operation");
  });

  it("P1.3: low-confidence repo_operation with ambiguities does NOT trigger P0.2 clarify", () => {
    // Justification: "just commit" is reversible at the repo level (git revert) and does
    // not damage workspace files. The P0.2 safety rule exists to protect against wrong
    // `apply_patch` calls. Firing it on repo_operation turns would block users from doing
    // fast `git commit` / `run tests` even when the classifier correctly tagged the turn.
    const plannerInput = buildPlannerInputFromTaskContract({
      prompt: "Run tests, if green commit",
      taskContract: {
        primaryOutcome: "workspace_change",
        requiredCapabilities: ["needs_repo_execution"],
        interactionMode: "tool_execution",
        confidence: 0.32,
        ambiguities: ["Commit message not specified."],
        deliverable: {
          kind: "repo_operation",
          acceptedFormats: ["test-report", "exec"],
          preferredFormat: "test-report",
          constraints: { operation: "run_tests" },
        },
      },
    });

    expect(plannerInput.lowConfidenceStrategy).toBeUndefined();
    expect(plannerInput.executionContract?.requiresWorkspaceMutation).toBe(false);
    expect(plannerInput.requestedTools).toEqual(expect.arrayContaining(["exec"]));
    expect(plannerInput.requestedTools).not.toEqual(expect.arrayContaining(["apply_patch"]));
  });

  it("P1.3 normalize: strips needs_workspace_mutation when deliverable.kind=repo_operation", async () => {
    // Guards against a classifier mis-tagging a git-only turn with `needs_workspace_mutation`.
    // Without this normalization the P0.2 safety rule and `apply_patch` path would both fire
    // on a low-confidence "just commit" turn.
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
      prompt: "git commit with message feat: X",
      cfg,
      adapterRegistry: {
        "stub-backend": {
          classify: vi.fn().mockResolvedValue({
            primaryOutcome: "workspace_change",
            requiredCapabilities: ["needs_workspace_mutation", "needs_repo_execution"],
            interactionMode: "tool_execution",
            confidence: 0.8,
            ambiguities: [],
            deliverable: {
              kind: "repo_operation",
              acceptedFormats: ["exec"],
              preferredFormat: "exec",
              constraints: { operation: "run_command" },
            },
          }),
        },
      },
    });

    expect(classified.taskContract.primaryOutcome).toBe("workspace_change");
    expect(classified.taskContract.requiredCapabilities).not.toContain("needs_workspace_mutation");
    expect(classified.taskContract.requiredCapabilities).toContain("needs_repo_execution");
    expect(classified.plannerInput.executionContract?.requiresWorkspaceMutation).toBe(false);
    expect(classified.plannerInput.requestedTools).not.toEqual(
      expect.arrayContaining(["apply_patch"]),
    );
  });
});

describe("classifier prompt composition (P1.5 §B context blocks)", () => {
  it("composes <workspace>, <identity>, <pending_commitments>, clarify_budget, prompt in canonical order", () => {
    const userRequest = composeClassifierUserRequestForTest({
      prompt: "запусти node --version",
      workspaceContext: "default_cwd: /repo\nroots:\n  - /repo [git=org/repo@dev]",
      identityContext: "persona: Trader\navailable_tools: exec, apply_patch",
      ledgerContext: "abc clarifying: \"format\"",
      clarifyBudgetNotice: "<clarify_budget_exceeded>limit</clarify_budget_exceeded>",
    });

    const workspaceIdx = userRequest.indexOf("<workspace>");
    const identityIdx = userRequest.indexOf("<identity>");
    const pendingIdx = userRequest.indexOf("<pending_commitments>");
    const clarifyIdx = userRequest.indexOf("<clarify_budget_exceeded>");
    const promptIdx = userRequest.indexOf("запусти node --version");

    expect(workspaceIdx).toBeGreaterThanOrEqual(0);
    expect(identityIdx).toBeGreaterThan(workspaceIdx);
    expect(pendingIdx).toBeGreaterThan(identityIdx);
    expect(clarifyIdx).toBeGreaterThan(pendingIdx);
    expect(promptIdx).toBeGreaterThan(clarifyIdx);
  });

  it("emits identity even when workspace is absent (cheap baseline injection)", () => {
    const userRequest = composeClassifierUserRequestForTest({
      prompt: "что у тебя есть?",
      identityContext: "persona: Trader\navailable_tools: exec, web_search",
    });
    expect(userRequest).toContain("<identity>");
    expect(userRequest).not.toContain("<workspace>");
    expect(userRequest).toMatch(/<\/identity>\s*\nчто у тебя есть\?/);
  });

  it("falls back to bare prompt when no context blocks are provided", () => {
    const userRequest = composeClassifierUserRequestForTest({ prompt: "hello" });
    expect(userRequest).toBe("hello");
  });

  it("propagates workspaceContext and identityContext through classifyTaskForDecision into the adapter", async () => {
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            taskClassifier: { backend: "stub-backend" },
          },
        },
      },
    } as OpenClawConfig;

    const seenParams: Array<Parameters<TaskClassifierAdapter["classify"]>[0]> = [];
    const adapter: TaskClassifierAdapter = {
      async classify(params) {
        seenParams.push(params);
        return {
          primaryOutcome: "workspace_change",
          requiredCapabilities: ["needs_workspace_mutation", "needs_repo_execution"],
          interactionMode: "tool_execution",
          confidence: 0.9,
          ambiguities: [],
        };
      },
    };

    await classifyTaskForDecision({
      prompt: "fix the leak in the tests lane",
      cfg,
      workspaceContext: "default_cwd: /repo\nroots:\n  - /repo [git=org/repo@dev]",
      identityContext: "persona: Trader\navailable_tools: exec, apply_patch, web_search",
      adapterRegistry: { "stub-backend": adapter },
    });

    expect(seenParams).toHaveLength(1);
    expect(seenParams[0]?.workspaceContext).toContain("default_cwd: /repo");
    expect(seenParams[0]?.identityContext).toContain("persona: Trader");
  });
});
