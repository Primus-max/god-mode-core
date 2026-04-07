import { describe, expect, it } from "vitest";
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
