import type { Affordance } from "./affordance.js";
import { codePatchAppliedPredicate } from "./done-predicate-code-patch-applied.js";
import {
  answerDeliveredPredicate,
  clarificationRequestedPredicate,
  externalEffectPerformedPredicate,
} from "./done-predicate-delivery.js";
import { docxCreatedPredicate } from "./done-predicate-docx-created.js";
import { imageCreatedPredicate } from "./done-predicate-image-created.js";
import { pdfCreatedPredicate } from "./done-predicate-pdf-created.js";
import { reminderDeliveredPredicate } from "./done-predicate-reminder-delivered.js";
import { reminderSetPredicate } from "./done-predicate-reminder-set.js";
import { repoBranchCreatedPredicate } from "./done-predicate-repo-branch-created.js";
import { repoCommitLandedPredicate } from "./done-predicate-repo-commit-landed.js";
import { repoDiffObservedPredicate } from "./done-predicate-repo-diff-observed.js";
import { repoMergeCompletedPredicate } from "./done-predicate-repo-merge-completed.js";
import type { CommitmentTarget } from "./execution-commitment.js";
import type { AffordanceId, EffectFamilyId, EffectId, PreconditionId } from "./ids.js";
import {
  ARTIFACT_EFFECT_FAMILY,
  CODE_PATCH_APPLIED_EFFECT,
  COMMUNICATION_EFFECT_FAMILY,
  DOCX_CREATED_EFFECT,
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
  WEB_EVIDENCE_COLLECTED_EFFECT,
  WEB_RESEARCH_EFFECT_FAMILY,
  WEB_RESEARCH_SUMMARIZED_EFFECT,
} from "./effect-family-registry.js";
import { persistentSessionCreatedPredicate } from "./done-predicate-persistent-session.js";
import { webEvidenceCollectedPredicate } from "./done-predicate-web-evidence-collected.js";
import { webResearchSummarizedPredicate } from "./done-predicate-web-research-summarized.js";
import type { OperationHint, TargetRef } from "./semantic-intent.js";

export type RegisteredAffordance = Affordance & {
  readonly effectFamily: EffectFamilyId;
  readonly operationKinds: readonly OperationHint["kind"][];
};

export type AffordanceRegistry = {
  /**
   * Returns every registered affordance entry.
   *
   * @returns Read-only affordance list.
   */
  all(): readonly RegisteredAffordance[];

  /**
   * Finds affordance candidates for semantic effect-family resolution.
   *
   * @param familyId - Semantic effect family from `IntentContractor`.
   * @param target - Semantic target from `IntentContractor`.
   * @param operation - Optional semantic operation hint.
   * @returns Matching affordance candidates; may be empty or contain several entries.
   */
  findByFamily(
    familyId: EffectFamilyId,
    target: TargetRef,
    operation?: OperationHint,
  ): readonly RegisteredAffordance[];
};

const PERSISTENT_SESSION_CREATED_EFFECT = "persistent_session.created" as EffectId;
const PERSISTENT_SESSION_CREATED_AFFORDANCE =
  "persistent_session.created" as AffordanceId;

/**
 * Matches the narrow target space for the PR-2 persistent-session affordance.
 *
 * @param target - Commitment target candidate.
 * @returns True for session-specific or unspecified targets.
 */
function matchesPersistentSessionTarget(target: CommitmentTarget): boolean {
  return target.kind === "session" || target.kind === "unspecified";
}

export const PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY = Object.freeze({
  id: PERSISTENT_SESSION_CREATED_AFFORDANCE,
  effectFamily: PERSISTENT_SESSION_EFFECT_FAMILY,
  effect: PERSISTENT_SESSION_CREATED_EFFECT,
  operationKinds: Object.freeze(["create"] satisfies OperationHint["kind"][]),
  target: matchesPersistentSessionTarget,
  requiredPreconditions: Object.freeze([]),
  requiredEvidence: Object.freeze([
    Object.freeze({ kind: "session_record.created", mandatory: true }),
  ]),
  allowedConstraintKeys: Object.freeze([
    "displayName",
    "description",
    "parentSessionKey",
  ]),
  riskTier: "low",
  defaultBudgets: Object.freeze({
    maxLatencyMs: 30_000,
    maxRetries: 0,
  }),
  observerHandle: Object.freeze({ id: "session_world_state" }),
  donePredicate: persistentSessionCreatedPredicate,
} satisfies RegisteredAffordance);

const ANSWER_DELIVERED_EFFECT = "answer.delivered" as EffectId;
const ANSWER_DELIVERED_AFFORDANCE = "answer.delivered" as AffordanceId;

const CLARIFICATION_REQUESTED_EFFECT = "clarification_requested" as EffectId;
const CLARIFICATION_REQUESTED_AFFORDANCE = "clarification_requested" as AffordanceId;

