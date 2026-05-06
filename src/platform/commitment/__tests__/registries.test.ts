import { describe, expect, it } from "vitest";
import {
  ANSWER_DELIVERED_AFFORDANCE_ENTRY,
  ARTIFACT_EFFECT_FAMILY,
  BRANCH_NAME_VALID_PRECONDITION,
  CLARIFICATION_REQUESTED_AFFORDANCE_ENTRY,
  CODE_PATCH_APPLIED_AFFORDANCE_ENTRY,
  COMMUNICATION_EFFECT_FAMILY,
  COMPOSER_AFTER_SEARCH_AFFORDANCE_ENTRY,
  DOCX_CREATED_AFFORDANCE_ENTRY,
  EFFECT_FAMILY_REGISTRY,
  EXTERNAL_EFFECT_PERFORMED_AFFORDANCE_ENTRY,
  IMAGE_CREATED_AFFORDANCE_ENTRY,
  IMAGE_GENERATION_PROVIDER_AVAILABLE_PRECONDITION,
  INBOUND_IMAGE_REFERENCE_AVAILABLE_PRECONDITION,
  PDF_CREATED_AFFORDANCE_ENTRY,
  PDF_RENDERER_AVAILABLE_PRECONDITION,
  PERPLEXITY_SEARCH_SPECIALIST_AFFORDANCE_ENTRY,
  PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
  PERSISTENT_SESSION_EFFECT_FAMILY,
  REPO_BRANCH_CREATED_AFFORDANCE_ENTRY,
  REPO_COMMIT_LANDED_AFFORDANCE_ENTRY,
  REPO_DIFF_OBSERVED_AFFORDANCE_ENTRY,
  REPO_EFFECT_FAMILY,
  REPO_MERGE_COMPLETED_AFFORDANCE_ENTRY,
  REPO_ROOT_AVAILABLE_PRECONDITION,
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
  it("includes persistent_session, communication (PR-4b), web_research (search-composer), unknown, artifact (cutover-3 phase 2), and repo (cutover-4 phase 2) families", () => {
    expect(EFFECT_FAMILY_REGISTRY.map((entry) => entry.id)).toEqual([
      "persistent_session",
      "communication",
      "web_research",
      "unknown",
      "artifact",
      "repo",
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
  it("registers Wave A persistent-session + Wave B chat-effect + Search-Composer Phase 2 web_research + cutover-3 Phase 4 artifact + cutover-4 Phase 4 repo affordances", () => {
    const registry = createAffordanceRegistry();
    expect(registry.all()).toEqual([
      PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
      ANSWER_DELIVERED_AFFORDANCE_ENTRY,
      CLARIFICATION_REQUESTED_AFFORDANCE_ENTRY,
      EXTERNAL_EFFECT_PERFORMED_AFFORDANCE_ENTRY,
      PERPLEXITY_SEARCH_SPECIALIST_AFFORDANCE_ENTRY,
      COMPOSER_AFTER_SEARCH_AFFORDANCE_ENTRY,
      PDF_CREATED_AFFORDANCE_ENTRY,
      DOCX_CREATED_AFFORDANCE_ENTRY,
      CODE_PATCH_APPLIED_AFFORDANCE_ENTRY,
      IMAGE_CREATED_AFFORDANCE_ENTRY,
      REPO_BRANCH_CREATED_AFFORDANCE_ENTRY,
      REPO_COMMIT_LANDED_AFFORDANCE_ENTRY,
      REPO_MERGE_COMPLETED_AFFORDANCE_ENTRY,
      REPO_DIFF_OBSERVED_AFFORDANCE_ENTRY,
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
    expect(createAffordanceRegistry().all()).toHaveLength(14);
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

describe("affordance registry — artifact family (cutover-3 Phase 4)", () => {
  it("registers all four cutover-3 affordances under the artifact effect-family", () => {
    expect(PDF_CREATED_AFFORDANCE_ENTRY.effectFamily).toBe(ARTIFACT_EFFECT_FAMILY);
    expect(DOCX_CREATED_AFFORDANCE_ENTRY.effectFamily).toBe(ARTIFACT_EFFECT_FAMILY);
    expect(CODE_PATCH_APPLIED_AFFORDANCE_ENTRY.effectFamily).toBe(ARTIFACT_EFFECT_FAMILY);
    expect(IMAGE_CREATED_AFFORDANCE_ENTRY.effectFamily).toBe(ARTIFACT_EFFECT_FAMILY);

    expect(PDF_CREATED_AFFORDANCE_ENTRY.effect).toBe("pdf.created");
    expect(DOCX_CREATED_AFFORDANCE_ENTRY.effect).toBe("docx.created");
    expect(CODE_PATCH_APPLIED_AFFORDANCE_ENTRY.effect).toBe("code_patch.applied");
    expect(IMAGE_CREATED_AFFORDANCE_ENTRY.effect).toBe("image.created");
  });

  it("declares three new precondition ids that are pairwise distinct and distinct from web_evidence_present", () => {
    const ids = new Set<string>([
      PDF_RENDERER_AVAILABLE_PRECONDITION,
      IMAGE_GENERATION_PROVIDER_AVAILABLE_PRECONDITION,
      INBOUND_IMAGE_REFERENCE_AVAILABLE_PRECONDITION,
      WEB_EVIDENCE_PRESENT_PRECONDITION,
    ]);
    expect(ids.size).toBe(4);

    expect(PDF_RENDERER_AVAILABLE_PRECONDITION).toBe("pdf_renderer_available");
    expect(IMAGE_GENERATION_PROVIDER_AVAILABLE_PRECONDITION).toBe(
      "image_generation_provider_available",
    );
    expect(INBOUND_IMAGE_REFERENCE_AVAILABLE_PRECONDITION).toBe(
      "inbound_image_reference_available",
    );
  });

  it("attaches preconditions per affordance per cutover-3 spec (pdf has renderer; image has provider; docx and code-patch have none)", () => {
    expect(PDF_CREATED_AFFORDANCE_ENTRY.requiredPreconditions).toEqual([
      PDF_RENDERER_AVAILABLE_PRECONDITION,
    ]);
    expect(DOCX_CREATED_AFFORDANCE_ENTRY.requiredPreconditions).toEqual([]);
    expect(CODE_PATCH_APPLIED_AFFORDANCE_ENTRY.requiredPreconditions).toEqual([]);
    expect(IMAGE_CREATED_AFFORDANCE_ENTRY.requiredPreconditions).toEqual([
      IMAGE_GENERATION_PROVIDER_AVAILABLE_PRECONDITION,
    ]);
    // INBOUND_IMAGE_REFERENCE_AVAILABLE_PRECONDITION is OPTIONAL — selected
    // at Phase 6 when img2img is detected; not declared on the static
    // affordance so from-scratch generation still resolves.
    expect(IMAGE_CREATED_AFFORDANCE_ENTRY.requiredPreconditions).not.toContain(
      INBOUND_IMAGE_REFERENCE_AVAILABLE_PRECONDITION,
    );
  });

  it("declares the per-spec budget envelopes per affordance", () => {
    expect(PDF_CREATED_AFFORDANCE_ENTRY.defaultBudgets).toEqual({
      maxLatencyMs: 120_000,
      maxRetries: 1,
    });
    expect(DOCX_CREATED_AFFORDANCE_ENTRY.defaultBudgets).toEqual({
      maxLatencyMs: 90_000,
      maxRetries: 1,
    });
    expect(CODE_PATCH_APPLIED_AFFORDANCE_ENTRY.defaultBudgets).toEqual({
      maxLatencyMs: 60_000,
      maxRetries: 0,
    });
    expect(IMAGE_CREATED_AFFORDANCE_ENTRY.defaultBudgets).toEqual({
      maxLatencyMs: 60_000,
      maxRetries: 1,
    });
  });

  it("flags code_patch as medium risk-tier (workspace mutation); pdf/docx/image stay low", () => {
    expect(PDF_CREATED_AFFORDANCE_ENTRY.riskTier).toBe("low");
    expect(DOCX_CREATED_AFFORDANCE_ENTRY.riskTier).toBe("low");
    expect(IMAGE_CREATED_AFFORDANCE_ENTRY.riskTier).toBe("low");
    expect(CODE_PATCH_APPLIED_AFFORDANCE_ENTRY.riskTier).toBe("medium");
  });

  it("declares the per-spec allowedConstraintKeys per affordance", () => {
    expect([...PDF_CREATED_AFFORDANCE_ENTRY.allowedConstraintKeys]).toEqual([
      "sourcePaths",
      "templatePath",
      "language",
      "pageCount",
    ]);
    expect([...DOCX_CREATED_AFFORDANCE_ENTRY.allowedConstraintKeys]).toEqual([
      "templatePath",
      "variables",
      "language",
    ]);
    expect([...CODE_PATCH_APPLIED_AFFORDANCE_ENTRY.allowedConstraintKeys]).toEqual([
      "workspaceId",
      "patchSizeLimit",
    ]);
    expect([...IMAGE_CREATED_AFFORDANCE_ENTRY.allowedConstraintKeys]).toEqual([
      "sourcePaths",
      "size",
      "aspectRatio",
      "resolution",
      "style",
      "count",
      "referenceMode",
    ]);
  });

  it("routes all four artifact affordances through the artifact_world_state observer", () => {
    expect(PDF_CREATED_AFFORDANCE_ENTRY.observerHandle.id).toBe("artifact_world_state");
    expect(DOCX_CREATED_AFFORDANCE_ENTRY.observerHandle.id).toBe("artifact_world_state");
    expect(CODE_PATCH_APPLIED_AFFORDANCE_ENTRY.observerHandle.id).toBe(
      "artifact_world_state",
    );
    expect(IMAGE_CREATED_AFFORDANCE_ENTRY.observerHandle.id).toBe("artifact_world_state");
  });

  it("findByFamily(artifact, {kind:'workspace'}, 'update') returns the code-patch affordance only", () => {
    const registry = createAffordanceRegistry();
    const candidates = registry.findByFamily(
      ARTIFACT_EFFECT_FAMILY,
      { kind: "workspace" },
      { kind: "update" },
    );
    expect(candidates.map((c) => c.id)).toEqual([CODE_PATCH_APPLIED_AFFORDANCE_ENTRY.id]);
  });

  it("findByFamily(artifact, {kind:'artifact'}, 'create') returns pdf, docx, and image candidates", () => {
    const registry = createAffordanceRegistry();
    const candidates = registry.findByFamily(
      ARTIFACT_EFFECT_FAMILY,
      { kind: "artifact", artifactId: "art-1" },
      { kind: "create" },
    );
    const ids = candidates.map((c) => c.id);
    expect(ids).toEqual([
      PDF_CREATED_AFFORDANCE_ENTRY.id,
      DOCX_CREATED_AFFORDANCE_ENTRY.id,
      IMAGE_CREATED_AFFORDANCE_ENTRY.id,
    ]);
    // Code-patch only matches workspace target; must NOT appear here.
    expect(ids).not.toContain(CODE_PATCH_APPLIED_AFFORDANCE_ENTRY.id);
  });

  it("findByFamily(artifact, {kind:'workspace'}, 'create') returns pdf, docx, and image (workspace-staged authoring)", () => {
    const registry = createAffordanceRegistry();
    const candidates = registry.findByFamily(
      ARTIFACT_EFFECT_FAMILY,
      { kind: "workspace" },
      { kind: "create" },
    );
    const ids = candidates.map((c) => c.id);
    expect(ids).toEqual([
      PDF_CREATED_AFFORDANCE_ENTRY.id,
      DOCX_CREATED_AFFORDANCE_ENTRY.id,
      IMAGE_CREATED_AFFORDANCE_ENTRY.id,
    ]);
  });

  it("findByFamily(artifact, {kind:'external_channel'}, 'create') returns image only (e.g. Telegram sendPhoto)", () => {
    const registry = createAffordanceRegistry();
    const candidates = registry.findByFamily(
      ARTIFACT_EFFECT_FAMILY,
      { kind: "external_channel", channelId: "telegram" as ChannelId },
      { kind: "create" },
    );
    expect(candidates.map((c) => c.id)).toEqual([IMAGE_CREATED_AFFORDANCE_ENTRY.id]);
  });

  it("findByFamily(artifact, {kind:'session'}, 'create') resolves nothing (artifact family rejects session targets)", () => {
    const registry = createAffordanceRegistry();
    expect(
      registry.findByFamily(
        ARTIFACT_EFFECT_FAMILY,
        { kind: "session" },
        { kind: "create" },
      ),
    ).toEqual([]);
  });

  it("preserves the cutover-2 G6.a structural canary — branching factor on artifact family > 1", () => {
    const registry = createAffordanceRegistry();
    const allArtifactCandidates = registry
      .all()
      .filter((entry) => entry.effectFamily === ARTIFACT_EFFECT_FAMILY);
    expect(allArtifactCandidates.length).toBeGreaterThan(1);
    expect(allArtifactCandidates.length).toBe(4);
  });

  it("does not contaminate other family lookups (artifact entries do not appear under communication or persistent_session)", () => {
    const registry = createAffordanceRegistry();
    const channelTarget = {
      kind: "external_channel",
      channelId: "telegram" as ChannelId,
    } as const;

    const communicationCreate = registry
      .findByFamily(COMMUNICATION_EFFECT_FAMILY, channelTarget, { kind: "create" })
      .map((c) => c.id);
    expect(communicationCreate).not.toContain(PDF_CREATED_AFFORDANCE_ENTRY.id);
    expect(communicationCreate).not.toContain(DOCX_CREATED_AFFORDANCE_ENTRY.id);
    expect(communicationCreate).not.toContain(IMAGE_CREATED_AFFORDANCE_ENTRY.id);
    expect(communicationCreate).not.toContain(CODE_PATCH_APPLIED_AFFORDANCE_ENTRY.id);

    const persistentCreate = registry
      .findByFamily(PERSISTENT_SESSION_EFFECT_FAMILY, { kind: "session" }, { kind: "create" })
      .map((c) => c.id);
    expect(persistentCreate).not.toContain(PDF_CREATED_AFFORDANCE_ENTRY.id);
    expect(persistentCreate).not.toContain(DOCX_CREATED_AFFORDANCE_ENTRY.id);
    expect(persistentCreate).not.toContain(IMAGE_CREATED_AFFORDANCE_ENTRY.id);
    expect(persistentCreate).not.toContain(CODE_PATCH_APPLIED_AFFORDANCE_ENTRY.id);
  });

  it("does not resolve update operation on pdf/docx/image (only code_patch supports update)", () => {
    const registry = createAffordanceRegistry();
    const candidates = registry.findByFamily(
      ARTIFACT_EFFECT_FAMILY,
      { kind: "artifact", artifactId: "art-1" },
      { kind: "update" },
    );
    expect(candidates).toEqual([]);
  });
});

describe("affordance registry — repo family (cutover-4 Phase 4)", () => {
  it("registers all four cutover-4 affordances under the repo effect-family", () => {
    expect(REPO_BRANCH_CREATED_AFFORDANCE_ENTRY.effectFamily).toBe(REPO_EFFECT_FAMILY);
    expect(REPO_COMMIT_LANDED_AFFORDANCE_ENTRY.effectFamily).toBe(REPO_EFFECT_FAMILY);
    expect(REPO_MERGE_COMPLETED_AFFORDANCE_ENTRY.effectFamily).toBe(REPO_EFFECT_FAMILY);
    expect(REPO_DIFF_OBSERVED_AFFORDANCE_ENTRY.effectFamily).toBe(REPO_EFFECT_FAMILY);

    expect(REPO_BRANCH_CREATED_AFFORDANCE_ENTRY.effect).toBe("repo.branch_created");
    expect(REPO_COMMIT_LANDED_AFFORDANCE_ENTRY.effect).toBe("repo.commit_landed");
    expect(REPO_MERGE_COMPLETED_AFFORDANCE_ENTRY.effect).toBe("repo.merge_completed");
    expect(REPO_DIFF_OBSERVED_AFFORDANCE_ENTRY.effect).toBe("repo.diff_observed");
  });

  it("declares two new precondition ids that are pairwise distinct and distinct from artifact + web_evidence preconditions", () => {
    const ids = new Set<string>([
      REPO_ROOT_AVAILABLE_PRECONDITION,
      BRANCH_NAME_VALID_PRECONDITION,
      PDF_RENDERER_AVAILABLE_PRECONDITION,
      IMAGE_GENERATION_PROVIDER_AVAILABLE_PRECONDITION,
      INBOUND_IMAGE_REFERENCE_AVAILABLE_PRECONDITION,
      WEB_EVIDENCE_PRESENT_PRECONDITION,
    ]);
    expect(ids.size).toBe(6);

    expect(REPO_ROOT_AVAILABLE_PRECONDITION).toBe("repo_root_available");
    expect(BRANCH_NAME_VALID_PRECONDITION).toBe("branch_name_valid");
  });

  it("attaches preconditions per affordance per cutover-4 spec (branch needs repo-root + branch-name; commit/merge/diff need repo-root only)", () => {
    expect(REPO_BRANCH_CREATED_AFFORDANCE_ENTRY.requiredPreconditions).toEqual([
      REPO_ROOT_AVAILABLE_PRECONDITION,
      BRANCH_NAME_VALID_PRECONDITION,
    ]);
    expect(REPO_COMMIT_LANDED_AFFORDANCE_ENTRY.requiredPreconditions).toEqual([
      REPO_ROOT_AVAILABLE_PRECONDITION,
    ]);
    expect(REPO_MERGE_COMPLETED_AFFORDANCE_ENTRY.requiredPreconditions).toEqual([
      REPO_ROOT_AVAILABLE_PRECONDITION,
    ]);
    expect(REPO_DIFF_OBSERVED_AFFORDANCE_ENTRY.requiredPreconditions).toEqual([
      REPO_ROOT_AVAILABLE_PRECONDITION,
    ]);
  });

  it("declares the per-spec budget envelopes per affordance (mutations zero retries; diff one retry)", () => {
    expect(REPO_BRANCH_CREATED_AFFORDANCE_ENTRY.defaultBudgets).toEqual({
      maxLatencyMs: 30_000,
      maxRetries: 0,
    });
    expect(REPO_COMMIT_LANDED_AFFORDANCE_ENTRY.defaultBudgets).toEqual({
      maxLatencyMs: 60_000,
      maxRetries: 0,
    });
    expect(REPO_MERGE_COMPLETED_AFFORDANCE_ENTRY.defaultBudgets).toEqual({
      maxLatencyMs: 120_000,
      maxRetries: 0,
    });
    expect(REPO_DIFF_OBSERVED_AFFORDANCE_ENTRY.defaultBudgets).toEqual({
      maxLatencyMs: 15_000,
      maxRetries: 1,
    });
  });

  it("flags merge as high risk-tier; branch + commit medium; diff low (read-only)", () => {
    expect(REPO_BRANCH_CREATED_AFFORDANCE_ENTRY.riskTier).toBe("medium");
    expect(REPO_COMMIT_LANDED_AFFORDANCE_ENTRY.riskTier).toBe("medium");
    expect(REPO_MERGE_COMPLETED_AFFORDANCE_ENTRY.riskTier).toBe("high");
    expect(REPO_DIFF_OBSERVED_AFFORDANCE_ENTRY.riskTier).toBe("low");
  });

  it("declares the per-spec allowedConstraintKeys per affordance", () => {
    expect([...REPO_BRANCH_CREATED_AFFORDANCE_ENTRY.allowedConstraintKeys]).toEqual([
      "branchName",
      "baseRef",
      "checkoutAfterCreate",
    ]);
    expect([...REPO_COMMIT_LANDED_AFFORDANCE_ENTRY.allowedConstraintKeys]).toEqual([
      "commitMessage",
      "filesIncluded",
      "signedOff",
      "author",
    ]);
    expect([...REPO_MERGE_COMPLETED_AFFORDANCE_ENTRY.allowedConstraintKeys]).toEqual([
      "sourceBranch",
      "targetBranch",
      "strategy",
      "fastForward",
      "squash",
    ]);
    expect([...REPO_DIFF_OBSERVED_AFFORDANCE_ENTRY.allowedConstraintKeys]).toEqual([
      "baseRef",
      "headRef",
      "pathFilter",
      "includeStatus",
    ]);
  });

  it("routes all four repo affordances through the repo_world_state observer", () => {
    expect(REPO_BRANCH_CREATED_AFFORDANCE_ENTRY.observerHandle.id).toBe("repo_world_state");
    expect(REPO_COMMIT_LANDED_AFFORDANCE_ENTRY.observerHandle.id).toBe("repo_world_state");
    expect(REPO_MERGE_COMPLETED_AFFORDANCE_ENTRY.observerHandle.id).toBe("repo_world_state");
    expect(REPO_DIFF_OBSERVED_AFFORDANCE_ENTRY.observerHandle.id).toBe("repo_world_state");
  });

  it("declares 'repo.completed' as the mandatory required evidence kind on every repo affordance", () => {
    for (const entry of [
      REPO_BRANCH_CREATED_AFFORDANCE_ENTRY,
      REPO_COMMIT_LANDED_AFFORDANCE_ENTRY,
      REPO_MERGE_COMPLETED_AFFORDANCE_ENTRY,
      REPO_DIFF_OBSERVED_AFFORDANCE_ENTRY,
    ]) {
      expect(entry.requiredEvidence).toEqual([
        { kind: "repo.completed", mandatory: true },
      ]);
    }
  });

  it("findByFamily(repo, {kind:'workspace'}, 'create') returns the branch_created affordance only", () => {
    const registry = createAffordanceRegistry();
    const candidates = registry.findByFamily(
      REPO_EFFECT_FAMILY,
      { kind: "workspace" },
      { kind: "create" },
    );
    expect(candidates.map((c) => c.id)).toEqual([REPO_BRANCH_CREATED_AFFORDANCE_ENTRY.id]);
  });

  it("findByFamily(repo, {kind:'workspace'}, 'update') returns commit_landed and merge_completed (branching factor > 1)", () => {
    const registry = createAffordanceRegistry();
    const candidates = registry.findByFamily(
      REPO_EFFECT_FAMILY,
      { kind: "workspace" },
      { kind: "update" },
    );
    const ids = candidates.map((c) => c.id);
    expect(ids).toEqual([
      REPO_COMMIT_LANDED_AFFORDANCE_ENTRY.id,
      REPO_MERGE_COMPLETED_AFFORDANCE_ENTRY.id,
    ]);
    expect(ids.length).toBeGreaterThan(1);
  });

  it("findByFamily(repo, {kind:'workspace'}, 'observe') returns diff_observed only", () => {
    const registry = createAffordanceRegistry();
    const candidates = registry.findByFamily(
      REPO_EFFECT_FAMILY,
      { kind: "workspace" },
      { kind: "observe" },
    );
    expect(candidates.map((c) => c.id)).toEqual([REPO_DIFF_OBSERVED_AFFORDANCE_ENTRY.id]);
  });

  it("findByFamily(repo, {kind:'unspecified'}, 'observe') returns diff_observed only (read-only target widening)", () => {
    const registry = createAffordanceRegistry();
    const candidates = registry.findByFamily(
      REPO_EFFECT_FAMILY,
      { kind: "unspecified" },
      { kind: "observe" },
    );
    expect(candidates.map((c) => c.id)).toEqual([REPO_DIFF_OBSERVED_AFFORDANCE_ENTRY.id]);
  });

  it("findByFamily(repo, {kind:'unspecified'}, 'create') resolves nothing (branch_created requires workspace)", () => {
    const registry = createAffordanceRegistry();
    expect(
      registry.findByFamily(
        REPO_EFFECT_FAMILY,
        { kind: "unspecified" },
        { kind: "create" },
      ),
    ).toEqual([]);
  });

  it("findByFamily(repo, {kind:'session'}, 'create') resolves nothing (repo family rejects session targets)", () => {
    const registry = createAffordanceRegistry();
    expect(
      registry.findByFamily(
        REPO_EFFECT_FAMILY,
        { kind: "session" },
        { kind: "create" },
      ),
    ).toEqual([]);
  });

  it("findByFamily(repo, {kind:'artifact'}, 'create') resolves nothing (repo family rejects artifact targets)", () => {
    const registry = createAffordanceRegistry();
    expect(
      registry.findByFamily(
        REPO_EFFECT_FAMILY,
        { kind: "artifact", artifactId: "art-1" },
        { kind: "create" },
      ),
    ).toEqual([]);
  });

  it("findByFamily(repo, {kind:'external_channel'}, 'observe') resolves nothing (repo family rejects channel targets)", () => {
    const registry = createAffordanceRegistry();
    expect(
      registry.findByFamily(
        REPO_EFFECT_FAMILY,
        { kind: "external_channel", channelId: "telegram" as ChannelId },
        { kind: "observe" },
      ),
    ).toEqual([]);
  });

  it("preserves the cutover-2 G6.a structural canary — branching factor on repo family > 1", () => {
    const registry = createAffordanceRegistry();
    const allRepoCandidates = registry
      .all()
      .filter((entry) => entry.effectFamily === REPO_EFFECT_FAMILY);
    expect(allRepoCandidates.length).toBeGreaterThan(1);
    expect(allRepoCandidates.length).toBe(4);
  });

  it("does not contaminate other family lookups (repo entries do not appear under communication, persistent_session, or artifact)", () => {
    const registry = createAffordanceRegistry();
    const channelTarget = {
      kind: "external_channel",
      channelId: "telegram" as ChannelId,
    } as const;

    const communicationCreate = registry
      .findByFamily(COMMUNICATION_EFFECT_FAMILY, channelTarget, { kind: "create" })
      .map((c) => c.id);
    expect(communicationCreate).not.toContain(REPO_BRANCH_CREATED_AFFORDANCE_ENTRY.id);
    expect(communicationCreate).not.toContain(REPO_COMMIT_LANDED_AFFORDANCE_ENTRY.id);
    expect(communicationCreate).not.toContain(REPO_MERGE_COMPLETED_AFFORDANCE_ENTRY.id);
    expect(communicationCreate).not.toContain(REPO_DIFF_OBSERVED_AFFORDANCE_ENTRY.id);

    const persistentCreate = registry
      .findByFamily(PERSISTENT_SESSION_EFFECT_FAMILY, { kind: "session" }, { kind: "create" })
      .map((c) => c.id);
    expect(persistentCreate).not.toContain(REPO_BRANCH_CREATED_AFFORDANCE_ENTRY.id);
    expect(persistentCreate).not.toContain(REPO_COMMIT_LANDED_AFFORDANCE_ENTRY.id);
    expect(persistentCreate).not.toContain(REPO_MERGE_COMPLETED_AFFORDANCE_ENTRY.id);
    expect(persistentCreate).not.toContain(REPO_DIFF_OBSERVED_AFFORDANCE_ENTRY.id);

    const artifactCreate = registry
      .findByFamily(ARTIFACT_EFFECT_FAMILY, { kind: "workspace" }, { kind: "update" })
      .map((c) => c.id);
    expect(artifactCreate).not.toContain(REPO_COMMIT_LANDED_AFFORDANCE_ENTRY.id);
    expect(artifactCreate).not.toContain(REPO_MERGE_COMPLETED_AFFORDANCE_ENTRY.id);
  });

  it("does not resolve cancel operation on any repo affordance (Phase 5 lights only create/observe/update emit-sites)", () => {
    const registry = createAffordanceRegistry();
    const candidates = registry.findByFamily(
      REPO_EFFECT_FAMILY,
      { kind: "workspace" },
      { kind: "cancel" },
    );
    expect(candidates).toEqual([]);
  });
});
