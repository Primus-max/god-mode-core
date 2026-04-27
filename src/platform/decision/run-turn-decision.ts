import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../../config/config.js";
import {
  allowAllPolicyGate,
  createIntentContractor,
  createShadowBuilder,
  defaultAffordanceRegistry,
  resolveIntentContractorConfig,
  type IntentContractorAdapter,
} from "../commitment/index.js";
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
};

export type RunTurnDecisionResult = {
  readonly legacyDecision: ClassifiedTaskResolution;
  readonly shadowCommitment: ShadowBuildResult;
  readonly traceId: TraceId;
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

  return {
    legacyDecision: attachShadowTrace(legacySettled.value, shadowCommitment),
    shadowCommitment,
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
          affordances: defaultAffordanceRegistry,
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

function attachShadowTrace(
  legacyDecision: ClassifiedTaskResolution,
  shadowCommitment: ShadowBuildResult,
): ClassifiedTaskResolution {
  const previousTrace = legacyDecision.plannerInput.decisionTrace;
  const decisionTrace: DecisionTrace = {
    version: 1,
    ...previousTrace,
    shadowCommitment,
  };
  return {
    ...legacyDecision,
    plannerInput: {
      ...legacyDecision.plannerInput,
      decisionTrace,
    },
  };
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
