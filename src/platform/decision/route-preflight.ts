import { findModelInCatalog, type ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { ModelCandidate } from "../../agents/model-fallback.types.js";
import type { RecipePlannerInput } from "../recipe/planner.js";
import type { ModelRouteCostTier, ModelRoutePreflightDecision } from "./contracts.js";
import { isLikelyControlPlaneLocalProvider } from "./control-plane-local.js";

export type RoutePreflightMode = "default" | "force_stronger";

const HEAVY_TOOL_IDS = new Set(["exec", "apply_patch", "process", "browser", "web_search"]);

/**
 * Models with `compat.nativeWebSearchTool: true` in
 * `~/.openclaw-dev/agents/dev/agent/models.json`.
 *
 * SOURCE OF TRUTH for which candidates can serve `web_search` end-to-end via
 * Hydra without falling back to OpenClaw's local DDG scraper. Mirror this set
 * any time a new model gains `nativeWebSearchTool: true` in models.json.
 *
 * Empirical verification via Hydra `/v1/models` (2026-05-02): only Perplexity
 * `sonar` and `sonar-pro` carry a `web_search: true` capability flag in
 * Hydra's own catalog AND reply with live SERP citations on chat-completions
 * calls (verified via `curl` returning current-day news with cited URLs).
 * `grok-4` was previously marked native (PR-#125) without curl verification;
 * Hydra does NOT advertise web_search for grok-4 and a live test returned
 * training-cutoff knowledge (July 2025) instead of fresh data — its compat
 * block was removed in this follow-up.
 *
 * Current members:
 * - `sonar` — Perplexity Sonar via Hydra openai-completions.
 * - `sonar-pro` — Perplexity Sonar Pro via Hydra openai-completions.
 */
const NATIVE_WEB_SEARCH_MODEL_IDS: ReadonlySet<string> = new Set(["sonar", "sonar-pro"]);

function hasNativeWebSearchCapability(candidate: ModelCandidate): boolean {
  return NATIVE_WEB_SEARCH_MODEL_IDS.has(candidate.model.trim().toLowerCase());
}

type LocalRoutingPlannerInput = Pick<
  RecipePlannerInput,
  | "intent"
  | "requestedTools"
  | "fileNames"
  | "artifactKinds"
  | "routing"
  | "resolutionContract"
>;

const HEAVY_FILE_EXTENSION =
  /\.(pdf|png|jpe?g|webp|gif|tiff?|bmp|heic|ts|tsx|js|jsx|mjs|cjs|json|py|go|rs|java|kt|cs|cpp|h)$/iu;
const HEAVY_ARTIFACT_KINDS = new Set([
  "image",
  "video",
  "audio",
  "document",
  "site",
  "release",
  "binary",
  "archive",
]);
type RemoteRoutingProfile = "cheap" | "code" | "strong" | "presentation";
const CHEAP_REMOTE_FIRST_ENV = "OPENCLAW_PREFER_CHEAP_REMOTE_FIRST";

function fileNamesImplyHeavyLocalRoute(fileNames: string[]): boolean {
  return fileNames.some((name) => HEAVY_FILE_EXTENSION.test(name));
}

function isFastLocalModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return (
    /\b(1\.5b|2b|3b|4b|7b|8b)\b/u.test(normalized) ||
    normalized.includes("mini") ||
    normalized.includes("small") ||
    normalized.includes("qwen2.5-coder:7b")
  );
}

function isStrongLocalModel(candidate: ModelCandidate): boolean {
  if (!isLikelyControlPlaneLocalProvider(candidate.provider)) {
    return false;
  }
  const normalized = candidate.model.trim().toLowerCase();
  return (
    normalized.includes("gemma") ||
    normalized.includes("gpt-oss") ||
    /\b(14b|20b|22b|27b|30b|32b|34b|70b)\b/u.test(normalized)
  );
}

/**
 * Estimates a local model's relative footprint from its model id so routing can
 * prefer a strong candidate that is more likely to start quickly on developer
 * machines. This is intentionally heuristic: we only need enough signal to keep
 * obviously heavier local models behind balanced ones such as Gemma.
 *
 * @param {string} model - Normalized local model identifier.
 * @returns {number | null} Approximate size in billions of parameters, when detectable.
 */
function extractApproxModelSizeInBillions(model: string): number | null {
  const normalized = model.trim().toLowerCase();
  const explicitBillions = normalized.match(/\b(\d+(?:\.\d+)?)b\b/u);
  if (explicitBillions?.[1]) {
    return Number(explicitBillions[1]);
  }
  const efficientBillions = normalized.match(/\be(\d+(?:\.\d+)?)b\b/u);
  if (efficientBillions?.[1]) {
    return Number(efficientBillions[1]);
  }
  return null;
}

