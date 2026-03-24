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

  it("scores fun/general prompts toward general", () => {
    const signals = extractProfileSignals({ prompt: "Tell me a joke about robots" });
    expect(signals.some((signal) => signal.profileId === "general")).toBe(true);
  });

  it("uses file attachments as scoring signals", () => {
    const signals = extractProfileSignals({ fileNames: ["estimate.pdf", "notes.docx", "repo.ts"] });
    expect(
      signals.some((signal) => signal.profileId === "builder" && signal.source === "file"),
    ).toBe(true);
    expect(
      signals.some((signal) => signal.profileId === "developer" && signal.source === "file"),
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
