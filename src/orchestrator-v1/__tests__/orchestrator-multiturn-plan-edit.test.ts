/**
 * V1-CONTRACT-ONLY — Multi-turn plan-edit awareness tests.
 *
 * Canonical real symptom: 2026-05-10 Telegram session.
 *   12:09 (real): user "Прикладываю два документа... надо найти инфу про
 *                 бойца ВОВ и собрать два файла..." → vanilla Stage A
 *                 picked tool_calls=[write, image_generate]; Stage B
 *                 failed missing_field on each; bot replied "не хватает:
 *                 путь к файлу (write); описание картинки
 *                 (image_generate). Допиши в следующем сообщении" and
 *                 stashed pending=[write, image_generate].
 *
 *   12:17 (real): user "Надо скачать, а не генерировать, я тебе дал
 *                 задание что надо делать." (plan correction). Old
 *                 multi-turn classifier: ran vanilla Stage A on the new
 *                 text in isolation → refuse (no concrete URL/query); the
 *                 pending plan got cleared. User reaction:
 *                 "нихера как не работало, так и не работает".
 *
 * The fix in this slice: when pending exists, route the new message
 * through `classifyTurnWithPendingContext`. That sees the pending plan +
 * user message together and emits one of:
 *   add_args | edit_plan | replace_plan | abandon
 *
 * For 12:17 the LLM is expected to return:
 *   { kind: "edit_plan", tool_names: ["write", "web_fetch"|"web_search"], ... }
 * dropping image_generate, adding the download tool. Stage B then runs
 * over the morphed plan (write argsSoFar carries forward; web_* fresh).
 *
 * This file scripts the LLM transport so we test the orchestrator
 * branching, NOT the live model accuracy. Live accuracy is covered by
 * the new `classifier-bench-plan-context` (separate fixture set).
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

describe("V1-CONTRACT-ONLY orchestrator — multi-turn plan-edit awareness", () => {
  it("CANONICAL 12:09→12:17 — pending [write, image_generate]; user 'Надо скачать' → edit_plan replaces image_generate with web_fetch", async () => {
    mockPiAi([
      // Turn 1 — vanilla Stage A picks the original 2 tools
      '{"intent":"tool_calls","tool_names":["write","image_generate"],"sequencing":"sequential"}',
      // Turn 1 — Stage B missing_field for both
      '{"_error":"missing","_field":"path"}',
      '{"_error":"missing","_field":"prompt"}',
      // Turn 2 — plan-context Stage A: edit_plan replacing image_generate with web_fetch
      '{"kind":"edit_plan","tool_names":["write","web_fetch"],"sequencing":"sequential"}',
      // Turn 2 — Stage B per morphed plan (write still missing path, web_fetch fresh + missing url)
      '{"_error":"missing","_field":"path"}',
      '{"_error":"missing","_field":"url"}',
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const store = createInMemoryTurnStateStore();
    const runTool = vi.fn();
    const runConv = vi.fn();

    const turn1 = await runOrchestratorTurn({
      userMessage:
        "Прикладываю два документа, надо найти инфу про бойца ВОВ и собрать два файла",
      chatKey: "tg:6533456892",
      runTool,
      runConversationLLM: runConv,
      turnState: store,
    });
    expect(turn1.contract.intent).toBe("refuse");
    const stashedAfterTurn1 = await store.get("tg:6533456892");
    expect(stashedAfterTurn1?.tool_calls.map((p) => p.tool)).toEqual([
      "write",
      "image_generate",
    ]);

    const turn2 = await runOrchestratorTurn({
      userMessage: "Надо скачать, а не генерировать, я тебе дал задание что надо делать.",
      chatKey: "tg:6533456892",
      runTool,
      runConversationLLM: runConv,
      turnState: store,
    });

    // Plan was morphed: image_generate dropped, web_fetch added; both
    // still missing fields → refuse_missing path stashed the new pending.
    expect(turn2.contract.intent).toBe("refuse");
    const stashedAfterTurn2 = await store.get("tg:6533456892");
    expect(stashedAfterTurn2?.tool_calls.map((p) => p.tool)).toEqual([
      "write",
      "web_fetch",
    ]);
    expect(turn2.reply).toContain("Допиши в следующем сообщении");
    // No tool ran (Stage B still incomplete on the morphed plan).
    expect(runTool).not.toHaveBeenCalled();
  });

  it("edit_plan with surviving tool: write argsSoFar carries forward across morph (image_generate → web_fetch)", async () => {
    mockPiAi([
      // Turn 1 — write+image_generate; Stage B fills write path but
      // missing content; image_generate missing prompt.
      '{"intent":"tool_calls","tool_names":["write","image_generate"],"sequencing":"sequential"}',
      '{"_error":"missing","_field":"content"}',
      '{"_error":"missing","_field":"prompt"}',
      // Turn 2 — edit_plan: drop image_generate, add web_fetch
      '{"kind":"edit_plan","tool_names":["write","web_fetch"],"sequencing":"sequential"}',
      // Stage B per morphed plan: write succeeds (with carryover empty argsSoFar
      // because turn 1 returned missing_field with no parsed args, argsSoFar={}).
      // To exercise carryover, the orchestrator passes priorByTool[write] = the
      // original PartialAction. Stage B prompt sees argsSoFar — Stage B emits content.
      '{"path":"/notes.md","content":"конспект"}',
      '{"url":"https://example.com/page"}',
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const store = createInMemoryTurnStateStore();
    const runTool = vi.fn(async (a) => ({
      ok: true as const,
      output: { ...a.args, content: "конспект", url: "ok" },
    }));

    await runOrchestratorTurn({
      userMessage: "сохрани конспект и сгенерируй картинку",
      chatKey: "chat-edit-survive",
      runTool,
      runConversationLLM: async () => "x",
      turnState: store,
    });

    const turn2 = await runOrchestratorTurn({
      userMessage: "не картинку, а скачай страницу example.com/page",
      chatKey: "chat-edit-survive",
      runTool,
      runConversationLLM: async () => "x",
      turnState: store,
    });

    expect(turn2.contract.intent).toBe("tool_calls");
    expect(runTool).toHaveBeenCalledTimes(2);
    const calledTools = runTool.mock.calls.map((c) => c[0].tool);
    expect(calledTools).toEqual(["write", "web_fetch"]);
    expect(await store.get("chat-edit-survive")).toBeUndefined();
  });

  it("add_args: pending [write] missing path; user supplies path → Stage B fills, dispatch runs", async () => {
    mockPiAi([
      '{"intent":"tool_calls","tool_names":["write"],"sequencing":"sequential"}',
      '{"_error":"missing","_field":"path"}',
      // Turn 2 — plan-context says: same plan, user just gave the args
      '{"kind":"add_args"}',
      '{"path":"/tmp/x.txt","content":"привет"}',
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const store = createInMemoryTurnStateStore();
    const runTool = vi.fn(async (a) => ({ ok: true as const, output: { ...a.args } }));

    await runOrchestratorTurn({
      userMessage: "сохрани заметку 'привет'",
      chatKey: "chat-add-args",
      runTool,
      runConversationLLM: async () => "x",
      turnState: store,
    });

    const turn2 = await runOrchestratorTurn({
      userMessage: "сохрани в /tmp/x.txt",
      chatKey: "chat-add-args",
      runTool,
      runConversationLLM: async () => "x",
      turnState: store,
    });

    expect(turn2.contract.intent).toBe("tool_calls");
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool.mock.calls[0]![0].args).toMatchObject({ path: "/tmp/x.txt" });
    expect(await store.get("chat-add-args")).toBeUndefined();
  });

  it("replace_plan: pending [pdf]; user 'забудь, прочитай /tmp/y.txt' → fresh dispatch with [read]", async () => {
    mockPiAi([
      '{"intent":"tool_calls","tool_names":["pdf"],"sequencing":"sequential"}',
      '{"_error":"missing","_field":"title"}',
      // Turn 2 — replace_plan with a wholly new plan
      '{"kind":"replace_plan","tool_names":["read"],"sequencing":"sequential"}',
      '{"path":"/tmp/y.txt"}',
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const store = createInMemoryTurnStateStore();
    const runTool = vi.fn(async (a) => ({ ok: true as const, output: { ...a.args, content: "ok" } }));

    await runOrchestratorTurn({
      userMessage: "сделай отчёт PDF",
      chatKey: "chat-replace-plan",
      runTool,
      runConversationLLM: async () => "x",
      turnState: store,
    });

    const turn2 = await runOrchestratorTurn({
      userMessage: "забудь, просто прочитай /tmp/y.txt",
      chatKey: "chat-replace-plan",
      runTool,
      runConversationLLM: async () => "x",
      turnState: store,
    });

    expect(turn2.contract.intent).toBe("tool_calls");
    // No carryover from pdf — fresh single-tool dispatch.
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool.mock.calls[0]![0].tool).toBe("read");
    expect(runTool.mock.calls[0]![0].args).toEqual({ path: "/tmp/y.txt" });
    expect(await store.get("chat-replace-plan")).toBeUndefined();
  });

  it("abandon/conversation: pending [write]; user 'ок, расскажи анекдот' → conversation runs, pending cleared", async () => {
    mockPiAi([
      '{"intent":"tool_calls","tool_names":["write"],"sequencing":"sequential"}',
      '{"_error":"missing","_field":"path"}',
      '{"kind":"abandon","intent":"conversation"}',
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const store = createInMemoryTurnStateStore();
    const runTool = vi.fn();
    const runConv = vi.fn(async () => "вот тебе анекдот");

    await runOrchestratorTurn({
      userMessage: "сохрани заметку",
      chatKey: "chat-abandon-conv",
      runTool,
      runConversationLLM: runConv,
      turnState: store,
    });

    const turn2 = await runOrchestratorTurn({
      userMessage: "ок, спасибо, расскажи анекдот",
      chatKey: "chat-abandon-conv",
      runTool,
      runConversationLLM: runConv,
      turnState: store,
    });

    expect(turn2.contract.intent).toBe("conversation");
    expect(runConv).toHaveBeenCalledTimes(1);
    expect(runTool).not.toHaveBeenCalled();
    expect(await store.get("chat-abandon-conv")).toBeUndefined();
  });

  it("abandon/refuse: pending [exec]; user 'сам разбирайся' → refuse template, pending cleared", async () => {
    mockPiAi([
      '{"intent":"tool_calls","tool_names":["exec"],"sequencing":"sequential"}',
      '{"_error":"missing","_field":"command"}',
      '{"kind":"abandon","intent":"refuse","refusal_reason":"пользователь не хочет продолжать"}',
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const store = createInMemoryTurnStateStore();
    const runTool = vi.fn();
    const runConv = vi.fn();

    await runOrchestratorTurn({
      userMessage: "выполни команду",
      chatKey: "chat-abandon-refuse",
      runTool,
      runConversationLLM: runConv,
      turnState: store,
    });

    const turn2 = await runOrchestratorTurn({
      userMessage: "сам разбирайся",
      chatKey: "chat-abandon-refuse",
      runTool,
      runConversationLLM: runConv,
      turnState: store,
    });

    expect(turn2.contract.intent).toBe("refuse");
    // Refuse template renders "Не могу: <reason>"
    expect(turn2.reply).toContain("пользователь не хочет продолжать");
    expect(runConv).not.toHaveBeenCalled();
    expect(runTool).not.toHaveBeenCalled();
    expect(await store.get("chat-abandon-refuse")).toBeUndefined();
  });

  it("plan-context Stage A non_json fallback → abandon/refuse, pending cleared", async () => {
    // Failure-mode coverage: a malformed JSON from the plan-context
    // classifier MUST NOT crash; we route to abandon/refuse so the user
    // is unstuck and pending is cleared.
    mockPiAi([
      '{"intent":"tool_calls","tool_names":["write"],"sequencing":"sequential"}',
      '{"_error":"missing","_field":"path"}',
      "complete garbage non-json",
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const store = createInMemoryTurnStateStore();
    const runTool = vi.fn();
    await runOrchestratorTurn({
      userMessage: "сохрани",
      chatKey: "chat-pc-nonjson",
      runTool,
      runConversationLLM: async () => "x",
      turnState: store,
    });
    const turn2 = await runOrchestratorTurn({
      userMessage: "путь /a",
      chatKey: "chat-pc-nonjson",
      runTool,
      runConversationLLM: async () => "x",
      turnState: store,
    });
    expect(turn2.contract.intent).toBe("refuse");
    expect(runTool).not.toHaveBeenCalled();
    expect(await store.get("chat-pc-nonjson")).toBeUndefined();
  });

  it("plan-context Stage A wrong_enum (kind not in 4-way) → abandon/refuse, pending cleared", async () => {
    mockPiAi([
      '{"intent":"tool_calls","tool_names":["write"],"sequencing":"sequential"}',
      '{"_error":"missing","_field":"path"}',
      // kind=garbage is not in the 4-way enum
      '{"kind":"garbage_value"}',
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const store = createInMemoryTurnStateStore();
    const runTool = vi.fn();
    await runOrchestratorTurn({
      userMessage: "сохрани",
      chatKey: "chat-pc-enum",
      runTool,
      runConversationLLM: async () => "x",
      turnState: store,
    });
    const turn2 = await runOrchestratorTurn({
      userMessage: "что-то ещё",
      chatKey: "chat-pc-enum",
      runTool,
      runConversationLLM: async () => "x",
      turnState: store,
    });
    expect(turn2.contract.intent).toBe("refuse");
    expect(await store.get("chat-pc-enum")).toBeUndefined();
  });

  it("CANONICAL 12:54 — pending [pdf, image_generate, write]; user 'найти изображения, а не генерировать ... шаблоны word, а не pdf' → edit_plan = [web_search, write]", async () => {
    // Real Telegram turn 2026-05-10 12:54. Pre-enrichment Stage A
    // dropped pdf correctly but did NOT replace image_generate with
    // web_search; the bot then complained "не хватает: описание
    // картинки (image_generate)" and the user rejected the reply
    // ("херня"). After prompt enrichment, the LLM is expected to emit
    // edit_plan with web_search substituted for image_generate AND pdf
    // dropped. This test scripts that LLM response and verifies the
    // wiring morphs the stashed plan correctly.
    mockPiAi([
      // Turn 1 — vanilla Stage A picks the original 3 tools.
      '{"intent":"tool_calls","tool_names":["pdf","image_generate","write"],"sequencing":"sequential"}',
      // Turn 1 — Stage B missing_field for each tool.
      '{"_error":"missing","_field":"title"}',
      '{"_error":"missing","_field":"prompt"}',
      '{"_error":"missing","_field":"path"}',
      // Turn 2 — plan-context Stage A: edit_plan with the morphed plan.
      '{"kind":"edit_plan","tool_names":["web_search","write"],"sequencing":"sequential"}',
      // Turn 2 — Stage B over the morphed plan; both still missing fields.
      '{"_error":"missing","_field":"query"}',
      '{"_error":"missing","_field":"path"}',
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const store = createInMemoryTurnStateStore();
    const runTool = vi.fn();
    const runConv = vi.fn();

    const turn1 = await runOrchestratorTurn({
      userMessage:
        "Поможешь сделать практику? Прикладываю шаблоны и нужно собрать pdf с картинками",
      chatKey: "tg:6533456892",
      runTool,
      runConversationLLM: runConv,
      turnState: store,
    });
    expect(turn1.contract.intent).toBe("refuse");
    const stashedAfterTurn1 = await store.get("tg:6533456892");
    expect(stashedAfterTurn1?.tool_calls.map((p) => p.tool)).toEqual([
      "pdf",
      "image_generate",
      "write",
    ]);

    const turn2 = await runOrchestratorTurn({
      userMessage:
        "Надо найти изображения, а не генерировать, того о ком будет практика. Я дал приложил шаблоны word, а не pdf!!!",
      chatKey: "tg:6533456892",
      runTool,
      runConversationLLM: runConv,
      turnState: store,
    });

    // Plan was morphed: pdf dropped, image_generate replaced with
    // web_search; both surviving tools still missing fields → refuse +
    // pending stashed with the new shape.
    expect(turn2.contract.intent).toBe("refuse");
    const stashedAfterTurn2 = await store.get("tg:6533456892");
    expect(stashedAfterTurn2?.tool_calls.map((p) => p.tool)).toEqual([
      "web_search",
      "write",
    ]);
    expect(runTool).not.toHaveBeenCalled();
  });

  it("first turn (no pending) uses VANILLA Stage A — plan-context is engaged only when pending exists", async () => {
    // Defence against accidental coupling: if a fresh chat receives a
    // bare `{"kind":"add_args"}` style response, vanilla Stage A would
    // reject it as wrong_shape (no `intent` field) and the orchestrator
    // would refuse. This guards against regressions where someone
    // routes the first turn through the plan-context prompt.
    mockPiAi([
      // Vanilla Stage A — expected to receive 3-way intent JSON.
      '{"intent":"tool_calls","tool_names":["write"],"sequencing":"sequential"}',
      '{"path":"/p","content":"x"}',
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const store = createInMemoryTurnStateStore();
    const runTool = vi.fn(async (a) => ({ ok: true as const, output: { ...a.args } }));

    const r = await runOrchestratorTurn({
      userMessage: "сохрани в /p текст x",
      chatKey: "chat-first-turn",
      runTool,
      runConversationLLM: async () => "x",
      turnState: store,
    });
    expect(r.contract.intent).toBe("tool_calls");
    expect(runTool).toHaveBeenCalledTimes(1);
    // No pending after a successful first-turn dispatch.
    expect(await store.get("chat-first-turn")).toBeUndefined();
  });
});
