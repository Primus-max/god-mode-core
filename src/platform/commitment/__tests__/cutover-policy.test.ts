import { describe, expect, it } from "vitest";
import { createCutoverPolicy, defaultCutoverPolicy } from "../cutover-policy.js";
import type { EffectFamilyId, EffectId } from "../ids.js";

describe("cutover policy", () => {
  it("marks only persistent_session.created as cutover-1 eligible by default", () => {
    expect(defaultCutoverPolicy.list()).toEqual([
      {
        effect: "persistent_session.created",
        effectFamily: "persistent_session",
      },
    ]);

    expect(defaultCutoverPolicy.isEligible("persistent_session.created" as EffectId)).toBe(true);
    expect(defaultCutoverPolicy.isEligible("answer.delivered" as EffectId)).toBe(false);
    expect(defaultCutoverPolicy.isEligible("artifact.created" as EffectId)).toBe(false);
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
