import { randomUUID } from "node:crypto";
import { defaultRuntime } from "../../runtime.js";
import type { OpenClawConfig } from "../../config/config.js";
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
  type ClarificationPolicyReader,
  type CutoverPolicy,
  type ExpectedDelta,
  type InboundMediaSummary,
  type IntentContractorAdapter,
  type IntentContractorLogger,
  type MonitoredRuntime,
  type PolicyGateReader,
  type RuntimeAttestation,
  type SemanticIntent,
} from "../commitment/index.js";
import type { ExecutionCommitment } from "../commitment/execution-commitment.js";
import type { EffectId } from "../commitment/ids.js";
import type {
  ShadowBuildResult,
  ShadowUnsupportedReason,
} from "../commitment/shadow-builder.js";
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
export async function runTurnDecision(
  input: RunTurnDecisionInput,
): Promise<RunTurnDecisionResult> {
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
    ...(input.classifierAdapterRegistry ? { adapterRegistry: input.classifierAdapterRegistry } : {}),
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
  const productionDecision = isKernelDerived
    ? await maybeBlockOnApproval({
        input,
        productionDecision: decisionAfterClarify,
        shadowCommitment,
      })
    : decisionAfterClarify;

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
      return gate.reason === "shadow_unsupported"
        ? "shadow_runtime_error"
        : gate.reason;
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
  return profile
    .filter((entry) => entry.blocksClarification)
    .map((entry) => entry.reason);
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
