import type { CapabilityDescriptor } from "../schemas/capability.js";
import { CapabilityDescriptorSchema } from "../schemas/capability.js";
import type { CapabilityRegistry } from "./types.js";

export function createCapabilityRegistry(initial: CapabilityDescriptor[] = []): CapabilityRegistry {
  const store = new Map<string, CapabilityDescriptor>();

  for (const descriptor of initial) {
    CapabilityDescriptorSchema.parse(descriptor);
    store.set(descriptor.id, descriptor);
  }

  return {
    get(id) {
      return store.get(id);
    },
    list() {
      return Array.from(store.values());
    },
    register(descriptor) {
      CapabilityDescriptorSchema.parse(descriptor);
      store.set(descriptor.id, descriptor);
    },
    available() {
      return Array.from(store.values()).filter((d) => d.status === "available");
    },
    missing() {
      return Array.from(store.values()).filter((d) => d.status === "missing");
    },
  };
}
