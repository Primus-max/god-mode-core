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
