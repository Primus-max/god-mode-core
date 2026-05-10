/**
 * V1-CUTOVER S9 — Telegram dispatch cutover unit tests.
 *
 * Exercises the env-gated `executeOrchestratorV1ShortCircuit` helper in
 * `bot-message-dispatch.ts`. The helper is the production replacement
 * for the old `diagnoseTurn(...)` short-circuit and must:
 *
 *   1. Skip (return false) when env flag `OPENCLAW_USE_V1_ORCHESTRATOR`
 *      is unset → legacy flow stays unchanged.
 *   2. Call `runOrchestratorTurn` with the right inputs (chatKey,
 *      userMessage, runTool, runConversationLLM) when flag is set.
 *   3. Send the orchestrator's `result.reply` to the originating chat
 *      via `bot.api.sendMessage`.
 *   4. NOT crash on orchestrator throw — log + send a generic error
 *      message instead.
 *   5. Skip when the user message is empty/whitespace.
 *
 * Stubs are passed via the helper's documented `overrides` test seam so
 * the tests never touch real gpt-5-mini. The seam exists only because
 * `bot-message-dispatch.ts`'s top-level imports are heavyweight (grammy,
 * many plugin-sdk modules) and `vi.mock("openclaw/...")` plays
 * inconsistently with that import graph; injecting overrides directly
 * matches the production wiring shape exactly (same callbacks the live
 * codepath constructs internally).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  danger: (msg: string) => msg,
  logVerbose: vi.fn(),
}));

type SendCall = { chatId: number | string; text: string; opts?: unknown };
type DocCall = { chatId: number | string; file: unknown; opts?: unknown };
type PhotoCall = { chatId: number | string; file: unknown; opts?: unknown };

function makeBotStub(): {
  bot: {
    api: {
      sendMessage: ReturnType<typeof vi.fn>;
      sendDocument: ReturnType<typeof vi.fn>;
      sendPhoto: ReturnType<typeof vi.fn>;
    };
  };
  sends: SendCall[];
  documents: DocCall[];
  photos: PhotoCall[];
} {
  const sends: SendCall[] = [];
  const documents: DocCall[] = [];
  const photos: PhotoCall[] = [];
  const sendMessage = vi.fn(async (chatId: number | string, text: string, opts?: unknown) => {
    sends.push({ chatId, text, opts });
    return { message_id: 1 };
  });
  const sendDocument = vi.fn(async (chatId: number | string, file: unknown, opts?: unknown) => {
    documents.push({ chatId, file, opts });
    return { message_id: 2 };
  });
  const sendPhoto = vi.fn(async (chatId: number | string, file: unknown, opts?: unknown) => {
    photos.push({ chatId, file, opts });
    return { message_id: 3 };
  });
  return {
    bot: { api: { sendMessage, sendDocument, sendPhoto } },
    sends,
    documents,
    photos,
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe("S9 — executeOrchestratorV1ShortCircuit", () => {
  it("returns false (does not handle) when OPENCLAW_USE_V1_ORCHESTRATOR is unset", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "");
    const { executeOrchestratorV1ShortCircuit } = await import("./bot-message-dispatch.js");
    const { bot } = makeBotStub();
    const runOrchestratorTurn = vi.fn();
    const handled = await executeOrchestratorV1ShortCircuit(
      {
        userText: "пиши /tmp/foo.txt текст",
        chatId: 6533456892,
        threadSpec: { id: undefined } as never,
        bot: bot as never,
        cfg: {} as never,
        runtime: {} as never,
        agentDir: undefined,
      },
      { runOrchestratorTurn: runOrchestratorTurn as never },
    );
    expect(handled).toBe(false);
    expect(runOrchestratorTurn).not.toHaveBeenCalled();
  });

  it("returns false (no work) when env flag is set but userText is empty", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const { executeOrchestratorV1ShortCircuit } = await import("./bot-message-dispatch.js");
    const { bot } = makeBotStub();
    const runOrchestratorTurn = vi.fn();
    const handled = await executeOrchestratorV1ShortCircuit(
      {
        userText: "   \n\t   ",
        chatId: 1,
        threadSpec: { id: undefined } as never,
        bot: bot as never,
        cfg: {} as never,
        runtime: {} as never,
        agentDir: undefined,
      },
      { runOrchestratorTurn: runOrchestratorTurn as never },
    );
    expect(handled).toBe(false);
    expect(runOrchestratorTurn).not.toHaveBeenCalled();
  });

  it("flag set + valid userText → calls runOrchestratorTurn with chatKey, userMessage, runTool, runConversationLLM", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const { executeOrchestratorV1ShortCircuit } = await import("./bot-message-dispatch.js");
    const { bot, sends } = makeBotStub();
    const runOrchestratorTurn = vi.fn(async () => ({
      reply: "Записал в /tmp/foo.txt.",
      contract: { intent: "tool_calls", tool_calls: [], sequencing: "sequential" },
      stageA: { routing: { intent: "tool_calls" }, fallbackReason: null, latencyMs: 12 },
      dispatch: { reply: "Записал в /tmp/foo.txt.", allOk: true, actions: [] },
    }));
    const buildRunToolFromRegistry = vi.fn(() => vi.fn());
    const callConversationLLM = vi.fn(async () => "stub");
    const handled = await executeOrchestratorV1ShortCircuit(
      {
        userText: "запиши /tmp/foo.txt 'hi'",
        chatId: 6533456892,
        threadSpec: { id: undefined } as never,
        bot: bot as never,
        cfg: {} as never,
        runtime: {} as never,
        agentDir: undefined,
      },
      {
        runOrchestratorTurn: runOrchestratorTurn as never,
        buildRunToolFromRegistry: buildRunToolFromRegistry as never,
        callConversationLLM: callConversationLLM as never,
      },
    );
    expect(handled).toBe(true);
    expect(runOrchestratorTurn).toHaveBeenCalledTimes(1);
    const turnCalls = runOrchestratorTurn.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const call = turnCalls[0]![0];
    expect(call.chatKey).toBe("telegram:6533456892");
    expect(call.userMessage).toBe("запиши /tmp/foo.txt 'hi'");
    expect(typeof call.runTool).toBe("function");
    expect(typeof call.runConversationLLM).toBe("function");
    // Reply text was sent to the originating chat via bot.api.sendMessage.
    expect(sends).toHaveLength(1);
    expect(sends[0]!.chatId).toBe(6533456892);
    expect(sends[0]!.text).toBe("Записал в /tmp/foo.txt.");
    // Registry was constructed with deps containing send + scheduling.
    expect(buildRunToolFromRegistry).toHaveBeenCalledTimes(1);
    const regCalls = buildRunToolFromRegistry.mock.calls as unknown as Array<
      [{ send: unknown; scheduling: { scheduleCron: unknown; createPersistentWorker: unknown } }]
    >;
    const regDeps = regCalls[0]![0];
    expect(typeof regDeps.send).toBe("function");
    expect(typeof regDeps.scheduling.scheduleCron).toBe("function");
    expect(typeof regDeps.scheduling.createPersistentWorker).toBe("function");
  });

  it("registry deps: send → forwards to bot.api.sendMessage with channel + text", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const { executeOrchestratorV1ShortCircuit } = await import("./bot-message-dispatch.js");
    const { bot, sends } = makeBotStub();
    let capturedSend: ((c: string, t: string) => Promise<void>) | undefined;
    const buildRunToolFromRegistry = vi.fn((deps: { send: typeof capturedSend }) => {
      capturedSend = deps.send;
      return vi.fn();
    });
    const runOrchestratorTurn = vi.fn(async () => ({
      reply: "ok",
      contract: { intent: "conversation" },
      stageA: { routing: { intent: "conversation" } },
      dispatch: { reply: "ok", allOk: true },
    }));
    await executeOrchestratorV1ShortCircuit(
      {
        userText: "hi",
        chatId: 1,
        threadSpec: { id: undefined } as never,
        bot: bot as never,
        cfg: {} as never,
        runtime: {} as never,
        agentDir: undefined,
      },
      {
        runOrchestratorTurn: runOrchestratorTurn as never,
        buildRunToolFromRegistry: buildRunToolFromRegistry as never,
      },
    );
    expect(typeof capturedSend).toBe("function");
    // Now exercise the captured `send` to confirm it routes to bot.api.sendMessage.
    await capturedSend!("987654321", "echo");
    const sendsToOtherChat = sends.filter((s) => s.chatId === "987654321");
    expect(sendsToOtherChat).toHaveLength(1);
    expect(sendsToOtherChat[0]!.text).toBe("echo");
  });

  it("registry deps: cron + persistent_worker_push placeholders fail-closed with explicit S9 message", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const { executeOrchestratorV1ShortCircuit } = await import("./bot-message-dispatch.js");
    const { bot } = makeBotStub();
    let capturedScheduling:
      | { scheduleCron: () => Promise<unknown>; createPersistentWorker: () => Promise<unknown> }
      | undefined;
    const buildRunToolFromRegistry = vi.fn((deps: { scheduling: typeof capturedScheduling }) => {
      capturedScheduling = deps.scheduling;
      return vi.fn();
    });
    const runOrchestratorTurn = vi.fn(async () => ({
      reply: "ok",
      contract: { intent: "conversation" },
      stageA: { routing: { intent: "conversation" } },
      dispatch: { reply: "ok", allOk: true },
    }));
    await executeOrchestratorV1ShortCircuit(
      {
        userText: "hi",
        chatId: 1,
        threadSpec: { id: undefined } as never,
        bot: bot as never,
        cfg: {} as never,
        runtime: {} as never,
        agentDir: undefined,
      },
      {
        runOrchestratorTurn: runOrchestratorTurn as never,
        buildRunToolFromRegistry: buildRunToolFromRegistry as never,
      },
    );
    await expect(capturedScheduling!.scheduleCron()).rejects.toThrow(/cron not yet wired in S9/);
    await expect(capturedScheduling!.createPersistentWorker()).rejects.toThrow(
      /persistent_worker_push not yet wired in S9/,
    );
  });

  it("forwards thread id when threadSpec.id is set (forum topics / DM threads)", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const { executeOrchestratorV1ShortCircuit } = await import("./bot-message-dispatch.js");
    const { bot, sends } = makeBotStub();
    const runOrchestratorTurn = vi.fn(async () => ({
      reply: "Готово.",
      contract: { intent: "tool_calls" },
      stageA: { routing: { intent: "tool_calls" } },
      dispatch: { reply: "Готово.", allOk: true },
    }));
    await executeOrchestratorV1ShortCircuit(
      {
        userText: "hi",
        chatId: 42,
        threadSpec: { id: 99 } as never,
        bot: bot as never,
        cfg: {} as never,
        runtime: {} as never,
        agentDir: undefined,
      },
      { runOrchestratorTurn: runOrchestratorTurn as never },
    );
    expect(sends).toHaveLength(1);
    expect(sends[0]!.opts).toEqual({ message_thread_id: 99 });
  });

  it("orchestrator throws → does NOT crash, logs + sends generic error reply", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const { executeOrchestratorV1ShortCircuit } = await import("./bot-message-dispatch.js");
    const { bot, sends } = makeBotStub();
    const errorRuntime = { error: vi.fn() };
    const runOrchestratorTurn = vi.fn(async () => {
      throw new Error("kaboom");
    });
    const handled = await executeOrchestratorV1ShortCircuit(
      {
        userText: "do something",
        chatId: 7,
        threadSpec: { id: undefined } as never,
        bot: bot as never,
        cfg: {} as never,
        runtime: errorRuntime as never,
        agentDir: undefined,
      },
      { runOrchestratorTurn: runOrchestratorTurn as never },
    );
    expect(handled).toBe(true);
    expect(errorRuntime.error).toHaveBeenCalled();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.chatId).toBe(7);
    expect(sends[0]!.text).toContain("kaboom");
  });

  it("S9.2 chunking: a 6000-char reply is split into multiple sendMessage calls each <= TELEGRAM_TEXT_LIMIT (real symptom: GrammyError 400 'message too long' from web_search)", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const { executeOrchestratorV1ShortCircuit, TELEGRAM_TEXT_LIMIT } =
      await import("./bot-message-dispatch.js");
    const { bot, sends } = makeBotStub();
    // Simulate web_search-style reply: header + N numbered hits with snippet
    // text. Total length ~6000 — the live-verify failure was 6098.
    const header = "Найдено по запросу «gpt-5»:\n\n";
    const hits = Array.from(
      { length: 30 },
      (_, i) =>
        `${i + 1}. Title #${i + 1} — https://example.com/${i + 1}\n` +
        `Snippet for result number ${i + 1}: ` +
        "lorem ipsum dolor sit amet ".repeat(8),
    ).join("\n\n");
    const longReply = header + hits;
    expect(longReply.length).toBeGreaterThan(TELEGRAM_TEXT_LIMIT);
    const runOrchestratorTurn = vi.fn(async () => ({
      reply: longReply,
      contract: { intent: "tool_calls" },
      stageA: { routing: { intent: "tool_calls" } },
      dispatch: { reply: longReply, allOk: true },
    }));
    const handled = await executeOrchestratorV1ShortCircuit(
      {
        userText: "Найди в интернете последние новости про gpt-5",
        chatId: 6533456892,
        threadSpec: { id: undefined } as never,
        bot: bot as never,
        cfg: {} as never,
        runtime: {} as never,
        agentDir: undefined,
      },
      { runOrchestratorTurn: runOrchestratorTurn as never },
    );
    expect(handled).toBe(true);
    // The live-verify symptom was: 1 sendMessage call, GrammyError 400.
    // The fix MUST produce >= 2 sendMessage calls when reply > limit.
    expect(sends.length).toBeGreaterThanOrEqual(2);
    for (const s of sends) {
      expect(s.text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
      expect(s.chatId).toBe(6533456892);
    }
    // No content loss: every chunk's text must appear once in the original
    // reply (loose anti-data-loss check — accounts for trim at boundaries).
    for (const s of sends) {
      expect(longReply).toContain(s.text);
    }
  });

  it("S9.2 chunking: short reply (well under limit) still produces exactly 1 sendMessage", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const { executeOrchestratorV1ShortCircuit } = await import("./bot-message-dispatch.js");
    const { bot, sends } = makeBotStub();
    const runOrchestratorTurn = vi.fn(async () => ({
      reply: "Записал в /tmp/foo.txt.",
      contract: { intent: "tool_calls" },
      stageA: { routing: { intent: "tool_calls" } },
      dispatch: { reply: "Записал в /tmp/foo.txt.", allOk: true },
    }));
    await executeOrchestratorV1ShortCircuit(
      {
        userText: "запиши /tmp/foo.txt 'hi'",
        chatId: 42,
        threadSpec: { id: undefined } as never,
        bot: bot as never,
        cfg: {} as never,
        runtime: {} as never,
        agentDir: undefined,
      },
      { runOrchestratorTurn: runOrchestratorTurn as never },
    );
    expect(sends).toHaveLength(1);
    expect(sends[0]!.text).toBe("Записал в /tmp/foo.txt.");
  });

  it("PR #350 wiring: passes the process-scoped TurnStateStore singleton to runOrchestratorTurn (multi-turn activation)", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const { executeOrchestratorV1ShortCircuit } = await import("./bot-message-dispatch.js");
    const { bot } = makeBotStub();
    const runOrchestratorTurn = vi.fn(async () => ({
      reply: "ok",
      contract: { intent: "conversation" },
      stageA: { routing: { intent: "conversation" } },
      dispatch: { reply: "ok", allOk: true },
    }));
    // Sentinel store so we can prove the EXACT object the singleton
    // accessor returns is forwarded verbatim into runOrchestratorTurn.
    // The TurnStateStore contract is `get/put/clear`; production passes
    // the in-memory impl, but the wiring helper does not care about the
    // shape beyond forwarding it.
    const sentinelStore = {
      get: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    };
    const getProcessTurnStateStoreStub = vi.fn(() => sentinelStore);
    await executeOrchestratorV1ShortCircuit(
      {
        userText: "hi",
        chatId: 6533456892,
        threadSpec: { id: undefined } as never,
        bot: bot as never,
        cfg: {} as never,
        runtime: {} as never,
        agentDir: undefined,
      },
      {
        runOrchestratorTurn: runOrchestratorTurn as never,
        getProcessTurnStateStore: getProcessTurnStateStoreStub as never,
      },
    );
    expect(getProcessTurnStateStoreStub).toHaveBeenCalledTimes(1);
    expect(runOrchestratorTurn).toHaveBeenCalledTimes(1);
    const turnCalls = runOrchestratorTurn.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const call = turnCalls[0]![0];
    // Identity check: must be the same object the accessor returned, not
    // a freshly-allocated store. This is what makes multi-turn state
    // share across consecutive turns.
    expect(call.turnState).toBe(sentinelStore);
    // Shape check: methods are present so the orchestrator can use it
    // without a type cast.
    expect(typeof (call.turnState as { get: unknown }).get).toBe("function");
    expect(typeof (call.turnState as { put: unknown }).put).toBe("function");
    expect(typeof (call.turnState as { clear: unknown }).clear).toBe("function");
  });

  it("emits [orch-v1] start + completion telemetry to stderr", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const { executeOrchestratorV1ShortCircuit } = await import("./bot-message-dispatch.js");
    const { bot } = makeBotStub();
    const runOrchestratorTurn = vi.fn(async () => ({
      reply: "Готово.",
      contract: { intent: "conversation" },
      stageA: { routing: { intent: "conversation" } },
      dispatch: { reply: "Готово.", allOk: true },
    }));
    const writeSpy = vi.spyOn(process.stderr, "write");
    await executeOrchestratorV1ShortCircuit(
      {
        userText: "привет",
        chatId: 1,
        threadSpec: { id: undefined } as never,
        bot: bot as never,
        cfg: {} as never,
        runtime: {} as never,
        agentDir: undefined,
      },
      { runOrchestratorTurn: runOrchestratorTurn as never },
    );
    const lines = writeSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.startsWith("[orch-v1] turn started"))).toBe(true);
    expect(lines.some((l) => l.startsWith("[orch-v1] turn completed"))).toBe(true);
    writeSpy.mockRestore();
  });
});

/**
 * Followup #19 — Telegram artifact upload for pdf + image_generate.
 *
 * Canonical symptom (live-verified 2026-05-09): user asks for a PDF, the
 * orchestrator-v1 reply contains a server-side absolute path
 * (`C:\Users\Tanya\AppData\Local\Temp\orchestrator-v1-pdf\<uuid>.pdf`)
 * which the user CANNOT open from Telegram — the file lives on the
 * gateway machine, not in the chat. Same for `image_generate` (path to
 * the saved PNG).
 *
 * Fix: after `executeOrchestratorV1ShortCircuit` sends the rendered text
 * reply, inspect tool outputs captured during dispatch and upload any
 * artifact-bearing local file via `bot.api.sendDocument` (pdf) or
 * `bot.api.sendPhoto` (image_generate). The text reply remains canonical;
 * the file upload is ADDITIONAL.
 *
 * Capture seam: the helper wraps the production `runTool` callback (built
 * via `buildRunToolFromRegistry`) so each `(tool, output)` tuple from a
 * successful tool run is recorded WITHOUT touching the frozen dispatcher
 * or contract modules. Tests drive the wrapper by having the
 * `runOrchestratorTurn` stub call the wrapped `runTool` it received,
 * which exactly mirrors what the real dispatcher does in production.
 */
