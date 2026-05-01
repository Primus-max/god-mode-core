import type { EffectFamilyId } from "./ids.js";
import type { SemanticIntent } from "./semantic-intent.js";

/**
 * Maps user prompt text to a structured `SemanticIntent`. Real PR-2
 * implementations brand the prompt inside `intent-contractor-impl.ts`.
 */
export interface IntentContractor {
  /**
   * Classify prompt text into a semantic intent.
   *
   * @param prompt - User-visible prompt text.
   * @returns A `SemanticIntent`. Low-confidence inputs are returned with
   *   `confidence: 0` and an `uncertainty` reason rather than thrown.
   */
  classify(prompt: string): Promise<SemanticIntent>;
}

/**
 * PR-1 stub. Always returns a low-confidence `SemanticIntent` with
 * `desiredEffectFamily: 'unknown'`, `target: { kind: 'unspecified' }`,
 * `confidence: 0`, and an `uncertainty` tag of `pr1_stub`. Never returns
 * `unsupported` — that is a `ShadowBuilder` shape, not an `IntentContractor`
 * shape (see sub-plan §3.9).
 */
export const intentContractorStub: IntentContractor = {
  async classify(_prompt: string): Promise<SemanticIntent> {
    return {
      desiredEffectFamily: "unknown" as EffectFamilyId,
      target: { kind: "unspecified" },
      constraints: {},
      uncertainty: ["pr1_stub"],
      confidence: 0,
    };
  },
};
