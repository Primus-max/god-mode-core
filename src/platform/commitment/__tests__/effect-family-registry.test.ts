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
  REMINDER_DELIVERED_EFFECT,
  REMINDER_EFFECT_FAMILY,
  REMINDER_SET_EFFECT,
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

  it("registry length grows from 5 to 6; existing 5 family ids preserved in order; repo appended last (Cutover-4 prefix preservation)", () => {
    // NOTE: Slice K Phase 3 grew the registry to 7 by appending `reminder`
    // last; the first 6 ids remain byte-identical and in order so this
    // assertion still checks the Cutover-4 prefix preservation.
    expect(EFFECT_FAMILY_REGISTRY.length).toBeGreaterThanOrEqual(6);
    expect(EFFECT_FAMILY_REGISTRY.slice(0, 6).map((entry) => entry.id)).toEqual([
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

describe("effect-family registry — Slice K Phase 3 (reminder family)", () => {
  it("preserves freeze + push-throw guard with the reminder entry appended", () => {
    expect(Object.isFrozen(EFFECT_FAMILY_REGISTRY)).toBe(true);
    expect(() =>
      (EFFECT_FAMILY_REGISTRY as unknown as EffectFamilyDefinition[]).push(
        {} as EffectFamilyDefinition,
      ),
    ).toThrow();
  });

  it("registers reminder family exactly once with id 'reminder' and displayName 'Reminder query'", () => {
    const matches = EFFECT_FAMILY_REGISTRY.filter(
      (entry) => entry.id === REMINDER_EFFECT_FAMILY,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.id).toBe("reminder");
    expect(matches[0]?.displayName).toBe("Reminder query");
    expect(Object.isFrozen(matches[0])).toBe(true);
    expect(Object.isFrozen(matches[0]?.allowedOperationKinds)).toBe(true);
  });

  it("reminder allowedOperationKinds includes 'observe' (slice K read-side preserved after Cron/Scheduler Phase 2 widen)", () => {
    // Slice K originally registered `reminder` with `['observe']` only. Cron/
    // Scheduler Phase 2 ADDITIVELY widens to `['observe', 'create']` for the
    // write-side reminder.set affordance. The set-equality assertion in the
    // dedicated "Cron/Scheduler Phase 2" describe block below pins the exact
    // post-widen contents; this assertion preserves the slice K read-side
    // guarantee (observe MUST still be present).
    const definition = getEffectFamilyDefinition(REMINDER_EFFECT_FAMILY);
    expect(definition).toBeDefined();
    expect(definition?.allowedOperationKinds).toContain("observe");
  });

  it("reminder family does NOT carry branchingHints (only web_research does — Cutover-3/4 precedent)", () => {
    const definition = getEffectFamilyDefinition(REMINDER_EFFECT_FAMILY);
    expect(definition?.branchingHints).toBeUndefined();
  });

  it("registry length grows from 6 to 7; existing 6 family ids preserved in order; reminder appended last", () => {
    expect(EFFECT_FAMILY_REGISTRY).toHaveLength(7);
    expect(EFFECT_FAMILY_REGISTRY.map((entry) => entry.id)).toEqual([
      PERSISTENT_SESSION_EFFECT_FAMILY,
      COMMUNICATION_EFFECT_FAMILY,
      WEB_RESEARCH_EFFECT_FAMILY,
      UNKNOWN_EFFECT_FAMILY,
      ARTIFACT_EFFECT_FAMILY,
      REPO_EFFECT_FAMILY,
      REMINDER_EFFECT_FAMILY,
    ]);
  });

  it("brands reminder as a known family id", () => {
    expect(isKnownEffectFamilyId("reminder")).toBe(true);
    expect(isKnownEffectFamilyId(REMINDER_EFFECT_FAMILY)).toBe(true);
  });

  it("declares REMINDER_DELIVERED_EFFECT as a branded EffectId distinct from REMINDER_EFFECT_FAMILY and from existing effect ids", () => {
    expect(REMINDER_DELIVERED_EFFECT).toBe("reminder.delivered");

    // Distinct from the family-id phantom string.
    expect((REMINDER_DELIVERED_EFFECT as unknown as string)).not.toBe(
      REMINDER_EFFECT_FAMILY as unknown as string,
    );

    // Distinct from every previously-declared EffectId constant.
    const existing = [
      WEB_EVIDENCE_COLLECTED_EFFECT,
      WEB_RESEARCH_SUMMARIZED_EFFECT,
      PDF_CREATED_EFFECT,
      DOCX_CREATED_EFFECT,
      CODE_PATCH_APPLIED_EFFECT,
      IMAGE_CREATED_EFFECT,
      REPO_BRANCH_CREATED_EFFECT,
      REPO_COMMIT_LANDED_EFFECT,
      REPO_MERGE_COMPLETED_EFFECT,
      REPO_DIFF_OBSERVED_EFFECT,
    ];
    for (const old of existing) {
      expect(REMINDER_DELIVERED_EFFECT).not.toBe(old);
    }
  });

  it("invariant #16 sentinel: REMINDER_EFFECT_FAMILY (EffectFamilyId) and REMINDER_DELIVERED_EFFECT (EffectId) remain distinct phantom-typed strings", () => {
    expect((REMINDER_EFFECT_FAMILY as unknown as string)).toBe("reminder");
    expect((REMINDER_DELIVERED_EFFECT as unknown as string)).toBe(
      "reminder.delivered",
    );
    expect((REMINDER_EFFECT_FAMILY as unknown as string)).not.toBe(
      REMINDER_DELIVERED_EFFECT as unknown as string,
    );
  });
});

describe("effect-family registry — Cron/Scheduler Phase 2 (reminder allowlist widen + REMINDER_SET_EFFECT)", () => {
  it("preserves freeze + push-throw guard with the reminder entry widened in place", () => {
    expect(Object.isFrozen(EFFECT_FAMILY_REGISTRY)).toBe(true);
    expect(() =>
      (EFFECT_FAMILY_REGISTRY as unknown as EffectFamilyDefinition[]).push(
        {} as EffectFamilyDefinition,
      ),
    ).toThrow();
  });

  it("registers reminder family exactly once (no new family added — slice K registration REUSED)", () => {
    const matches = EFFECT_FAMILY_REGISTRY.filter(
      (entry) => entry.id === REMINDER_EFFECT_FAMILY,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.id).toBe("reminder");
    expect(matches[0]?.displayName).toBe("Reminder query");
  });

  it("reminder allowedOperationKinds set === {observe, create} EXACTLY (order-independent set-equality)", () => {
    const definition = getEffectFamilyDefinition(REMINDER_EFFECT_FAMILY);
    expect(definition).toBeDefined();
    expect(new Set(definition?.allowedOperationKinds ?? [])).toEqual(
      new Set(["observe", "create"]),
    );
    expect(definition?.allowedOperationKinds).toHaveLength(2);
  });

  it("reminder allowedOperationKinds remains a frozen readonly tuple after the widen", () => {
    const definition = getEffectFamilyDefinition(REMINDER_EFFECT_FAMILY);
    expect(definition).toBeDefined();
    expect(Object.isFrozen(definition?.allowedOperationKinds)).toBe(true);
  });

  it("declares REMINDER_SET_EFFECT === 'reminder.set' as a branded EffectId distinct from every prior EffectId", () => {
    expect(REMINDER_SET_EFFECT).toBe("reminder.set");

    // Distinct from every previously-declared EffectId constant
    // (Cutover-3 P2 / Cutover-4 P2 / Slice K P3 precedent).
    const existing = [
      WEB_EVIDENCE_COLLECTED_EFFECT,
      WEB_RESEARCH_SUMMARIZED_EFFECT,
      PDF_CREATED_EFFECT,
      DOCX_CREATED_EFFECT,
      CODE_PATCH_APPLIED_EFFECT,
      IMAGE_CREATED_EFFECT,
      REPO_BRANCH_CREATED_EFFECT,
      REPO_COMMIT_LANDED_EFFECT,
      REPO_MERGE_COMPLETED_EFFECT,
      REPO_DIFF_OBSERVED_EFFECT,
      REMINDER_DELIVERED_EFFECT,
    ];
    for (const old of existing) {
      expect(REMINDER_SET_EFFECT).not.toBe(old);
    }
  });

  it("invariant #16 sentinel: REMINDER_EFFECT_FAMILY (EffectFamilyId) and REMINDER_SET_EFFECT (EffectId) remain distinct phantom-typed strings", () => {
    // The brand is a phantom type; underlying primitives are plain strings.
    // Cross-domain equality between an EffectFamilyId and an EffectId is a
    // structural canary — if a refactor accidentally collapsed brands to
    // share a value, this test would catch it.
    expect((REMINDER_EFFECT_FAMILY as unknown as string)).toBe("reminder");
    expect((REMINDER_SET_EFFECT as unknown as string)).toBe("reminder.set");
    expect((REMINDER_EFFECT_FAMILY as unknown as string)).not.toBe(
      REMINDER_SET_EFFECT as unknown as string,
    );
    // Also distinct from the slice K observe-side EffectId.
    expect((REMINDER_SET_EFFECT as unknown as string)).not.toBe(
      REMINDER_DELIVERED_EFFECT as unknown as string,
    );
  });

  it("invariant #16 reverse-test: EffectFamilyId is NOT assignable to EffectId at the type level (compile-time canary)", () => {
    // This test exists to fail TypeScript compilation if a future refactor
    // collapses `EffectFamilyId` and `EffectId` brands. The `@ts-expect-error`
    // annotation must remain — its absence (i.e. the cross-brand assignment
    // typechecks) is what would constitute the regression.
    const familyId = REMINDER_EFFECT_FAMILY;
    // @ts-expect-error invariant #16: EffectFamilyId is NOT assignable to EffectId
    const asEffectId: typeof REMINDER_SET_EFFECT = familyId;
    // Runtime assertion is incidental — the compile-time check is the point.
    expect(typeof asEffectId).toBe("string");
  });

  it("registry length unchanged — Phase 2 widens in place; registry stays at 7 entries", () => {
    // Slice K Phase 3 grew the registry to 7 (last family added: reminder).
    // Cron/Scheduler Phase 2 ADDITIVELY widens the existing reminder entry's
    // allowedOperationKinds tuple WITHOUT appending a new family. Length must
    // stay 7.
    expect(EFFECT_FAMILY_REGISTRY).toHaveLength(7);
  });
});
