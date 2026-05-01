import { createSubsystemLogger } from "../../logging/subsystem.js";
import { TRUSTED_CAPABILITY_CATALOG } from "../bootstrap/defaults.js";
import type {
  CandidateExecutionFamily,
  OutcomeContract,
  QualificationConfidence,
  QualificationExecutionContract,
  QualificationLowConfidenceStrategy,
  RequestedEvidenceKind,
} from "../decision/qualification-contract.js";
import {
  resolveProfile,
  type ProfileResolution,
  type ProfileResolverInput,
} from "../profile/resolver.js";
import { getCurrentTurnProgressEmitter } from "../progress/progress-bus.js";
import type { ExecutionRecipe, PlannerOutput } from "../schemas/index.js";
import { PlannerOutputSchema } from "../schemas/index.js";
import type { ProfileId } from "../schemas/profile.js";
import { collectMissingRequiredEnvForDeliverable } from "./credentials-preflight.js";
import { INITIAL_RECIPES, getInitialRecipe } from "./defaults.js";

const log = createSubsystemLogger("planner");

type PlannerStackFrame = { fn: string | undefined; loc: string | undefined };

function captureCallerTag(): string {
  const stack = new Error("planner-caller-probe").stack ?? "";
  const lines = stack.split("\n").slice(2);
  const frames: PlannerStackFrame[] = [];
  for (const line of lines) {
    const match = line.match(/at\s+(\S+)\s+\(([^)]+)\)/) ?? line.match(/at\s+(\S+)/);
    if (!match) {
      continue;
    }
    const fn = match[1];
    const loc = match[2];
    if (!fn && !loc) {
      continue;
    }
    frames.push({ fn, loc });
  }
  const interesting = frames
    .filter(
      (frame) =>
        !frame.loc?.includes("recipe\\planner") &&
        !frame.loc?.includes("recipe/planner") &&
        !frame.loc?.includes("logPlannerSelection"),
    )
    .slice(0, 3)
    .map((frame) => {
      const shortLoc = frame.loc
        ?.replace(/^.*[\\/]src[\\/]/, "src/")
        .replace(/^.*[\\/]dist[\\/]/, "dist/")
        .replace(/\\/g, "/")
        .replace(/:\d+:\d+$/, "");
      return frame.fn ? `${frame.fn}@${shortLoc ?? "?"}` : (shortLoc ?? "?");
    });
  return interesting.join(" <- ") || "unknown";
}

function logPlannerSelection(params: {
  recipeId: string;
  input: RecipePlannerInput;
  routingOutcome: RoutingOutcome;
}): void {
  const ec = params.input.executionContract;
  const bundles = params.input.resolutionContract?.toolBundles ?? [];
  const requestedTools = params.input.requestedTools ?? [];
  const caller = params.input.callerTag ?? captureCallerTag();
  const outcome = params.routingOutcome;
  const outcomeLabel =
    outcome.kind === "matched"
      ? `matched:${outcome.source}`
      : outcome.kind === "low_confidence_clarify"
        ? "low_confidence_clarify"
        : `contract_unsatisfiable:${outcome.reasons.join("+")}`;
  const base =
    `recipe=${params.recipeId} routingOutcome=${outcomeLabel}` +
    ` contractFirst=${params.input.contractFirst === true}` +
    ` requiresTools=${Boolean(ec?.requiresTools)}` +
    ` requiresDeliveryEvidence=${Boolean(ec?.requiresDeliveryEvidence)}` +
    ` requiresWorkspaceMutation=${Boolean(ec?.requiresWorkspaceMutation)}` +
    ` requiresLocalProcess=${Boolean(ec?.requiresLocalProcess)}` +
    ` requiresArtifactEvidence=${Boolean(ec?.requiresArtifactEvidence)}` +
    ` outcomeContract=${params.input.outcomeContract ?? "undefined"}` +
    ` toolBundles=[${bundles.join(",")}]` +
    ` requestedTools=[${requestedTools.join(",")}]` +
    ` intent=${params.input.intent ?? "undefined"}` +
    ` caller=${caller}`;
  if (outcome.kind === "contract_unsatisfiable") {
    log.warn(
      `CONTRACT_UNSATISFIABLE planner returned a safe fallback recipe but contract cannot be satisfied. ${base}`,
    );
  } else {
    log.info(`selected: ${base}`);
  }
}
import type { ResolutionContract } from "../decision/resolution-contract.js";
import type { DecisionTrace } from "../decision/trace.js";
import type { DeliverableSpec } from "../produce/registry.js";
import type { CapabilityCatalogEntry } from "../schemas/capability.js";
import {
  deriveFamiliesFromOutcomeContract,
  hasCodeArtifact,
  hasDocumentArtifact,
  hasMediaArtifact,
  selectExecutionFamily,
} from "./family-selector.js";

/**
 * Diagnostic snapshot of how the classifier described the turn. Stored on the
 * runtime plan so downstream layers (debug footer, UI, tests) can see exactly
 * which model/backend classified this turn and what contract it produced,
 * without having to thread a second channel from classifier to reply.
 */
export type ClassifierTelemetry = {
  /**
   * `provenance_guard` is emitted when `buildClassifiedExecutionDecisionInput`
   * short-circuits a non-`external_user` prompt to a respond-only baseline
   * without invoking `runTurnDecision` (see
   * `src/platform/decision/input.ts::buildNonUserProvenanceShortCircuitPlannerInput`).
   * Diagnostic-only — does not influence planner / runtime selection.
   */
  source: "llm" | "fail_closed" | "provenance_guard";
  backend?: string;
  model?: string;
  primaryOutcome?: string;
  interactionMode?: string;
  confidence?: number;
  deliverableKind?: string;
  deliverableFormats?: string[];
};

/**
 * Structured signal describing HOW the recipe was selected. Decouples
 * "which recipe to use" from "can we actually act on it?". Downstream
 * layers (runtime, reply) check {@link RoutingOutcome.kind} to decide
 * whether to execute the recipe normally, ask for clarification, or
 * fail-closed with a diagnostic.
 *
 * States:
 * - `matched`: recipe satisfies the contract (both `toolBundles` and
 *   `executionContract` agree). Safe to execute.
 * - `low_confidence_clarify`: classifier returned low confidence with
 *   strategy=clarify. Recipe is a safe default (general_reasoning) but
 *   caller should prefer to ask a clarifying question before acting.
 * - `contract_unsatisfiable`: classifier declared an execution contract
 *   (tools/evidence/mutation/etc) but no known recipe can satisfy it.
 *   A safe fallback recipe is still returned for rendering purposes,
 *   but callers MUST NOT claim successful execution. This is the proper
 *   fail-closed state.
 */
export type RoutingOutcome =
  | { kind: "matched"; source: "ranked" | "contract_first_fallback" }
  | { kind: "low_confidence_clarify" }
  | { kind: "contract_unsatisfiable"; reasons: string[] };

