import { describe, expect, it } from "vitest";
import type { ModelCandidate } from "../../agents/model-fallback.types.js";
import type { ResolutionContract } from "./resolution-contract.js";
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

  it("preserves configured order for all-remote chains with no local candidate (passthrough decision)", () => {
    const allRemote: ModelCandidate[] = [
      { provider: "hydra", model: "claude-opus-4.6" },
      { provider: "hydra", model: "gpt-5.4" },
      { provider: "hydra", model: "hydra-gpt-pro" },
    ];
    const { candidates, decision } = applyModelRoutePreflight({
      candidates: allRemote,
      plannerInput: {
        artifactKinds: [],
        requestedTools: [],
      },
    });

    expect(candidates).toEqual(allRemote);
    expect(decision?.reasonCode).toBe("preflight_no_local_candidate");
    expect(decision?.reordered).toBe(false);
    expect(decision?.localRoutingEligible).toBe(true);
  });

  it("preserves configured order for stronger-route passthrough (keeping configured candidate order)", () => {
    const allRemote: ModelCandidate[] = [
      { provider: "hydra", model: "claude-opus-4.6" },
      { provider: "hydra", model: "gpt-5.4" },
      { provider: "hydra", model: "hydra-gpt-pro" },
    ];
    const { candidates, decision } = applyModelRoutePreflight({
      candidates: allRemote,
      plannerInput: {
        intent: "code",
        requestedTools: ["exec", "apply_patch"],
      },
    });

    expect(candidates).toEqual(allRemote);
    expect(decision?.reasonCode).toBe("preflight_stronger_route");
    expect(decision?.reordered).toBe(false);
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

  it("does not touch the chain when web_search is requested (gate disabled until search/composer pipeline lands)", () => {
    const chain: ModelCandidate[] = [
      { provider: "hydra", model: "claude-opus-4.6" },
      { provider: "hydra", model: "gpt-5.4" },
      { provider: "hydra", model: "sonar-pro" },
      { provider: "hydra", model: "hydra-gpt-pro" },
    ];
    const { decision } = applyModelRoutePreflight({
      candidates: chain,
      plannerInput: {
        intent: "general",
        requestedTools: ["web_search"],
      },
    });

    expect(decision?.reasonCode).not.toBe("preflight_routed_grok_for_web_search");
  });

  it("does not touch the chain when bundles=[public_web_lookup] and sonar-pro is in the chain (gate disabled)", () => {
    const chain: ModelCandidate[] = [
      { provider: "hydra", model: "claude-opus-4.6" },
      { provider: "hydra", model: "gpt-5.4" },
      { provider: "hydra", model: "sonar-pro" },
      { provider: "hydra", model: "hydra-gpt-pro" },
    ];
    const { decision } = applyModelRoutePreflight({
      candidates: chain,
      plannerInput: {
        intent: "general",
        requestedTools: [],
        resolutionContract: {
          toolBundles: ["public_web_lookup"],
        } as unknown as ResolutionContract,
      },
    });

    expect(decision?.reasonCode).not.toBe("preflight_routed_grok_for_web_search");
  });

  it("does not touch the chain when web_search is requested but no native-search candidate is present", () => {
    const chain: ModelCandidate[] = [
      { provider: "hydra", model: "claude-opus-4.6" },
      { provider: "hydra", model: "gpt-5.4" },
      { provider: "hydra", model: "grok-4" },
    ];
    const { decision } = applyModelRoutePreflight({
      candidates: chain,
      plannerInput: {
        intent: "general",
        requestedTools: ["web_search"],
      },
    });

    expect(decision?.reasonCode).not.toBe("preflight_routed_grok_for_web_search");
  });

  it("leaves chain unchanged when public_web_lookup bundle is signaled but no native-search candidate is in the chain", () => {
    const chain: ModelCandidate[] = [
      { provider: "hydra", model: "claude-opus-4.6" },
      { provider: "hydra", model: "gpt-5.4" },
    ];
    const { candidates, decision } = applyModelRoutePreflight({
      candidates: chain,
      plannerInput: {
        intent: "general",
        requestedTools: [],
        resolutionContract: {
          toolBundles: ["public_web_lookup"],
        } as unknown as ResolutionContract,
      },
    });

    expect(candidates).toEqual(chain);
    expect(decision?.reasonCode).not.toBe("preflight_routed_grok_for_web_search");
  });
});
