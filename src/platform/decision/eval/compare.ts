import { z } from "zod";
import type { AggregateMetrics, EvalSnapshot } from "./types.js";

const AccuracyBucketSchema = z.object({
  matched: z.number().int().nonnegative(),
  graded: z.number().int().nonnegative(),
  ratio: z.number().nullable(),
});

const MetricsSchema: z.ZodType<AggregateMetrics> = z.object({
  cases: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  accuracy: z.object({
    primaryOutcome: AccuracyBucketSchema,
    interactionMode: AccuracyBucketSchema,
    deliverableKind: AccuracyBucketSchema,
    deliverablePreferredFormat: AccuracyBucketSchema,
    requiredCapabilitiesExact: AccuracyBucketSchema,
  }),
  jaccard: z.object({
    requiredCapabilities: z.object({
      sum: z.number(),
      graded: z.number().int().nonnegative(),
      mean: z.number().nullable(),
    }),
  }),
  latencyMs: z.object({
    samples: z.number().int().nonnegative(),
    mean: z.number().nullable(),
    p50: z.number().nullable(),
    p95: z.number().nullable(),
  }),
});

export const EvalSnapshotSchema: z.ZodType<EvalSnapshot> = z.object({
  meta: z.object({
    schemaVersion: z.literal(1),
    backend: z.string(),
    model: z.string(),
    timestamp: z.string(),
    durationMs: z.number(),
    casesTotal: z.number().int().nonnegative(),
    casesWithContract: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    datasetSha256: z.string(),
  }),
  metrics: MetricsSchema,
  perTag: z.array(
    z.object({
      tag: z.string(),
      n: z.number().int().nonnegative(),
      metrics: MetricsSchema,
    }),
  ),
  cases: z.array(z.unknown()) as unknown as z.ZodType<EvalSnapshot["cases"]>,
});

export type MetricDelta = {
  metric: string;
  baseline: number | null;
  candidate: number | null;
  deltaAbs: number | null;
};

function diffNumbers(baseline: number | null, candidate: number | null): number | null {
  if (baseline === null || candidate === null) return null;
  return candidate - baseline;
}

function metricRow(
  metric: string,
  baseline: number | null,
  candidate: number | null,
): MetricDelta {
  return {
    metric,
    baseline,
    candidate,
    deltaAbs: diffNumbers(baseline, candidate),
  };
}

export function compareMetrics(
  baseline: AggregateMetrics,
  candidate: AggregateMetrics,
): MetricDelta[] {
  return [
    metricRow(
      "accuracy.primaryOutcome",
      baseline.accuracy.primaryOutcome.ratio,
      candidate.accuracy.primaryOutcome.ratio,
    ),
    metricRow(
      "accuracy.interactionMode",
      baseline.accuracy.interactionMode.ratio,
      candidate.accuracy.interactionMode.ratio,
    ),
    metricRow(
      "accuracy.deliverableKind",
      baseline.accuracy.deliverableKind.ratio,
      candidate.accuracy.deliverableKind.ratio,
    ),
    metricRow(
      "accuracy.deliverablePreferredFormat",
      baseline.accuracy.deliverablePreferredFormat.ratio,
      candidate.accuracy.deliverablePreferredFormat.ratio,
    ),
    metricRow(
      "accuracy.requiredCapabilitiesExact",
      baseline.accuracy.requiredCapabilitiesExact.ratio,
      candidate.accuracy.requiredCapabilitiesExact.ratio,
    ),
    metricRow(
      "jaccard.requiredCapabilities.mean",
      baseline.jaccard.requiredCapabilities.mean,
      candidate.jaccard.requiredCapabilities.mean,
    ),
    metricRow("latency.meanMs", baseline.latencyMs.mean, candidate.latencyMs.mean),
    metricRow("latency.p50Ms", baseline.latencyMs.p50, candidate.latencyMs.p50),
    metricRow("latency.p95Ms", baseline.latencyMs.p95, candidate.latencyMs.p95),
  ];
}

export type CaseFlip = {
  id: string;
  baselineMatched: boolean;
  candidateMatched: boolean;
  changedFields: string[];
};

function caseAllGradedFieldsMatch(
  c: EvalSnapshot["cases"][number],
): { graded: boolean; matched: boolean } {
  const s = c.scores;
  const items: Array<{ graded: boolean; match: boolean }> = [
    { graded: s.primaryOutcome.graded, match: s.primaryOutcome.match },
    { graded: s.interactionMode.graded, match: s.interactionMode.match },
    { graded: s.deliverableKind.graded, match: s.deliverableKind.match },
    {
      graded: s.deliverablePreferredFormat.graded,
      match: s.deliverablePreferredFormat.match,
    },
    {
      graded: s.requiredCapabilities.graded,
      match: s.requiredCapabilities.exactMatch === true,
    },
  ];
  const graded = items.some((i) => i.graded) && !c.error;
  const matched = graded && items.every((i) => !i.graded || i.match);
  return { graded, matched };
}