const EXTERNAL_EFFECT_PERFORMED_EFFECT = "external_effect.performed" as EffectId;
const EXTERNAL_EFFECT_PERFORMED_AFFORDANCE = "external_effect.performed" as AffordanceId;

/**
 * Matches the active dialog target for a final answer delivery. The
 * IntentContractor emits `external_channel` once a delivery target is bound;
 * unresolved channel targets stay in `clarification_requested` (which uses
 * `unspecified`) so this affordance does not collide with it.
 *
 * @param target - Commitment target candidate.
 * @returns True only for `external_channel` targets.
 */
function matchesAnswerDeliveredTarget(target: CommitmentTarget): boolean {
  return target.kind === "external_channel";
}

/**
 * Matches a clarification request that does not yet have a bound delivery
 * target. Clarifications are routed to the channel of the originating turn at
 * runtime; affordance selection only requires an `unspecified` semantic target.
 *
 * @param target - Commitment target candidate.
 * @returns True for the unspecified target only.
 */
function matchesClarificationRequestedTarget(target: CommitmentTarget): boolean {
  return target.kind === "unspecified";
}

/**
 * Matches a non-chat external effect whose target is a specific external
 * channel (notification, side-effect receipt, etc.).
 *
 * @param target - Commitment target candidate.
 * @returns True for `external_channel` targets only.
 */
function matchesExternalEffectPerformedTarget(target: CommitmentTarget): boolean {
  return target.kind === "external_channel";
}

export const ANSWER_DELIVERED_AFFORDANCE_ENTRY = Object.freeze({
  id: ANSWER_DELIVERED_AFFORDANCE,
  effectFamily: COMMUNICATION_EFFECT_FAMILY,
  effect: ANSWER_DELIVERED_EFFECT,
  operationKinds: Object.freeze(["create"] satisfies OperationHint["kind"][]),
  target: matchesAnswerDeliveredTarget,
  requiredPreconditions: Object.freeze([]),
  requiredEvidence: Object.freeze([
    Object.freeze({ kind: "answer.delivered", mandatory: true }),
  ]),
  allowedConstraintKeys: Object.freeze(["deliveryContextKey", "channelId"]),
  riskTier: "low",
  defaultBudgets: Object.freeze({
    maxLatencyMs: 30_000,
    maxRetries: 0,
  }),
  observerHandle: Object.freeze({ id: "delivery_world_state" }),
  donePredicate: answerDeliveredPredicate,
} satisfies RegisteredAffordance);

export const CLARIFICATION_REQUESTED_AFFORDANCE_ENTRY = Object.freeze({
  id: CLARIFICATION_REQUESTED_AFFORDANCE,
  effectFamily: COMMUNICATION_EFFECT_FAMILY,
  effect: CLARIFICATION_REQUESTED_EFFECT,
  operationKinds: Object.freeze(["create"] satisfies OperationHint["kind"][]),
  target: matchesClarificationRequestedTarget,
  requiredPreconditions: Object.freeze([]),
  requiredEvidence: Object.freeze([
    Object.freeze({ kind: "clarification.delivered", mandatory: true }),
  ]),
  allowedConstraintKeys: Object.freeze(["deliveryContextKey", "channelId"]),
  riskTier: "low",
  defaultBudgets: Object.freeze({
    maxLatencyMs: 30_000,
    maxRetries: 0,
  }),
  observerHandle: Object.freeze({ id: "delivery_world_state" }),
  donePredicate: clarificationRequestedPredicate,
} satisfies RegisteredAffordance);

export const EXTERNAL_EFFECT_PERFORMED_AFFORDANCE_ENTRY = Object.freeze({
  id: EXTERNAL_EFFECT_PERFORMED_AFFORDANCE,
  effectFamily: COMMUNICATION_EFFECT_FAMILY,
  effect: EXTERNAL_EFFECT_PERFORMED_EFFECT,
  operationKinds: Object.freeze(["observe"] satisfies OperationHint["kind"][]),
  target: matchesExternalEffectPerformedTarget,
  requiredPreconditions: Object.freeze([]),
  requiredEvidence: Object.freeze([
    Object.freeze({ kind: "external_effect.observed", mandatory: true }),
  ]),
  allowedConstraintKeys: Object.freeze(["deliveryContextKey", "channelId"]),
  riskTier: "low",
  defaultBudgets: Object.freeze({
    maxLatencyMs: 30_000,
    maxRetries: 0,
  }),
  observerHandle: Object.freeze({ id: "delivery_world_state" }),
  donePredicate: externalEffectPerformedPredicate,
} satisfies RegisteredAffordance);

const PERPLEXITY_SEARCH_SPECIALIST_AFFORDANCE =
  "perplexity_search_specialist" as AffordanceId;
const COMPOSER_AFTER_SEARCH_AFFORDANCE = "composer_after_search" as AffordanceId;

export const WEB_EVIDENCE_PRESENT_PRECONDITION =
  "web_evidence_present" as PreconditionId;

