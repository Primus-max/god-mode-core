import { describe, expect, it } from "vitest";
import {
  ANSWER_DELIVERED_AFFORDANCE_ENTRY,
  CLARIFICATION_REQUESTED_AFFORDANCE_ENTRY,
  COMMUNICATION_EFFECT_FAMILY,
  EFFECT_FAMILY_REGISTRY,
  EXTERNAL_EFFECT_PERFORMED_AFFORDANCE_ENTRY,
  PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
  PERSISTENT_SESSION_EFFECT_FAMILY,
  UNKNOWN_EFFECT_FAMILY,
  createAffordanceRegistry,
  getEffectFamilyDefinition,
  isKnownEffectFamilyId,
  resolveEffectFamilyId,
} from "../index.js";
import type { ChannelId, EffectFamilyId } from "../ids.js";

describe("effect-family registry", () => {
  it("includes persistent_session, communication (PR-4b), and unknown families", () => {
    expect(EFFECT_FAMILY_REGISTRY.map((entry) => entry.id)).toEqual([
      "persistent_session",
      "communication",
      "unknown",
    ]);
  });

  it("exposes allowed operation kinds per family", () => {
    expect(
      getEffectFamilyDefinition(PERSISTENT_SESSION_EFFECT_FAMILY)?.allowedOperationKinds,
    ).toEqual(["create", "observe", "cancel"]);
    expect(getEffectFamilyDefinition(COMMUNICATION_EFFECT_FAMILY)?.allowedOperationKinds).toEqual([
      "create",
      "observe",
    ]);
    expect(getEffectFamilyDefinition(UNKNOWN_EFFECT_FAMILY)?.allowedOperationKinds).toEqual(
      [],
    );
  });

  it("brands only registered family ids and falls back to unknown", () => {
    expect(isKnownEffectFamilyId("persistent_session")).toBe(true);
    expect(isKnownEffectFamilyId("communication")).toBe(true);
    expect(isKnownEffectFamilyId("answer_delivered")).toBe(false);
    expect(resolveEffectFamilyId("answer_delivered")).toBe(UNKNOWN_EFFECT_FAMILY);
  });
});

describe("affordance registry", () => {
  it("registers Wave A persistent-session + Wave B chat-effect affordances", () => {
    const registry = createAffordanceRegistry();
    expect(registry.all()).toEqual([
      PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
      ANSWER_DELIVERED_AFFORDANCE_ENTRY,
      CLARIFICATION_REQUESTED_AFFORDANCE_ENTRY,
      EXTERNAL_EFFECT_PERFORMED_AFFORDANCE_ENTRY,
    ]);
  });

  it("resolves persistent-session create intent to the catalog candidate", () => {
    const registry = createAffordanceRegistry();
    const candidates = registry.findByFamily(
      PERSISTENT_SESSION_EFFECT_FAMILY,
      { kind: "session" },
      { kind: "create" },
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.effect).toBe("persistent_session.created");
    expect(candidates[0]?.allowedConstraintKeys).toEqual([
      "displayName",
      "description",
      "parentSessionKey",
    ]);
  });

  it("disambiguates communication-family affordances by target and operation", () => {
    const registry = createAffordanceRegistry();

    const channelTarget = {
      kind: "external_channel",
      channelId: "telegram" as ChannelId,
    } as const;

    const answerCreate = registry.findByFamily(
      COMMUNICATION_EFFECT_FAMILY,
      channelTarget,
      { kind: "create" },
    );
    expect(answerCreate).toHaveLength(1);
    expect(answerCreate[0]?.effect).toBe("answer.delivered");

    const clarificationCreate = registry.findByFamily(
      COMMUNICATION_EFFECT_FAMILY,
      { kind: "unspecified" },
      { kind: "create" },
    );
    expect(clarificationCreate).toHaveLength(1);
    expect(clarificationCreate[0]?.effect).toBe("clarification_requested");

    const externalObserve = registry.findByFamily(
      COMMUNICATION_EFFECT_FAMILY,
      channelTarget,
      { kind: "observe" },
    );
    expect(externalObserve).toHaveLength(1);
    expect(externalObserve[0]?.effect).toBe("external_effect.performed");
  });

  it("does not resolve unknown family, unsupported operation, or unrelated target", () => {
    const registry = createAffordanceRegistry();

    expect(
      registry.findByFamily(UNKNOWN_EFFECT_FAMILY, { kind: "session" }, { kind: "create" }),
    ).toEqual([]);
    expect(
      registry.findByFamily(
        PERSISTENT_SESSION_EFFECT_FAMILY,
        { kind: "session" },
        { kind: "observe" },
      ),
    ).toEqual([]);
    expect(
      registry.findByFamily(
        PERSISTENT_SESSION_EFFECT_FAMILY,
        { kind: "artifact", artifactId: "artifact-1" },
        { kind: "create" },
      ),
    ).toEqual([]);
  });

  it("accepts custom fixture registries without widening the default catalog", () => {
    const registry = createAffordanceRegistry([]);
    const unknown = "custom_family" as EffectFamilyId;

    expect(registry.all()).toEqual([]);
    expect(registry.findByFamily(unknown, { kind: "unspecified" })).toEqual([]);
    expect(createAffordanceRegistry().all()).toHaveLength(4);
  });
});
