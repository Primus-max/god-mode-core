import { describe, expect, it } from "vitest";
import { getInitialProfile } from "./defaults.js";
import { applyTaskOverlay, type ProfileOverlayInput, resolveTaskOverlay } from "./overlay.js";

function makeOverlayInput(overrides: Partial<ProfileOverlayInput> = {}): ProfileOverlayInput {
  return {
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
    },
    ...overrides,
  };
}

describe("resolveTaskOverlay", () => {
  it("selects document_first for builder document contracts", () => {
    const profile = getInitialProfile("builder")!;
    const overlay = resolveTaskOverlay(
      profile,
      makeOverlayInput({
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
        },
      }),
    );
    expect(overlay?.id).toBe("document_first");
  });

  it("selects code_first for developer workspace-change contracts", () => {
    const profile = getInitialProfile("developer")!;
    const overlay = resolveTaskOverlay(
      profile,
      makeOverlayInput({
        outcomeContract: "workspace_change",
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
        },
      }),
    );
    expect(overlay?.id).toBe("code_first");
  });

  it("keeps code_first ahead of generic publish overlay for developer delivery contracts", () => {
    const profile = getInitialProfile("developer")!;
    const overlay = resolveTaskOverlay(
      profile,
      makeOverlayInput({
        outcomeContract: "external_operation",
        executionContract: {
          requiresTools: true,
          requiresWorkspaceMutation: true,
          requiresLocalProcess: false,
          requiresArtifactEvidence: false,
          requiresDeliveryEvidence: true,
          mayNeedBootstrap: false,
        },
        resolutionContract: {
          selectedFamily: "code_build",
          candidateFamilies: ["code_build"],
          toolBundles: ["repo_mutation", "external_delivery"],
        },
      }),
    );
    expect(overlay?.id).toBe("code_first");
  });

  it("selects general_chat for respond-only text contracts", () => {
    const profile = getInitialProfile("developer")!;
    const overlay = resolveTaskOverlay(profile, makeOverlayInput());
    expect(overlay?.id).toBe("general_chat");
  });

  it("selects integration_first for integrator delivery contracts", () => {
    const profile = getInitialProfile("integrator")!;
    const overlay = resolveTaskOverlay(
      profile,
      makeOverlayInput({
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
        },
      }),
    );
    expect(overlay?.id).toBe("integration_first");
  });

  it("selects ops overlays from local-process execution contracts", () => {
    const profile = getInitialProfile("operator")!;
    const machineOverlay = resolveTaskOverlay(
      profile,
      makeOverlayInput({
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
        },
      }),
    );
    expect(machineOverlay?.id).toBe("machine_control");

    const bootstrapOverlay = resolveTaskOverlay(
      profile,
      makeOverlayInput({
        outcomeContract: "interactive_local_result",
        executionContract: {
          requiresTools: true,
          requiresWorkspaceMutation: false,
          requiresLocalProcess: true,
          requiresArtifactEvidence: false,
          requiresDeliveryEvidence: false,
          mayNeedBootstrap: true,
        },
        resolutionContract: {
          selectedFamily: "ops_execution",
          candidateFamilies: ["ops_execution"],
          toolBundles: ["repo_run"],
        },
      }),
    );
    expect(bootstrapOverlay?.id).toBe("bootstrap_capability");
  });

  it("selects media_first for media-generation contracts", () => {
    const profile = getInitialProfile("media_creator")!;
    const overlay = resolveTaskOverlay(
      profile,
      makeOverlayInput({
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
        },
      }),
    );
    expect(overlay?.id).toBe("media_first");
  });
});

describe("applyTaskOverlay", () => {
  it("merges overlay hints with profile defaults", () => {
    const profile = getInitialProfile("developer")!;
    const overlay = profile.taskOverlays?.find((entry) => entry.id === "code_first");
    const effective = applyTaskOverlay(profile, overlay);
    expect(effective.preferredTools).toEqual(["edit", "exec", "process", "read", "write"]);
    expect(effective.modelHints).toEqual(["repo-aware", "tool-use"]);
    expect(effective.timeoutSeconds).toBe(300);
  });

  it("does not invent permissions while merging preferences", () => {
    const profile = getInitialProfile("builder")!;
    const overlay = profile.taskOverlays?.find((entry) => entry.id === "general_chat");
    const effective = applyTaskOverlay(profile, overlay);
    expect(effective.preferredTools).toContain("read");
    expect(effective.preferredTools).not.toContain("process");
  });
});
