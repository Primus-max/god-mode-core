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

function makeBotStub(): {
  bot: { api: { sendMessage: ReturnType<typeof vi.fn> } };
  sends: SendCall[];
} {
  const sends: SendCall[] = [];
  const sendMessage = vi.fn(async (chatId: number | string, text: string, opts?: unknown) => {
    sends.push({ chatId, text, opts });
    return { message_id: 1 };
  });
  return { bot: { api: { sendMessage } }, sends };
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
    const buildRunToolFromRegistry = vi.fn(
      (deps: { scheduling: typeof capturedScheduling }) => {
        capturedScheduling = deps.scheduling;
        return vi.fn();
      },
    );
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
    const { executeOrchestratorV1ShortCircuit, TELEGRAM_TEXT_LIMIT } = await import(
      "./bot-message-dispatch.js"
    );
    const { bot, sends } = makeBotStub();
    // Simulate web_search-style reply: header + N numbered hits with snippet
    // text. Total length ~6000 — the live-verify failure was 6098.
    const header = "Найдено по запросу «gpt-5»:\n\n";
    const hits = Array.from({ length: 30 }, (_, i) =>
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
