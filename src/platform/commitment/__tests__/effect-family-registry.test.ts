import { describe, expect, it } from "vitest";
import {
  ARTIFACT_EFFECT_FAMILY,
  CODE_PATCH_APPLIED_EFFECT,
  COMMUNICATION_EFFECT_FAMILY,
  DOCX_CREATED_EFFECT,
  EFFECT_FAMILY_REGISTRY,
  IMAGE_CREATED_EFFECT,
  PDF_CREATED_EFFECT,
  PERSISTENT_SESSION_EFFECT_FAMILY,
  REPO_BRANCH_CREATED_EFFECT,
  REPO_COMMIT_LANDED_EFFECT,
  REPO_DIFF_OBSERVED_EFFECT,
  REPO_EFFECT_FAMILY,
  REPO_MERGE_COMPLETED_EFFECT,
  UNKNOWN_EFFECT_FAMILY,
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

describe("effect-family registry — Cutover-3 Artifacts Phase 2 (artifact family)", () => {
  it("preserves freeze + push-throw guard with the artifact entry appended", () => {
    expect(Object.isFrozen(EFFECT_FAMILY_REGISTRY)).toBe(true);
    expect(() =>
      (EFFECT_FAMILY_REGISTRY as unknown as EffectFamilyDefinition[]).push(
        {} as EffectFamilyDefinition,
      ),
    ).toThrow();
  });

  it("registers artifact family exactly once with id 'artifact' and displayName 'Artifact authoring'", () => {
    const matches = EFFECT_FAMILY_REGISTRY.filter(
      (entry) => entry.id === ARTIFACT_EFFECT_FAMILY,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.id).toBe("artifact");
    expect(matches[0]?.displayName).toBe("Artifact authoring");
    expect(Object.isFrozen(matches[0])).toBe(true);
    expect(Object.isFrozen(matches[0]?.allowedOperationKinds)).toBe(true);
  });

  it("artifact allowedOperationKinds set === {create, observe, update} (set-equality, order-independent)", () => {
    const definition = getEffectFamilyDefinition(ARTIFACT_EFFECT_FAMILY);
    expect(definition).toBeDefined();
    expect(new Set(definition?.allowedOperationKinds ?? [])).toEqual(
      new Set(["create", "observe", "update"]),
    );
    expect(definition?.allowedOperationKinds).toHaveLength(3);
  });

  it("artifact family does NOT carry branchingHints (only web_research does)", () => {
    const definition = getEffectFamilyDefinition(ARTIFACT_EFFECT_FAMILY);
    expect(definition?.branchingHints).toBeUndefined();
  });

  it("registry length grows from 4 to 5; existing 4 family ids preserved in order (legacy)", () => {
    // NOTE: Cutover-4 Phase 2 grew the registry to 6 entries by appending
    // `repo` last; the first 5 ids remain byte-identical and in order so
    // this assertion still checks the Cutover-3 prefix preservation.
    expect(EFFECT_FAMILY_REGISTRY.length).toBeGreaterThanOrEqual(5);
    expect(EFFECT_FAMILY_REGISTRY.slice(0, 5).map((entry) => entry.id)).toEqual([
      PERSISTENT_SESSION_EFFECT_FAMILY,
      COMMUNICATION_EFFECT_FAMILY,
      WEB_RESEARCH_EFFECT_FAMILY,
      UNKNOWN_EFFECT_FAMILY,
      ARTIFACT_EFFECT_FAMILY,
    ]);
  });

  it("brands artifact as a known family id", () => {
    expect(isKnownEffectFamilyId("artifact")).toBe(true);
    expect(isKnownEffectFamilyId(ARTIFACT_EFFECT_FAMILY)).toBe(true);
  });

  it("declares 4 new EffectId constants distinct from each other AND from existing effect ids", () => {
    const newEffects = [
      PDF_CREATED_EFFECT,
      DOCX_CREATED_EFFECT,
      CODE_PATCH_APPLIED_EFFECT,
      IMAGE_CREATED_EFFECT,
    ];

    // Distinct from each other (no accidental dedup).
    expect(new Set(newEffects).size).toBe(newEffects.length);

    // Concrete string values match Phase 2 spec verbatim.
    expect(PDF_CREATED_EFFECT).toBe("pdf.created");
    expect(DOCX_CREATED_EFFECT).toBe("docx.created");
    expect(CODE_PATCH_APPLIED_EFFECT).toBe("code_patch.applied");
    expect(IMAGE_CREATED_EFFECT).toBe("image.created");

    // Distinct from existing effect ids exported from the registry.
    const existing = [WEB_EVIDENCE_COLLECTED_EFFECT, WEB_RESEARCH_SUMMARIZED_EFFECT];
    for (const eff of newEffects) {
      for (const old of existing) {
        expect(eff).not.toBe(old);
      }
    }
  });

  it("invariant #16 sentinel: ARTIFACT_EFFECT_FAMILY (EffectFamilyId) and the four EffectIds remain distinct phantom-typed strings", () => {
    // The brand is a phantom type; underlying primitives are plain strings.
    // Cross-domain equality between an EffectFamilyId and an EffectId is a
    // structural canary — if a refactor accidentally collapsed brands to
    // share a value, this test would catch it.
    expect((ARTIFACT_EFFECT_FAMILY as unknown as string)).toBe("artifact");
    expect((PDF_CREATED_EFFECT as unknown as string)).not.toBe(
      ARTIFACT_EFFECT_FAMILY as unknown as string,
    );
    expect((DOCX_CREATED_EFFECT as unknown as string)).not.toBe(
      ARTIFACT_EFFECT_FAMILY as unknown as string,
    );
    expect((CODE_PATCH_APPLIED_EFFECT as unknown as string)).not.toBe(
      ARTIFACT_EFFECT_FAMILY as unknown as string,
    );
    expect((IMAGE_CREATED_EFFECT as unknown as string)).not.toBe(
      ARTIFACT_EFFECT_FAMILY as unknown as string,
    );
  });
});

describe("effect-family registry — Cutover-4 Phase 2 (repo family)", () => {
  it("preserves freeze + push-throw guard with the repo entry appended", () => {
    expect(Object.isFrozen(EFFECT_FAMILY_REGISTRY)).toBe(true);
    expect(() =>
      (EFFECT_FAMILY_REGISTRY as unknown as EffectFamilyDefinition[]).push(
        {} as EffectFamilyDefinition,
      ),
    ).toThrow();
  });

  it("registers repo family exactly once with id 'repo' and displayName 'Repository operation'", () => {
    const matches = EFFECT_FAMILY_REGISTRY.filter(
      (entry) => entry.id === REPO_EFFECT_FAMILY,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.id).toBe("repo");
    expect(matches[0]?.displayName).toBe("Repository operation");
    expect(Object.isFrozen(matches[0])).toBe(true);
    expect(Object.isFrozen(matches[0]?.allowedOperationKinds)).toBe(true);
  });

  it("repo allowedOperationKinds set === {create, observe, update, cancel} (set-equality, order-independent)", () => {
    const definition = getEffectFamilyDefinition(REPO_EFFECT_FAMILY);
    expect(definition).toBeDefined();
    expect(new Set(definition?.allowedOperationKinds ?? [])).toEqual(
      new Set(["create", "observe", "update", "cancel"]),
    );
    expect(definition?.allowedOperationKinds).toHaveLength(4);
  });

  it("repo family does NOT carry branchingHints (only web_research does — Cutover-3 precedent)", () => {
    const definition = getEffectFamilyDefinition(REPO_EFFECT_FAMILY);
    expect(definition?.branchingHints).toBeUndefined();
  });

  it("registry length grows from 5 to 6; existing 5 family ids preserved in order; repo appended last", () => {
    expect(EFFECT_FAMILY_REGISTRY).toHaveLength(6);
    expect(EFFECT_FAMILY_REGISTRY.map((entry) => entry.id)).toEqual([
      PERSISTENT_SESSION_EFFECT_FAMILY,
      COMMUNICATION_EFFECT_FAMILY,
      WEB_RESEARCH_EFFECT_FAMILY,
      UNKNOWN_EFFECT_FAMILY,
      ARTIFACT_EFFECT_FAMILY,
      REPO_EFFECT_FAMILY,
    ]);
  });

  it("brands repo as a known family id", () => {
    expect(isKnownEffectFamilyId("repo")).toBe(true);
    expect(isKnownEffectFamilyId(REPO_EFFECT_FAMILY)).toBe(true);
  });

  it("declares 4 new repo EffectId constants distinct from each other AND from existing effect ids", () => {
    const newEffects = [
      REPO_BRANCH_CREATED_EFFECT,
      REPO_COMMIT_LANDED_EFFECT,
      REPO_MERGE_COMPLETED_EFFECT,
      REPO_DIFF_OBSERVED_EFFECT,
    ];

    // Distinct from each other (no accidental dedup).
    expect(new Set(newEffects).size).toBe(newEffects.length);

    // Concrete string values match Phase 2 spec verbatim.
    expect(REPO_BRANCH_CREATED_EFFECT).toBe("repo.branch_created");
    expect(REPO_COMMIT_LANDED_EFFECT).toBe("repo.commit_landed");
    expect(REPO_MERGE_COMPLETED_EFFECT).toBe("repo.merge_completed");
    expect(REPO_DIFF_OBSERVED_EFFECT).toBe("repo.diff_observed");

    // Distinct from existing effect ids exported from the registry.
    const existing = [
      WEB_EVIDENCE_COLLECTED_EFFECT,
      WEB_RESEARCH_SUMMARIZED_EFFECT,
      PDF_CREATED_EFFECT,
      DOCX_CREATED_EFFECT,
      CODE_PATCH_APPLIED_EFFECT,
      IMAGE_CREATED_EFFECT,
    ];
    for (const eff of newEffects) {
      for (const old of existing) {
        expect(eff).not.toBe(old);
      }
    }
  });

  it("invariant #16 sentinel: REPO_EFFECT_FAMILY (EffectFamilyId) and the four repo EffectIds remain distinct phantom-typed strings", () => {
    expect((REPO_EFFECT_FAMILY as unknown as string)).toBe("repo");
    expect((REPO_BRANCH_CREATED_EFFECT as unknown as string)).not.toBe(
      REPO_EFFECT_FAMILY as unknown as string,
    );
    expect((REPO_COMMIT_LANDED_EFFECT as unknown as string)).not.toBe(
      REPO_EFFECT_FAMILY as unknown as string,
    );
    expect((REPO_MERGE_COMPLETED_EFFECT as unknown as string)).not.toBe(
      REPO_EFFECT_FAMILY as unknown as string,
    );
    expect((REPO_DIFF_OBSERVED_EFFECT as unknown as string)).not.toBe(
      REPO_EFFECT_FAMILY as unknown as string,
    );
  });
});