/**
 * Scores strong local candidates by "best likely first pass" instead of raw
 * size or raw capability. We still prefer local support first, but bias toward
 * models that are both capable and realistically runnable on a laptop/desktop.
 *
 * @param {ModelCandidate} candidate - Local strong model candidate to score.
 * @returns {number} Higher score means a better first-pass strong-local choice.
 */
function scorePreferredStrongLocalModel(candidate: ModelCandidate): number {
  if (!isStrongLocalModel(candidate)) {
    return Number.NEGATIVE_INFINITY;
  }
  const normalized = candidate.model.trim().toLowerCase();
  const approxSize = extractApproxModelSizeInBillions(normalized);
  let score = 0;

  if (normalized.includes("gemma")) {
    score += 120;
  }
  if (normalized.includes("qwen")) {
    score += 80;
  }
  if (normalized.includes("gpt-oss")) {
    score -= 40;
  }

  if (approxSize !== null) {
    if (approxSize <= 4) {
      score += 70;
    } else if (approxSize <= 8) {
      score += 55;
    } else if (approxSize <= 14) {
      score += 35;
    } else if (approxSize <= 20) {
      score += 5;
    } else {
      score -= 35;
    }
  }

  return score;
}

function scorePreferredLightLocalModel(
  candidate: ModelCandidate,
  plannerInput: LocalRoutingPlannerInput | null,
): number {
  if (!isLikelyControlPlaneLocalProvider(candidate.provider)) {
    return Number.NEGATIVE_INFINITY;
  }
  const normalized = candidate.model.trim().toLowerCase();
  const approxSize = extractApproxModelSizeInBillions(normalized);
  let score = 0;

  if (normalized.includes("gemma")) {
    score += 140;
  }
  if (normalized.includes("llama")) {
    score += 90;
  }
  if (normalized.includes("qwen")) {
    score += 60;
  }
  if (normalized.includes("coder") && plannerInput?.intent !== "code") {
    score -= 120;
  }
  if (normalized.includes("gpt-oss")) {
    score -= 90;
  }

  if (approxSize !== null) {
    if (approxSize <= 4) {
      score += 70;
    } else if (approxSize <= 8) {
      score += 45;
    } else if (approxSize <= 14) {
      score += 20;
    } else {
      score -= 25;
    }
  }

  return score;
}

function shouldPreferRemoteOrchestratorFirst(
  plannerInput: LocalRoutingPlannerInput | null,
): boolean {
  if (!plannerInput) {
    return false;
  }
  if (plannerInput.routing?.preferRemoteFirst === true) {
    return true;
  }
  if (plannerInput.intent === "publish") {
    return true;
  }
  const tools = plannerInput.requestedTools ?? [];
  if (tools.includes("browser") || tools.includes("web_search")) {
    return true;
  }
  const kinds = plannerInput.artifactKinds ?? [];
  if (
    kinds.some(
      (kind) =>
        kind === "image" ||
        kind === "video" ||
        kind === "audio" ||
        kind === "site" ||
        kind === "release",
    )
  ) {
    return true;
  }
  return false;
}

function shouldPreferCheapRemoteFirstForGeneral(
  plannerInput: LocalRoutingPlannerInput | null,
): boolean {
  if (process.env[CHEAP_REMOTE_FIRST_ENV] !== "1") {
    return false;
  }
  if (!plannerInput) {
    return false;
  }
  return (
    (plannerInput.intent === "general" || plannerInput.intent === undefined) &&
    (plannerInput.requestedTools?.length ?? 0) === 0 &&
    (plannerInput.artifactKinds?.length ?? 0) === 0 &&
    (plannerInput.fileNames?.length ?? 0) === 0
  );
}

function plannerInputNeedsVisionCapability(plannerInput: LocalRoutingPlannerInput): boolean {
  if (plannerInput.routing?.needsVision === true) {
    return true;
  }
  const fileNames = plannerInput.fileNames ?? [];
  if (fileNames.some((name) => /\.(pdf|png|jpe?g|webp|gif|tiff?|bmp|heic)$/iu.test(name))) {
    return true;
  }
  return false;
}

