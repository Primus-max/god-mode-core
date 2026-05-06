import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../../config/config.js";
import { defaultRuntime } from "../../runtime.js";
import type { ExecutionCommitment } from "../commitment/execution-commitment.js";
import type { EffectId } from "../commitment/ids.js";
import {
  createClarificationPolicy,
  createIntentContractor,
  createPolicyGate,
  createShadowBuilder,
  defaultCutoverPolicy,
  defaultAffordanceRegistry,
  resolveIntentContractorConfig,
  type AffordanceRegistry,
  type ApprovalPolicyReader,
  type BudgetPolicyReader,
  type ClarificationPolicyReader,
  type CutoverPolicy,
  type EscalationHook,
  type EscalationHookFireInput,
  type ExpectedDelta,
  type InboundMediaSummary,
  type IntentContractorAdapter,
  type IntentContractorLogger,
  type MonitoredRuntime,
  type PolicyGateReader,
  type RetryPolicyReader,
  type RolePolicyReader,
  type RuntimeAttestation,
  type SemanticIntent,
} from "../commitment/index.js";
import type { ShadowBuildResult, ShadowUnsupportedReason } from "../commitment/shadow-builder.js";
import type { IdentityId } from "../identity/identity-id.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { TaskLedger } from "../task/task-ledger.js";
import type { BuildExecutionDecisionInputParams } from "./input.js";
import {
  classifyTaskForDecision,
  type ClassifiedTaskResolution,
  type TaskClassifierAdapter,
} from "./task-classifier.js";
import type {
  ClarificationPolicyDowngradeMarker,
  DecisionTrace,
  KernelDerivedDecisionMarker,
  KernelFallbackReason,
  PolicyApprovalDenialMarker,
  PolicyBudgetDenialMarker,
  PolicyEscalationFiredMarker,
  PolicyRetryDenialMarker,
  PolicyRoleDenialMarker,
} from "./trace.js";

declare const TraceIdBrand: unique symbol;
export type TraceId = string & { readonly [TraceIdBrand]: true };

