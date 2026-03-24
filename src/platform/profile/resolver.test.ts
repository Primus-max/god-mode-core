import { describe, expect, it } from "vitest";
import { resolveProfile, scoreProfiles } from "./resolver.js";

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
  it("resolves builder for document-first tasks", () => {
    const resolved = resolveProfile({
      prompt: "Extract data from this estimate PDF",
      fileNames: ["estimate.pdf"],
    });
    expect(resolved.selectedProfile.id).toBe("builder");
    expect(resolved.activeProfile.taskOverlay).toBe("document_first");
  });

  it("resolves developer for code-first tasks", () => {
    const resolved = resolveProfile({
      prompt: "Fix the failing test in repo.ts and deploy the service",
      fileNames: ["repo.ts"],
      publishTargets: ["github"],
    });
    expect(resolved.selectedProfile.id).toBe("developer");
    expect(["code_first", "publish_release"]).toContain(resolved.activeProfile.taskOverlay);
  });

  it("lets a specialist user fall back to general for fun/general tasks", () => {
    const resolved = resolveProfile({
      baseProfile: "developer",
      sessionProfile: "developer",
      prompt: "Tell me a joke about robots",
    });
    expect(resolved.selectedProfile.id).toBe("general");
    expect(resolved.activeProfile.baseProfile).toBe("developer");
    expect(resolved.activeProfile.sessionProfile).toBe("general");
    expect(resolved.activeProfile.taskOverlay).toBe("general_chat");
  });

  it("falls back to general when no strong signals are present", () => {
    const resolved = resolveProfile({ prompt: "" });
    expect(resolved.selectedProfile.id).toBe("general");
  });
});
