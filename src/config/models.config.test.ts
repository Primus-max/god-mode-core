// V1-CLOSE T6 — schema + canonical-defaults tests for `config/models.default.json`
// and `src/agents/models-config.canonical-modalities.ts`.
//
// Per AGENTS.md "Tests must catch real bugs":
// - Schema rejection cases feed REAL malformed JSON literals into the Zod
//   schema. No `vi.spyOn` on the validator. The boundary tests assert that
//   the live validator fails, with field-level path info preserved.
// - Overlay precedence is exercised via the real `applyCanonicalModelDefaults`
//   on a real provider record — no mocking of the function under test.
// - Reproduce-first: the "no `input`" boundary is exactly the symptom the
//   slice fixes. The applier MUST fill it from the canonical default.
// - Guardrail: the embedded `CANONICAL_MODEL_DEFAULTS` constant must stay
//   byte-equivalent to `config/models.default.json`. If they drift, neither
//   side gets silently updated — the test fails and the implementer must
//   reconcile both deliberately (charter §3 "no defaulting unknown
//   modalities to permissive — reject unknown").

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { applyCanonicalModelDefaults } from "../agents/models-config.canonical-modalities.js";
import type { ProviderConfig } from "../agents/models-config.providers.js";
import {
  CANONICAL_MODEL_DEFAULTS,
  CanonicalModelDefaultsFileSchema,
  parseCanonicalModelDefaults,
} from "./models.config.schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MODELS_DEFAULT_JSON_PATH = path.join(REPO_ROOT, "config", "models.default.json");

type ProviderModel = NonNullable<ProviderConfig["models"]>[number];

/**
 * Test fixture helper: build a minimal `ProviderConfig` whose `models[]` are
 * intentionally typed loose to mirror the runtime data shapes the applier
 * sees in production (where pi-ai upstream / user-edited entries may omit
 * `reasoning` / `cost` / `contextWindow` / `maxTokens`). The applier MUST
 * tolerate these omissions — that's the slice's whole point.
 */
function buildTestProvider(
  models: ReadonlyArray<{ id: string; name?: string; input?: unknown }>,
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    baseUrl: "https://example/v1",
    api: "openai-completions",
    ...overrides,
    models: models.map((m) => ({ name: m.id, ...m }) as unknown as ProviderModel),
  };
}

describe("models.config.schema — accept", () => {
  it("accepts the canonical 7-model fleet (sanity check on the embedded constant)", () => {
    expect(CANONICAL_MODEL_DEFAULTS.models.map((m) => m.id).toSorted()).toEqual(
      [
        "claude-opus-4.6",
        "claude-sonnet-4.6",
        "gemini-2.5-pro",
        "gpt-4o",
        "gpt-5-mini",
        "gpt-5.4",
        "grok-4",
      ].toSorted(),
    );
  });

  it("accepts a single-modality output like grok-4 (input=['text'])", () => {
    const parsed = parseCanonicalModelDefaults({
      models: [{ id: "grok-4", input: ["text"], output: ["text"] }],
    });
    expect(parsed.models[0].input).toEqual(["text"]);
  });

  it("accepts a JSON-comment placeholder ($comment) without rejecting", () => {
    const parsed = parseCanonicalModelDefaults({
      $comment: "human note",
      models: [{ id: "gpt-4o", input: ["text", "image"], output: ["text"] }],
    });
    expect(parsed.models).toHaveLength(1);
  });
});

