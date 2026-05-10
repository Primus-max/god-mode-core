/**
 * V1-CONTRACT-ONLY — Stage-A wrapper unit tests.
 *
 * These tests do NOT call live LLMs (that's the bench's job). They drive
 * the parse/validate/fallback paths of `classifyTurn` by stubbing the
 * pi-ai `completeSimple` and `resolveModelAsync` boundary, so the unit
 * tests catch regressions in shape-validation and failure-mode mapping.
 *
 * Per AGENTS.md "Tests must catch real bugs": stubs sit at the LLM
 * transport boundary (the same boundary `auto-topic-label.ts` uses),
 * not on `classifyTurn` itself. Each test feeds a representative raw
 * LLM response and asserts the parsed routing + fallbackReason.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { StageARoutingSchema } from "../contract.js";
import { buildStageAPrompt } from "../classifier-stage-a.js";
import type { InboundAttachment } from "../inbound-attachment.js";

describe("V1-CONTRACT-ONLY Stage-A — prompt builder", () => {
  it("includes every TOOL_NAME with a 1-line description", () => {
    const prompt = buildStageAPrompt();
    // tools the dispatcher knows about must all appear in the menu
    for (const tool of [
      "write",
      "edit",
      "read",
      "image_generate",
      "web_search",
      "web_fetch",
      "sessions_send",
      "persistent_worker_push",
      "cron",
      "exec",
    ]) {
      expect(prompt).toContain(`- ${tool}: `);
    }
  });

  it("forbids markdown / code-fence preamble in the output instructions", () => {
    const prompt = buildStageAPrompt();
    expect(prompt).toMatch(/ОТВЕЧАЙ ТОЛЬКО JSON/);
    expect(prompt).toMatch(/Без markdown/);
  });

  it("explicitly handles ambiguous-deixis case (refuse, not guess)", () => {
    const prompt = buildStageAPrompt();
    expect(prompt).toMatch(/сделай это.*БЕЗ конкретного объекта/s);
  });
});

describe("V1-CONTRACT-ONLY Stage-A — schema validation", () => {
  it("accepts a tool_calls routing with sequential default", () => {
    const r = StageARoutingSchema.safeParse({
      intent: "tool_calls",
      tool_names: ["write"],
      sequencing: "sequential",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a tool_calls routing without sequencing (default applied)", () => {
    const r = StageARoutingSchema.safeParse({
      intent: "tool_calls",
      tool_names: ["write", "sessions_send"],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.intent).toBe("tool_calls");
      if (r.data.intent === "tool_calls") {
        expect(r.data.sequencing).toBe("sequential");
      }
    }
  });

  it("accepts a parallel sequencing", () => {
    const r = StageARoutingSchema.safeParse({
      intent: "tool_calls",
      tool_names: ["read", "web_search"],
      sequencing: "parallel",
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown tool name", () => {
    const r = StageARoutingSchema.safeParse({
      intent: "tool_calls",
      tool_names: ["bogus_tool"],
    });
    expect(r.success).toBe(false);
  });

  it("rejects empty tool_calls array", () => {
    const r = StageARoutingSchema.safeParse({
      intent: "tool_calls",
      tool_names: [],
    });
    expect(r.success).toBe(false);
  });

  it("rejects invalid sequencing enum", () => {
    const r = StageARoutingSchema.safeParse({
      intent: "tool_calls",
      tool_names: ["write"],
      sequencing: "lol",
    });
    expect(r.success).toBe(false);
  });

  it("accepts a conversation routing with no extra fields", () => {
    const r = StageARoutingSchema.safeParse({ intent: "conversation" });
    expect(r.success).toBe(true);
  });

  it("accepts a refuse routing with reason", () => {
    const r = StageARoutingSchema.safeParse({
      intent: "refuse",
      refusal_reason: "не понял",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a refuse routing with empty reason", () => {
    const r = StageARoutingSchema.safeParse({
      intent: "refuse",
      refusal_reason: "",
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown intent value", () => {
    const r = StageARoutingSchema.safeParse({ intent: "execute" });
    expect(r.success).toBe(false);
  });
});

describe("V1-CONTRACT-ONLY Stage-A — wrapper fallback paths (mocked transport)", () => {
  // We mock at the pi-ai module boundary — same boundary auto-topic-label uses.
  // The classifyTurn function's deps (cfg + agentDir) are passed through to
  // resolveModelAsync, so we stub resolveModelAsync to return a fake Model and
  // completeSimple to return our test payload.

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to refuse with fallbackReason=non_json on malformed JSON", async () => {
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
    vi.doMock("../../config/config.js", () => ({
      loadConfig: () => ({}),
    }));
    vi.doMock("@mariozechner/pi-ai", () => ({
      completeSimple: async () => ({
        content: [{ type: "text", text: "this is not JSON at all" }],
      }),
    }));

    const { classifyTurn } = await import("../classifier-stage-a.js");
    const result = await classifyTurn("привет");
    expect(result.routing.intent).toBe("refuse");
    expect(result.fallbackReason).toBe("non_json");
  });

  it("falls back to refuse with fallbackReason=model_unresolved when resolver returns no model", async () => {
    vi.doMock("../../agents/pi-embedded-runner/model.js", () => ({
      resolveModelAsync: async () => ({
        model: undefined,
        error: "Unknown model: fake/missing",
        modelRegistry: {},
        authStorage: {},
      }),
    }));
    vi.doMock("../../config/config.js", () => ({
      loadConfig: () => ({}),
    }));

    const { classifyTurn } = await import("../classifier-stage-a.js");
    const result = await classifyTurn("привет", {
      model: { provider: "fake", modelId: "missing" },
    });
    expect(result.routing.intent).toBe("refuse");
    expect(result.fallbackReason).toBe("model_unresolved");
  });

  it("returns valid routing on a clean tool_calls JSON response", async () => {
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
    vi.doMock("../../config/config.js", () => ({
      loadConfig: () => ({}),
    }));
    vi.doMock("@mariozechner/pi-ai", () => ({
      completeSimple: async () => ({
        content: [
          {
            type: "text",
            text: '{"intent":"tool_calls","tool_names":["write"],"sequencing":"sequential"}',
          },
        ],
      }),
    }));

    const { classifyTurn } = await import("../classifier-stage-a.js");
    const result = await classifyTurn("напиши заметку");
    expect(result.routing.intent).toBe("tool_calls");
    if (result.routing.intent === "tool_calls") {
      expect(result.routing.tool_names).toEqual(["write"]);
    }
    expect(result.fallbackReason).toBeUndefined();
  });

  it("strips ```json``` code-fence wrapper from the LLM response", async () => {
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
    vi.doMock("../../config/config.js", () => ({
      loadConfig: () => ({}),
    }));
    vi.doMock("@mariozechner/pi-ai", () => ({
      completeSimple: async () => ({
        content: [
          {
            type: "text",
            text: '```json\n{"intent":"conversation"}\n```',
          },
        ],
      }),
    }));

    const { classifyTurn } = await import("../classifier-stage-a.js");
    const result = await classifyTurn("привет");
    expect(result.routing.intent).toBe("conversation");
    expect(result.fallbackReason).toBeUndefined();
  });
});

/**
 * Inbound attachment awareness — Stage-A prompt extension.
 *
 * Canonical symptom (real Telegram turn 2026-05-10 12:52): user wrote a
 * long task description AND attached two .docx templates. Orchestrator-v1
 * forwarded ONLY the text; Stage A picked image_generate / pdf as if
 * creating files from scratch instead of routing toward "use the attached
 * docs as templates". User reaction at 13:00: "Я дал приложил шаблоны
 * word, а не pdf!!!".
 *
 * Tests below lock in two contracts:
 *
 *   1. With NO attachments the prompt is BYTE-IDENTICAL to today (so the
 *      live bench's 100/100 on 58 fixtures is preserved).
 *   2. With attachments an extra block appears AT THE END of the prompt
 *      (so the bench-tuned core stays untouched), naming each attachment
 *      and steering away from file-generator tools.
 *   3. The plumbing is honoured end-to-end: `classifyTurn(attachments)`
 *      forwards them into `buildStageAPrompt(attachments)`, which the
 *      LLM transport sees verbatim.
 */
