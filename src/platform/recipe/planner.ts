import {
  countTabularFiles,
  promptSuggestsCalculationIntent,
  promptSuggestsCompareIntent,
  promptSuggestsWebsiteFrontendWork,
  TABULAR_ATTACHMENT_EXTENSION,
} from "../decision/intent-signals.js";
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

function hasOcrSignal(input: RecipePlannerInput, files: string[]): boolean {
  const prompt = (input.prompt ?? "").toLowerCase();
  return (
    /\b(ocr|scan|scanned|screenshot|photo|image[- ]based)\b/iu.test(prompt) ||
    files.some((file) => /\.(png|jpe?g|webp|tiff?)$/iu.test(file))
  );
}

function hasIntegrationSignal(input: RecipePlannerInput, files: string[]): boolean {
  const prompt = (input.prompt ?? "").toLowerCase();
  const integrations = (input.integrations ?? []).map((value) => value.toLowerCase());
  return (
    /\b(integration|integrate|webhook|connector|sync|pipeline|workflow|oauth|mcp)\b/iu.test(
      prompt,
    ) ||
    integrations.length > 0 ||
    files.some((file) => /\.(yaml|yml|toml|graphql|proto)$/iu.test(file))
  );
}

function hasOpsSignal(input: RecipePlannerInput): boolean {
  const prompt = (input.prompt ?? "").toLowerCase();
  return /\b(infra|infrastructure|ops|server|ssh|machine|node|cluster|kubernetes|bootstrap|capability|restart|logs)\b/iu.test(
    prompt,
  );
}

function hasMediaSignal(input: RecipePlannerInput, files: string[]): boolean {
  const prompt = (input.prompt ?? "").toLowerCase();
  return (
    /\b(image|video|audio|thumbnail|poster|render|caption|transcribe|voiceover|storyboard|figma|design)\b/iu.test(
      prompt,
    ) ||
    files.some((file) => /\.(png|jpe?g|webp|gif|mp4|webm|mp3|wav)$/iu.test(file)) ||
    hasMediaArtifact(input.artifactKinds ?? [])
  );
}

function hasTableSignal(input: RecipePlannerInput, files: string[]): boolean {
  const prompt = (input.prompt ?? "").toLowerCase();
  return (
    /\b(table|spreadsheet|csv|xlsx|rows|columns|line items?)\b/iu.test(prompt) ||
    files.some((file) => TABULAR_ATTACHMENT_EXTENSION.test(file))
  );
}

function tabularFileCount(files: string[]): number {
  return countTabularFiles(files);
}

function hasCompareSignal(input: RecipePlannerInput, files: string[]): boolean {
  const prompt = input.prompt ?? "";
  const lower = prompt.toLowerCase();
  const tabular = tabularFileCount(files);
  const compareWord = promptSuggestsCompareIntent(prompt);
  const multiTabularPrompt =
    /\b(two|three|both|multiple)\s+(csv|spreadsheets?|workbooks?|exports?|files?)\b/iu.test(
      lower,
    ) || /\b(два|две|три|оба|обе)\s+(csv|файл|таблиц|экспорт)/iu.test(prompt);
  return (
    compareWord ||
    (tabular >= 2 && /\b(price|sku|qty|quantity|cost|amount|total)\b/iu.test(lower)) ||
    (tabular >= 2 && /\b(цен|артикул|колич|сумм|стоимост)\w*\b/iu.test(prompt)) ||
    (multiTabularPrompt && tabular >= 1) ||
    tabular >= 2
  );
}

