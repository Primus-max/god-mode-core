import { describe, expect, it } from "vitest";
import {
  PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
  PERSISTENT_SESSION_EFFECT_FAMILY,
  allowAllPolicyGate,
  createAffordanceRegistry,
  createShadowBuilder,
  pickAllowedConstraints,
  type PolicyGateReader,
  type ShadowBuilderLogger,
} from "../index.js";
import type { AffordanceId, EffectId } from "../ids.js";
import type { SemanticIntent } from "../semantic-intent.js";

const persistentCreateIntent: SemanticIntent = {
  desiredEffectFamily: PERSISTENT_SESSION_EFFECT_FAMILY,
  target: { kind: "session" },
  operation: { kind: "create" },
  constraints: {
    displayName: "Valera",
    description: "Daily project report",
    parentSessionKey: "parent-1",
    unapproved: "ignored",
  },
  uncertainty: [],
  confidence: 0.91,
};

function makeLogger(events: unknown[]): ShadowBuilderLogger {
  return {
    trace: (_message, fields) => events.push(fields),
  };
}

describe("ShadowBuilder implementation", () => {
  it("builds a commitment from a single matching affordance", async () => {
    const events: unknown[] = [];
    const builder = createShadowBuilder({
      affordances: createAffordanceRegistry(),
      policy: allowAllPolicyGate,
      logger: makeLogger(events),
      confidenceThreshold: 0.6,
    });

    const result = await builder.build(persistentCreateIntent);

    expect(result.kind).toBe("commitment");
    if (result.kind !== "commitment") {
      throw new Error("expected commitment");
    }
    expect(result.value.effect).toBe("persistent_session.created");
    expect(result.value.target).toEqual({ kind: "session" });
    expect(result.value.constraints).toEqual({
      displayName: "Valera",
      description: "Daily project report",
      parentSessionKey: "parent-1",
    });
    expect(events).toEqual([{ affordance_branching_factor: 1 }]);
  });

  it("returns low_confidence_intent before registry lookup", async () => {
    const events: unknown[] = [];
    const builder = createShadowBuilder({
      affordances: createAffordanceRegistry(),
      policy: allowAllPolicyGate,
      logger: makeLogger(events),
      confidenceThreshold: 0.6,
    });

    await expect(
      builder.build({ ...persistentCreateIntent, confidence: 0.4 }),
    ).resolves.toEqual({ kind: "unsupported", reason: "low_confidence_intent" });
    expect(events).toEqual([]);
  });

  it("returns no_matching_affordance and logs branching factor zero", async () => {
    const events: unknown[] = [];
    const builder = createShadowBuilder({
      affordances: createAffordanceRegistry(),
      policy: allowAllPolicyGate,
      logger: makeLogger(events),
      confidenceThreshold: 0.6,
    });

    await expect(
      builder.build({
        ...persistentCreateIntent,
        operation: { kind: "observe" },
      }),
    ).resolves.toEqual({ kind: "unsupported", reason: "no_matching_affordance" });
    expect(events).toEqual([{ affordance_branching_factor: 0 }]);
  });

  it("returns typed unsupported for multiple candidates", async () => {
    const events: unknown[] = [];
    const duplicate = {
      ...PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
      id: "persistent_session.created.second" as AffordanceId,
      effect: "persistent_session.created.second" as EffectId,
    };
    const builder = createShadowBuilder({
      affordances: createAffordanceRegistry([
        PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
        duplicate,
      ]),
      policy: allowAllPolicyGate,
      logger: makeLogger(events),
      confidenceThreshold: 0.6,
    });

    await expect(builder.build(persistentCreateIntent)).resolves.toEqual({
      kind: "unsupported",
      reason: "no_matching_affordance",
      uncertainty: ["multiple_candidates"],
    });
    expect(events).toEqual([{ affordance_branching_factor: 2 }]);
  });

  it("honors policy rejection before building a commitment", async () => {
    const policy: PolicyGateReader = {
      canUseAffordance: () => ({ allowed: false, reason: "blocked" }),
    };
    const builder = createShadowBuilder({
      affordances: createAffordanceRegistry(),
      policy,
      logger: {},
      confidenceThreshold: 0.6,
    });

    await expect(builder.build(persistentCreateIntent)).resolves.toEqual({
      kind: "unsupported",
      reason: "policy_blocked",
    });
  });

  it("filters intent constraints through the affordance whitelist", () => {
    expect(
      pickAllowedConstraints(
        persistentCreateIntent.constraints,
        PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
      ),
    ).toEqual({
      displayName: "Valera",
      description: "Daily project report",
      parentSessionKey: "parent-1",
    });
  });
});
