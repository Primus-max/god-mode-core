import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSessionTranscriptPathInDir } from "../config/sessions/paths.js";
import {
  appendInboundFilesContext,
  buildClassifiedPlatformPlannerInput,
  buildInlineCsvPreview,
  buildPlatformPlannerInput,
  shouldFailoverEmptySemanticRetryResult,
  shouldGrantPlatformExplicitApprovalForAgentTurn,
} from "./agent-command.js";
import type { TaskClassifierAdapter } from "../platform/decision/task-classifier.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

describe("agent-command Stage 4 planner input helpers", () => {
  it("keeps sync planner input transport-only while preserving channel integrations", () => {
    const input = buildPlatformPlannerInput({
      prompt:
        "Build the app, run tests, deploy a preview to Vercel, then publish release notes to GitHub.",
      opts: {
        messageChannel: "webchat",
        channel: undefined,
        replyChannel: undefined,
      },
    });

    expect(input.prompt).toBe(
      "Build the app, run tests, deploy a preview to Vercel, then publish release notes to GitHub.",
    );
    expect(input.integrations).toEqual(["webchat"]);
    expect(input.intent).toBeUndefined();
    expect(input.publishTargets).toBeUndefined();
    expect(input.requestedTools).toBeUndefined();
    expect(input.artifactKinds).toBeUndefined();
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

    expect(input.prompt).toBe("Tell me a joke about compilers.");
    expect(input.integrations).toEqual(["webchat"]);
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
    expect(input.integrations).toEqual(["telegram"]);
    expect(input.intent).toBeUndefined();
    expect(input.requestedTools).toBeUndefined();
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

    expect(input.fileNames).toEqual(["offer-a.csv", "offer-b.xlsx"]);
    expect(input.intent).toBeUndefined();
    expect(input.artifactKinds).toBeUndefined();
  });

  it("uses classifier-first routing for live agent turns", async () => {
    const stubAdapter: TaskClassifierAdapter = {
      async classify() {
        return {
          primaryOutcome: "document_package",
          requiredCapabilities: ["needs_visual_composition"],
          interactionMode: "artifact_iteration",
          confidence: 0.96,
          ambiguities: [],
        };
      },
    };

    const input = await buildClassifiedPlatformPlannerInput({
      prompt: "Просто сделай яркую смешную cartoon-картинку банана.",
      opts: {
        messageChannel: "webchat",
        channel: undefined,
        replyChannel: undefined,
      },
      cfg: {
        agents: {
          defaults: {
            embeddedPi: {
              taskClassifier: {
                enabled: true,
                backend: "stub",
                model: "hydra/gpt-5-mini",
              },
            },
          },
        },
      } as never,
      adapterRegistry: {
        stub: stubAdapter,
      },
    });

    expect(input.contractFirst).toBe(true);
    expect(input.requestedTools).toEqual(["image_generate"]);
    expect(input.artifactKinds).toEqual(["image"]);
    expect(input.candidateFamilies).toEqual(["document_render", "media_generation"]);
    expect(input.resolutionContract?.selectedFamily).toBe("media_generation");
  });

  it("forces semantic retry when a direct artifact turn replies with a clarifying question", () => {
    const shouldRetry = shouldFailoverEmptySemanticRetryResult({
      payloads: [
        {
          text: "Я могу сделать картинку, но у меня есть короткий уточняющий вопрос: в каком стиле вы хотите итоговое изображение?",
        },
      ],
      meta: {
        executionIntent: {
          outcomeContract: "structured_artifact",
          artifactKinds: ["image"],
          requestedToolNames: ["image_generate"],
        },
      },
    } as never);

    expect(shouldRetry).toBe(true);
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
