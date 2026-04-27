import { describe, expect, it } from "vitest";
import {
  EFFECT_FAMILY_REGISTRY,
  PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
  PERSISTENT_SESSION_EFFECT_FAMILY,
  UNKNOWN_EFFECT_FAMILY,
  createAffordanceRegistry,
  getEffectFamilyDefinition,
  isKnownEffectFamilyId,
  resolveEffectFamilyId,
} from "../index.js";
import type { EffectFamilyId } from "../ids.js";

describe("effect-family registry", () => {
  it("keeps the PR-2 registry closed to persistent_session and unknown", () => {
    expect(EFFECT_FAMILY_REGISTRY.map((entry) => entry.id)).toEqual([
      "persistent_session",
      "unknown",
    ]);
  });

  it("exposes allowed operation kinds per family", () => {
    expect(
      getEffectFamilyDefinition(PERSISTENT_SESSION_EFFECT_FAMILY)?.allowedOperationKinds,
    ).toEqual(["create", "observe", "cancel"]);
    expect(getEffectFamilyDefinition(UNKNOWN_EFFECT_FAMILY)?.allowedOperationKinds).toEqual(
      [],
    );
  });

  it("brands only registered family ids and falls back to unknown", () => {
    expect(isKnownEffectFamilyId("persistent_session")).toBe(true);
    expect(isKnownEffectFamilyId("answer_delivered")).toBe(false);
    expect(resolveEffectFamilyId("answer_delivered")).toBe(UNKNOWN_EFFECT_FAMILY);
  });
});

describe("affordance registry", () => {
  it("registers exactly one PR-2 affordance", () => {
    const registry = createAffordanceRegistry();
    expect(registry.all()).toEqual([PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY]);
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
    expect(createAffordanceRegistry().all()).toHaveLength(1);
  });
});
