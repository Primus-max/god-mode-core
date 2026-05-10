/**
 * V1-CONTRACT-ONLY — Multi-turn state orchestrator tests.
 *
 * Canonical real symptom: 2026-05-10 10:31 Telegram turn (operator log).
 * The user pasted a multi-tool task plan ("приложи два документа... найди...
 * напиши... на 10 страниц") instead of concrete args. Stage A correctly
 * routed to [write, image_generate, pdf]; Stage B failed missing_field
 * on each; the bot refused with a wall of "не хватает: ...". User had no
 * way to recover without resending the whole plan.
 *
 * The fix: an opt-in `turnState` store that stashes the partial plan
 * after a missing_field refuse. On the next inbound message, Stage A
 * runs again on the new text; if it produces the SAME ordered tool
 * names, Stage B receives the prior `argsSoFar` and only has to extract
 * the still-missing fields. Once all fields are filled, dispatch runs
 * and pending is cleared.
 *
 * Tests stub the LLM transport so we can script Stage A / Stage B
 * responses turn-by-turn.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { clearAllLocksForTesting } from "../chat-lock.js";
import { createInMemoryTurnStateStore } from "../turn-state/index.js";

beforeEach(() => {
  vi.resetModules();
  clearAllLocksForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Mock the pi-ai layer with a queue of canned responses. Each call to
 * `completeSimple` shifts the next response off the queue. Tests that
 * span multiple `runOrchestratorTurn` calls must enqueue Stage-A +
 * Stage-B responses in the order the orchestrator will issue them.
 */
function mockPiAi(scriptedResponses: string[]): void {
  let i = 0;
  vi.doMock("../../agents/pi-embedded-runner/model.js", () => ({
    resolveModelAsync: async () => ({
      model: { id: "fake", api: "openai-completions", baseUrl: "" } as never,
      modelRegistry: {},
      authStorage: {},
    }),
  }));
  vi.doMock("../../agents/simple-completion-transport.js", () => ({
    prepareModelForSimpleCompletion: ({ model }: { model: unknown }) => model,
  }));
  vi.doMock("../../agents/model-auth.js", () => ({
    getApiKeyForModel: async () => "test-key",
    requireApiKey: (k: string) => k,
  }));
  vi.doMock("../../config/config.js", () => ({ loadConfig: () => ({}) }));
  vi.doMock("@mariozechner/pi-ai", () => ({
    completeSimple: async () => {
      const text = scriptedResponses[i] ?? "(out of script)";
      i += 1;
      return { content: [{ type: "text", text }] };
    },
  }));
}