function scoreCatalogStatus(
  entry: ModelCatalogEntry | undefined,
  profile: RemoteRoutingProfile,
): number {
  const successRate = entry?.status?.successRate;
  const tps = entry?.status?.tps;
  const art = entry?.status?.art;
  let score = 0;
  if (successRate !== undefined) {
    if (successRate >= 99) {
      score += 50;
    } else if (successRate >= 95) {
      score += 35;
    } else if (successRate >= 90) {
      score += 20;
    } else if (successRate >= 80) {
      score += 5;
    } else if (successRate < 70) {
      score -= 80;
    } else {
      score -= 25;
    }
  }
  if (tps !== undefined) {
    if (tps >= 80) {
      score += profile === "cheap" ? 35 : 20;
    } else if (tps >= 40) {
      score += profile === "cheap" ? 35 : 15;
    } else if (tps >= 20) {
      score += profile === "cheap" ? 20 : 8;
    } else if (tps < 8) {
      score -= profile === "cheap" ? 20 : 12;
    }
  }
  if (art !== undefined) {
    if (art <= 2) {
      score += profile === "cheap" ? 20 : 12;
    } else if (art <= 5) {
      score += profile === "cheap" ? 10 : 8;
    } else if (art > 120) {
      score -= 260;
    } else if (art > 60) {
      score -= 160;
    } else if (art > 20) {
      score -= 70;
    } else if (art > 12) {
      score -= 25;
    }
  }
  if (profile === "cheap") {
    return score;
  }
  return score;
}

function scoreCatalogCost(
  entry: ModelCatalogEntry | undefined,
  profile: RemoteRoutingProfile,
): number {
  if (!entry?.cost) {
    return 0;
  }
  const requestCost = entry.cost.request;
  const blendedTokenCost = (entry.cost.input ?? 0) + (entry.cost.output ?? 0);

  if (profile === "cheap") {
    if (requestCost !== undefined) {
      if (requestCost <= 1.5) {
        return 90;
      }
      if (requestCost <= 3) {
        return 40;
      }
      return -120;
    }
    if (blendedTokenCost <= 20) {
      return 95;
    }
    if (blendedTokenCost <= 80) {
      return 60;
    }
    if (blendedTokenCost <= 180) {
      return 20;
    }
    if (blendedTokenCost <= 400) {
      return -25;
    }
    return -100;
  }

  if (profile === "code") {
    if (requestCost !== undefined) {
      return -150;
    }
    if (blendedTokenCost <= 100) {
      return 35;
    }
    if (blendedTokenCost <= 250) {
      return 15;
    }
    if (blendedTokenCost <= 500) {
      return -10;
    }
    return -45;
  }

  if (requestCost !== undefined) {
    return requestCost <= 2 ? -25 : -150;
  }
  if (blendedTokenCost <= 120) {
    return 25;
  }
  if (blendedTokenCost <= 300) {
    return 10;
  }
  if (blendedTokenCost <= 700) {
    return -25;
  }
  return -90;
}

/**
 * Selects the remote tier profile that should follow the local-first pass.
 * Cheap prompts should fail over into inexpensive API models, while code and
 * long-form analytical work should escalate into stronger remote candidates.
 *
 * @param {LocalRoutingPlannerInput} plannerInput - Planner hints for the current turn.
 * @param {boolean} localEligible - Whether the turn qualifies for a cheap local first pass.
 * @returns {RemoteRoutingProfile} Preferred remote profile for this turn.
 */
function inferRemoteRoutingProfile(
  plannerInput: LocalRoutingPlannerInput,
  localEligible: boolean,
): RemoteRoutingProfile {
  if (plannerInput.routing?.remoteProfile) {
    return plannerInput.routing.remoteProfile;
  }
  const tools = plannerInput.requestedTools ?? [];
  const kinds = plannerInput.artifactKinds ?? [];
  const wantsPresentationQuality =
    plannerInput.intent === "document" &&
    kinds.includes("document") &&
    tools.includes("pdf") &&
    (tools.includes("image_generate") || kinds.includes("image") || plannerInputNeedsVisionCapability(plannerInput));
  if (wantsPresentationQuality) {
    return "presentation";
  }
  if (
    plannerInput.intent === "code" ||
    plannerInput.intent === "publish" ||
    tools.some((tool) => HEAVY_TOOL_IDS.has(tool))
  ) {
    return "code";
  }
  if (
    !localEligible ||
    kinds.some((kind) => HEAVY_ARTIFACT_KINDS.has(kind)) ||
    plannerInputNeedsVisionCapability(plannerInput)
  ) {
    return "strong";
  }
  return "cheap";
}

/**
 * Scores remote candidates according to the current remote routing profile.
 * This keeps local-first intact while making the remote tail task-aware instead
 * of always inheriting config order blindly.
 *
 * @param {ModelCandidate} candidate - Remote model candidate to score.
 * @param {RemoteRoutingProfile} profile - Desired remote routing profile.
 * @returns {number} Higher score means a better remote fallback candidate.
 */
