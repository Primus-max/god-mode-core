import { describe, expect, it } from "vitest";
import { createCapabilityRegistry } from "../registry/capability-registry.js";
import {
  BootstrapResolutionStatusSchema,
  type BootstrapResolution,
  type BootstrapResolutionStatus,
} from "./contracts.js";
import { TRUSTED_CAPABILITY_CATALOG } from "./defaults.js";
import { resolveBootstrapRequest, resolveBootstrapRequests } from "./resolver.js";

/**
 * Phase 8 Bug #1: the discriminator that drives the
 * `closure-outcome-dispatcher.ts` `already_verified` early-return is
 * `BootstrapResolution.status`. These tests pin the contract for that
 * discriminator and the exhaustiveness of its variants.
 */

function assertNever(_x: never, message: string): never {
  throw new Error(`unreachable: ${message}`);
}

describe("bootstrap resolver — discriminated `BootstrapResolution.status`", () => {
  it("returns kind=`available` when the registry already lists the capability as available", () => {
    const registry = createCapabilityRegistry([
      {
        id: "pdf-renderer",
        label: "PDF Renderer",
        status: "available",
        trusted: true,
      },
    ]);

    const result: BootstrapResolution = resolveBootstrapRequest({
      capabilityId: "pdf-renderer",
      registry,
      catalog: TRUSTED_CAPABILITY_CATALOG,
      reason: "renderer_unavailable",
      sourceDomain: "document",
    });

    expect(result.status).toBe("available");
    // No `request` payload on the verified branch — this is what
    // `ensureBootstrapRequests` currently flattens into `[]`.
    expect(result.request).toBeUndefined();
    expect(result.capability?.id).toBe("pdf-renderer");
  });

  it("returns kind=`request` when capability is approved but missing from registry", () => {
    const registry = createCapabilityRegistry();
    const result = resolveBootstrapRequest({
      capabilityId: "pdf-renderer",
      registry,
      catalog: TRUSTED_CAPABILITY_CATALOG,
      reason: "renderer_unavailable",
      sourceDomain: "document",
    });

    expect(result.status).toBe("request");
    expect(result.request).toBeDefined();
    expect(result.request?.capabilityId).toBe("pdf-renderer");
  });

  it("returns kind=`unknown` when capability is not in the approved catalog", () => {
    const registry = createCapabilityRegistry();
    const result = resolveBootstrapRequest({
      capabilityId: "totally-unknown",
      registry,
      catalog: TRUSTED_CAPABILITY_CATALOG,
      reason: "missing_capability",
      sourceDomain: "platform",
    });

    expect(result.status).toBe("unknown");
    expect(result.request).toBeUndefined();
  });

  it("partitions a mixed batch by status (verified vs request)", () => {
    const registry = createCapabilityRegistry([
      {
        id: "pdf-renderer",
        label: "PDF Renderer",
        status: "available",
        trusted: true,
      },
    ]);

    const results = resolveBootstrapRequests({
      capabilityIds: ["pdf-renderer", "pdf-parser"],
      registry,
      reason: "missing_capability",
      sourceDomain: "document",
    });

    const verified = results.filter((r) => r.status === "available");
    const requests = results.filter((r) => r.status === "request");

    expect(verified).toHaveLength(1);
    expect(verified[0]?.capability?.id).toBe("pdf-renderer");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.request?.capabilityId).toBe("pdf-parser");
    // Verified branch yields `undefined` request — the trigger for the
    // dispatcher's false-positive collapse before the bug #1 fix.
    expect(verified[0]?.request).toBeUndefined();
  });

  it("exhaustiveness: BootstrapResolutionStatus enumerates all four variants and no extras (assertNever guard)", () => {
    const enumValues = BootstrapResolutionStatusSchema.options;
    expect(enumValues).toEqual(
      expect.arrayContaining(["available", "request", "unknown", "untrusted"]),
    );
    expect(enumValues).toHaveLength(4);

    // Compile-time exhaustiveness check via assertNever.
    function classify(status: BootstrapResolutionStatus): string {
      switch (status) {
        case "available":
          return "already_verified";
        case "request":
          return "requests_created";
        case "unknown":
          return "no_capabilities_advertised";
        case "untrusted":
          return "no_capabilities_advertised";
        default:
          return assertNever(status, "unhandled BootstrapResolutionStatus");
      }
    }

    expect(classify("available")).toBe("already_verified");
    expect(classify("request")).toBe("requests_created");
    expect(classify("unknown")).toBe("no_capabilities_advertised");
    expect(classify("untrusted")).toBe("no_capabilities_advertised");
  });
});
