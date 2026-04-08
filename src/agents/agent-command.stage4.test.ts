import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSessionTranscriptPathInDir } from "../config/sessions/paths.js";
import {
  appendInboundFilesContext,
  buildInlineCsvPreview,
  buildPlatformPlannerInput,
  shouldGrantPlatformExplicitApprovalForAgentTurn,
} from "./agent-command.js";

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

    expect(input.intent).toBe("general");
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

  it("passes explicit inbound file names into planner resolution", () => {
    const input = buildPlatformPlannerInput({
      prompt: "Сравни прайс-листы и дай краткий отчёт по расхождениям.",
      fileNames: ["offer-a.csv", "offer-b.xlsx"],
      opts: {
        messageChannel: "telegram",
        channel: undefined,
        replyChannel: undefined,
      },
    });

    expect(input.intent).toBe("compare");
    expect(input.fileNames).toEqual(["offer-a.csv", "offer-b.xlsx"]);
    expect(input.artifactKinds).toEqual(["data", "report"]);
  });

  it("inlines small csv previews into the prompt context", () => {
    const preview = buildInlineCsvPreview(
      "offer-a.csv",
      "media/inbound/offer-a.csv",
      Buffer.from("sku,price\nA-100,10\nB-200,20\n", "utf8"),
    );
    const prompt = appendInboundFilesContext(
      "Сравни файлы.",
      ["media/inbound/offer-a.csv"],
      [preview!],
    );

    expect(preview).toContain("```csv");
    expect(preview).toContain("A-100,10");
    expect(prompt).toContain("Attached files available in workspace:");
    expect(prompt).toContain("do not emit raw tool-call JSON");
    expect(prompt).toContain("Inline file previews for immediate reasoning:");
  });

  it("skips inline previews for oversized csv attachments", () => {
    const largeCsv = `sku,price\n${"A-100,10\n".repeat(4000)}`;
    const preview = buildInlineCsvPreview(
      "huge.csv",
      "media/inbound/huge.csv",
      Buffer.from(largeCsv, "utf8"),
    );

    expect(preview).toBeUndefined();
  });

  it("treats owner-originated turns as explicitly approved for platform execution", () => {
    expect(shouldGrantPlatformExplicitApprovalForAgentTurn({ senderIsOwner: true })).toBe(true);
    expect(shouldGrantPlatformExplicitApprovalForAgentTurn({ senderIsOwner: false })).toBe(false);
  });
});
