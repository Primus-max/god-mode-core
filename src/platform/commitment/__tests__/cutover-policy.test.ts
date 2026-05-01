import { describe, expect, it } from "vitest";
import { createCutoverPolicy, defaultCutoverPolicy } from "../cutover-policy.js";
import type { EffectFamilyId, EffectId } from "../ids.js";

describe("cutover policy", () => {
  it("includes persistent_session.created (Wave A) plus the 3 chat-bound effects (Wave B) by default", () => {
    expect(defaultCutoverPolicy.list()).toEqual([
      { effect: "persistent_session.created", effectFamily: "persistent_session" },
      { effect: "answer.delivered", effectFamily: "communication" },
      { effect: "clarification_requested", effectFamily: "communication" },
      { effect: "external_effect.performed", effectFamily: "communication" },
    ]);

    expect(defaultCutoverPolicy.isEligible("persistent_session.created" as EffectId)).toBe(true);
    expect(defaultCutoverPolicy.isEligible("answer.delivered" as EffectId)).toBe(true);
    expect(defaultCutoverPolicy.isEligible("clarification_requested" as EffectId)).toBe(true);
    expect(defaultCutoverPolicy.isEligible("external_effect.performed" as EffectId)).toBe(true);
    expect(defaultCutoverPolicy.isEligible("artifact.created" as EffectId)).toBe(false);
    expect(defaultCutoverPolicy.isEligible("repo_operation.completed" as EffectId)).toBe(false);
  });

  it("supports fixture policies without widening the default policy", () => {
    const fixturePolicy = createCutoverPolicy([
      {
        effect: "artifact.created" as EffectId,
        effectFamily: "artifact" as EffectFamilyId,
      },
    ]);

    expect(fixturePolicy.isEligible("artifact.created" as EffectId)).toBe(true);
    expect(defaultCutoverPolicy.isEligible("artifact.created" as EffectId)).toBe(false);
  });
});
