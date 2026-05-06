import type { EffectId } from "../commitment/ids.js";
import type {
  RuntimeAcceptanceReason,
  RuntimeTerminalState,
} from "../commitment/monitored-runtime.js";
import type { ShadowBuildResult, ShadowUnsupportedReason } from "../commitment/shadow-builder.js";
import type { DeliverableSpec } from "../produce/registry.js";
import type { ClassifierTelemetry, RoutingOutcome } from "../recipe/planner.js";
import type { RecipeRoutingHints } from "../recipe/planner.js";
import type { AmbiguityProfileEntry } from "./ambiguity-policy.js";
import type { PlatformExecutionContextReadinessStatus } from "./contracts.js";
import type {
  CandidateExecutionFamily,
  OutcomeContract,
  QualificationConfidence,
  QualificationExecutionContract,
  QualificationLowConfidenceStrategy,
  RequestedEvidenceKind,
} from "./qualification-contract.js";
import type { ResolutionContract, ResolutionRouting } from "./resolution-contract.js";
import type { TaskClassifierDebugEvent, TaskContract } from "./task-classifier.js";

export type DecisionTraceErrorTag =
  | "unnecessary_clarify"
  | "wrong_execution_mode"
  | "missing_required_tool"
  | "bundle_recipe_mismatch"
  | "policy_denial_leak_risk";

export type DecisionTraceClassifierDebugEvent = Pick<
  TaskClassifierDebugEvent,
  | "stage"
  | "backend"
  | "configuredModel"
  | "provider"
  | "modelId"
  | "parseResult"
  | "parseErrorMessage"
  | "message"
>;

export type DecisionTraceClassifier = ClassifierTelemetry & {
  rawContract?: TaskContract;
  normalizedContract?: TaskContract;
  finalContract?: TaskContract;
  debugEvents?: DecisionTraceClassifierDebugEvent[];
};

export type DecisionTraceContracts = {
  outcomeContract?: OutcomeContract;
  executionContract?: QualificationExecutionContract;
  requestedEvidence?: RequestedEvidenceKind[];
  confidence?: QualificationConfidence;
  ambiguityReasons?: string[];
  ambiguityProfile?: AmbiguityProfileEntry[];
  lowConfidenceStrategy?: QualificationLowConfidenceStrategy;
  deliverable?: DeliverableSpec;
};

export type DecisionTraceResolution = {
  candidateFamilies?: CandidateExecutionFamily[];
  selectedFamily?: CandidateExecutionFamily;
  toolBundles?: ResolutionContract["toolBundles"];
  routing?: ResolutionRouting;
  routingHints?: RecipeRoutingHints;
};

export type DecisionTracePlanner = {
  selectedRecipeId?: string;
  routingOutcome?: RoutingOutcome;
};

export type DecisionTracePolicy = {
  requireExplicitApproval?: boolean;
  autonomy?: "chat" | "assist" | "guarded";
};

export type DecisionTraceReadiness = {
  status?: PlatformExecutionContextReadinessStatus;
  reasons?: string[];
};

/**
 * Reason a turn fell back to the legacy classifier-derived production decision
 * instead of becoming kernel-source-of-truth. Inherits all `ShadowUnsupportedReason`
 * codes (raised by the shadow-builder) and adds the cutover-gate-specific codes
 * surfaced by `runTurnDecision`.
 */
export type KernelFallbackReason =
  | ShadowUnsupportedReason
  | "cutover_disabled"
  | "effect_not_eligible"
  | "affordance_unavailable"
  | "monitored_runtime_unavailable"
  | "expected_delta_unavailable"
  | "monitored_runtime_error"
  | "commitment_unsatisfied";

/**
 * Marker proving a production decision was derived from the kernel pipeline
 * (commitment + runtime attestation) rather than from the legacy classifier.
 * Present in `DecisionTrace` only when `productionDecision !== legacyDecision`.
 */
export type KernelDerivedDecisionMarker = {
  readonly sourceOfTruth: "kernel";
  readonly effect: EffectId;
  readonly terminalState: RuntimeTerminalState;
  readonly acceptanceReason: RuntimeAcceptanceReason;
};

