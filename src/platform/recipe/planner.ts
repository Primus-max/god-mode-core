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

// Narrows the candidate recipe pool to a single execution family.
//
// Priority:
//   1. Resolution-contract family choice.
//   2. Explicit candidateFamilies from the qualification contract.
//   3. Families derived from outcomeContract (contract-first routing).
//   4. Full candidate pool when neither is available (legacy scoring path).
//
// After narrowing, buildRecipeScore only compares recipes within the chosen
// family — it acts as a tie-breaker, not as a cross-family selector.
function narrowRecipesByFamily(params: {
  candidateRecipes: ExecutionRecipe[];
  input: RecipePlannerInput;
}): { selectedFamily?: CandidateExecutionFamily; recipes: ExecutionRecipe[] } {
  const { candidateRecipes, input } = params;

  // Determine requested families: explicit takes priority, then contract derivation.
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
    // Legacy fallback: no family narrowing; buildRecipeScore selects across full pool.
    return { recipes: candidateRecipes };
  }

  // Intersect with families that actually have recipes in the candidate pool.
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
  const promptOnlyDocumentAuthoring =
    input.intent === "document" &&
    (tools.includes("pdf") || publishTargets.includes("pdf")) &&
    (files.length === 0 || contractFirst);
  const documentSignal =
    input.intent === "document" ||
    hasDocumentArtifact(artifactKinds) ||
    files.some((file) => /\.(pdf|doc|docx|xls|xlsx|csv)$/iu.test(file));
  const ocrSignal = contractFirst ? false : hasOcrSignal(input, files);
  const tableSignal = contractFirst ? false : hasTableSignal(input, files);
  const compareSignal = contractFirst ? false : hasCompareSignal(input, files);
  const calculationSignal = contractFirst ? false : hasCalculationSignal(input);

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
    } else if (tabularFileCount(files) === 1 && hasCompareSignal(input, files)) {
      score += 1.3;
    }
    if (hasTableSignal(input, files)) {
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
    if (hasIntegrationSignal(input, files)) {
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
    if (hasOpsSignal(input)) {
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
    if (hasMediaSignal(input, files)) {
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

export function planExecutionRecipe(input: RecipePlannerInput): ExecutionPlan {
  const profile = resolveProfile(input);
  const recipes = input.recipes ?? INITIAL_RECIPES;
  const candidateRecipes = recipes.filter((recipe) =>
    recipeMatchesProfile(recipe, profile.selectedProfile.id),
  );
  if (input.lowConfidenceStrategy === "clarify") {
    const selectedRecipe = getInitialRecipe("general_reasoning") ?? INITIAL_RECIPES[0];
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
      ...(selectedRecipe.defaultModel ? { overrides: { model: selectedRecipe.defaultModel } } : {}),
    });
    return {
      profile,
      recipe: selectedRecipe,
      plannerOutput,
      candidateRecipes,
    };
  }
  const familySelection = narrowRecipesByFamily({ candidateRecipes, input });
  const familyScopedRecipes =
    familySelection.recipes.length > 0 ? familySelection.recipes : candidateRecipes;

  const rankedRecipes = familyScopedRecipes
    .map((recipe) => ({
      recipe,
      score: buildRecipeScore({ recipe, profile, input }),
    }))
    .toSorted((left, right) => right.score - left.score);

  const selectedRecipe =
    rankedRecipes[0]?.recipe ?? getInitialRecipe("general_reasoning") ?? INITIAL_RECIPES[0];

  const selectedOverrideEntries = {
    ...(selectedRecipe.defaultModel ? { model: selectedRecipe.defaultModel } : {}),
    ...(selectedRecipe.timeoutSeconds ? { timeoutSeconds: selectedRecipe.timeoutSeconds } : {}),
  };

  const plannerOutput = PlannerOutputSchema.parse({
    selectedRecipeId: selectedRecipe.id,
    reasoning: [
      resolvePlannerReason({
        recipe: selectedRecipe,
        profile,
        selectedFamily: familySelection.selectedFamily,
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
