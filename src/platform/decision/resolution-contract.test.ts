import { describe, expect, it } from "vitest";
import { resolveResolutionContract } from "./resolution-contract.js";

describe("resolveResolutionContract", () => {
  it("maps structured code execution fields to code routing", () => {
    const resolution = resolveResolutionContract({
      requestedTools: ["exec", "apply_patch", "process"],
      artifactKinds: ["binary"],
      outcomeContract: "workspace_change",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: true,
        requiresLocalProcess: true,
        requiresArtifactEvidence: false,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: true,
      },
      candidateFamilies: ["code_build"],
    });

    expect(resolution).toEqual(
      expect.objectContaining({
        selectedFamily: "code_build",
        toolBundles: expect.arrayContaining(["repo_run", "repo_mutation"]),
        routing: expect.objectContaining({
          remoteProfile: "code",
          localEligible: false,
        }),
      }),
    );
  });

  it("derives document extraction from structural attachments instead of prompt text", () => {
    const resolution = resolveResolutionContract({
      fileNames: ["vendors.pdf"],
      artifactKinds: ["document", "report"],
      outcomeContract: "structured_artifact",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: true,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: true,
      },
      candidateFamilies: ["document_render"],
    });

    expect(resolution.toolBundles).toContain("document_extraction");
    expect(resolution.toolBundles).not.toContain("artifact_authoring");
    expect(resolution.routing.needsVision).toBe(true);
    expect(resolution.routing.localEligible).toBe(false);
  });

  it("derives presentation routing from structured authoring fields", () => {
    const resolution = resolveResolutionContract({
      fileNames: ["brief.pdf"],
      artifactKinds: ["document", "image"],
      requestedTools: ["pdf", "image_generate"],
      outcomeContract: "structured_artifact",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: true,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: false,
      },
      candidateFamilies: ["document_render", "media_generation"],
    });

    expect(resolution.toolBundles).toContain("artifact_authoring");
    expect(resolution.routing.remoteProfile).toBe("presentation");
    expect(resolution.routing.preferRemoteFirst).toBe(true);
  });
});