/**
 * Matches semantic targets that the search specialist can serve. The
 * commitment for a `web_research` turn does not bind a delivery channel
 * yet — the specialist runs against the user query carried via
 * `SemanticIntent`, regardless of whether the eventual answer goes to
 * Telegram, an artifact bucket, or stays unbound until the composer
 * resolves the response surface.
 *
 * @param target - Commitment target candidate.
 * @returns True for `unspecified`, `external_channel`, `artifact`, or `workspace`.
 */
function matchesPerplexitySearchSpecialistTarget(target: CommitmentTarget): boolean {
  return (
    target.kind === "unspecified" ||
    target.kind === "external_channel" ||
    target.kind === "artifact" ||
    target.kind === "workspace"
  );
}

/**
 * Matches semantic targets the composer-after-search affordance can satisfy.
 * The composer ultimately delivers either a text response over an external
 * channel or a structured artifact (PDF / document); both are valid bindings
 * for `web_research.summarized`.
 *
 * @param target - Commitment target candidate.
 * @returns True for `external_channel` or `artifact` only.
 */
function matchesComposerAfterSearchTarget(target: CommitmentTarget): boolean {
  return target.kind === "external_channel" || target.kind === "artifact";
}

export const PERPLEXITY_SEARCH_SPECIALIST_AFFORDANCE_ENTRY = Object.freeze({
  id: PERPLEXITY_SEARCH_SPECIALIST_AFFORDANCE,
  effectFamily: WEB_RESEARCH_EFFECT_FAMILY,
  effect: WEB_EVIDENCE_COLLECTED_EFFECT,
  operationKinds: Object.freeze(["create"] satisfies OperationHint["kind"][]),
  target: matchesPerplexitySearchSpecialistTarget,
  requiredPreconditions: Object.freeze([]),
  requiredEvidence: Object.freeze([
    Object.freeze({ kind: "web_evidence.collected", mandatory: true }),
  ]),
  allowedConstraintKeys: Object.freeze(["queryString", "freshness", "region", "maxRecords"]),
  riskTier: "low",
  defaultBudgets: Object.freeze({
    maxLatencyMs: 30_000,
    maxRetries: 1,
  }),
  observerHandle: Object.freeze({ id: "web_evidence_world_state" }),
  donePredicate: webEvidenceCollectedPredicate,
} satisfies RegisteredAffordance);

export const COMPOSER_AFTER_SEARCH_AFFORDANCE_ENTRY = Object.freeze({
  id: COMPOSER_AFTER_SEARCH_AFFORDANCE,
  effectFamily: WEB_RESEARCH_EFFECT_FAMILY,
  effect: WEB_RESEARCH_SUMMARIZED_EFFECT,
  operationKinds: Object.freeze(["create"] satisfies OperationHint["kind"][]),
  target: matchesComposerAfterSearchTarget,
  requiredPreconditions: Object.freeze([WEB_EVIDENCE_PRESENT_PRECONDITION]),
  requiredEvidence: Object.freeze([
    Object.freeze({ kind: "web_research.summarized", mandatory: true }),
  ]),
  allowedConstraintKeys: Object.freeze([
    "responseFormat",
    "deliveryContextKey",
    "channelId",
    "artifactKind",
  ]),
  riskTier: "low",
  defaultBudgets: Object.freeze({
    maxLatencyMs: 60_000,
    maxRetries: 0,
  }),
  observerHandle: Object.freeze({ id: "delivery_world_state" }),
  donePredicate: webResearchSummarizedPredicate,
} satisfies RegisteredAffordance);

// ─── Cutover-3 Phase 4 — artifact-family affordances + preconditions ───────
//
// Additive registry extension under the `artifact` effect-family registered
// in Phase 2 (`ARTIFACT_EFFECT_FAMILY`). Each entry references one of the
// four `EffectId` constants from `effect-family-registry.ts`; tool→effect
// resolution lives in the Phase 5 runtime adapter
// (`src/agents/pi-embedded-runner/run/artifact-runtime-adapter.ts`), so the
// affordance stays tool-free per invariant #1. Done-predicates read
// `ctx.stateAfter.artifacts?.records` (Phase 3 slice) only — no raw user
// text, no tool surface, no `TaskContract` (invariant #9).

export const PDF_RENDERER_AVAILABLE_PRECONDITION =
  "pdf_renderer_available" as PreconditionId;
export const IMAGE_GENERATION_PROVIDER_AVAILABLE_PRECONDITION =
  "image_generation_provider_available" as PreconditionId;
export const INBOUND_IMAGE_REFERENCE_AVAILABLE_PRECONDITION =
  "inbound_image_reference_available" as PreconditionId;

const PDF_CREATED_AFFORDANCE = "pdf.created" as AffordanceId;
const DOCX_CREATED_AFFORDANCE = "docx.created" as AffordanceId;
const CODE_PATCH_APPLIED_AFFORDANCE = "code_patch.applied" as AffordanceId;
const IMAGE_CREATED_AFFORDANCE = "image.created" as AffordanceId;