function scorePreferredRemoteModel(
  candidate: ModelCandidate,
  profile: RemoteRoutingProfile,
  catalogEntry?: ModelCatalogEntry,
  options?: { needsVision: boolean },
): number {
  if (isLikelyControlPlaneLocalProvider(candidate.provider)) {
    return Number.NEGATIVE_INFINITY;
  }
  const normalized = `${candidate.provider}/${candidate.model}`.trim().toLowerCase();
  let score = 0;

  if (profile === "cheap") {
    if (normalized.includes("hydra/hydra-gpt-mini")) {
      score += 280;
    }
    if (normalized.includes("hydra/hydra-gpt")) {
      score += 210;
    }
    if (normalized.includes("hydra/hydra-gemini")) {
      score += 190;
    }
    if (
      normalized.includes("gpt-4o-mini") ||
      normalized.includes("gpt-4.1-nano") ||
      normalized.includes("gpt-5-nano") ||
      normalized.includes("gpt-5-mini") ||
      normalized.includes("gemini-2.5-flash") ||
      normalized.includes("deepseek-v3.2")
    ) {
      score += 140;
    }
    if (normalized.includes("opus") || normalized.includes("gpt-5.4")) {
      score -= 80;
    }
  }

  if (profile === "code") {
    if (normalized.includes("codex")) {
      score += 300;
    }
    if (normalized.includes("qwen3-coder")) {
      score += 250;
    }
    if (normalized.includes("claude-sonnet-4.6") || normalized.includes("claude-sonnet-4.5")) {
      score += 240;
    }
    if (normalized.includes("claude-opus-4.6")) {
      score += 220;
    }
    if (normalized.includes("gpt-5.4") || normalized.includes("gpt-5.2")) {
      score += 210;
    }
    if (normalized.includes("deepseek-v3.2") || normalized.includes("deepseek-r1")) {
      score += 190;
    }
    if (normalized.includes("hydra-gpt-pro") || normalized.includes("hydra-gpt")) {
      score += 170;
    }
    if (normalized.includes("mini") || normalized.includes("nano")) {
      score -= 40;
    }
  }

  if (profile === "strong") {
    if (normalized.includes("claude-opus-4.6")) {
      score += 320;
    }
    if (normalized.includes("gpt-5.4")) {
      score += 230;
    }
    if (normalized.includes("claude-sonnet-4.6") || normalized.includes("claude-sonnet-4.5")) {
      score += 260;
    }
    if (normalized.includes("gpt-4o") && !normalized.includes("mini")) {
      score += 520;
    }
    if (normalized.includes("hydra-gpt-pro") || normalized.includes("hydra-gemini-pro")) {
      score += 240;
    }
    if (
      normalized.includes("deepseek-r1") ||
      normalized.includes("deepseek-v3.2") ||
      normalized.includes("kimi-k2") ||
      normalized.includes("grok-4") ||
      normalized.includes("glm-4.7") ||
      normalized.includes("minimax-m2.1")
    ) {
      score += 220;
    }
    if (normalized.includes("codex") || normalized.includes("gpt-5.2")) {
      score += 200;
    }
    if (
      (normalized.includes("hydra-gpt") && !normalized.includes("hydra-gpt-pro")) ||
      (normalized.includes("hydra-gemini") && !normalized.includes("hydra-gemini-pro"))
    ) {
      score += 170;
    }
    if (normalized.includes("mini") || normalized.includes("nano")) {
      score -= 90;
    }
  }

  if (profile === "presentation") {
    if (normalized.includes("claude-opus-4.6")) {
      score += 420;
    }
    if (normalized.includes("gpt-5.4")) {
      score += 360;
    }
    if (normalized.includes("claude-sonnet-4.6") || normalized.includes("claude-sonnet-4.5")) {
      score += 340;
    }
    if (normalized.includes("gemini-2.5-pro")) {
      score += 300;
    }
    if (normalized.includes("gpt-4o") && !normalized.includes("mini")) {
      score += 120;
    }
    if (normalized.includes("hydra-gpt-pro")) {
      score += 80;
    }
    if (normalized.includes("codex")) {
      score -= 120;
    }
    if (normalized.includes("mini") || normalized.includes("nano")) {
      score -= 140;
    }
  }

  if (candidate.provider === "hydra") {
    score += 10;
  }

  if (catalogEntry) {
    const outputs = new Set(catalogEntry.output ?? []);
    const inputs = new Set(catalogEntry.input ?? []);
    const type = catalogEntry.type?.toLowerCase();

    if (catalogEntry.active === false) {
      score -= 500;
    }
    if (type === "embedding") {
      score -= 1_000;
    }
    if (type === "image") {
      score -= 900;
    }
    if (outputs.has("image")) {
      score -= 150;
    }
    if ((profile === "code" || profile === "strong" || profile === "presentation") && catalogEntry.reasoning) {
      score += 60;
    }
    if (profile === "code" && catalogEntry.supportsTools) {
      score += 60;
    }
    if (profile === "strong" && catalogEntry.supportsTools) {
      score += 80;
    }
    if (profile === "presentation" && catalogEntry.supportsTools) {
      score += 90;
    }
    if (options?.needsVision) {
      if (type === "vision" || inputs.has("image") || inputs.has("document")) {
        score += profile === "presentation" ? 140 : 90;
      } else {
        score -= 40;
      }
    } else if (type === "vision") {
      score += profile === "presentation" ? 40 : 15;
    }
    if (catalogEntry.architecture?.toLowerCase() === "moe" && profile !== "cheap") {
      score += 10;
    }
    if (catalogEntry.quantization?.toLowerCase() === "fp8" && profile === "cheap") {
      score += 10;
    }
    score += scoreCatalogCost(catalogEntry, profile);
    score += scoreCatalogStatus(catalogEntry, profile);
  }

  return score;
}