describe("V1-CONTRACT-ONLY orchestrator — multi-turn state machine", () => {
  it("real-symptom 10:31 — Stage A picks 3 tools, Stage B fails 3x missing_field, plan stashed; turn 2 fills all 3 → dispatch runs all", async () => {
    // Turn 1: vanilla Stage A (1 call) + 3x Stage B (one per tool).
    // Turn 2: plan-context Stage A (1 call) → add_args + 3x Stage B with argsSoFar.
    mockPiAi([
      // Turn 1 — vanilla Stage A
      '{"intent":"tool_calls","tool_names":["write","image_generate","pdf"],"sequencing":"sequential"}',
      // Turn 1 — Stage B per tool, all missing_field
      '{"_error":"missing","_field":"path"}',
      '{"_error":"missing","_field":"prompt"}',
      '{"_error":"missing","_field":"title"}',
      // Turn 2 — plan-context Stage A: user supplied missing args → add_args
      '{"kind":"add_args"}',
      // Turn 2 — Stage B per tool, now successful
      '{"path":"/work/practice.md","content":"шапка + текст"}',
      '{"prompt":"советский боец, портрет, ВОВ, документальный стиль"}',
      '{"title":"Отчёт по практике","summary":"История бойца..."}',
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const store = createInMemoryTurnStateStore();
    const runTool = vi.fn(async (a) => ({
      ok: true as const,
      output: { ...a.args, url: a.tool === "pdf" ? "/pdf/x.pdf" : "/img/y.png" },
    }));
    const runConv = vi.fn();

    const turn1 = await runOrchestratorTurn({
      userMessage:
        "Прикладываю два документа, надо в таком же стиле, шапки и тд оставить, заполнить всё как доложно быть...",
      chatKey: "tg:6533456892",
      runTool,
      runConversationLLM: runConv,
      turnState: store,
    });

    // Turn 1 expectations: refuse with multi-turn "Допиши в следующем" wording
    expect(turn1.contract.intent).toBe("refuse");
    expect(turn1.reply).toContain("путь к файлу");
    expect(turn1.reply).toContain("описание картинки");
    expect(turn1.reply).toContain("заголовок документа");
    expect(turn1.reply).toContain("Допиши в следующем сообщении");
    expect(runTool).not.toHaveBeenCalled();

    // Plan stashed
    const stashed = await store.get("tg:6533456892");
    expect(stashed).toBeDefined();
    expect(stashed?.tool_calls.map((p) => p.tool)).toEqual([
      "write",
      "image_generate",
      "pdf",
    ]);
    expect(stashed?.tool_calls[0]?.missingFields).toEqual(["path"]);

    const turn2 = await runOrchestratorTurn({
      userMessage:
        "путь /work/practice.md, prompt — советский боец, заголовок 'Отчёт по практике'",
      chatKey: "tg:6533456892",
      runTool,
      runConversationLLM: runConv,
      turnState: store,
    });

    // Turn 2 expectations: dispatch runs all 3 tools, pending cleared
    expect(turn2.contract.intent).toBe("tool_calls");
    expect(runTool).toHaveBeenCalledTimes(3);
    expect(runTool.mock.calls.map((c) => c[0].tool)).toEqual([
      "write",
      "image_generate",
      "pdf",
    ]);
    expect(turn2.dispatch.allOk).toBe(true);
    expect(await store.get("tg:6533456892")).toBeUndefined();
  });

  it("pending state cleared when plan-context Stage A returns abandon/conversation on next turn (user changed topic)", async () => {
    mockPiAi([
      // Turn 1 — vanilla Stage A → tool_calls
      '{"intent":"tool_calls","tool_names":["write"],"sequencing":"sequential"}',
      // Turn 1 — Stage B fails missing_field
      '{"_error":"missing","_field":"path"}',
      // Turn 2 — plan-context Stage A: abandon to conversation
      '{"kind":"abandon","intent":"conversation"}',
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const store = createInMemoryTurnStateStore();
    const runTool = vi.fn(async () => ({ ok: true as const, output: {} }));
    const runConv = vi.fn(async () => "ну привет");

    await runOrchestratorTurn({
      userMessage: "сохрани заметку",
      chatKey: "chat-pivot",
      runTool,
      runConversationLLM: runConv,
      turnState: store,
    });
    expect(await store.get("chat-pivot")).toBeDefined();

    const turn2 = await runOrchestratorTurn({
      userMessage: "забудь, как дела вообще",
      chatKey: "chat-pivot",
      runTool,
      runConversationLLM: runConv,
      turnState: store,
    });

    expect(turn2.contract.intent).toBe("conversation");
    expect(runConv).toHaveBeenCalledTimes(1);
    expect(await store.get("chat-pivot")).toBeUndefined();
  });

  it("pending state cleared when plan-context Stage A returns replace_plan (user pivoted to a new plan)", async () => {
    mockPiAi([
      // Turn 1
      '{"intent":"tool_calls","tool_names":["write"],"sequencing":"sequential"}',
      '{"_error":"missing","_field":"path"}',
      // Turn 2 — plan-context says replace_plan with entirely different tools
      '{"kind":"replace_plan","tool_names":["web_search"],"sequencing":"sequential"}',
      '{"query":"новости вторника"}',
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const store = createInMemoryTurnStateStore();
    const runTool = vi.fn(async (a) => ({
      ok: true as const,
      output: { results: "...", query: a.args.query },
    }));

    await runOrchestratorTurn({
      userMessage: "сохрани",
      chatKey: "chat-newplan",
      runTool,
      runConversationLLM: async () => "x",
      turnState: store,
    });
    expect(await store.get("chat-newplan")).toBeDefined();

    const turn2 = await runOrchestratorTurn({
      userMessage: "найди новости вторника",
      chatKey: "chat-newplan",
      runTool,
      runConversationLLM: async () => "x",
      turnState: store,
    });

    // The new plan ran (web_search) — write was not retried.
    expect(turn2.contract.intent).toBe("tool_calls");
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool.mock.calls[0]![0].tool).toBe("web_search");
    expect(await store.get("chat-newplan")).toBeUndefined();
  });

  it("plan-context edit_plan adds a new tool while keeping the original; argsSoFar carry forward for survivors", async () => {
    mockPiAi([
      // Turn 1 — write only, missing path
      '{"intent":"tool_calls","tool_names":["write"],"sequencing":"sequential"}',
      '{"_error":"missing","_field":"path"}',
      // Turn 2 — plan-context says edit_plan: keep write, add pdf
      '{"kind":"edit_plan","tool_names":["write","pdf"],"sequencing":"sequential"}',
      // Stage B both succeed with concrete fields
      '{"path":"/a","content":"x"}',
      '{"title":"T","summary":"s"}',
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const store = createInMemoryTurnStateStore();
    const runTool = vi.fn(async (a) => ({ ok: true as const, output: { ...a.args, url: "u" } }));

    await runOrchestratorTurn({
      userMessage: "сохрани",
      chatKey: "chat-overlap",
      runTool,
      runConversationLLM: async () => "x",
      turnState: store,
    });

    const turn2 = await runOrchestratorTurn({
      userMessage: "/a content x, и pdf T s",
      chatKey: "chat-overlap",
      runTool,
      runConversationLLM: async () => "x",
      turnState: store,
    });

    expect(turn2.contract.intent).toBe("tool_calls");
    expect(runTool).toHaveBeenCalledTimes(2);
    expect(await store.get("chat-overlap")).toBeUndefined();
  });

  it("pending state cleared when plan-context Stage A returns abandon/refuse on next turn", async () => {
    mockPiAi([
      '{"intent":"tool_calls","tool_names":["write"],"sequencing":"sequential"}',
      '{"_error":"missing","_field":"path"}',
      '{"kind":"abandon","intent":"refuse","refusal_reason":"непонятно что"}',
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const store = createInMemoryTurnStateStore();
    const runTool = vi.fn();
    await runOrchestratorTurn({
      userMessage: "сохрани",
      chatKey: "chat-refuse-pivot",
      runTool,
      runConversationLLM: async () => "x",
      turnState: store,
    });
    expect(await store.get("chat-refuse-pivot")).toBeDefined();

    const turn2 = await runOrchestratorTurn({
      userMessage: "хм",
      chatKey: "chat-refuse-pivot",
      runTool,
      runConversationLLM: async () => "x",
      turnState: store,
    });
    expect(turn2.contract.intent).toBe("refuse");
    expect(await store.get("chat-refuse-pivot")).toBeUndefined();
  });

  it("TTL expiry: an expired pending state is treated as absent (no resume)", async () => {
    mockPiAi([
      '{"intent":"tool_calls","tool_names":["write"],"sequencing":"sequential"}',
      '{"_error":"missing","_field":"path"}',
      '{"intent":"tool_calls","tool_names":["write"],"sequencing":"sequential"}',
      // After expiry, Stage B sees no argsSoFar — same fresh missing_field
      // would happen, but we use successful response to confirm dispatch
      // proceeds without resume context.
      '{"path":"/late.md","content":"hi"}',
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");

    // Store uses real wall clock until we override it. Orchestrator stamps
    // expiresAt with real Date.now()+ttl. We then advance the store's
    // mocked now past that expiry timestamp by sampling Date.now()+offset.
    let nowOffset = 0;
    const store = createInMemoryTurnStateStore({
      now: () => Date.now() + nowOffset,
    });
    const runTool = vi.fn(async (a) => ({ ok: true as const, output: { ...a.args } }));

    await runOrchestratorTurn({
      userMessage: "сохрани",
      chatKey: "chat-ttl",
      runTool,
      runConversationLLM: async () => "x",
      turnState: store,
      turnStateTtlMs: 60_000, // 1 minute
    });
    expect(await store.get("chat-ttl")).toBeDefined();

    // Jump past TTL — store's now() now exceeds the stashed expiresAt.
    nowOffset = 120_000;
    expect(await store.get("chat-ttl")).toBeUndefined();

    const turn2 = await runOrchestratorTurn({
      userMessage: "/late.md hi",
      chatKey: "chat-ttl",
      runTool,
      runConversationLLM: async () => "x",
      turnState: store,
      turnStateTtlMs: 60_000,
    });
    expect(turn2.contract.intent).toBe("tool_calls");
    expect(runTool).toHaveBeenCalledTimes(1);
  });

  it("backwards compat: omitting `turnState` collapses Stage-B failure to refuse without stashing", async () => {
    mockPiAi([
      '{"intent":"tool_calls","tool_names":["write"],"sequencing":"sequential"}',
      '{"_error":"missing","_field":"path"}',
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const runTool = vi.fn();
    const result = await runOrchestratorTurn({
      userMessage: "сохрани",
      chatKey: "chat-no-mt",
      runTool,
      runConversationLLM: async () => "x",
      // no turnState
    });
    expect(result.contract.intent).toBe("refuse");
    // Old phrasing — NO "Допиши в следующем" suffix on single-turn flow.
    expect(result.reply).not.toContain("Допиши в следующем сообщении");
    // Original prefix when ALL actions failed (existing tests assert this).
    expect(result.reply).toMatch(/не удалось извлечь аргументы для инструментов/);
    expect(result.reply).toContain("путь к файлу");
    expect(runTool).not.toHaveBeenCalled();
  });

  it("Stage-B argsSoFar carries forward: prompt includes prior args block on resume", async () => {
    // White-box: when resuming, Stage B's prompt is built with argsSoFar.
    // We script Stage B to echo back a JSON with ONLY the new field; the
    // orchestrator's merge logic in extractToolArgs fills in the prior
    // argsSoFar so Zod validation passes.
    mockPiAi([
      // Turn 1
      '{"intent":"tool_calls","tool_names":["write"],"sequencing":"sequential"}',
      // First Stage B: gets `content` already, missing `path`.
      // Use missing_field to stash, but argsSoFar must be empty at this point
      // because Stage B parsed nothing successfully on turn 1 — that's by
      // design (we only stash what the LLM positively reported, not what
      // we *suspected*). If the LLM only reported missing, argsSoFar={}.
      '{"_error":"missing","_field":"path"}',
      // Turn 2: plan-context Stage A → add_args
      '{"kind":"add_args"}',
      // Stage B emits both fields (the LLM's job); merge would also work
      // if it emitted just path.
      '{"path":"/p.md","content":"new text"}',
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const store = createInMemoryTurnStateStore();
    const runTool = vi.fn(async (a) => ({ ok: true as const, output: { ...a.args } }));

    await runOrchestratorTurn({
      userMessage: "сохрани заметку 'привет'",
      chatKey: "chat-carry",
      runTool,
      runConversationLLM: async () => "x",
      turnState: store,
    });

    const turn2 = await runOrchestratorTurn({
      userMessage: "путь /p.md, текст 'new text'",
      chatKey: "chat-carry",
      runTool,
      runConversationLLM: async () => "x",
      turnState: store,
    });

    expect(turn2.contract.intent).toBe("tool_calls");
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool.mock.calls[0]![0].args).toEqual({ path: "/p.md", content: "new text" });
  });

  it("concurrency: two concurrent turns on the same chatKey serialize via withChatLock and pending state is consistent", async () => {
    // Both turns start at the same time. Lock ensures turn 1 finishes
    // (stashing pending) before turn 2 begins (which then resumes /
    // pivots). Without the lock, turn 2 could read the store before
    // turn 1 wrote, causing a missed resume / double-stash.
    mockPiAi([
      // Turn 1 — vanilla Stage A → tool_calls, Stage B → missing
      '{"intent":"tool_calls","tool_names":["write"],"sequencing":"sequential"}',
      '{"_error":"missing","_field":"path"}',
      // Turn 2 — plan-context Stage A → add_args, Stage B → success
      '{"kind":"add_args"}',
      '{"path":"/concurrent.md","content":"hi"}',
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const store = createInMemoryTurnStateStore();
    const runTool = vi.fn(async (a) => ({ ok: true as const, output: { ...a.args } }));

    const t1 = runOrchestratorTurn({
      userMessage: "сохрани",
      chatKey: "chat-concurrent",
      runTool,
      runConversationLLM: async () => "x",
      turnState: store,
    });
    const t2 = runOrchestratorTurn({
      userMessage: "/concurrent.md hi",
      chatKey: "chat-concurrent",
      runTool,
      runConversationLLM: async () => "x",
      turnState: store,
    });

    const [r1, r2] = await Promise.all([t1, t2]);
    expect(r1.contract.intent).toBe("refuse");
    expect(r2.contract.intent).toBe("tool_calls");
    // After both complete, pending must be cleared (turn 2 dispatched).
    expect(await store.get("chat-concurrent")).toBeUndefined();
    expect(runTool).toHaveBeenCalledTimes(1);
  });

  it("non-recoverable Stage-B failure (non_json) on multi-turn does NOT stash pending — user can't fix it by typing more text", async () => {
    mockPiAi([
      '{"intent":"tool_calls","tool_names":["write"],"sequencing":"sequential"}',
      "complete garbage non-json",
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const store = createInMemoryTurnStateStore();
    const runTool = vi.fn();
    const result = await runOrchestratorTurn({
      userMessage: "сохрани что-то",
      chatKey: "chat-infra-fail",
      runTool,
      runConversationLLM: async () => "x",
      turnState: store,
    });
    expect(result.contract.intent).toBe("refuse");
    expect(result.reply).toMatch(/non_json/);
    // No stashing — that error is infra, not user-actionable.
    expect(await store.get("chat-infra-fail")).toBeUndefined();
    // Old phrasing preserved (no "Допиши" suffix).
    expect(result.reply).not.toContain("Допиши в следующем сообщении");
  });

  it("mixed missing_field + non_json on multi-turn → refuse_other (no stash, no Допиши suffix)", async () => {
    // If even one tool fails infra-style (non_json), retrying won't help;
    // we surface the regular refuse and don't stash.
    mockPiAi([
      '{"intent":"tool_calls","tool_names":["write","sessions_send"],"sequencing":"sequential"}',
      '{"_error":"missing","_field":"path"}',
      "totally not json",
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const store = createInMemoryTurnStateStore();
    const runTool = vi.fn();
    const result = await runOrchestratorTurn({
      userMessage: "сохрани и отправь",
      chatKey: "chat-mixed-fail",
      runTool,
      runConversationLLM: async () => "x",
      turnState: store,
    });
    expect(result.contract.intent).toBe("refuse");
    expect(result.reply).toContain("путь к файлу");
    expect(result.reply).toMatch(/sessions_send \(non_json/);
    expect(result.reply).not.toContain("Допиши в следующем сообщении");
    expect(await store.get("chat-mixed-fail")).toBeUndefined();
  });
});
