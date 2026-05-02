import type { Affordance } from "./affordance.js";
import {
  answerDeliveredPredicate,
  clarificationRequestedPredicate,
  externalEffectPerformedPredicate,
} from "./done-predicate-delivery.js";
import type { CommitmentTarget } from "./execution-commitment.js";
import type { AffordanceId, EffectFamilyId, EffectId, PreconditionId } from "./ids.js";
import {
  COMMUNICATION_EFFECT_FAMILY,
  PERSISTENT_SESSION_EFFECT_FAMILY,
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

const DEFAULT_AFFORDANCES = Object.freeze([
  PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
  ANSWER_DELIVERED_AFFORDANCE_ENTRY,
  CLARIFICATION_REQUESTED_AFFORDANCE_ENTRY,
  EXTERNAL_EFFECT_PERFORMED_AFFORDANCE_ENTRY,
  PERPLEXITY_SEARCH_SPECIALIST_AFFORDANCE_ENTRY,
  COMPOSER_AFTER_SEARCH_AFFORDANCE_ENTRY,
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
