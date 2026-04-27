import type { EffectFamilyId } from "./ids.js";
import type { RawUserTurn } from "./raw-user-turn.js";
import type { SemanticIntent } from "./semantic-intent.js";

/**
 * Sole whitelisted reader of `RawUserTurn` / `UserPrompt`. Maps raw user input
 * to a structured `SemanticIntent`. Hard invariants #5 and #6: no other file
 * in the repo may import `RawUserTurn` or `UserPrompt`; the
 * `lint:commitment:no-raw-user-text-import` check enforces this.
 */
export interface IntentContractor {
  /**
   * Classify a raw user turn into a semantic intent.
   *
   * @param turn - Raw user input including text, channel, attachments.
   * @returns A `SemanticIntent`. Low-confidence inputs are returned with
   *   `confidence: 0` and an `uncertainty` reason rather than thrown.
   */
  classify(turn: RawUserTurn): Promise<SemanticIntent>;
}

/**
 * PR-1 stub. Always returns a low-confidence `SemanticIntent` with
 * `desiredEffectFamily: 'unknown'`, `target: { kind: 'unspecified' }`,
 * `confidence: 0`, and an `uncertainty` tag of `pr1_stub`. Never returns
 * `unsupported` — that is a `ShadowBuilder` shape, not an `IntentContractor`
 * shape (see sub-plan §3.9).
 */
export const intentContractorStub: IntentContractor = {
  async classify(_turn: RawUserTurn): Promise<SemanticIntent> {
    return {
      desiredEffectFamily: "unknown" as EffectFamilyId,
      target: { kind: "unspecified" },
      constraints: {},
      uncertainty: ["pr1_stub"],
      confidence: 0,
    };
  },
};
