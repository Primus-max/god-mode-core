import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSessionTranscriptPathInDir } from "../../config/sessions/paths.js";
import { planExecutionRecipe } from "../recipe/planner.js";
import { adaptExecutionPlanToRuntime } from "../recipe/runtime-adapter.js";
import {
  buildExecutionDecisionInput,
  buildExecutionDecisionInputFromRuntimePlan,
  buildSessionBackedExecutionDecisionInput,
} from "./input.js";

describe("buildSessionBackedExecutionDecisionInput", () => {
  it("merges transcript-derived prompt and file names with the current draft prompt", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-decision-input-"));
    const storePath = path.join(tempDir, "sessions.json");
    const transcriptPath = resolveSessionTranscriptPathInDir("session-input", tempDir);
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        id: "msg-1",
        message: {
          role: "user",
          content: "Please inspect the CI log and fix the build failure",
          MediaPaths: ["/tmp/build.log"],
        },
      })}\n`,
      "utf8",
    );

    const decisionInput = buildSessionBackedExecutionDecisionInput({
      draftPrompt: "Then ship the patch.",
      storePath,
      sessionEntry: {
        sessionId: "session-input",
        sessionFile: "session-input.jsonl",
      },
      channelHints: {
        messageChannel: "telegram",
      },
    });

    expect(decisionInput.prompt).toContain("inspect the CI log");
    expect(decisionInput.prompt).toContain("Then ship the patch.");
    expect(decisionInput.fileNames).toEqual(["build.log"]);
    expect(decisionInput.channelHints).toEqual({ messageChannel: "telegram" });
  });
});

describe("buildExecutionDecisionInputFromRuntimePlan", () => {
  it("keeps structured signals when the live prompt no longer matches the original heuristics", () => {
    const plannerInput = {
      prompt: "Parse this PDF estimate into a report",
      fileNames: ["estimate.pdf"],
      artifactKinds: ["document", "report"] as const,
      intent: "document" as const,
    };
    const priorPlan = planExecutionRecipe(plannerInput);
    const priorRuntime = adaptExecutionPlanToRuntime(priorPlan, { input: plannerInput });
    const replayInput = buildExecutionDecisionInputFromRuntimePlan({
      runtime: priorRuntime,
      prompt: "Thanks, continue.",
    });
    const fromScratch = buildExecutionDecisionInput({ prompt: "Thanks, continue." });

    expect(replayInput.intent).toBe("document");
    expect(replayInput.artifactKinds).toEqual(["document", "report"]);
    expect(fromScratch.intent).toBeUndefined();
    expect(fromScratch.artifactKinds?.length ?? 0).toBe(0);
  });

  it("replays planner input that selects the same recipe without calling full platform resolution", () => {
    const plannerInput = {
      prompt: "Parse this PDF estimate into a report",
      fileNames: ["estimate.pdf"],
      artifactKinds: ["document", "report"] as const,
      intent: "document" as const,
    };
    const priorPlan = planExecutionRecipe(plannerInput);
    const priorRuntime = adaptExecutionPlanToRuntime(priorPlan, { input: plannerInput });
    const replayPlannerInput = buildExecutionDecisionInputFromRuntimePlan({
      runtime: priorRuntime,
      prompt: "ok",
    });
    const replayPlan = planExecutionRecipe(replayPlannerInput);
    expect(replayPlan.recipe.id).toBe(priorPlan.recipe.id);
    expect(replayPlan.profile.selectedProfile.id).toBe(priorPlan.profile.selectedProfile.id);
  });
});

describe("buildExecutionDecisionInput", () => {
  it("infers document intent and artifact kinds for pdf-style prompts", () => {
    const input = buildExecutionDecisionInput({
      prompt: "Create a PDF report with a short summary for the customer.",
    });

    expect(input.intent).toBe("document");
    expect(input.artifactKinds).toEqual(["document", "report"]);
  });

  it("infers image artifact kinds for media-generation prompts", () => {
    const input = buildExecutionDecisionInput({
      prompt: "Generate an image banner with the text Stage 86 OK.",
    });

    expect(input.intent).toBeUndefined();
    expect(input.artifactKinds).toEqual(["image"]);
  });

  it("infers artifact kinds from Russian media and document prompts", () => {
    const imageInput = buildExecutionDecisionInput({
      prompt: "Сгенерируй изображение баннера с текстом Stage 86 OK.",
    });
    const pdfInput = buildExecutionDecisionInput({
      prompt: "Создай PDF-отчёт с краткой сводкой результатов теста.",
    });

    expect(imageInput.artifactKinds).toEqual(["image"]);
    expect(pdfInput.intent).toBe("document");
    expect(pdfInput.artifactKinds).toEqual(["document"]);
  });

  it("keeps PDF generation prompts on the document path even when they mention tests", () => {
    const input = buildExecutionDecisionInput({
      prompt:
        "Создай PDF-отчёт с краткой сводкой результатов теста и заголовком Stage 86 PDF Test.",
    });

    expect(input.intent).toBe("document");
    expect(input.artifactKinds).toEqual(["document"]);
  });

  it("does not force ordinary summary requests onto the document path", () => {
    const input = buildExecutionDecisionInput({
      prompt: "Сильно сожми этот раздутый запрос и дай краткую сводку по статусу stage 86.",
    });

    expect(input.intent).toBeUndefined();
    expect(input.artifactKinds ?? []).toEqual([]);
  });
});
