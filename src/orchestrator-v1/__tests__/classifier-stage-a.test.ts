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
