import type { ProfileId } from "../schemas/profile.js";
import type { ExecutionRecipe } from "../schemas/recipe.js";
import { ExecutionRecipeSchema } from "../schemas/recipe.js";
import type { RecipeRegistry } from "./types.js";

export function createRecipeRegistry(initial: ExecutionRecipe[] = []): RecipeRegistry {
  const store = new Map<string, ExecutionRecipe>();

  for (const recipe of initial) {
    ExecutionRecipeSchema.parse(recipe);
    store.set(recipe.id, recipe);
  }

  return {
    get(id) {
      return store.get(id);
    },
    list() {
      return Array.from(store.values());
    },
    register(recipe) {
      ExecutionRecipeSchema.parse(recipe);
      store.set(recipe.id, recipe);
    },
    findByCapability(capabilityId) {
      return Array.from(store.values()).filter(
        (r) => r.requiredCapabilities?.includes(capabilityId),
      );
    },
    findByProfile(profileId: ProfileId) {
      return Array.from(store.values()).filter(
        (r) => !r.allowedProfiles || r.allowedProfiles.includes(profileId),
      );
    },
  };
}
