import { parseRegistryNpmSpec } from "../../infra/npm-registry-spec.js";
import type { CapabilityRegistry } from "../registry/types.js";
import { CapabilityCatalogEntrySchema, type CapabilityCatalogEntry } from "../schemas/capability.js";
import {
  BootstrapRequestSchema,
  BootstrapResolutionSchema,
  type BootstrapReason,
  type BootstrapResolution,
  type BootstrapSourceDomain,
} from "./contracts.js";

function assessCatalogEntryTrust(entry: CapabilityCatalogEntry): string[] {
  const reasons: string[] = [];
  const installMethod = entry.install?.method ?? entry.capability.installMethod ?? "builtin";
  if (entry.source === "user") {
    reasons.push(`capability ${entry.capability.id} comes from a user catalog source`);
  }
  if (!entry.capability.trusted) {
    reasons.push(`capability ${entry.capability.id} is not trusted for bootstrap`);
  }
  if (installMethod !== "builtin" && !entry.install) {
    reasons.push(`capability ${entry.capability.id} is missing install metadata`);
  }
  if (entry.install && installMethod !== "builtin" && !entry.install.integrity) {
    reasons.push(`capability ${entry.capability.id} is missing install integrity`);
  }
  if (entry.install && installMethod !== "builtin" && !entry.install.packageRef) {
    reasons.push(`capability ${entry.capability.id} is missing install packageRef`);
  }
  if (
    entry.install &&
    installMethod === "node" &&
    entry.install.packageRef &&
    parseRegistryNpmSpec(entry.install.packageRef)?.selectorKind !== "exact-version"
  ) {
    reasons.push(
      `capability ${entry.capability.id} must use an exact npm registry packageRef for node installs`,
    );
  }
  if (entry.install && installMethod === "download" && !entry.install.downloadUrl) {
    reasons.push(`capability ${entry.capability.id} is missing downloadUrl`);
  }
  if (entry.install && installMethod === "download" && !entry.install.archiveKind) {
    reasons.push(`capability ${entry.capability.id} is missing archiveKind`);
  }
  if (
    installMethod === "download" &&
    (!entry.capability.requiredBins || entry.capability.requiredBins.length === 0)
  ) {
    reasons.push(`capability ${entry.capability.id} is missing requiredBins for download verify`);
  }
  return reasons;
}

function resolveInstallMethod(entry: CapabilityCatalogEntry) {
  return entry.install?.method ?? entry.capability.installMethod ?? "builtin";
}

export function resolveBootstrapRequest(params: {
  capabilityId: string;
  registry: CapabilityRegistry;
  catalog?: CapabilityCatalogEntry[];
  reason: BootstrapReason;
  sourceDomain: BootstrapSourceDomain;
  sourceRecipeId?: string;
}): BootstrapResolution {
  const existing = params.registry.get(params.capabilityId);
  if (existing?.status === "available") {
    return BootstrapResolutionSchema.parse({
      status: "available",
      capability: existing,
    });
  }

  const catalogEntry =
    params.registry.resolveCatalogEntry(params.capabilityId) ??
    params.catalog?.find((entry) => entry.capability.id === params.capabilityId);
  if (!catalogEntry) {
    return BootstrapResolutionSchema.parse({
      status: "unknown",
      capability: existing,
      reasons: [`no trusted catalog entry found for capability ${params.capabilityId}`],
    });
  }
  const trustReasons = assessCatalogEntryTrust(catalogEntry);
  if (trustReasons.length > 0) {
    const catalogEntryResult = CapabilityCatalogEntrySchema.safeParse(catalogEntry);
    return BootstrapResolutionSchema.parse({
      status: "untrusted",
      capability: existing ?? catalogEntry.capability,
      ...(catalogEntryResult.success ? { catalogEntry: catalogEntryResult.data } : {}),
      reasons: trustReasons,
    });
  }

  const request = BootstrapRequestSchema.parse({
    capabilityId: catalogEntry.capability.id,
    installMethod: resolveInstallMethod(catalogEntry),
    rollbackStrategy: catalogEntry.install?.rollbackStrategy,
    reason: params.reason,
    sourceDomain: params.sourceDomain,
    ...(params.sourceRecipeId ? { sourceRecipeId: params.sourceRecipeId } : {}),
    approvalMode: "explicit",
    catalogEntry,
  });

  return BootstrapResolutionSchema.parse({
    status: "request",
    capability: existing ?? catalogEntry.capability,
    catalogEntry,
    request,
  });
}

export function resolveBootstrapRequests(params: {
  capabilityIds: string[];
  registry: CapabilityRegistry;
  catalog?: CapabilityCatalogEntry[];
  reason: BootstrapReason;
  sourceDomain: BootstrapSourceDomain;
  sourceRecipeId?: string;
}): BootstrapResolution[] {
  return params.capabilityIds.map((capabilityId) =>
    resolveBootstrapRequest({
      capabilityId,
      registry: params.registry,
      catalog: params.catalog,
      reason: params.reason,
      sourceDomain: params.sourceDomain,
      sourceRecipeId: params.sourceRecipeId,
    }),
  );
}
