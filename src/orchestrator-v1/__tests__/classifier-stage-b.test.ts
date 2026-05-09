/**
 * V1-CONTRACT-ONLY — Stage-B unit tests.
 *
 * Drive the per-tool arg extraction's parse/validate/fallback paths via
 * mocked pi-ai transport. Tests cover:
 *   - clean tool args → returned action
 *   - LLM-declared missing-field sentinel → error.kind=missing_field
 *   - malformed JSON → error.kind=non_json
 *   - schema-invalid args → error.kind=wrong_shape
 *   - URL validator (web_fetch) → wrong_shape
 *   - prompt builder includes per-tool description
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { TOOL_ARG_SCHEMAS } from "../tool-arg-schemas.js";
import { buildStageBPrompt } from "../classifier-stage-b.js";

describe("V1-CONTRACT-ONLY Stage-B — prompt builder", () => {
  it("includes the tool name in the prompt", () => {
    expect(buildStageBPrompt("write")).toContain("Инструмент: write");
    expect(buildStageBPrompt("image_generate")).toContain("Инструмент: image_generate");
  });

  it("contains the missing-field sentinel instruction", () => {
    const prompt = buildStageBPrompt("write");
    expect(prompt).toMatch(/_error.*missing.*_field/s);
  });

  it("forbids markdown wrapper", () => {
    expect(buildStageBPrompt("write")).toMatch(/Без markdown/);
  });
});

describe("V1-CONTRACT-ONLY Stage-B — tool arg schemas", () => {
  it("write requires path + content", () => {
    expect(TOOL_ARG_SCHEMAS.write.safeParse({ path: "/a.md", content: "x" }).success).toBe(true);
    expect(TOOL_ARG_SCHEMAS.write.safeParse({ path: "/a.md" }).success).toBe(false);
    expect(TOOL_ARG_SCHEMAS.write.safeParse({ content: "x" }).success).toBe(false);
    expect(TOOL_ARG_SCHEMAS.write.safeParse({ path: "", content: "x" }).success).toBe(false);
  });

  it("web_fetch requires a valid URL", () => {
    expect(TOOL_ARG_SCHEMAS.web_fetch.safeParse({ url: "https://x.test" }).success).toBe(true);
    expect(TOOL_ARG_SCHEMAS.web_fetch.safeParse({ url: "not-a-url" }).success).toBe(false);
  });

  it("persistent_worker_push requires worker_name + schedule + message_template", () => {
    const ok = TOOL_ARG_SCHEMAS.persistent_worker_push.safeParse({
      worker_name: "w1",
      schedule: "every 2 minutes",
      message_template: "tick",
    });
    expect(ok.success).toBe(true);
    const missing = TOOL_ARG_SCHEMAS.persistent_worker_push.safeParse({
      worker_name: "w1",
      schedule: "*/2 * * * *",
    });
    expect(missing.success).toBe(false);
  });

  it("image_generate requires prompt only; size/style optional", () => {
    expect(TOOL_ARG_SCHEMAS.image_generate.safeParse({ prompt: "red cat" }).success).toBe(true);
    expect(
      TOOL_ARG_SCHEMAS.image_generate.safeParse({
        prompt: "red cat",
        size: "1024x1024",
        style: "vivid",
      }).success,
    ).toBe(true);
    expect(TOOL_ARG_SCHEMAS.image_generate.safeParse({}).success).toBe(false);
  });
});

describe("V1-CONTRACT-ONLY Stage-B — wrapper fallback paths (mocked transport)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockTransportReturning(text: string): void {
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
        content: [{ type: "text", text }],
      }),
    }));
  }

  it("returns a TurnAction on a clean write extraction", async () => {
    mockTransportReturning('{"path":"/notes/memory.md","content":"тест прошёл"}');
    const { extractToolArgs } = await import("../classifier-stage-b.js");
    const result = await extractToolArgs("write", "напиши заметку 'тест прошёл' в файл /notes/memory.md");
    expect(result.error).toBeUndefined();
    expect(result.action?.tool).toBe("write");
    expect(result.action?.args).toEqual({ path: "/notes/memory.md", content: "тест прошёл" });
  });

  it("returns error.kind=missing_field on the model's _error sentinel", async () => {
    mockTransportReturning('{"_error":"missing","_field":"path"}');
    const { extractToolArgs } = await import("../classifier-stage-b.js");
    const result = await extractToolArgs("write", "напиши что-нибудь");
    expect(result.action).toBeUndefined();
    expect(result.error?.kind).toBe("missing_field");
    expect(result.error?.detail).toBe("path");
  });

  it("returns error.kind=non_json on garbage", async () => {
    mockTransportReturning("я думаю что вам надо это, наверное");
    const { extractToolArgs } = await import("../classifier-stage-b.js");
    const result = await extractToolArgs("write", "напиши заметку");
    expect(result.action).toBeUndefined();
    expect(result.error?.kind).toBe("non_json");
  });

  it("returns error.kind=wrong_shape on schema-invalid args (missing required)", async () => {
    mockTransportReturning('{"path":"/a.md"}');
    const { extractToolArgs } = await import("../classifier-stage-b.js");
    const result = await extractToolArgs("write", "напиши /a.md");
    expect(result.action).toBeUndefined();
    expect(result.error?.kind).toBe("wrong_shape");
  });

  it("returns error.kind=wrong_shape on invalid URL for web_fetch", async () => {
    mockTransportReturning('{"url":"not-a-url"}');
    const { extractToolArgs } = await import("../classifier-stage-b.js");
    const result = await extractToolArgs("web_fetch", "скачай эту страницу");
    expect(result.action).toBeUndefined();
    expect(result.error?.kind).toBe("wrong_shape");
  });

  it("returns error.kind=model_unresolved when resolver returns no model", async () => {
    vi.doMock("../../agents/pi-embedded-runner/model.js", () => ({
      resolveModelAsync: async () => ({
        model: undefined,
        error: "Unknown model: fake/missing",
        modelRegistry: {},
        authStorage: {},
      }),
    }));
    vi.doMock("../../config/config.js", () => ({ loadConfig: () => ({}) }));
    const { extractToolArgs } = await import("../classifier-stage-b.js");
    const result = await extractToolArgs("write", "напиши /a.md", {
      model: { provider: "fake", modelId: "missing" },
    });
    expect(result.action).toBeUndefined();
    expect(result.error?.kind).toBe("model_unresolved");
  });

  it("strips ```json``` code-fence wrapper", async () => {
    mockTransportReturning('```json\n{"path":"/a.md","content":"hi"}\n```');
    const { extractToolArgs } = await import("../classifier-stage-b.js");
    const result = await extractToolArgs("write", "напиши /a.md");
    expect(result.action?.tool).toBe("write");
    expect(result.action?.args.path).toBe("/a.md");
  });
});
