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
import type { DecisionTrace } from "./trace.js";

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
  readonly legacyDecision: ClassifiedTaskResolution;
  readonly productionDecision: ClassifiedTaskResolution;
  readonly shadowCommitment: ShadowBuildResult;
  readonly cutoverGate: CutoverGateTrace;
  readonly runtimeAttestation?: RuntimeAttestation;
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
 * Runs legacy decision and commitment shadow branches side by side.
 *
 * @param input - Prompt plus legacy classifier and shadow adapter context.
 * @returns Legacy authoritative decision with shadow commitment attached to trace.
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
  const shadowCommitment =
    shadowSettled.status === "fulfilled"
      ? shadowSettled.value
      : unsupported("shadow_runtime_error");
  const cutover = await evaluateCutoverGate(input, shadowCommitment);
  const productionDecision = attachDecisionTrace(
    legacySettled.value,
    shadowCommitment,
    cutover.gate,
  );

  return {
    legacyDecision: productionDecision,
    productionDecision,
    shadowCommitment,
    cutoverGate: cutover.gate,
    ...(cutover.attestation ? { runtimeAttestation: cutover.attestation } : {}),
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

function attachDecisionTrace(
  legacyDecision: ClassifiedTaskResolution,
  shadowCommitment: ShadowBuildResult,
  cutoverGate: CutoverGateTrace,
): ClassifiedTaskResolution {
  const previousTrace = legacyDecision.plannerInput.decisionTrace;
  const decisionTrace: DecisionTraceWithCutoverGate = {
    version: 1,
    ...previousTrace,
    shadowCommitment,
    cutoverGate,
  };
  return {
    ...legacyDecision,
    plannerInput: {
      ...legacyDecision.plannerInput,
      decisionTrace,
    },
  };
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
