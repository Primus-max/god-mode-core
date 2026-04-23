import { describe, expect, it } from "vitest";
import { type ProfileResolverInput, resolveProfile, scoreProfiles } from "./resolver.js";

const DEFAULT_ROUTING = {
  localEligible: false,
  remoteProfile: "cheap" as const,
  preferRemoteFirst: true,
  needsVision: false,
};

function makeContractInput(overrides: Partial<ProfileResolverInput> = {}): ProfileResolverInput {
  return {
    contractFirst: true,
    outcomeContract: "text_response",
    executionContract: {
      requiresTools: false,
      requiresWorkspaceMutation: false,
      requiresLocalProcess: false,
      requiresArtifactEvidence: false,
      requiresDeliveryEvidence: false,
      mayNeedBootstrap: false,
    },
    resolutionContract: {
      selectedFamily: "general_assistant",
      candidateFamilies: ["general_assistant"],
      toolBundles: ["respond_only"],
      routing: DEFAULT_ROUTING,
    },
    ...overrides,
  };
}

describe("scoreProfiles", () => {
  it("adds soft bias for base and session profile without locking the result", () => {
    const scores = scoreProfiles(
      [
        { source: "dialogue", profileId: "general", weight: 0.35, reason: "fun" },
        { source: "dialogue", profileId: "developer", weight: 0.7, reason: "code" },
      ],
      "general",
      "general",
    );
    expect(scores.general).toBeCloseTo(0.65);
    expect(scores.developer).toBeCloseTo(0.7);
  });
});

describe("resolveProfile", () => {
  it("resolves builder for document-first contracts", () => {
    const resolved = resolveProfile(
      makeContractInput({
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
      }),
    );
    expect(resolved.selectedProfile.id).toBe("builder");
    expect(resolved.activeProfile.taskOverlay).toBe("document_first");
  });

  it("resolves developer for workspace-change contracts", () => {
    const resolved = resolveProfile(
      makeContractInput({
        outcomeContract: "workspace_change",
        artifactKinds: ["site", "release"],
        executionContract: {
          requiresTools: true,
          requiresWorkspaceMutation: true,
          requiresLocalProcess: true,
          requiresArtifactEvidence: false,
          requiresDeliveryEvidence: false,
          mayNeedBootstrap: false,
        },
        resolutionContract: {
          selectedFamily: "code_build",
          candidateFamilies: ["code_build"],
          toolBundles: ["repo_mutation", "repo_run"],
          routing: {
            ...DEFAULT_ROUTING,
            remoteProfile: "code",
          },
        },
      }),
    );
    expect(resolved.selectedProfile.id).toBe("developer");
    expect(resolved.activeProfile.taskOverlay).toBe("code_first");
  });

  it("resolves integrator for delivery contracts", () => {
    const resolved = resolveProfile(
      makeContractInput({
        outcomeContract: "external_operation",
        executionContract: {
          requiresTools: true,
          requiresWorkspaceMutation: false,
          requiresLocalProcess: false,
          requiresArtifactEvidence: false,
          requiresDeliveryEvidence: true,
          mayNeedBootstrap: false,
        },
        resolutionContract: {
          selectedFamily: "ops_execution",
          candidateFamilies: ["ops_execution"],
          toolBundles: ["external_delivery"],
          routing: {
            ...DEFAULT_ROUTING,
            remoteProfile: "strong",
          },
        },
      }),
    );
    expect(resolved.selectedProfile.id).toBe("integrator");
    expect(resolved.activeProfile.taskOverlay).toBe("integration_first");
  });

  it("resolves operator for local-process contracts", () => {
    const resolved = resolveProfile(
      makeContractInput({
        outcomeContract: "interactive_local_result",
        executionContract: {
          requiresTools: true,
          requiresWorkspaceMutation: false,
          requiresLocalProcess: true,
          requiresArtifactEvidence: false,
          requiresDeliveryEvidence: false,
          mayNeedBootstrap: false,
        },
        resolutionContract: {
          selectedFamily: "ops_execution",
          candidateFamilies: ["ops_execution"],
          toolBundles: ["repo_run"],
          routing: {
            ...DEFAULT_ROUTING,
            localEligible: true,
          },
        },
      }),
    );
    expect(resolved.selectedProfile.id).toBe("operator");
    expect(resolved.activeProfile.taskOverlay).toBe("machine_control");
  });

  it("resolves media_creator for media-generation contracts", () => {
    const resolved = resolveProfile(
      makeContractInput({
        outcomeContract: "structured_artifact",
        artifactKinds: ["image", "audio"],
        executionContract: {
          requiresTools: true,
          requiresWorkspaceMutation: false,
          requiresLocalProcess: false,
          requiresArtifactEvidence: true,
          requiresDeliveryEvidence: false,
          mayNeedBootstrap: false,
        },
        resolutionContract: {
          selectedFamily: "media_generation",
          candidateFamilies: ["media_generation"],
          toolBundles: ["artifact_authoring"],
          routing: DEFAULT_ROUTING,
        },
      }),
    );
    expect(resolved.selectedProfile.id).toBe("media_creator");
    expect(resolved.activeProfile.taskOverlay).toBe("media_first");
  });

  it("pins the selected profile when an explicit session override is present", () => {
    const resolved = resolveProfile({
      sessionProfile: "developer",
    });
    expect(resolved.selectedProfile.id).toBe("developer");
    expect(resolved.activeProfile.sessionProfile).toBe("developer");
  });

  it("keeps an explicit base profile pinned over automatic contract routing", () => {
    const resolved = resolveProfile({
      ...makeContractInput({
        outcomeContract: "structured_artifact",
        artifactKinds: ["image"],
        executionContract: {
          requiresTools: true,
          requiresWorkspaceMutation: false,
          requiresLocalProcess: false,
          requiresArtifactEvidence: true,
          requiresDeliveryEvidence: false,
          mayNeedBootstrap: false,
        },
        resolutionContract: {
          selectedFamily: "media_generation",
          candidateFamilies: ["media_generation"],
          toolBundles: ["artifact_authoring"],
          routing: DEFAULT_ROUTING,
        },
      }),
      baseProfile: "builder",
    });
    expect(resolved.selectedProfile.id).toBe("builder");
  });

  it("keeps an explicit session profile pinned over automatic contract routing", () => {
    const resolved = resolveProfile({
      ...makeContractInput({
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
      }),
      sessionProfile: "media_creator",
    });
    expect(resolved.selectedProfile.id).toBe("media_creator");
  });

  it("keeps mixed document-plus-media authoring contracts on builder", () => {
    const resolved = resolveProfile(
      makeContractInput({
        outcomeContract: "structured_artifact",
        artifactKinds: ["document", "image"],
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
          candidateFamilies: ["document_render", "media_generation"],
          toolBundles: ["artifact_authoring"],
          routing: DEFAULT_ROUTING,
        },
      }),
    );
    expect(resolved.selectedProfile.id).toBe("builder");
    expect(resolved.activeProfile.taskOverlay).toBe("document_first");
  });

  it("falls back to general when no strong signals are present", () => {
    const resolved = resolveProfile({});
    expect(resolved.selectedProfile.id).toBe("general");
  });
});
