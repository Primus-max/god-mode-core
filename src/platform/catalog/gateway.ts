import type { GatewayRequestHandler } from "../../gateway/server-methods/types.js";
import { TRUSTED_CAPABILITY_CATALOG } from "../bootstrap/defaults.js";
import type { CapabilityRegistry } from "../registry/types.js";
import { getInitialProfile } from "../profile/defaults.js";
import { INITIAL_RECIPES, getInitialRecipe, initialRecipeRegistry } from "../recipe/defaults.js";
import type { ExecutionRecipe } from "../schemas/recipe.js";
import {
  CapabilityCatalogDetailSchema,
  CapabilityCatalogSummarySchema,
  RecipeCatalogDetailSchema,
  RecipeCatalogSummarySchema,
} from "./contracts.js";

function buildRecipeCatalogSummary(recipe: ExecutionRecipe) {
  return RecipeCatalogSummarySchema.parse({
    id: recipe.id,
    purpose: recipe.purpose,
    ...(recipe.summary ? { summary: recipe.summary } : {}),
    riskLevel: recipe.riskLevel,
    allowedProfiles: (recipe.allowedProfiles ?? []).map((profileId) => ({
      id: profileId,
      label: getInitialProfile(profileId)?.label ?? profileId,
    })),
    requiredCapabilities: recipe.requiredCapabilities ?? [],
    publishTargets: recipe.publishTargets ?? [],
    producedArtifacts: recipe.producedArtifacts ?? [],
    ...(recipe.timeoutSeconds ? { timeoutSeconds: recipe.timeoutSeconds } : {}),
  });
}

function buildCapabilityCatalogSummary(
  capabilityId: string,
  registry?: CapabilityRegistry,
) {
  const catalogEntry =
    registry?.resolveCatalogEntry(capabilityId) ??
    TRUSTED_CAPABILITY_CATALOG.find((entry) => entry.capability.id === capabilityId);
  if (!catalogEntry) {
    return undefined;
  }
  const runtimeDescriptor = registry?.get(capabilityId);
  const effectiveCapability = runtimeDescriptor ?? catalogEntry.capability;
  const requiredByRecipes = initialRecipeRegistry
    .findByCapability(capabilityId)
    .map((recipe) => ({
      id: recipe.id,
      purpose: recipe.purpose,
      ...(recipe.summary ? { summary: recipe.summary } : {}),
    }));
  return CapabilityCatalogSummarySchema.parse({
    id: effectiveCapability.id,
    label: effectiveCapability.label,
    ...(effectiveCapability.description ? { description: effectiveCapability.description } : {}),
    status: effectiveCapability.status,
    source: catalogEntry.source,
    trusted: effectiveCapability.trusted,
    ...(effectiveCapability.installMethod ? { installMethod: effectiveCapability.installMethod } : {}),
    ...(effectiveCapability.sandboxed !== undefined
      ? { sandboxed: effectiveCapability.sandboxed }
      : {}),
    requiredBins: effectiveCapability.requiredBins ?? [],
    requiredEnv: effectiveCapability.requiredEnv ?? [],
    ...(effectiveCapability.healthCheckCommand
      ? { healthCheckCommand: effectiveCapability.healthCheckCommand }
      : {}),
    tags: effectiveCapability.tags ?? [],
    requiredByRecipes,
    requiredByRecipeCount: requiredByRecipes.length,
  });
}

export function createRecipeCatalogListGatewayMethod(): GatewayRequestHandler {
  return ({ respond }) => {
    respond(true, { recipes: INITIAL_RECIPES.map((recipe) => buildRecipeCatalogSummary(recipe)) });
  };
}

export function createRecipeCatalogGetGatewayMethod(): GatewayRequestHandler {
  return ({ params, respond }) => {
    const recipeId = typeof params.recipeId === "string" ? params.recipeId.trim() : "";
    if (!recipeId) {
      respond(false, { error: "recipeId required" });
      return;
    }
    const recipe = getInitialRecipe(recipeId);
    if (!recipe) {
      respond(false, { error: "recipe not found" });
      return;
    }
    respond(true, {
      recipe: RecipeCatalogDetailSchema.parse({
        ...buildRecipeCatalogSummary(recipe),
        acceptedInputs: recipe.acceptedInputs,
        ...(recipe.defaultModel ? { defaultModel: recipe.defaultModel } : {}),
        ...(recipe.fallbackModels?.length ? { fallbackModels: recipe.fallbackModels } : {}),
        ...(recipe.systemPrompt ? { systemPrompt: recipe.systemPrompt } : {}),
        ...(recipe.testSuite ? { testSuite: recipe.testSuite } : {}),
        ...(recipe.healthCheck ? { healthCheck: recipe.healthCheck } : {}),
      }),
    });
  };
}

export function createCapabilityCatalogListGatewayMethod(
  registry?: CapabilityRegistry,
): GatewayRequestHandler {
  return ({ respond }) => {
    respond(true, {
      capabilities: TRUSTED_CAPABILITY_CATALOG.map((entry) =>
        buildCapabilityCatalogSummary(entry.capability.id, registry),
      ).filter(Boolean),
    });
  };
}

export function createCapabilityCatalogGetGatewayMethod(
  registry?: CapabilityRegistry,
): GatewayRequestHandler {
  return ({ params, respond }) => {
    const capabilityId = typeof params.capabilityId === "string" ? params.capabilityId.trim() : "";
    if (!capabilityId) {
      respond(false, { error: "capabilityId required" });
      return;
    }
    const summary = buildCapabilityCatalogSummary(capabilityId, registry);
    const catalogEntry =
      registry?.resolveCatalogEntry(capabilityId) ??
      TRUSTED_CAPABILITY_CATALOG.find((entry) => entry.capability.id === capabilityId);
    if (!summary || !catalogEntry) {
      respond(false, { error: "capability not found" });
      return;
    }
    respond(true, {
      capability: CapabilityCatalogDetailSchema.parse({
        ...summary,
        catalogEntry,
      }),
    });
  };
}