describe("models.config.schema — reject", () => {
  it("rejects a missing `models` array", () => {
    expect(() => parseCanonicalModelDefaults({})).toThrowError(ZodError);
  });

  it("rejects an empty `models` array (must declare at least one entry)", () => {
    const result = CanonicalModelDefaultsFileSchema.safeParse({ models: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      const flat = result.error.flatten();
      expect(JSON.stringify(flat)).toContain("at least one canonical entry");
    }
  });

  it("rejects an entry missing `input`", () => {
    const result = CanonicalModelDefaultsFileSchema.safeParse({
      models: [{ id: "gpt-4o", output: ["text"] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an entry missing `output`", () => {
    const result = CanonicalModelDefaultsFileSchema.safeParse({
      models: [{ id: "gpt-4o", input: ["text", "image"] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty `input` array (must have at least one modality)", () => {
    const result = CanonicalModelDefaultsFileSchema.safeParse({
      models: [{ id: "gpt-4o", input: [], output: ["text"] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown modality literal in `input`", () => {
    const result = CanonicalModelDefaultsFileSchema.safeParse({
      models: [{ id: "gpt-4o", input: ["text", "audio"], output: ["text"] }],
    });
    expect(result.success).toBe(false);
    // The schema MUST surface a path so a future contributor adding an
    // unknown modality sees exactly which entry blew up. Charter §3:
    // "no defaulting unknown modalities to permissive — reject unknown".
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain("input");
    }
  });

  it("rejects an unknown modality literal in `output`", () => {
    const result = CanonicalModelDefaultsFileSchema.safeParse({
      models: [{ id: "gpt-4o", input: ["text", "image"], output: ["audio"] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a duplicate modality in `input`", () => {
    const result = CanonicalModelDefaultsFileSchema.safeParse({
      models: [{ id: "gpt-4o", input: ["text", "text"], output: ["text"] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-string id (numeric)", () => {
    const result = CanonicalModelDefaultsFileSchema.safeParse({
      models: [{ id: 42, input: ["text"], output: ["text"] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty-string id", () => {
    const result = CanonicalModelDefaultsFileSchema.safeParse({
      models: [{ id: "", input: ["text"], output: ["text"] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown top-level key (strict mode)", () => {
    const result = CanonicalModelDefaultsFileSchema.safeParse({
      models: [{ id: "gpt-4o", input: ["text", "image"], output: ["text"] }],
      // Spec freezing: only `$comment` + `models` are allowed.
      provider: "azure-openai",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown per-entry key (strict mode)", () => {
    const result = CanonicalModelDefaultsFileSchema.safeParse({
      models: [
        {
          id: "gpt-4o",
          input: ["text", "image"],
          output: ["text"],
          // Per-entry keys other than id/input/output are NOT part of the
          // canonical-defaults contract; the broader provider model schema
          // owns those (`ModelDefinitionSchema` in zod-schema.core.ts).
          contextWindow: 128000,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects malformed JSON when fed via JSON.parse + parse", () => {
    // Double-check the realistic boot-time path: someone hand-edits the JSON
    // and produces a structurally-typed but semantically wrong document.
    const malformedFromJsonText = '{"models":[{"id":"gpt-4o","input":"text","output":["text"]}]}';
    const parsedRaw = JSON.parse(malformedFromJsonText) as unknown;
    expect(() => parseCanonicalModelDefaults(parsedRaw)).toThrow();
  });
});

describe("models.config — repo defaults file <-> embedded constant guardrail", () => {
  it("config/models.default.json parses cleanly through the schema", async () => {
    const raw = await fs.readFile(MODELS_DEFAULT_JSON_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    expect(() => parseCanonicalModelDefaults(parsed)).not.toThrow();
  });

  it("config/models.default.json declares the same model fleet as the embedded constant", async () => {
    const raw = await fs.readFile(MODELS_DEFAULT_JSON_PATH, "utf8");
    const fileParsed = parseCanonicalModelDefaults(JSON.parse(raw));
    const fileSig = fileParsed.models
      .map((m) => `${m.id}|${m.input.join(",")}|${m.output.join(",")}`)
      .toSorted();
    const constSig = CANONICAL_MODEL_DEFAULTS.models
      .map((m) => `${m.id}|${m.input.join(",")}|${m.output.join(",")}`)
      .toSorted();
    expect(fileSig).toEqual(constSig);
  });

  it("declares grok-4 as text-only on input (per operator decision, mirroring pi-ai upstream)", () => {
    const grok = CANONICAL_MODEL_DEFAULTS.models.find((m) => m.id === "grok-4");
    expect(grok).toBeDefined();
    expect(grok?.input).toEqual(["text"]);
  });

  it("declares 6 of 7 canonical models as vision-capable (input includes 'image')", () => {
    const visionCapable = CANONICAL_MODEL_DEFAULTS.models.filter((m) => m.input.includes("image"));
    expect(visionCapable).toHaveLength(6);
    expect(visionCapable.map((m) => m.id).toSorted()).toEqual(
      [
        "claude-opus-4.6",
        "claude-sonnet-4.6",
        "gemini-2.5-pro",
        "gpt-4o",
        "gpt-5-mini",
        "gpt-5.4",
      ].toSorted(),
    );
  });
});

describe("applyCanonicalModelDefaults — fill gaps", () => {
  it("fills missing input on a canonical model id (the bug this slice fixes)", () => {
    // The user's `~/.openclaw/agents/main/agent/models.json` shipped gpt-5.4
    // entries with NO `input` field — modality filter fail-opened. Repo
    // default fills it.
    const providers: Record<string, ProviderConfig> = {
      "azure-openai-responses": buildTestProvider([{ id: "gpt-5.4", name: "GPT-5.4" }], {
        baseUrl: "",
        api: "openai-responses",
      }),
    };
    const result = applyCanonicalModelDefaults({ providers });
    expect(result.applied).toBe(1);
    expect(result.appliedKeys).toEqual(["azure-openai-responses/gpt-5.4"]);
    expect(result.providers["azure-openai-responses"].models?.[0].input).toEqual(["text", "image"]);
  });

  it("fills missing input on every canonical id when nothing declared input", () => {
    const providers: Record<string, ProviderConfig> = {
      upstream: buildTestProvider([
        { id: "gpt-5.4" },
        { id: "gpt-4o" },
        { id: "gpt-5-mini" },
        { id: "gemini-2.5-pro" },
        { id: "claude-sonnet-4.6" },
        { id: "claude-opus-4.6" },
        { id: "grok-4" },
      ]),
    };
    const result = applyCanonicalModelDefaults({ providers });
    expect(result.applied).toBe(7);
    const filled = result.providers.upstream.models ?? [];
    const grok = filled.find((m) => m.id === "grok-4");
    expect(grok?.input).toEqual(["text"]);
    const opus = filled.find((m) => m.id === "claude-opus-4.6");
    expect(opus?.input).toEqual(["text", "image"]);
  });

  it("fills missing input on EMPTY-array input (treats [] as missing)", () => {
    // The user file may have `input: []` due to a prior buggy round-trip.
    // Treat it as "missing" — non-empty input is the precondition for the
    // modality filter to actually exclude anything.
    const providers: Record<string, ProviderConfig> = {
      upstream: buildTestProvider([{ id: "gpt-4o", input: [] }]),
    };
    const result = applyCanonicalModelDefaults({ providers });
    expect(result.applied).toBe(1);
    expect(result.providers.upstream.models?.[0].input).toEqual(["text", "image"]);
  });

  it("matches case-insensitively on id (handles `GPT-5.4`)", () => {
    const providers: Record<string, ProviderConfig> = {
      upstream: buildTestProvider([{ id: "GPT-5.4" }]),
    };
    const result = applyCanonicalModelDefaults({ providers });
    expect(result.applied).toBe(1);
    expect(result.providers.upstream.models?.[0].input).toEqual(["text", "image"]);
  });
});

describe("applyCanonicalModelDefaults — overlay precedence (user wins)", () => {
  it("does NOT overwrite a non-empty user-declared input", () => {
    // Operator decision: user's local override of grok-4 to ['text','image']
    // (vision wishful thinking) MUST WIN over the conservative repo default
    // of ['text']. Charter row §4 T6: "Vladimir's models.json will continue
    // to overlay grok-4 vision locally if he wants".
    const providers: Record<string, ProviderConfig> = {
      xai: buildTestProvider([{ id: "grok-4", name: "Grok 4", input: ["text", "image"] }], {
        baseUrl: "https://api.x.ai/v1",
      }),
    };
    const result = applyCanonicalModelDefaults({ providers });
    expect(result.applied).toBe(0);
    expect(result.appliedKeys).toEqual([]);
    expect(result.providers.xai.models?.[0].input).toEqual(["text", "image"]);
  });

  it("does NOT overwrite a single-modality user-declared input", () => {
    const providers: Record<string, ProviderConfig> = {
      upstream: buildTestProvider([{ id: "gpt-5.4", input: ["text"] }]),
    };
    const result = applyCanonicalModelDefaults({ providers });
    expect(result.applied).toBe(0);
    expect(result.providers.upstream.models?.[0].input).toEqual(["text"]);
  });

  it("preserves input on canonical entries while filling gaps on others", () => {
    // Mixed case: gpt-5.4 has user-declared input (wins), gpt-4o has none
    // (gets filled). Returned providers must reflect both.
    const providers: Record<string, ProviderConfig> = {
      upstream: buildTestProvider([
        { id: "gpt-5.4", input: ["text"] }, // user wins
        { id: "gpt-4o" }, // gap filled
      ]),
    };
    const result = applyCanonicalModelDefaults({ providers });
    expect(result.applied).toBe(1);
    expect(result.appliedKeys).toEqual(["upstream/gpt-4o"]);
    const models = result.providers.upstream.models ?? [];
    expect(models.find((m) => m.id === "gpt-5.4")?.input).toEqual(["text"]);
    expect(models.find((m) => m.id === "gpt-4o")?.input).toEqual(["text", "image"]);
  });
});

describe("applyCanonicalModelDefaults — non-canonical and edge cases", () => {
  it("leaves non-canonical model ids untouched", () => {
    // A model the canonical defaults don't know about (e.g. local Ollama).
    const providers: Record<string, ProviderConfig> = {
      ollama: buildTestProvider([{ id: "qwen2.5:14b", name: "Qwen 2.5" }], {
        baseUrl: "http://localhost:11434/v1",
        api: "openai-completions",
      }),
    };
    const result = applyCanonicalModelDefaults({ providers });
    expect(result.applied).toBe(0);
    // A non-canonical model entry without `input` declaration is NOT touched
    // — the canonical-defaults seam intentionally only knows about the v1
    // fleet. Other surfaces (model-catalog inference, NEW-A fail-open) own
    // the unknown-model path.
    expect(result.providers.ollama.models?.[0]).not.toHaveProperty("input");
  });

  it("handles a provider with no `models` array (returns input unchanged)", () => {
    const providers: Record<string, ProviderConfig> = {
      ghost: { baseUrl: "x", api: "openai-completions", models: [] },
    };
    const result = applyCanonicalModelDefaults({ providers });
    expect(result.applied).toBe(0);
    expect(result.providers).toBe(providers);
  });

  it("handles an empty providers record", () => {
    const result = applyCanonicalModelDefaults({ providers: {} });
    expect(result.applied).toBe(0);
    expect(result.appliedKeys).toEqual([]);
    expect(result.providers).toEqual({});
  });

  it("does not mutate the input providers record (returns a new shape on change)", () => {
    const providers: Record<string, ProviderConfig> = {
      upstream: buildTestProvider([{ id: "gpt-4o" }]),
    };
    const before = JSON.stringify(providers);
    const result = applyCanonicalModelDefaults({ providers });
    expect(JSON.stringify(providers)).toBe(before);
    expect(result.providers).not.toBe(providers);
  });

  it("returns the SAME providers reference when no canonical fill applies (referential identity)", () => {
    // Optimisation contract: callers can compare references to detect
    // whether the applier actually changed anything.
    const providers: Record<string, ProviderConfig> = {
      ollama: buildTestProvider([{ id: "qwen2.5:14b", input: ["text"] }], {
        baseUrl: "http://localhost:11434/v1",
      }),
    };
    const result = applyCanonicalModelDefaults({ providers });
    expect(result.providers).toBe(providers);
  });
});
