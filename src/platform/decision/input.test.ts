import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSessionTranscriptPathInDir } from "../../config/sessions/paths.js";
import { buildSessionBackedExecutionDecisionInput } from "./input.js";

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