/**
 * Observability-only marker describing that the legacy classifier
 * `clarification_needed` outcome was downgraded to a regular answer because
 * the kernel-side `SemanticIntent` already carried a structural signal that
 * resolves the ambiguity.
 *
 * Stage 1 (`ambiguity_resolved_by_intent`, see
 * `commitment_kernel_policy_gate_full.plan.md`): current intent has explicit
 * local-deployment signal. Stage 1.5 (`ambiguity_resolved_by_session_history`,
 * see `commitment_kernel_smart_orchestrator_roadmap.plan.md` §3 row 3 and
 * `commitment_kernel_clarification_history_aware.plan.md`): a prior turn's
 * intent fills a field the current intent leaves empty; `inheritedFields`
 * lists the inherited closed-string field names.
 *
 * The downgrade is emitted by `run-turn-decision.ts` and is **not** a new
 * orchestration-semantics field on TaskContract / OutcomeContract /
 * QualificationExecutionContract / ResolutionContract / RecipeRoutingHints
 * (invariant #11). The closed-string `downgradeReason` mirrors the frozen
 * `CLARIFICATION_POLICY_REASONS` set, and `inheritedFields` mirrors the
 * frozen `INHERITABLE_INTENT_FIELDS` set; any extension requires an explicit
 * sub-plan stage. Stages 1 and 1.5 land without maintainer signoff (same
 * narrow class as Bug D); Stages 2-6 require signoff (invariant #15).
 */
export type ClarificationPolicyDowngradeMarker = {
  readonly downgradeReason:
    | "ambiguity_resolved_by_intent"
    | "ambiguity_resolved_by_session_history";
  readonly inheritedFields?: readonly ("target.kind" | "operation")[];
};

/**
 * Observability-only marker emitted by `run-turn-decision.ts` when the
 * Stage 2 Approvals gate (`commitment_kernel_policy_gate_full.plan.md`
 * Phase 3) denies a kernel-derived effect. The gate runs AFTER the
 * affordance allowlist (which lives inside `runShadowBranch`) and
 * BEFORE the kernel-derived production decision is returned to the
 * caller.
 *
 * Carrying the closed-string `reason` mirrors the
 * `APPROVAL_POLICY_REASONS` frozen tuple
 * (`policy-gate-stages.ts`); the `approvalRequestId` is the join key
 * between the decision trace, the `policy_approval` episodic event,
 * and the `ExecApprovalManager` record raised by the same denial
 * event. Per audit §g, this marker is the trace-side observability
 * channel — `RuntimeAttestation` is **not** widened with a
 * `policyDenialReasons` slot (policy denials short-circuit upstream of
 * the runtime).
 *
 * The closed-string `reason` mirrors the frozen
 * `APPROVAL_POLICY_REASONS = ['requires_approval']` tuple (Phase 2
 * deliverable). Stages 3-6 will land sibling markers
 * (`policyBudgetDenial`, `policyRoleDenial`, etc.) following the same
 * pattern; each extension is gated on its own sub-plan phase with
 * maintainer signoff.
 */
export type PolicyApprovalDenialMarker = {
  readonly stage: "approval";
  readonly reason: "requires_approval";
  readonly effectId: EffectId;
  readonly approvalRequestId: string;
};

/**
 * Phase 4 — Stage 3 (Budgets) trace marker. Mirrors the
 * `policyApprovalDenial` shape (one denial per turn at most), but
 * carries the orthogonal three-reason `BudgetPolicyReason` enum and
 * the `(used, limit, windowId)` triple so observability can join on
 * the same `windowId` against the `policy_budget` episodic event
 * AND the `SqliteBudgetStore` row in one query.
 *
 * The closed-string `reason` mirrors the frozen
 * `BUDGET_POLICY_REASONS = ['budget_exceeded_user',
 * 'budget_exceeded_channel', 'budget_exceeded_effect']` tuple
 * (Phase 2 deliverable). Stages 4-6 land sibling markers
 * (`policyRoleDenial`, `policyRetryDenial`, …) following the same
 * pattern; each extension is gated on its own sub-plan phase with
 * maintainer signoff.
 */
export type PolicyBudgetDenialMarker = {
  readonly stage: "budget";
  readonly reason: "budget_exceeded_user" | "budget_exceeded_channel" | "budget_exceeded_effect";
  readonly effectId: EffectId;
  readonly windowId: string;
  readonly used: number;
  readonly limit: number;
};

/**
 * Phase 5 — Stage 4 (Role-based access) trace marker. Mirrors the
 * `policyApprovalDenial` / `policyBudgetDenial` shape (one denial
 * per turn at most). The `requiredRole` carries the role-key the
 * caller would need to be granted before retry, surfaced for
 * escalation routing.
 *
 * The closed-string `reason` mirrors the frozen
 * `ROLE_POLICY_REASONS = ['role_denied']` tuple (Phase 2
 * deliverable). Stages 5-6 land sibling markers
 * (`policyRetryDenial`, `policyEscalation`) following the same
 * pattern; each extension is gated on its own sub-plan phase with
 * maintainer signoff.
 */
export type PolicyRoleDenialMarker = {
  readonly stage: "role";
  readonly reason: "role_denied";
  readonly effectId: EffectId;
  readonly requiredRole: string;
};

