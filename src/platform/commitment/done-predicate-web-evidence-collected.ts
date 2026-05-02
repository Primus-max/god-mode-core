import type { DonePredicate, EvidenceFact } from "./affordance.js";

/**
 * Verifies that the search specialist (sonar / sonar-pro) populated the
 * `WebEvidenceSlice` with at least one record carrying a cited URL —
 * the structural proof that a real search ran rather than a
 * training-cutoff fallback.
 *
 * Phase 3 wiring: reads `ctx.stateAfter.webEvidence?.records` only.
 * Raw user text, `TaskContract`, and task-classifier output remain
 * untouched (invariant #9). Population of the slice is a Phase 4
 * runtime-adapter concern; this predicate is observation-only.
 *
 * @param ctx - Predicate context with state snapshots, expected delta,
 *   receipts, and trace.
 * @returns Satisfied when ≥1 record is present and every record carries
 *   a non-empty `url`; otherwise `unsatisfied` with a closed-string
 *   missing key explaining the structural failure.
 */
export const webEvidenceCollectedPredicate: DonePredicate = (ctx) => {
  const records = ctx.stateAfter.webEvidence?.records;
  if (records === undefined) {
    return {
      satisfied: false,
      missing: Object.freeze(["web_evidence.slice_absent"]),
    };
  }
  if (records.length === 0) {
    return {
      satisfied: false,
      missing: Object.freeze(["web_evidence.records.empty"]),
    };
  }

  const missing: string[] = [];
  const evidence: EvidenceFact[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.url === "") {
      missing.push(`evidence_record_missing_url:${index}`);
      continue;
    }
    evidence.push({
      kind: "web_evidence.collected",
      value: Object.freeze({
        url: record.url,
        snippet: record.snippet,
        title: record.title,
        capturedAt: record.capturedAt,
      }),
    });
  }

  return missing.length === 0
    ? { satisfied: true, evidence: Object.freeze(evidence) }
    : { satisfied: false, missing: Object.freeze(missing) };
};
