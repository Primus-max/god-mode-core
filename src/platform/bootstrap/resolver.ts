import type { CapabilityRegistry } from "../registry/types.js";
import type { CapabilityCatalogEntry } from "../schemas/capability.js";
import {
  BootstrapRequestSchema,
  BootstrapResolutionSchema,
  type BootstrapReason,
  type BootstrapResolution,
  type BootstrapSourceDomain,
} from "./contracts.js";

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
  if (!catalogEntry.capability.trusted) {
    return BootstrapResolutionSchema.parse({
      status: "untrusted",
      capability: existing ?? catalogEntry.capability,
      catalogEntry,
      reasons: [`capability ${params.capabilityId} is not trusted for bootstrap`],
    });
  }

  const request = BootstrapRequestSchema.parse({
    capabilityId: catalogEntry.capability.id,
    installMethod: catalogEntry.install?.method ?? catalogEntry.capability.installMethod ?? "builtin",
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