/**
 * Matches PDF/DOCX targets — the artifact bucket itself or the workspace
 * (when the document is staged into a workspace folder before delivery).
 *
 * @param target - Commitment target candidate.
 * @returns True for `artifact` or `workspace` targets only.
 */
function matchesPdfDocxTarget(target: CommitmentTarget): boolean {
  return target.kind === "artifact" || target.kind === "workspace";
}

/**
 * Matches the workspace target for code-patch effects. Patches always
 * mutate the workspace tree; artifact-bucket-only targets are not valid
 * for `code_patch.applied`.
 *
 * @param target - Commitment target candidate.
 * @returns True for `workspace` only.
 */
function matchesCodePatchTarget(target: CommitmentTarget): boolean {
  return target.kind === "workspace";
}

/**
 * Matches image-generation targets. The image can settle into the artifact
 * bucket (default), into the workspace (when authored alongside other
 * artifacts), or be delivered directly to an external channel
 * (e.g. Telegram `sendPhoto`).
 *
 * @param target - Commitment target candidate.
 * @returns True for `artifact`, `workspace`, or `external_channel`.
 */
function matchesImageCreatedTarget(target: CommitmentTarget): boolean {
  return (
    target.kind === "artifact" ||
    target.kind === "workspace" ||
    target.kind === "external_channel"
  );
}

export const PDF_CREATED_AFFORDANCE_ENTRY = Object.freeze({
  id: PDF_CREATED_AFFORDANCE,
  effectFamily: ARTIFACT_EFFECT_FAMILY,
  effect: PDF_CREATED_EFFECT,
  operationKinds: Object.freeze(["create"] satisfies OperationHint["kind"][]),
  target: matchesPdfDocxTarget,
  requiredPreconditions: Object.freeze([PDF_RENDERER_AVAILABLE_PRECONDITION]),
  requiredEvidence: Object.freeze([
    Object.freeze({ kind: "artifact.created", mandatory: true }),
  ]),
  allowedConstraintKeys: Object.freeze([
    "sourcePaths",
    "templatePath",
    "language",
    "pageCount",
  ]),
  riskTier: "low",
  defaultBudgets: Object.freeze({
    maxLatencyMs: 120_000,
    maxRetries: 1,
  }),
  observerHandle: Object.freeze({ id: "artifact_world_state" }),
  donePredicate: pdfCreatedPredicate,
} satisfies RegisteredAffordance);

export const DOCX_CREATED_AFFORDANCE_ENTRY = Object.freeze({
  id: DOCX_CREATED_AFFORDANCE,
  effectFamily: ARTIFACT_EFFECT_FAMILY,
  effect: DOCX_CREATED_EFFECT,
  operationKinds: Object.freeze(["create"] satisfies OperationHint["kind"][]),
  target: matchesPdfDocxTarget,
  requiredPreconditions: Object.freeze([]),
  requiredEvidence: Object.freeze([
    Object.freeze({ kind: "artifact.created", mandatory: true }),
  ]),
  allowedConstraintKeys: Object.freeze(["templatePath", "variables", "language"]),
  riskTier: "low",
  defaultBudgets: Object.freeze({
    maxLatencyMs: 90_000,
    maxRetries: 1,
  }),
  observerHandle: Object.freeze({ id: "artifact_world_state" }),
  donePredicate: docxCreatedPredicate,
} satisfies RegisteredAffordance);

export const CODE_PATCH_APPLIED_AFFORDANCE_ENTRY = Object.freeze({
  id: CODE_PATCH_APPLIED_AFFORDANCE,
  effectFamily: ARTIFACT_EFFECT_FAMILY,
  effect: CODE_PATCH_APPLIED_EFFECT,
  operationKinds: Object.freeze(["update"] satisfies OperationHint["kind"][]),
  target: matchesCodePatchTarget,
  requiredPreconditions: Object.freeze([]),
  requiredEvidence: Object.freeze([
    Object.freeze({ kind: "artifact.created", mandatory: true }),
  ]),
  allowedConstraintKeys: Object.freeze(["workspaceId", "patchSizeLimit"]),
  riskTier: "medium",
  defaultBudgets: Object.freeze({
    maxLatencyMs: 60_000,
    maxRetries: 0,
  }),
  observerHandle: Object.freeze({ id: "artifact_world_state" }),
  donePredicate: codePatchAppliedPredicate,
} satisfies RegisteredAffordance);

