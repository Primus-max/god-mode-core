import type { DonePredicate, EvidenceFact } from "./affordance.js";
import type { ExpectedDelta } from "./expected-delta.js";
import type { ScheduledReminderRecord } from "./world-state.js";

/**
 * Cron/Scheduler Phase 4 — done-predicate for `reminder.set`.
 *
 * Verifies that the runtime adapter (Phase 5
 * `ScheduledReminderRuntimeAdapter`) recorded a scheduled reminder whose
 * `reminderId` was emitted via the commitment's `expectedDelta.scheduledReminders.added`
 * list and whose `status` is `pending` (the cron-callback was registered;
 * the actual `fired` transition is downstream — Phase 5 cron-fire callback).
 *
 * The predicate observes only `state` / `delta` / `receipts` / `trace` per
 * invariant #9; raw user text and `TaskContract` are NEVER read.
 *
 * Phase 4 wiring: reads `ctx.stateAfter.scheduledReminders?.records` (Phase 3
 * world-state slice) only. Population of the slice is a Phase 3 observer
 * concern (`ScheduledReminderObserver`); emit is a Phase 5 runtime-adapter
 * concern (`scheduled-reminder-runtime-adapter.ts`); this predicate is
 * observation-only.
 *
 * `expectedDelta.scheduledReminders.added` is widened in Phase 5 (Cutover-3 P4
 * / Cutover-4 P4 / Slice K P3 forward-compat shim precedent — `expected-delta.ts`
 * does NOT yet declare a `scheduledReminders` slice). For Phase 4 the
 * predicate accepts the future `added: readonly string[]` shape via a
 * structural cast — predicates must NEVER throw on the empty shape and emit
 * a closed-string sentinel until Phase 5 wiring (#9 sentinel-proxy).
 *
 * Closed missing-key set (sub-plan §1 todo Phase 4):
 *  - `scheduled_reminders.slice_absent` — `WorldStateSnapshot.scheduledReminders`
 *    slice missing entirely.
 *  - `scheduled_reminders.records.empty` — slice present but no records observed.
 *  - `scheduled_reminders.delta_empty` — `expectedDelta.scheduledReminders.added`
 *    is absent or empty (Phase 5 runtime adapter populates this).
 *  - `reminder_record_missing:<id>` — record with matching `reminderId` not
 *    found in observed slice.
 *  - `reminder_record_status_unexpected:<id>:<status>` — record found but its
 *    `status` is not the canonical `pending`. Cron-fire happens via the
 *    scheduler at `fireAt`; the done-predicate runs immediately after the
 *    `RecordReminderTool` emit, so any non-pending status at that boundary is
 *    a structural anomaly (cancelled / fired / unknown).
 *
 * **NEVER throws** — every malformed shape (missing slice, missing records
 * key, missing reminderId on a record, non-array `added`) yields a
 * closed-string sentinel via the missing-key set above.
 *
 * @param ctx - Predicate context with state snapshots, expected delta,
 *   receipts, and trace.
 * @returns Satisfied with one `reminder.scheduled` evidence fact carrying
 *   the matched record's identity-scoped fields when the reminderId is
 *   present and `status === 'pending'`; otherwise `unsatisfied` with
 *   closed-string missing keys.
 */
export const reminderSetPredicate: DonePredicate = (ctx) => {
  const slice = readScheduledRemindersSlice(ctx.stateAfter);
  if (slice === undefined) {
    return {
      satisfied: false,
      missing: Object.freeze(["scheduled_reminders.slice_absent"]),
    };
  }

  const records = Array.isArray(slice.records) ? slice.records : undefined;
  if (records === undefined || records.length === 0) {
    return {
      satisfied: false,
      missing: Object.freeze(["scheduled_reminders.records.empty"]),
    };
  }

  const delta = readScheduledRemindersExpectedDelta(ctx.expectedDelta);
  const expectedAdded = Array.isArray(delta?.added) ? delta.added : [];
  if (expectedAdded.length === 0) {
    return {
      satisfied: false,
      missing: Object.freeze(["scheduled_reminders.delta_empty"]),
    };
  }

  const recordsById = new Map<string, ScheduledReminderRecord>();
  for (const record of records) {
    if (record && typeof record.reminderId === "string") {
      recordsById.set(record.reminderId, record);
    }
  }

  const missing: string[] = [];
  const evidence: EvidenceFact[] = [];
  for (const reminderId of expectedAdded) {
    if (typeof reminderId !== "string" || reminderId.length === 0) {
      continue;
    }
    const record = recordsById.get(reminderId);
    if (!record) {
      missing.push(`reminder_record_missing:${reminderId}`);
      continue;
    }
    if (record.status !== "pending") {
      missing.push(
        `reminder_record_status_unexpected:${reminderId}:${record.status}`,
      );
      continue;
    }
    evidence.push({
      kind: "reminder.scheduled",
      value: Object.freeze({
        reminderId: record.reminderId,
        ownerIdentityId: record.ownerIdentityId,
        fireAt: record.fireAt,
        deliveryChannel: record.deliveryChannel,
        deliveryTo: record.deliveryTo,
        createdAt: record.createdAt,
        status: record.status,
      }),
    });
  }

  return missing.length === 0
    ? { satisfied: true, evidence: Object.freeze(evidence) }
    : { satisfied: false, missing: Object.freeze(missing) };
};

/**
 * Forward-compat shape for `WorldStateSnapshot.scheduledReminders`. Phase 3
 * widens `world-state.ts` with the real `ScheduledRemindersSlice`; this
 * structural reader stays defensive against malformed slice shapes (#9
 * sentinel-proxy) without taking a hard dependency on the Phase 3 type.
 */
type ScheduledRemindersSliceShape = {
  readonly records?: readonly ScheduledReminderRecord[];
};

/**
 * Reads `WorldStateSnapshot.scheduledReminders` defensively. Returns the slice
 * shape when present, `undefined` otherwise. Predicates must NEVER throw on
 * the empty shape (#9).
 */
function readScheduledRemindersSlice(
  stateAfter: Parameters<DonePredicate>[0]["stateAfter"],
): ScheduledRemindersSliceShape | undefined {
  const slice = (
    stateAfter as { scheduledReminders?: ScheduledRemindersSliceShape }
  ).scheduledReminders;
  return slice;
}

/**
 * Forward-compat shape for `ExpectedDelta.scheduledReminders` — Phase 5
 * widens the frozen-layer `ExpectedDelta` type. Phase 4 reads via a
 * structural cast so the affordance + predicate land AHEAD of the runtime
 * adapter without entangling the frozen-layer expected-delta surface
 * (Cutover-3 P4 / Cutover-4 P4 / Slice K P3 precedent).
 */
type ScheduledRemindersExpectedDelta = {
  readonly added?: readonly string[];
};

/**
 * Reads `expectedDelta.scheduledReminders` defensively. Returns the shape
 * when present, `undefined` otherwise. Predicates must NEVER widen the
 * frozen-layer delta type themselves (#9 / #11).
 */
function readScheduledRemindersExpectedDelta(
  expectedDelta: ExpectedDelta,
): ScheduledRemindersExpectedDelta | undefined {
  const slice = (
    expectedDelta as { scheduledReminders?: ScheduledRemindersExpectedDelta }
  ).scheduledReminders;
  return slice;
}
