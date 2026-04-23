import type { AggregateMetrics, EvalSnapshot } from "./types.js";

function fmtRatio(value: number | null): string {
  if (value === null) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function fmtNumber(value: number | null, digits = 0): string {
  if (value === null) return "n/a";
  return value.toFixed(digits);
}

function metricsRows(metrics: AggregateMetrics): string[] {
  return [
    `| primaryOutcome | ${fmtRatio(metrics.accuracy.primaryOutcome.ratio)} | ${metrics.accuracy.primaryOutcome.matched}/${metrics.accuracy.primaryOutcome.graded} |`,
    `| interactionMode | ${fmtRatio(metrics.accuracy.interactionMode.ratio)} | ${metrics.accuracy.interactionMode.matched}/${metrics.accuracy.interactionMode.graded} |`,
    `| deliverable.kind | ${fmtRatio(metrics.accuracy.deliverableKind.ratio)} | ${metrics.accuracy.deliverableKind.matched}/${metrics.accuracy.deliverableKind.graded} |`,
    `| deliverable.preferredFormat | ${fmtRatio(metrics.accuracy.deliverablePreferredFormat.ratio)} | ${metrics.accuracy.deliverablePreferredFormat.matched}/${metrics.accuracy.deliverablePreferredFormat.graded} |`,
    `| requiredCapabilities (exact set) | ${fmtRatio(metrics.accuracy.requiredCapabilitiesExact.ratio)} | ${metrics.accuracy.requiredCapabilitiesExact.matched}/${metrics.accuracy.requiredCapabilitiesExact.graded} |`,
    `| requiredCapabilities (mean Jaccard) | ${fmtRatio(metrics.jaccard.requiredCapabilities.mean)} | ${metrics.jaccard.requiredCapabilities.graded} graded |`,
  ];
}

export function renderMarkdownReport(snapshot: EvalSnapshot): string {
  const lines: string[] = [];
  lines.push(`# TaskClassifier eval — ${snapshot.meta.backend} / ${snapshot.meta.model}`);
  lines.push("");
  lines.push(`- Timestamp: ${snapshot.meta.timestamp}`);
  lines.push(`- Cases: ${snapshot.meta.casesTotal} (with contract: ${snapshot.meta.casesWithContract}, errors: ${snapshot.meta.errors})`);
  lines.push(`- Duration: ${(snapshot.meta.durationMs / 1000).toFixed(2)} s`);
  lines.push(`- Dataset sha256: ${snapshot.meta.datasetSha256.slice(0, 16)}…`);
  lines.push("");
  lines.push("## Aggregate metrics");
  lines.push("");
  lines.push("| metric | value | observed |");
  lines.push("| --- | ---: | ---: |");
  for (const row of metricsRows(snapshot.metrics)) {
    lines.push(row);
  }
  lines.push("");
  lines.push("## Latency");
  lines.push("");
  lines.push(`- mean: ${fmtNumber(snapshot.metrics.latencyMs.mean, 0)} ms`);
  lines.push(`- p50: ${fmtNumber(snapshot.metrics.latencyMs.p50, 0)} ms`);
  lines.push(`- p95: ${fmtNumber(snapshot.metrics.latencyMs.p95, 0)} ms`);
  lines.push(`- samples: ${snapshot.metrics.latencyMs.samples}`);
  lines.push("");
  if (snapshot.perTag.length > 0) {
    lines.push("## Per-tag breakdown");
    lines.push("");
    lines.push("| tag | n | outcome | mode | kind | preferredFormat | caps (exact) | caps (Jaccard) |");
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const tagBucket of snapshot.perTag) {
      const m = tagBucket.metrics;
      lines.push(
        `| ${tagBucket.tag} | ${tagBucket.n} | ${fmtRatio(m.accuracy.primaryOutcome.ratio)} | ${fmtRatio(m.accuracy.interactionMode.ratio)} | ${fmtRatio(m.accuracy.deliverableKind.ratio)} | ${fmtRatio(m.accuracy.deliverablePreferredFormat.ratio)} | ${fmtRatio(m.accuracy.requiredCapabilitiesExact.ratio)} | ${fmtRatio(m.jaccard.requiredCapabilities.mean)} |`,
      );
    }
    lines.push("");
  }
  const failures = snapshot.cases.filter(
    (c) =>
      c.error ||
      (c.scores.primaryOutcome.graded && !c.scores.primaryOutcome.match) ||
      (c.scores.interactionMode.graded && !c.scores.interactionMode.match) ||
      (c.scores.deliverableKind.graded && !c.scores.deliverableKind.match) ||
      (c.scores.requiredCapabilities.graded && !c.scores.requiredCapabilities.exactMatch),
  );
  if (failures.length > 0) {
    lines.push(`## Failures (${failures.length})`);
    lines.push("");
    for (const c of failures) {
      lines.push(`- **${c.id}** (${c.tags.join(", ") || "no tags"})`);
      lines.push(`  - prompt: \`${c.prompt.replace(/`/g, "\\`")}\``);
      if (c.error) {
        lines.push(`  - error: ${c.error.message}`);
        continue;
      }
      const diffs: string[] = [];
      const s = c.scores;
      if (s.primaryOutcome.graded && !s.primaryOutcome.match) {
        diffs.push(`primaryOutcome: expected=${s.primaryOutcome.expected}, actual=${s.primaryOutcome.actual ?? "(none)"}`);
      }
      if (s.interactionMode.graded && !s.interactionMode.match) {
        diffs.push(`interactionMode: expected=${s.interactionMode.expected}, actual=${s.interactionMode.actual ?? "(none)"}`);
      }
      if (s.deliverableKind.graded && !s.deliverableKind.match) {
        diffs.push(`deliverable.kind: expected=${s.deliverableKind.expected}, actual=${s.deliverableKind.actual ?? "(none)"}`);
      }
      if (s.deliverablePreferredFormat.graded && !s.deliverablePreferredFormat.match) {
        diffs.push(`deliverable.preferredFormat: expected=${s.deliverablePreferredFormat.expected}, actual=${s.deliverablePreferredFormat.actual ?? "(none)"}`);
      }
      if (s.requiredCapabilities.graded && !s.requiredCapabilities.exactMatch) {
        diffs.push(`requiredCapabilities: expected={${(s.requiredCapabilities.expected ?? []).join(",")}}, actual={${s.requiredCapabilities.actual.join(",")}}, jaccard=${(s.requiredCapabilities.jaccard ?? 0).toFixed(2)}`);
      }
      for (const d of diffs) {
        lines.push(`  - ${d}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
