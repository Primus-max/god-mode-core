import fs from "node:fs";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { rewriteTranscriptEntriesInSessionFile } from "../../agents/pi-embedded-runner/transcript-rewrite.js";
import { appendInjectedAssistantMessageToTranscript } from "./chat-transcript-inject.js";
import { createTranscriptFixtureSync } from "./chat.test-helpers.js";

// Guardrail: Ensure gateway "injected" assistant transcript messages are appended via SessionManager,
// so they are attached to the current leaf with a `parentId` and do not sever compaction history.
describe("gateway chat.inject transcript writes", () => {
  it("appends a Pi session entry that includes parentId", async () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-",
      sessionId: "sess-1",
    });

    try {
      const appended = appendInjectedAssistantMessageToTranscript({
        transcriptPath,
        message: "hello",
      });
      expect(appended.ok).toBe(true);
      expect(appended.messageId).toBeTruthy();

      const lines = fs.readFileSync(transcriptPath, "utf-8").split(/\r?\n/).filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(2);

      const last = JSON.parse(lines.at(-1) as string) as Record<string, unknown>;
      expect(last.type).toBe("message");

      // The regression we saw: raw jsonl appends omitted this field entirely.
      expect(Object.prototype.hasOwnProperty.call(last, "parentId")).toBe(true);
      expect(last).toHaveProperty("id");
      expect(last).toHaveProperty("message");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves media urls in injected assistant content", async () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-media-",
      sessionId: "sess-2",
    });

    try {
      const appended = appendInjectedAssistantMessageToTranscript({
        transcriptPath,
        message: "artifact ready",
        mediaUrls: ["https://example.com/banana.png", "https://example.com/banana.pdf"],
      });
      expect(appended.ok).toBe(true);
      const content = (appended.message as { content?: Array<Record<string, unknown>> } | undefined)
        ?.content;
      expect(content).toEqual([
        { type: "text", text: "artifact ready" },
        { type: "image", url: "https://example.com/banana.png" },
        { type: "file", url: "https://example.com/banana.pdf" },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rewrites an existing assistant entry with media without appending a duplicate", async () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-chat-rewrite-media-",
      sessionId: "sess-3",
    });

    try {
      const sessionManager = SessionManager.open(transcriptPath);
      const messageId = sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Generated image: media/banana.png" }],
        timestamp: Date.now(),
        stopReason: "stop",
        usage: { input: 0, output: 0, totalTokens: 0 },
        api: "openai-responses",
        provider: "openclaw",
        model: "hydra/gpt-5.4",
      });

      await rewriteTranscriptEntriesInSessionFile({
        sessionFile: transcriptPath,
        sessionKey: "main",
        request: {
          replacements: [
            {
              entryId: messageId,
              message: {
                role: "assistant",
                content: [
                  { type: "text", text: "Generated image: media/banana.png" },
                  { type: "image", url: "https://example.com/banana.png" },
                ],
                timestamp: Date.now(),
                stopReason: "stop",
                usage: { input: 0, output: 0, totalTokens: 0 },
                api: "openai-responses",
                provider: "openclaw",
                model: "hydra/gpt-5.4",
              },
            },
          ],
        },
      });

      const lines = fs.readFileSync(transcriptPath, "utf-8").split(/\r?\n/).filter(Boolean);
      const messageLines = lines
        .map((line) => JSON.parse(line) as { type?: string; message?: Record<string, unknown> })
        .filter((entry) => entry.type === "message");
      expect(messageLines.length).toBeGreaterThanOrEqual(1);
      expect(messageLines.at(-1)?.message?.content).toEqual([
        { type: "text", text: "Generated image: media/banana.png" },
        { type: "image", url: "https://example.com/banana.png" },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
