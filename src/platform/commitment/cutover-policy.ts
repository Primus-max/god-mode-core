import {
  ARTIFACT_EFFECT_FAMILY,
  CODE_PATCH_APPLIED_EFFECT,
  COMMUNICATION_EFFECT_FAMILY,
  DOCX_CREATED_EFFECT,
  IMAGE_CREATED_EFFECT,
  PDF_CREATED_EFFECT,
  PERSISTENT_SESSION_EFFECT_FAMILY,
  REPO_BRANCH_CREATED_EFFECT,
  REPO_COMMIT_LANDED_EFFECT,
  REPO_DIFF_OBSERVED_EFFECT,
  REPO_EFFECT_FAMILY,
  REPO_MERGE_COMPLETED_EFFECT,
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

// Cutover-3 Phase 7 extended `CUTOVER_2` ADDITIVELY with the four artifact
// effect ids (`pdf.created`, `docx.created`, `code_patch.applied`,
// `image.created`) per cutover-3 sub-plan §4 #5 ("all four"). Cutover-4
// Phase 7 (this slice) extends the SAME array ADDITIVELY with the four
// repo effect ids (`repo.branch_created`, `repo.commit_landed`,
// `repo.merge_completed`, `repo.diff_observed`) per cutover-4 sub-plan
// §4 #5 ("all four") and the audit decision in
// `extensions/AUDIT-cutover4-repo-operation.md` §d. The constant name
// is retained: extending `CUTOVER_2` in place mirrors the cutover-2
// PR-#104 precedent (where Wave A's single effect was extended with
// three Wave B chat effects inside the same array literal — no
// `CUTOVER_1` constant) and the cutover-3 PR-#202 precedent, keeping
// the public surface a single immutable allow-list.
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
  Object.freeze({
    effect: PDF_CREATED_EFFECT,
    effectFamily: ARTIFACT_EFFECT_FAMILY,
  }),
  Object.freeze({
    effect: DOCX_CREATED_EFFECT,
    effectFamily: ARTIFACT_EFFECT_FAMILY,
  }),
  Object.freeze({
    effect: CODE_PATCH_APPLIED_EFFECT,
    effectFamily: ARTIFACT_EFFECT_FAMILY,
  }),
  Object.freeze({
    effect: IMAGE_CREATED_EFFECT,
    effectFamily: ARTIFACT_EFFECT_FAMILY,
  }),
  Object.freeze({
    effect: REPO_BRANCH_CREATED_EFFECT,
    effectFamily: REPO_EFFECT_FAMILY,
  }),
  Object.freeze({
    effect: REPO_COMMIT_LANDED_EFFECT,
    effectFamily: REPO_EFFECT_FAMILY,
  }),
  Object.freeze({
    effect: REPO_MERGE_COMPLETED_EFFECT,
    effectFamily: REPO_EFFECT_FAMILY,
  }),
  Object.freeze({
    effect: REPO_DIFF_OBSERVED_EFFECT,
    effectFamily: REPO_EFFECT_FAMILY,
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
