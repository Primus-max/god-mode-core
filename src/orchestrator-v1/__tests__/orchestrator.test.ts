/**
 * V1-CONTRACT-ONLY — End-to-end orchestrator tests.
 *
 * Verifies the full pipeline by stubbing pi-ai transport (so Stage A and
 * Stage B return canned routing/args) and tool execution.
 *
 * Real LLMs are not called — that's what the bench is for. These tests
 * lock in the orchestration logic: stage-A → stage-B → dispatcher → reply.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { clearAllLocksForTesting } from "../chat-lock.js";

beforeEach(() => {
  vi.resetModules();
  clearAllLocksForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Mock the pi-ai layer to script Stage-A/Stage-B responses in order. */
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

describe("V1-CONTRACT-ONLY orchestrator — end-to-end (mocked transport)", () => {
  it("conversation path: Stage A → conversation contract → conversation LLM stub → reply", async () => {
    mockPiAi(['{"intent":"conversation"}']);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const runConv = vi.fn(async (msg: string) => `Привет, ${msg}!`);
    const runTool = vi.fn(async () => {
      throw new Error("must not be called on conversation path");
    });
    const result = await runOrchestratorTurn({
      userMessage: "Vova",
      chatKey: "chat-1",
      runTool,
      runConversationLLM: runConv,
    });
    expect(result.contract.intent).toBe("conversation");
    expect(result.reply).toBe("Привет, Vova!");
    expect(runConv).toHaveBeenCalledWith("Vova");
    expect(runTool).not.toHaveBeenCalled();
  });

  it("single tool_calls: Stage A picks write → Stage B extracts args → dispatcher runs tool → success reply", async () => {
    mockPiAi([
      '{"intent":"tool_calls","tool_names":["write"],"sequencing":"sequential"}',
      '{"path":"/notes/x.md","content":"тест"}',
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const runTool = vi.fn(async () => ({
      ok: true as const,
      output: { path: "/notes/x.md" },
    }));
    const result = await runOrchestratorTurn({
      userMessage: "напиши заметку 'тест' в /notes/x.md",
      chatKey: "chat-2",
      runTool,
      runConversationLLM: async () => "must not call",
    });
    expect(result.contract.intent).toBe("tool_calls");
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("Записал в /notes/x.md.");
    expect(result.dispatch.allOk).toBe(true);
  });

  it("multi-action sequential: Stage A picks 2 tools → Stage B extracts both → dispatcher runs both → multi success reply", async () => {
    mockPiAi([
      '{"intent":"tool_calls","tool_names":["write","sessions_send"],"sequencing":"sequential"}',
      '{"path":"/report.md","content":"hi"}',
      '{"channel":"boss","text":"check report"}',
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const calls: string[] = [];
    const runTool = vi.fn(async (a) => {
      calls.push(a.tool);
      return { ok: true as const, output: { ...a.args } };
    });
    const result = await runOrchestratorTurn({
      userMessage: "создай /report.md и отправь его в boss",
      chatKey: "chat-3",
      runTool,
      runConversationLLM: async () => "must not call",
    });
    expect(calls).toEqual(["write", "sessions_send"]);
    expect(result.reply).toMatch(/^Готово:\n\n1\. .* \/report\.md\.\n2\. Отправил в boss\.$/);
    expect(result.dispatch.allOk).toBe(true);
  });

  it("Stage-B failure on sequential turn collapses to refuse", async () => {
    mockPiAi([
      '{"intent":"tool_calls","tool_names":["write"],"sequencing":"sequential"}',
      "complete garbage non-json",
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const runTool = vi.fn(async () => ({ ok: true as const, output: {} }));
    const result = await runOrchestratorTurn({
      userMessage: "сохрани что-то",
      chatKey: "chat-4",
      runTool,
      runConversationLLM: async () => "must not call",
    });
    expect(result.contract.intent).toBe("refuse");
    expect(result.reply).toMatch(/Не могу:.*write \(non_json/);
    expect(runTool).not.toHaveBeenCalled();
  });

  it("Stage-A refuse passes through to refuse template", async () => {
    mockPiAi(['{"intent":"refuse","refusal_reason":"нет конкретного объекта"}']);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const runTool = vi.fn();
    const runConv = vi.fn();
    const result = await runOrchestratorTurn({
      userMessage: "сохрани это",
      chatKey: "chat-5",
      runTool,
      runConversationLLM: runConv,
    });
    expect(result.reply).toBe("Не могу: нет конкретного объекта");
    expect(runTool).not.toHaveBeenCalled();
    expect(runConv).not.toHaveBeenCalled();
  });

  it("per-chat lock serializes same-chat turns", async () => {
    mockPiAi([
      '{"intent":"conversation"}',
      '{"intent":"conversation"}',
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const order: string[] = [];
    const runConv = vi.fn(async (msg: string) => {
      order.push(`start:${msg}`);
      await new Promise((r) => setTimeout(r, 30));
      order.push(`end:${msg}`);
      return `done:${msg}`;
    });
    const t1 = runOrchestratorTurn({
      userMessage: "msg1",
      chatKey: "same-chat",
      runTool: async () => {
        throw new Error("nope");
      },
      runConversationLLM: runConv,
    });
    const t2 = runOrchestratorTurn({
      userMessage: "msg2",
      chatKey: "same-chat",
      runTool: async () => {
        throw new Error("nope");
      },
      runConversationLLM: runConv,
    });
    await Promise.all([t1, t2]);
    expect(order).toEqual([
      "start:msg1",
      "end:msg1",
      "start:msg2",
      "end:msg2",
    ]);
  });
});
