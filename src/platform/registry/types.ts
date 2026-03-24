import type { Profile, ProfileId } from "../schemas/profile.js";
import type { ExecutionRecipe } from "../schemas/recipe.js";
import type { CapabilityDescriptor } from "../schemas/capability.js";
import type { ArtifactDescriptor, ArtifactOperation } from "../schemas/artifact.js";

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
  available(): CapabilityDescriptor[];
  missing(): CapabilityDescriptor[];
}

export interface ArtifactStore {
  get(id: string): ArtifactDescriptor | undefined;
  list(): ArtifactDescriptor[];
  create(descriptor: ArtifactDescriptor): void;
  update(id: string, patch: Partial<ArtifactDescriptor>): ArtifactDescriptor | undefined;
  transition(id: string, operation: ArtifactOperation): ArtifactDescriptor | undefined;
}
