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

  it("resolves integrator for integration-first tasks", () => {
    const resolved = resolveProfile({
      prompt: "Validate the webhook integration and sync the connector rollout",
      integrations: ["slack", "webhook"],
    });
    expect(resolved.selectedProfile.id).toBe("integrator");
    expect(resolved.activeProfile.taskOverlay).toBe("integration_first");
  });

  it("resolves operator for machine/bootstrap tasks", () => {
    const resolved = resolveProfile({
      prompt: "Check the linked machine, inspect logs, and bootstrap the missing capability",
      requestedTools: ["exec", "process"],
    });
    expect(resolved.selectedProfile.id).toBe("operator");
    expect(["machine_control", "bootstrap_capability", "ops_first"]).toContain(
      resolved.activeProfile.taskOverlay,
    );
  });

  it("resolves media_creator for media tasks", () => {
    const resolved = resolveProfile({
      prompt: "Generate a thumbnail image and caption the audio clip",
      artifactKinds: ["image", "audio"],
    });
    expect(resolved.selectedProfile.id).toBe("media_creator");
    expect(resolved.activeProfile.taskOverlay).toBe("media_first");
  });

  it("pins the selected profile when an explicit session override is present", () => {
    const resolved = resolveProfile({
      sessionProfile: "developer",
      prompt: "Tell me a joke about robots",
    });
    expect(resolved.selectedProfile.id).toBe("developer");
    expect(resolved.activeProfile.sessionProfile).toBe("developer");
  });

  it("lets explicit media turns override a pinned builder profile", () => {
    const resolved = resolveProfile({
      baseProfile: "builder",
      prompt: "Сделай инфографику с бананом и отдай PDF с картинкой",
      artifactKinds: ["document", "image"],
      requestedTools: ["image_generate", "pdf"],
    });
    expect(resolved.selectedProfile.id).toBe("media_creator");
    expect(resolved.activeProfile.taskOverlay).toBe("media_first");
  });

  it("lets explicit document turns override a pinned media profile", () => {
    const resolved = resolveProfile({
      sessionProfile: "media_creator",
      prompt:
        "Надо сделать pdf файл, с инфографикой о жизни городского котика, это просто прикол, но надо пару страниц, красивый формат, можно добавить пару картинок.",
      artifactKinds: ["document", "image"],
      requestedTools: ["pdf", "image_generate"],
    });
    expect(resolved.selectedProfile.id).toBe("builder");
    expect(resolved.activeProfile.taskOverlay).toBe("document_first");
  });

  it("keeps mixed pdf plus images document requests on builder", () => {
    const resolved = resolveProfile({
      prompt:
        "Надо сделать pdf файл, с инфографикой о жизни городского котика, это просто прикол, но надо пару страниц, красивый формат, можно добавить пару картинок.",
      artifactKinds: ["document", "image"],
      requestedTools: ["pdf", "image_generate"],
    });
    expect(resolved.selectedProfile.id).toBe("builder");
    expect(resolved.activeProfile.taskOverlay).toBe("document_first");
  });

  it("falls back to general when no strong signals are present", () => {
    const resolved = resolveProfile({ prompt: "" });
    expect(resolved.selectedProfile.id).toBe("general");
  });
});