/**
 * Reorders only the remote slots inside an already-constructed fallback chain.
 * Local candidate positions remain untouched, but the API tail becomes aligned
 * with the current task profile.
 *
 * @param {ModelCandidate[]} candidates - Current candidate chain after local-first preflight.
 * @param {LocalRoutingPlannerInput | null} plannerInput - Structured planner hints for the turn.
 * @param {boolean} localEligible - Whether the turn qualified for a cheap local first pass.
 * @returns {{ candidates: ModelCandidate[]; changed: boolean; reason?: string }} Remote-tail adjustment result.
 */
function reorderRemoteTailCandidates(params: {
  candidates: ModelCandidate[];
  plannerInput: LocalRoutingPlannerInput | null;
  localEligible: boolean;
  catalog?: ModelCatalogEntry[];
}): { candidates: ModelCandidate[]; changed: boolean; reason?: string } {
  if (!params.plannerInput) {
    return { candidates: params.candidates, changed: false };
  }
  const remoteIndexes = params.candidates.reduce<number[]>((acc, candidate, index) => {
    if (!isLikelyControlPlaneLocalProvider(candidate.provider)) {
      acc.push(index);
    }
    return acc;
  }, []);
  if (remoteIndexes.length < 2) {
    return { candidates: params.candidates, changed: false };
  }

  const profile = inferRemoteRoutingProfile(params.plannerInput, params.localEligible);
  const needsVision = plannerInputNeedsVisionCapability(params.plannerInput);
  const orderedRemote = remoteIndexes
    .map((index) => ({
      index,
      candidate: params.candidates[index],
      score: scorePreferredRemoteModel(
        params.candidates[index],
        profile,
        params.catalog
          ? findModelInCatalog(
              params.catalog,
              params.candidates[index].provider,
              params.candidates[index].model,
            )
          : undefined,
        { needsVision },
      ),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  if ((orderedRemote[0]?.score ?? Number.NEGATIVE_INFINITY) < 100) {
    return { candidates: params.candidates, changed: false };
  }

  const sortedRemoteCandidates = orderedRemote.map((entry) => entry.candidate);

  const next = [...params.candidates];
  remoteIndexes.forEach((candidateIndex, remoteOrderIndex) => {
    next[candidateIndex] = sortedRemoteCandidates[remoteOrderIndex] ?? next[candidateIndex];
  });

  const changed = next.some((candidate, index) => candidate !== params.candidates[index]);
  if (!changed) {
    return { candidates: params.candidates, changed: false };
  }

  const label =
    profile === "cheap"
      ? "cheap remote fallback"
      : profile === "code"
        ? "code-oriented remote fallback"
        : profile === "presentation"
          ? "presentation-quality remote fallback"
          : "strong remote fallback";
  return {
    candidates: next,
    changed: true,
    reason: `Reordered the remote tail for a ${label} profile.`,
  };
}

function orderPresentationCandidates(params: {
  candidates: ModelCandidate[];
  catalog?: ModelCatalogEntry[];
  plannerInput: LocalRoutingPlannerInput;
}): ModelCandidate[] {
  const needsVision = plannerInputNeedsVisionCapability(params.plannerInput);
  const remote = params.candidates
    .filter((candidate) => !isLikelyControlPlaneLocalProvider(candidate.provider))
    .map((candidate, index) => ({
      candidate,
      index,
      score: scorePreferredRemoteModel(
        candidate,
        "presentation",
        params.catalog ? findModelInCatalog(params.catalog, candidate.provider, candidate.model) : undefined,
        { needsVision },
      ),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.candidate);
  const local = params.candidates.filter((candidate) =>
    isLikelyControlPlaneLocalProvider(candidate.provider),
  );
  return [...remote, ...local];
}

function artifactKindsAllowLightTabularOrCalc(
  kinds: NonNullable<RecipePlannerInput["artifactKinds"]>,
  intent: RecipePlannerInput["intent"],
): boolean {
  if (kinds.length === 0) {
    return true;
  }
  if (kinds.some((kind) => HEAVY_ARTIFACT_KINDS.has(kind))) {
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
  if (typeof plannerInput.routing?.localEligible === "boolean") {
    return plannerInput.routing.localEligible;
  }
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

  if (fileNames.length > 0) {
    if (fileNamesImplyHeavyLocalRoute(fileNames)) {
      return false;
    }
    return false;
  }

  if (kinds.length > 0) {
    return artifactKindsAllowLightTabularOrCalc(kinds, intent);
  }
  return true;
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
  catalog?: ModelCatalogEntry[];
}): { candidates: ModelCandidate[]; decision: ModelRoutePreflightDecision | null } {
  const list = params.candidates;
  if (list.length === 0) {
    return { candidates: list, decision: null };
  }

  const plannerInput = params.plannerInput ?? null;
  if (!plannerInput) {
    return { candidates: list, decision: null };
  }

  // Tool-aware routing (extends PR-#125): when the turn signals a web_search
  // need — either explicitly via `requestedTools` OR structurally via the
  // `public_web_lookup` tool bundle on the resolution contract — promote any
  // candidate that has a working native search capability ahead of the
  // configured chain. OpenClaw's local DDG-backed `web_search` tool is rate-
  // limited / bot-detected, and for models without `compat.nativeWebSearchTool=true`
  // an autonomous `web_search` call dies with `Provider finish_reason: error`
  // (see gateway-grok-route.log 2026-05-02 turn 355ae135). Today only `grok-4`
  // carries the marker (xAI Live Search via openai-completions schema); the
  // curated `NATIVE_WEB_SEARCH_MODEL_IDS` set mirrors the models.json compat
  // blocks. Fallbacks remain in their original order behind the promoted
  // candidate — failover semantics unchanged.
  const requestedTools = plannerInput.requestedTools ?? [];
  const toolBundles = plannerInput.resolutionContract?.toolBundles ?? [];
  const isWebSearchSignaled =
    requestedTools.includes("web_search") || toolBundles.includes("public_web_lookup");
  if (isWebSearchSignaled) {
    const nativeIndex = list.findIndex(hasNativeWebSearchCapability);
    if (nativeIndex > 0) {
      const native = list[nativeIndex];
      const ordered = [native, ...list.filter((_, idx) => idx !== nativeIndex)];
      return {
        candidates: ordered,
        decision: buildDecisionForOrdered(ordered, {
          reasonCode: "preflight_routed_grok_for_web_search",
          reason: `Promoted ${native.provider}/${native.model} ahead of the configured chain because the turn signals web_search (requestedTools or public_web_lookup bundle) and ${native.provider}/${native.model} is the candidate with compat.nativeWebSearchTool=true.`,
          localRoutingEligible: false,
          reordered: true,
        }),
      };
    }
  }

  const localEligible =
    params.mode === "force_stronger"
      ? false
      : plannerInput
        ? inferLocalRoutingEligibleFromPlannerInput(plannerInput)
        : false;

  const finalizeResult = (
    candidates: ModelCandidate[],
    decision: ModelRoutePreflightDecision | null,
  ): { candidates: ModelCandidate[]; decision: ModelRoutePreflightDecision | null } => {
    if (!decision) {
      return { candidates, decision };
    }
    // Heuristic-driven remote-tail reorder runs only on top of decisions that
    // already chose to reorder (`reordered: true`). Passthrough decisions
    // (`preflight_no_local_candidate`, `preflight_stronger_route` keep-order,
    // `preflight_primary_control_plane_local`) preserve user-configured order
    // — overriding them by score caused live regression where a configured
    // primary (e.g. `hydra/claude-opus-4.6`) was bumped behind a cheaper but
    // slower remote (e.g. `hydra/hydra-gpt-pro`) that timed out repeatedly.
    if (!decision.reordered) {
      return { candidates, decision };
    }
    const remoteAdjusted = reorderRemoteTailCandidates({
      candidates,
      plannerInput,
      localEligible,
      catalog: params.catalog,
    });
    if (!remoteAdjusted.changed) {
      return { candidates, decision };
    }
    return {
      candidates: remoteAdjusted.candidates,
      decision: buildDecisionForOrdered(remoteAdjusted.candidates, {
        reasonCode: decision.reasonCode,
        reason: `${decision.reason} ${remoteAdjusted.reason ?? ""}`.trim(),
        localRoutingEligible: decision.localRoutingEligible,
        reordered: true,
      }),
    };
  };
  const findBestRemoteIndex = (profile: RemoteRoutingProfile, needsVision: boolean): number =>
    list.reduce((bestIndex, candidate, index) => {
      if (isLikelyControlPlaneLocalProvider(candidate.provider)) {
        return bestIndex;
      }
      if (bestIndex < 0) {
        return index;
      }
      const candidateScore = scorePreferredRemoteModel(
        candidate,
        profile,
        params.catalog ? findModelInCatalog(params.catalog, candidate.provider, candidate.model) : undefined,
        { needsVision },
      );
      const bestCandidate = list[bestIndex];
      const bestScore = scorePreferredRemoteModel(
        bestCandidate,
        profile,
        params.catalog
          ? findModelInCatalog(params.catalog, bestCandidate.provider, bestCandidate.model)
          : undefined,
        { needsVision },
      );
      return candidateScore > bestScore ? index : bestIndex;
    }, -1);

  if (!localEligible) {
    const shouldPreferRemoteFirst =
      shouldPreferRemoteOrchestratorFirst(plannerInput) ||
      (plannerInput?.intent === "code" &&
        isLikelyControlPlaneLocalProvider(list[0]?.provider ?? ""));
    if (shouldPreferRemoteFirst) {
      const profile = plannerInput ? inferRemoteRoutingProfile(plannerInput, false) : "strong";
      const needsVision = plannerInput ? plannerInputNeedsVisionCapability(plannerInput) : false;
      if (plannerInput && profile === "presentation") {
        const ordered = orderPresentationCandidates({
          candidates: list,
          catalog: params.catalog,
          plannerInput,
        });
        const first = ordered[0];
        if (first && (first.provider !== list[0]?.provider || first.model !== list[0]?.model)) {
          return {
            candidates: ordered,
            decision: buildDecisionForOrdered(ordered, {
              reasonCode: "preflight_reordered_remote_first",
              reason: `Promoted ${first.provider}/${first.model} and reordered the full chain for a presentation-quality remote route.`,
              localRoutingEligible: false,
              reordered: true,
            }),
          };
        }
      }
      const bestRemoteIndex = findBestRemoteIndex(profile, needsVision);
      if (bestRemoteIndex > 0) {
        const remoteCandidate = list[bestRemoteIndex];
        const ordered = [remoteCandidate, ...list.filter((_, index) => index !== bestRemoteIndex)];
        const reason =
          plannerInput?.intent === "code"
            ? `Promoted ${remoteCandidate.provider}/${remoteCandidate.model} ahead of local candidates for a code-intensive turn.`
            : `Promoted ${remoteCandidate.provider}/${remoteCandidate.model} ahead of local candidates for a tool-heavy artifact turn.`;
        return finalizeResult(
          ordered,
          buildDecisionForOrdered(ordered, {
            reasonCode: "preflight_reordered_remote_first",
            reason,
            localRoutingEligible: false,
            reordered: true,
          }),
        );
      }
    }
    if (params.mode !== "force_stronger") {
      const primary = list[0];
      const strongLocalIndex = list.reduce((bestIndex, candidate, index) => {
        if (index === 0 || !isStrongLocalModel(candidate)) {
          return bestIndex;
        }
        if (bestIndex < 0) {
          return index;
        }
        return scorePreferredStrongLocalModel(candidate) >
          scorePreferredStrongLocalModel(list[bestIndex])
          ? index
          : bestIndex;
      }, -1);
      const promoteStrongLocal =
        strongLocalIndex > 0 &&
        isLikelyControlPlaneLocalProvider(primary.provider) &&
        isFastLocalModel(primary.model);
      if (promoteStrongLocal) {
        const localStrongCandidate = list[strongLocalIndex];
        const ordered = [
          localStrongCandidate,
          ...list.filter((_, index) => index !== strongLocalIndex),
        ];
        return {
          ...finalizeResult(
            ordered,
            buildDecisionForOrdered(ordered, {
              reasonCode: "preflight_reordered_local_strong_first",
              reason: `Promoted ${localStrongCandidate.provider}/${localStrongCandidate.model} ahead of the lightweight local primary for a stronger first pass.`,
              localRoutingEligible: false,
              reordered: true,
            }),
          ),
        };
      }
    }
    const primary = list[0];
    const shouldPromoteRemoteForStrongerRoute = isLikelyControlPlaneLocalProvider(primary.provider);
    if (shouldPromoteRemoteForStrongerRoute) {
      const profile = plannerInput ? inferRemoteRoutingProfile(plannerInput, false) : "strong";
      const needsVision = plannerInput ? plannerInputNeedsVisionCapability(plannerInput) : false;
      const bestRemoteIndex = findBestRemoteIndex(profile, needsVision);
      if (bestRemoteIndex > 0) {
        const remoteCandidate = list[bestRemoteIndex];
        const ordered = [remoteCandidate, ...list.filter((_, index) => index !== bestRemoteIndex)];
        return finalizeResult(
          ordered,
          buildDecisionForOrdered(ordered, {
            reasonCode: "preflight_reordered_remote_first",
            reason: `Heuristics require a stronger route, so ${remoteCandidate.provider}/${remoteCandidate.model} was promoted ahead of the lightweight local primary.`,
            localRoutingEligible: false,
            reordered: true,
          }),
        );
      }
    }
    return finalizeResult(
      list,
      buildDecisionForOrdered(list, {
        reasonCode: "preflight_stronger_route",
        reason:
          params.mode === "force_stronger"
            ? "Preflight forced stronger route (e.g. structured or memory workloads)."
            : "Heuristics require a stronger route; keeping configured candidate order.",
        localRoutingEligible: false,
        reordered: false,
      }),
    );
  }

  const preferredLocalIndex = list.reduce((bestIndex, candidate, index) => {
    if (!isLikelyControlPlaneLocalProvider(candidate.provider)) {
      return bestIndex;
    }
    if (bestIndex < 0) {
      return index;
    }
    return scorePreferredLightLocalModel(candidate, plannerInput) >
      scorePreferredLightLocalModel(list[bestIndex], plannerInput)
      ? index
      : bestIndex;
  }, -1);

  const primary = list[0];
  if (shouldPreferCheapRemoteFirstForGeneral(plannerInput)) {
    const profile = plannerInput ? inferRemoteRoutingProfile(plannerInput, true) : "cheap";
    const needsVision = plannerInput ? plannerInputNeedsVisionCapability(plannerInput) : false;
    const bestRemoteIndex = list.reduce((bestIndex, candidate, index) => {
      if (isLikelyControlPlaneLocalProvider(candidate.provider)) {
        return bestIndex;
      }
      if (bestIndex < 0) {
        return index;
      }
      const candidateScore = scorePreferredRemoteModel(
        candidate,
        profile,
        params.catalog
          ? findModelInCatalog(params.catalog, candidate.provider, candidate.model)
          : undefined,
        { needsVision },
      );
      const bestCandidate = list[bestIndex];
      const bestScore = scorePreferredRemoteModel(
        bestCandidate,
        profile,
        params.catalog
          ? findModelInCatalog(params.catalog, bestCandidate.provider, bestCandidate.model)
          : undefined,
        { needsVision },
      );
      return candidateScore > bestScore ? index : bestIndex;
    }, -1);
    if (bestRemoteIndex > 0) {
      const remoteCandidate = list[bestRemoteIndex];
      const ordered = [remoteCandidate, ...list.filter((_, index) => index !== bestRemoteIndex)];
      return finalizeResult(
        ordered,
        buildDecisionForOrdered(ordered, {
          reasonCode: "preflight_reordered_remote_first",
          reason: `Temporary latency mode promoted ${remoteCandidate.provider}/${remoteCandidate.model} ahead of local candidates for a cheap remote-first pass.`,
          localRoutingEligible: false,
          reordered: true,
        }),
      );
    }
  }
  if (isLikelyControlPlaneLocalProvider(primary.provider)) {
    if (preferredLocalIndex > 0) {
      const localCandidate = list[preferredLocalIndex];
      const ordered = [localCandidate, ...list.filter((_, index) => index !== preferredLocalIndex)];
      return finalizeResult(
        ordered,
        buildDecisionForOrdered(ordered, {
          reasonCode: "preflight_reordered_local_first",
          reason: `Promoted ${localCandidate.provider}/${localCandidate.model} ahead of the configured local primary for a faster chat-first pass.`,
          localRoutingEligible: true,
          reordered: true,
        }),
      );
    }
    return finalizeResult(
      list,
      buildDecisionForOrdered(list, {
        reasonCode: "preflight_primary_control_plane_local",
        reason: "Primary candidate is already a control-plane local provider.",
        localRoutingEligible: true,
        reordered: false,
      }),
    );
  }

  if (preferredLocalIndex < 0) {
    return finalizeResult(
      list,
      buildDecisionForOrdered(list, {
        reasonCode: "preflight_no_local_candidate",
        reason: "No control-plane local provider in the candidate chain.",
        localRoutingEligible: true,
        reordered: false,
      }),
    );
  }

  const localCandidate = list[preferredLocalIndex];
  const rest = list.filter((_, i) => i !== preferredLocalIndex);
  const ordered = [localCandidate, ...rest];
  return finalizeResult(
    ordered,
    buildDecisionForOrdered(ordered, {
      reasonCode: "preflight_reordered_local_first",
      reason: `Promoted ${localCandidate.provider}/${localCandidate.model} ahead of primary for a local-eligible turn.`,
      localRoutingEligible: true,
      reordered: true,
    }),
  );
}
