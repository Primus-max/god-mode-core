import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { ModelCandidate } from "../../agents/model-fallback.types.js";
import {
  applyModelRoutePreflight,
  inferLocalRoutingEligibleFromPlannerInput,
  inferLocalRoutingEligibleFromPrompt,
} from "./route-preflight.js";

describe("inferLocalRoutingEligibleFromPrompt", () => {
  it("treats casual chat as local-eligible", () => {
    expect(inferLocalRoutingEligibleFromPrompt("hello, how are you?")).toBe(true);
  });

  it("treats code-intent prompts as requiring a stronger route", () => {
    expect(inferLocalRoutingEligibleFromPrompt("fix the failing unit test in CI")).toBe(false);
  });

  it("treats publish-intent prompts as requiring a stronger route", () => {
    expect(inferLocalRoutingEligibleFromPrompt("deploy this preview to vercel")).toBe(false);
  });

  it("treats image-generation prompts as requiring a stronger route", () => {
    expect(inferLocalRoutingEligibleFromPrompt("Generate an image banner for Stage 86.")).toBe(
      false,
    );
  });

  it("treats Russian image-generation prompts as requiring a stronger route", () => {
    expect(
      inferLocalRoutingEligibleFromPrompt("Сгенерируй изображение баннера для Stage 86."),
    ).toBe(false);
  });

  it("treats pdf-generation prompts as requiring a stronger route", () => {
    expect(inferLocalRoutingEligibleFromPrompt("Create a PDF report with the test results.")).toBe(
      false,
    );
  });

  it("keeps ordinary summary requests local-eligible", () => {
    expect(
      inferLocalRoutingEligibleFromPrompt(
        "Сильно сожми этот раздутый запрос и дай краткую сводку по статусу stage 86.",
      ),
    ).toBe(true);
  });

  it("keeps detailed analytical prompts on the stronger route", () => {
    expect(
      inferLocalRoutingEligibleFromPrompt(
        "Напиши подробный анализ: какие 5 метрик важны для SaaS продукта и почему. С примерами.",
      ),
    ).toBe(false);
  });
});

describe("inferLocalRoutingEligibleFromPlannerInput", () => {
  it("keeps simple session-backed chat eligible when no heavy signals exist", () => {
    expect(
      inferLocalRoutingEligibleFromPlannerInput({
        intent: undefined,
      }),
    ).toBe(true);
  });

  it("treats session-backed code turns as requiring a stronger route", () => {
    expect(
      inferLocalRoutingEligibleFromPlannerInput({
        intent: "code",
        requestedTools: ["exec"],
      }),
    ).toBe(false);
  });

  it("keeps file-backed compare turns on the stronger route even for simple CSV pairs", () => {
    const input = inferLocalRoutingEligibleFromPlannerInput({
      prompt: "Compare these two CSVs for SKU alignment.",
      intent: "compare",
      fileNames: ["a.csv", "b.csv"],
      artifactKinds: ["data", "report"],
    });
    expect(input).toBe(false);
  });

  it("blocks local-first when compare attachments include a PDF", () => {
    expect(
      inferLocalRoutingEligibleFromPlannerInput({
        prompt: "Compare pricing",
        intent: "compare",
        fileNames: ["quotes.pdf", "internal.csv"],
        artifactKinds: ["data", "report"],
      }),
    ).toBe(false);
  });

  it("allows local-first for calculation turns that only carry report-style artifact hints", () => {
    expect(
      inferLocalRoutingEligibleFromPlannerInput({
        prompt: "Estimate CFM for a 12x14 ft bedroom with standard assumptions.",
        intent: "calculation",
        artifactKinds: ["report", "data"],
      }),
    ).toBe(true);
  });

  it("blocks local-first when prompts mention PDF work even without attachments", () => {
    expect(
      inferLocalRoutingEligibleFromPlannerInput({
        prompt: "Compare totals and export a PDF summary.",
        intent: "compare",
        artifactKinds: ["data", "report"],
      }),
    ).toBe(false);
  });

  it("blocks local-first for general prompts that clearly ask for multi-step analysis", () => {
    expect(
      inferLocalRoutingEligibleFromPlannerInput({
        prompt: "Напиши подробный анализ: какие 5 метрик важны для SaaS продукта и почему.",
        intent: "general",
      }),
    ).toBe(false);
  });
});

