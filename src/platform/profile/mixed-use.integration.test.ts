import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../policy/engine.js";
import { resolveProfile } from "./resolver.js";

describe("mixed-use profile scenarios", () => {
  it("gives a single user document-first behavior for builder-like requests", () => {
    const resolved = resolveProfile({
      prompt: "Parse this PDF estimate and produce a report",
      fileNames: ["estimate.pdf"],
      artifactKinds: ["document", "report"],
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

  it("gives a single user code-first behavior for developer-like requests", () => {
    const resolved = resolveProfile({
      prompt: "Fix the failing TypeScript build and publish to GitHub",
      fileNames: ["app.ts"],
      publishTargets: ["github"],
      integrations: ["github"],
      requestedTools: ["exec"],
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
      prompt: "Tell me a joke about compilers",
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
