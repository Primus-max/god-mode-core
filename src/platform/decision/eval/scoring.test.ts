import { describe, expect, it } from "vitest";
import {
  aggregateMetrics,
  aggregatePerTag,
  jaccardSimilarity,
  scoreCase,
  setEqual,
} from "./scoring.js";
import type { CaseResult, GoldenCase } from "./types.js";

function makeCase(overrides: Partial<GoldenCase> = {}): GoldenCase {
  return {
    id: overrides.id ?? "case-1",
    prompt: overrides.prompt ?? "do the thing",
    fileNames: overrides.fileNames,
    tags: overrides.tags ?? ["english"],
    expectedTaskContract: overrides.expectedTaskContract ?? {
      primaryOutcome: "answer",
      interactionMode: "respond_only",
      requiredCapabilities: [],
      deliverable: { kind: "answer" },
    },
  };
}

function makeActual(
  overrides: Partial<NonNullable<CaseResult["actualTaskContract"]>> = {},
): NonNullable<CaseResult["actualTaskContract"]> {
  return {
    primaryOutcome: overrides.primaryOutcome ?? "answer",
    interactionMode: overrides.interactionMode ?? "respond_only",
    requiredCapabilities: overrides.requiredCapabilities ?? [],
    confidence: overrides.confidence ?? 0.95,
    ambiguities: overrides.ambiguities ?? [],
    ...(overrides.deliverable ? { deliverable: overrides.deliverable } : {}),
  };
}

describe("jaccardSimilarity", () => {
  it("returns 1 for two empty sets", () => {
    expect(jaccardSimilarity([], [])).toBe(1);
  });

  it("returns 1 for identical sets, ignoring order/duplicates", () => {
    expect(jaccardSimilarity(["a", "b"], ["b", "a"])).toBe(1);
    expect(jaccardSimilarity(["a", "a", "b"], ["b", "a"])).toBe(1);
  });

  it("returns 0 for disjoint sets", () => {
    expect(jaccardSimilarity(["a"], ["b"])).toBe(0);
  });

  it("computes intersection over union", () => {
    expect(jaccardSimilarity(["a", "b", "c"], ["b", "c", "d"])).toBeCloseTo(0.5);
  });
});

describe("setEqual", () => {
  it("treats unordered duplicates correctly", () => {
    expect(setEqual(["a", "b"], ["b", "a"])).toBe(true);
    expect(setEqual(["a"], ["a", "b"])).toBe(false);
    expect(setEqual([], [])).toBe(true);
  });
});

describe("scoreCase", () => {
  it("marks a perfect match across all graded fields", () => {
    const goldenCase = makeCase({
      expectedTaskContract: {
        primaryOutcome: "workspace_change",
        interactionMode: "tool_execution",
        requiredCapabilities: ["needs_workspace_mutation"],
        deliverable: { kind: "code_change", preferredFormat: "patch" },
      },
    });
    const actual = makeActual({
      primaryOutcome: "workspace_change",
      interactionMode: "tool_execution",
      requiredCapabilities: ["needs_workspace_mutation"],
      deliverable: { kind: "code_change", acceptedFormats: ["patch"], preferredFormat: "patch" },
    });
    const result = scoreCase(goldenCase, actual, 123);
    expect(result.scores.primaryOutcome.match).toBe(true);
    expect(result.scores.interactionMode.match).toBe(true);
    expect(result.scores.deliverableKind.match).toBe(true);
    expect(result.scores.deliverablePreferredFormat.match).toBe(true);
    expect(result.scores.requiredCapabilities.exactMatch).toBe(true);
    expect(result.scores.requiredCapabilities.jaccard).toBe(1);
    expect(result.latencyMs).toBe(123);
    expect(result.error).toBeUndefined();
  });

  it("does not grade fields the case did not specify", () => {
    const goldenCase = makeCase({
      expectedTaskContract: {
        primaryOutcome: "answer",
      },
    });
    const actual = makeActual({
      primaryOutcome: "answer",
      interactionMode: "tool_execution",
      requiredCapabilities: ["needs_web_research"],
    });
    const result = scoreCase(goldenCase, actual, 10);
    expect(result.scores.primaryOutcome.graded).toBe(true);
    expect(result.scores.primaryOutcome.match).toBe(true);
    expect(result.scores.interactionMode.graded).toBe(false);
    expect(result.scores.requiredCapabilities.graded).toBe(false);
    expect(result.scores.deliverableKind.graded).toBe(false);
  });

  it("handles a null contract (classifier failure) gracefully", () => {
    const goldenCase = makeCase();
    const result = scoreCase(goldenCase, null, 999, { message: "boom" });
    expect(result.scores.primaryOutcome.match).toBe(false);
    expect(result.scores.requiredCapabilities.exactMatch).toBe(false);
    expect(result.error?.message).toBe("boom");
  });
});