export type RunTurnDecisionInput = {
  readonly prompt: string;
  readonly cfg: OpenClawConfig;
  readonly ledgerContext?: string;
  readonly fileNames?: readonly string[];
  readonly clarifyBudgetNotice?: string;
  readonly workspaceContext?: string;
  readonly identityContext?: string;
  readonly agentDir?: string;
  readonly classifierInput?: BuildExecutionDecisionInputParams;
  readonly classifierAdapterRegistry?: Readonly<Record<string, TaskClassifierAdapter>>;
  readonly intentContractorAdapterRegistry?: Readonly<Record<string, IntentContractorAdapter>>;
  readonly affordanceRegistry?: AffordanceRegistry;
  readonly cutoverPolicy?: CutoverPolicy;
  readonly monitoredRuntime?: MonitoredRuntime;
  readonly expectedDeltaResolver?: (commitment: ExecutionCommitment) => ExpectedDelta | undefined;
  /**
   * Wave B injection point for the real `PolicyGate` (master §8.5.1, sub-plan
   * §4.10). When omitted, `runShadowBranch` constructs a default real gate
   * from `input.cfg`, replacing the Wave A `allowAllPolicyGate` stub.
   */
  readonly policyGate?: PolicyGateReader;
  /**
   * Stage 1 injection point for the orthogonal Clarification PolicyGate
   * (`commitment_kernel_policy_gate_full.plan.md`). When omitted,
   * `runTurnDecision` constructs a default policy from `input.cfg` to
   * downgrade legacy classifier `clarification_needed` outcomes whose
   * deployment-target ambiguity is already resolved by the kernel-side
   * `SemanticIntent` (target=workspace, or constraints with explicit local
   * marker). Active only on the legacy fallback path; never overrides a
   * kernel-derived production decision (invariant #3).
   */
  readonly clarificationPolicy?: ClarificationPolicyReader;
  /**
   * Phase 3 — Stage 2 (Approvals) injection point per
   * `commitment_kernel_policy_gate_full.plan.md`. When omitted, the
   * approval gate is bypassed cleanly (default-allow) — Phases 4-7
   * land their respective sibling injection points
   * (`budgetPolicy`, `rolePolicy`, `retryPolicy`, `escalationHook`).
   *
   * Evaluation order (sub-plan §3 Phase 3 row d):
   *   affordance allowlist (existing, inside `runShadowBranch`)
   *   → approval (this)
   *   → budget (Phase 4)
   *   → role (Phase 5)
   *   → retry (Phase 6)
   *   → escalation hook (Phase 7, observability)
   *
   * Active only on the kernel-derived production-decision path; the
   * legacy fallback path bypasses policy gates by design (the legacy
   * classifier never reached an `EffectId`-typed commitment to gate
   * against).
   */
  readonly approvalPolicy?: ApprovalPolicyReader;
  /**
   * Phase 4 — Stage 3 (Budgets) injection point per
   * `commitment_kernel_policy_gate_full.plan.md`. When omitted, the
   * budget gate is bypassed cleanly (default-allow). Active only on
   * the kernel-derived production-decision path; the legacy fallback
   * path bypasses policy gates by design.
   *
   * Evaluation chain order (sub-plan §3 Phase 4 row d):
   *   affordance allowlist (existing, inside `runShadowBranch`)
   *   → approval (Phase 3)
   *   → budget (this)
   *   → role (Phase 5)
   *   → retry (Phase 6)
   *   → escalation hook (Phase 7, observability)
   *
   * On `within=false` the wiring helper:
   *   1. Attaches a `policyBudgetDenial` marker to the decision
   *      trace so downstream callers can join on the same `windowId`
   *      against the `policy_budget` episodic event AND the
   *      `SqliteBudgetStore` row.
   *   2. Flips `taskContract.primaryOutcome` to `"answer"` and
   *      `interactionMode` to `"respond_only"` so the downstream
   *      agent surface delivers the "budget exhausted" message
   *      instead of attempting the gated effect (mirrors clarification
   *      / approval downgrade shape).
   *
   * `channel` for the evaluate input is read from
   * `cfg.channels?._activeChannel` when present, falling back to the
   * literal string `"unknown"`. Channel-dimension rules that require
   * an exact match SHOULD set `channel` explicitly in their config
   * entry — `'unknown'` will never match a real channel string.
   */
  readonly budgetPolicy?: BudgetPolicyReader;
  /**
   * Phase 5 — Stage 4 (Role-based access) injection point per
   * `commitment_kernel_policy_gate_full.plan.md`. When omitted, the
   * role gate is bypassed cleanly (default-allow). Active only on
   * the kernel-derived production-decision path; the legacy fallback
   * path bypasses policy gates by design.
   *
   * Evaluation chain order (sub-plan §3 Phase 5 row d):
   *   affordance allowlist (existing, inside `runShadowBranch`)
   *   → approval (Phase 3)
   *   → budget (Phase 4)
   *   → role (this)
   *   → retry (Phase 6)
   *   → escalation hook (Phase 7, observability)
   *
   * On `allowed=false` the wiring helper:
   *   1. Attaches a `policyRoleDenial` marker to the decision
   *      trace so downstream callers can join on the same
   *      `requiredRole` against the `policy_role` episodic event.
   *   2. Flips `taskContract.primaryOutcome` to `"answer"` and
   *      `interactionMode` to `"respond_only"` so the downstream
   *      agent surface delivers the "role required" message instead
   *      of attempting the gated effect (mirrors clarification /
   *      approval / budget downgrade shape).
   *
   * The role gate is skipped entirely when the upstream Approval OR
   * Budget gate already denied (avoids double-emit of episodic
   * events for an effect that will not execute).
   */
  readonly rolePolicy?: RolePolicyReader;
  /**
   * Phase 6 — Stage 5 (Retry policies) injection point per
   * `commitment_kernel_policy_gate_full.plan.md`. When omitted, the
   * retry gate is bypassed cleanly (default-allow). Active only on
   * the kernel-derived production-decision path; the legacy fallback
   * path bypasses policy gates by design.
   *
   * Evaluation chain order (sub-plan §3 Phase 6 row d):
   *   affordance allowlist (existing, inside `runShadowBranch`)
   *   → approval (Phase 3)
   *   → budget (Phase 4)
   *   → role (Phase 5)
   *   → retry (this)
   *   → escalation hook (Phase 7, observability)
   *
   * On `retry=false` the wiring helper:
   *   1. Attaches a `policyRetryDenial` marker to the decision
   *      trace so downstream callers can join on
   *      `(attemptCount, maxAttempts)` against the
   *      `policy_retry` episodic event.
   *   2. Flips `taskContract.primaryOutcome` to `"answer"` and
   *      `interactionMode` to `"respond_only"` so the downstream
   *      agent surface delivers the "retry budget exhausted"
   *      message instead of attempting the gated effect (mirrors
   *      clarification / approval / budget / role downgrade shape).
   *
   * The retry gate is skipped entirely when the upstream Approval,
   * Budget, OR Role gate already denied (avoids double-emit of
   * episodic events for an effect that will not execute).
   *
   * `attemptCount` and `sessionId` are read from the optional
   * `retryContext` field on this same input. When `retryContext` is
   * absent, the gate uses `attemptCount=0` and a synthetic session
   * id so the pre-execution consultation can still observe per-effect
   * defaults — the runner-layer wrapper (sub-plan §3 Phase 6 row e)
   * is responsible for the per-attempt counter advance.
   */
  readonly retryPolicy?: RetryPolicyReader;
  /**
   * Per-turn context for the Stage 5 retry gate. Threaded by the
   * runner-layer wrapper (`src/agents/pi-embedded-runner/run/`) when
   * the same turn is being re-driven after a `terminalState=
   * transient_failure`; absent on the first attempt of a turn.
   *
   * `attemptCount` is the number of failures observed so far for
   * this `(identityId, effectId, sessionId)` triple. `sessionId` is
   * the session anchor — typically the same id the
   * `persistent_session.created` effect family uses, but the gate
   * accepts any non-empty string so non-session-bound effects can
   * still be gated.
   */
  readonly retryContext?: {
    readonly attemptCount: number;
    readonly sessionId: string;
  };
  /**
   * Phase 7 — Stage 6 (Escalation hooks) injection point per
   * `commitment_kernel_policy_gate_full.plan.md`. When omitted, no
   * escalation fires — the production decision proceeds with the
   * upstream policy denial trace marker (if any) untouched. Active
   * only on the kernel-derived production-decision path; the legacy
   * fallback path bypasses escalation by design (the legacy classifier
   * never reached an `EffectId`-typed commitment that could carry a
   * policy denial).
   *
   * Evaluation chain order (sub-plan §3 Phase 7 row d):
   *   affordance allowlist (existing, inside `runShadowBranch`)
   *   → approval (Phase 3)
   *   → budget (Phase 4)
   *   → role (Phase 5)
   *   → retry (Phase 6)
   *   → escalation hook (this — observability, not a gate)
   *
   * When ANY of the upstream policy gates denied (one of the
   * `policy*Denial` trace markers is attached), the wiring helper:
   *   1. Reads the denial reason off the trace marker.
   *   2. Calls `escalationHook.fire(...)` with the denial reason
   *      verbatim plus the canonical `(identityId, effectId, channel)`
   *      triple and a `turnId` derived from `result.traceId`.
   *   3. On `{fired: true, escalationId}` → attaches a
   *      `policyEscalationFired` marker to the decision trace so
   *      downstream callers (telemetry, eval, planner-trace dumps)
   *      can join on the same `escalationId` against the
   *      `policy_escalation` episodic event AND the
   *      `ExecApprovalManager` record raised by the same denial.
   *   4. On `{fired: false, ...}` → emits a warn log via
   *      `defaultRuntime.log` and continues — escalation failure NEVER
   *      gates the production decision (sub-plan §10 invariant #15;
   *      escalation is observability, not a gate).
   *
   * The hook is consulted ONCE per turn at most (idempotency lives
   * inside the hook impl per `(turnId, identityId, denialReason,
   * effectId)`). The wiring helper does NOT inspect the hook return
   * other than to read `escalationId` for the trace marker.
   */
  readonly escalationHook?: EscalationHook;
  /**
   * Stage 1.5 injection point (`commitment_kernel_smart_orchestrator_roadmap.plan.md`
   * §3 row 3 — PR-H session-history-aware clarify). Last successful
   * kernel-derived `SemanticIntent` for the same session within a recent
   * window (default N=5 turns). Caller is responsible for providing this
   * value from a per-session intent cache; the policy never reads raw user
   * text (invariant #6) and never reaches into a module-level cache
   * (forward-compat constraint, roadmap §4 #1).
   *
   * When omitted (cold start, no session history, or caller does not yet
   * maintain a per-session intent cache), Stage 1.5 is bypassed silently —
   * Stage 1 still runs.
   */
  readonly priorIntent?: SemanticIntent;
  /**
   * Slice E Phase 5 — commitment-runtime memory hook callback. Fires
   * AFTER the cutover gate produces a `RuntimeAttestation` (regardless
   * of `commitmentSatisfied` — the hook itself filters). Absent when
   * the gate did not produce an attestation (cutover disabled,
   * shadow unsupported, etc.) so that "no attestation" never fans out
   * to a memory write attempt with stale state.
   *
   * The callback's failure is contained: any thrown / rejected error
   * is caught here, logged via `defaultRuntime.log`, and DOES NOT
   * propagate back to the calling commitment turn (memory layer is
   * observability, not gating — invariant #15). The hook
   * implementation lives in
   * `src/agents/pi-embedded-runner/run/memory-write-on-satisfied.ts`
   * outside the frozen `src/platform/commitment/` module (invariant
   * #8); this field is the single seam through which the call site
   * threads the hook into the decision pipeline.
   */
  readonly onAttestation?: (attestation: RuntimeAttestation) => void | Promise<void>;
  /**
   * Slice E Phase 7 — recall seam. When BOTH `memoryStore` and
   * `identityId` are supplied, `runShadowBranch` threads them into
   * `createIntentContractor(...)` so the contractor's optional Phase-6
   * recall hook (the `<memory>` block) can fire. Either field absent
   * disables recall cleanly — the contractor falls back to byte-identical
   * pre-Phase-6 behaviour.
   *
   * The fields are kept on `RunTurnDecisionInput` (not on a deeper deps
   * struct) because the production caller in `input.ts` already builds
   * the input object turn-by-turn; threading them through the existing
   * surface is the smallest possible change that closes B1 (memory
   * across `/new`).
   */
  readonly memoryStore?: MemoryStore;
  readonly identityId?: IdentityId;
  /**
   * Slice E Phase 7 — optional structural logger forwarded to
   * `createIntentContractor` so memory-recall warnings (e.g. sqlite
   * locked, embedder timeout) are observable without coupling the
   * decision layer to a specific logger implementation. When omitted,
   * recall failures degrade silently (per invariant #15 — recall is
   * observability, not a hard fault).
   */
  readonly memoryLogger?: IntentContractorLogger;
  /**
   * Slice F Phase 5 — optional task ledger surface threaded through
   * the production wiring helper (`memory-wiring.ts` Strategy A).
   * Phase 5 ships the field as a thread-through: the wiring layer
   * reads it from `MemoryRuntime`, and the contractor does NOT
   * consume it yet (Phase 6 lights up the `<active_tasks>` block).
   * When absent, the task hook stays inert; when present it is
   * available for downstream phases that wire recall.
   */
  readonly taskLedger?: TaskLedger;
  /**
   * Cutover-3 Phase 6 — optional inbound-media resolver threaded into
   * `createIntentContractor` so the contractor's `<inbound_attachments>`
   * block fires when an inbound TG attachment arrives this turn. The
   * resolver returns STRUCTURAL metadata only (path + MIME type +
   * closed `kind` enumeration) — never raw user text (invariants
   * #5/#6). When the field is absent OR the resolver returns
   * `undefined` / empty, the block is elided cleanly (zero whitespace
   * pollution; pre-Phase-6 byte-identical behaviour for all existing
   * callers — frozen-layer ADDITIVE constraint, cutover-2 PR-#104 /
   * slice E P6 / slice F P6 precedent).
   *
   * Production wiring (gateway / agent-command bridge) supplies a
   * resolver that reads from the same upstream source
   * `appendInboundFilesContext` consumes (`agent-command.ts:471-492`).
   * The plain-text injection at that site is preserved (LLM-readable
   * surface); the new resolver is the contractor-readable surface.
   */
  readonly inboundMediaResolver?: () => InboundMediaSummary | undefined;
};

