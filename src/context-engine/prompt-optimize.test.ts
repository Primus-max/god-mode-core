import { describe, expect, it } from "vitest";
import { deterministicPromptOptimize, mergePromptOptimizationReports } from "./prompt-optimize.js";

describe("deterministicPromptOptimize", () => {
  it("is a no-op on minimal clean prompts", () => {
    const { prompt, meta } = deterministicPromptOptimize("fix the bug in src/app.ts");
    expect(prompt).toBe("fix the bug in src/app.ts");
    expect(meta.applied).toBe(false);
    expect(meta.charsRemoved).toBe(0);
    expect(meta.strategyId).toBe("deterministic-v1");
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
  });

  it("collapses excessive blank lines but keeps paragraph breaks", () => {
    const { prompt } = deterministicPromptOptimize("line1\n\n\n\nline2");
    expect(prompt).toBe("line1\n\nline2");
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
});
