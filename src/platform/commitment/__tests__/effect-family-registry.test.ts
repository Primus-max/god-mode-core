import { describe, expect, it } from "vitest";
import {
  EFFECT_FAMILY_REGISTRY,
  WEB_EVIDENCE_COLLECTED_EFFECT,
  WEB_RESEARCH_EFFECT_FAMILY,
  WEB_RESEARCH_SUMMARIZED_EFFECT,
  getEffectFamilyDefinition,
  isKnownEffectFamilyId,
} from "../index.js";
import type { EffectFamilyDefinition } from "../effect-family-registry.js";

describe("effect-family registry — Search-Composer Pipeline Phase 1 (web_research)", () => {
  it("freezes the registry and rejects mutation", () => {
    expect(Object.isFrozen(EFFECT_FAMILY_REGISTRY)).toBe(true);
    expect(() =>
      (EFFECT_FAMILY_REGISTRY as unknown as EffectFamilyDefinition[]).push(
        {} as EffectFamilyDefinition,
      ),
    ).toThrow();
  });

  it("freezes each entry and rejects per-entry mutation", () => {
    for (const entry of EFFECT_FAMILY_REGISTRY) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.allowedOperationKinds)).toBe(true);
    }
  });

  it("registers web_research family exactly once with create-only operation", () => {
    const matches = EFFECT_FAMILY_REGISTRY.filter(
      (entry) => entry.id === WEB_RESEARCH_EFFECT_FAMILY,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.allowedOperationKinds).toEqual(["create"]);
    expect(matches[0]?.displayName).toBe("Web research");
  });

  it("declares branchingHints for web_research family — search_specialist + search_then_composer", () => {
    const definition = getEffectFamilyDefinition(WEB_RESEARCH_EFFECT_FAMILY);
    expect(definition?.branchingHints).toEqual([
      "search_specialist",
      "search_then_composer",
    ]);
    expect(Object.isFrozen(definition?.branchingHints)).toBe(true);
  });

  it("brands web_research as a known family id", () => {
    expect(isKnownEffectFamilyId("web_research")).toBe(true);
  });

  it("exposes web_evidence.collected and web_research.summarized as branded EffectIds", () => {
    expect(WEB_EVIDENCE_COLLECTED_EFFECT).toBe("web_evidence.collected");
    expect(WEB_RESEARCH_SUMMARIZED_EFFECT).toBe("web_research.summarized");
  });

  it("does NOT carry branchingHints on non-web_research families (closed extension)", () => {
    for (const entry of EFFECT_FAMILY_REGISTRY as readonly EffectFamilyDefinition[]) {
      if (entry.id !== WEB_RESEARCH_EFFECT_FAMILY) {
        expect(entry.branchingHints).toBeUndefined();
      }
    }
  });
});
