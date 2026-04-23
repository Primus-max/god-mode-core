import type {
  AggregateMetrics,
  CaseResult,
  FieldScore,
  GoldenCase,
  SetScore,
} from "./types.js";

/**
 * Pure scoring helpers for the classifier eval harness.
 *
 * All functions here are deterministic, take the structured TaskContract output
 * (never the raw prompt) and produce structured comparisons. The eval runner
 * never looks at user-prompt text after the adapter has produced a contract.
 */

export function jaccardSimilarity(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) {
    return 1;
  }
  let intersection = 0;
  for (const value of setA) {
    if (setB.has(value)) {
      intersection += 1;
    }
  }
  const union = setA.size + setB.size - intersection;
  if (union === 0) {
    return 1;
  }
  return intersection / union;
}

export function setEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const setB = new Set(b);
  for (const value of a) {
    if (!setB.has(value)) {
      return false;
    }
  }
  return true;
}

function gradeField(
  expected: string | undefined,
  actual: string | undefined,
  contractMissing: boolean,
): FieldScore {
  if (expected === undefined) {
    return { expected, actual, match: false, graded: false };
  }
  if (contractMissing) {
    return { expected, actual: undefined, match: false, graded: true };
  }
  return {
    expected,
    actual,
    match: actual === expected,
    graded: true,
  };
}

function gradeCapabilities(
  expected: readonly string[] | undefined,
  actual: readonly string[],
  contractMissing: boolean,
): SetScore {
  if (expected === undefined) {
    return {
      expected: undefined,
      actual: [...actual],
      jaccard: undefined,
      exactMatch: undefined,
      graded: false,
    };
  }
  if (contractMissing) {
    return {
      expected: [...expected],
      actual: [],
      jaccard: 0,
      exactMatch: false,
      graded: true,
    };
  }
  return {
    expected: [...expected],
    actual: [...actual],
    jaccard: jaccardSimilarity(expected, actual),
    exactMatch: setEqual(expected, actual),
    graded: true,
  };
}

export function scoreCase(
  goldenCase: GoldenCase,
  actualTaskContract: CaseResult["actualTaskContract"],
  latencyMs: number,
  error?: { message: string },
): CaseResult {
  const expected = goldenCase.expectedTaskContract;
  const actual = actualTaskContract;
  const contractMissing = actual === null;
  const scores: CaseResult["scores"] = {
    primaryOutcome: gradeField(expected.primaryOutcome, actual?.primaryOutcome, contractMissing),
    interactionMode: gradeField(expected.interactionMode, actual?.interactionMode, contractMissing),
    deliverableKind: gradeField(
      expected.deliverable?.kind,
      actual?.deliverable?.kind,
      contractMissing,
    ),
    deliverablePreferredFormat: gradeField(
      expected.deliverable?.preferredFormat,
      actual?.deliverable?.preferredFormat,
      contractMissing,
    ),
    requiredCapabilities: gradeCapabilities(
      expected.requiredCapabilities,
      actual?.requiredCapabilities ?? [],
      contractMissing,
    ),
  };
  return {
    id: goldenCase.id,
    tags: [...goldenCase.tags],
    prompt: goldenCase.prompt,
    fileNames: goldenCase.fileNames ? [...goldenCase.fileNames] : [],
    expectedTaskContract: expected,
    actualTaskContract: actual,
    scores,
    latencyMs,
    ...(error ? { error } : {}),
  };
}

function percentile(sortedAsc: readonly number[], q: number): number | null {
  if (sortedAsc.length === 0) {
    return null;
  }
  if (sortedAsc.length === 1) {
    return sortedAsc[0]!;
  }
  const rank = q * (sortedAsc.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) {
    return sortedAsc[lower]!;
  }
  const weight = rank - lower;
  return sortedAsc[lower]! * (1 - weight) + sortedAsc[upper]! * weight;
}

function emptyAccuracyBucket(): AggregateMetrics["accuracy"]["primaryOutcome"] {
  return { matched: 0, graded: 0, ratio: null };
}

