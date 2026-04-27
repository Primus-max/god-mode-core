import type { EffectFamilyId, EffectId } from "./ids.js";

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

const CUTOVER_1 = Object.freeze([
  Object.freeze({
    effect: "persistent_session.created" as EffectId,
    effectFamily: "persistent_session" as EffectFamilyId,
  }),
] satisfies CutoverEntry[]);

/**
 * Creates an immutable cutover policy from explicit entries.
 *
 * @param entries - Cutover-eligible effect entries.
 * @returns Read-only cutover policy.
 */
export function createCutoverPolicy(entries: readonly CutoverEntry[] = CUTOVER_1): CutoverPolicy {
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