describe("V1-CONTRACT-ONLY Stage-A — attachment awareness", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("with NO attachments → prompt is byte-identical to default (preserves bench accuracy)", () => {
    // Paranoid byte-equality check: both empty array and undefined must
    // round-trip to the same string the bench was tuned against.
    const baseline = buildStageAPrompt();
    const withEmptyArray = buildStageAPrompt([]);
    expect(withEmptyArray).toBe(baseline);
  });

  it("with one .docx document → prompt includes the attachment block AT THE END", () => {
    const attachments: InboundAttachment[] = [
      {
        kind: "document",
        filename: "Шаблон.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        telegramFileId: "tg-file-abc",
      },
    ];
    const prompt = buildStageAPrompt(attachments);
    // The block names the file with both name and mime so the classifier
    // can see "this is a Word doc, not a PDF" — the symptom of 12:52.
    expect(prompt).toContain('Шаблон.docx');
    expect(prompt).toContain(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    // Block is APPENDED — the bench-tuned ОТВЕЧАЙ ТОЛЬКО JSON line must
    // still come BEFORE the attachment block, with the user-message
    // marker at the very end.
    const jsonOnlyIdx = prompt.indexOf("ОТВЕЧАЙ ТОЛЬКО JSON");
    const attachmentIdx = prompt.indexOf("Пользователь приложил");
    const userMarkerIdx = prompt.indexOf("Сообщение пользователя:");
    expect(jsonOnlyIdx).toBeGreaterThan(0);
    expect(attachmentIdx).toBeGreaterThan(jsonOnlyIdx);
    expect(userMarkerIdx).toBeGreaterThan(attachmentIdx);
  });

  it("with attachment → prompt steers AWAY from file-generator tools (image_generate / pdf / write-from-scratch)", () => {
    const attachments: InboundAttachment[] = [
      { kind: "document", filename: "data.csv", mimeType: "text/csv" },
    ];
    const prompt = buildStageAPrompt(attachments);
    // Loose contract — the precise wording can evolve, but the prompt
    // MUST mention generator tools by name AND tell the classifier not
    // to pick them when files are already attached.
    expect(prompt).toMatch(/image_generate.*pdf.*write|write.*pdf.*image_generate/);
    expect(prompt).toMatch(/УЖЕ ПРИКРЕПЛЕНЫ|УЖЕ приложены|уже приложены|уже прикреплены/);
  });

  it("photo attachment without filename → block uses '(без имени)' label", () => {
    const attachments: InboundAttachment[] = [
      { kind: "photo", telegramFileId: "p1" },
    ];
    const prompt = buildStageAPrompt(attachments);
    expect(prompt).toContain("- photo (без имени)");
  });

  it("multiple attachments → all listed in the block, in submission order", () => {
    const attachments: InboundAttachment[] = [
      { kind: "document", filename: "Шаблон1.docx" },
      { kind: "document", filename: "Шаблон2.docx" },
      { kind: "photo", telegramFileId: "p1" },
    ];
    const prompt = buildStageAPrompt(attachments);
    const i1 = prompt.indexOf("Шаблон1.docx");
    const i2 = prompt.indexOf("Шаблон2.docx");
    const i3 = prompt.indexOf("- photo");
    expect(i1).toBeGreaterThan(0);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
  });

  it("classifyTurn forwards attachments into buildStageAPrompt (transport sees the block)", async () => {
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
    vi.doMock("../../config/config.js", () => ({
      loadConfig: () => ({}),
    }));
    vi.doMock("@mariozechner/pi-ai", () => ({
      completeSimple: async (
        _model: unknown,
        req: { messages: Array<{ content: string }> },
      ) => {
        capturedPrompt = req.messages[0]!.content;
        return {
          content: [{ type: "text", text: '{"intent":"refuse","refusal_reason":"уточни"}' }],
        };
      },
    }));

    const { classifyTurn } = await import("../classifier-stage-a.js");
    const attachments: InboundAttachment[] = [
      {
        kind: "document",
        filename: "Шаблон.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    ];
    await classifyTurn("вот шаблон, заполни его данными", { attachments });
    expect(capturedPrompt).toContain("Шаблон.docx");
    expect(capturedPrompt).toContain("Пользователь приложил");
    // Sanity: the user message itself must come AFTER the prompt block.
    expect(capturedPrompt.indexOf("Шаблон.docx")).toBeLessThan(
      capturedPrompt.indexOf("вот шаблон, заполни его данными"),
    );
  });

  it("classifyTurn with NO attachments → prompt sent to LLM lacks the attachment block (bench-equivalence guarantee)", async () => {
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
    vi.doMock("../../config/config.js", () => ({
      loadConfig: () => ({}),
    }));
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

    const { classifyTurn } = await import("../classifier-stage-a.js");
    await classifyTurn("привет");
    expect(capturedPrompt).not.toContain("Пользователь приложил");
    // The exact baseline prompt MUST be a prefix of what the LLM saw.
    expect(capturedPrompt.startsWith(buildStageAPrompt())).toBe(true);
  });
});
