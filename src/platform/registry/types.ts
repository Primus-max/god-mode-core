import type { ArtifactDescriptor, ArtifactOperation } from "../schemas/artifact.js";
import type { CapabilityCatalogEntry, CapabilityDescriptor } from "../schemas/capability.js";
import type { Profile, ProfileId } from "../schemas/profile.js";
import type { ExecutionRecipe } from "../schemas/recipe.js";

export interface ProfileRegistry {
  get(id: ProfileId): Profile | undefined;
  list(): Profile[];
  register(profile: Profile): void;
}

export interface RecipeRegistry {
  get(id: string): ExecutionRecipe | undefined;
  list(): ExecutionRecipe[];
  register(recipe: ExecutionRecipe): void;
  findByCapability(capabilityId: string): ExecutionRecipe[];
  findByProfile(profileId: ProfileId): ExecutionRecipe[];
}

export interface CapabilityRegistry {
  get(id: string): CapabilityDescriptor | undefined;
  list(): CapabilityDescriptor[];
  register(descriptor: CapabilityDescriptor): void;
  update(id: string, patch: Partial<CapabilityDescriptor>): CapabilityDescriptor | undefined;
  available(): CapabilityDescriptor[];
  missing(): CapabilityDescriptor[];
  registerCatalogEntry(entry: CapabilityCatalogEntry): void;
  listCatalogEntries(): CapabilityCatalogEntry[];
  resolveCatalogEntry(capabilityId: string): CapabilityCatalogEntry | undefined;
}

export interface ArtifactStore {
  get(id: string): ArtifactDescriptor | undefined;
  list(): ArtifactDescriptor[];
  create(descriptor: ArtifactDescriptor): void;
  update(id: string, patch: Partial<ArtifactDescriptor>): ArtifactDescriptor | undefined;
  transition(id: string, operation: ArtifactOperation): ArtifactDescriptor | undefined;
}
