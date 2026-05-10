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

/**
 * Spy receptacle for `resolveModelAsync` calls. Reset per test by
 * `mockPiAi`. Used by the regression test that the orchestrator forwards
 * cfg+agentDir down to model resolution (the S9 live-verify bug:
 * "классификатор не загружен" was fired because cfg/agentDir defaulted
 * to a global config without the hydra provider entries).
 */
const RESOLVE_MODEL_CALLS: Array<{
  provider: string;
  modelId: string;
  agentDir: string | undefined;
  cfg: unknown;
}> = [];

/** Mock the pi-ai layer to script Stage-A/Stage-B responses in order. */
function mockPiAi(scriptedResponses: string[]): void {
  let i = 0;
  RESOLVE_MODEL_CALLS.length = 0;
  vi.doMock("../../agents/pi-embedded-runner/model.js", () => ({
    resolveModelAsync: async (
      provider: string,
      modelId: string,
      agentDir: string | undefined,
      cfg: unknown,
    ) => {
      RESOLVE_MODEL_CALLS.push({ provider, modelId, agentDir, cfg });
      return {
        model: { id: "fake", api: "openai-completions", baseUrl: "" } as never,
        modelRegistry: {},
        authStorage: {},
      };
    },
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

  it("Stage-B missing_field renders human-readable Russian label, not the raw field name (live 18:09 symptom)", async () => {
    // Real Telegram turn 2026-05-09 18:09 (Vladimir): Stage A picked
    // [web_search, write, write] greedily on a meta-question that asked
    // about collaboration; Stage B emitted missing_field for query / path
    // / path; the orchestrator surfaced
    //   "Не могу: ... web_search (missing_field: query); write (missing_field: path); ..."
    // which the operator labelled "техническая каракуля". The fix is
    // a static (tool, field) → Russian-label table, applied in
    // buildContractFromRouting. This test reproduces the symptom and
    // pins the new format.
    mockPiAi([
      '{"intent":"tool_calls","tool_names":["write"],"sequencing":"sequential"}',
      '{"_error":"missing","_field":"path"}',
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const runTool = vi.fn(async () => ({ ok: true as const, output: {} }));
    const result = await runOrchestratorTurn({
      userMessage: "сохрани заметку",
      chatKey: "chat-rb-1",
      runTool,
      runConversationLLM: async () => "must not call",
    });
    expect(result.contract.intent).toBe("refuse");
    // human-readable label appears
    expect(result.reply).toContain("путь к файлу");
    // tool name still surfaces (so user can connect what was asked)
    expect(result.reply).toContain("write");
    // raw "missing_field: path" must NOT leak through
    expect(result.reply).not.toContain("missing_field");
    expect(runTool).not.toHaveBeenCalled();
  });

  it("Stage-B missing_field on multiple tools lists each humanly (parallel turn, all fail)", async () => {
    // Live 18:09 turn ran web_search + 2x write; reproduce a similar
    // multi-failure on PARALLEL sequencing so all failures surface.
    // (Sequential first-failure-wins is also covered above; parallel
    // ensures the renderer iterates every failed tool, not just one.)
    mockPiAi([
      '{"intent":"tool_calls","tool_names":["web_search","write"],"sequencing":"parallel"}',
      '{"_error":"missing","_field":"query"}',
      '{"_error":"missing","_field":"path"}',
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const runTool = vi.fn();
    const result = await runOrchestratorTurn({
      userMessage: "поищи и сохрани",
      chatKey: "chat-rb-2",
      runTool,
      runConversationLLM: async () => "must not call",
    });
    expect(result.contract.intent).toBe("refuse");
    expect(result.reply).toContain("запрос для поиска");
    expect(result.reply).toContain("путь к файлу");
    expect(result.reply).not.toContain("missing_field");
    expect(runTool).not.toHaveBeenCalled();
  });

  it("Stage-B mixed failures: missing_field renders humanly, non_json keeps raw kind:detail", async () => {
    // Two-tool sequential turn; first tool fails missing_field (user-
    // actionable), second fails non_json (LLM infra failure, not user-
    // fixable). The renderer must humanise the first and keep the raw
    // tag for the second so logs / triage still see the LLM glitch.
    mockPiAi([
      '{"intent":"tool_calls","tool_names":["write","sessions_send"],"sequencing":"sequential"}',
      '{"_error":"missing","_field":"path"}',
      "totally not json",
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const runTool = vi.fn();
    const result = await runOrchestratorTurn({
      userMessage: "сохрани и отправь",
      chatKey: "chat-rb-3",
      runTool,
      runConversationLLM: async () => "must not call",
    });
    expect(result.contract.intent).toBe("refuse");
    // human-readable for missing_field
    expect(result.reply).toContain("путь к файлу");
    expect(result.reply).toContain("write");
    // raw kind preserved for infra failures
    expect(result.reply).toMatch(/sessions_send \(non_json/);
    // missing_field literal must not leak
    expect(result.reply).not.toContain("missing_field");
    expect(runTool).not.toHaveBeenCalled();
  });

  it("Stage-B missing_field with unmapped field name falls back to a safe label, not crash", async () => {
    // Defensive: if a future tool schema gains a new required field
    // before TOOL_FIELD_LABELS is updated, the renderer must fall back
    // to a generic "поле <field>" label rather than throwing or showing
    // 'undefined'. We simulate this by having Stage B emit a field name
    // ("nonexistent_field") that isn't in any TOOL_FIELD_LABELS entry.
    mockPiAi([
      '{"intent":"tool_calls","tool_names":["write"],"sequencing":"sequential"}',
      '{"_error":"missing","_field":"nonexistent_field"}',
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const runTool = vi.fn();
    const result = await runOrchestratorTurn({
      userMessage: "что-то непонятное",
      chatKey: "chat-rb-4",
      runTool,
      runConversationLLM: async () => "must not call",
    });
    expect(result.contract.intent).toBe("refuse");
    // graceful fallback — no crash, no 'undefined', no leak of raw tag
    expect(result.reply).toContain('поле "nonexistent_field"');
    expect(result.reply).not.toContain("undefined");
    expect(result.reply).not.toContain("missing_field");
  });

  it("threads inputs.cfg and inputs.agentDir down to resolveModelAsync (S9 live-verify regression)", async () => {
    // Real symptom: in live Telegram, Stage A failed with "классификатор
    // не загружен" because the orchestrator entry never forwarded cfg /
    // agentDir to classifyTurn → resolveModelAsync, so the model lookup
    // fell back to a globally-loaded config without the hydra provider.
    // This test fires Stage A AND Stage B (tool_calls path) so both
    // classifier callsites are exercised — if either is silently
    // dropping cfg/agentDir, the assertion fails.
    mockPiAi([
      '{"intent":"tool_calls","tool_names":["write"],"sequencing":"sequential"}',
      '{"path":"/x","content":"y"}',
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const fakeCfg = { agents: { default: {} } } as never;
    const fakeAgentDir = "/fake/agent/dir";
    await runOrchestratorTurn({
      userMessage: "сохрани y в /x",
      chatKey: "chat-deps",
      runTool: async () => ({ ok: true as const, output: { path: "/x" } }),
      runConversationLLM: async () => "must not call",
      cfg: fakeCfg,
      agentDir: fakeAgentDir,
    });
    expect(RESOLVE_MODEL_CALLS.length).toBeGreaterThanOrEqual(2);
    for (const call of RESOLVE_MODEL_CALLS) {
      expect(call.agentDir).toBe(fakeAgentDir);
      expect(call.cfg).toBe(fakeCfg);
    }
  });
});

/**
 * Attachment plumbing — `runOrchestratorTurn({ attachments })` must reach
 * Stage A. Symptom this catches: 2026-05-10 12:52 turn (user attached two
 * .docx templates, Stage A never saw them, picked image_generate / pdf
 * from scratch). The wiring is "channel → orchestrator → classifyTurn →
 * Stage A prompt"; this test pins the contract at the LLM transport so a
 * future refactor that drops the parameter on any hop fails loudly.
 */
describe("V1-CONTRACT-ONLY orchestrator — attachment plumbing", () => {
  it("attachments propagate from runOrchestratorTurn to the Stage-A LLM prompt", async () => {
    let capturedPrompt = "";
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
      completeSimple: async (
        _model: unknown,
        req: { messages: Array<{ content: string }> },
      ) => {
        capturedPrompt = req.messages[0]!.content;
        return {
          content: [{ type: "text", text: '{"intent":"conversation"}' }],
        };
      },
    }));
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    await runOrchestratorTurn({
      userMessage: "вот шаблон, заполни его",
      chatKey: "chat-att-1",
      runTool: async () => ({ ok: true as const, output: {} }),
      runConversationLLM: async () => "ok",
      attachments: [
        {
          kind: "document",
          filename: "Шаблон.docx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      ],
    });
    expect(capturedPrompt).toContain("Пользователь приложил");
    expect(capturedPrompt).toContain("Шаблон.docx");
  });

  it("no attachments → Stage-A prompt has no attachment block (bench-equivalence)", async () => {
    let capturedPrompt = "";
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
      completeSimple: async (
        _model: unknown,
        req: { messages: Array<{ content: string }> },
      ) => {
        capturedPrompt = req.messages[0]!.content;
        return {
          content: [{ type: "text", text: '{"intent":"conversation"}' }],
        };
      },
    }));
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    await runOrchestratorTurn({
      userMessage: "привет",
      chatKey: "chat-att-2",
      runTool: async () => ({ ok: true as const, output: {} }),
      runConversationLLM: async () => "ok",
      // no attachments field
    });
    expect(capturedPrompt).not.toContain("Пользователь приложил");
  });

  it("empty attachments array is treated identically to no attachments", async () => {
    let capturedPrompt = "";
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
      completeSimple: async (
        _model: unknown,
        req: { messages: Array<{ content: string }> },
      ) => {
        capturedPrompt = req.messages[0]!.content;
        return {
          content: [{ type: "text", text: '{"intent":"conversation"}' }],
        };
      },
    }));
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    await runOrchestratorTurn({
      userMessage: "привет",
      chatKey: "chat-att-3",
      runTool: async () => ({ ok: true as const, output: {} }),
      runConversationLLM: async () => "ok",
      attachments: [],
    });
    expect(capturedPrompt).not.toContain("Пользователь приложил");
  });
});
