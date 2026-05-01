import { describe, expect, it } from "vitest";
import { injectTimestamp } from "../gateway/server-methods/agent-timestamp.js";
import { deterministicPromptOptimize, mergePromptOptimizationReports } from "./prompt-optimize.js";

describe("deterministicPromptOptimize", () => {
  it("is a no-op on minimal clean prompts", () => {
    const { prompt, meta } = deterministicPromptOptimize("fix the bug in src/app.ts");
    expect(prompt).toBe("fix the bug in src/app.ts");
    expect(meta.applied).toBe(false);
    expect(meta.charsRemoved).toBe(0);
    expect(meta.strategyId).toBe("deterministic-v2");
  });

  it("normalizes CRLF and trims trailing line whitespace without dropping paths", () => {
    const { prompt, meta } = deterministicPromptOptimize(
      "Please edit `src/foo/bar.ts`  \r\nand run tests  \r\n",
    );
    expect(prompt).toContain("src/foo/bar.ts");
    expect(prompt).toContain("and run tests");
    expect(prompt.endsWith("tests")).toBe(true);
    expect(meta.applied).toBe(true);
    expect(meta.reasoning?.length).toBeGreaterThan(0);
    expect(meta.normalized).toBe(true);
    expect(meta.trimmedWhitespace).toBeGreaterThan(0);
    expect(meta.collapsedLines).toBe(0);
  });

  it("reports visibility metrics on messy multiline prompts", () => {
    const { prompt, meta } = deterministicPromptOptimize("  line1  \r\n\r\n\r\nline2  \n");
    expect(prompt).toBe("line1\n\nline2");
    expect(meta.normalized).toBe(true);
    expect(meta.trimmedWhitespace).toBe(7);
    expect(meta.collapsedLines).toBe(1);
  });

  it("collapses excessive blank lines but keeps paragraph breaks", () => {
    const { prompt } = deterministicPromptOptimize("line1\n\n\n\nline2");
    expect(prompt).toBe("line1\n\nline2");
  });

  it("collapses repeated inline spacing in plain text", () => {
    const { prompt, meta } = deterministicPromptOptimize(
      "Сильно    сожми   этот   раздутый запрос и  ответь одной фразой.",
    );
    expect(prompt).toBe("Сильно сожми этот раздутый запрос и ответь одной фразой.");
    expect(meta.applied).toBe(true);
  });

  it("matches the Stage 86 prompt optimization checklist example", () => {
    const { prompt, meta } = deterministicPromptOptimize(
      "\n\n\n   Привет!     Как работает   routing в OpenClaw?\n\n\n",
    );
    expect(prompt).toBe("Привет! Как работает routing в OpenClaw?");
    expect(meta.applied).toBe(true);
    expect(meta.normalized).toBe(false);
    expect(meta.trimmedWhitespace).toBe(7);
    expect(meta.collapsedLines).toBe(2);
  });

  it("matches the live gateway Stage 86 contract after timestamp injection", () => {
    const stamped = injectTimestamp("\n\n\n   Привет!     Как работает   routing в OpenClaw?", {
      now: new Date("2026-04-09T09:06:14.000Z"),
      timezone: "UTC",
    });
    const { prompt, meta } = deterministicPromptOptimize(stamped);
    expect(prompt).toContain("Привет! Как работает routing в OpenClaw?");
    expect(meta.applied).toBe(true);
    expect(meta.normalized).toBe(false);
    expect(meta.trimmedWhitespace).toBe(1);
    expect(meta.collapsedLines).toBe(1);
  });

  it("preserves fenced and inline code spacing", () => {
    const { prompt } = deterministicPromptOptimize(
      "Keep `foo  bar` unchanged.\n```ts\nconst x =  1;\n```",
    );
    expect(prompt).toContain("`foo  bar`");
    expect(prompt).toContain("const x =  1;");
  });
});

describe("mergePromptOptimizationReports", () => {
  it("concatenates reasoning and sums charsRemoved", () => {
    const merged = mergePromptOptimizationReports(
      { reasoning: ["a"], charsRemoved: 2, applied: true, strategyId: "s1" },
      { reasoning: ["b"], charsRemoved: 3, strategyId: "s2" },
    );
    expect(merged?.reasoning).toEqual(["a", "b"]);
    expect(merged?.charsRemoved).toBe(5);
    expect(merged?.strategyId).toBe("s2");
    expect(merged?.applied).toBe(true);
  });

  it("returns undefined when no inputs", () => {
    expect(mergePromptOptimizationReports(undefined, undefined)).toBeUndefined();
  });

  it("merges visibility fields with normalized OR and summed numerics", () => {
    const merged = mergePromptOptimizationReports(
      { normalized: true, trimmedWhitespace: 2, collapsedLines: 1 },
      { trimmedWhitespace: 3, collapsedLines: 2 },
    );
    expect(merged?.normalized).toBe(true);
    expect(merged?.trimmedWhitespace).toBe(5);
    expect(merged?.collapsedLines).toBe(3);
  });
});