describe("applyModelRoutePreflight", () => {
  const chain: ModelCandidate[] = [
    { provider: "openai", model: "gpt-4.1-mini" },
    { provider: "ollama", model: "llama3.2" },
    { provider: "anthropic", model: "claude-haiku-3-5" },
  ];

  it("leaves order unchanged when no prompt is provided", () => {
    const { candidates, decision } = applyModelRoutePreflight({ candidates: chain });
    expect(candidates.map((c) => `${c.provider}/${c.model}`)).toEqual([
      "openai/gpt-4.1-mini",
      "ollama/llama3.2",
      "anthropic/claude-haiku-3-5",
    ]);
    expect(decision).toBeNull();
  });

  it("promotes a control-plane local provider first on local-eligible prompts", () => {
    const { candidates, decision } = applyModelRoutePreflight({
      candidates: chain,
      prompt: "quick question about my schedule",
    });
    expect(candidates[0]).toEqual({ provider: "ollama", model: "llama3.2" });
    expect(decision?.reasonCode).toBe("preflight_reordered_local_first");
    expect(decision?.reordered).toBe(true);
    expect(decision?.controlPlaneUsed).toBe(true);
    expect(decision?.localRoutingEligible).toBe(true);
    expect(candidates).toHaveLength(3);
  });

  it("keeps primary first when heuristics require a stronger route", () => {
    const { candidates, decision } = applyModelRoutePreflight({
      candidates: chain,
      prompt: "refactor the repo to use pnpm workspaces",
    });
    expect(candidates[0]).toEqual({ provider: "openai", model: "gpt-4.1-mini" });
    expect(decision?.reasonCode).toBe("preflight_stronger_route");
    expect(decision?.reordered).toBe(false);
    expect(decision?.localRoutingEligible).toBe(false);
  });

  it("promotes a stronger local model ahead of a lightweight local primary on heavy turns", () => {
    const localChain: ModelCandidate[] = [
      { provider: "ollama", model: "qwen2.5-coder:7b" },
      { provider: "ollama", model: "gpt-oss:20b" },
      { provider: "ollama", model: "gemma4:e4b" },
      { provider: "hydra", model: "gpt-4o-mini" },
    ];
    const { candidates, decision } = applyModelRoutePreflight({
      candidates: localChain,
      prompt: "Create a detailed PDF-ready analysis of two reports and explain every mismatch.",
    });
    expect(candidates[0]).toEqual({ provider: "hydra", model: "gpt-4o-mini" });
    expect(decision?.reasonCode).toBe("preflight_reordered_remote_first");
    expect(decision?.reordered).toBe(true);
    expect(decision?.localRoutingEligible).toBe(false);
    expect(decision?.controlPlaneUsed).toBe(false);
  });

  it("prefers a balanced strong local model over a heavier gpt-oss candidate", () => {
    const localChain: ModelCandidate[] = [
      { provider: "ollama", model: "qwen2.5-coder:7b" },
      { provider: "ollama", model: "gpt-oss:20b" },
      { provider: "ollama", model: "qwen2.5-coder:14b" },
      { provider: "hydra", model: "gpt-4o-mini" },
    ];
    const { candidates, decision } = applyModelRoutePreflight({
      candidates: localChain,
      prompt: "Сделай подробный анализ и подготовь аккуратный итоговый отчет.",
    });
    expect(candidates[0]).toEqual({ provider: "ollama", model: "qwen2.5-coder:14b" });
    expect(decision?.reasonCode).toBe("preflight_reordered_local_strong_first");
  });

  it("reorders the remote tail toward cheap API fallbacks for local-eligible prompts", () => {
    const chainWithCheapRemote: ModelCandidate[] = [
      { provider: "openai", model: "gpt-5.4" },
      { provider: "ollama", model: "qwen2.5-coder:7b" },
      { provider: "hydra", model: "gpt-5.4" },
      { provider: "hydra", model: "hydra-gpt-mini" },
      { provider: "hydra", model: "hydra-gpt" },
    ];
    const { candidates, decision } = applyModelRoutePreflight({
      candidates: chainWithCheapRemote,
      prompt: "Коротко ответь, какие сейчас риски по релизу?",
    });
    expect(candidates.map((candidate) => `${candidate.provider}/${candidate.model}`)).toEqual([
      "ollama/qwen2.5-coder:7b",
      "hydra/hydra-gpt-mini",
      "hydra/hydra-gpt",
      "hydra/gpt-5.4",
      "openai/gpt-5.4",
    ]);
    expect(decision?.reasonCode).toBe("preflight_reordered_local_first");
    expect(decision?.reordered).toBe(true);
  });

  it("prefers a chat-oriented local model over a coder-first local primary for casual prompts", () => {
    const chainWithTwoLocals: ModelCandidate[] = [
      { provider: "ollama", model: "qwen2.5-coder:7b" },
      { provider: "ollama", model: "gemma4:e4b" },
      { provider: "hydra", model: "hydra-gpt-mini" },
    ];
    const { candidates, decision } = applyModelRoutePreflight({
      candidates: chainWithTwoLocals,
      prompt: "Привет",
    });
    expect(candidates.map((candidate) => `${candidate.provider}/${candidate.model}`)).toEqual([
      "ollama/gemma4:e4b",
      "ollama/qwen2.5-coder:7b",
      "hydra/hydra-gpt-mini",
    ]);
    expect(decision?.reasonCode).toBe("preflight_reordered_local_first");
    expect(decision?.localRoutingEligible).toBe(true);
  });

  it("reorders the remote tail toward code-capable API fallbacks for heavy coding turns", () => {
    const codeChain: ModelCandidate[] = [
      { provider: "ollama", model: "qwen2.5-coder:7b" },
      { provider: "ollama", model: "gemma4:e4b" },
      { provider: "hydra", model: "hydra-gpt-mini" },
      { provider: "hydra", model: "gpt-5.3-codex" },
      { provider: "hydra", model: "claude-sonnet-4.6" },
      { provider: "hydra", model: "gpt-5.4" },
    ];
    const { candidates, decision } = applyModelRoutePreflight({
      candidates: codeChain,
      plannerInput: {
        prompt: "Исправь фейлящий e2e-тест, обнови код и прогоняй релевантные проверки.",
        intent: "code",
        requestedTools: ["exec", "apply_patch"],
      },
    });
    expect(candidates.map((candidate) => `${candidate.provider}/${candidate.model}`)).toEqual([
      "hydra/gpt-5.3-codex",
      "ollama/qwen2.5-coder:7b",
      "ollama/gemma4:e4b",
      "hydra/claude-sonnet-4.6",
      "hydra/gpt-5.4",
      "hydra/hydra-gpt-mini",
    ]);
    expect(decision?.reasonCode).toBe("preflight_reordered_remote_first");
    expect(decision?.reordered).toBe(true);
  });

  it("reorders the remote tail toward strong analytical models when no local candidate exists", () => {
    const remoteOnlyChain: ModelCandidate[] = [
      { provider: "hydra", model: "hydra-gpt-mini" },
      { provider: "hydra", model: "gpt-5.4" },
      { provider: "hydra", model: "claude-opus-4.6" },
    ];
    const { candidates, decision } = applyModelRoutePreflight({
      candidates: remoteOnlyChain,
      prompt: "Сделай подробный анализ архитектурных trade-offs и предложи целевую схему.",
    });
    expect(candidates.map((candidate) => `${candidate.provider}/${candidate.model}`)).toEqual([
      "hydra/claude-opus-4.6",
      "hydra/gpt-5.4",
      "hydra/hydra-gpt-mini",
    ]);
    expect(decision?.reasonCode).toBe("preflight_stronger_route");
    expect(decision?.reordered).toBe(true);
  });

  it("uses Hydra catalog metadata to rank previously unrated cheap remote candidates", () => {
    const remoteOnlyChain: ModelCandidate[] = [
      { provider: "hydra", model: "gemini-2.5-pro" },
      { provider: "hydra", model: "claude-3.5-haiku" },
      { provider: "hydra", model: "deepseek-v3.1" },
    ];
    const catalog: ModelCatalogEntry[] = [
      {
        provider: "hydra",
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        type: "vision",
        active: true,
        input: ["text", "image"],
        output: ["text"],
        cost: { input: 80, output: 320 },
        status: { successRate: 96, tps: 14, art: 2.8 },
      },
      {
        provider: "hydra",
        id: "claude-3.5-haiku",
        name: "Claude 3.5 Haiku",
        type: "chat",
        active: true,
        input: ["text"],
        output: ["text"],
        cost: { input: 8, output: 40 },
        status: { successRate: 93, tps: 18, art: 2.5 },
      },
      {
        provider: "hydra",
        id: "deepseek-v3.1",
        name: "DeepSeek V3.1",
        type: "chat",
        active: true,
        input: ["text"],
        output: ["text"],
        architecture: "MoE",
        quantization: "fp8",
        cost: { input: 3, output: 9 },
        status: { successRate: 99, tps: 42, art: 1.2 },
      },
    ];
    const { candidates, decision } = applyModelRoutePreflight({
      candidates: remoteOnlyChain,
      prompt: "Коротко ответь, в чем сейчас главный риск релиза?",
      catalog,
    });
    expect(candidates.map((candidate) => `${candidate.provider}/${candidate.model}`)).toEqual([
      "hydra/deepseek-v3.1",
      "hydra/claude-3.5-haiku",
      "hydra/gemini-2.5-pro",
    ]);
    expect(decision?.reordered).toBe(true);
  });

  it("demotes image and embedding Hydra models during code routing when catalog metadata is available", () => {
    const codeChain: ModelCandidate[] = [
      { provider: "ollama", model: "gemma4:e4b" },
      { provider: "hydra", model: "hydra-banana" },
      { provider: "hydra", model: "text-embedding-3-small" },
      { provider: "hydra", model: "gpt-5.3-codex" },
    ];
    const catalog: ModelCatalogEntry[] = [
      {
        provider: "hydra",
        id: "hydra-banana",
        name: "Hydra Banana",
        type: "vision",
        active: true,
        input: ["text", "image"],
        output: ["text", "image"],
        cost: { request: 1.1 },
      },
      {
        provider: "hydra",
        id: "text-embedding-3-small",
        name: "Text Embedding 3 Small",
        type: "embedding",
        active: true,
        input: ["text"],
        output: ["embed"],
        cost: { input: 0.75 },
      },
      {
        provider: "hydra",
        id: "gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        type: "vision",
        active: true,
        reasoning: true,
        supportsTools: true,
        input: ["text", "image"],
        output: ["text"],
        cost: { input: 60, output: 560 },
      },
    ];
    const { candidates } = applyModelRoutePreflight({
      candidates: codeChain,
      plannerInput: {
        prompt: "Исправь баг в маршрутизации и запусти релевантные тесты.",
        intent: "code",
        requestedTools: ["exec", "apply_patch"],
      },
      catalog,
    });
    expect(candidates.map((candidate) => `${candidate.provider}/${candidate.model}`)).toEqual([
      "hydra/gpt-5.3-codex",
      "ollama/gemma4:e4b",
      "hydra/hydra-banana",
      "hydra/text-embedding-3-small",
    ]);
  });

  it("prefers a faster tool-capable remote orchestrator over a slow premium model for artifact generation", () => {
    const artifactChain: ModelCandidate[] = [
      { provider: "ollama", model: "gemma4:e4b" },
      { provider: "hydra", model: "gpt-5.4" },
      { provider: "hydra", model: "hydra-gpt-pro" },
      { provider: "hydra", model: "hydra-gpt-mini" },
    ];
    const catalog: ModelCatalogEntry[] = [
      {
        provider: "hydra",
        id: "gpt-5.4",
        name: "GPT-5.4",
        type: "vision",
        active: true,
        reasoning: true,
        supportsTools: true,
        input: ["text", "image"],
        output: ["text"],
        cost: { input: 100, output: 600 },
        status: { successRate: 100, tps: 20.78, art: 187.05 },
      },
      {
        provider: "hydra",
        id: "hydra-gpt-pro",
        name: "Hydra GPT Pro",
        type: "chat",
        active: true,
        reasoning: true,
        supportsTools: true,
        input: ["text"],
        output: ["text"],
        cost: { input: 40, output: 320 },
        status: { successRate: 100, tps: 34.42, art: 4.26 },
      },
      {
        provider: "hydra",
        id: "hydra-gpt-mini",
        name: "Hydra GPT Mini",
        type: "chat",
        active: true,
        supportsTools: true,
        input: ["text"],
        output: ["text"],
        cost: { input: 8, output: 32 },
        status: { successRate: 100, tps: 98.71, art: 9.92 },
      },
    ];
    const { candidates, decision } = applyModelRoutePreflight({
      candidates: artifactChain,
      plannerInput: {
        prompt: "Сделай 3-страничный PDF про жизнь городского кота с иллюстрациями.",
        intent: "document",
        artifactKinds: ["document", "image"],
      },
      catalog,
    });
    expect(candidates.map((candidate) => `${candidate.provider}/${candidate.model}`)).toEqual([
      "hydra/hydra-gpt-pro",
      "ollama/gemma4:e4b",
      "hydra/gpt-5.4",
      "hydra/hydra-gpt-mini",
    ]);
    expect(decision?.reasonCode).toBe("preflight_reordered_remote_first");
    expect(decision?.reordered).toBe(true);
  });

  it("uses structured planner input when a short follow-up prompt lacks the full session context", () => {
    const { candidates, decision } = applyModelRoutePreflight({
      candidates: chain,
      prompt: "ok, do it",
      plannerInput: {
        intent: "code",
        requestedTools: ["exec", "apply_patch"],
      },
    });
    expect(candidates[0]).toEqual({ provider: "openai", model: "gpt-4.1-mini" });
    expect(decision?.reasonCode).toBe("preflight_stronger_route");
    expect(decision?.localRoutingEligible).toBe(false);
  });

  it("promotes a remote orchestrator first for browser-tool turns", () => {
    const { candidates, decision } = applyModelRoutePreflight({
      candidates: chain,
      plannerInput: {
        prompt: "Открой в браузере https://example.com и скажи заголовок страницы.",
        requestedTools: ["browser"],
      },
    });

    expect(candidates[0]?.provider).not.toBe("ollama");
    expect(decision?.reasonCode).toBe("preflight_reordered_remote_first");
    expect(decision?.localRoutingEligible).toBe(false);
  });

  it("honors force_stronger even for simple prompts", () => {
    const { candidates, decision } = applyModelRoutePreflight({
      candidates: chain,
      prompt: "hello",
      mode: "force_stronger",
    });
    expect(candidates[0]).toEqual({ provider: "openai", model: "gpt-4.1-mini" });
    expect(decision?.reasonCode).toBe("preflight_stronger_route");
    expect(decision?.localRoutingEligible).toBe(false);
  });

  it("does not reorder when primary is already local", () => {
    const localPrimary: ModelCandidate[] = [
      { provider: "lmstudio", model: "local-model" },
      { provider: "openai", model: "gpt-4.1-mini" },
    ];
    const { candidates, decision } = applyModelRoutePreflight({
      candidates: localPrimary,
      prompt: "hello",
    });
    expect(candidates[0]?.provider).toBe("lmstudio");
    expect(decision?.reasonCode).toBe("preflight_primary_control_plane_local");
    expect(decision?.reordered).toBe(false);
  });
});
