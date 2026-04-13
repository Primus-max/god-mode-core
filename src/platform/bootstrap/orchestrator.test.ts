import { describe, expect, it } from "vitest";
import { getInitialProfile } from "../profile/defaults.js";
import { applyTaskOverlay } from "../profile/overlay.js";
import { createCapabilityRegistry } from "../registry/capability-registry.js";
import { TRUSTED_CAPABILITY_CATALOG } from "./defaults.js";
import { orchestrateBootstrapRequest } from "./orchestrator.js";
import { resolveBootstrapRequest } from "./resolver.js";

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

describe("bootstrap orchestrator", () => {
  it("returns a policy-shaped denied result without running lifecycle", async () => {
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

    const result = await orchestrateBootstrapRequest({
      request: resolution.request,
      policyContext: makePolicyContext(false),
      registry,
    });

    expect(result.status).toBe("denied");
    expect(result.lifecycle).toBeUndefined();
    expect(result.policy.allowCapabilityBootstrap).toBe(false);
    expect(result.reasons?.[0]).toContain("explicit approval");
  });

  it("returns lifecycle and capability details when bootstrap succeeds", async () => {
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

    const result = await orchestrateBootstrapRequest({
      request: resolution.request,
      policyContext: makePolicyContext(true),
      registry,
      installers: {
        node: async ({ request }) => ({
          ok: true,
          capability: {
            ...request.catalogEntry.capability,
            status: "available",
            trusted: true,
            installMethod: "node",
            sandboxed: true,
          },
        }),
      },
      availableBins: ["node"],
      runHealthCheckCommand: async () => true,
    });

    expect(result.status).toBe("bootstrapped");
    expect(result.lifecycle?.status).toBe("available");
    expect(result.capability?.status).toBe("available");
    expect(result.policy.allowCapabilityBootstrap).toBe(true);
  });
});
