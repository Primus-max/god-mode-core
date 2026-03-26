import { describe, expect, it } from "vitest";
import { getInitialProfile } from "../profile/defaults.js";
import { applyTaskOverlay } from "../profile/overlay.js";
import { createCapabilityRegistry } from "../registry/capability-registry.js";
import { TRUSTED_CAPABILITY_CATALOG } from "./defaults.js";
import type { BootstrapInstaller } from "./installers.js";
import { resolveBootstrapRequest } from "./resolver.js";
import { runBootstrapLifecycle } from "./runtime.js";

function makePolicyContext(explicitApproval: boolean) {
  const profile = getInitialProfile("developer")!;
  return {
    activeProfileId: profile.id,
    activeProfile: profile,
    effective: applyTaskOverlay(
      profile,
      profile.taskOverlays?.find((overlay) => overlay.id === "code_first"),
    ),
    intent: "code" as const,
    explicitApproval,
  };
}

function makeSuccessfulInstaller(): BootstrapInstaller {
  return async ({ request }) => ({
    ok: true,
    capability: {
      ...request.catalogEntry.capability,
      status: "available" as const,
      trusted: true,
      installMethod: request.installMethod,
      sandboxed: true,
    },
  });
}

describe("bootstrap runtime", () => {
  it("blocks bootstrap without explicit approval", async () => {
    const registry = createCapabilityRegistry([], TRUSTED_CAPABILITY_CATALOG);
    const resolution = resolveBootstrapRequest({
      capabilityId: "pdf-renderer",
      registry,
      reason: "renderer_unavailable",
      sourceDomain: "document",
    });

    if (!resolution.request) {
      throw new Error("expected bootstrap request");
    }

    const result = await runBootstrapLifecycle({
      request: resolution.request,
      policyContext: makePolicyContext(false),
      registry,
    });

    expect(result.status).toBe("denied");
    expect(result.transitions).toEqual(["requested", "denied"]);
    expect(result.verificationStatus).toBe("not_run");
    expect(result.rollbackStatus).toBe("not_needed");
  });

  it("installs, verifies, and registers approved capabilities", async () => {
    const registry = createCapabilityRegistry([], TRUSTED_CAPABILITY_CATALOG);
    const resolution = resolveBootstrapRequest({
      capabilityId: "pdf-renderer",
      registry,
      reason: "renderer_unavailable",
      sourceDomain: "developer",
    });

    if (!resolution.request) {
      throw new Error("expected bootstrap request");
    }

    const result = await runBootstrapLifecycle({
      request: resolution.request,
      policyContext: makePolicyContext(true),
      registry,
      installers: {
        download: makeSuccessfulInstaller(),
      },
      availableBins: ["playwright"],
      runHealthCheckCommand: async () => true,
    });

    expect(result.status).toBe("available");
    expect(result.transitions).toEqual([
      "requested",
      "approved",
      "installing",
      "verifying",
      "available",
    ]);
    expect(registry.get("pdf-renderer")?.status).toBe("available");
    expect(result.verificationStatus).toBe("passed");
    expect(result.rollbackStatus).toBe("not_needed");
  });

  it("rolls back into degraded mode when verification fails", async () => {
    const previous = {
      id: "pdf-renderer",
      label: "PDF Renderer",
      status: "missing" as const,
      trusted: true,
      installMethod: "download" as const,
    };
    const registry = createCapabilityRegistry([previous], TRUSTED_CAPABILITY_CATALOG);
    const resolution = resolveBootstrapRequest({
      capabilityId: "pdf-renderer",
      registry,
      reason: "renderer_unavailable",
      sourceDomain: "document",
    });

    if (!resolution.request) {
      throw new Error("expected bootstrap request");
    }

    const result = await runBootstrapLifecycle({
      request: resolution.request,
      policyContext: makePolicyContext(true),
      registry,
      installers: {
        download: makeSuccessfulInstaller(),
      },
      availableBins: [],
      runHealthCheckCommand: async () => false,
    });

    expect(result.status).toBe("degraded");
    expect(result.transitions).toContain("rolled_back");
    expect(result.verificationStatus).toBe("failed");
    expect(result.rollbackStatus).toBe("restore_previous");
    expect(registry.get("pdf-renderer")?.status).toBe("missing");
  });

  it("keeps degraded state when the install method is unsupported", async () => {
    const registry = createCapabilityRegistry([], TRUSTED_CAPABILITY_CATALOG);
    const result = await runBootstrapLifecycle({
      request: {
        capabilityId: "brew-only-smoke",
        installMethod: "brew",
        rollbackStrategy: "keep_failed",
        reason: "missing_capability",
        sourceDomain: "developer",
        approvalMode: "explicit",
        catalogEntry: {
          capability: {
            id: "brew-only-smoke",
            label: "Brew Only Smoke",
            status: "missing",
            trusted: true,
          },
          source: "catalog",
          install: {
            method: "brew",
            packageRef: "brew-only-smoke",
            integrity:
              "sha256:2222222222222222222222222222222222222222222222222222222222222222",
            rollbackStrategy: "keep_failed",
          },
        },
      },
      policyContext: makePolicyContext(true),
      registry,
    });

    expect(result.status).toBe("degraded");
    expect(result.verificationStatus).toBe("not_run");
    expect(result.rollbackStatus).toBe("keep_failed");
    expect(result.reasons).toContain("bootstrap installer for brew is not implemented");
    expect(registry.get("brew-only-smoke")?.status).toBe("failed");
  });
});
