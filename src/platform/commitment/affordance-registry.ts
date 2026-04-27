import type { Affordance } from "./affordance.js";
import type { CommitmentTarget } from "./execution-commitment.js";
import type { AffordanceId, EffectFamilyId, EffectId } from "./ids.js";
import { PERSISTENT_SESSION_EFFECT_FAMILY } from "./effect-family-registry.js";
import { persistentSessionCreatedPredicate } from "./done-predicate-persistent-session.js";
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

const DEFAULT_AFFORDANCES = Object.freeze([
  PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
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
