import { describe, expect, it } from "vitest";
import { createCapabilityRegistry } from "../registry/capability-registry.js";
import type { CapabilityRegistry } from "../registry/types.js";
import { TRUSTED_CAPABILITY_CATALOG } from "./defaults.js";
import { resolveBootstrapRequest, resolveBootstrapRequests } from "./resolver.js";

function driftedPdfRendererRegistry(): CapabilityRegistry {
  const canonical = TRUSTED_CAPABILITY_CATALOG.find((e) => e.capability.id === "pdf-renderer")!;
  return {
    get: () => undefined,
    list: () => [],
    register: () => {},
    update: () => undefined,
    available: () => [],
    missing: () => [],
    registerCatalogEntry: () => {},
    listCatalogEntries: () => [],
    resolveCatalogEntry: () => ({
      ...canonical,
      install: {
        ...canonical.install!,
        packageRef: "playwright-core@1.58.1",
      },
    }),
  };
}

describe("bootstrap resolver", () => {
  it("returns available when the capability is already installed", () => {
    const registry = createCapabilityRegistry([
      {
        id: "pdf-renderer",
        label: "PDF Renderer",
        status: "available",
        trusted: true,
      },
    ]);

    const result = resolveBootstrapRequest({
      capabilityId: "pdf-renderer",
      registry,
      catalog: TRUSTED_CAPABILITY_CATALOG,
      reason: "renderer_unavailable",
      sourceDomain: "document",
    });

    expect(result.status).toBe("available");
  });

  it("creates a structured request for trusted missing capabilities", () => {
    const registry = createCapabilityRegistry();
    const result = resolveBootstrapRequest({
      capabilityId: "pdf-renderer",
      registry,
      catalog: TRUSTED_CAPABILITY_CATALOG,
      reason: "renderer_unavailable",
      sourceRecipeId: "doc_ingest",
      sourceDomain: "document",
    });

    expect(result.status).toBe("request");
    expect(result.request).toMatchObject({
      capabilityId: "pdf-renderer",
      installMethod: "node",
      approvalMode: "explicit",
      reason: "renderer_unavailable",
      sourceRecipeId: "doc_ingest",
    });
  });

  it("returns unknown when the capability is not in the approved catalog", () => {
    const registry = createCapabilityRegistry();
    const result = resolveBootstrapRequest({
      capabilityId: "totally-unknown",
      registry,
      catalog: TRUSTED_CAPABILITY_CATALOG,
      reason: "missing_capability",
      sourceDomain: "platform",
    });

    expect(result.status).toBe("unknown");
    expect(result.reasons?.[0]).toContain("not in the approved capability catalog");
  });

  it("ignores hostile catalog overrides and pins the approved snapshot", () => {
    const registry = createCapabilityRegistry();
    const result = resolveBootstrapRequest({
      capabilityId: "pdf-renderer",
      registry,
      catalog: [
        {
          capability: {
            id: "pdf-renderer",
            label: "PDF Renderer",
            status: "missing",
            trusted: false,
          },
          source: "user",
          install: { method: "builtin" },
        },
      ],
      reason: "renderer_unavailable",
      sourceDomain: "document",
    });

    expect(result.status).toBe("request");
    expect(result.request?.catalogEntry.source).toBe("catalog");
    expect(result.request?.catalogEntry.capability.trusted).toBe(true);
  });

  it("returns untrusted when the registry catalog entry drifts from the approved snapshot", () => {
    const registry = driftedPdfRendererRegistry();
    const result = resolveBootstrapRequest({
      capabilityId: "pdf-renderer",
      registry,
      reason: "renderer_unavailable",
      sourceDomain: "document",
    });

    expect(result.status).toBe("untrusted");
    expect(result.reasons?.[0]).toContain("does not match the approved catalog snapshot");
  });

  it("resolves from the approved snapshot when the registry has no catalog overlay", () => {
    const registry = createCapabilityRegistry();
    const result = resolveBootstrapRequest({
      capabilityId: "pdf-parser",
      registry,
      reason: "missing_capability",
      sourceDomain: "platform",
    });

    expect(result.status).toBe("request");
    expect(result.request?.installMethod).toBe("node");
    expect(result.request?.catalogEntry.install?.packageRef).toBe("@openclaw/pdf-parser@1.0.0");
  });

  it("resolves bulk recipe capability requirements", () => {
    const registry = createCapabilityRegistry();
    const results = resolveBootstrapRequests({
      capabilityIds: ["pdf-parser", "table-parser"],
      registry,
      catalog: TRUSTED_CAPABILITY_CATALOG,
      reason: "recipe_requirement",
      sourceDomain: "document",
      sourceRecipeId: "table_extract",
    });

    expect(results).toHaveLength(2);
    expect(results.every((entry) => entry.status === "request")).toBe(true);
  });
});
