import { describe, expect, it } from "vitest";
import { createCapabilityRegistry } from "../registry/capability-registry.js";
import { TRUSTED_CAPABILITY_CATALOG } from "./defaults.js";
import { resolveBootstrapRequest, resolveBootstrapRequests } from "./resolver.js";

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
      sourceDomain: "document",
      sourceRecipeId: "doc_ingest",
    });

    expect(result.status).toBe("request");
    expect(result.request).toMatchObject({
      capabilityId: "pdf-renderer",
      installMethod: "download",
      approvalMode: "explicit",
      reason: "renderer_unavailable",
      sourceRecipeId: "doc_ingest",
    });
  });

  it("returns unknown when the capability is not in the trusted catalog", () => {
    const registry = createCapabilityRegistry();
    const result = resolveBootstrapRequest({
      capabilityId: "totally-unknown",
      registry,
      catalog: TRUSTED_CAPABILITY_CATALOG,
      reason: "missing_capability",
      sourceDomain: "platform",
    });

    expect(result.status).toBe("unknown");
    expect(result.reasons?.[0]).toContain("no trusted catalog entry");
  });

  it("returns untrusted for user-sourced catalog entries", () => {
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

    expect(result.status).toBe("untrusted");
    expect(result.reasons).toContain(
      "capability pdf-renderer comes from a user catalog source",
    );
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
