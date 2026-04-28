import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../../config/config.js";
import {
  allowAllPolicyGate,
  createIntentContractor,
  createShadowBuilder,
  defaultCutoverPolicy,
  defaultAffordanceRegistry,
  resolveIntentContractorConfig,
  type AffordanceRegistry,
  type CutoverPolicy,
  type ExpectedDelta,
  type IntentContractorAdapter,
  type MonitoredRuntime,
  type RuntimeAttestation,
} from "../commitment/index.js";
import type { ExecutionCommitment } from "../commitment/execution-commitment.js";
import type { EffectId } from "../commitment/ids.js";
import type {
  ShadowBuildResult,
  ShadowUnsupportedReason,
} from "../commitment/shadow-builder.js";
import type { BuildExecutionDecisionInputParams } from "./input.js";
import {
  classifyTaskForDecision,
  type ClassifiedTaskResolution,
  type TaskClassifierAdapter,
} from "./task-classifier.js";
import type {
  DecisionTrace,
  KernelDerivedDecisionMarker,
  KernelFallbackReason,
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
  const shadowCommitment =
    shadowSettled.status === "fulfilled"
      ? shadowSettled.value
      : unsupported("shadow_runtime_error");
  const cutover = await evaluateCutoverGate(input, shadowCommitment);

  const isKernelDerived =
    cutover.gate.kind === "gate_in_success" && cutover.attestation?.commitmentSatisfied === true;

  const productionDecision = isKernelDerived
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

  const fallbackReason = isKernelDerived
    ? undefined
    : resolveFallbackReason(shadowCommitment, cutover.gate);

  return {
    legacyDecision,
    productionDecision,
    shadowCommitment,
    cutoverGate: cutover.gate,
    ...(cutover.attestation ? { runtimeAttestation: cutover.attestation } : {}),
    kernelFallback: !isKernelDerived,
    ...(fallbackReason ? { fallbackReason } : {}),
    traceId,
  };
}

async function runShadowBranch(input: RunTurnDecisionInput): Promise<ShadowBuildResult> {
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
        });
        const shadowBuilder = createShadowBuilder({
          affordances: input.affordanceRegistry ?? defaultAffordanceRegistry,
          policy: allowAllPolicyGate,
          logger: {},
          confidenceThreshold: config.confidenceThreshold,
        });
        const intent = await intentContractor.classify(input.prompt);
        return await shadowBuilder.build(intent);
      })(),
      config.timeoutMs,
    );
  } catch (error) {
    return unsupported(isTimeoutError(error) ? "shadow_timeout" : "shadow_runtime_error");
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
