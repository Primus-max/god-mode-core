import { describe, expect, it } from "vitest";
import { compareCases, compareMetrics, EvalSnapshotSchema } from "./compare.js";
import type { CaseResult, EvalSnapshot } from "./types.js";

function caseResult(
  id: string,
  overrides: {
    primaryOutcomeMatch?: boolean;
    actualPrimaryOutcome?: string;
    capsActual?: string[];
    error?: string;
  } = {},
): CaseResult {
  return {
    id,
    tags: ["english"],
    prompt: `prompt-${id}`,
    fileNames: [],
    expectedTaskContract: {
      primaryOutcome: "answer",
      requiredCapabilities: [],
    },
    actualTaskContract: overrides.error
      ? null
      : {
          primaryOutcome: overrides.actualPrimaryOutcome ?? "answer",
          interactionMode: "respond_only",
          requiredCapabilities: overrides.capsActual ?? [],
          confidence: 0.9,
          ambiguities: [],
        },
    scores: {
      primaryOutcome: {
        expected: "answer",
        actual: overrides.actualPrimaryOutcome ?? "answer",
        match: overrides.primaryOutcomeMatch ?? true,
        graded: true,
      },
      interactionMode: { expected: undefined, actual: undefined, match: false, graded: false },
      deliverableKind: { expected: undefined, actual: undefined, match: false, graded: false },
      deliverablePreferredFormat: {
        expected: undefined,
        actual: undefined,
        match: false,
        graded: false,
      },
      requiredCapabilities: {
        expected: [],
        actual: overrides.capsActual ?? [],
        jaccard: overrides.capsActual && overrides.capsActual.length > 0 ? 0 : 1,
        exactMatch: !overrides.capsActual || overrides.capsActual.length === 0,
        graded: true,
      },
    },
    latencyMs: 100,
    ...(overrides.error ? { error: { message: overrides.error } } : {}),
  };
}

function snapshot(
  cases: CaseResult[],
  overrides: Partial<EvalSnapshot["meta"]> = {},
): EvalSnapshot {
  return {
    meta: {
      schemaVersion: 1,
      backend: "test",
      model: "model-a",
      timestamp: "2026-04-23T00:00:00.000Z",
      durationMs: 1000,
      casesTotal: cases.length,
      casesWithContract: cases.filter((c) => !c.error).length,
      errors: cases.filter((c) => c.error).length,
      datasetSha256: "0".repeat(64),
      ...overrides,
    },
    metrics: {
      cases: cases.length,
      errors: cases.filter((c) => c.error).length,
      accuracy: {
        primaryOutcome: { matched: 1, graded: 2, ratio: 0.5 },
        interactionMode: { matched: 0, graded: 0, ratio: null },
        deliverableKind: { matched: 0, graded: 0, ratio: null },
        deliverablePreferredFormat: { matched: 0, graded: 0, ratio: null },
        requiredCapabilitiesExact: { matched: 2, graded: 2, ratio: 1 },
      },
      jaccard: { requiredCapabilities: { sum: 2, graded: 2, mean: 1 } },
      latencyMs: { samples: 2, mean: 100, p50: 100, p95: 100 },
    },
    perTag: [],
    cases,
  };
}

describe("compareMetrics", () => {
  it("computes signed deltas and returns null when either side is null", () => {
    const baseline = snapshot([]).metrics;
    const candidate = snapshot([]).metrics;
    candidate.accuracy.primaryOutcome.ratio = 0.75;
    baseline.accuracy.primaryOutcome.ratio = 0.5;
    candidate.latencyMs.mean = 200;
    baseline.latencyMs.mean = 100;
    candidate.latencyMs.p95 = null;
    const deltas = compareMetrics(baseline, candidate);
    const primary = deltas.find((d) => d.metric === "accuracy.primaryOutcome");
    const latency = deltas.find((d) => d.metric === "latency.meanMs");
    const p95 = deltas.find((d) => d.metric === "latency.p95Ms");
    expect(primary?.deltaAbs).toBeCloseTo(0.25);
    expect(latency?.deltaAbs).toBe(100);
    expect(p95?.deltaAbs).toBeNull();
  });
});

describe("compareCases", () => {
  it("buckets per-case status changes into regressions / improvements / neutral", () => {
    const baseline = snapshot([
      caseResult("kept-pass"),
      caseResult("now-fail"),
      caseResult("now-pass", { primaryOutcomeMatch: false, actualPrimaryOutcome: "answer-bad" }),
      caseResult("kept-fail", { primaryOutcomeMatch: false, actualPrimaryOutcome: "answer-x" }),
    ]);
    const candidate = snapshot([
      caseResult("kept-pass"),
      caseResult("now-fail", { primaryOutcomeMatch: false, actualPrimaryOutcome: "answer-bad" }),
      caseResult("now-pass"),
      caseResult("kept-fail", { primaryOutcomeMatch: false, actualPrimaryOutcome: "answer-y" }),
    ]);
    const flips = compareCases(baseline, candidate);
    expect(flips.regressions.map((f) => f.id)).toEqual(["now-fail"]);
    expect(flips.improvements.map((f) => f.id)).toEqual(["now-pass"]);
    expect(flips.neutralChanges.map((f) => f.id)).toEqual(["kept-fail"]);
  });
});

describe("EvalSnapshotSchema", () => {
  it("round-trips a valid snapshot", () => {
    const snap = snapshot([caseResult("a")]);
    const json = JSON.parse(JSON.stringify(snap)) as unknown;
    const parsed = EvalSnapshotSchema.parse(json);
    expect(parsed.meta.schemaVersion).toBe(1);
    expect(parsed.cases).toHaveLength(1);
  });
});
