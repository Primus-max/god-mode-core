import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../policy/engine.js";
import { resolveProfile } from "./resolver.js";

const DEFAULT_ROUTING = {
  localEligible: false,
  remoteProfile: "cheap" as const,
  preferRemoteFirst: true,
  needsVision: false,
};

describe("mixed-use profile scenarios", () => {
  it("gives a single user document-first behavior for builder-like contracts", () => {
    const resolved = resolveProfile({
      contractFirst: true,
      outcomeContract: "structured_artifact",
      artifactKinds: ["document", "report"],
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: true,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: false,
      },
      resolutionContract: {
        selectedFamily: "document_render",
        candidateFamilies: ["document_render"],
        toolBundles: ["document_extraction"],
        routing: DEFAULT_ROUTING,
      },
    });

    const decision = evaluatePolicy({
      activeProfileId: resolved.selectedProfile.id,
      activeProfile: resolved.selectedProfile,
      activeStateTaskOverlay: resolved.activeProfile.taskOverlay,
      effective: resolved.effective,
      intent: "document",
      artifactKinds: ["document", "report"],
    });

    expect(resolved.selectedProfile.id).toBe("builder");
    expect(resolved.activeProfile.taskOverlay).toBe("document_first");
    expect(decision.allowArtifactPersistence).toBe(true);
    expect(decision.allowPrivilegedTools).toBe(false);
  });

  it("gives a single user code-first behavior for developer-like contracts", () => {
    const resolved = resolveProfile({
      contractFirst: true,
      outcomeContract: "workspace_change",
      artifactKinds: ["site", "release"],
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: true,
        requiresLocalProcess: true,
        requiresArtifactEvidence: false,
        requiresDeliveryEvidence: true,
        mayNeedBootstrap: false,
      },
      resolutionContract: {
        selectedFamily: "code_build",
        candidateFamilies: ["code_build"],
        toolBundles: ["repo_mutation", "repo_run", "external_delivery"],
        routing: {
          ...DEFAULT_ROUTING,
          remoteProfile: "code",
        },
      },
    });

    const decision = evaluatePolicy({
      activeProfileId: resolved.selectedProfile.id,
      activeProfile: resolved.selectedProfile,
      activeStateTaskOverlay: resolved.activeProfile.taskOverlay,
      effective: resolved.effective,
      intent: "publish",
      publishTargets: ["github"],
      requestedToolNames: ["exec"],
      explicitApproval: true,
    });

    expect(resolved.selectedProfile.id).toBe("developer");
    expect(decision.allowPublish).toBe(true);
    expect(decision.allowPrivilegedTools).toBe(true);
  });

  it("keeps an explicit specialist override active for fun/general requests", () => {
    const resolved = resolveProfile({
      sessionProfile: "developer",
    });

    const decision = evaluatePolicy({
      activeProfileId: resolved.selectedProfile.id,
      activeProfile: resolved.selectedProfile,
      activeStateTaskOverlay: resolved.activeProfile.taskOverlay,
      effective: resolved.effective,
      intent: "general",
      explicitApproval: false,
    });

    expect(resolved.selectedProfile.id).toBe("developer");
    expect(resolved.activeProfile.sessionProfile).toBe("developer");
    expect(decision.allowPrivilegedTools).toBe(false);
  });
});
