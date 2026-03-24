import type { ArtifactDescriptor, ArtifactLifecycle, ArtifactOperation } from "../schemas/artifact.js";
import { ArtifactDescriptorSchema } from "../schemas/artifact.js";
import type { ArtifactStore } from "./types.js";

const LIFECYCLE_TRANSITIONS: Record<ArtifactOperation, ArtifactLifecycle | null> = {
  create: "draft",
  update: null,
  version: null,
  preview: "preview",
  publish: "published",
  approve: "approved",
  retain: "archived",
  delete: "deleted",
};

export function createArtifactStore(initial: ArtifactDescriptor[] = []): ArtifactStore {
  const store = new Map<string, ArtifactDescriptor>();

  for (const descriptor of initial) {
    ArtifactDescriptorSchema.parse(descriptor);
    store.set(descriptor.id, descriptor);
  }

  return {
    get(id) {
      return store.get(id);
    },
    list() {
      return Array.from(store.values());
    },
    create(descriptor) {
      ArtifactDescriptorSchema.parse(descriptor);
      store.set(descriptor.id, descriptor);
    },
    update(id, patch) {
      const existing = store.get(id);
      if (!existing) {
        return undefined;
      }
      const updated = { ...existing, ...patch, id };
      ArtifactDescriptorSchema.parse(updated);
      store.set(id, updated);
      return updated;
    },
    transition(id, operation) {
      const existing = store.get(id);
      if (!existing) {
        return undefined;
      }
      const nextLifecycle = LIFECYCLE_TRANSITIONS[operation];
      if (!nextLifecycle) {
        return existing;
      }
      const updated: ArtifactDescriptor = {
        ...existing,
        lifecycle: nextLifecycle,
        updatedAt: new Date().toISOString(),
      };
      store.set(id, updated);
      return updated;
    },
  };
}
