import { describe, expect, it } from "vitest";

import {
  LLM_EXTRACTOR_PROMPT,
  LlmExtractorDecisionSchema,
  parseLlmExtractorDecision,
} from "./llm-extractor-prompt.js";

/**
 * Slice E Phase 4 — frozen prompt + structured-output schema tests.
 *
 * The prompt itself is asserted as STABLE (only changes via deliberate
 * sub-plan amendment) so every test that relies on its shape is anchored
 * here. The schema is the single source of truth for what an LLM call
 * may return; downstream code (`LlmExtractorMemoryStore`) trusts the
 * decision shape only after `parseLlmExtractorDecision` has accepted it.
 */

describe("LLM_EXTRACTOR_PROMPT — frozen prompt invariants", () => {
  it("includes a JSON-shape directive so the model knows the response schema", () => {
    expect(LLM_EXTRACTOR_PROMPT).toContain("keep");
    expect(LLM_EXTRACTOR_PROMPT).toContain("normalized");
    expect(LLM_EXTRACTOR_PROMPT).toContain("tags");
  });

  it("is non-empty and includes the structured-output marker for log auditability", () => {
    expect(LLM_EXTRACTOR_PROMPT.length).toBeGreaterThan(64);
    expect(LLM_EXTRACTOR_PROMPT).toContain("JSON");
  });
});

describe("LlmExtractorDecisionSchema — structured-output validation", () => {
  it("accepts a well-formed keep:true decision with non-empty normalized text", () => {
    const decision = {
      keep: true,
      normalized: "operator favourite colour: teal",
      tags: ["preference", "colour"],
    };
    expect(() => LlmExtractorDecisionSchema.parse(decision)).not.toThrow();
  });

  it("accepts a well-formed keep:false decision (normalized text may match input)", () => {
    const decision = {
      keep: false,
      normalized: "ok thanks lol",
      tags: [],
    };
    expect(() => LlmExtractorDecisionSchema.parse(decision)).not.toThrow();
  });

  it("rejects a missing `keep` field", () => {
    const decision = { normalized: "x", tags: [] };
    expect(() => LlmExtractorDecisionSchema.parse(decision)).toThrow();
  });

  it("rejects a non-string `normalized` field", () => {
    const decision = { keep: true, normalized: 42, tags: [] };
    expect(() => LlmExtractorDecisionSchema.parse(decision)).toThrow();
  });

  it("rejects a `tags` field that is not an array of strings", () => {
    const decision = { keep: true, normalized: "x", tags: ["ok", 5] };
    expect(() => LlmExtractorDecisionSchema.parse(decision)).toThrow();
  });

  it("rejects an empty normalized when keep:true (we do NOT persist empty strings)", () => {
    const decision = { keep: true, normalized: "", tags: [] };
    expect(() => LlmExtractorDecisionSchema.parse(decision)).toThrow();
  });
});

describe("parseLlmExtractorDecision — string parser surface", () => {
  it("parses a JSON string and round-trips the decision", () => {
    const raw = JSON.stringify({
      keep: true,
      normalized: "the fact",
      tags: ["a", "b"],
    });
    const parsed = parseLlmExtractorDecision(raw);
    expect(parsed.keep).toBe(true);
    expect(parsed.normalized).toBe("the fact");
    expect(parsed.tags).toEqual(["a", "b"]);
  });

  it("strips a markdown code-fence wrapper if the model returned one", () => {
    // Some providers wrap structured output in ```json ... ``` even
    // when asked not to. Be forgiving on the parse side; that's
    // observability hardening, not behavioural change.
    const raw = "```json\n" + JSON.stringify({ keep: false, normalized: "x", tags: [] }) + "\n```";
    const parsed = parseLlmExtractorDecision(raw);
    expect(parsed.keep).toBe(false);
  });

  it("rejects malformed JSON with a clear error", () => {
    expect(() => parseLlmExtractorDecision("not json")).toThrow();
  });
});
