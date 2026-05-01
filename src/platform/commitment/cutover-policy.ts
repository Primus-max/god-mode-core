import {
  COMMUNICATION_EFFECT_FAMILY,
  PERSISTENT_SESSION_EFFECT_FAMILY,
} from "./effect-family-registry.js";
import type { EffectId } from "./ids.js";
import type { EffectFamilyId } from "./ids.js";

export type CutoverEntry = {
  readonly effect: EffectId;
  readonly effectFamily: EffectFamilyId;
};

export interface CutoverPolicy {
  /**
   * Checks whether an effect is eligible for production cutover.
   *
   * @param effect - Commitment effect to check.
   * @returns True when the effect belongs to the current cutover allow-list.
   */
  isEligible(effect: EffectId): boolean;

  /**
   * Lists current cutover entries.
   *
   * @returns Read-only list of cutover-eligible effect entries.
   */
  list(): readonly CutoverEntry[];
}

const CUTOVER_2 = Object.freeze([
  Object.freeze({
    effect: "persistent_session.created" as EffectId,
    effectFamily: PERSISTENT_SESSION_EFFECT_FAMILY,
  }),
  Object.freeze({
    effect: "answer.delivered" as EffectId,
    effectFamily: COMMUNICATION_EFFECT_FAMILY,
  }),
  Object.freeze({
    effect: "clarification_requested" as EffectId,
    effectFamily: COMMUNICATION_EFFECT_FAMILY,
  }),
  Object.freeze({
    effect: "external_effect.performed" as EffectId,
    effectFamily: COMMUNICATION_EFFECT_FAMILY,
  }),
] satisfies CutoverEntry[]);

/**
 * Creates an immutable cutover policy from explicit entries.
 *
 * @param entries - Cutover-eligible effect entries.
 * @returns Read-only cutover policy.
 */
export function createCutoverPolicy(entries: readonly CutoverEntry[] = CUTOVER_2): CutoverPolicy {
  const frozenEntries = Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
  const eligibleEffects = new Set(frozenEntries.map((entry) => entry.effect));

  return Object.freeze({
    isEligible(effect: EffectId): boolean {
      return eligibleEffects.has(effect);
    },

    list(): readonly CutoverEntry[] {
      return frozenEntries;
    },
  });
}

export const defaultCutoverPolicy: CutoverPolicy = createCutoverPolicy();
