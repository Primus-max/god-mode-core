import type { ModelCandidate } from "../../agents/model-fallback.types.js";
import type { RecipePlannerInput } from "../recipe/planner.js";
import type { ModelRouteCostTier, ModelRoutePreflightDecision } from "./contracts.js";
import { isLikelyControlPlaneLocalProvider } from "./control-plane-local.js";
import { buildExecutionDecisionInput } from "./input.js";

export type RoutePreflightMode = "default" | "force_stronger";

const HEAVY_TOOL_IDS = new Set(["exec", "apply_patch", "process"]);

type LocalRoutingPlannerInput = Pick<
  RecipePlannerInput,
  "intent" | "requestedTools" | "fileNames" | "artifactKinds"
>;

function costTierForCandidate(candidate: ModelCandidate): ModelRouteCostTier {
  return isLikelyControlPlaneLocalProvider(candidate.provider) ? "control_plane_local" : "standard";
}

function buildDecisionForOrdered(
  ordered: ModelCandidate[],
  params: {
    reasonCode: ModelRoutePreflightDecision["reasonCode"];
    reason: string;
    localRoutingEligible: boolean;
    reordered: boolean;
  },
): ModelRoutePreflightDecision {
  const first = ordered[0];
  const controlPlaneUsed = isLikelyControlPlaneLocalProvider(first.provider);
  return {
    chosenProvider: first.provider,
    chosenModel: first.model,
    reasonCode: params.reasonCode,
    reason: params.reason,
    costTier: costTierForCandidate(first),
    controlPlaneUsed,
    localRoutingEligible: params.localRoutingEligible,
    reordered: params.reordered,
  };
}

/**
 * Infer whether the turn is safe to route through a cheap local control-plane model first
 * when one appears in the fallback chain (simple chat / no heavy tooling signals).
 */
export function inferLocalRoutingEligibleFromPlannerInput(
  plannerInput: LocalRoutingPlannerInput,
): boolean {
  if (plannerInput.intent === "code" || plannerInput.intent === "publish") {
    return false;
  }
  const tools = plannerInput.requestedTools ?? [];
  if (tools.some((t) => HEAVY_TOOL_IDS.has(t))) {
    return false;
  }
  if (plannerInput.fileNames && plannerInput.fileNames.length > 0) {
    return false;
  }
  if (plannerInput.artifactKinds && plannerInput.artifactKinds.length > 0) {
    return false;
  }
  return true;
}

export function inferLocalRoutingEligibleFromPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return false;
  }
  return inferLocalRoutingEligibleFromPlannerInput(buildExecutionDecisionInput({ prompt: trimmed }));
}

/**
 * Reorders model fallback candidates so a control-plane local provider can run first when
 * eligible, without dropping any candidates (failover semantics unchanged).
 */
export function applyModelRoutePreflight(params: {
  candidates: ModelCandidate[];
  prompt?: string;
  plannerInput?: LocalRoutingPlannerInput | null;
  mode?: RoutePreflightMode;
}): { candidates: ModelCandidate[]; decision: ModelRoutePreflightDecision | null } {
  const list = params.candidates;
  if (list.length === 0) {
    return { candidates: list, decision: null };
  }

  const prompt = params.prompt?.trim();
  const plannerInput = params.plannerInput ?? (prompt ? buildExecutionDecisionInput({ prompt }) : null);
  if (!prompt && !plannerInput) {
    return { candidates: list, decision: null };
  }

  const localEligible =
    params.mode === "force_stronger"
      ? false
      : plannerInput
        ? inferLocalRoutingEligibleFromPlannerInput(plannerInput)
        : false;

  if (!localEligible) {
    return {
      candidates: list,
      decision: buildDecisionForOrdered(list, {
        reasonCode: "preflight_stronger_route",
        reason:
          params.mode === "force_stronger"
            ? "Preflight forced stronger route (e.g. structured or memory workloads)."
            : "Heuristics require a stronger route; keeping configured candidate order.",
        localRoutingEligible: false,
        reordered: false,
      }),
    };
  }

  const primary = list[0];
  if (isLikelyControlPlaneLocalProvider(primary.provider)) {
    return {
      candidates: list,
      decision: buildDecisionForOrdered(list, {
        reasonCode: "preflight_primary_control_plane_local",
        reason: "Primary candidate is already a control-plane local provider.",
        localRoutingEligible: true,
        reordered: false,
      }),
    };
  }

  const localIndex = list.findIndex((c) => isLikelyControlPlaneLocalProvider(c.provider));
  if (localIndex < 0) {
    return {
      candidates: list,
      decision: buildDecisionForOrdered(list, {
        reasonCode: "preflight_no_local_candidate",
        reason: "No control-plane local provider in the candidate chain.",
        localRoutingEligible: true,
        reordered: false,
      }),
    };
  }

  const localCandidate = list[localIndex];
  const rest = list.filter((_, i) => i !== localIndex);
  const ordered = [localCandidate, ...rest];
  return {
    candidates: ordered,
    decision: buildDecisionForOrdered(ordered, {
      reasonCode: "preflight_reordered_local_first",
      reason: `Promoted ${localCandidate.provider}/${localCandidate.model} ahead of primary for a local-eligible turn.`,
      localRoutingEligible: true,
      reordered: true,
    }),
  };
}
