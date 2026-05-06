import type { DonePredicate, EvidenceFact } from "./affordance.js";
import type { ArtifactRecord } from "./world-state.js";

type ArtifactExpectedDeltaForPhase4 = {
  readonly added?: readonly string[];
};

/**
 * Verifies that the runtime adapter (Phase 5) recorded an `image` artifact
 * whose `artifactId` was emitted via the commitment's
 * `expectedDelta.artifacts.added` list. The evidence value carries the
 * record's `sourcePaths` so img2img turns expose the inbound reference path
 * for downstream auditability (cutover-3 bug #2 — Phase 6 closure).
 *
 * Mirrors `pdfCreatedPredicate` (slice cutover-3 Phase 4) — see that file
 * for the closed missing-key set rationale.
 *
 * @param ctx - Predicate context with state snapshots, expected delta,
 *   receipts, and trace.
 * @returns Satisfied with one `artifact.created` evidence fact per matched
 *   record; otherwise `unsatisfied` with closed-string missing keys.
 */
export const imageCreatedPredicate: DonePredicate = (ctx) => {
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

  const expectedAdded =
    (ctx.expectedDelta.artifacts as ArtifactExpectedDeltaForPhase4 | undefined)
      ?.added ?? [];
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
    if (!record || record.kind !== "image") {
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