function hasCalculationSignal(input: RecipePlannerInput): boolean {
  return promptSuggestsCalculationIntent(input.prompt ?? "");
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
      : selectExecutionFamily(requestedFamilies, availableFamilies, input);

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
  const contractFirst = isContractFirstInput(input);
  const overlayId = profile.activeProfile.taskOverlay;
  const files = input.fileNames ?? [];
  const publishTargets = (input.publishTargets ?? []).map((value) => value.toLowerCase());
  const tools = (input.requestedTools ?? []).map((value) => value.toLowerCase());
  const artifactKinds = input.artifactKinds ?? [];

  // Contract-first: document authoring inference from capabilities, not prompt words
  const promptOnlyDocumentAuthoring = contractFirst
    ? (input.executionContract?.requiresArtifactEvidence && !files.length)
    : (input.intent === "document" &&
       (tools.includes("pdf") || publishTargets.includes("pdf")) &&
       (files.length === 0));

  // Contract-first: document signal from outcomeContract/artifactKinds, not prompt parsing
  const documentSignal = contractFirst
    ? (input.outcomeContract === "structured_artifact" && hasDocumentArtifact(artifactKinds))
    : (input.intent === "document" ||
       hasDocumentArtifact(artifactKinds) ||
       files.some((file) => /\.(pdf|doc|docx|xls|xlsx|csv)$/iu.test(file)));

  // Word-trigger signals disabled in contract-first mode (source of truth: TaskContract)
  const ocrSignal = contractFirst ? false : hasOcrSignal(input, files);
  const tableSignal = contractFirst ? false : hasTableSignal(input, files);
  const compareSignal = contractFirst ? false : hasCompareSignal(input, files);
  const calculationSignal = contractFirst ? false : hasCalculationSignal(input);
  const mediaSignal = contractFirst ? false : hasMediaSignal(input, files);
  const integrationSignal = contractFirst ? false : hasIntegrationSignal(input, files);
  const opsSignal = contractFirst ? false : hasOpsSignal(input);

  if (recipe.id === "general_reasoning") {
    let score = 0.2;
    if (profile.selectedProfile.id === "general") {
      score += 0.5;
    }
    if (overlayId === "general_chat") {
      score += 1.2;
    }
    if (input.intent === "general") {
      score += 0.8;
    }
    return score;
  }

  if (recipe.id === "doc_ingest") {
    let score = 0;
    if (profile.selectedProfile.id === "builder" && documentSignal) {
      score += 1;
    }
    if (overlayId === "document_first" && documentSignal) {
      score += 1.4;
    }
    if (input.intent === "document") {
      score += 1;
    }
    if (files.some((file) => /\.(pdf|doc|docx|xls|xlsx|csv)$/iu.test(file))) {
      score += 1;
    }
    if (hasDocumentArtifact(artifactKinds)) {
      score += 0.9;
    }
    if (promptOnlyDocumentAuthoring) {
      score -= 1.2;
    }
    if (
      publishTargets.some((target) => target === "pdf" || target === "email" || target === "docs")
    ) {
      score += 0.4;
    }
    return score;
  }

  if (recipe.id === "doc_authoring") {
    if (!promptOnlyDocumentAuthoring) {
      return -0.5;
    }
    let score = 0;
    if (profile.selectedProfile.id === "builder" && documentSignal) {
      score += 1;
    } else if (profile.selectedProfile.id === "general" && documentSignal) {
      score += 0.6;
    }
    if (overlayId === "document_first" && documentSignal) {
      score += 1.4;
    }
    if (input.intent === "document") {
      score += 1.1;
    }
    if (hasDocumentArtifact(artifactKinds)) {
      score += 1.1;
    }
    if (tools.includes("pdf")) {
      score += 2.6;
    }
    if (publishTargets.includes("pdf")) {
      score += 1.4;
    }
    if (files.length === 0) {
      score += 1.5;
    } else {
      score -= 1.8;
    }
    if (hasMediaArtifact(artifactKinds) && tools.includes("image_generate")) {
      score += 0.7;
    }
    if (ocrSignal || tableSignal || compareSignal || calculationSignal) {
      score -= 1.5;
    }
    return score;
  }

  if (recipe.id === "ocr_extract") {
    let score = 0;
    if (profile.selectedProfile.id === "builder" && (ocrSignal || documentSignal)) {
      score += 1;
    }
    if (overlayId === "document_first" && (ocrSignal || documentSignal)) {
      score += 1.2;
    }
    if (input.intent === "document") {
      score += 0.8;
    }
    if (ocrSignal) {
      score += 1.8;
    }
    if (hasDocumentArtifact(artifactKinds)) {
      score += 0.5;
    }
    return score;
  }

  if (recipe.id === "table_extract") {
    let score = 0;
    if (profile.selectedProfile.id === "builder" && (tableSignal || documentSignal)) {
      score += 1;
    }
    if (overlayId === "document_first" && (tableSignal || documentSignal)) {
      score += 1.1;
    }
    if (input.intent === "document") {
      score += 0.8;
    }
    if (tableSignal) {
      score += 2.2;
    }
    if (compareSignal) {
      score -= 2.6;
    }
    if (hasDocumentArtifact(artifactKinds)) {
      score += 0.5;
    }
    return score;
  }

  if (recipe.id === "table_compare") {
    let score = 0;
    if (profile.selectedProfile.id === "builder" && compareSignal) {
      score += 1;
    }
    if (overlayId === "document_first" && compareSignal) {
      score += 1.2;
    }
    if (input.intent === "compare") {
      score += 2.7;
    }
    if (input.intent === "document") {
      score += 0.45;
    }
    if (compareSignal) {
      score += 3.5;
    }
    if (tabularFileCount(files) >= 2) {
      score += 2.6;
    } else if (tabularFileCount(files) === 1 && compareSignal) {
      score += 1.3;
    }
    if (tableSignal) {
      score += 0.8;
    }
    if (hasDocumentArtifact(artifactKinds)) {
      score += 0.35;
    }
    return score;
  }

  if (recipe.id === "calculation_report") {
    let score = 0;
    if (
      (profile.selectedProfile.id === "builder" || profile.selectedProfile.id === "general") &&
      (calculationSignal || input.intent === "calculation")
    ) {
      score += 0.95;
    }
    if (overlayId === "document_first" && (calculationSignal || input.intent === "calculation")) {
      score += 0.65;
    }
    if (input.intent === "calculation") {
      score += 3.3;
    }
    if (input.intent === "document") {
      score += 0.35;
    }
    if (calculationSignal) {
      score += 3.6;
    }
    if (hasDocumentArtifact(artifactKinds)) {
      score += 0.3;
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
    if (input.intent === "code" || input.intent === "publish") {
      score += 1;
    }
    if (files.some((file) => /\.(ts|tsx|js|jsx|json|py|go|rs|java|kt)$/iu.test(file))) {
      score += 1;
    }
    if (hasCodeArtifact(artifactKinds)) {
      score += 0.9;
    }
    if (hasMatchingTarget(recipe, publishTargets)) {
      score += 1.1;
    }
    if (tools.some((tool) => tool === "exec" || tool === "process" || tool === "apply_patch")) {
      score += 0.6;
    }
    if (!contractFirst && promptSuggestsWebsiteFrontendWork(input.prompt ?? "")) {
      score += 3.6;
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
    if (input.intent === "code" || input.intent === "publish") {
      score += 0.6;
    }
    if (integrationSignal) {
      score += 1.8;
    }
    if (hasCodeArtifact(artifactKinds)) {
      score += 0.4;
    }
    if (hasMatchingTarget(recipe, publishTargets)) {
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
    if (opsSignal) {
      score += 1.9;
    }
    if (tools.some((tool) => tool === "exec" || tool === "process")) {
      score += 0.5;
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
    if (mediaSignal) {
      score += 2;
    }
    if (hasMediaArtifact(artifactKinds)) {
      score += 0.9;
    }
    if (hasMatchingTarget(recipe, publishTargets)) {
      score += 0.5;
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
      getInitialRecipe("general_reasoning") ??
      INITIAL_RECIPES[0];
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