export type RunTurnDecisionResult = {
  /**
   * Raw classifier output without shadow trace or cutover-gate decoration.
   * Reserved for telemetry, eval snapshots, and shadow comparison only —
   * production call-sites must read `productionDecision`.
   */
  readonly legacyDecision: ClassifiedTaskResolution;
  /**
   * Decision routed to downstream production code. Equal to a kernel-derived
   * `ClassifiedTaskResolution` when the cutover gate fires `gate_in_success`
   * (and the commitment is satisfied), otherwise a copy of `legacyDecision`
   * decorated with `kernelFallback=true` plus the matching `fallbackReason`.
   */
  readonly productionDecision: ClassifiedTaskResolution;
  readonly shadowCommitment: ShadowBuildResult;
  readonly cutoverGate: CutoverGateTrace;
  readonly runtimeAttestation?: RuntimeAttestation;
  readonly kernelFallback: boolean;
  readonly fallbackReason?: KernelFallbackReason;
  readonly traceId: TraceId;
  /**
   * Kernel-derived `SemanticIntent` from `IntentContractor` (when shadow
   * branch produced one). Exposed so caller-layer per-session intent caches
   * (PR-H Phase 2 — `commitment_kernel_clarification_history_aware.plan.md`)
   * can record this turn's intent for future Stage 1.5 lookups. Absent when
   * shadow branch failed or timed out.
   */
  readonly intent?: SemanticIntent;
  /**
   * Kernel-derived `ExecutionCommitment` surfaced from the shadow branch on
   * the kernel-source-of-truth path (`gate_in_success` + `commitmentSatisfied`).
   * Absent on legacy fallback. Exposed for the Search-Composer Phase 4b''-e
   * caller wiring (`commitment_kernel_search_composer_pipeline.plan.md` §8.5),
   * which gates the two-affordance dispatch (specialist → composer) on
   * `isWebResearchFamilyEffect(derivedCommitment.effect)`. Outside that
   * branch, the existing single-LLM flow runs untouched.
   */
  readonly derivedCommitment?: ExecutionCommitment;
};

export type CutoverGateTrace =
  | {
      readonly kind: "gate_out";
      readonly reason: "cutover_disabled" | "shadow_unsupported" | "effect_not_eligible";
      readonly effect?: EffectId;
    }
  | {
      readonly kind: "gate_in_success";
      readonly effect: EffectId;
      readonly terminalState: RuntimeAttestation["terminalState"];
      readonly acceptanceReason: RuntimeAttestation["acceptanceReason"];
    }
  | {
      readonly kind: "gate_in_fail";
      readonly effect: EffectId;
      readonly terminalState: RuntimeAttestation["terminalState"];
      readonly acceptanceReason: RuntimeAttestation["acceptanceReason"];
    }
  | {
      readonly kind: "gate_in_uncertain";
      readonly reason:
        | "affordance_unavailable"
        | "expected_delta_unavailable"
        | "monitored_runtime_unavailable"
        | "monitored_runtime_error";
      readonly effect: EffectId;
    };

type DecisionTraceWithCutoverGate = DecisionTrace & {
  readonly cutoverGate: CutoverGateTrace;
};

type ShadowBranchOutcome = {
  readonly result: ShadowBuildResult;
  readonly intent?: SemanticIntent;
};

/**
 * Runs legacy decision and commitment shadow branches side by side, then
 * derives a production decision through the cutover gate (kernel-source on
 * `gate_in_success`+`commitmentSatisfied`, legacy-with-fallback otherwise).
 *
 * @param input - Prompt plus legacy classifier and shadow adapter context.
 * @returns Both raw legacy decision and routed production decision, plus
 *   shadow commitment, cutover gate, and (when available) runtime attestation.
 */
