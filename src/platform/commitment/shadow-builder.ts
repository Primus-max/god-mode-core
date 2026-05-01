import type { ExecutionCommitment } from "./execution-commitment.js";
import type { SemanticIntent } from "./semantic-intent.js";

export type ShadowUnsupportedReason =
  | "pr1_stub"
  | "low_confidence_intent"
  | "no_matching_affordance"
  | "policy_blocked"
  | "budget_exceeded"
  | "shadow_timeout"
  | "shadow_runtime_error";

export type ShadowBuildResult =
  | { readonly kind: "commitment"; readonly value: ExecutionCommitment }
  | {
      readonly kind: "unsupported";
      readonly reason: ShadowUnsupportedReason;
      readonly uncertainty?: readonly string[];
    };

/**
 * Builds an `ExecutionCommitment` (or returns a typed `unsupported` reason)
 * from a `SemanticIntent`. Implementations must never read `RawUserTurn` or
 * `UserPrompt` (hard invariant #7); they must always work from already-classified
 * `SemanticIntent`.
 */
export interface ShadowBuilder {
  /**
   * Produce a commitment for the given intent, or a typed unsupported reason.
   *
   * @param intent - Pre-classified semantic intent.
   * @returns Either a built `ExecutionCommitment` or a structured unsupported
   *   reason. Never throws for routing decisions; never returns `null`.
   */
  build(intent: SemanticIntent): Promise<ShadowBuildResult>;
}

/**
 * PR-1 skeleton implementation. Always returns `unsupported` with reason
 * `pr1_stub`. The real builder lands in PR-2.
 */
export const shadowBuilderSkeleton: ShadowBuilder = {
  async build(_intent: SemanticIntent): Promise<ShadowBuildResult> {
    return { kind: "unsupported", reason: "pr1_stub" };
  },
};
