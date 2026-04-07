import type { ModelCandidate } from "../../agents/model-fallback.types.js";
import type { RecipePlannerInput } from "../recipe/planner.js";
import type { ModelRouteCostTier, ModelRoutePreflightDecision } from "./contracts.js";
import { isLikelyControlPlaneLocalProvider } from "./control-plane-local.js";
import { buildExecutionDecisionInput } from "./input.js";

export type RoutePreflightMode = "default" | "force_stronger";

const HEAVY_TOOL_IDS = new Set(["exec", "apply_patch", "process"]);

type LocalRoutingPlannerInput = Pick<
  RecipePlannerInput,
  "intent" | "requestedTools" | "fileNames" | "artifactKinds" | "prompt"
>;

const HEAVY_FILE_EXTENSION =
  /\.(pdf|png|jpe?g|webp|gif|tiff?|bmp|heic|ts|tsx|js|jsx|mjs|cjs|json|py|go|rs|java|kt|cs|cpp|h)$/iu;

const TABULAR_ATTACHMENT_EXTENSION = /\.(csv|xlsx|xls|ods)$/iu;

function fileNamesImplyHeavyLocalRoute(fileNames: string[]): boolean {
  return fileNames.some((name) => HEAVY_FILE_EXTENSION.test(name));
}

function promptSuggestsHeavyDocumentWork(prompt: string | undefined): boolean {
  if (!prompt?.trim()) {
    return false;
  }
  return (
    /\b(pdf|png|jpe?g|webp|gif|scan|scanned|screenshot|ocr|invoice|diagram)\b/iu.test(prompt) ||
    /\b(pdf|png|скан|скриншот|чертеж)\b/iu.test(prompt)
  );
}

/**
 * Keep obviously multi-step analytical asks on the stronger route even when they have
 * no files, because local-first is mainly for lightweight chat and simple arithmetic.
 */
function promptSuggestsComplexReasoning(prompt: string | undefined): boolean {
  if (!prompt?.trim()) {
    return false;
  }
  const normalized = prompt.trim().toLowerCase();
  let score = 0;
  if (normalized.length >= 120) {
    score += 1;
  }
  if (
    /\b(analy[sz]e|analysis|deep dive|detailed|trade[- ]?offs?|framework|metrics?|kpis?|examples?|rationale|prioriti[sz]e|step[- ]by[- ]step)\b/iu.test(
      prompt,
    ) ||
    [
      "анализ",
      "подробн",
      "развернут",
      "развёрнут",
      "почему",
      "пример",
      "метрик",
      "пошагов",
      "приорит",
      "обоснован",
    ].some((hint) => normalized.includes(hint))
  ) {
    score += 2;
  }
  if (
    /\b(three|four|five|six|seven|eight|nine|ten|3|4|5|6|7|8|9|10)\b/iu.test(prompt) ||
    ["три", "четыре", "пять", "шесть", "семь", "восемь", "девять", "десять"].some((hint) =>
      normalized.includes(hint),
    )
  ) {
    score += 1;
  }
  if (
    /[:;]/.test(prompt) &&
    (/\b(why|because|with examples?)\b/iu.test(prompt) ||
      normalized.includes("с примерами") ||
      normalized.includes("почему") ||
      normalized.includes("например"))
  ) {
    score += 1;
  }
  return score >= 2;
}

function artifactKindsAllowLightTabularOrCalc(
  kinds: NonNullable<RecipePlannerInput["artifactKinds"]>,
  intent: RecipePlannerInput["intent"],
): boolean {
  if (kinds.length === 0) {
    return true;
  }
  const heavy = new Set([
    "image",
    "video",
    "audio",
    "document",
    "site",
    "release",
    "binary",
    "archive",
  ]);
  if (kinds.some((kind) => heavy.has(kind))) {
    return false;
  }
  const onlyDataReport = kinds.every((kind) => kind === "data" || kind === "report");
  if (!onlyDataReport) {
    return false;
  }
  return intent === "compare" || intent === "calculation";
}

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
  const intent = plannerInput.intent;
  const fileNames = plannerInput.fileNames ?? [];
  const kinds = plannerInput.artifactKinds ?? [];

  if (promptSuggestsHeavyDocumentWork(plannerInput.prompt)) {
    return false;
  }
  if (promptSuggestsComplexReasoning(plannerInput.prompt)) {
    return false;
  }

  if (fileNames.length > 0) {
    if (fileNamesImplyHeavyLocalRoute(fileNames)) {
      return false;
    }
    if (
      intent === "compare" &&
      fileNames.every((name) => TABULAR_ATTACHMENT_EXTENSION.test(name))
    ) {
      return false;
    }
    return false;
  }

  if (kinds.length > 0) {
    return artifactKindsAllowLightTabularOrCalc(kinds, intent);
  }
  return true;
}

export function inferLocalRoutingEligibleFromPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return false;
  }
  return inferLocalRoutingEligibleFromPlannerInput(
    buildExecutionDecisionInput({ prompt: trimmed }),
  );
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
  const plannerInput =
    params.plannerInput ?? (prompt ? buildExecutionDecisionInput({ prompt }) : null);
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
