import type { DonePredicate, EvidenceFact } from "./affordance.js";
import type { ExpectedDelta } from "./expected-delta.js";
import { PERSISTENT_WORKER_SUBSEQUENT_PUSH_EFFECT } from "../persistent-worker/persistent-worker-push-types.js";

/**
 * Bug F (persistent-worker subsequent push) Phase 3 — done-predicate for
 * `persistent_worker.subsequent_push`.
 *
 * Verifies that the runtime adapter (Phase 4
 * `runPersistentWorkerSubsequentPush`) recorded a delivered worker-report
 * whose `workerRunId` was emitted via the commitment's
 * `expectedDelta.persistentWorkerReports.added` list and whose `status` is
 * `pushed` (the cron-fire callback marked the record `pushed` BEFORE
 * dispatching the outbound payload — Phase 5 idempotency-on-retry parity
 * with the slice K reminder-fire callback's `markFired`-before-dispatch).
 *
 * The predicate observes only `state` / `delta` / `receipts` / `trace` per
 * invariant #9; raw user text and `TaskContract` are NEVER read.
 *
 * Phase 3 wiring: reads `ctx.stateAfter.persistentWorkerReports?.delivered`
 * (Phase 5 world-state slice) only. Population of the slice is a Phase 5
 * observer concern (`PersistentWorkerReportObserver`); emit is a Phase 4
 * runtime-adapter concern (`persistent-worker-push-runtime-adapter.ts`);
 * this predicate is observation-only.
 *
 * `expectedDelta.persistentWorkerReports.added` is widened in Phase 5
 * (Cutover-3 P4 / Cutover-4 P4 / Slice K P3 / Cron-Scheduler P4 forward-
 * compat shim precedent — `expected-delta.ts` does NOT yet declare a
 * `persistentWorkerReports` slice). For Phase 3 the predicate accepts the
 * future `added: readonly string[]` shape via a structural cast —
 * predicates must NEVER throw on the empty shape and emit a closed-string
 * sentinel until Phase 5 wiring (#9 sentinel-proxy).
 *
 * Closed missing-key set (sub-plan §1 todo Phase 3):
 *  - `persistent_worker_reports.slice_absent` —
 *    `WorldStateSnapshot.persistentWorkerReports` slice missing entirely.
 *  - `persistent_worker_reports.delivered.empty` — slice present but the
 *    `delivered` list is empty (no worker-reports were dispatched).
 *  - `worker_report_missing:<id>` — record with matching `workerRunId` not
 *    found in observed slice.
 *  - `worker_report_status_unexpected:<id>:<status>` — record found but its
 *    `status` is not the canonical `pushed`. The cron-fire callback marks
 *    the record `pushed` BEFORE dispatch (idempotent-on-retry), so any
 *    non-`pushed` status at predicate time is a structural anomaly.
 *
 * **NEVER throws** — every malformed shape (missing slice, missing
 * `delivered` key, missing `workerRunId` on a record, non-array `added`)
 * yields a closed-string sentinel via the missing-key set above.
 *
 * Empty `expectedDelta.persistentWorkerReports.added` + non-empty
 * `delivered` list satisfies the predicate (the cron-fire boundary
 * observed at least one push for the turn — there is no outstanding
 * commitment to verify against, but the slice carries an effect-fact
 * the trace can fingerprint). This matches sub-plan §1 todo Phase 3
 * test case #6 and is consistent with the audit §i NEW invariant
 * («every push is structural; the trace must be able to surface the
 * effect even when the commitment carried no expected delta»).
 *
 * @param ctx - Predicate context with state snapshots, expected delta,
 *   receipts, and trace.
 * @returns Satisfied with one `persistent_worker.subsequent_push` evidence
 *   fact per matched record carrying the `workerRunId`; otherwise
 *   `unsatisfied` with closed-string missing keys.
 */
export const persistentWorkerPushDeliveredPredicate: DonePredicate = (ctx) => {
  const slice = readPersistentWorkerReportsSlice(ctx.stateAfter);
  if (slice === undefined) {
    return {
      satisfied: false,
      missing: Object.freeze(["persistent_worker_reports.slice_absent"]),
    };
  }

  const delivered = Array.isArray(slice.delivered) ? slice.delivered : undefined;
  if (delivered === undefined || delivered.length === 0) {
    return {
      satisfied: false,
      missing: Object.freeze(["persistent_worker_reports.delivered.empty"]),
    };
  }

  const recordsById = new Map<string, DeliveredWorkerReportRecordShape>();
  for (const record of delivered) {
    if (record && typeof record.workerRunId === "string") {
      recordsById.set(record.workerRunId, record);
    }
  }

  const delta = readPersistentWorkerReportsExpectedDelta(ctx.expectedDelta);
  const expectedAdded = Array.isArray(delta?.added) ? delta.added : [];

  // Empty expectedDelta but non-empty delivered — emit one evidence fact per
  // observed record (sub-plan §1 todo Phase 3 test case #6 — «empty
  // expectedDelta + non-empty delivered → satisfied=true; just observed»).
  if (expectedAdded.length === 0) {
    const facts: EvidenceFact[] = [];
    for (const record of recordsById.values()) {
      facts.push(buildEvidenceFact(record));
    }
    return { satisfied: true, evidence: Object.freeze(facts) };
  }

  const missing: string[] = [];
  const evidence: EvidenceFact[] = [];
  for (const workerRunId of expectedAdded) {
    if (typeof workerRunId !== "string" || workerRunId.length === 0) {
      continue;
    }
    const record = recordsById.get(workerRunId);
    if (!record) {
      missing.push(`worker_report_missing:${workerRunId}`);
      continue;
    }
    if (record.status !== "pushed") {
      missing.push(
        `worker_report_status_unexpected:${workerRunId}:${String(record.status)}`,
      );
      continue;
    }
    evidence.push(buildEvidenceFact(record));
  }

  return missing.length === 0
    ? { satisfied: true, evidence: Object.freeze(evidence) }
    : { satisfied: false, missing: Object.freeze(missing) };
};