function emptyMetrics(): AggregateMetrics {
  return {
    cases: 0,
    errors: 0,
    accuracy: {
      primaryOutcome: emptyAccuracyBucket(),
      interactionMode: emptyAccuracyBucket(),
      deliverableKind: emptyAccuracyBucket(),
      deliverablePreferredFormat: emptyAccuracyBucket(),
      requiredCapabilitiesExact: emptyAccuracyBucket(),
    },
    jaccard: {
      requiredCapabilities: { sum: 0, graded: 0, mean: null },
    },
    latencyMs: { samples: 0, mean: null, p50: null, p95: null },
  };
}

function tally(
  bucket: AggregateMetrics["accuracy"]["primaryOutcome"],
  field: FieldScore,
): void {
  if (!field.graded) return;
  bucket.graded += 1;
  if (field.match) bucket.matched += 1;
}

function tallySetExact(
  bucket: AggregateMetrics["accuracy"]["requiredCapabilitiesExact"],
  setScore: SetScore,
): void {
  if (!setScore.graded) return;
  bucket.graded += 1;
  if (setScore.exactMatch) bucket.matched += 1;
}

function finalizeRatio(bucket: AggregateMetrics["accuracy"]["primaryOutcome"]): void {
  bucket.ratio = bucket.graded > 0 ? bucket.matched / bucket.graded : null;
}

export function aggregateMetrics(results: readonly CaseResult[]): AggregateMetrics {
  const metrics = emptyMetrics();
  metrics.cases = results.length;
  const latencies: number[] = [];
  for (const r of results) {
    if (r.error) metrics.errors += 1;
    tally(metrics.accuracy.primaryOutcome, r.scores.primaryOutcome);
    tally(metrics.accuracy.interactionMode, r.scores.interactionMode);
    tally(metrics.accuracy.deliverableKind, r.scores.deliverableKind);
    tally(metrics.accuracy.deliverablePreferredFormat, r.scores.deliverablePreferredFormat);
    tallySetExact(metrics.accuracy.requiredCapabilitiesExact, r.scores.requiredCapabilities);
    if (r.scores.requiredCapabilities.graded && r.scores.requiredCapabilities.jaccard !== undefined) {
      metrics.jaccard.requiredCapabilities.sum += r.scores.requiredCapabilities.jaccard;
      metrics.jaccard.requiredCapabilities.graded += 1;
    }
    if (Number.isFinite(r.latencyMs)) {
      latencies.push(r.latencyMs);
    }
  }
  finalizeRatio(metrics.accuracy.primaryOutcome);
  finalizeRatio(metrics.accuracy.interactionMode);
  finalizeRatio(metrics.accuracy.deliverableKind);
  finalizeRatio(metrics.accuracy.deliverablePreferredFormat);
  finalizeRatio(metrics.accuracy.requiredCapabilitiesExact);
  metrics.jaccard.requiredCapabilities.mean =
    metrics.jaccard.requiredCapabilities.graded > 0
      ? metrics.jaccard.requiredCapabilities.sum / metrics.jaccard.requiredCapabilities.graded
      : null;

  if (latencies.length > 0) {
    const sorted = [...latencies].toSorted((a, b) => a - b);
    metrics.latencyMs.samples = sorted.length;
    metrics.latencyMs.mean =
      sorted.reduce((acc, value) => acc + value, 0) / sorted.length;
    metrics.latencyMs.p50 = percentile(sorted, 0.5);
    metrics.latencyMs.p95 = percentile(sorted, 0.95);
  }
  return metrics;
}

export function aggregatePerTag(
  results: readonly CaseResult[],
): Array<{ tag: string; n: number; metrics: AggregateMetrics }> {
  const buckets = new Map<string, CaseResult[]>();
  for (const r of results) {
    for (const tag of r.tags) {
      const list = buckets.get(tag);
      if (list) {
        list.push(r);
      } else {
        buckets.set(tag, [r]);
      }
    }
  }
  return Array.from(buckets.entries())
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([tag, bucketResults]) => ({
      tag,
      n: bucketResults.length,
      metrics: aggregateMetrics(bucketResults),
    }));
}
