import { describe, expect, it } from "vitest";
import {
  ANSWER_DELIVERED_AFFORDANCE_ENTRY,
  CLARIFICATION_REQUESTED_AFFORDANCE_ENTRY,
  COMMUNICATION_EFFECT_FAMILY,
  COMPOSER_AFTER_SEARCH_AFFORDANCE_ENTRY,
  EFFECT_FAMILY_REGISTRY,
  EXTERNAL_EFFECT_PERFORMED_AFFORDANCE_ENTRY,
  PERPLEXITY_SEARCH_SPECIALIST_AFFORDANCE_ENTRY,
  PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
  PERSISTENT_SESSION_EFFECT_FAMILY,
  UNKNOWN_EFFECT_FAMILY,
  WEB_EVIDENCE_PRESENT_PRECONDITION,
  WEB_RESEARCH_EFFECT_FAMILY,
  createAffordanceRegistry,
  getEffectFamilyDefinition,
  isKnownEffectFamilyId,
  resolveEffectFamilyId,
} from "../index.js";
import type { ChannelId, EffectFamilyId } from "../ids.js";
import type { WorldStateSnapshot } from "../world-state.js";
import type { ExpectedDelta } from "../expected-delta.js";

describe("effect-family registry", () => {
  it("includes persistent_session, communication (PR-4b), web_research (search-composer), and unknown families", () => {
    expect(EFFECT_FAMILY_REGISTRY.map((entry) => entry.id)).toEqual([
      "persistent_session",
      "communication",
      "web_research",
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
  it("registers Wave A persistent-session + Wave B chat-effect + Search-Composer Phase 2 web_research affordances", () => {
    const registry = createAffordanceRegistry();
    expect(registry.all()).toEqual([
      PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
      ANSWER_DELIVERED_AFFORDANCE_ENTRY,
      CLARIFICATION_REQUESTED_AFFORDANCE_ENTRY,
      EXTERNAL_EFFECT_PERFORMED_AFFORDANCE_ENTRY,
      PERPLEXITY_SEARCH_SPECIALIST_AFFORDANCE_ENTRY,
      COMPOSER_AFTER_SEARCH_AFFORDANCE_ENTRY,
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
    expect(createAffordanceRegistry().all()).toHaveLength(6);
  });
});

describe("affordance registry — web_research family (Search-Composer Phase 2)", () => {
  it("resolves the perplexity_search_specialist affordance for unspecified, external_channel, artifact, and workspace targets", () => {
    const registry = createAffordanceRegistry();

    for (const target of [
      { kind: "unspecified" } as const,
      { kind: "external_channel", channelId: "telegram" as ChannelId } as const,
      { kind: "artifact", artifactId: "pdf-1" } as const,
      { kind: "workspace" } as const,
    ]) {
      const candidates = registry.findByFamily(WEB_RESEARCH_EFFECT_FAMILY, target, {
        kind: "create",
      });
      expect(candidates.map((c) => c.id)).toContain(PERPLEXITY_SEARCH_SPECIALIST_AFFORDANCE_ENTRY.id);
    }
  });

  it("resolves the composer_after_search affordance for external_channel and artifact targets only", () => {
    const registry = createAffordanceRegistry();

    const channelTarget = {
      kind: "external_channel",
      channelId: "telegram" as ChannelId,
    } as const;
    const artifactTarget = { kind: "artifact", artifactId: "pdf-1" } as const;
    const sessionTarget = { kind: "session" } as const;

    const channelCandidates = registry.findByFamily(WEB_RESEARCH_EFFECT_FAMILY, channelTarget, {
      kind: "create",
    });
    expect(channelCandidates.map((c) => c.id)).toContain(
      COMPOSER_AFTER_SEARCH_AFFORDANCE_ENTRY.id,
    );

    const artifactCandidates = registry.findByFamily(WEB_RESEARCH_EFFECT_FAMILY, artifactTarget, {
      kind: "create",
    });
    expect(artifactCandidates.map((c) => c.id)).toContain(
      COMPOSER_AFTER_SEARCH_AFFORDANCE_ENTRY.id,
    );

    const sessionCandidates = registry.findByFamily(WEB_RESEARCH_EFFECT_FAMILY, sessionTarget, {
      kind: "create",
    });
    expect(sessionCandidates.map((c) => c.id)).not.toContain(
      COMPOSER_AFTER_SEARCH_AFFORDANCE_ENTRY.id,
    );
  });

  it("declares the web_evidence_present precondition only on the composer affordance", () => {
    expect(PERPLEXITY_SEARCH_SPECIALIST_AFFORDANCE_ENTRY.requiredPreconditions).toEqual([]);
    expect(COMPOSER_AFTER_SEARCH_AFFORDANCE_ENTRY.requiredPreconditions).toEqual([
      WEB_EVIDENCE_PRESENT_PRECONDITION,
    ]);
  });

  it("rejects observe and update operations under web_research (create-only family)", () => {
    const registry = createAffordanceRegistry();

    expect(
      registry.findByFamily(
        WEB_RESEARCH_EFFECT_FAMILY,
        { kind: "external_channel", channelId: "telegram" as ChannelId },
        { kind: "observe" },
      ),
    ).toEqual([]);
    expect(
      registry.findByFamily(
        WEB_RESEARCH_EFFECT_FAMILY,
        { kind: "external_channel", channelId: "telegram" as ChannelId },
        { kind: "update" },
      ),
    ).toEqual([]);
  });

  it("Phase 4b: both predicates read state-after — empty state yields web_evidence.slice_absent on both", () => {
    const emptyState: WorldStateSnapshot = Object.freeze({});
    const emptyDelta: ExpectedDelta = Object.freeze({});
    const ctx = {
      stateBefore: emptyState,
      stateAfter: emptyState,
      expectedDelta: emptyDelta,
      receipts: { entries: [] },
      trace: { steps: [] },
    } as const;

    const searchResult = PERPLEXITY_SEARCH_SPECIALIST_AFFORDANCE_ENTRY.donePredicate(ctx);
    expect(searchResult.satisfied).toBe(false);
    expect(searchResult.satisfied === false ? searchResult.missing : []).toEqual([
      "web_evidence.slice_absent",
    ]);

    const composerResult = COMPOSER_AFTER_SEARCH_AFFORDANCE_ENTRY.donePredicate(ctx);
    expect(composerResult.satisfied).toBe(false);
    expect(composerResult.satisfied === false ? composerResult.missing : []).toEqual([
      "web_evidence.slice_absent",
    ]);
  });

  it("does not contaminate other family lookups (web_research entries do not appear under communication or persistent_session)", () => {
    const registry = createAffordanceRegistry();
    const channelTarget = {
      kind: "external_channel",
      channelId: "telegram" as ChannelId,
    } as const;

    const communicationCreate = registry
      .findByFamily(COMMUNICATION_EFFECT_FAMILY, channelTarget, { kind: "create" })
      .map((c) => c.id);
    expect(communicationCreate).not.toContain(PERPLEXITY_SEARCH_SPECIALIST_AFFORDANCE_ENTRY.id);
    expect(communicationCreate).not.toContain(COMPOSER_AFTER_SEARCH_AFFORDANCE_ENTRY.id);

    const persistentCreate = registry
      .findByFamily(PERSISTENT_SESSION_EFFECT_FAMILY, { kind: "session" }, { kind: "create" })
      .map((c) => c.id);
    expect(persistentCreate).not.toContain(PERPLEXITY_SEARCH_SPECIALIST_AFFORDANCE_ENTRY.id);
    expect(persistentCreate).not.toContain(COMPOSER_AFTER_SEARCH_AFFORDANCE_ENTRY.id);
  });
});