export const IMAGE_CREATED_AFFORDANCE_ENTRY = Object.freeze({
  id: IMAGE_CREATED_AFFORDANCE,
  effectFamily: ARTIFACT_EFFECT_FAMILY,
  effect: IMAGE_CREATED_EFFECT,
  operationKinds: Object.freeze(["create"] satisfies OperationHint["kind"][]),
  target: matchesImageCreatedTarget,
  // `INBOUND_IMAGE_REFERENCE_AVAILABLE_PRECONDITION` is OPTIONAL and selected
  // at Phase 6 — present when img2img, absent for from-scratch generation.
  // Phase 4 declares only the always-required provider precondition.
  requiredPreconditions: Object.freeze([
    IMAGE_GENERATION_PROVIDER_AVAILABLE_PRECONDITION,
  ]),
  requiredEvidence: Object.freeze([
    Object.freeze({ kind: "artifact.created", mandatory: true }),
  ]),
  allowedConstraintKeys: Object.freeze([
    "sourcePaths",
    "size",
    "aspectRatio",
    "resolution",
    "style",
    "count",
    "referenceMode",
  ]),
  riskTier: "low",
  defaultBudgets: Object.freeze({
    maxLatencyMs: 60_000,
    maxRetries: 1,
  }),
  observerHandle: Object.freeze({ id: "artifact_world_state" }),
  donePredicate: imageCreatedPredicate,
} satisfies RegisteredAffordance);

// ─── Cutover-4 Phase 4 — repo-family affordances + preconditions ───────────
//
// Additive registry extension under the `repo` effect-family registered in
// Phase 2 (`REPO_EFFECT_FAMILY`). Each entry references one of the four
// `EffectId` constants from `effect-family-registry.ts`; tool→effect
// resolution lives in the Phase 5 runtime adapter (`repo-runtime-adapter.ts`),
// so the affordance stays tool-free per invariant #1. Done-predicates read
// `ctx.stateAfter.repo?.records` (Phase 3 slice) only — no raw user text, no
// tool surface, no `TaskContract` (invariant #9).
//
// Risk-tier asymmetry within the family is intentional: `repo.diff_observed`
// is read-only (low) vs `repo.merge_completed` is history-altering on
// protected refs (high). Phase 6 PolicyGate Stage 4 enforces the maintainer
// role on `repo.merge_completed`. `defaultBudgets.maxRetries` is `0` for
// every mutation effect — duplicate branch/commit/partial-merge replays from
// auto-retry are unsafe (audit `extensions/AUDIT-cutover4-repo-operation.md`
// §a). Only the read-only `repo.diff_observed` permits a single retry on
// transient failure.

export const REPO_ROOT_AVAILABLE_PRECONDITION =
  "repo_root_available" as PreconditionId;
export const BRANCH_NAME_VALID_PRECONDITION =
  "branch_name_valid" as PreconditionId;

const REPO_BRANCH_CREATED_AFFORDANCE = "repo.branch_created" as AffordanceId;
const REPO_COMMIT_LANDED_AFFORDANCE = "repo.commit_landed" as AffordanceId;
const REPO_MERGE_COMPLETED_AFFORDANCE = "repo.merge_completed" as AffordanceId;
const REPO_DIFF_OBSERVED_AFFORDANCE = "repo.diff_observed" as AffordanceId;

/**
 * Matches the workspace target for repo-mutating effects (branch / commit /
 * merge). All three operations write to the workspace tree; artifact-bucket
 * or session targets are not valid bindings.
 *
 * @param target - Commitment target candidate.
 * @returns True for `workspace` only.
 */
function matchesRepoMutationTarget(target: CommitmentTarget): boolean {
  return target.kind === "workspace";
}

/**
 * Matches the read-only `repo.diff_observed` target space. Diff turns may be
 * issued without a bound workspace (e.g. "show me the diff" early in a
 * session before the IntentContractor has resolved the workspace target);
 * accepting `unspecified` lets the affordance resolve when the workspace is
 * implicit.
 *
 * @param target - Commitment target candidate.
 * @returns True for `workspace` or `unspecified` only.
 */
function matchesRepoDiffObservedTarget(target: CommitmentTarget): boolean {
  return target.kind === "workspace" || target.kind === "unspecified";
}

export const REPO_BRANCH_CREATED_AFFORDANCE_ENTRY = Object.freeze({
  id: REPO_BRANCH_CREATED_AFFORDANCE,
  effectFamily: REPO_EFFECT_FAMILY,
  effect: REPO_BRANCH_CREATED_EFFECT,
  operationKinds: Object.freeze(["create"] satisfies OperationHint["kind"][]),
  target: matchesRepoMutationTarget,
  requiredPreconditions: Object.freeze([
    REPO_ROOT_AVAILABLE_PRECONDITION,
    BRANCH_NAME_VALID_PRECONDITION,
  ]),
  requiredEvidence: Object.freeze([
    Object.freeze({ kind: "repo.completed", mandatory: true }),
  ]),
  allowedConstraintKeys: Object.freeze([
    "branchName",
    "baseRef",
    "checkoutAfterCreate",
  ]),
  riskTier: "medium",
  defaultBudgets: Object.freeze({
    maxLatencyMs: 30_000,
    maxRetries: 0,
  }),
  observerHandle: Object.freeze({ id: "repo_world_state" }),
  donePredicate: repoBranchCreatedPredicate,
} satisfies RegisteredAffordance);

