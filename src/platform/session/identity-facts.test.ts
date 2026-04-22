import { afterEach, describe, expect, it, vi } from "vitest";
import { IntentLedger } from "./intent-ledger.js";
import {
  buildIdentityFacts,
  type BuildIdentityFactsOptions,
  IDENTITY_FACTS_TTL_MS_DEFAULT,
  IDENTITY_PROJECTION_DEFAULT_MAX_TOKENS,
  projectIdentityForPrompt,
  type CapabilityRegistry,
  type IdentityFacts,
  type ToolRegistry,
} from "./identity-facts.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildIdentityFacts", () => {
  it("returns stable unique tool and capability lists", () => {
    const toolRegistry: ToolRegistry = {
      listToolNames: () => ["exec", "apply_patch", "exec", "web_search"],
    };
    const capabilityRegistry: CapabilityRegistry = {
      listCapabilityIds: () => ["pdf-renderer", "xlsx-writer", "pdf-renderer"],
    };

    const facts = buildIdentityFacts({
      personaResolver: () => "Trader",
      toolRegistry,
      capabilityRegistry,
      now: () => 7_000,
    });

    expect(facts.persona).toBe("Trader");
    expect(facts.availableTools).toEqual(["apply_patch", "exec", "web_search"]);
    expect(facts.availableCapabilities).toEqual(["pdf-renderer", "xlsx-writer"]);
    expect(facts.ttlMs).toBe(IDENTITY_FACTS_TTL_MS_DEFAULT);
    expect(facts.capturedAt).toBe(7_000);
  });

  it("returns empty arrays for empty registries", () => {
    const facts = buildIdentityFacts({
      toolRegistry: { listToolNames: () => [] },
      capabilityRegistry: { listCapabilityIds: () => [] },
      now: () => 9_000,
    });

    expect(facts.availableTools).toEqual([]);
    expect(facts.availableCapabilities).toEqual([]);
    expect(facts.persona).toBeUndefined();
  });
});

describe("IntentLedger identity cache", () => {
  it("respects OPENCLAW_IDENTITY_TTL_MS override", () => {
    vi.stubEnv("OPENCLAW_IDENTITY_TTL_MS", "10");
    let now = 1_000;
    const build = vi.fn((params: BuildIdentityFactsOptions) => ({
      availableTools: ["exec"],
      availableCapabilities: ["pdf-renderer"],
      capturedAt: (params.now ?? (() => 0))(),
      ttlMs: 30 * 60 * 1000,
    }));
    const ledger = new IntentLedger({ now: () => now });

    ledger.getOrBuildIdentity("session-identity", "telegram", { build });
    now += 9;
    ledger.getOrBuildIdentity("session-identity", "telegram", { build });
    now += 2;
    ledger.getOrBuildIdentity("session-identity", "telegram", { build });

    expect(build).toHaveBeenCalledTimes(2);
  });
});

describe("projectIdentityForPrompt", () => {
  function makeFacts(overrides: Partial<IdentityFacts> = {}): IdentityFacts {
    return {
      availableTools: ["apply_patch", "exec", "web_search"],
      availableCapabilities: [],
      capturedAt: 1_000,
      ttlMs: IDENTITY_FACTS_TTL_MS_DEFAULT,
      ...overrides,
    };
  }

  it("returns empty string when facts are undefined or contain neither persona nor tools", () => {
    expect(projectIdentityForPrompt(undefined)).toBe("");
    expect(projectIdentityForPrompt(makeFacts({ availableTools: [] }))).toBe("");
  });

  it("emits persona and the first N tools", () => {
    const text = projectIdentityForPrompt(makeFacts({ persona: "Trader" }));
    expect(text).toContain("persona: Trader");
    expect(text).toContain("available_tools: apply_patch, exec, web_search");
  });

  it("omits persona line when no persona is set", () => {
    const text = projectIdentityForPrompt(makeFacts());
    expect(text).not.toMatch(/persona:/);
    expect(text).toContain("available_tools:");
  });

  it("truncates tools to fit budget while keeping persona intact", () => {
    const facts = makeFacts({
      persona: "Trader",
      availableTools: Array.from({ length: 30 }, (_, idx) => `tool${String(idx).padStart(2, "0")}`),
    });
    const text = projectIdentityForPrompt(facts, { maxTokens: 12 });
    expect(text).toContain("persona: Trader");
    const tokens = text.split(/[\s,]+/).filter(Boolean).length;
    expect(tokens).toBeLessThanOrEqual(12);
  });

  it("respects the default token budget for a representative identity", () => {
    const facts = makeFacts({
      persona: "Trader",
      availableTools: Array.from({ length: 8 }, (_, idx) => `tool-${String(idx)}`),
    });
    const text = projectIdentityForPrompt(facts);
    const tokens = text.split(/[\s,]+/).filter(Boolean).length;
    expect(tokens).toBeLessThanOrEqual(IDENTITY_PROJECTION_DEFAULT_MAX_TOKENS);
  });
});