export const ROUTING_OUTCOME_UNSATISFIABLE_REASONS = {
  noRecipeMatchesToolBundles: "no_recipe_matches_toolBundles",
  noRecipeSatisfiesExecutionContract: "no_recipe_satisfies_executionContract",
  noRecipeMatchesSessionOrchestration: "no_recipe_matches_session_orchestration",
  contractRequiresTools: "contract_requires_tools",
  contractRequiresWorkspaceMutation: "contract_requires_workspace_mutation",
  contractRequiresLocalProcess: "contract_requires_local_process",
  contractRequiresDeliveryEvidence: "contract_requires_delivery_evidence",
  contractRequiresArtifactEvidence: "contract_requires_artifact_evidence",
  rankerDowngradedToGeneralReasoning:
    "ranker_downgraded_to_general_reasoning_despite_tool_contract",
} as const;

function contractRequiresToolingFlags(ec: QualificationExecutionContract | undefined): string[] {
  if (!ec) {
    return [];
  }
  const reasons: string[] = [];
  if (ec.requiresTools) {
    reasons.push(ROUTING_OUTCOME_UNSATISFIABLE_REASONS.contractRequiresTools);
  }
  if (ec.requiresWorkspaceMutation) {
    reasons.push(ROUTING_OUTCOME_UNSATISFIABLE_REASONS.contractRequiresWorkspaceMutation);
  }
  if (ec.requiresLocalProcess) {
    reasons.push(ROUTING_OUTCOME_UNSATISFIABLE_REASONS.contractRequiresLocalProcess);
  }
  if (ec.requiresDeliveryEvidence) {
    reasons.push(ROUTING_OUTCOME_UNSATISFIABLE_REASONS.contractRequiresDeliveryEvidence);
  }
  if (ec.requiresArtifactEvidence) {
    reasons.push(ROUTING_OUTCOME_UNSATISFIABLE_REASONS.contractRequiresArtifactEvidence);
  }
  return reasons;
}

function contractDemandsTooling(ec: QualificationExecutionContract | undefined): boolean {
  return contractRequiresToolingFlags(ec).length > 0;
}

export type RecipeRoutingHints = {
  localEligible?: boolean;
  remoteProfile?: "cheap" | "code" | "strong" | "presentation";
  preferRemoteFirst?: boolean;
  needsVision?: boolean;
};

export type RecipePlannerInput = ProfileResolverInput & {
  contractFirst?: boolean;
  intent?: "general" | "document" | "code" | "publish" | "compare" | "calculation";
  outcomeContract?: OutcomeContract;
  executionContract?: QualificationExecutionContract;
  requestedEvidence?: RequestedEvidenceKind[];
  confidence?: QualificationConfidence;
  ambiguityReasons?: string[];
  lowConfidenceStrategy?: QualificationLowConfidenceStrategy;
  candidateFamilies?: CandidateExecutionFamily[];
  resolutionContract?: ResolutionContract;
  recipes?: ExecutionRecipe[];
  routing?: RecipeRoutingHints;
  deliverable?: DeliverableSpec;
  taskRequiredCapabilities?: string[];
  capabilityCatalog?: CapabilityCatalogEntry[];
  preflightEnvSnapshot?: NodeJS.ProcessEnv;
  classifierTelemetry?: ClassifierTelemetry;
  decisionTrace?: DecisionTrace;
  /**
   * Diagnostic-only: human-readable tag identifying which call site produced this
   * planner input. Threaded into logs so we can see how many distinct entry points
   * are invoking the planner per user turn. Does not affect routing.
   */
  callerTag?: string;
};

function isScaffoldDeliverable(deliverable?: DeliverableSpec): boolean {
  if (deliverable?.kind !== "code_change") {
    return false;
  }
  const operation = deliverable.constraints?.operation;
  return typeof operation === "string" && operation === "scaffold_repo";
}

export function collectMissingRequiredEnvForCapabilities(params: {
  capabilityIds: string[];
  capabilityCatalog?: CapabilityCatalogEntry[];
  envSnapshot?: NodeJS.ProcessEnv;
}): string[] {
  if (params.capabilityIds.length === 0) {
    return [];
  }
  const catalog = params.capabilityCatalog ?? TRUSTED_CAPABILITY_CATALOG;
  const env = params.envSnapshot ?? process.env;
  const missing = new Set<string>();
  const byId = new Map(catalog.map((entry) => [entry.capability.id, entry]));
  for (const capabilityId of params.capabilityIds) {
    const requiredEnv = byId.get(capabilityId)?.capability.requiredEnv ?? [];
    for (const envName of requiredEnv) {
      const value = env[envName];
      if (typeof value !== "string" || value.trim().length === 0) {
        missing.add(envName);
      }
    }
  }
  return Array.from(missing).toSorted();
}

function rewritePlanToCredentialClarification(params: {
  input: RecipePlannerInput;
  basePlan: ExecutionPlan;
  missingCredentials: string[];
}): ExecutionPlan {
  const selectedRecipe = getInitialRecipe("general_reasoning") ?? INITIAL_RECIPES[0];
  const selectedModelOverride = resolvePlannerModelOverride({
    recipe: selectedRecipe,
    profile: params.basePlan.profile,
  });
  const plannerOutput = PlannerOutputSchema.parse({
    selectedRecipeId: selectedRecipe.id,
    reasoning: [
      "Credentials preflight blocked scaffold execution before tool calls.",
      `Missing required environment variables: ${params.missingCredentials.join(", ")}.`,
      "Failing closed to clarification (respond-only invariant).",
      params.input.confidence ? `Qualification confidence: ${params.input.confidence}.` : undefined,
      params.input.ambiguityReasons?.length
        ? `Ambiguity: ${params.input.ambiguityReasons.join("; ")}.`
        : undefined,
    ]
      .filter(Boolean)
      .join(" "),
    ...(selectedModelOverride ? { overrides: { model: selectedModelOverride } } : {}),
  });
  return {
    profile: params.basePlan.profile,
    recipe: selectedRecipe,
    plannerOutput,
    candidateRecipes: params.basePlan.candidateRecipes,
    routingOutcome: { kind: "low_confidence_clarify" },
  };
}

