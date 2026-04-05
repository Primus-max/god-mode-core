import { assertApprovedCatalogEntryOrThrow } from "../bootstrap/catalog-approval.js";
import type { CapabilityCatalogEntry, CapabilityDescriptor } from "../schemas/capability.js";
import { CapabilityCatalogEntrySchema, CapabilityDescriptorSchema } from "../schemas/capability.js";
import type { CapabilityRegistry } from "./types.js";

export function createCapabilityRegistry(
  initial: CapabilityDescriptor[] = [],
  catalogSeed: CapabilityCatalogEntry[] = [],
): CapabilityRegistry {
  const store = new Map<string, CapabilityDescriptor>();
  const catalog = new Map<string, CapabilityCatalogEntry>();

  for (const descriptor of initial) {
    CapabilityDescriptorSchema.parse(descriptor);
    store.set(descriptor.id, descriptor);
  }
  for (const entry of catalogSeed) {
    assertApprovedCatalogEntryOrThrow(entry);
    catalog.set(entry.capability.id, CapabilityCatalogEntrySchema.parse(entry));
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
    update(id, patch) {
      const existing = store.get(id);
      if (!existing) {
        return undefined;
      }
      const updated = CapabilityDescriptorSchema.parse({
        ...existing,
        ...patch,
        id,
      });
      store.set(id, updated);
      return updated;
    },
    available() {
      return Array.from(store.values()).filter((d) => d.status === "available");
    },
    missing() {
      return Array.from(store.values()).filter((d) => d.status === "missing");
    },
    registerCatalogEntry(entry) {
      assertApprovedCatalogEntryOrThrow(entry);
      const parsed = CapabilityCatalogEntrySchema.parse(entry);
      catalog.set(parsed.capability.id, parsed);
    },
    listCatalogEntries() {
      return Array.from(catalog.values());
    },
    resolveCatalogEntry(capabilityId) {
      return catalog.get(capabilityId);
    },
  };
}