export const REPO_COMMIT_LANDED_AFFORDANCE_ENTRY = Object.freeze({
  id: REPO_COMMIT_LANDED_AFFORDANCE,
  effectFamily: REPO_EFFECT_FAMILY,
  effect: REPO_COMMIT_LANDED_EFFECT,
  operationKinds: Object.freeze(["update"] satisfies OperationHint["kind"][]),
  target: matchesRepoMutationTarget,
  requiredPreconditions: Object.freeze([REPO_ROOT_AVAILABLE_PRECONDITION]),
  requiredEvidence: Object.freeze([
    Object.freeze({ kind: "repo.completed", mandatory: true }),
  ]),
  allowedConstraintKeys: Object.freeze([
    "commitMessage",
    "filesIncluded",
    "signedOff",
    "author",
  ]),
  riskTier: "medium",
  defaultBudgets: Object.freeze({
    maxLatencyMs: 60_000,
    maxRetries: 0,
  }),
  observerHandle: Object.freeze({ id: "repo_world_state" }),
  donePredicate: repoCommitLandedPredicate,
} satisfies RegisteredAffordance);

export const REPO_MERGE_COMPLETED_AFFORDANCE_ENTRY = Object.freeze({
  id: REPO_MERGE_COMPLETED_AFFORDANCE,
  effectFamily: REPO_EFFECT_FAMILY,
  effect: REPO_MERGE_COMPLETED_EFFECT,
  operationKinds: Object.freeze(["update"] satisfies OperationHint["kind"][]),
  target: matchesRepoMutationTarget,
  requiredPreconditions: Object.freeze([REPO_ROOT_AVAILABLE_PRECONDITION]),
  requiredEvidence: Object.freeze([
    Object.freeze({ kind: "repo.completed", mandatory: true }),
  ]),
  allowedConstraintKeys: Object.freeze([
    "sourceBranch",
    "targetBranch",
    "strategy",
    "fastForward",
    "squash",
  ]),
  riskTier: "high",
  defaultBudgets: Object.freeze({
    maxLatencyMs: 120_000,
    maxRetries: 0,
  }),
  observerHandle: Object.freeze({ id: "repo_world_state" }),
  donePredicate: repoMergeCompletedPredicate,
} satisfies RegisteredAffordance);

export const REPO_DIFF_OBSERVED_AFFORDANCE_ENTRY = Object.freeze({
  id: REPO_DIFF_OBSERVED_AFFORDANCE,
  effectFamily: REPO_EFFECT_FAMILY,
  effect: REPO_DIFF_OBSERVED_EFFECT,
  operationKinds: Object.freeze(["observe"] satisfies OperationHint["kind"][]),
  target: matchesRepoDiffObservedTarget,
  requiredPreconditions: Object.freeze([REPO_ROOT_AVAILABLE_PRECONDITION]),
  requiredEvidence: Object.freeze([
    Object.freeze({ kind: "repo.completed", mandatory: true }),
  ]),
  allowedConstraintKeys: Object.freeze([
    "baseRef",
    "headRef",
    "pathFilter",
    "includeStatus",
  ]),
  riskTier: "low",
  defaultBudgets: Object.freeze({
    maxLatencyMs: 15_000,
    maxRetries: 1,
  }),
  observerHandle: Object.freeze({ id: "repo_world_state" }),
  donePredicate: repoDiffObservedPredicate,
} satisfies RegisteredAffordance);

// ─── Slice K Phase 3 — reminder-family affordance + precondition ──────────
//
// Additive registry extension under the `reminder` effect-family registered
// in Phase 3 (`REMINDER_EFFECT_FAMILY`, observe-only — sub-plan §0.5.6).
// Slice K is a pure CONSUMER over LIT episodic slots; the affordance carries
// `riskTier: 'low'` because every read is identity-scoped + read-only +
// in-process (no outbound network, no mutation). The done-predicate reads
// `ctx.stateAfter.reminder?.lastQuery` (Phase 4 slice — accessed via
// structural cast in Phase 3) — no raw user text, no `TaskContract` (#9).
//
// `IDENTITY_RESOLVED_PRECONDITION` enforces the anonymous-fail-closed rule
// (sub-plan §1 #15 + acceptance #8): a reminder turn from an unbound
// session resolves no affordance candidate, so the runtime never issues a
// `MemoryStore` call without `identityId`.

export const IDENTITY_RESOLVED_PRECONDITION =
  "identity_resolved" as PreconditionId;

const REMINDER_DELIVERED_AFFORDANCE = "reminder.delivered" as AffordanceId;