export type ExecutionPlan = {
  profile: ProfileResolution;
  recipe: ExecutionRecipe;
  plannerOutput: PlannerOutput;
  candidateRecipes: ExecutionRecipe[];
  /**
   * Structured routing status. Always present. Consumers MUST switch on
   * {@link RoutingOutcome.kind} before claiming successful execution:
   * `matched` is the only kind that represents a satisfied contract.
   */
  routingOutcome: RoutingOutcome;
  /**
   * Heuristic upper-bound estimate of how long the run will take, in
   * milliseconds. Derived without LLM calls from structured classifier
   * signals (outcomeContract, deliverable.constraints) and recipe metadata
   * (required capabilities, requested tools). Consumed by the ack-then-defer
   * dispatcher (P1.4 D.2) to decide whether the user should receive an
   * immediate ack frame while the heavy work runs as a bg-job. Filled by
   * {@link planExecutionRecipe}; internal callers should treat `undefined`
   * as "not yet computed".
   */
  estimatedDurationMs?: number;
  /**
   * True when the planner decided this run should receive an immediate ack
   * and be dispatched as a deferred bg-job. Activated when
   * `estimatedDurationMs > OPENCLAW_ACK_DEFER_MS` (default 3000), when the
   * selected recipe declares `capability_install`/`bootstrap` as a required
   * capability, or when `requestedTools` includes `capability_install`.
   * Only present on matched routing outcomes.
   */
  ackThenDefer?: boolean;
};

export const DEFAULT_ACK_DEFER_THRESHOLD_MS = 3_000;
export const ACK_DEFER_THRESHOLD_ENV = "OPENCLAW_ACK_DEFER_MS";

/**
 * Non-LLM hints that mark a run as long-running even when
 * `estimatedDurationMs` would otherwise slot under the threshold.
 *
 * We intentionally narrow these to the cases where the structural signal is
 * strong enough that an immediate "принял, работаю" ack is genuinely useful:
 * - `capability_install` (requested tool or required capability): bootstrap
 *   flows install dependencies, typically >3s.
 * - `outcomeContract === "interactive_local_result"`: classifier explicitly
 *   marked this turn as needing a long-lived local process (dev server,
 *   build, test runner). This is the structural discriminator that lets us
 *   distinguish `exec "node --version"` (one-shot) from `exec "npm run build"`
 *   (long), without parsing the user prompt.
 * - `image_generate` with `deliverable.constraints.batch > 1`: multi-image
 *   batches noticeably exceed the threshold; single image renders do not.
 *
 * What is intentionally NOT here:
 * - `apply_patch`, single `image_generate`, `pdf`, plain `exec`/`process`:
 *   these are typically <3s and previously over-triggered the ack ("принял
 *   на каждый non-trivial turn", live UX gap from 2026-04-21).
 */
const LONG_RUN_CAPABILITY_HINTS = new Set<string>(["capability_install", "bootstrap"]);

const LONG_RUN_TOOL_HINTS = new Set<string>(["capability_install"]);

const LONG_RUN_OUTCOME_CONTRACTS = new Set<OutcomeContract>(["interactive_local_result"]);

export function resolveAckDeferThresholdMs(envSnapshot: NodeJS.ProcessEnv = process.env): number {
  const raw = envSnapshot[ACK_DEFER_THRESHOLD_ENV];
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return DEFAULT_ACK_DEFER_THRESHOLD_MS;
}

function recipeHasLongRunningCapability(recipe: ExecutionRecipe): boolean {
  const capabilities = recipe.requiredCapabilities ?? [];
  for (const capability of capabilities) {
    if (typeof capability === "string" && LONG_RUN_CAPABILITY_HINTS.has(capability)) {
      return true;
    }
  }
  return false;
}

function requestedToolsIncludeLongRunning(requestedTools?: string[]): boolean {
  if (!requestedTools?.length) {
    return false;
  }
  for (const tool of requestedTools) {
    if (typeof tool !== "string") {
      continue;
    }
    if (LONG_RUN_TOOL_HINTS.has(tool.trim().toLowerCase())) {
      return true;
    }
  }
  return false;
}

function outcomeContractImpliesLongRun(outcomeContract?: OutcomeContract): boolean {
  return Boolean(outcomeContract && LONG_RUN_OUTCOME_CONTRACTS.has(outcomeContract));
}

