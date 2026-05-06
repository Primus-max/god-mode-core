import { describe, expect, it } from "vitest";
import { createCutoverPolicy, defaultCutoverPolicy } from "../cutover-policy.js";
import type { EffectFamilyId, EffectId } from "../ids.js";

describe("cutover policy", () => {
  it("includes Wave A + Wave B chat effects PLUS the 4 cutover-3 artifact effects by default", () => {
    // Cutover-3 Phase 7 (sub-plan §4 #5 — "all four"): the allow-list grows
    // additively from 4 entries (cutover-2 PR-#104) to 8 entries. Existing
    // 4 entries stay byte-identical and in the same leading slots; the 4
    // new artifact effect ids land in append-order per the audit
    // recommendation in `extensions/AUDIT-cutover3-artifacts.md`.
    expect(defaultCutoverPolicy.list()).toEqual([
      // ── Wave A (PR-#103, cutover-1) ────────────────────────────────────
      { effect: "persistent_session.created", effectFamily: "persistent_session" },
      // ── Wave B (PR-#104, cutover-2 chat effects) ──────────────────────
      { effect: "answer.delivered", effectFamily: "communication" },
      { effect: "clarification_requested", effectFamily: "communication" },
      { effect: "external_effect.performed", effectFamily: "communication" },
      // ── Cutover-3 Phase 7 (this PR — artifact authoring) ──────────────
      { effect: "pdf.created", effectFamily: "artifact" },
      { effect: "docx.created", effectFamily: "artifact" },
      { effect: "code_patch.applied", effectFamily: "artifact" },
      { effect: "image.created", effectFamily: "artifact" },
    ]);

    // Wave A + B preserved (additive-extension regression guard).
    expect(defaultCutoverPolicy.isEligible("persistent_session.created" as EffectId)).toBe(true);
    expect(defaultCutoverPolicy.isEligible("answer.delivered" as EffectId)).toBe(true);
    expect(defaultCutoverPolicy.isEligible("clarification_requested" as EffectId)).toBe(true);
    expect(defaultCutoverPolicy.isEligible("external_effect.performed" as EffectId)).toBe(true);
    // Cutover-3 Phase 7 — all four artifact effects eligible.
    expect(defaultCutoverPolicy.isEligible("pdf.created" as EffectId)).toBe(true);
    expect(defaultCutoverPolicy.isEligible("docx.created" as EffectId)).toBe(true);
    expect(defaultCutoverPolicy.isEligible("code_patch.applied" as EffectId)).toBe(true);
    expect(defaultCutoverPolicy.isEligible("image.created" as EffectId)).toBe(true);
    // Sister-effect under the same family but NOT in the explicit allow-list
    // remains ineligible (closed-allow-list canary — guards against an
    // accidental "any-artifact-effect" widening regression).
    expect(defaultCutoverPolicy.isEligible("artifact.created" as EffectId)).toBe(false);
    // Cutover-4 effect explicitly out of scope for this slice.
    expect(defaultCutoverPolicy.isEligible("repo_operation.completed" as EffectId)).toBe(false);
  });

  it("default cutover-policy entries are deeply frozen (push throws, length stable)", () => {
    const list = defaultCutoverPolicy.list();
    expect(Object.isFrozen(list)).toBe(true);
    expect(list).toHaveLength(8);
    expect(() => {
      (list as unknown as { push: (item: unknown) => void }).push({
        effect: "rogue.effect" as EffectId,
        effectFamily: "rogue" as EffectFamilyId,
      });
    }).toThrow();
    // Per-entry frozen too (cutover-2 reverse-test posture preserved).
    for (const entry of list) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });

  it("supports fixture policies without widening the default policy", () => {
    const fixturePolicy = createCutoverPolicy([
      {
        effect: "rogue.effect" as EffectId,
        effectFamily: "rogue" as EffectFamilyId,
      },
    ]);

    expect(fixturePolicy.isEligible("rogue.effect" as EffectId)).toBe(true);
    expect(defaultCutoverPolicy.isEligible("rogue.effect" as EffectId)).toBe(false);
  });
});
