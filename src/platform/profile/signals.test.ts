import { describe, expect, it } from "vitest";
import { extractProfileSignals } from "./signals.js";

describe("extractProfileSignals", () => {
  it("scores document-oriented prompts toward builder", () => {
    const signals = extractProfileSignals({
      prompt: "Extract tables from this PDF estimate and summarize it",
    });
    expect(signals.some((signal) => signal.profileId === "builder")).toBe(true);
  });

  it("scores code-oriented prompts toward developer", () => {
    const signals = extractProfileSignals({
      prompt: "Fix the TypeScript build and deploy the repo",
    });
    expect(signals.some((signal) => signal.profileId === "developer")).toBe(true);
  });

  it("scores integration-oriented prompts toward integrator", () => {
    const signals = extractProfileSignals({
      prompt: "Wire the webhook integration, validate OAuth, and roll out the connector",
      integrations: ["slack", "webhook"],
    });
    expect(signals.some((signal) => signal.profileId === "integrator")).toBe(true);
  });

  it("scores ops-oriented prompts toward operator", () => {
    const signals = extractProfileSignals({
      prompt: "Check the linked machine, inspect logs, and restart the node service",
      requestedTools: ["exec", "process"],
    });
    expect(signals.some((signal) => signal.profileId === "operator")).toBe(true);
  });

  it("scores media-oriented prompts toward media_creator", () => {
    const signals = extractProfileSignals({
      prompt: "Generate a video thumbnail and caption this audio clip",
      artifactKinds: ["image", "audio"],
    });
    expect(signals.some((signal) => signal.profileId === "media_creator")).toBe(true);
  });

  it("scores fun/general prompts toward general", () => {
    const signals = extractProfileSignals({ prompt: "Tell me a joke about robots" });
    expect(signals.some((signal) => signal.profileId === "general")).toBe(true);
  });

  it("uses file attachments as scoring signals", () => {
    const signals = extractProfileSignals({
      fileNames: ["estimate.pdf", "notes.docx", "repo.ts", "integration.yaml"],
    });
    expect(
      signals.some((signal) => signal.profileId === "builder" && signal.source === "file"),
    ).toBe(true);
    expect(
      signals.some((signal) => signal.profileId === "developer" && signal.source === "file"),
    ).toBe(true);
    expect(
      signals.some((signal) => signal.profileId === "integrator" && signal.source === "file"),
    ).toBe(true);
  });

  it("uses media attachments as scoring signals when the task is not document extraction", () => {
    const signals = extractProfileSignals({
      prompt: "Generate a thumbnail for this trailer cut",
      fileNames: ["thumbnail.png"],
    });
    expect(
      signals.some((signal) => signal.profileId === "media_creator" && signal.source === "file"),
    ).toBe(true);
  });

  it("uses publish targets and integrations as scoring signals", () => {
    const signals = extractProfileSignals({
      publishTargets: ["github"],
      integrations: ["vercel"],
    });
    expect(
      signals.every((signal) => signal.profileId === "developer" || signal.profileId === "general"),
    ).toBe(true);
  });

  it("falls back to general when there are no strong signals", () => {
    const signals = extractProfileSignals({ prompt: "" });
    expect(signals).toEqual([
      {
        source: "config",
        profileId: "general",
        weight: 0.2,
        reason: "fallback general profile",
      },
    ]);
  });
});