/**
 * Forward-compat shape for a single delivered worker-report record on
 * `WorldStateSnapshot.persistentWorkerReports.delivered`. Phase 5 widens
 * `world-state.ts` with the canonical `DeliveredWorkerReportRecord` type;
 * this structural shape stays defensive against malformed slice shapes
 * (#9 sentinel-proxy) without taking a hard dependency on the Phase 5 type.
 *
 * The shape mirrors the Phase 2 `WorkerReportRef` closed shape plus the
 * Phase 5 `subsequentPushStatus` field promoted to a `status` discriminator
 * on the slice (`'pushed' | 'failed' | string`). Predicates must never
 * throw on a malformed `status` — non-string and unknown values surface as
 * `worker_report_status_unexpected`.
 */
type DeliveredWorkerReportRecordShape = {
  readonly workerRunId?: string;
  readonly status?: string;
  readonly ownerIdentityId?: string;
  readonly completedAt?: string;
  readonly channel?: string;
  readonly to?: string;
};

/**
 * Forward-compat shape for `WorldStateSnapshot.persistentWorkerReports`.
 * Phase 5 widens `world-state.ts` with the real
 * `PersistentWorkerReportsSlice`; this structural reader stays defensive
 * against malformed slice shapes (#9 sentinel-proxy) without taking a hard
 * dependency on the Phase 5 type.
 */
type PersistentWorkerReportsSliceShape = {
  readonly delivered?: readonly DeliveredWorkerReportRecordShape[];
};

/**
 * Reads `WorldStateSnapshot.persistentWorkerReports` defensively. Returns
 * the slice shape when present, `undefined` otherwise. Predicates must
 * NEVER throw on the empty shape (#9).
 */
function readPersistentWorkerReportsSlice(
  stateAfter: Parameters<DonePredicate>[0]["stateAfter"],
): PersistentWorkerReportsSliceShape | undefined {
  const slice = (
    stateAfter as { persistentWorkerReports?: PersistentWorkerReportsSliceShape }
  ).persistentWorkerReports;
  return slice;
}

/**
 * Forward-compat shape for `ExpectedDelta.persistentWorkerReports` —
 * Phase 5 widens the frozen-layer `ExpectedDelta` type. Phase 3 reads
 * via a structural cast so the affordance + predicate land AHEAD of the
 * runtime adapter without entangling the frozen-layer expected-delta
 * surface (Cutover-3 P4 / Cutover-4 P4 / Slice K P3 / Cron-Scheduler P4
 * precedent).
 */
type PersistentWorkerReportsExpectedDelta = {
  readonly added?: readonly string[];
};

/**
 * Reads `expectedDelta.persistentWorkerReports` defensively. Returns the
 * shape when present, `undefined` otherwise. Predicates must NEVER widen
 * the frozen-layer delta type themselves (#9 / #11).
 */
function readPersistentWorkerReportsExpectedDelta(
  expectedDelta: ExpectedDelta,
): PersistentWorkerReportsExpectedDelta | undefined {
  const slice = (
    expectedDelta as {
      persistentWorkerReports?: PersistentWorkerReportsExpectedDelta;
    }
  ).persistentWorkerReports;
  return slice;
}

/**
 * Builds the `persistent_worker.subsequent_push` evidence fact carrying
 * the matched record's identity-scoped fields. Phase 7 acceptance grep
 * uses this evidence kind to verify the `[commitment]
 * persistent_worker.subsequent_push effectFamily=communication
 * operationKind=create decision=kernel` log-line emission.
 *
 * The fact's `kind` is keyed off the `EffectId` constant (cast to
 * `string` for the `EvidenceFact.kind` shape). The structural cast
 * preserves invariant #16 (`EffectId` ↛ `EvidenceFact.kind` is just a
 * string field, not a brand carry-over).
 */
function buildEvidenceFact(
  record: DeliveredWorkerReportRecordShape,
): EvidenceFact {
  return {
    kind: PERSISTENT_WORKER_SUBSEQUENT_PUSH_EFFECT as string,
    value: Object.freeze({
      workerRunId: record.workerRunId,
      ownerIdentityId: record.ownerIdentityId,
      completedAt: record.completedAt,
      channel: record.channel,
      to: record.to,
      status: record.status,
    }),
  };
}
