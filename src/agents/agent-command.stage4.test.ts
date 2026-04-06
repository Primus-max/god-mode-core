import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSessionTranscriptPathInDir } from "../config/sessions/paths.js";
import { buildPlatformPlannerInput } from "./agent-command.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

describe("agent-command Stage 4 planner input helpers", () => {
  it("infers publish intent, targets, integrations, and artifacts from developer prompts", () => {
    const input = buildPlatformPlannerInput({
      prompt:
        "Build the app, run tests, deploy a preview to Vercel, then publish release notes to GitHub.",
      opts: {
        messageChannel: "webchat",
        channel: undefined,
        replyChannel: undefined,
      },
    });

    expect(input).toMatchObject({
      intent: "publish",
      publishTargets: ["github", "vercel"],
      integrations: ["github", "vercel", "webchat"],
      requestedTools: ["exec", "apply_patch", "process"],
    });
    expect(input.artifactKinds).toEqual(["site", "release", "binary"]);
  });

  it("keeps general prompts lightweight when no developer signals are present", () => {
    const input = buildPlatformPlannerInput({
      prompt: "Tell me a joke about compilers.",
      opts: {
        messageChannel: "webchat",
        channel: undefined,
        replyChannel: undefined,
      },
    });

    expect(input.intent).toBeUndefined();
    expect(input.publishTargets).toBeUndefined();
    expect(input.requestedTools).toBeUndefined();
    expect(input.artifactKinds).toBeUndefined();
  });

  it("uses recent session context for short follow-up prompts when a transcript is available", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-command-"));
    tempDirs.push(tempDir);
    const storePath = path.join(tempDir, "sessions.json");
    const transcriptPath = resolveSessionTranscriptPathInDir("session-1", tempDir);
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        id: "msg-1",
        message: {
          role: "user",
          content: "Please fix the failing unit test in CI.",
        },
      })}\n`,
      "utf-8",
    );

    const input = buildPlatformPlannerInput({
      prompt: "ok, do it",
      opts: {
        messageChannel: "telegram",
        channel: undefined,
        replyChannel: undefined,
      },
      storePath,
      sessionEntry: {
        sessionId: "session-1",
        sessionFile: "session-1.jsonl",
      },
    });

    expect(input.prompt).toContain("Please fix the failing unit test in CI.");
    expect(input.prompt).toContain("ok, do it");
    expect(input.intent).toBe("code");
    expect(input.requestedTools).toEqual(["exec", "apply_patch", "process"]);
  });
});
