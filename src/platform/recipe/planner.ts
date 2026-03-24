import {
  resolveProfile,
  type ProfileResolution,
  type ProfileResolverInput,
} from "../profile/resolver.js";
import type { ArtifactKind, ExecutionRecipe, PlannerOutput } from "../schemas/index.js";
import { PlannerOutputSchema } from "../schemas/index.js";
import type { ProfileId } from "../schemas/profile.js";
import { INITIAL_RECIPES, getInitialRecipe } from "./defaults.js";

export type RecipePlannerInput = ProfileResolverInput & {
  intent?: "general" | "document" | "code" | "publish";
  recipes?: ExecutionRecipe[];
};

export type ExecutionPlan = {
  profile: ProfileResolution;
  recipe: ExecutionRecipe;
  plannerOutput: PlannerOutput;
  candidateRecipes: ExecutionRecipe[];
};

function recipeMatchesProfile(recipe: ExecutionRecipe, profileId: ProfileId): boolean {
  return !recipe.allowedProfiles || recipe.allowedProfiles.includes(profileId);
}

function hasMatchingTarget(recipe: ExecutionRecipe, publishTargets: string[]): boolean {
  if (!recipe.publishTargets || publishTargets.length === 0) {
    return false;
  }
  const allowed = new Set(recipe.publishTargets.map((value) => value.toLowerCase()));
  return publishTargets.some((target) => allowed.has(target));
}

function hasDocumentArtifact(artifactKinds: ArtifactKind[]): boolean {
  return artifactKinds.some(
    (kind) => kind === "document" || kind === "estimate" || kind === "report" || kind === "data",
  );
}

function hasCodeArtifact(artifactKinds: ArtifactKind[]): boolean {
  return artifactKinds.some(
    (kind) => kind === "site" || kind === "release" || kind === "binary" || kind === "archive",
  );
}

function hasOcrSignal(input: RecipePlannerInput, files: string[]): boolean {
  const prompt = (input.prompt ?? "").toLowerCase();
  return (
    /\b(ocr|scan|scanned|screenshot|photo|image[- ]based)\b/iu.test(prompt) ||
    files.some((file) => /\.(png|jpe?g|webp|tiff?)$/iu.test(file))
  );
}

function hasTableSignal(input: RecipePlannerInput, files: string[]): boolean {
  const prompt = (input.prompt ?? "").toLowerCase();
  return (
    /\b(table|spreadsheet|csv|xlsx|rows|columns|line items?)\b/iu.test(prompt) ||
    files.some((file) => /\.(csv|xlsx|xls|ods)$/iu.test(file))
  );
}

function buildRecipeScore(params: {
  recipe: ExecutionRecipe;
  profile: ProfileResolution;
  input: RecipePlannerInput;
}): number {
  const { recipe, profile, input } = params;
  const overlayId = profile.activeProfile.taskOverlay;
  const files = input.fileNames ?? [];
  const publishTargets = (input.publishTargets ?? []).map((value) => value.toLowerCase());
  const tools = (input.requestedTools ?? []).map((value) => value.toLowerCase());
  const artifactKinds = input.artifactKinds ?? [];

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
    if (profile.selectedProfile.id === "builder") {
      score += 1;
    }
    if (overlayId === "document_first") {
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
    if (
      publishTargets.some((target) => target === "pdf" || target === "email" || target === "docs")
    ) {
      score += 0.4;
    }
    return score;
  }

  if (recipe.id === "ocr_extract") {
    let score = 0;
    if (profile.selectedProfile.id === "builder") {
      score += 1;
    }
    if (overlayId === "document_first") {
      score += 1.2;
    }
    if (input.intent === "document") {
      score += 0.8;
    }
    if (hasOcrSignal(input, files)) {
      score += 1.8;
    }
    if (hasDocumentArtifact(artifactKinds)) {
      score += 0.5;
    }
    return score;
  }

  if (recipe.id === "table_extract") {
    let score = 0;
    if (profile.selectedProfile.id === "builder") {
      score += 1;
    }
    if (overlayId === "document_first") {
      score += 1.1;
    }
    if (input.intent === "document") {
      score += 0.8;
    }
    if (hasTableSignal(input, files)) {
      score += 2.2;
    }
    if (hasDocumentArtifact(artifactKinds)) {
      score += 0.5;
    }
    return score;
  }

  if (recipe.id === "code_build_publish") {
    let score = 0;
    if (profile.selectedProfile.id === "developer") {
      score += 1;
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
    return score;
  }

  return 0;
}

function resolvePlannerReason(params: {
  recipe: ExecutionRecipe;
  profile: ProfileResolution;
}): string {
  const overlayId = params.profile.activeProfile.taskOverlay;
  const overlayText = overlayId ? ` Task overlay: ${overlayId}.` : "";
  return `Recipe ${params.recipe.id} selected for profile ${params.profile.selectedProfile.id}.${overlayText}`;
}

export function planExecutionRecipe(input: RecipePlannerInput): ExecutionPlan {
  const profile = resolveProfile(input);
  const recipes = input.recipes ?? INITIAL_RECIPES;
  const candidateRecipes = recipes.filter((recipe) =>
    recipeMatchesProfile(recipe, profile.selectedProfile.id),
  );

  const rankedRecipes = candidateRecipes
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
    reasoning: resolvePlannerReason({ recipe: selectedRecipe, profile }),
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
