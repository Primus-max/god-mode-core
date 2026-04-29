import type { OpenClawConfig } from "../../config/config.js";
import type { SemanticIntent } from "./semantic-intent.js";

/**
 * Closed set of downgrade reasons exposed by the Stage 1 ClarificationPolicy
 * gate (see `commitment_kernel_policy_gate_full.plan.md` §1, §6.3).
 *
 * The gate is **orthogonal** to the affordance-selection `POLICY_GATE_REASONS`
 * exposed by `policy-gate.ts`: the affordance gate decides whether a candidate
 * affordance may be used, while this gate decides whether a legacy classifier
 * "clarification_needed" outcome should be downgraded to a regular answer when
 * the kernel-side `SemanticIntent` already carries an explicit signal.
 *
 * Stages 2-6 of the same sub-plan (approvals, budgets, role-based access,
 * retry policies, escalation hooks) belong to extensions of `POLICY_GATE_REASONS`
 * and are out of scope here — keeping the two reason registries separate makes
 * scope-creep visible at PR review (a third reason added to either set fails
 * its respective reverse-test).
 *
 * The reverse-test in `__tests__/clarification-policy.test.ts` asserts this
 * exact tuple to lock the Stage 1 surface.
 */
export const CLARIFICATION_POLICY_REASONS = Object.freeze([
  "ambiguity_resolved_by_intent",
] as const);

export type ClarificationPolicyReason = (typeof CLARIFICATION_POLICY_REASONS)[number];

export type ClarificationPolicyDecision =
  | { readonly shouldClarify: true }
  | {
      readonly shouldClarify: false;
      readonly downgradeReason: ClarificationPolicyReason;
    };

export type ClarificationPolicyEvaluateInput = {
  readonly intent: SemanticIntent;
  readonly blockingReasons: readonly string[];
};

export interface ClarificationPolicyReader {
  /**
   * Decides whether a legacy clarify outcome should still trigger clarification
   * or be downgraded because the kernel-side `SemanticIntent` already resolves
   * the ambiguity structurally.
   *
   * @param params - Kernel-derived intent plus the classifier-emitted blocking
   *   ambiguity reasons (already filtered to `blocksClarification === true`).
   * @returns `{ shouldClarify: true }` to preserve legacy clarify, or
   *   `{ shouldClarify: false; downgradeReason }` to downgrade.
   */
  evaluate(
    params: ClarificationPolicyEvaluateInput,
  ): ClarificationPolicyDecision | Promise<ClarificationPolicyDecision>;
}

export type ClarificationPolicyContext = {
  readonly cfg: OpenClawConfig;
};

/**
 * Curated allowlist of `SemanticIntent.constraints` keys that may carry an
 * explicit local-deployment signal. The gate reads these keys structurally and
 * never falls back to regex over user prompts (invariants #5, #6).
 *
 * Extension of this list is a deliberate review action — never silently widen.
 */
const LOCAL_DEPLOYMENT_CONSTRAINT_KEYS = ["hosting", "deploymentTarget", "executionTarget"] as const;

/**
 * Closed value set treated as "the user explicitly said local". Comparison is
 * case-insensitive against the trimmed string value.
 */
const LOCAL_DEPLOYMENT_VALUES: ReadonlySet<string> = new Set([
  "local",
  "localhost",
  "local_machine",
  "local-machine",
  "локально",
  "локальный",
]);

/**
 * Curated set of classifier-emitted ambiguity reason fragments that map to
 * "deployment / publish target unspecified" — these are matched against
 * `AmbiguityProfileEntry.reason` strings produced by the frozen
 * `ambiguity-policy.ts` / `qualification-confidence.ts` layer (classifier
 * OUTPUT, not user input — invariant #5 holds).
 */
const DEPLOYMENT_BLOCKING_REASON_FRAGMENTS = [
  "publish target",
  "deployment target",
  "production target",
] as const;

/**
 * Creates the Stage 1 ClarificationPolicy gate.
 *
 * Stage 1 scope (focused bug-fix slice): downgrade legacy classifier
 * "clarification_needed: publish target is not specified" to `answer` when
 * `SemanticIntent` carries an explicit local-deployment signal. Everything
 * else (approvals, budgets, role-based access, retry, escalation) is deferred
 * to Stages 2-6 of the same sub-plan, each requiring an explicit PR + maintainer
 * signoff (invariant #15).
 *
 * @param context - Real-mode runtime context (just `cfg` for Stage 1; richer
 *   contexts are reserved for future stages).
 * @returns `ClarificationPolicyReader` ready to be injected into
 *   `runTurnDecision` via `RunTurnDecisionInput.clarificationPolicy`.
 */
export function createClarificationPolicy(
  context: ClarificationPolicyContext,
): ClarificationPolicyReader {
  void context;
  const reader: ClarificationPolicyReader = {
    evaluate(params: ClarificationPolicyEvaluateInput): ClarificationPolicyDecision {
      if (!hasDeploymentBlockingReason(params.blockingReasons)) {
        return { shouldClarify: true };
      }
      if (!hasExplicitLocalSignal(params.intent)) {
        return { shouldClarify: true };
      }
      return {
        shouldClarify: false,
        downgradeReason: "ambiguity_resolved_by_intent" satisfies ClarificationPolicyReason,
      };
    },
  };
  return Object.freeze(reader);
}

/**
 * Returns true when at least one classifier-emitted blocking reason matches the
 * curated deployment-target fragment list.
 *
 * @param reasons - Blocking ambiguity reasons (already filtered upstream).
 * @returns True when a deployment-target ambiguity is present.
 */
function hasDeploymentBlockingReason(reasons: readonly string[]): boolean {
  if (reasons.length === 0) {
    return false;
  }
  for (const reason of reasons) {
    const lowered = reason.toLowerCase();
    for (const fragment of DEPLOYMENT_BLOCKING_REASON_FRAGMENTS) {
      if (lowered.includes(fragment)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Detects an explicit local-deployment signal on `SemanticIntent` either via
 * `target.kind === 'workspace'` or via a curated constraint key carrying a
 * known local-marker value. This is structural matching only — no regex over
 * raw user text (invariants #5, #6).
 *
 * @param intent - Kernel-side semantic intent produced by `IntentContractor`.
 * @returns True when the intent unambiguously resolves to a local target.
 */
function hasExplicitLocalSignal(intent: SemanticIntent): boolean {
  if (intent.target.kind === "workspace") {
    return true;
  }
  const constraints = intent.constraints as Record<string, unknown>;
  for (const key of LOCAL_DEPLOYMENT_CONSTRAINT_KEYS) {
    const raw = constraints[key];
    if (typeof raw !== "string") {
      continue;
    }
    const normalized = raw.trim().toLowerCase();
    if (LOCAL_DEPLOYMENT_VALUES.has(normalized)) {
      return true;
    }
  }
  return false;
}
