import type { DonePredicate, EvidenceFact } from "./affordance.js";
import type { ArtifactRecord } from "./world-state.js";

/**
 * Verifies that the runtime adapter (Phase 5) recorded a `pdf` artifact
 * whose `artifactId` was emitted via the commitment's
 * `expectedDelta.artifacts.added` list. The predicate observes only
 * `state`/`delta`/`receipts`/`trace` per invariant #9; raw user text and
 * `TaskContract` are NOT read.
 *
 * Phase 4 wiring: reads `ctx.stateAfter.artifacts?.records` only. Population
 * of the slice is a Phase 3 observer concern; emit is a Phase 5 runtime-
 * adapter concern; this predicate is observation-only.
 *
 * Closed missing-key set (slice E precedent):
 *  - `artifacts.slice_absent` — `ArtifactWorldState` slice missing.
 *  - `artifacts.records.empty` — slice present but no records observed.
 *  - `artifacts.delta_empty` — `expectedDelta.artifacts.added` is absent
 *    or empty (Phase 5 runtime adapter populates this; until then the
 *    predicate cannot resolve a target artifactId).
 *  - `artifact_record_missing:<id>` — record with matching `artifactId`
 *    AND `kind === "pdf"` not found.
 *
 * @param ctx - Predicate context with state snapshots, expected delta,
 *   receipts, and trace.
 * @returns Satisfied with one `artifact.created` evidence fact per matched
 *   record; otherwise `unsatisfied` with closed-string missing keys.
 */
export const pdfCreatedPredicate: DonePredicate = (ctx) => {
  const records = ctx.stateAfter.artifacts?.records;
  if (records === undefined) {
    return {
      satisfied: false,
      missing: Object.freeze(["artifacts.slice_absent"]),
    };
  }
  if (records.length === 0) {
    return {
      satisfied: false,
      missing: Object.freeze(["artifacts.records.empty"]),
    };
  }

  const expectedAdded = ctx.expectedDelta.artifacts?.added ?? [];
  if (expectedAdded.length === 0) {
    return {
      satisfied: false,
      missing: Object.freeze(["artifacts.delta_empty"]),
    };
  }

  const recordsById = new Map<string, ArtifactRecord>();
  for (const record of records) {
    if (record && typeof record.artifactId === "string") {
      recordsById.set(record.artifactId, record);
    }
  }

  const missing: string[] = [];
  const evidence: EvidenceFact[] = [];
  for (const artifactId of expectedAdded) {
    const record = recordsById.get(artifactId);
    if (!record || record.kind !== "pdf") {
      missing.push(`artifact_record_missing:${artifactId}`);
      continue;
    }
    evidence.push({
      kind: "artifact.created",
      value: Object.freeze({
        artifactId: record.artifactId,
        kind: record.kind,
        path: record.path,
        mimeType: record.mimeType,
        sizeBytes: record.sizeBytes,
        sourcePaths: record.sourcePaths,
        producedAt: record.producedAt,
      }),
    });
  }

  return missing.length === 0
    ? { satisfied: true, evidence: Object.freeze(evidence) }
    : { satisfied: false, missing: Object.freeze(missing) };
};