export async function runTurnDecision(input: RunTurnDecisionInput): Promise<RunTurnDecisionResult> {
  const traceId = newTraceId();
  const legacy = classifyTaskForDecision({
    prompt: input.prompt,
    fileNames: [...(input.fileNames ?? [])],
    ...(input.ledgerContext ? { ledgerContext: input.ledgerContext } : {}),
    ...(input.clarifyBudgetNotice ? { clarifyBudgetNotice: input.clarifyBudgetNotice } : {}),
    ...(input.workspaceContext ? { workspaceContext: input.workspaceContext } : {}),
    ...(input.identityContext ? { identityContext: input.identityContext } : {}),
    cfg: input.cfg,
    ...(input.agentDir ? { agentDir: input.agentDir } : {}),
    ...(input.classifierInput ? { input: input.classifierInput } : {}),
    ...(input.classifierAdapterRegistry
      ? { adapterRegistry: input.classifierAdapterRegistry }
      : {}),
  });
  const shadow = runShadowBranch(input);

  const [legacySettled, shadowSettled] = await Promise.allSettled([legacy, shadow]);
  if (legacySettled.status === "rejected") {
    throw legacySettled.reason;
  }
  const legacyDecision = legacySettled.value;
  const shadowOutcome: ShadowBranchOutcome =
    shadowSettled.status === "fulfilled"
      ? shadowSettled.value
      : { result: unsupported("shadow_runtime_error") };
  const shadowCommitment = shadowOutcome.result;
  const cutover = await evaluateCutoverGate(input, shadowCommitment);

  const isKernelDerived =
    cutover.gate.kind === "gate_in_success" && cutover.attestation?.commitmentSatisfied === true;

  const baseProductionDecision = isKernelDerived
    ? deriveDecisionFromCommitment({
        legacyDecision,
        shadowCommitment,
        cutoverGate: cutover.gate,
        attestation: cutover.attestation!,
      })
    : attachLegacyFallbackTrace({
        legacyDecision,
        shadowCommitment,
        cutoverGate: cutover.gate,
        fallbackReason: resolveFallbackReason(shadowCommitment, cutover.gate),
      });

  const decisionAfterClarify = isKernelDerived
    ? baseProductionDecision
    : await maybeDowngradeClarification({
        input,
        productionDecision: baseProductionDecision,
        intent: shadowOutcome.intent,
      });

  // Phase 3 — Stage 2 (Approvals). Active only on the kernel-derived
  // path: the legacy fallback never reaches an `EffectId`-typed
  // commitment, so there is nothing to gate. On denial, the helper
  // returns a decision with `taskContract.primaryOutcome="answer"` +
  // `interactionMode="respond_only"` (mirrors clarification downgrade
  // shape) plus a `policyApprovalDenial` trace marker carrying the
  // closed `requires_approval` reason and the sibling-reused
  // `ExecApprovalManager` request id. Log + episodic emission happen
  // INSIDE `approvalPolicy.evaluate(...)` — see `approval-policy.ts`.
  const decisionAfterApproval = isKernelDerived
    ? await maybeBlockOnApproval({
        input,
        productionDecision: decisionAfterClarify,
        shadowCommitment,
      })
    : decisionAfterClarify;

  // Phase 4 — Stage 3 (Budgets). Runs only on the kernel-derived path
  // AND only when the prior Approval gate did NOT already deny (we
  // detect a prior denial via the `policyApprovalDenial` trace
  // marker — chaining a budget check on top of an already-denied
  // turn would double-charge the per-user budget for a turn that
  // never executes). On `within=false` the helper attaches a
  // `policyBudgetDenial` trace marker and downgrades the decision
  // to answer/respond_only. Log + episodic emission happen INSIDE
  // `budgetPolicy.evaluate(...)` — see `budget-policy.ts`.
  const decisionAfterBudget = isKernelDerived
    ? await maybeBlockOnBudget({
        input,
        productionDecision: decisionAfterApproval,
        shadowCommitment,
      })
    : decisionAfterApproval;

  // Phase 5 — Stage 4 (Role-based access). Runs only on the
  // kernel-derived path AND only when neither the prior Approval gate
  // NOR the prior Budget gate already denied (`policyApprovalDenial`
  // / `policyBudgetDenial` trace markers act as the
  // already-denied signal — a role check on top of an
  // already-denied turn would double-emit the episodic event for an
  // effect that will not execute). On `allowed=false` the helper
  // attaches a `policyRoleDenial` trace marker and downgrades the
  // decision to answer/respond_only. Log + episodic emission happen
  // INSIDE `rolePolicy.evaluate(...)` — see `role-policy.ts`.
  const decisionAfterRole = isKernelDerived
    ? await maybeBlockOnRole({
        input,
        productionDecision: decisionAfterBudget,
        shadowCommitment,
      })
    : decisionAfterBudget;

  // Phase 6 — Stage 5 (Retry policies). Runs only on the
  // kernel-derived path AND only when none of the prior Approval /
  // Budget / Role gates already denied (any `policy*Denial` trace
  // marker acts as the already-denied signal). On `retry=false`
  // the helper attaches a `policyRetryDenial` trace marker and
  // downgrades the decision to answer/respond_only. Log + episodic
  // emission happen INSIDE `retryPolicy.evaluate(...)` — see
  // `retry-policy.ts`. The runner-layer wrapper
  // (`src/agents/pi-embedded-runner/run/`) is responsible for the
  // per-attempt counter advance against the same
  // `RetryStateStore`; this seam is the pre-execution consultation
  // (sub-plan §3 Phase 6 row d).
  const decisionAfterRetry = isKernelDerived
    ? await maybeBlockOnRetry({
        input,
        productionDecision: decisionAfterRole,
        shadowCommitment,
      })
    : decisionAfterRole;

  // Phase 7 — Stage 6 (Escalation hook). Runs only on the
  // kernel-derived path AND only when at least one upstream policy
  // gate already denied (the hook is observability for denials, not
  // a denial source itself). Failure inside the hook NEVER alters
  // the production decision — escalation is observability, not
  // gating (sub-plan §10 invariant #3 footnote).
  const productionDecision = isKernelDerived
    ? await maybeFireEscalation({
        input,
        productionDecision: decisionAfterRetry,
        shadowCommitment,
        traceId,
      })
    : decisionAfterRetry;

  const fallbackReason = isKernelDerived
    ? undefined
    : resolveFallbackReason(shadowCommitment, cutover.gate);

  // Slice E Phase 5 — fire the commitment-runtime memory hook callback
  // when the gate produced a `RuntimeAttestation`. The callback (set by
  // the pi-embedded-runner orchestration via
  // `recordMemoryOnCommitmentSatisfied`) filters internally on
  // `commitmentSatisfied === true` plus identity / store presence; this
  // call site forwards the attestation unconditionally so absence of a
  // gate result never reaches the hook. Failures stay local —
  // memory-layer outages MUST NOT break the commitment turn (invariant
  // #15).
  if (input.onAttestation && cutover.attestation) {
    try {
      await input.onAttestation(cutover.attestation);
    } catch (error) {
      defaultRuntime.log(
        `[memory-hook] onAttestation callback failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return {
    legacyDecision,
    productionDecision,
    shadowCommitment,
    cutoverGate: cutover.gate,
    ...(cutover.attestation ? { runtimeAttestation: cutover.attestation } : {}),
    kernelFallback: !isKernelDerived,
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(shadowOutcome.intent ? { intent: shadowOutcome.intent } : {}),
    ...(isKernelDerived && shadowCommitment.kind === "commitment"
      ? { derivedCommitment: shadowCommitment.value }
      : {}),
    traceId,
  };
}

async function runShadowBranch(input: RunTurnDecisionInput): Promise<ShadowBranchOutcome> {
  const config = resolveIntentContractorConfig({ cfg: input.cfg });
  try {
    return await withTimeout(
      (async () => {
        const intentContractor = createIntentContractor({
          cfg: input.cfg,
          fileNames: input.fileNames,
          ledgerContext: input.ledgerContext,
          agentDir: input.agentDir,
          adapterRegistry: input.intentContractorAdapterRegistry,
          // Slice E Phase 7 — wire the memory recall seam introduced in
          // Phase 6. Both fields are optional; the contractor disables
          // recall cleanly when either is absent (anonymous session OR
          // caller has not threaded a store yet). This is the single
          // production wiring point that closes B1 — without it, the
          // Phase-6 recall surface stays inert at runtime even though
          // its tests pass in isolation.
          ...(input.memoryStore ? { memoryStore: input.memoryStore } : {}),
          // Slice F Phase 6 — thread the optional task ledger through the
          // same recall seam the memory store rides on. The contractor
          // self-elides the `<active_tasks>` block when either the
          // ledger OR `identityId` is missing (anonymous session or
          // pre-Phase-6 caller). Mirrors the memory-store wiring above.
          ...(input.taskLedger ? { taskLedger: input.taskLedger } : {}),
          ...(input.identityId ? { identityId: input.identityId } : {}),
          ...(input.memoryLogger ? { logger: input.memoryLogger } : {}),
          // Cutover-3 Phase 6 — thread the optional inbound-media
          // resolver through to the contractor's `<inbound_attachments>`
          // block hook. Absent resolver = block elided cleanly
          // (pre-Phase-6 byte-identical behaviour for callers that
          // have not yet threaded the seam).
          ...(input.inboundMediaResolver
            ? { inboundMediaResolver: input.inboundMediaResolver }
            : {}),
          onDebugEvent: (event) => {
            const parts: string[] = [
              `[intent-contractor] stage=${event.stage}`,
              `backend=${event.backend}`,
              `model=${event.modelId ?? event.configuredModel}`,
            ];
            if (event.parseResult) parts.push(`parseResult=${event.parseResult}`);
            if (event.parseErrorMessage) {
              parts.push(`parseError=${truncateForLog(event.parseErrorMessage, 120)}`);
            }
            if (event.message) parts.push(`message=${truncateForLog(event.message, 120)}`);
            if (event.rawText !== undefined) {
              parts.push(`rawTextLen=${String(event.rawText.length)}`);
              if (event.parseResult && event.parseResult !== "ok") {
                parts.push(`rawText="${truncateForLog(event.rawText, 240)}"`);
              }
            }
            defaultRuntime.log(parts.join(" "));
          },
        });
        const shadowBuilder = createShadowBuilder({
          affordances: input.affordanceRegistry ?? defaultAffordanceRegistry,
          policy: input.policyGate ?? createPolicyGate({ cfg: input.cfg }),
          logger: {},
          confidenceThreshold: config.confidenceThreshold,
        });
        const intent = await intentContractor.classify(input.prompt);
        const result = await shadowBuilder.build(intent);
        return { result, intent };
      })(),
      config.timeoutMs,
    );
  } catch (error) {
    return {
      result: unsupported(isTimeoutError(error) ? "shadow_timeout" : "shadow_runtime_error"),
    };
  }
}

async function evaluateCutoverGate(
  input: RunTurnDecisionInput,
  shadowCommitment: ShadowBuildResult,
): Promise<{ gate: CutoverGateTrace; attestation?: RuntimeAttestation }> {
  if (!isCutoverEnabled(input.cfg)) {
    return { gate: { kind: "gate_out", reason: "cutover_disabled" } };
  }
  if (shadowCommitment.kind !== "commitment") {
    return { gate: { kind: "gate_out", reason: "shadow_unsupported" } };
  }

  const commitment = shadowCommitment.value;
  const cutoverPolicy = input.cutoverPolicy ?? defaultCutoverPolicy;
  if (!cutoverPolicy.isEligible(commitment.effect)) {
    return {
      gate: {
        kind: "gate_out",
        reason: "effect_not_eligible",
        effect: commitment.effect,
      },
    };
  }

  const affordance = (input.affordanceRegistry ?? defaultAffordanceRegistry)
    .all()
    .find((entry) => entry.effect === commitment.effect);
  if (!affordance) {
    return {
      gate: {
        kind: "gate_in_uncertain",
        reason: "affordance_unavailable",
        effect: commitment.effect,
      },
    };
  }

  const monitoredRuntime = input.monitoredRuntime;
  if (!monitoredRuntime) {
    return {
      gate: {
        kind: "gate_in_uncertain",
        reason: "monitored_runtime_unavailable",
        effect: commitment.effect,
      },
    };
  }

  const expectedDelta = input.expectedDeltaResolver?.(commitment);
  if (!expectedDelta) {
    return {
      gate: {
        kind: "gate_in_uncertain",
        reason: "expected_delta_unavailable",
        effect: commitment.effect,
      },
    };
  }

  try {
    const attestation = await monitoredRuntime.run({
      commitment,
      affordance,
      expectedDelta,
    });
    return {
      gate: {
        kind: attestation.commitmentSatisfied ? "gate_in_success" : "gate_in_fail",
        effect: commitment.effect,
        terminalState: attestation.terminalState,
        acceptanceReason: attestation.acceptanceReason,
      },
      attestation,
    };
  } catch {
    return {
      gate: {
        kind: "gate_in_uncertain",
        reason: "monitored_runtime_error",
        effect: commitment.effect,
      },
    };
  }
}

/**
 * Builds the kernel-source-of-truth `productionDecision` for a turn whose
 * commitment was both eligible for cutover and satisfied by the runtime.
 * The underlying `taskContract` and `plannerInput` shape stay legacy-derived
 * for PR-4a (`persistent_session.created` only); the kernel contributes the
 * `kernelDerived` trace marker (effect, terminal state, acceptance reason).
 *
 * @param params - Legacy decision plus shadow + cutover gate + attestation.
 * @returns A `ClassifiedTaskResolution` distinct from `legacyDecision` whose
 *   `decisionTrace.kernelDerived.sourceOfTruth === "kernel"`.
 */
function deriveDecisionFromCommitment(params: {
  legacyDecision: ClassifiedTaskResolution;
  shadowCommitment: ShadowBuildResult;
  cutoverGate: CutoverGateTrace;
  attestation: RuntimeAttestation;
}): ClassifiedTaskResolution {
  const commitment = extractCommitment(params.shadowCommitment);
  const kernelDerived: KernelDerivedDecisionMarker = {
    sourceOfTruth: "kernel",
    effect: commitment.effect,
    terminalState: params.attestation.terminalState,
    acceptanceReason: params.attestation.acceptanceReason,
  };
  const previousTrace = params.legacyDecision.plannerInput.decisionTrace;
  const decisionTrace: DecisionTraceWithCutoverGate = {
    version: 1,
    ...previousTrace,
    shadowCommitment: params.shadowCommitment,
    cutoverGate: params.cutoverGate,
    kernelDerived,
    kernelFallback: false,
  };
  return {
    ...params.legacyDecision,
    plannerInput: {
      ...params.legacyDecision.plannerInput,
      decisionTrace,
    },
  };
}

/**
 * Builds the legacy-fallback `productionDecision` for a turn whose commitment
 * could not be promoted to kernel source-of-truth (cutover disabled, effect
 * out of policy, runtime/expected-delta unavailable, runtime error, or
 * `commitmentSatisfied=false`). The decision is structurally legacy plus a
 * `kernelFallback=true` trace flag and the matching `fallbackReason`.
 *
 * @param params - Legacy decision plus shadow + cutover gate + reason.
 * @returns A `ClassifiedTaskResolution` distinct from `legacyDecision` whose
 *   `decisionTrace.kernelFallback === true`.
 */
function attachLegacyFallbackTrace(params: {
  legacyDecision: ClassifiedTaskResolution;
  shadowCommitment: ShadowBuildResult;
  cutoverGate: CutoverGateTrace;
  fallbackReason: KernelFallbackReason;
}): ClassifiedTaskResolution {
  const previousTrace = params.legacyDecision.plannerInput.decisionTrace;
  const decisionTrace: DecisionTraceWithCutoverGate = {
    version: 1,
    ...previousTrace,
    shadowCommitment: params.shadowCommitment,
    cutoverGate: params.cutoverGate,
    kernelFallback: true,
    fallbackReason: params.fallbackReason,
  };
  return {
    ...params.legacyDecision,
    plannerInput: {
      ...params.legacyDecision.plannerInput,
      decisionTrace,
    },
  };
}

/**
 * Maps the cutover-gate outcome to the matching `KernelFallbackReason` so
 * observers can distinguish "shadow gave up" from "runtime unavailable" from
 * "commitment refused" without re-reading the gate trace.
 *
 * @param shadowCommitment - Shadow build result for this turn.
 * @param gate - Cutover gate trace produced by `evaluateCutoverGate`.
 * @returns The reason emitted as `RunTurnDecisionResult.fallbackReason`.
 */
function resolveFallbackReason(
  shadowCommitment: ShadowBuildResult,
  gate: CutoverGateTrace,
): KernelFallbackReason {
  if (shadowCommitment.kind === "unsupported") {
    return shadowCommitment.reason;
  }
  switch (gate.kind) {
    case "gate_out":
      return gate.reason === "shadow_unsupported" ? "shadow_runtime_error" : gate.reason;
    case "gate_in_uncertain":
      return gate.reason;
    case "gate_in_fail":
      return "commitment_unsatisfied";
    case "gate_in_success":
      return "commitment_unsatisfied";
  }
}

/**
 * Applies the Stage 1 ClarificationPolicy gate to the legacy fallback decision.
 * Active only when the production decision still carries `lowConfidenceStrategy
 * === "clarify"` (so kernel-derived success paths and non-clarify legacy paths
 * are bypassed). When the gate downgrades, returns a copy of the decision with
 * `taskContract.primaryOutcome="answer"`, `interactionMode="respond_only"`,
 * cleared `lowConfidenceStrategy`, and an observability marker in
 * `decisionTrace.clarificationPolicy`. Otherwise the decision is returned
 * unchanged.
 *
 * @param params - Original production decision plus optional kernel-side intent.
 * @returns Possibly-downgraded production decision.
 */
async function maybeDowngradeClarification(params: {
  readonly input: RunTurnDecisionInput;
  readonly productionDecision: ClassifiedTaskResolution;
  readonly intent?: SemanticIntent;
}): Promise<ClassifiedTaskResolution> {
  const { input, productionDecision, intent } = params;
  if (!intent) {
    return productionDecision;
  }
  if (productionDecision.plannerInput.lowConfidenceStrategy !== "clarify") {
    return productionDecision;
  }
  const blockingReasons = collectBlockingClarificationReasons(productionDecision);
  if (blockingReasons.length === 0) {
    return productionDecision;
  }
  const gate = input.clarificationPolicy ?? createClarificationPolicy({ cfg: input.cfg });
  const decision = await gate.evaluate({
    intent,
    blockingReasons,
    ...(input.priorIntent ? { priorIntent: input.priorIntent } : {}),
  });
  if (decision.shouldClarify) {
    return productionDecision;
  }
  const marker: ClarificationPolicyDowngradeMarker = {
    downgradeReason: decision.downgradeReason,
    ...(decision.inheritedFields && decision.inheritedFields.length > 0
      ? { inheritedFields: decision.inheritedFields }
      : {}),
  };
  return downgradeClarifyToAnswer(productionDecision, marker);
}

/**
 * Phase 3 — Stage 2 (Approvals) wiring helper. Runs ONLY when the
 * caller injected an `approvalPolicy` AND the shadow commitment
 * resolved to a kernel-derived `ExecutionCommitment`. On
 * `approved=false` the helper:
 *
 *   1. Attaches a `policyApprovalDenial` marker to the decision trace
 *      so downstream callers (telemetry, eval, planner-trace dumps)
 *      can join on `approvalRequestId` against the
 *      `policy_approval` episodic event AND the
 *      `ExecApprovalManager` record raised by the same denial.
 *   2. Flips `taskContract.primaryOutcome` to `"answer"` and
 *      `interactionMode` to `"respond_only"` so the downstream agent
 *      surface delivers the "approval pending" message instead of
 *      attempting the gated effect (mirrors the clarification
 *      downgrade shape).
 *
 * The log line `[policy-gate] event=approval_checked …` and the
 * `[policy-gate] event=approval_request_created …` line are emitted
 * INSIDE `approvalPolicy.evaluate(...)` — see
 * `src/platform/commitment/approval-policy.ts`. The episodic event
 * emit + `ExecApprovalManager.create(...)` sibling-reuse also happen
 * inside the policy reader; this wiring helper only translates the
 * decision into the production-decision shape.
 *
 * @param params - Wiring input + the kernel-derived production decision
 *   + the shadow build result (for the `ExecutionCommitment.effect`).
 * @returns Possibly-downgraded production decision.
 */
async function maybeBlockOnApproval(params: {
  readonly input: RunTurnDecisionInput;
  readonly productionDecision: ClassifiedTaskResolution;
  readonly shadowCommitment: ShadowBuildResult;
}): Promise<ClassifiedTaskResolution> {
  const { input, productionDecision, shadowCommitment } = params;
  if (!input.approvalPolicy) {
    return productionDecision;
  }
  if (shadowCommitment.kind !== "commitment") {
    return productionDecision;
  }
  const effectId = shadowCommitment.value.effect;
  const decision = await input.approvalPolicy.evaluate({
    effectId,
    ...(input.identityId ? { identityId: input.identityId } : {}),
  });
  if (decision.approved) {
    return productionDecision;
  }
  const marker: PolicyApprovalDenialMarker = {
    stage: "approval",
    reason: decision.reason,
    effectId,
    approvalRequestId: String(decision.approvalRequestId),
  };
  return downgradeOnApprovalDenial(productionDecision, marker);
}

/**
 * Phase 4 — Stage 3 (Budgets) wiring helper. Mirrors the structure
 * of `maybeBlockOnApproval`. Runs ONLY when the caller injected a
 * `budgetPolicy` AND the shadow commitment resolved to a
 * kernel-derived `ExecutionCommitment` AND the upstream Approval
 * gate did NOT already deny (skipping budget on an already-denied
 * turn keeps the per-user counter aligned with actual execution
 * intent).
 *
 * On `within=false` the helper:
 *   1. Attaches a `policyBudgetDenial` marker to the decision trace
 *      so downstream callers (telemetry, eval, planner-trace dumps)
 *      can join on `windowId` against the `policy_budget` episodic
 *      event AND the `SqliteBudgetStore` row.
 *   2. Flips `taskContract.primaryOutcome` to `"answer"` and
 *      `interactionMode` to `"respond_only"` so the downstream
 *      agent surface delivers the "budget exhausted" message
 *      instead of attempting the gated effect.
 *
 * Log + episodic emission happen INSIDE
 * `budgetPolicy.evaluate(...)` — see `budget-policy.ts`. This
 * wiring helper only translates the decision into the
 * production-decision shape.
 *
 * The `channel` value passed to `evaluate` is taken from
 * `cfg.channels?._activeChannel` when present, falling back to the
 * literal string `"unknown"`. Channel-dimension rules that need an
 * exact match SHOULD set the channel explicitly in their config
 * entry; the `'unknown'` fallback is intentional — a config rule
 * keyed on `'unknown'` would only match wiring paths that did not
 * thread an active channel.
 */
async function maybeBlockOnBudget(params: {
  readonly input: RunTurnDecisionInput;
  readonly productionDecision: ClassifiedTaskResolution;
  readonly shadowCommitment: ShadowBuildResult;
}): Promise<ClassifiedTaskResolution> {
  const { input, productionDecision, shadowCommitment } = params;
  if (!input.budgetPolicy) {
    return productionDecision;
  }
  if (shadowCommitment.kind !== "commitment") {
    return productionDecision;
  }
  // Skip budget when Approval already denied — the turn will not
  // execute the gated effect, so charging the budget would over-count.
  const trace = productionDecision.plannerInput.decisionTrace as
    | { readonly policyApprovalDenial?: PolicyApprovalDenialMarker }
    | undefined;
  if (trace?.policyApprovalDenial) {
    return productionDecision;
  }
  const effectId = shadowCommitment.value.effect;
  const channel = resolveActiveChannelForBudget(input.cfg);
  const decision = await input.budgetPolicy.evaluate({
    effectId,
    channel,
    ...(input.identityId ? { identityId: input.identityId } : {}),
  });
  if (decision.within) {
    return productionDecision;
  }
  const marker: PolicyBudgetDenialMarker = {
    stage: "budget",
    reason: decision.reason,
    effectId,
    windowId: String(decision.windowId),
    used: decision.used,
    limit: decision.limit,
  };
  return downgradeOnBudgetDenial(productionDecision, marker);
}

function downgradeOnBudgetDenial(
  legacy: ClassifiedTaskResolution,
  marker: PolicyBudgetDenialMarker,
): ClassifiedTaskResolution {
  const previousTrace = legacy.plannerInput.decisionTrace;
  const decisionTrace: DecisionTrace = {
    version: 1,
    ...previousTrace,
    policyBudgetDenial: marker,
  };
  const taskContract = {
    ...legacy.taskContract,
    primaryOutcome: "answer" as const,
    interactionMode: "respond_only" as const,
  };
  const { lowConfidenceStrategy: _droppedStrategy, ...plannerInputRest } = legacy.plannerInput;
  return {
    ...legacy,
    taskContract,
    plannerInput: {
      ...plannerInputRest,
      decisionTrace,
    },
  };
}

/**
 * Phase 5 — Stage 4 (Role-based access) wiring helper. Mirrors the
 * structure of `maybeBlockOnApproval` / `maybeBlockOnBudget`. Runs
 * ONLY when the caller injected a `rolePolicy` AND the shadow
 * commitment resolved to a kernel-derived `ExecutionCommitment` AND
 * neither the upstream Approval gate NOR the upstream Budget gate
 * already denied (skipping role on an already-denied turn keeps the
 * episodic stream and trace clean — only one denial reason per turn,
 * carried by the gate that actually fired first).
 *
 * On `allowed=false` the helper:
 *   1. Attaches a `policyRoleDenial` marker to the decision trace
 *      so downstream callers (telemetry, eval, planner-trace dumps)
 *      can join on `requiredRole` against the `policy_role`
 *      episodic event.
 *   2. Flips `taskContract.primaryOutcome` to `"answer"` and
 *      `interactionMode` to `"respond_only"` so the downstream
 *      agent surface delivers the "role required" message instead
 *      of attempting the gated effect.
 *
 * Log + episodic emission happen INSIDE
 * `rolePolicy.evaluate(...)` — see `role-policy.ts`. This wiring
 * helper only translates the decision into the production-decision
 * shape.
 *
 * Anonymous turns (no `identityId` threaded through
 * `RunTurnDecisionInput`) flow through the gate — `role-policy.ts`
 * fail-closes for anonymous identities AND the wiring helper still
 * downgrades the decision (the gate is a denial gate, not an
 * identification gate).
 */
async function maybeBlockOnRole(params: {
  readonly input: RunTurnDecisionInput;
  readonly productionDecision: ClassifiedTaskResolution;
  readonly shadowCommitment: ShadowBuildResult;
}): Promise<ClassifiedTaskResolution> {
  const { input, productionDecision, shadowCommitment } = params;
  if (!input.rolePolicy) {
    return productionDecision;
  }
  if (shadowCommitment.kind !== "commitment") {
    return productionDecision;
  }
  // Skip role gate when Approval OR Budget already denied — the turn
  // will not execute the gated effect, so re-checking role would
  // double-emit the policy episodic event without changing the
  // outcome.
  const trace = productionDecision.plannerInput.decisionTrace as
    | {
        readonly policyApprovalDenial?: PolicyApprovalDenialMarker;
        readonly policyBudgetDenial?: PolicyBudgetDenialMarker;
      }
    | undefined;
  if (trace?.policyApprovalDenial || trace?.policyBudgetDenial) {
    return productionDecision;
  }
  const effectId = shadowCommitment.value.effect;
  const decision = await input.rolePolicy.evaluate({
    effectId,
    // Cast through the structurally-optional shape the wiring layer
    // uses — `RolePolicyEvaluateInput` formally requires `identityId`,
    // but the production caller may thread an anonymous turn (no
    // `identityId` on `RunTurnDecisionInput`). The reader's anonymous
    // fail-closed path defends against the structural-undefined leak.
    ...(input.identityId ? { identityId: input.identityId } : ({} as { identityId: IdentityId })),
  });
  if (decision.allowed) {
    return productionDecision;
  }
  const marker: PolicyRoleDenialMarker = {
    stage: "role",
    reason: decision.reason,
    effectId,
    requiredRole: String(decision.requiredRole),
  };
  return downgradeOnRoleDenial(productionDecision, marker);
}

function downgradeOnRoleDenial(
  legacy: ClassifiedTaskResolution,
  marker: PolicyRoleDenialMarker,
): ClassifiedTaskResolution {
  const previousTrace = legacy.plannerInput.decisionTrace;
  const decisionTrace: DecisionTrace = {
    version: 1,
    ...previousTrace,
    policyRoleDenial: marker,
  };
  const taskContract = {
    ...legacy.taskContract,
    primaryOutcome: "answer" as const,
    interactionMode: "respond_only" as const,
  };
  const { lowConfidenceStrategy: _droppedStrategy, ...plannerInputRest } = legacy.plannerInput;
  return {
    ...legacy,
    taskContract,
    plannerInput: {
      ...plannerInputRest,
      decisionTrace,
    },
  };
}

/**
 * Phase 6 — Stage 5 (Retry policies) wiring helper. Mirrors the
 * structure of `maybeBlockOnApproval` / `maybeBlockOnBudget` /
 * `maybeBlockOnRole`. Runs ONLY when the caller injected a
 * `retryPolicy` AND the shadow commitment resolved to a
 * kernel-derived `ExecutionCommitment` AND none of the upstream
 * Approval / Budget / Role gates already denied (skipping retry on
 * an already-denied turn keeps the episodic stream and trace clean
 * — only one denial reason per turn, carried by the gate that
 * actually fired first).
 *
 * On `retry=false` the helper:
 *   1. Attaches a `policyRetryDenial` marker to the decision trace
 *      so downstream callers (telemetry, eval, planner-trace dumps)
 *      can join on `(attemptCount, maxAttempts)` against the
 *      `policy_retry` episodic event.
 *   2. Flips `taskContract.primaryOutcome` to `"answer"` and
 *      `interactionMode` to `"respond_only"` so the downstream
 *      agent surface delivers the "retry budget exhausted" message
 *      instead of attempting the gated effect.
 *
 * Log + episodic emission happen INSIDE
 * `retryPolicy.evaluate(...)` — see `retry-policy.ts`. This wiring
 * helper only translates the decision into the production-decision
 * shape.
 *
 * `attemptCount` and `sessionId` are read from
 * `RunTurnDecisionInput.retryContext`. When the field is absent the
 * pre-execution consultation runs with `attemptCount=0` and a
 * synthetic session id derived from the trace id — the gate then
 * always returns `retry: true` for an unconfigured turn (0 < any
 * `maxAttempts >= 1`); the runner-layer wrapper drives the actual
 * per-attempt advance separately.
 */
async function maybeBlockOnRetry(params: {
  readonly input: RunTurnDecisionInput;
  readonly productionDecision: ClassifiedTaskResolution;
  readonly shadowCommitment: ShadowBuildResult;
}): Promise<ClassifiedTaskResolution> {
  const { input, productionDecision, shadowCommitment } = params;
  if (!input.retryPolicy) {
    return productionDecision;
  }
  if (shadowCommitment.kind !== "commitment") {
    return productionDecision;
  }
  // Skip retry gate when an upstream gate already denied — the turn
  // will not execute the gated effect, so re-checking retry would
  // double-emit the policy episodic event without changing the
  // outcome.
  const trace = productionDecision.plannerInput.decisionTrace as
    | {
        readonly policyApprovalDenial?: PolicyApprovalDenialMarker;
        readonly policyBudgetDenial?: PolicyBudgetDenialMarker;
        readonly policyRoleDenial?: PolicyRoleDenialMarker;
      }
    | undefined;
  if (trace?.policyApprovalDenial || trace?.policyBudgetDenial || trace?.policyRoleDenial) {
    return productionDecision;
  }
  const effectId = shadowCommitment.value.effect;
  const attemptCount = input.retryContext?.attemptCount ?? 0;
  const sessionId = input.retryContext?.sessionId ?? "session:none";
  const decision = await input.retryPolicy.evaluate({
    effectId,
    sessionId,
    attemptCount,
    // Cast through the structurally-optional shape the wiring layer
    // uses — `RetryPolicyEvaluateInput` formally requires
    // `identityId`, but the production caller may thread an
    // anonymous turn (no `identityId` on `RunTurnDecisionInput`).
    // The reader's anonymous fail-closed/pass-through path defends
    // against the structural-undefined leak (see `retry-policy.ts`).
    ...(input.identityId ? { identityId: input.identityId } : ({} as { identityId: IdentityId })),
  });
  if (decision.retry) {
    return productionDecision;
  }
  const marker: PolicyRetryDenialMarker = {
    stage: "retry",
    reason: decision.reason,
    effectId,
    attemptCount: decision.attemptCount,
    maxAttempts: decision.maxAttempts,
  };
  return downgradeOnRetryDenial(productionDecision, marker);
}

function downgradeOnRetryDenial(
  legacy: ClassifiedTaskResolution,
  marker: PolicyRetryDenialMarker,
): ClassifiedTaskResolution {
  const previousTrace = legacy.plannerInput.decisionTrace;
  const decisionTrace: DecisionTrace = {
    version: 1,
    ...previousTrace,
    policyRetryDenial: marker,
  };
  const taskContract = {
    ...legacy.taskContract,
    primaryOutcome: "answer" as const,
    interactionMode: "respond_only" as const,
  };
  const { lowConfidenceStrategy: _droppedStrategy, ...plannerInputRest } = legacy.plannerInput;
  return {
    ...legacy,
    taskContract,
    plannerInput: {
      ...plannerInputRest,
      decisionTrace,
    },
  };
}

/**
 * Phase 7 — Stage 6 (Escalation hooks) wiring helper. Runs ONLY when
 * the caller injected an `escalationHook` AND the shadow commitment
 * resolved to a kernel-derived `ExecutionCommitment` AND at least one
 * upstream policy gate (approval / budget / role / retry) attached a
 * denial trace marker.
 *
 * Reads the denial reason verbatim off the trace marker and forwards
 * it to `escalationHook.fire(...)` together with `(identityId,
 * effectId, channel, turnId)`. On `{fired: true, escalationId}` the
 * helper attaches a `policyEscalationFired` marker to the decision
 * trace so downstream telemetry can join on the same `escalationId`.
 * On `{fired: false, ...}` the helper logs a warn line and returns
 * the production decision UNCHANGED — escalation is observability,
 * not gating (sub-plan §10 invariant #3 footnote).
 *
 * The hook NEVER throws — defense-in-depth lives inside
 * `escalation-hook.ts`. The `try/catch` here is a belt-and-braces
 * net for hand-rolled host hooks that bypass the factory.
 */
async function maybeFireEscalation(params: {
  readonly input: RunTurnDecisionInput;
  readonly productionDecision: ClassifiedTaskResolution;
  readonly shadowCommitment: ShadowBuildResult;
  readonly traceId: TraceId;
}): Promise<ClassifiedTaskResolution> {
  const { input, productionDecision, shadowCommitment, traceId } = params;
  if (!input.escalationHook) {
    return productionDecision;
  }
  if (shadowCommitment.kind !== "commitment") {
    return productionDecision;
  }
  const trace = productionDecision.plannerInput.decisionTrace as
    | {
        readonly policyApprovalDenial?: PolicyApprovalDenialMarker;
        readonly policyBudgetDenial?: PolicyBudgetDenialMarker;
        readonly policyRoleDenial?: PolicyRoleDenialMarker;
        readonly policyRetryDenial?: PolicyRetryDenialMarker;
      }
    | undefined;

  const denialReason = readDenialReasonFromTrace(trace);
  if (!denialReason) {
    return productionDecision;
  }
  const effectId = shadowCommitment.value.effect;
  const channel = resolveActiveChannelForBudget(input.cfg);

  const fireInput: EscalationHookFireInput & { turnId: string } = {
    identityId: (input.identityId ?? ("identity:anonymous" as IdentityId)) as IdentityId,
    effectId,
    denialReason,
    channel,
    turnId: String(traceId),
  };

  let decision;
  try {
    decision = await input.escalationHook.fire(fireInput);
  } catch (error) {
    defaultRuntime.log(
      `[policy-gate] event=escalation_failed transport_error=` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return productionDecision;
  }

  if (!decision.fired) {
    // Failure already logged inside the hook impl
    // (`escalation-hook.ts`). Decision passes through unchanged.
    return productionDecision;
  }

  const marker: PolicyEscalationFiredMarker = {
    stage: "escalation",
    denialReason,
    channel: denialReason === "requires_approval" ? "approval_request" : "memory",
    escalationId: decision.escalationId,
    effectId,
  };
  return attachEscalationFiredMarker(productionDecision, marker);
}

/**
 * Pulls the upstream-most denial reason from the decision trace. The
 * order mirrors the gate evaluation chain
 * (`approval → budget → role → retry`); only the FIRST gate that
 * fired writes a marker (each downstream helper short-circuits on a
 * pre-existing marker), so reading them in order yields the canonical
 * denial reason for this turn.
 */
function readDenialReasonFromTrace(
  trace:
    | {
        readonly policyApprovalDenial?: PolicyApprovalDenialMarker;
        readonly policyBudgetDenial?: PolicyBudgetDenialMarker;
        readonly policyRoleDenial?: PolicyRoleDenialMarker;
        readonly policyRetryDenial?: PolicyRetryDenialMarker;
      }
    | undefined,
):
  | "requires_approval"
  | "budget_exceeded_user"
  | "budget_exceeded_channel"
  | "budget_exceeded_effect"
  | "role_denied"
  | "retry_limit_exceeded"
  | undefined {
  if (trace?.policyApprovalDenial) {
    return trace.policyApprovalDenial.reason;
  }
  if (trace?.policyBudgetDenial) {
    return trace.policyBudgetDenial.reason;
  }
  if (trace?.policyRoleDenial) {
    return trace.policyRoleDenial.reason;
  }
  if (trace?.policyRetryDenial) {
    return trace.policyRetryDenial.reason;
  }
  return undefined;
}

function attachEscalationFiredMarker(
  decision: ClassifiedTaskResolution,
  marker: PolicyEscalationFiredMarker,
): ClassifiedTaskResolution {
  const previousTrace = decision.plannerInput.decisionTrace;
  const decisionTrace: DecisionTrace = {
    version: 1,
    ...previousTrace,
    policyEscalationFired: marker,
  };
  return {
    ...decision,
    plannerInput: {
      ...decision.plannerInput,
      decisionTrace,
    },
  };
}

/**
 * Best-effort active-channel lookup for the budget gate. The
 * `OpenClawConfig.channels` shape is intentionally heterogeneous
 * across providers (slack, telegram, discord, …); for the budget
 * gate we only need a string discriminator. We probe known
 * convention slots in priority order and fall back to `"unknown"`
 * — a config-driven `dimension='channel'` rule keyed on
 * `'unknown'` would only match wiring paths that did not thread
 * an active channel.
 */
function resolveActiveChannelForBudget(cfg: OpenClawConfig): string {
  const probe = (cfg as unknown as Record<string, unknown>)["channels"];
  if (probe && typeof probe === "object") {
    const active = (probe as Record<string, unknown>)["_activeChannel"];
    if (typeof active === "string" && active.length > 0) {
      return active;
    }
  }
  return "unknown";
}

function downgradeOnApprovalDenial(
  legacy: ClassifiedTaskResolution,
  marker: PolicyApprovalDenialMarker,
): ClassifiedTaskResolution {
  const previousTrace = legacy.plannerInput.decisionTrace;
  const decisionTrace: DecisionTrace = {
    version: 1,
    ...previousTrace,
    policyApprovalDenial: marker,
  };
  const taskContract = {
    ...legacy.taskContract,
    primaryOutcome: "answer" as const,
    interactionMode: "respond_only" as const,
  };
  const { lowConfidenceStrategy: _droppedStrategy, ...plannerInputRest } = legacy.plannerInput;
  return {
    ...legacy,
    taskContract,
    plannerInput: {
      ...plannerInputRest,
      decisionTrace,
    },
  };
}

/**
 * Reads classifier-emitted blocking ambiguity reasons from the production
 * decision's trace. Returns the empty list when no ambiguity profile is
 * attached or no entry has `blocksClarification === true`.
 *
 * @param decision - Production classified task resolution.
 * @returns Blocking ambiguity reason strings (classifier output, not user text).
 */
function collectBlockingClarificationReasons(decision: ClassifiedTaskResolution): string[] {
  const profile = decision.plannerInput.decisionTrace?.contracts?.ambiguityProfile;
  if (!profile || profile.length === 0) {
    return [];
  }
  return profile.filter((entry) => entry.blocksClarification).map((entry) => entry.reason);
}

/**
 * Builds a downgraded `ClassifiedTaskResolution` from a clarify-needed legacy
 * decision. The downgrade flips `primaryOutcome` to `answer`, drops the
 * clarify-first interaction mode, clears `lowConfidenceStrategy`, and writes a
 * `clarificationPolicy.downgradeReason` marker into the decision trace. The
 * marker is observability-only — it does not extend any of the five frozen
 * legacy contracts (invariant #11).
 *
 * @param legacy - Production decision still carrying legacy clarify shape.
 * @param marker - Closed-string downgrade reason from the gate.
 * @returns Downgraded decision with answer/respond_only shape.
 */
function downgradeClarifyToAnswer(
  legacy: ClassifiedTaskResolution,
  marker: ClarificationPolicyDowngradeMarker,
): ClassifiedTaskResolution {
  const previousTrace = legacy.plannerInput.decisionTrace;
  const decisionTrace: DecisionTrace = {
    version: 1,
    ...previousTrace,
    clarificationPolicy: marker,
  };
  const taskContract = {
    ...legacy.taskContract,
    primaryOutcome: "answer" as const,
    interactionMode: "respond_only" as const,
  };
  const { lowConfidenceStrategy: _droppedStrategy, ...plannerInputRest } = legacy.plannerInput;
  return {
    ...legacy,
    taskContract,
    plannerInput: {
      ...plannerInputRest,
      decisionTrace,
    },
  };
}

function extractCommitment(shadowCommitment: ShadowBuildResult): ExecutionCommitment {
  if (shadowCommitment.kind !== "commitment") {
    throw new Error(
      "extractCommitment requires shadowCommitment.kind === 'commitment' (cutover gate invariant)",
    );
  }
  return shadowCommitment.value;
}

function isCutoverEnabled(cfg: OpenClawConfig): boolean {
  return cfg.agents?.defaults?.embeddedPi?.commitment?.cutoverEnabled !== false;
}

function unsupported(reason: ShadowUnsupportedReason): ShadowBuildResult {
  return { kind: "unsupported", reason };
}

function newTraceId(): TraceId {
  return `decision_trace_${randomUUID()}` as TraceId;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("shadow_timeout")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message === "shadow_timeout";
}

function truncateForLog(value: string, maxLength: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, maxLength - 1)}…`;
}