describe("followup #19 — artifact upload (pdf / image_generate)", () => {
  // Use a real on-disk temp file so the existence + size checks in the
  // helper exercise their real branch instead of being mocked.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path") as typeof import("node:path");

  function makeArtifact(ext: string, payload: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-v1-followup19-"));
    const p = path.join(dir, `artifact${ext}`);
    fs.writeFileSync(p, payload);
    return p;
  }

  it("pdf with ok=true → uploads via sendDocument with the local file path AFTER the text reply", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const { executeOrchestratorV1ShortCircuit } = await import("./bot-message-dispatch.js");
    const { bot, sends, documents, photos } = makeBotStub();
    const pdfPath = makeArtifact(".pdf", "%PDF-1.4 fake bytes");

    // The runTool we hand back to the orchestrator IS the wrapped one
    // — when invoked we return a synthetic ok=true with output.url.
    let capturedRunTool: ((a: unknown) => Promise<unknown>) | undefined;
    const buildRunToolFromRegistry = vi.fn(() => {
      const inner = vi.fn(async (action: { tool: string; args: Record<string, unknown> }) => {
        if (action.tool === "pdf") {
          return { ok: true, output: { url: pdfPath, title: action.args.title ?? "doc" } };
        }
        return { ok: false, error: "unsupported in test" };
      });
      return inner as never;
    });

    // Order assertion: capture the order in which bot api calls happen.
    const callOrder: string[] = [];
    bot.api.sendMessage.mockImplementation(async (chatId, text, opts) => {
      callOrder.push("sendMessage");
      sends.push({ chatId, text, opts });
      return { message_id: 1 };
    });
    bot.api.sendDocument.mockImplementation(async (chatId, file, opts) => {
      callOrder.push("sendDocument");
      documents.push({ chatId, file, opts });
      return { message_id: 2 };
    });

    const runOrchestratorTurn = vi.fn(
      async (input: { runTool: (a: unknown) => Promise<unknown> }) => {
        capturedRunTool = input.runTool;
        // Simulate dispatcher invoking the wrapped runTool for the pdf action.
        await input.runTool({ tool: "pdf", args: { title: "Тест отчёта", summary: "..." } });
        return {
          reply: `Сгенерировал PDF «Тест отчёта»: ${pdfPath}`,
          contract: { intent: "tool_calls", tool_calls: [], sequencing: "sequential" },
          stageA: { routing: { intent: "tool_calls" } },
          dispatch: {
            reply: `Сгенерировал PDF «Тест отчёта»: ${pdfPath}`,
            allOk: true,
            actions: [{ tool: "pdf", ok: true, reply: "..." }],
          },
        };
      },
    );

    const handled = await executeOrchestratorV1ShortCircuit(
      {
        userText: "сделай pdf отчёт «Тест»",
        chatId: 6533456892,
        threadSpec: { id: undefined } as never,
        bot: bot as never,
        cfg: {} as never,
        runtime: {} as never,
        agentDir: undefined,
      },
      {
        runOrchestratorTurn: runOrchestratorTurn as never,
        buildRunToolFromRegistry: buildRunToolFromRegistry as never,
      },
    );
    expect(handled).toBe(true);
    expect(typeof capturedRunTool).toBe("function");
    // Text first, document second — order matters so user sees context.
    expect(callOrder).toEqual(["sendMessage", "sendDocument"]);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.text).toContain("Сгенерировал PDF");
    expect(documents).toHaveLength(1);
    expect(photos).toHaveLength(0);
    expect(documents[0]!.chatId).toBe(6533456892);
    // Verify the file is wrapped as a grammy InputFile carrying the
    // local artifact filename (the constructor stores `filename` and
    // `fileData` internally; `fileData` is the path string we passed in).
    const file = documents[0]!.file as { filename?: string; fileData?: unknown };
    expect(file.filename).toBe("artifact.pdf");
    expect(file.fileData).toBe(pdfPath);
  });

  it("image_generate with ok=true → uploads via sendPhoto, NOT sendDocument", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const { executeOrchestratorV1ShortCircuit } = await import("./bot-message-dispatch.js");
    const { bot, sends, documents, photos } = makeBotStub();
    const imagePath = makeArtifact(".png", "PNG-fake");

    const buildRunToolFromRegistry = vi.fn(() => {
      const inner = vi.fn(async (_action: { tool: string }) => ({
        ok: true,
        output: { url: imagePath },
      }));
      return inner as never;
    });
    const runOrchestratorTurn = vi.fn(
      async (input: { runTool: (a: unknown) => Promise<unknown> }) => {
        await input.runTool({ tool: "image_generate", args: { prompt: "котик" } });
        return {
          reply: `Сгенерировал: ${imagePath}`,
          contract: { intent: "tool_calls" },
          stageA: { routing: { intent: "tool_calls" } },
          dispatch: { reply: `Сгенерировал: ${imagePath}`, allOk: true },
        };
      },
    );

    await executeOrchestratorV1ShortCircuit(
      {
        userText: "нарисуй котика",
        chatId: 1,
        threadSpec: { id: undefined } as never,
        bot: bot as never,
        cfg: {} as never,
        runtime: {} as never,
        agentDir: undefined,
      },
      {
        runOrchestratorTurn: runOrchestratorTurn as never,
        buildRunToolFromRegistry: buildRunToolFromRegistry as never,
      },
    );
    expect(sends).toHaveLength(1);
    expect(photos).toHaveLength(1);
    expect(documents).toHaveLength(0);
    expect(photos[0]!.chatId).toBe(1);
  });

  it("write tool (non-artifact) with ok=true → NEITHER sendDocument NOR sendPhoto called (only sendMessage)", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const { executeOrchestratorV1ShortCircuit } = await import("./bot-message-dispatch.js");
    const { bot, sends, documents, photos } = makeBotStub();

    const buildRunToolFromRegistry = vi.fn(() => {
      const inner = vi.fn(async () => ({
        ok: true,
        output: { path: "/tmp/foo.txt", bytesWritten: 3 },
      }));
      return inner as never;
    });
    const runOrchestratorTurn = vi.fn(
      async (input: { runTool: (a: unknown) => Promise<unknown> }) => {
        await input.runTool({ tool: "write", args: { path: "/tmp/foo.txt", content: "hi" } });
        return {
          reply: "Записал в /tmp/foo.txt.",
          contract: { intent: "tool_calls" },
          stageA: { routing: { intent: "tool_calls" } },
          dispatch: { reply: "Записал в /tmp/foo.txt.", allOk: true },
        };
      },
    );

    await executeOrchestratorV1ShortCircuit(
      {
        userText: "запиши /tmp/foo.txt 'hi'",
        chatId: 42,
        threadSpec: { id: undefined } as never,
        bot: bot as never,
        cfg: {} as never,
        runtime: {} as never,
        agentDir: undefined,
      },
      {
        runOrchestratorTurn: runOrchestratorTurn as never,
        buildRunToolFromRegistry: buildRunToolFromRegistry as never,
      },
    );
    expect(sends).toHaveLength(1);
    expect(documents).toHaveLength(0);
    expect(photos).toHaveLength(0);
  });

  it("multi-action turn (pdf + write) → sendMessage for combined text, sendDocument ONLY for pdf", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const { executeOrchestratorV1ShortCircuit } = await import("./bot-message-dispatch.js");
    const { bot, sends, documents, photos } = makeBotStub();
    const pdfPath = makeArtifact(".pdf", "%PDF fake");

    const buildRunToolFromRegistry = vi.fn(() => {
      const inner = vi.fn(async (action: { tool: string }) => {
        if (action.tool === "pdf") {
          return { ok: true, output: { url: pdfPath, title: "X" } };
        }
        if (action.tool === "write") {
          return { ok: true, output: { path: "/tmp/bar.txt", bytesWritten: 4 } };
        }
        return { ok: false, error: "?" };
      });
      return inner as never;
    });
    const runOrchestratorTurn = vi.fn(
      async (input: { runTool: (a: unknown) => Promise<unknown> }) => {
        await input.runTool({ tool: "pdf", args: { title: "X", summary: "Y" } });
        await input.runTool({ tool: "write", args: { path: "/tmp/bar.txt", content: "data" } });
        return {
          reply: "Готово:\n\n1. Сгенерировал PDF «X»: " + pdfPath + "\n2. Записал в /tmp/bar.txt.",
          contract: { intent: "tool_calls" },
          stageA: { routing: { intent: "tool_calls" } },
          dispatch: { reply: "...", allOk: true },
        };
      },
    );

    await executeOrchestratorV1ShortCircuit(
      {
        userText: "сгенерь pdf и запиши файл",
        chatId: 99,
        threadSpec: { id: undefined } as never,
        bot: bot as never,
        cfg: {} as never,
        runtime: {} as never,
        agentDir: undefined,
      },
      {
        runOrchestratorTurn: runOrchestratorTurn as never,
        buildRunToolFromRegistry: buildRunToolFromRegistry as never,
      },
    );
    expect(sends).toHaveLength(1); // combined multi-template reply
    expect(documents).toHaveLength(1); // pdf only
    expect(photos).toHaveLength(0);
    expect(documents[0]!.chatId).toBe(99);
  });

  it("pdf with ok=false → does NOT upload (don't send error replies as files)", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const { executeOrchestratorV1ShortCircuit } = await import("./bot-message-dispatch.js");
    const { bot, documents, photos } = makeBotStub();

    const buildRunToolFromRegistry = vi.fn(() => {
      const inner = vi.fn(async () => ({ ok: false, error: "playwright missing" }));
      return inner as never;
    });
    const runOrchestratorTurn = vi.fn(
      async (input: { runTool: (a: unknown) => Promise<unknown> }) => {
        await input.runTool({ tool: "pdf", args: { title: "X", summary: "Y" } });
        return {
          reply: "Не получилось создать PDF",
          contract: { intent: "tool_calls" },
          stageA: { routing: { intent: "tool_calls" } },
          dispatch: { reply: "Не получилось создать PDF", allOk: false },
        };
      },
    );

    await executeOrchestratorV1ShortCircuit(
      {
        userText: "сделай pdf",
        chatId: 7,
        threadSpec: { id: undefined } as never,
        bot: bot as never,
        cfg: {} as never,
        runtime: {} as never,
        agentDir: undefined,
      },
      {
        runOrchestratorTurn: runOrchestratorTurn as never,
        buildRunToolFromRegistry: buildRunToolFromRegistry as never,
      },
    );
    expect(documents).toHaveLength(0);
    expect(photos).toHaveLength(0);
  });

  it("artifact path doesn't exist on disk → log + skip upload, do NOT crash the dispatch", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const { executeOrchestratorV1ShortCircuit } = await import("./bot-message-dispatch.js");
    const { bot, sends, documents, photos } = makeBotStub();
    const errorRuntime = { error: vi.fn() };
    const ghostPath = path.join(os.tmpdir(), "definitely-does-not-exist-" + Date.now() + ".pdf");

    const buildRunToolFromRegistry = vi.fn(() => {
      const inner = vi.fn(async () => ({
        ok: true,
        output: { url: ghostPath, title: "ghost" },
      }));
      return inner as never;
    });
    const runOrchestratorTurn = vi.fn(
      async (input: { runTool: (a: unknown) => Promise<unknown> }) => {
        await input.runTool({ tool: "pdf", args: { title: "ghost", summary: "..." } });
        return {
          reply: "Сгенерировал PDF «ghost»: " + ghostPath,
          contract: { intent: "tool_calls" },
          stageA: { routing: { intent: "tool_calls" } },
          dispatch: { reply: "...", allOk: true },
        };
      },
    );

    const handled = await executeOrchestratorV1ShortCircuit(
      {
        userText: "сделай pdf",
        chatId: 8,
        threadSpec: { id: undefined } as never,
        bot: bot as never,
        cfg: {} as never,
        runtime: errorRuntime as never,
        agentDir: undefined,
      },
      {
        runOrchestratorTurn: runOrchestratorTurn as never,
        buildRunToolFromRegistry: buildRunToolFromRegistry as never,
      },
    );
    expect(handled).toBe(true);
    expect(sends).toHaveLength(1); // the text reply still went out
    expect(documents).toHaveLength(0); // upload skipped
    expect(photos).toHaveLength(0);
    // The runtime.error sink saw a warning about the missing artifact.
    expect(errorRuntime.error).toHaveBeenCalled();
  });

  it("empty file (size 0) → skip upload (defensive: a buggy runner could lie about ok=true)", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const { executeOrchestratorV1ShortCircuit } = await import("./bot-message-dispatch.js");
    const { bot, documents, photos } = makeBotStub();
    const emptyPath = makeArtifact(".pdf", ""); // 0 bytes

    const buildRunToolFromRegistry = vi.fn(() => {
      const inner = vi.fn(async () => ({
        ok: true,
        output: { url: emptyPath, title: "empty" },
      }));
      return inner as never;
    });
    const runOrchestratorTurn = vi.fn(
      async (input: { runTool: (a: unknown) => Promise<unknown> }) => {
        await input.runTool({ tool: "pdf", args: { title: "empty", summary: "..." } });
        return {
          reply: "Сгенерировал PDF «empty»: " + emptyPath,
          contract: { intent: "tool_calls" },
          stageA: { routing: { intent: "tool_calls" } },
          dispatch: { reply: "...", allOk: true },
        };
      },
    );

    await executeOrchestratorV1ShortCircuit(
      {
        userText: "pdf",
        chatId: 9,
        threadSpec: { id: undefined } as never,
        bot: bot as never,
        cfg: {} as never,
        runtime: { error: vi.fn() } as never,
        agentDir: undefined,
      },
      {
        runOrchestratorTurn: runOrchestratorTurn as never,
        buildRunToolFromRegistry: buildRunToolFromRegistry as never,
      },
    );
    expect(documents).toHaveLength(0);
    expect(photos).toHaveLength(0);
  });

  it("threadSpec.id forwarded to sendDocument as message_thread_id (forum topic landing)", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const { executeOrchestratorV1ShortCircuit } = await import("./bot-message-dispatch.js");
    const { bot, documents } = makeBotStub();
    const pdfPath = makeArtifact(".pdf", "%PDF");

    const buildRunToolFromRegistry = vi.fn(() => {
      const inner = vi.fn(async () => ({ ok: true, output: { url: pdfPath, title: "T" } }));
      return inner as never;
    });
    const runOrchestratorTurn = vi.fn(
      async (input: { runTool: (a: unknown) => Promise<unknown> }) => {
        await input.runTool({ tool: "pdf", args: { title: "T", summary: "S" } });
        return {
          reply: "Сгенерировал PDF «T»",
          contract: { intent: "tool_calls" },
          stageA: { routing: { intent: "tool_calls" } },
          dispatch: { reply: "...", allOk: true },
        };
      },
    );

    await executeOrchestratorV1ShortCircuit(
      {
        userText: "pdf",
        chatId: 100,
        threadSpec: { id: 555 } as never,
        bot: bot as never,
        cfg: {} as never,
        runtime: {} as never,
        agentDir: undefined,
      },
      {
        runOrchestratorTurn: runOrchestratorTurn as never,
        buildRunToolFromRegistry: buildRunToolFromRegistry as never,
      },
    );
    expect(documents).toHaveLength(1);
    expect(documents[0]!.opts).toEqual({ message_thread_id: 555 });
  });

  it("sendDocument throws → log + continue (don't crash the dispatch, text reply already delivered)", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const { executeOrchestratorV1ShortCircuit } = await import("./bot-message-dispatch.js");
    const { bot, sends } = makeBotStub();
    const errorRuntime = { error: vi.fn() };
    const pdfPath = makeArtifact(".pdf", "%PDF");

    bot.api.sendDocument.mockImplementation(async () => {
      throw new Error("telegram api 413 file too large");
    });

    const buildRunToolFromRegistry = vi.fn(() => {
      const inner = vi.fn(async () => ({ ok: true, output: { url: pdfPath, title: "T" } }));
      return inner as never;
    });
    const runOrchestratorTurn = vi.fn(
      async (input: { runTool: (a: unknown) => Promise<unknown> }) => {
        await input.runTool({ tool: "pdf", args: { title: "T", summary: "S" } });
        return {
          reply: "Сгенерировал PDF «T»",
          contract: { intent: "tool_calls" },
          stageA: { routing: { intent: "tool_calls" } },
          dispatch: { reply: "...", allOk: true },
        };
      },
    );

    const handled = await executeOrchestratorV1ShortCircuit(
      {
        userText: "pdf",
        chatId: 101,
        threadSpec: { id: undefined } as never,
        bot: bot as never,
        cfg: {} as never,
        runtime: errorRuntime as never,
        agentDir: undefined,
      },
      {
        runOrchestratorTurn: runOrchestratorTurn as never,
        buildRunToolFromRegistry: buildRunToolFromRegistry as never,
      },
    );
    expect(handled).toBe(true);
    expect(sends).toHaveLength(1); // text already sent before upload attempt
    expect(errorRuntime.error).toHaveBeenCalled();
  });
});
