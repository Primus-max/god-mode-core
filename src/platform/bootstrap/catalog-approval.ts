import { isDeepStrictEqual } from "node:util";
import type { CapabilityCatalogEntry } from "../schemas/capability.js";
import { CapabilityCatalogEntrySchema } from "../schemas/capability.js";
import { TRUSTED_CAPABILITY_CATALOG } from "./defaults.js";

function normalizeCatalogEntry(entry: CapabilityCatalogEntry): CapabilityCatalogEntry {
  return CapabilityCatalogEntrySchema.parse(entry);
}

const APPROVED_ENTRIES: CapabilityCatalogEntry[] = TRUSTED_CAPABILITY_CATALOG.map((e) =>
  normalizeCatalogEntry(e),
);

const APPROVED_BY_ID = new Map(APPROVED_ENTRIES.map((e) => [e.capability.id, e]));

/**
 * Capability IDs that may participate in bootstrap via the approved in-repo catalog snapshot.
 */
export function listApprovedCapabilityCatalogIds(): string[] {
  return APPROVED_ENTRIES.map((e) => e.capability.id);
}

/**
 * Returns the canonical approved catalog entry for an id, or undefined if bootstrap is not defined for that capability.
 */
export function getApprovedCapabilityCatalogEntry(
  capabilityId: string,
): CapabilityCatalogEntry | undefined {
  return APPROVED_BY_ID.get(capabilityId);
}

export function catalogEntryMatchesApprovedSnapshot(entry: CapabilityCatalogEntry): boolean {
  const parsed = normalizeCatalogEntry(entry);
  const canonical = APPROVED_BY_ID.get(parsed.capability.id);
  if (!canonical) {
    return false;
  }
  return isDeepStrictEqual(parsed, canonical);
}

/**
 * Ensures a catalog entry is exactly the approved snapshot for its capability id (used by {@link createCapabilityRegistry}).
 */
export function assertApprovedCatalogEntryOrThrow(entry: CapabilityCatalogEntry): void {
  const parsed = normalizeCatalogEntry(entry);
  const canonical = APPROVED_BY_ID.get(parsed.capability.id);
  if (!canonical) {
    throw new Error(
      `capability catalog entry "${parsed.capability.id}" is not in the approved capability catalog`,
    );
  }
  if (!isDeepStrictEqual(parsed, canonical)) {
    throw new Error(
      `capability catalog entry "${parsed.capability.id}" does not match the approved catalog snapshot`,
    );
  }
}