/**
 * Matches the target shape produced by Phase 5 IntentContractor
 * classification of reminder turns. The contractor emits
 * `target.kind=unspecified` for «какой PDF я делал на прошлой неделе?» —
 * the operator did not bind a specific session/channel. The affordance
 * additionally accepts `kind: 'session'` so a future contractor refinement
 * that binds the active session id (e.g. «какие задачи в текущей сессии?»)
 * resolves to the same affordance without registry churn.
 *
 * NOTE — the slice K sub-plan §11 mentions a hypothetical
 * `kind: 'session_state'` `TargetRef` variant; the frozen `TargetRef`
 * union (`semantic-intent.ts:8-13`) does NOT carry that variant and
 * widening it is out-of-scope for slice K (acceptance #11 — frozen-layer
 * additive only, never widening). The effective coverage of `unspecified`
 * + `session` matches the intended contractor surface.
 *
 * @param target - Commitment target candidate.
 * @returns True for `unspecified` or `session` only.
 */
function matchesReminderDeliveredTarget(target: CommitmentTarget): boolean {
  return target.kind === "unspecified" || target.kind === "session";
}

export const REMINDER_DELIVERED_AFFORDANCE_ENTRY = Object.freeze({
  id: REMINDER_DELIVERED_AFFORDANCE,
  effectFamily: REMINDER_EFFECT_FAMILY,
  effect: REMINDER_DELIVERED_EFFECT,
  operationKinds: Object.freeze(["observe"] satisfies OperationHint["kind"][]),
  target: matchesReminderDeliveredTarget,
  // Anonymous fail-closed (sub-plan acceptance #8) — slice D resolver must
  // bind an `IdentityId` BEFORE the affordance resolves. Phase 4's
  // precondition resolver short-circuits the tool execution otherwise.
  requiredPreconditions: Object.freeze([IDENTITY_RESOLVED_PRECONDITION]),
  requiredEvidence: Object.freeze([
    Object.freeze({ kind: "reminder.queried", mandatory: true }),
  ]),
  allowedConstraintKeys: Object.freeze([
    "recallWindow",
    "effectFamilyFilter",
    "textHint",
    "limit",
  ]),
  riskTier: "low",
  defaultBudgets: Object.freeze({
    maxLatencyMs: 8_000,
    maxRetries: 1,
  }),
  observerHandle: Object.freeze({ id: "reminder_world_state" }),
  donePredicate: reminderDeliveredPredicate,
} satisfies RegisteredAffordance);

// ─── Cron/Scheduler Phase 4 — reminder.set affordance (write-side) ─────────
//
// Sibling of `REMINDER_DELIVERED_AFFORDANCE_ENTRY` (slice K — read-side
// recall) under the SAME `REMINDER_EFFECT_FAMILY`. Phase 2 (PR-#257) widened
// the family allowlist from `['observe']` to `['observe','create']`; Phase 4
// adds the create-side affordance entry. Branching factor on the reminder
// family becomes 2: `findByFamily('reminder', target, op={kind:'observe'})`
// resolves to slice K's affordance; `findByFamily('reminder', target,
// op={kind:'create'})` resolves to this entry. The two affordances have
// disjoint `operationKinds` arrays so no collision under target overlap.
//
// `riskTier: 'medium'` — state crosses `/new` boundary (the reminder lives
// in a Phase 6 SqliteReminderStore identity-scoped persistent store, so
// `/new` does NOT clear it) AND triggers an outbound push at fire-time
// (Cron-fire callback dispatches via existing `delivery-dispatch.ts`). The
// risk is asymmetric vs slice K (low — read-only, identity-scoped, no
// outbound network).
//
// `defaultBudgets.maxRetries: 0` — mutation idempotency is unsafe (Cutover-4
// P4 mutation precedent — repo branch/commit/merge all carry `maxRetries: 0`).
// Duplicate reminder = double-ping disasters: a maxRetries=1 retry on a
// transient persist failure could create two `(reminderId, fireAt)` records
// that BOTH fire to the operator at fireAt. The Phase 6 SqliteReminderStore
// keys on `reminder_id` PRIMARY KEY so a duplicate INSERT is rejected at
// SQL, but the retry-policy default closes the gap one layer up.
//
// `IDENTITY_RESOLVED_PRECONDITION` — anonymous fail-closed (slice K precedent
// + sub-plan §1 invariant #15 + audit §i NEW invariant). The Phase 5
// `RecordReminderTool` rejects empty `ownerIdentityId` via
// `identity_unavailable` failure code; the affordance precondition prevents
// the tool from being invoked at all when the resolver couldn't bind the
// identity.
//
// `requiredEvidence: [{kind: 'reminder.scheduled', mandatory: true}]` — the
// done-predicate emits this evidence kind on satisfy with the matched
// record's identity-scoped fields (NOT the content — content is reflected
// only at fire-time delivery, not in the evidence trail).
//
// `donePredicate: reminderSetPredicate` — reads
// `state.scheduledReminders?.records` for record matching `reminderId` from
// `expectedDelta.scheduledReminders?.added[]`. Satisfies on
// `status === 'pending'` (reminder scheduled, cron callback registered;
// firing is downstream — Phase 5 cron-fire callback transitions to `fired`
// AFTER the predicate runs). Closed missing-key set in
// `done-predicate-reminder-set.ts`. NEVER throws (#9).