export type DecisionTrace = {
  version: 1;
  classifier?: DecisionTraceClassifier;
  contracts?: DecisionTraceContracts;
  requestedTools?: string[];
  resolution?: DecisionTraceResolution;
  planner?: DecisionTracePlanner;
  policy?: DecisionTracePolicy;
  readiness?: DecisionTraceReadiness;
  errorTags?: DecisionTraceErrorTag[];
  readonly shadowCommitment?: ShadowBuildResult;
  readonly kernelDerived?: KernelDerivedDecisionMarker;
  readonly kernelFallback?: boolean;
  readonly fallbackReason?: KernelFallbackReason;
  readonly clarificationPolicy?: ClarificationPolicyDowngradeMarker;
  readonly policyApprovalDenial?: PolicyApprovalDenialMarker;
  readonly policyBudgetDenial?: PolicyBudgetDenialMarker;
  readonly policyRoleDenial?: PolicyRoleDenialMarker;
};

function sortUnique(values: readonly string[] | undefined): string[] {
  return Array.from(new Set(values ?? [])).toSorted();
}

/**
 * Compacts classifier debug events before they enter runtime decision traces.
 *
 * @param events - Classifier debug events that may include raw model output.
 * @returns Debug metadata without raw response text or JSON candidates.
 */
export function compactDecisionTraceDebugEvents(
  events: readonly TaskClassifierDebugEvent[] | undefined,
): DecisionTraceClassifierDebugEvent[] | undefined {
  if (!events?.length) {
    return undefined;
  }
  return events.map((event) => ({
    stage: event.stage,
    backend: event.backend,
    configuredModel: event.configuredModel,
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.modelId ? { modelId: event.modelId } : {}),
    ...(event.parseResult ? { parseResult: event.parseResult } : {}),
    ...(event.parseErrorMessage ? { parseErrorMessage: event.parseErrorMessage } : {}),
    ...(event.message ? { message: event.message } : {}),
  }));
}

function hasClarifySignal(trace: DecisionTrace): boolean {
  const finalContract = trace.classifier?.finalContract;
  return (
    finalContract?.primaryOutcome === "clarification_needed" ||
    finalContract?.interactionMode === "clarify_first" ||
    trace.contracts?.lowConfidenceStrategy === "clarify" ||
    trace.planner?.routingOutcome?.kind === "low_confidence_clarify"
  );
}

function hasToolDemand(trace: DecisionTrace): boolean {
  const contract = trace.contracts?.executionContract;
  return (
    contract?.requiresTools === true ||
    contract?.requiresWorkspaceMutation === true ||
    contract?.requiresLocalProcess === true ||
    contract?.requiresArtifactEvidence === true ||
    contract?.requiresDeliveryEvidence === true
  );
}

/**
 * Derives compact machine tags that point to the decision layer most likely to
 * have failed. Tags are diagnostic only and never change routing.
 *
 * @param trace - Decision trace assembled across classifier, planner, and runtime.
 * @returns Sorted unique error tags for logs, eval output, and debug traces.
 */
export function deriveDecisionTraceErrorTags(trace: DecisionTrace): DecisionTraceErrorTag[] {
  const tags = new Set<DecisionTraceErrorTag>();
  const toolBundles = trace.resolution?.toolBundles ?? [];
  const requestedTools = trace.requestedTools ?? [];
  const routingOutcome = trace.planner?.routingOutcome;

  if (
    hasClarifySignal(trace) &&
    (requestedTools.length > 0 || toolBundles.some((bundle) => bundle !== "respond_only"))
  ) {
    tags.add("unnecessary_clarify");
  }
  if (hasToolDemand(trace) && requestedTools.length === 0 && toolBundles.length === 0) {
    tags.add("missing_required_tool");
  }
  if (routingOutcome?.kind === "contract_unsatisfiable") {
    tags.add("bundle_recipe_mismatch");
  }
  if (
    trace.policy?.requireExplicitApproval === true &&
    trace.readiness?.status !== "approval_required" &&
    (requestedTools.includes("exec") ||
      requestedTools.includes("process") ||
      (trace.contracts?.executionContract?.requiresDeliveryEvidence ?? false))
  ) {
    tags.add("policy_denial_leak_risk");
  }
  return sortUnique(Array.from(tags)) as DecisionTraceErrorTag[];
}

/**
 * Returns a copy of the trace with error tags recomputed from current fields.
 *
 * @param trace - Partial or complete trace to finalize.
 * @returns Trace with deterministic `errorTags`.
 */
export function finalizeDecisionTrace(trace: DecisionTrace): DecisionTrace {
  const errorTags = deriveDecisionTraceErrorTags(trace);
  const { errorTags: _previousErrorTags, ...traceWithoutErrorTags } = trace;
  return {
    ...traceWithoutErrorTags,
    ...(errorTags.length > 0 ? { errorTags } : {}),
  };
}
