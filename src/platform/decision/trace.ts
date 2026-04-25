import type { DeliverableSpec } from "../produce/registry.js";
import type { ClassifierTelemetry, RoutingOutcome } from "../recipe/planner.js";
import type { RecipeRoutingHints } from "../recipe/planner.js";
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
