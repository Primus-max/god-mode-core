import { describe, expect, it } from "vitest";
import type { ModelCandidate } from "../../agents/model-fallback.types.js";
import { applyModelRoutePreflight, inferLocalRoutingEligibleFromPlannerInput } from "./route-preflight.js";

const BASE_CHAIN: ModelCandidate[] = [
  { provider: "openai", model: "gpt-4.1-mini" },
  { provider: "ollama", model: "gemma4:e4b" },
  { provider: "hydra", model: "gpt-5.3-codex" },
  { provider: "hydra", model: "claude-opus-4.6" },
];

const LOCAL_FIRST_CODE_CHAIN: ModelCandidate[] = [
  { provider: "ollama", model: "gemma4:e4b" },
  { provider: "hydra", model: "gpt-5.3-codex" },
  { provider: "hydra", model: "claude-opus-4.6" },
];

describe("inferLocalRoutingEligibleFromPlannerInput", () => {
  it("keeps simple structured chat eligible when no heavy signals exist", () => {
    expect(
      inferLocalRoutingEligibleFromPlannerInput({
        artifactKinds: [],
        requestedTools: [],
      }),
    ).toBe(true);
  });

  it("blocks local-first for structured code execution turns", () => {
    expect(
      inferLocalRoutingEligibleFromPlannerInput({
        intent: "code",
        requestedTools: ["exec", "apply_patch"],
      }),
    ).toBe(false);
  });

  it("blocks local-first for file-backed turns even without prompt parsing", () => {
    expect(
      inferLocalRoutingEligibleFromPlannerInput({
        fileNames: ["quote.pdf"],
        artifactKinds: ["document", "report"],
        requestedTools: [],
      }),
    ).toBe(false);
  });
});

describe("applyModelRoutePreflight", () => {
  it("does nothing when only a prompt is provided without structured planner input", () => {
    const { candidates, decision } = applyModelRoutePreflight({
      candidates: BASE_CHAIN,
      prompt: "fix the repo and run the checks",
    });

    expect(candidates).toEqual(BASE_CHAIN);
    expect(decision).toBeNull();
  });

  it("promotes a local control-plane model first for structured local-eligible turns", () => {
    const { candidates, decision } = applyModelRoutePreflight({
      candidates: BASE_CHAIN,
      plannerInput: {
        artifactKinds: [],
        requestedTools: [],
      },
    });

    expect(candidates[0]).toEqual({ provider: "ollama", model: "gemma4:e4b" });
    expect(decision?.reasonCode).toBe("preflight_reordered_local_first");
    expect(decision?.localRoutingEligible).toBe(true);
  });

  it("promotes a code-oriented remote model first for structured repo execution turns", () => {
    const { candidates, decision } = applyModelRoutePreflight({
      candidates: LOCAL_FIRST_CODE_CHAIN,
      plannerInput: {
        intent: "code",
        requestedTools: ["exec", "apply_patch"],
      },
    });

    expect(candidates[0]).toEqual({ provider: "hydra", model: "gpt-5.3-codex" });
    expect(decision?.reasonCode).toBe("preflight_reordered_remote_first");
    expect(decision?.localRoutingEligible).toBe(false);
  });

  it("uses structured planner input even when the follow-up prompt is semantically empty", () => {
    const { candidates, decision } = applyModelRoutePreflight({
      candidates: LOCAL_FIRST_CODE_CHAIN,
      prompt: "ok",
      plannerInput: {
        intent: "code",
        requestedTools: ["exec", "apply_patch"],
      },
    });

    expect(candidates[0]).toEqual({ provider: "hydra", model: "gpt-5.3-codex" });
    expect(decision?.reasonCode).toBe("preflight_reordered_remote_first");
  });

  it("honors presentation routing from structured planner hints without reading prompt text", () => {
    const { candidates, decision } = applyModelRoutePreflight({
      candidates: BASE_CHAIN,
      plannerInput: {
        artifactKinds: ["document", "image"],
        requestedTools: ["pdf", "image_generate"],
        fileNames: ["brief.pdf"],
        routing: {
          localEligible: false,
          remoteProfile: "presentation",
          preferRemoteFirst: true,
          needsVision: true,
        },
      },
    });

    expect(candidates[0]).toEqual({ provider: "hydra", model: "claude-opus-4.6" });
    expect(decision?.reasonCode).toBe("preflight_reordered_remote_first");
    expect(decision?.reordered).toBe(true);
  });
});
