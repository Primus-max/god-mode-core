import type { OpenClawConfig } from "../../config/config.js";
import type { SemanticIntent } from "./semantic-intent.js";

/**
 * Closed set of downgrade reasons exposed by the ClarificationPolicy gate.
 *
 * Stage 1 (Bug D, merged): `ambiguity_resolved_by_intent` — current
 * `SemanticIntent` carries an explicit local-deployment signal that resolves
 * a deployment-target classifier ambiguity (see
 * `commitment_kernel_policy_gate_full.plan.md` §1, §6.3).
 *
 * Stage 1.5 (PR-H, this slice): `ambiguity_resolved_by_session_history` —
 * a previously successful `SemanticIntent` for the same session structurally
 * fills a field that the current intent leaves empty, and the classifier
 * blocking reason class matches the inheritable field (see
 * `commitment_kernel_smart_orchestrator_roadmap.plan.md` §3 row 3, FIXED
 * design choice §pr-h-session-aware-clarify, AND
 * `commitment_kernel_clarification_history_aware.plan.md` §3 algorithm).
 *
 * The gate is **orthogonal** to the affordance-selection `POLICY_GATE_REASONS`
 * exposed by `policy-gate.ts`: the affordance gate decides whether a candidate
 * affordance may be used, while this gate decides whether a legacy classifier
 * "clarification_needed" outcome should be downgraded to a regular answer.
 *
 * Stages 2-6 of `commitment_kernel_policy_gate_full.plan.md` (approvals,
 * budgets, role-based access, retry policies, escalation hooks) belong to
 * extensions of `POLICY_GATE_REASONS` and are out of scope here — keeping the
 * two reason registries separate makes scope-creep visible at PR review (a
 * third reason added to either set fails its respective reverse-test).
 *
 * The reverse-test in `__tests__/clarification-policy.test.ts` asserts this
 * exact tuple to lock the Stage 1 + 1.5 surface.
 */
export const CLARIFICATION_POLICY_REASONS = Object.freeze([
  "ambiguity_resolved_by_intent",
  "ambiguity_resolved_by_session_history",
] as const);

export type ClarificationPolicyReason = (typeof CLARIFICATION_POLICY_REASONS)[number];

/**
 * Closed list of `SemanticIntent` fields the Stage 1.5 history-aware gate is
 * allowed to inherit from a prior turn.
 *
 * Curated structural surface only — extending requires (a) a new entry here,
 * (b) a matching entry in the curated reason-fragment map, (c) a matching
 * field-extraction in `collectInheritableFields`, and (d) a reverse-test
 * update. Frozen by `Object.freeze` so silent runtime push fails.
 */
export const INHERITABLE_INTENT_FIELDS = Object.freeze([
  "target.kind",
  "operation",
] as const);

export type InheritableIntentField = (typeof INHERITABLE_INTENT_FIELDS)[number];

export type ClarificationPolicyDecision =
  | { readonly shouldClarify: true }
  | {
      readonly shouldClarify: false;
      readonly downgradeReason: ClarificationPolicyReason;
      /**
       * Structural diff for `ambiguity_resolved_by_session_history` only:
       * which inheritable fields were inherited from `priorIntent`. Always
       * a non-empty subset of `INHERITABLE_INTENT_FIELDS` when present.
       * Omitted for Stage 1 (`ambiguity_resolved_by_intent`).
       */
      readonly inheritedFields?: readonly InheritableIntentField[];
    };

export type ClarificationPolicyEvaluateInput = {
  readonly intent: SemanticIntent;
  readonly blockingReasons: readonly string[];
  /**
   * Stage 1.5: last successful kernel-derived `SemanticIntent` for the same
   * session within a recent window (default N=5 turns). When omitted (cold
   * start, no session history, or caller does not maintain a per-session
   * intent cache yet), the Stage 1.5 path is bypassed silently — Stage 1
   * still runs.
   *
   * Caller is responsible for providing this value; the policy never reads
   * raw user text (invariant #6) and never reaches into a module-level cache
   * (forward-compat constraint, roadmap §4 #1).
   */
  readonly priorIntent?: SemanticIntent;
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
 * Curated reason-fragment classes for Stage 1.5 (`ambiguity_resolved_by_session_history`).
 * Each `InheritableIntentField` maps to a closed set of substring fragments
 * that the classifier-emitted blocking reason must include for the gate to
 * downgrade. Matched against classifier OUTPUT only — invariant #5 holds.
 *
 * Extension requires updating both `INHERITABLE_INTENT_FIELDS` and this map
 * AND the reverse-test in `__tests__/clarification-policy.test.ts`.
 */
const TARGET_CLASS_BLOCKING_REASON_FRAGMENTS = [
  "target",
  "destination",
  "scope",
] as const;

const OPERATION_CLASS_BLOCKING_REASON_FRAGMENTS = [
  "action",
  "operation",
  "verb",
  "intent",
  "what to do",
  "next step",
  "command",
] as const;

const FIELD_TO_BLOCKING_REASON_FRAGMENTS: ReadonlyMap<
  InheritableIntentField,
  readonly string[]
> = new Map([
  ["target.kind", TARGET_CLASS_BLOCKING_REASON_FRAGMENTS],
  ["operation", OPERATION_CLASS_BLOCKING_REASON_FRAGMENTS],
]);

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
      const stage1 = evaluateStage1(params);
      if (!stage1.shouldClarify) {
        return stage1;
      }
      const stage1_5 = evaluateStage1_5(params);
      if (!stage1_5.shouldClarify) {
        return stage1_5;
      }
      return { shouldClarify: true };
    },
  };
  return Object.freeze(reader);
}