const REMINDER_SET_AFFORDANCE = "reminder.set" as AffordanceId;

/**
 * Matches the target shape produced by Phase 7 IntentContractor classification
 * of "set reminder" turns. Per sub-plan §1 todo Phase 4: target matcher
 * accepts `kind === 'session_state' || kind === 'unspecified'`. The frozen
 * `TargetRef` union (`semantic-intent.ts:8-13`) does NOT carry the
 * `session_state` variant — slice K Phase 3 `matchesReminderDeliveredTarget`
 * documented this same gap (out-of-scope frozen-layer widening). For
 * forward-compat without widening the frozen contract we compare the literal
 * via a structural cast; today the contractor emits `target.kind=unspecified`
 * for «напомни мне через 30 минут позвонить клиенту X» turns, and a future
 * `TargetRef` widening that adds `session_state` (e.g. when the contractor
 * binds the active session-state surface explicitly) resolves to this
 * affordance without registry churn.
 *
 * @param target - Commitment target candidate.
 * @returns True for `unspecified` or the forward-compat `session_state` kind.
 */
function matchesReminderSetTarget(target: CommitmentTarget): boolean {
  const kind = (target as { kind: string }).kind;
  return kind === "session_state" || kind === "unspecified";
}

export const REMINDER_SET_AFFORDANCE_ENTRY = Object.freeze({
  id: REMINDER_SET_AFFORDANCE,
  effectFamily: REMINDER_EFFECT_FAMILY,
  effect: REMINDER_SET_EFFECT,
  operationKinds: Object.freeze(["create"] satisfies OperationHint["kind"][]),
  target: matchesReminderSetTarget,
  // Anonymous fail-closed — slice K precedent. The Phase 5 runtime adapter
  // additionally enforces `ownerIdentityId.trim().length > 0` at the tool
  // boundary; this precondition prevents affordance resolution when the
  // session-context resolver hasn't bound an identity at all.
  requiredPreconditions: Object.freeze([IDENTITY_RESOLVED_PRECONDITION]),
  requiredEvidence: Object.freeze([
    Object.freeze({ kind: "reminder.scheduled", mandatory: true }),
  ]),
  allowedConstraintKeys: Object.freeze([
    "fireAt",
    "content",
    "deliveryChannel",
    "deliveryTo",
    "recurrence",
  ]),
  riskTier: "medium",
  // mutation idempotency unsafe — Cutover-4 P4 mutation precedent.
  defaultBudgets: Object.freeze({
    maxLatencyMs: 10_000,
    maxRetries: 0,
  }),
  observerHandle: Object.freeze({ id: "scheduled_reminder_world_state" }),
  donePredicate: reminderSetPredicate,
} satisfies RegisteredAffordance);

const DEFAULT_AFFORDANCES = Object.freeze([
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
  REMINDER_DELIVERED_AFFORDANCE_ENTRY,
  REMINDER_SET_AFFORDANCE_ENTRY,
] satisfies RegisteredAffordance[]);

class StaticAffordanceRegistry implements AffordanceRegistry {
  readonly #affordances: readonly RegisteredAffordance[];

  /**
   * Creates a read-only registry over predeclared affordance entries.
   *
   * @param affordances - Catalog entries available for shadow resolution.
   */
  constructor(affordances: readonly RegisteredAffordance[]) {
    this.#affordances = affordances;
  }

  all(): readonly RegisteredAffordance[] {
    return this.#affordances;
  }

  findByFamily(
    familyId: EffectFamilyId,
    target: TargetRef,
    operation?: OperationHint,
  ): readonly RegisteredAffordance[] {
    return this.#affordances.filter((affordance) => {
      if (affordance.effectFamily !== familyId) {
        return false;
      }
      if (!affordance.target(target)) {
        return false;
      }
      if (!operation) {
        return true;
      }
      return affordance.operationKinds.includes(operation.kind);
    });
  }
}

export const defaultAffordanceRegistry: AffordanceRegistry = new StaticAffordanceRegistry(
  DEFAULT_AFFORDANCES,
);

/**
 * Creates an immutable affordance registry for tests or future catalog expansion.
 *
 * @param affordances - Catalog entries to expose through lookup.
 * @returns Read-only affordance registry.
 */
export function createAffordanceRegistry(
  affordances: readonly RegisteredAffordance[] = DEFAULT_AFFORDANCES,
): AffordanceRegistry {
  return new StaticAffordanceRegistry(Object.freeze([...affordances]));
}