function changedFields(
  baseline: EvalSnapshot["cases"][number],
  candidate: EvalSnapshot["cases"][number],
): string[] {
  const fields: string[] = [];
  const compareField = (name: string, b: { actual: unknown }, c: { actual: unknown }): void => {
    if (JSON.stringify(b.actual) !== JSON.stringify(c.actual)) {
      fields.push(name);
    }
  };
  compareField("primaryOutcome", baseline.scores.primaryOutcome, candidate.scores.primaryOutcome);
  compareField(
    "interactionMode",
    baseline.scores.interactionMode,
    candidate.scores.interactionMode,
  );
  compareField(
    "deliverableKind",
    baseline.scores.deliverableKind,
    candidate.scores.deliverableKind,
  );
  compareField(
    "deliverablePreferredFormat",
    baseline.scores.deliverablePreferredFormat,
    candidate.scores.deliverablePreferredFormat,
  );
  if (
    JSON.stringify(baseline.scores.requiredCapabilities.actual) !==
    JSON.stringify(candidate.scores.requiredCapabilities.actual)
  ) {
    fields.push("requiredCapabilities");
  }
  return fields;
}

export function compareCases(
  baseline: EvalSnapshot,
  candidate: EvalSnapshot,
): { regressions: CaseFlip[]; improvements: CaseFlip[]; neutralChanges: CaseFlip[] } {
  const baselineById = new Map(baseline.cases.map((c) => [c.id, c]));
  const regressions: CaseFlip[] = [];
  const improvements: CaseFlip[] = [];
  const neutralChanges: CaseFlip[] = [];
  for (const candidateCase of candidate.cases) {
    const baselineCase = baselineById.get(candidateCase.id);
    if (!baselineCase) continue;
    const baselineStatus = caseAllGradedFieldsMatch(baselineCase);
    const candidateStatus = caseAllGradedFieldsMatch(candidateCase);
    const fields = changedFields(baselineCase, candidateCase);
    if (fields.length === 0 && baselineStatus.matched === candidateStatus.matched) continue;
    const flip: CaseFlip = {
      id: candidateCase.id,
      baselineMatched: baselineStatus.matched,
      candidateMatched: candidateStatus.matched,
      changedFields: fields,
    };
    if (baselineStatus.matched && !candidateStatus.matched) {
      regressions.push(flip);
    } else if (!baselineStatus.matched && candidateStatus.matched) {
      improvements.push(flip);
    } else {
      neutralChanges.push(flip);
    }
  }
  return { regressions, improvements, neutralChanges };
}

function fmtRatio(value: number | null): string {
  if (value === null) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function fmtSignedDelta(value: number | null, isPercent: boolean): string {
  if (value === null) return "n/a";
  const sign = value > 0 ? "+" : value < 0 ? "" : "±";
  if (isPercent) {
    return `${sign}${(value * 100).toFixed(1)} pp`;
  }
  return `${sign}${value.toFixed(0)}`;
}

export function renderCompareReport(
  baseline: EvalSnapshot,
  candidate: EvalSnapshot,
): string {
  const lines: string[] = [];
  lines.push(
    `# Compare ${baseline.meta.backend}/${baseline.meta.model} → ${candidate.meta.backend}/${candidate.meta.model}`,
  );
  lines.push("");
  if (baseline.meta.datasetSha256 !== candidate.meta.datasetSha256) {
    lines.push(
      `> WARNING: dataset sha256 differs — comparisons across different golden sets are not apples-to-apples.`,
    );
    lines.push(
      `> baseline=${baseline.meta.datasetSha256.slice(0, 16)}…  candidate=${candidate.meta.datasetSha256.slice(0, 16)}…`,
    );
    lines.push("");
  }
  const deltas = compareMetrics(baseline.metrics, candidate.metrics);
  lines.push("## Metric deltas");
  lines.push("");
  lines.push("| metric | baseline | candidate | Δ |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const d of deltas) {
    const isLatency = d.metric.startsWith("latency.");
    const baselineValue = isLatency
      ? d.baseline === null
        ? "n/a"
        : `${d.baseline.toFixed(0)} ms`
      : fmtRatio(d.baseline);
    const candidateValue = isLatency
      ? d.candidate === null
        ? "n/a"
        : `${d.candidate.toFixed(0)} ms`
      : fmtRatio(d.candidate);
    lines.push(
      `| ${d.metric} | ${baselineValue} | ${candidateValue} | ${fmtSignedDelta(d.deltaAbs, !isLatency)} |`,
    );
  }
  lines.push("");
  const flips = compareCases(baseline, candidate);
  if (flips.regressions.length > 0) {
    lines.push(`## Regressions (${flips.regressions.length})`);
    lines.push("");
    for (const f of flips.regressions) {
      lines.push(`- ${f.id} — fields changed: ${f.changedFields.join(", ") || "none"}`);
    }
    lines.push("");
  }
  if (flips.improvements.length > 0) {
    lines.push(`## Improvements (${flips.improvements.length})`);
    lines.push("");
    for (const f of flips.improvements) {
      lines.push(`- ${f.id} — fields changed: ${f.changedFields.join(", ") || "none"}`);
    }
    lines.push("");
  }
  if (
    flips.regressions.length === 0 &&
    flips.improvements.length === 0 &&
    flips.neutralChanges.length === 0
  ) {
    lines.push("No per-case flips.");
    lines.push("");
  }
  return lines.join("\n");
}