/**
 * Stage 1 evaluation: explicit local-deployment signal resolves a
 * deployment-target classifier ambiguity. Pure structural matcher.
 *
 * @param params - Current intent + classifier blocking reasons.
 * @returns Downgrade decision with `ambiguity_resolved_by_intent` when both
 *   conditions match; `shouldClarify: true` otherwise.
 */
function evaluateStage1(
  params: ClarificationPolicyEvaluateInput,
): ClarificationPolicyDecision {
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
}

/**
 * Stage 1.5 evaluation: structural inheritance of an inheritable
 * `SemanticIntent` field from a prior turn's intent for the same session,
 * combined with a curated reason-class match. Bypassed when `priorIntent` is
 * absent (cold start, no session history, or caller has not wired prior-intent
 * lookup yet).
 *
 * Algorithm (FIXED, see roadmap §pr-h-session-aware-clarify):
 *   1. Compute inheritable fields = priorIntent has the field set explicitly
 *      AND current intent leaves the field empty (`unspecified` for `target.kind`,
 *      `undefined` for `operation`). Contradiction (current explicitly set to a
 *      different value) is implicit: such fields are NOT inheritable.
 *   2. Filter inheritable fields to those whose curated blocking-reason class
 *      includes at least one of `params.blockingReasons`.
 *   3. If non-empty after filtering, downgrade with the matching subset.
 *
 * @param params - Current intent + classifier blocking reasons + optional
 *   priorIntent.
 * @returns Downgrade decision with `ambiguity_resolved_by_session_history`
 *   and the matching `inheritedFields`; `shouldClarify: true` otherwise.
 */
function evaluateStage1_5(
  params: ClarificationPolicyEvaluateInput,
): ClarificationPolicyDecision {
  if (!params.priorIntent) {
    return { shouldClarify: true };
  }
  const inheritable = collectInheritableFields(params.intent, params.priorIntent);
  if (inheritable.length === 0) {
    return { shouldClarify: true };
  }
  const matched: InheritableIntentField[] = [];
  for (const field of inheritable) {
    if (hasMatchingBlockingReasonForField(field, params.blockingReasons)) {
      matched.push(field);
    }
  }
  if (matched.length === 0) {
    return { shouldClarify: true };
  }
  return {
    shouldClarify: false,
    downgradeReason: "ambiguity_resolved_by_session_history" satisfies ClarificationPolicyReason,
    inheritedFields: Object.freeze(matched),
  };
}

/**
 * Returns the subset of `INHERITABLE_INTENT_FIELDS` that priorIntent fills
 * explicitly while current intent leaves them structurally empty. Per-field
 * contradictions (current explicitly set to a different value) are implicit
 * non-matches — not inheritable.
 *
 * @param intent - Current kernel-derived intent.
 * @param priorIntent - Last successful kernel-derived intent for the same session.
 * @returns Fields whose value can be structurally inherited from priorIntent.
 */
function collectInheritableFields(
  intent: SemanticIntent,
  priorIntent: SemanticIntent,
): InheritableIntentField[] {
  const fields: InheritableIntentField[] = [];
  if (
    priorIntent.target.kind !== "unspecified" &&
    intent.target.kind === "unspecified"
  ) {
    fields.push("target.kind");
  }
  if (priorIntent.operation !== undefined && intent.operation === undefined) {
    fields.push("operation");
  }
  return fields;
}

/**
 * Returns true when at least one classifier-emitted blocking reason includes
 * a curated fragment for the inheritable field's class.
 *
 * @param field - Inheritable intent field (e.g. `target.kind`).
 * @param reasons - Blocking ambiguity reasons (already filtered upstream).
 * @returns True when a reason matches the curated class for this field.
 */
function hasMatchingBlockingReasonForField(
  field: InheritableIntentField,
  reasons: readonly string[],
): boolean {
  const fragments = FIELD_TO_BLOCKING_REASON_FRAGMENTS.get(field);
  if (!fragments || reasons.length === 0) {
    return false;
  }
  for (const reason of reasons) {
    const lowered = reason.toLowerCase();
    for (const fragment of fragments) {
      if (lowered.includes(fragment)) {
        return true;
      }
    }
  }
  return false;
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
