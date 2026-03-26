import { describe, expect, it } from "vitest";
import { resolveDeveloperCredentialGate } from "../developer/index.js";
import { getInitialProfile } from "../profile/defaults.js";
import { applyTaskOverlay } from "../profile/overlay.js";
import { evaluatePolicy } from "./engine.js";

describe("evaluatePolicy", () => {
  it("does not grant hidden privileged tools to developer profile", () => {
    const profile = getInitialProfile("developer")!;
    const decision = evaluatePolicy({
      activeProfileId: profile.id,
      activeProfile: profile,
      effective: applyTaskOverlay(
        profile,
        profile.taskOverlays?.find((overlay) => overlay.id === "code_first"),
      ),
      requestedToolNames: ["exec"],
      intent: "code",
      explicitApproval: false,
    });
    expect(decision.allowPrivilegedTools).toBe(false);
    expect(decision.requireExplicitApproval).toBe(true);
  });

  it("allows privileged tools only with explicit approval", () => {
    const profile = getInitialProfile("developer")!;
    const decision = evaluatePolicy({
      activeProfileId: profile.id,
      activeProfile: profile,
      effective: applyTaskOverlay(
        profile,
        profile.taskOverlays?.find((overlay) => overlay.id === "code_first"),
      ),
      requestedToolNames: ["exec", "apply_patch"],
      explicitApproval: true,
      intent: "code",
    });
    expect(decision.allowPrivilegedTools).toBe(true);
    expect(decision.autonomy).toBe("guarded");
  });

  it("blocks publishing without explicit approval even for developer profile", () => {
    const profile = getInitialProfile("developer")!;
    const decision = evaluatePolicy({
      activeProfileId: profile.id,
      activeProfile: profile,
      effective: applyTaskOverlay(
        profile,
        profile.taskOverlays?.find((overlay) => overlay.id === "publish_release"),
      ),
      publishTargets: ["github"],
      intent: "publish",
      explicitApproval: false,
    });
    expect(decision.allowPublish).toBe(false);
    expect(decision.requireExplicitApproval).toBe(true);
  });

  it("does not let credential bindings bypass publish approval", () => {
    const profile = getInitialProfile("developer")!;
    const gate = resolveDeveloperCredentialGate({
      id: "github-release",
      target: "github",
      credentialKind: "oauth",
      bindingScope: "persistent",
      source: "auth_profile",
      authProfileId: "github-release",
    });
    const decision = evaluatePolicy({
      activeProfileId: profile.id,
      activeProfile: profile,
      effective: applyTaskOverlay(
        profile,
        profile.taskOverlays?.find((overlay) => overlay.id === "publish_release"),
      ),
      intent: gate.policyIntent,
      publishTargets: gate.publishTargets,
      explicitApproval: false,
    });
    expect(decision.allowPublish).toBe(false);
    expect(decision.requireExplicitApproval).toBe(true);
  });

  it("blocks external model use for sensitive data until approval is explicit", () => {
    const profile = getInitialProfile("builder")!;
    const decision = evaluatePolicy({
      activeProfileId: profile.id,
      activeProfile: profile,
      effective: applyTaskOverlay(
        profile,
        profile.taskOverlays?.find((overlay) => overlay.id === "document_first"),
      ),
      touchesSensitiveData: true,
      intent: "document",
      artifactKinds: ["document"],
    });
    expect(decision.allowExternalModel).toBe(false);
    expect(decision.allowArtifactPersistence).toBe(true);
  });

  it("keeps general chat overlay lightweight", () => {
    const profile = getInitialProfile("developer")!;
    const decision = evaluatePolicy({
      activeProfileId: profile.id,
      activeProfile: profile,
      activeStateTaskOverlay: "general_chat",
      effective: applyTaskOverlay(
        profile,
        profile.taskOverlays?.find((overlay) => overlay.id === "general_chat"),
      ),
      intent: "general",
    });
    expect(decision.allowPublish).toBe(false);
    expect(decision.allowCapabilityBootstrap).toBe(false);
    expect(decision.autonomy).toBe("chat");
  });

  it("denies machine control by default for unlinked devices", () => {
    const profile = getInitialProfile("developer")!;
    const decision = evaluatePolicy({
      activeProfileId: profile.id,
      activeProfile: profile,
      effective: applyTaskOverlay(
        profile,
        profile.taskOverlays?.find((overlay) => overlay.id === "code_first"),
      ),
      intent: "code",
      requestedToolNames: ["exec"],
      requestedMachineControl: true,
      machineControlLinked: false,
      explicitApproval: false,
    });
    expect(decision.allowMachineControl).toBe(false);
    expect(decision.deniedReasons).toContain("machine control requires explicit device binding");
  });

  it("lets linked machine control stay guarded until approval is explicit", () => {
    const profile = getInitialProfile("developer")!;
    const decision = evaluatePolicy({
      activeProfileId: profile.id,
      activeProfile: profile,
      effective: applyTaskOverlay(
        profile,
        profile.taskOverlays?.find((overlay) => overlay.id === "code_first"),
      ),
      intent: "code",
      requestedToolNames: ["exec"],
      requestedMachineControl: true,
      machineControlLinked: true,
      explicitApproval: false,
    });
    expect(decision.allowMachineControl).toBe(false);
    expect(decision.requireExplicitApproval).toBe(true);
  });

  it("honors machine-control kill switch even when device is linked", () => {
    const profile = getInitialProfile("developer")!;
    const decision = evaluatePolicy({
      activeProfileId: profile.id,
      activeProfile: profile,
      effective: applyTaskOverlay(
        profile,
        profile.taskOverlays?.find((overlay) => overlay.id === "code_first"),
      ),
      intent: "code",
      requestedToolNames: ["exec"],
      requestedMachineControl: true,
      machineControlLinked: true,
      machineControlKillSwitchEnabled: true,
      explicitApproval: true,
    });
    expect(decision.allowMachineControl).toBe(false);
    expect(decision.deniedReasons).toContain("machine control is disabled by kill switch");
  });
});
