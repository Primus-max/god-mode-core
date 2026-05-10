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

/**
 * Stage-A model selection by turn complexity.
 *
 * Real symptom (canonical): 2026-05-10 13:22 Telegram turn — user
 * attached two .docx templates and asked the bot to find a WWII soldier
 * story, fill the template, attach a photo. Stage A on `gpt-5-mini`
 * picked `[read, image_generate, pdf]` (wrong: should be
 * `[read, web_search, write]`). Operator: "что мне здесь опять
 * уточнять, что не надо генерировать?"
 *
 * The bench winner `gpt-5-mini` scores 100/100 on 58 single-tool
 * fixtures (median ~80 chars, no attachments, single intent) but hits
 * its ceiling on composite multi-tool + attachment turns. The fix:
 * upgrade Stage A model FOR COMPLEX TURNS ONLY (multi-turn / has
 * attachments / message > 200 chars). Simple turns continue on
 * `gpt-5-mini` so the 58-fixture bench stays 100/100.
 *
 * These tests pin the heuristic at the model-resolution boundary so any
 * future refactor that drops the per-turn selection (or accidentally
 * routes simple turns to BIG, breaking the bench) fails loudly.
 */
describe("V1-CONTRACT-ONLY orchestrator — Stage-A model selection by complexity", () => {
  it("simple turn (short text, no attachments, no pending) → uses gpt-5-mini", async () => {
    mockPiAi(['{"intent":"conversation"}']);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    await runOrchestratorTurn({
      userMessage: "привет",
      chatKey: "chat-mini-1",
      runTool: async () => ({ ok: true as const, output: {} }),
      runConversationLLM: async () => "ok",
    });
    expect(RESOLVE_MODEL_CALLS.length).toBeGreaterThanOrEqual(1);
    expect(RESOLVE_MODEL_CALLS[0]?.modelId).toBe("gpt-5-mini");
    expect(RESOLVE_MODEL_CALLS[0]?.provider).toBe("hydra");
  });

  it("long text (>200 chars) → uses BIG model (gpt-5.4)", async () => {
    mockPiAi(['{"intent":"conversation"}']);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    // 300+ chars — emulates the kind of multi-paragraph composite ask
    // that flooded gpt-5-mini on 13:22.
    const longMsg =
      "Пожалуйста найди мне в интернете историю одного советского " +
      "солдата времён Великой Отечественной войны (можно с конкретной " +
      "фамилией если найдёшь), потом заполни прикрепленный шаблон в " +
      ".docx формате его данными, и в конце приложи его фотографию " +
      "в высоком разрешении. Спасибо большое!";
    expect(longMsg.length).toBeGreaterThan(200);
    await runOrchestratorTurn({
      userMessage: longMsg,
      chatKey: "chat-big-1",
      runTool: async () => ({ ok: true as const, output: {} }),
      runConversationLLM: async () => "ok",
    });
    expect(RESOLVE_MODEL_CALLS.length).toBeGreaterThanOrEqual(1);
    expect(RESOLVE_MODEL_CALLS[0]?.modelId).toBe("gpt-5.4");
    expect(RESOLVE_MODEL_CALLS[0]?.provider).toBe("hydra");
  });

  it("attachments present → uses BIG model even on short text (real 13:22 symptom)", async () => {
    mockPiAi(['{"intent":"conversation"}']);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    await runOrchestratorTurn({
      userMessage: "заполни шаблон",
      chatKey: "chat-big-2",
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
    expect(RESOLVE_MODEL_CALLS.length).toBeGreaterThanOrEqual(1);
    expect(RESOLVE_MODEL_CALLS[0]?.modelId).toBe("gpt-5.4");
  });

  it("pending plan present → BIG model used for BOTH plan-context Stage A and Stage B re-extraction", async () => {
    // Turn 1: vanilla Stage A picks write, Stage B fails missing_field
    // → plan stashed. Turn 2: plan-context kicks in, then add_args
    // re-runs Stage B with prior argsSoFar. Both calls on turn 2 must
    // hit BIG model since `existingPending` makes the turn complex.
    mockPiAi([
      // Turn 1 — Stage A + Stage B (missing path)
      '{"intent":"tool_calls","tool_names":["write"],"sequencing":"sequential"}',
      '{"_error":"missing","_field":"path"}',
      // Turn 2 — plan-context Stage A + Stage B
      '{"kind":"add_args"}',
      '{"path":"/work/x.md","content":"hi"}',
    ]);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    const { createInMemoryTurnStateStore } = await import(
      "../turn-state/index.js"
    );
    const store = createInMemoryTurnStateStore();
    const runTool = vi.fn(async () => ({ ok: true as const, output: {} }));
    await runOrchestratorTurn({
      userMessage: "сохрани",
      chatKey: "chat-big-3",
      runTool,
      runConversationLLM: async () => "ok",
      turnState: store,
    });
    // Reset before turn 2 so we observe ONLY turn-2 model calls.
    RESOLVE_MODEL_CALLS.length = 0;
    await runOrchestratorTurn({
      userMessage: "/work/x.md",
      chatKey: "chat-big-3",
      runTool,
      runConversationLLM: async () => "ok",
      turnState: store,
    });
    // Turn 2 makes 2 LLM calls: plan-context Stage A + Stage B per tool.
    // BOTH must use BIG.
    expect(RESOLVE_MODEL_CALLS.length).toBeGreaterThanOrEqual(2);
    for (const call of RESOLVE_MODEL_CALLS) {
      expect(call.modelId).toBe("gpt-5.4");
    }
  });

  it("OPENCLAW_V1_BIG_MODEL env override changes which BIG model fires on complex turns", async () => {
    const prev = process.env.OPENCLAW_V1_BIG_MODEL;
    process.env.OPENCLAW_V1_BIG_MODEL = "claude-haiku-4-5";
    try {
      mockPiAi(['{"intent":"conversation"}']);
      const { runOrchestratorTurn } = await import("../orchestrator.js");
      await runOrchestratorTurn({
        userMessage: "заполни шаблон",
        chatKey: "chat-big-env-1",
        runTool: async () => ({ ok: true as const, output: {} }),
        runConversationLLM: async () => "ok",
        attachments: [
          { kind: "document", filename: "x.docx" },
        ],
      });
      expect(RESOLVE_MODEL_CALLS[0]?.modelId).toBe("claude-haiku-4-5");
    } finally {
      if (prev === undefined) {
        delete process.env.OPENCLAW_V1_BIG_MODEL;
      } else {
        process.env.OPENCLAW_V1_BIG_MODEL = prev;
      }
    }
  });

  it("explicit inputs.classifierModel override beats both heuristic and env", async () => {
    const prev = process.env.OPENCLAW_V1_BIG_MODEL;
    process.env.OPENCLAW_V1_BIG_MODEL = "gpt-5.4";
    try {
      mockPiAi(['{"intent":"conversation"}']);
      const { runOrchestratorTurn } = await import("../orchestrator.js");
      await runOrchestratorTurn({
        // complex (long + attachments) — heuristic would pick BIG
        userMessage: "x".repeat(300),
        chatKey: "chat-override-1",
        runTool: async () => ({ ok: true as const, output: {} }),
        runConversationLLM: async () => "ok",
        attachments: [{ kind: "document", filename: "y.docx" }],
        classifierModel: { provider: "hydra", modelId: "grok-3-mini" },
      });
      expect(RESOLVE_MODEL_CALLS[0]?.modelId).toBe("grok-3-mini");
    } finally {
      if (prev === undefined) {
        delete process.env.OPENCLAW_V1_BIG_MODEL;
      } else {
        process.env.OPENCLAW_V1_BIG_MODEL = prev;
      }
    }
  });

  it("isComplexTurn unit: pending + attachments + long-text are all true; short-text-no-attachments-no-pending is false", async () => {
    const { isComplexTurn } = await import("../orchestrator.js");
    expect(isComplexTurn({ userMessage: "привет" }, false)).toBe(false);
    expect(isComplexTurn({ userMessage: "привет" }, true)).toBe(true);
    expect(
      isComplexTurn(
        { userMessage: "x", attachments: [{ kind: "document" }] },
        false,
      ),
    ).toBe(true);
    expect(isComplexTurn({ userMessage: "x".repeat(201) }, false)).toBe(true);
    expect(isComplexTurn({ userMessage: "x".repeat(200) }, false)).toBe(false);
    expect(
      isComplexTurn({ userMessage: "x", attachments: [] }, false),
    ).toBe(false);
  });

  it("bench preservation: vanilla classifyTurn called WITHOUT explicit model still hits gpt-5-mini (bench fixture invariant)", async () => {
    // The bench harness imports buildStageAPrompt + calls Stage A on
    // canonical fixtures with no orchestrator wrapper, so it never goes
    // through `isComplexTurn`. But operator wiring of the orchestrator
    // for a SHORT, NO-ATTACHMENT, NO-PENDING fixture (the median bench
    // case) MUST still resolve gpt-5-mini, else 58-fixture accuracy
    // drops silently. We pin that here as a regression guard.
    mockPiAi(['{"intent":"tool_calls","tool_names":["write"],"sequencing":"sequential"}', '{"path":"/x","content":"y"}']);
    const { runOrchestratorTurn } = await import("../orchestrator.js");
    await runOrchestratorTurn({
      userMessage: "напиши y в /x",
      chatKey: "chat-bench-equiv",
      runTool: async () => ({ ok: true as const, output: { path: "/x" } }),
      runConversationLLM: async () => "ok",
    });
    // Stage A + Stage B both fire — both should hit gpt-5-mini.
    expect(RESOLVE_MODEL_CALLS.length).toBeGreaterThanOrEqual(2);
    for (const call of RESOLVE_MODEL_CALLS) {
      expect(call.modelId).toBe("gpt-5-mini");
    }
  });
});