describe("aggregateMetrics", () => {
  it("computes ratios, Jaccard mean, and latency percentiles", () => {
    const passing: CaseResult = scoreCase(
      makeCase({ id: "p1" }),
      makeActual({ deliverable: { kind: "answer", acceptedFormats: ["text"] } }),
      100,
    );
    const failing: CaseResult = scoreCase(
      makeCase({
        id: "f1",
        expectedTaskContract: {
          primaryOutcome: "workspace_change",
          interactionMode: "tool_execution",
          requiredCapabilities: ["needs_workspace_mutation"],
          deliverable: { kind: "code_change", preferredFormat: "patch" },
        },
      }),
      makeActual({
        primaryOutcome: "answer",
        interactionMode: "respond_only",
        requiredCapabilities: ["needs_web_research"],
        deliverable: { kind: "answer", acceptedFormats: ["text"] },
      }),
      300,
    );
    const errored: CaseResult = scoreCase(
      makeCase({ id: "e1" }),
      null,
      50,
      { message: "fail" },
    );
    const metrics = aggregateMetrics([passing, failing, errored]);
    expect(metrics.cases).toBe(3);
    expect(metrics.errors).toBe(1);
    expect(metrics.accuracy.primaryOutcome.matched).toBe(1);
    expect(metrics.accuracy.primaryOutcome.graded).toBe(3);
    expect(metrics.accuracy.primaryOutcome.ratio).toBeCloseTo(1 / 3);
    expect(metrics.accuracy.requiredCapabilitiesExact.matched).toBe(1);
    expect(metrics.accuracy.requiredCapabilitiesExact.graded).toBe(3);
    expect(metrics.jaccard.requiredCapabilities.graded).toBe(3);
    expect(metrics.jaccard.requiredCapabilities.mean).toBeCloseTo((1 + 0 + 0) / 3);
    expect(metrics.latencyMs.samples).toBe(3);
    expect(metrics.latencyMs.mean).toBeCloseTo((100 + 300 + 50) / 3);
    expect(metrics.latencyMs.p50).toBeCloseTo(100);
  });

  it("returns null ratios when no cases are graded", () => {
    const metrics = aggregateMetrics([]);
    expect(metrics.accuracy.primaryOutcome.ratio).toBeNull();
    expect(metrics.jaccard.requiredCapabilities.mean).toBeNull();
    expect(metrics.latencyMs.p95).toBeNull();
  });
});

describe("aggregatePerTag", () => {
  it("buckets cases by every tag they declare", () => {
    const r1 = scoreCase(
      makeCase({ id: "r1", tags: ["russian", "answer"] }),
      makeActual(),
      10,
    );
    const r2 = scoreCase(
      makeCase({
        id: "e1",
        tags: ["english", "answer"],
        expectedTaskContract: { primaryOutcome: "answer" },
      }),
      makeActual({ primaryOutcome: "comparison_report" }),
      20,
    );
    const buckets = aggregatePerTag([r1, r2]);
    const tags = buckets.map((b) => b.tag);
    expect(tags).toContain("russian");
    expect(tags).toContain("english");
    expect(tags).toContain("answer");
    const answerBucket = buckets.find((b) => b.tag === "answer");
    expect(answerBucket?.n).toBe(2);
    expect(answerBucket?.metrics.accuracy.primaryOutcome.matched).toBe(1);
    expect(answerBucket?.metrics.accuracy.primaryOutcome.graded).toBe(2);
  });
});