function readBatchHint(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function deliverableImpliesLongRun(
  deliverable?: DeliverableSpec,
  requestedTools?: string[],
): boolean {
  if (!deliverable || deliverable.kind !== "image") {
    return false;
  }
  const usesImageGenerate = (requestedTools ?? []).some(
    (tool) => typeof tool === "string" && tool.trim().toLowerCase() === "image_generate",
  );
  if (!usesImageGenerate) {
    return false;
  }
  const constraints = deliverable.constraints ?? {};
  const batch = readBatchHint(constraints.batch) ?? readBatchHint(constraints.count);
  return typeof batch === "number" && batch > 1;
}

/**
 * Heuristic duration estimate for a turn. NOTE: This is a non-LLM upper-bound,
 * intentionally coarse. It exists purely to feed the ack-then-defer decision
 * (P1.4 D.2). Never treat it as a real runtime budget.
 *
 * Signals are taken exclusively from structured classifier output and recipe
 * metadata — never from parsing the user prompt (guard:
 * lint:routing:no-prompt-parsing). The triggers are intentionally narrow so
 * short turns (typo fix, single apply_patch, `node --version` exec) do not
 * receive an "принял, работаю" frame.
 *
 * We intentionally do NOT use `recipe.timeoutSeconds` as a duration proxy:
 * that value is a safety ceiling (e.g. 90s for general_reasoning) and would
 * force nearly every turn above the 3s defer threshold.
 */
export function estimateRecipeDurationMs(params: {
  recipe: ExecutionRecipe;
  requestedTools?: string[];
  outcomeContract?: OutcomeContract;
  executionContract?: QualificationExecutionContract;
  deliverable?: DeliverableSpec;
}): number {
  if (
    recipeHasLongRunningCapability(params.recipe) ||
    requestedToolsIncludeLongRunning(params.requestedTools)
  ) {
    return 8_000;
  }
  if (outcomeContractImpliesLongRun(params.outcomeContract)) {
    return 7_000;
  }
  if (deliverableImpliesLongRun(params.deliverable, params.requestedTools)) {
    return 6_000;
  }
  return 1_500;
}

export function decideAckThenDefer(params: {
  estimatedDurationMs: number;
  recipe: ExecutionRecipe;
  requestedTools?: string[];
  thresholdMs?: number;
}): boolean {
  const threshold = params.thresholdMs ?? resolveAckDeferThresholdMs();
  if (params.estimatedDurationMs > threshold) {
    return true;
  }
  if (recipeHasLongRunningCapability(params.recipe)) {
    return true;
  }
  if (requestedToolsIncludeLongRunning(params.requestedTools)) {
    return true;
  }
  return false;
}

function isContractFirstInput(input: RecipePlannerInput): boolean {
  return input.contractFirst === true;
}

const RECIPE_FAMILIES: Record<string, CandidateExecutionFamily[]> = {
  general_reasoning: ["general_assistant"],
  doc_ingest: ["document_render"],
  doc_authoring: ["document_render"],
  ocr_extract: ["document_render"],
  table_extract: ["document_render"],
  table_compare: ["analysis_transform"],
  calculation_report: ["analysis_transform"],
  code_build_publish: ["code_build"],
  integration_delivery: ["ops_execution"],
  ops_orchestration: ["ops_execution"],
  media_production: ["media_generation"],
};

function recipeMatchesProfile(recipe: ExecutionRecipe, profileId: ProfileId): boolean {
  return !recipe.allowedProfiles || recipe.allowedProfiles.includes(profileId);
}

function getRecipeFamilies(recipe: ExecutionRecipe): CandidateExecutionFamily[] {
  return RECIPE_FAMILIES[recipe.id] ?? [];
}

function hasMatchingTarget(recipe: ExecutionRecipe, publishTargets: string[]): boolean {
  if (!recipe.publishTargets || publishTargets.length === 0) {
    return false;
  }
  const allowed = new Set(recipe.publishTargets.map((value) => value.toLowerCase()));
  return publishTargets.some((target) => allowed.has(target));
}

// Maps tool bundles to recipe capability requirements.
// This is the contract-based routing source of truth.
function toolBundlesMatchRecipe(toolBundles: string[], recipe: ExecutionRecipe): boolean {
  const bundles = new Set(toolBundles);
  const capabilities = new Set(recipe.requiredCapabilities ?? []);

  // respond_only: general_reasoning only
  if (bundles.has("respond_only") && recipe.id === "general_reasoning") {
    return true;
  }

  // repo_mutation or repo_run: code/recipe related
  if (
    (bundles.has("repo_mutation") || bundles.has("repo_run")) &&
    (capabilities.has("node") || capabilities.has("git"))
  ) {
    return true;
  }

  // interactive_browser: not specific to any current recipe, allow general or code
  if (bundles.has("interactive_browser")) {
    return (
      recipe.id === "general_reasoning" ||
      recipe.id === "code_build_publish" ||
      recipe.id === "integration_delivery"
    );
  }

  // public_web_lookup: general reasoning or analysis
  if (bundles.has("public_web_lookup")) {
    return (
      recipe.id === "general_reasoning" ||
      recipe.id === "calculation_report" ||
      recipe.id === "table_compare"
    );
  }

  // document_extraction: doc/ocr/table recipes
  if (bundles.has("document_extraction")) {
    return (
      recipe.id.startsWith("doc_") || recipe.id.startsWith("ocr_") || recipe.id.startsWith("table_")
    );
  }

  // artifact_authoring: authoring / packaging recipes only
  if (bundles.has("artifact_authoring")) {
    return recipe.id === "doc_authoring" || recipe.id === "media_production";
  }

  // external_delivery: code/integration/ops recipes
  if (bundles.has("external_delivery")) {
    return (
      recipe.id === "code_build_publish" ||
      recipe.id === "integration_delivery" ||
      recipe.id === "ops_orchestration"
    );
  }

  // session_orchestration: persistent worker/subagent setup only
  if (bundles.has("session_orchestration")) {
    return recipe.id === "ops_orchestration";
  }

  // If no specific bundle matches, use respond_only as default
  return recipe.id === "general_reasoning";
}

function executionContractAllowsRecipe(
  executionContract: QualificationExecutionContract | undefined,
  recipe: ExecutionRecipe,
): boolean {
  if (!executionContract) {
    return true;
  }

  if (!executionContract.requiresTools) {
    return recipe.id === "general_reasoning";
  }

  if (recipe.id === "general_reasoning") {
    return (
      executionContract.requiresTools !== true &&
      executionContract.requiresArtifactEvidence !== true &&
      executionContract.requiresWorkspaceMutation !== true &&
      executionContract.requiresLocalProcess !== true &&
      executionContract.requiresDeliveryEvidence !== true
    );
  }

  if (executionContract.requiresWorkspaceMutation || executionContract.requiresLocalProcess) {
    return (
      recipe.id === "code_build_publish" ||
      recipe.id === "integration_delivery" ||
      recipe.id === "ops_orchestration"
    );
  }

  if (executionContract.requiresArtifactEvidence && recipe.id === "general_reasoning") {
    return false;
  }

  return true;
}

function selectContractFallbackRecipe(params: {
  candidateRecipes: ExecutionRecipe[];
  input: RecipePlannerInput;
}): ExecutionRecipe | undefined {
  const { candidateRecipes, input } = params;
  const executionContract = input.executionContract;
  const bundles = new Set(input.resolutionContract?.toolBundles ?? []);

  const preferredIds = bundles.has("session_orchestration")
    ? ["ops_orchestration"]
    : executionContract?.requiresWorkspaceMutation || executionContract?.requiresLocalProcess
      ? ["code_build_publish", "integration_delivery", "ops_orchestration"]
      : executionContract?.requiresArtifactEvidence || bundles.has("artifact_authoring")
        ? ["doc_authoring", "doc_ingest", "media_production", "table_compare", "calculation_report"]
        : executionContract?.requiresDeliveryEvidence || bundles.has("external_delivery")
          ? ["integration_delivery", "code_build_publish", "ops_orchestration"]
          : bundles.has("interactive_browser") || bundles.has("public_web_lookup")
            ? ["table_compare", "calculation_report", "general_reasoning"]
            : ["general_reasoning"];

  return preferredIds
    .map((id) => candidateRecipes.find((recipe) => recipe.id === id))
    .find((recipe): recipe is ExecutionRecipe => Boolean(recipe));
}

// Narrows the candidate recipe pool using contract-based matching.
//
// Source of truth:
//   1. resolutionContract.toolBundles (primary)
//   2. input.executionContract (secondary)
//   3. Family fallback only for legacy non-contractFirst inputs.
//
// Family labels (selectedFamily/candidateFamilies) are now debug/eval only.
function narrowRecipesByContract(params: {
  candidateRecipes: ExecutionRecipe[];
  input: RecipePlannerInput;
}): { selectedFamily?: CandidateExecutionFamily; recipes: ExecutionRecipe[] } {
  const { candidateRecipes, input } = params;
  const contractFirst = input.contractFirst === true;

  // Contract-first: use toolBundles + executionContract as source of truth.
  // Never widen back to full recipe pool in this path.
  if (contractFirst) {
    const toolBundles = input.resolutionContract?.toolBundles ?? [];
    if (toolBundles.length === 0) {
      return {
        selectedFamily: input.resolutionContract?.selectedFamily,
        recipes: [],
      };
    }

    const matchingRecipes = candidateRecipes.filter(
      (recipe) =>
        toolBundlesMatchRecipe(toolBundles, recipe) &&
        executionContractAllowsRecipe(input.executionContract, recipe),
    );
    if (matchingRecipes.length > 0) {
      return {
        selectedFamily: input.resolutionContract?.selectedFamily,
        recipes: matchingRecipes,
      };
    }

    const executionScopedRecipes = candidateRecipes.filter((recipe) =>
      executionContractAllowsRecipe(input.executionContract, recipe),
    );
    if (executionScopedRecipes.length > 0) {
      return {
        selectedFamily: input.resolutionContract?.selectedFamily,
        recipes: executionScopedRecipes,
      };
    }

    return {
      selectedFamily: input.resolutionContract?.selectedFamily,
      recipes: [],
    };
  }

  // Legacy fallback: family-based narrowing for non-contractFirst inputs only.
  const requestedFamilies: CandidateExecutionFamily[] = Array.from(
    new Set(
      input.resolutionContract?.candidateFamilies?.length
        ? input.resolutionContract.candidateFamilies
        : input.candidateFamilies?.length
          ? input.candidateFamilies
          : input.outcomeContract
            ? deriveFamiliesFromOutcomeContract(input.outcomeContract)
            : [],
    ),
  );

  if (requestedFamilies.length === 0) {
    return { recipes: candidateRecipes };
  }

  const availableFamilies = requestedFamilies.filter((family) =>
    candidateRecipes.some((recipe) => getRecipeFamilies(recipe).includes(family)),
  );

  const resolvedSelectedFamily = input.resolutionContract?.selectedFamily;
  const selectedFamily =
    resolvedSelectedFamily && availableFamilies.includes(resolvedSelectedFamily)
      ? resolvedSelectedFamily
      : selectExecutionFamily(requestedFamilies, availableFamilies, {
          outcomeContract: input.outcomeContract,
          artifactKinds: input.artifactKinds,
        });

  if (!selectedFamily) {
    return { recipes: candidateRecipes };
  }

  return {
    selectedFamily,
    recipes: candidateRecipes.filter((recipe) =>
      getRecipeFamilies(recipe).includes(selectedFamily),
    ),
  };
}

function buildRecipeScore(params: {
  recipe: ExecutionRecipe;
  profile: ProfileResolution;
  input: RecipePlannerInput;
}): number {
  const { recipe, profile, input } = params;
  const overlayId = profile.activeProfile.taskOverlay;
  const tools = new Set((input.requestedTools ?? []).map((value) => value.toLowerCase()));
  const artifactKinds = input.artifactKinds ?? [];
  const fileNames = (input.fileNames ?? []).map((value) => value.toLowerCase());
  const bundles = new Set(input.resolutionContract?.toolBundles ?? []);
  const routing = input.routing ?? input.resolutionContract?.routing;
  const outcomeContract = input.outcomeContract;
  const executionContract = input.executionContract;
  const hasDocument = hasDocumentArtifact(artifactKinds);
  const hasCode = hasCodeArtifact(artifactKinds);
  const hasMedia = hasMediaArtifact(artifactKinds);
  const hasReportOrData = artifactKinds.some((kind) => kind === "report" || kind === "data");
  const hasPdfFile = fileNames.some((name) => name.endsWith(".pdf"));
  const hasTabularFile = fileNames.some(
    (name) =>
      name.endsWith(".csv") ||
      name.endsWith(".xls") ||
      name.endsWith(".xlsx") ||
      name.endsWith(".ods"),
  );
  const hasRepoMutation = bundles.has("repo_mutation");
  const hasRepoRun = bundles.has("repo_run");
  const hasDocumentExtraction = bundles.has("document_extraction");
  const hasArtifactAuthoring = bundles.has("artifact_authoring");
  const hasBrowserBundle = bundles.has("interactive_browser");
  const hasWebLookup = bundles.has("public_web_lookup");
  const hasDeliveryBundle = bundles.has("external_delivery");
  const hasSessionOrchestration = bundles.has("session_orchestration");
  const profileBias =
    routing?.remoteProfile === "presentation"
      ? "presentation"
      : routing?.remoteProfile === "code"
        ? "code"
        : undefined;

  // Bug C — recipe routing для intent=publish.
  // Структурные сигналы для tie-break внутри ops_execution-семьи. Никакого
  // text-rule matching на user prompt (invariant #5). Используются
  // нормализованные publishTargets / integrations поля из classifier/resolution.
  // Profile id=integrator как сигнал не используется специально: он
  // выбирается по умолчанию для external_operation в profile/resolver.ts:140
  // даже без явных integration-сигналов и не различает «реальный integration
  // turn» и «default publish без сигнала».
  const publishTargetsLower = (input.publishTargets ?? []).map((value) =>
    value.toLowerCase(),
  );
  const integrationsLower = (input.integrations ?? []).map((value) =>
    value.toLowerCase(),
  );
  // Target уникальный для integration_delivery vs code_build_publish (см.
  // recipe defaults.ts): только webhook не пересекается с code_build_publish.
  const hasIntegrationOnlyTarget = publishTargetsLower.includes("webhook");
  // Подмножество INTEGRATOR_INTEGRATIONS из profile/signals.ts — структурный
  // классификатор уже различает их как integrator-конфигурации.
  const integrationSignalIntegrations = new Set([
    "slack",
    "discord",
    "notion",
    "confluence",
    "jira",
    "linear",
    "zapier",
    "webhook",
    "mcp",
  ]);
  const hasIntegrationConfigSignal = integrationsLower.some((value) =>
    integrationSignalIntegrations.has(value),
  );
  const isPublishIntent = input.intent === "publish";
  const isIntegrationConfident = hasIntegrationOnlyTarget || hasIntegrationConfigSignal;

  if (recipe.id === "general_reasoning") {
    let score = 0.2;
    if (profile.selectedProfile.id === "general") {
      score += 0.5;
    }
    if (overlayId === "general_chat") {
      score += 1.2;
    }
    if (outcomeContract === "text_response") {
      score += 1.4;
    }
    if (!executionContract?.requiresTools) {
      score += 0.6;
    }
    if (bundles.has("respond_only")) {
      score += 1;
    }
    if (!hasDocument && !hasCode && !hasMedia) {
      score += 0.3;
    }
    if (
      executionContract?.requiresArtifactEvidence ||
      executionContract?.requiresWorkspaceMutation ||
      executionContract?.requiresDeliveryEvidence
    ) {
      score -= 1.4;
    }
    return score;
  }

  if (recipe.id === "doc_ingest") {
    let score = 0;
    if (profile.selectedProfile.id === "builder" && hasDocument) {
      score += 1;
    }
    if (overlayId === "document_first" && hasDocument) {
      score += 1.4;
    }
    if (outcomeContract === "structured_artifact") {
      score += 0.8;
    }
    if (executionContract?.requiresArtifactEvidence) {
      score += 1.3;
    }
    if (hasDocument) {
      score += 0.9;
    }
    if (hasPdfFile) {
      score += 1.8;
    }
    if (hasDocumentExtraction) {
      score += 2;
    }
    if (hasArtifactAuthoring) {
      score -= 1.5;
    }
    return score;
  }

  if (recipe.id === "doc_authoring") {
    let score = 0;
    if (profile.selectedProfile.id === "builder" && hasDocument) {
      score += 1;
    } else if (profile.selectedProfile.id === "general" && hasDocument) {
      score += 0.6;
    }
    if (overlayId === "document_first" && hasDocument) {
      score += 1.4;
    }
    if (outcomeContract === "structured_artifact") {
      score += 0.8;
    }
    if (executionContract?.requiresArtifactEvidence) {
      score += 1.1;
    }
    if (hasDocument) {
      score += 1.1;
    }
    if (tools.has("pdf")) {
      score += 2.6;
    }
    if (hasArtifactAuthoring) {
      score += 2.6;
    }
    if (hasMedia && tools.has("image_generate")) {
      score += 0.7;
    }
    if (hasDocumentExtraction) {
      score -= 1.5;
    }
    return score;
  }

  if (recipe.id === "ocr_extract") {
    let score = 0;
    if (profile.selectedProfile.id === "builder" && hasDocument) {
      score += 1;
    }
    if (overlayId === "document_first" && hasDocument) {
      score += 1.2;
    }
    if (outcomeContract === "structured_artifact") {
      score += 0.6;
    }
    if (executionContract?.requiresArtifactEvidence) {
      score += 0.8;
    }
    if (hasDocument) {
      score += 0.5;
    }
    if (hasDocumentExtraction) {
      score += 0.4;
    }
    if (hasArtifactAuthoring) {
      score -= 1.2;
    }
    return score;
  }

  if (recipe.id === "table_extract") {
    let score = 0;
    if (profile.selectedProfile.id === "builder" && hasDocument) {
      score += 1;
    }
    if (overlayId === "document_first" && hasDocument) {
      score += 1.1;
    }
    if (outcomeContract === "structured_artifact") {
      score += 0.5;
    }
    if (executionContract?.requiresArtifactEvidence) {
      score += 0.7;
    }
    if (hasDocumentExtraction) {
      score += 0.6;
    }
    if (hasReportOrData) {
      score += 0.5;
    }
    if (hasDocument) {
      score += 0.5;
    }
    if (hasArtifactAuthoring) {
      score -= 1.2;
    }
    return score;
  }

  if (recipe.id === "table_compare") {
    let score = 0;
    if (profile.selectedProfile.id === "builder" && hasReportOrData) {
      score += 1;
    }
    if (overlayId === "document_first" && hasReportOrData) {
      score += 1.2;
    }
    if (outcomeContract === "text_response") {
      score += 1;
    }
    if (hasReportOrData) {
      score += 1.4;
    }
    if (hasTabularFile) {
      score += 1.4;
    }
    if (hasPdfFile && !hasTabularFile) {
      score -= 2.2;
    }
    if (!executionContract?.requiresArtifactEvidence) {
      score += 0.5;
    }
    if (!executionContract?.requiresTools) {
      score += 0.5;
    }
    if (hasWebLookup) {
      score += 0.6;
    }
    if (hasBrowserBundle || hasArtifactAuthoring) {
      score -= 1.5;
    }
    return score;
  }

  if (recipe.id === "calculation_report") {
    let score = 0;
    if (profile.selectedProfile.id === "builder" || profile.selectedProfile.id === "general") {
      score += 0.95;
    }
    if (overlayId === "document_first") {
      score += 0.65;
    }
    if (outcomeContract === "text_response") {
      score += 1.2;
    }
    if (!executionContract?.requiresTools) {
      score += 1.3;
    }
    if (!executionContract?.requiresArtifactEvidence) {
      score += 0.4;
    }
    if (hasReportOrData) {
      score += 0.5;
    }
    if (hasBrowserBundle || hasArtifactAuthoring || hasCode || hasMedia) {
      score -= 0.8;
    }
    return score;
  }

  if (recipe.id === "code_build_publish") {
    let score = 0;
    if (profile.selectedProfile.id === "developer") {
      score += 1;
    } else if (profile.selectedProfile.id === "integrator") {
      score += 0.45;
    } else if (profile.selectedProfile.id === "media_creator") {
      score += 0.35;
    }
    if (overlayId === "code_first" || overlayId === "publish_release") {
      score += 1.4;
    }
    if (profileBias === "code") {
      score += 0.8;
    }
    if (outcomeContract === "workspace_change") {
      score += 2.2;
    }
    if (outcomeContract === "external_operation") {
      score += 0.6;
    }
    if (executionContract?.requiresWorkspaceMutation) {
      score += 2.5;
    }
    if (executionContract?.requiresLocalProcess) {
      score += 1.2;
    }
    if (executionContract?.requiresDeliveryEvidence) {
      score += 0.9;
    }
    if (hasCode) {
      score += 0.9;
    }
    if (tools.has("exec") || tools.has("process") || tools.has("apply_patch")) {
      score += 0.6;
    }
    if (hasRepoMutation) {
      score += 2.2;
    }
    if (hasRepoRun) {
      score += 1.5;
    }
    if (hasDeliveryBundle) {
      score += 0.7;
    }
    if (hasSessionOrchestration) {
      score -= 2.5;
    }
    if (hasDocument && !hasCode) {
      score -= 1.2;
    }
    return score;
  }

  if (recipe.id === "integration_delivery") {
    let score = 0;
    if (profile.selectedProfile.id === "integrator") {
      score += 1.2;
    } else if (profile.selectedProfile.id === "developer") {
      score += 0.4;
    }
    if (overlayId === "integration_first" || overlayId === "publish_release") {
      score += 1.4;
    }
    if (outcomeContract === "external_operation") {
      score += 1.4;
    }
    if (executionContract?.requiresDeliveryEvidence) {
      score += 1.8;
    }
    if (hasDeliveryBundle) {
      score += 1.8;
    }
    if (hasSessionOrchestration) {
      score -= 2.2;
    }
    if (hasCode) {
      score += 0.4;
    }
    if (hasRepoRun) {
      score += 0.6;
    }
    if (tools.has("exec") || tools.has("process")) {
      score += 0.4;
    }
    if (hasRepoMutation) {
      score -= 0.8;
    }
    if (profileBias === "code") {
      score += 0.8;
    }
    // Bug C: явный integration-only target → подтверждаем интеграционную ветку.
    if (hasIntegrationOnlyTarget) {
      score += 1.2;
    }
    // Bug C: для intent=publish без интеграционного сигнала integration_delivery
    // не должен опережать ops_orchestration / code_build_publish. Симптом —
    // ранний refusal до правильной recipe; «второй pass = ops_orchestration»
    // достигался добавлением session_orchestration / requiresLocalProcess.
    if (isPublishIntent && !isIntegrationConfident) {
      score -= 2.5;
    }
    return score;
  }

  if (recipe.id === "ops_orchestration") {
    let score = 0;
    if (profile.selectedProfile.id === "operator") {
      score += 1.2;
    }
    if (
      overlayId === "ops_first" ||
      overlayId === "machine_control" ||
      overlayId === "bootstrap_capability"
    ) {
      score += 1.5;
    }
    if (outcomeContract === "external_operation") {
      score += 1;
    }
    if (hasSessionOrchestration) {
      score += 3.2;
    }
    if (executionContract?.requiresLocalProcess) {
      score += 1.2;
    }
    if (executionContract?.requiresDeliveryEvidence) {
      score += 0.4;
    }
    if (tools.has("exec") || tools.has("process")) {
      score += 0.5;
    }
    if (hasRepoRun) {
      score += 0.5;
    }
    if (hasRepoMutation) {
      score -= 1.2;
    }
    // Bug C: для intent=publish без интеграционного сигнала и без session-pool'а
    // ops_orchestration становится дефолтом семьи ops_execution (закрывает
    // «первый pass = integration_delivery, второй pass = ops_orchestration»).
    if (isPublishIntent && !isIntegrationConfident && !hasSessionOrchestration) {
      score += 1.5;
    }
    return score;
  }

  if (recipe.id === "media_production") {
    let score = 0;
    if (profile.selectedProfile.id === "media_creator") {
      score += 1.2;
    }
    if (overlayId === "media_first" || overlayId === "media_publish") {
      score += 1.4;
    }
    if (outcomeContract === "structured_artifact") {
      score += 0.8;
    }
    if (hasMedia) {
      score += 2;
    }
    if (executionContract?.requiresArtifactEvidence) {
      score += 0.5;
    }
    if (tools.has("image_generate")) {
      score += 1.2;
    }
    if (hasArtifactAuthoring) {
      score += 0.8;
    }
    if (tools.has("pdf")) {
      score -= 0.6;
    }
    if (hasCode) {
      score -= 1.2;
    }
    return score;
  }

  return 0;
}

function resolvePlannerReason(params: {
  recipe: ExecutionRecipe;
  profile: ProfileResolution;
  selectedFamily?: CandidateExecutionFamily;
}): string {
  const overlayId = params.profile.activeProfile.taskOverlay;
  const overlayText = overlayId ? ` Task overlay: ${overlayId}.` : "";
  const familyText = params.selectedFamily ? ` Family: ${params.selectedFamily}.` : "";
  return `Recipe ${params.recipe.id} selected for profile ${params.profile.selectedProfile.id}.${familyText}${overlayText}`;
}

function resolvePlannerModelOverride(params: {
  recipe: ExecutionRecipe;
  profile: ProfileResolution;
}): string | undefined {
  return params.recipe.defaultModel ?? params.profile.selectedProfile.defaultModel;
}

export function planExecutionRecipe(input: RecipePlannerInput): ExecutionPlan {
  const emitter = getCurrentTurnProgressEmitter();
  emitter?.emit("planning");
  let plan = planExecutionRecipeCore(input);
  if (plan.routingOutcome.kind === "matched" && isScaffoldDeliverable(input.deliverable)) {
    // P1.6.1: env requirements come from two sources, unioned.
    //   - Capabilities listed by the classifier — kept for back-compat with
    //     any custom catalog that still pins `requiredEnv` on a capability
    //     (the bundled `needs_repo_execution` no longer does).
    //   - The deliverable's `provider`/`integration` constraint, resolved
    //     through the provider→envKeys table in `credentials-preflight.ts`.
    // The capability source no longer fires for plain exec/dev-server
    // turns, so users only see a credentials clarification when there is
    // an actual provider tag in the structured deliverable.
    const capabilityMissing = collectMissingRequiredEnvForCapabilities({
      capabilityIds: input.taskRequiredCapabilities ?? [],
      capabilityCatalog: input.capabilityCatalog,
      envSnapshot: input.preflightEnvSnapshot,
    });
    const deliverableMissing = collectMissingRequiredEnvForDeliverable({
      deliverable: input.deliverable,
      envSnapshot: input.preflightEnvSnapshot,
    });
    const missingCredentials = Array.from(
      new Set([...capabilityMissing, ...deliverableMissing]),
    ).toSorted();
    if (missingCredentials.length > 0) {
      plan = rewritePlanToCredentialClarification({
        input,
        basePlan: plan,
        missingCredentials,
      });
    }
  }
  const estimatedDurationMs = estimateRecipeDurationMs({
    recipe: plan.recipe,
    requestedTools: input.requestedTools,
    outcomeContract: input.outcomeContract,
    executionContract: input.executionContract,
    deliverable: input.deliverable,
  });
  const ackThenDefer =
    plan.routingOutcome.kind === "matched"
      ? decideAckThenDefer({
          estimatedDurationMs,
          recipe: plan.recipe,
          requestedTools: input.requestedTools,
        })
      : false;
  const planWithDefer: ExecutionPlan = {
    ...plan,
    estimatedDurationMs,
    ackThenDefer,
  };
  if (emitter) {
    const needsTools =
      input.executionContract?.requiresTools === true ||
      (input.resolutionContract?.toolBundles?.length ?? 0) > 0 ||
      (input.requestedTools?.length ?? 0) > 0;
    if (needsTools) {
      const bundles = input.resolutionContract?.toolBundles ?? [];
      const detail =
        bundles.length > 0
          ? bundles.join(",")
          : (input.requestedTools?.join(",") ?? planWithDefer.recipe.id);
      emitter.emit("preflight", detail);
    }
  }
  return planWithDefer;
}

function planExecutionRecipeCore(input: RecipePlannerInput): ExecutionPlan {
  const profile = resolveProfile(input);
  const recipes = input.recipes ?? INITIAL_RECIPES;
  const candidateRecipes = recipes.filter((recipe) =>
    recipeMatchesProfile(recipe, profile.selectedProfile.id),
  );
  if (input.lowConfidenceStrategy === "clarify") {
    const selectedRecipe = getInitialRecipe("general_reasoning") ?? INITIAL_RECIPES[0];
    const selectedModelOverride = resolvePlannerModelOverride({
      recipe: selectedRecipe,
      profile,
    });
    const plannerOutput = PlannerOutputSchema.parse({
      selectedRecipeId: selectedRecipe.id,
      reasoning: [
        resolvePlannerReason({ recipe: selectedRecipe, profile }),
        input.confidence ? `Qualification confidence: ${input.confidence}.` : undefined,
        input.lowConfidenceStrategy
          ? `Low-confidence strategy: ${input.lowConfidenceStrategy}.`
          : undefined,
        input.ambiguityReasons?.length
          ? `Ambiguity: ${input.ambiguityReasons.join("; ")}.`
          : undefined,
      ]
        .filter(Boolean)
        .join(" "),
      ...(selectedModelOverride ? { overrides: { model: selectedModelOverride } } : {}),
    });
    const routingOutcome: RoutingOutcome = { kind: "low_confidence_clarify" };
    logPlannerSelection({
      recipeId: selectedRecipe.id,
      input,
      routingOutcome,
    });
    return {
      profile,
      recipe: selectedRecipe,
      plannerOutput,
      candidateRecipes,
      routingOutcome,
    };
  }
  const contractSelection = narrowRecipesByContract({ candidateRecipes, input });
  if (input.contractFirst === true && contractSelection.recipes.length === 0) {
    const fallbackRecipe =
      selectContractFallbackRecipe({ candidateRecipes, input }) ??
      (input.executionContract?.requiresTools ||
      input.executionContract?.requiresArtifactEvidence ||
      input.executionContract?.requiresWorkspaceMutation ||
      input.executionContract?.requiresLocalProcess ||
      input.executionContract?.requiresDeliveryEvidence
        ? undefined
        : (getInitialRecipe("general_reasoning") ?? INITIAL_RECIPES[0]));
    if (!fallbackRecipe) {
      const selectedRecipe = getInitialRecipe("general_reasoning") ?? INITIAL_RECIPES[0];
      const selectedModelOverride = resolvePlannerModelOverride({
        recipe: selectedRecipe,
        profile,
      });
      const plannerOutput = PlannerOutputSchema.parse({
        selectedRecipeId: selectedRecipe.id,
        reasoning: [
          "Contract-first routing found no recipe that satisfies the declared execution contract.",
          "Failing closed to clarification instead of widening into legacy general routing.",
          input.confidence ? `Qualification confidence: ${input.confidence}.` : undefined,
          input.ambiguityReasons?.length
            ? `Ambiguity: ${input.ambiguityReasons.join("; ")}.`
            : undefined,
          "Low-confidence strategy: clarify.",
        ]
          .filter(Boolean)
          .join(" "),
        ...(selectedModelOverride ? { overrides: { model: selectedModelOverride } } : {}),
      });
      const reasons = [
        ROUTING_OUTCOME_UNSATISFIABLE_REASONS.noRecipeMatchesToolBundles,
        ROUTING_OUTCOME_UNSATISFIABLE_REASONS.noRecipeSatisfiesExecutionContract,
        ...contractRequiresToolingFlags(input.executionContract),
      ];
      const routingOutcome: RoutingOutcome = {
        kind: "contract_unsatisfiable",
        reasons,
      };
      logPlannerSelection({
        recipeId: selectedRecipe.id,
        input,
        routingOutcome,
      });
      return {
        profile,
        recipe: selectedRecipe,
        plannerOutput,
        candidateRecipes,
        routingOutcome,
      };
    }
    const fallbackModelOverride = resolvePlannerModelOverride({
      recipe: fallbackRecipe,
      profile,
    });
    const plannerOutput = PlannerOutputSchema.parse({
      selectedRecipeId: fallbackRecipe.id,
      reasoning: [
        `Recipe ${fallbackRecipe.id} selected via contract fallback (toolBundles + executionContract).`,
        input.confidence ? `Qualification confidence: ${input.confidence}.` : undefined,
        input.lowConfidenceStrategy
          ? `Low-confidence strategy: ${input.lowConfidenceStrategy}.`
          : undefined,
        input.ambiguityReasons?.length
          ? `Ambiguity: ${input.ambiguityReasons.join("; ")}.`
          : undefined,
      ]
        .filter(Boolean)
        .join(" "),
      ...(fallbackModelOverride ? { overrides: { model: fallbackModelOverride } } : {}),
    });
    const routingOutcome: RoutingOutcome = {
      kind: "matched",
      source: "contract_first_fallback",
    };
    logPlannerSelection({
      recipeId: fallbackRecipe.id,
      input,
      routingOutcome,
    });
    return {
      profile,
      recipe: fallbackRecipe,
      plannerOutput,
      candidateRecipes,
      routingOutcome,
    };
  }
  const contractScopedRecipes =
    contractSelection.recipes.length > 0 ? contractSelection.recipes : candidateRecipes;

  const rankedRecipes = contractScopedRecipes
    .map((recipe) => ({
      recipe,
      score: buildRecipeScore({ recipe, profile, input }),
    }))
    .toSorted((left, right) => right.score - left.score);

  const selectedRecipe =
    rankedRecipes[0]?.recipe ?? getInitialRecipe("general_reasoning") ?? INITIAL_RECIPES[0];
  const selectedModelOverride = resolvePlannerModelOverride({
    recipe: selectedRecipe,
    profile,
  });

  const selectedOverrideEntries = {
    ...(selectedModelOverride ? { model: selectedModelOverride } : {}),
    ...(selectedRecipe.timeoutSeconds ? { timeoutSeconds: selectedRecipe.timeoutSeconds } : {}),
  };

  const plannerOutput = PlannerOutputSchema.parse({
    selectedRecipeId: selectedRecipe.id,
    reasoning: [
      resolvePlannerReason({
        recipe: selectedRecipe,
        profile,
        selectedFamily: contractSelection.selectedFamily,
      }),
      input.confidence ? `Qualification confidence: ${input.confidence}.` : undefined,
      input.lowConfidenceStrategy
        ? `Low-confidence strategy: ${input.lowConfidenceStrategy}.`
        : undefined,
      input.ambiguityReasons?.length
        ? `Ambiguity: ${input.ambiguityReasons.join("; ")}.`
        : undefined,
    ]
      .filter(Boolean)
      .join(" "),
    ...(Object.keys(selectedOverrideEntries).length > 0
      ? { overrides: selectedOverrideEntries }
      : {}),
  });

  // Post-rank invariant guard: `general_reasoning` must never win a turn whose
  // execution contract demands tools, workspace mutation, local process, or
  // evidence. Narrowing already filters this, but if a legacy non-contractFirst
  // call slips through, we convert the outcome to `contract_unsatisfiable` so
  // downstream layers don't treat this as a normal successful routing.
  if (
    selectedRecipe.id === "general_reasoning" &&
    contractDemandsTooling(input.executionContract)
  ) {
    const routingOutcome: RoutingOutcome = {
      kind: "contract_unsatisfiable",
      reasons: [
        ROUTING_OUTCOME_UNSATISFIABLE_REASONS.rankerDowngradedToGeneralReasoning,
        ...contractRequiresToolingFlags(input.executionContract),
      ],
    };
    logPlannerSelection({
      recipeId: selectedRecipe.id,
      input,
      routingOutcome,
    });
    return {
      profile,
      recipe: selectedRecipe,
      plannerOutput,
      candidateRecipes,
      routingOutcome,
    };
  }

  const routingOutcome: RoutingOutcome = { kind: "matched", source: "ranked" };
  logPlannerSelection({
    recipeId: selectedRecipe.id,
    input,
    routingOutcome,
  });
  return {
    profile,
    recipe: selectedRecipe,
    plannerOutput,
    candidateRecipes,
    routingOutcome,
  };
}
