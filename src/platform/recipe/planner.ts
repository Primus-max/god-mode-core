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
import type { ExecutionRecipe, PlannerOutput } from "../schemas/index.js";
import { PlannerOutputSchema } from "../schemas/index.js";
import type { ProfileId } from "../schemas/profile.js";
import { INITIAL_RECIPES, getInitialRecipe } from "./defaults.js";
import {
  deriveFamiliesFromOutcomeContract,
  hasCodeArtifact,
  hasDocumentArtifact,
  hasMediaArtifact,
  selectExecutionFamily,
} from "./family-selector.js";
import type { ResolutionContract } from "../decision/resolution-contract.js";
import type { DeliverableSpec } from "../produce/registry.js";

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
};

export type ExecutionPlan = {
  profile: ProfileResolution;
  recipe: ExecutionRecipe;
  plannerOutput: PlannerOutput;
  candidateRecipes: ExecutionRecipe[];
};

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
  if ((bundles.has("repo_mutation") || bundles.has("repo_run")) &&
      (capabilities.has("node") || capabilities.has("git"))) {
    return true;
  }

  // interactive_browser: not specific to any current recipe, allow general or code
  if (bundles.has("interactive_browser")) {
    return recipe.id === "general_reasoning" ||
           recipe.id === "code_build_publish" ||
           recipe.id === "integration_delivery";
  }

  // public_web_lookup: general reasoning or analysis
  if (bundles.has("public_web_lookup")) {
    return recipe.id === "general_reasoning" ||
           recipe.id === "calculation_report" ||
           recipe.id === "table_compare";
  }

  // document_extraction: doc/ocr/table recipes
  if (bundles.has("document_extraction")) {
    return recipe.id.startsWith("doc_") ||
           recipe.id.startsWith("ocr_") ||
           recipe.id.startsWith("table_");
  }

  // artifact_authoring: authoring / packaging recipes only
  if (bundles.has("artifact_authoring")) {
    return recipe.id === "doc_authoring" ||
           recipe.id === "media_production";
  }

  // external_delivery: code/integration/ops recipes
  if (bundles.has("external_delivery")) {
    return recipe.id === "code_build_publish" ||
           recipe.id === "integration_delivery" ||
           recipe.id === "ops_orchestration";
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

  if (
    executionContract.requiresWorkspaceMutation ||
    executionContract.requiresLocalProcess
  ) {
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

  const preferredIds =
    executionContract?.requiresWorkspaceMutation || executionContract?.requiresLocalProcess
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
    recipes: candidateRecipes.filter((recipe) => getRecipeFamilies(recipe).includes(selectedFamily)),
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
  const bundles = new Set(input.resolutionContract?.toolBundles ?? []);
  const routing = input.routing ?? input.resolutionContract?.routing;
  const outcomeContract = input.outcomeContract;
  const executionContract = input.executionContract;
  const hasDocument = hasDocumentArtifact(artifactKinds);
  const hasCode = hasCodeArtifact(artifactKinds);
  const hasMedia = hasMediaArtifact(artifactKinds);
  const hasReportOrData = artifactKinds.some((kind) => kind === "report" || kind === "data");
  const hasRepoMutation = bundles.has("repo_mutation");
  const hasRepoRun = bundles.has("repo_run");
  const hasDocumentExtraction = bundles.has("document_extraction");
  const hasArtifactAuthoring = bundles.has("artifact_authoring");
  const hasBrowserBundle = bundles.has("interactive_browser");
  const hasWebLookup = bundles.has("public_web_lookup");
  const hasDeliveryBundle = bundles.has("external_delivery");
  const profileBias =
    routing?.remoteProfile === "presentation"
      ? "presentation"
      : routing?.remoteProfile === "code"
        ? "code"
        : undefined;

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
    return {
      profile,
      recipe: selectedRecipe,
      plannerOutput,
      candidateRecipes,
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
        : getInitialRecipe("general_reasoning") ?? INITIAL_RECIPES[0]);
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
      return {
        profile,
        recipe: selectedRecipe,
        plannerOutput,
        candidateRecipes,
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
    return {
      profile,
      recipe: fallbackRecipe,
      plannerOutput,
      candidateRecipes,
    };
  }
  const contractScopedRecipes = contractSelection.recipes.length > 0 ? contractSelection.recipes : candidateRecipes;

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

  return {
    profile,
    recipe: selectedRecipe,
    plannerOutput,
    candidateRecipes,
  };
}
