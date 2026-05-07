import { describe, expect, it } from "vitest";
import type { IdentityId } from "../../identity/identity-id.js";
import { reminderSetPredicate } from "../done-predicate-reminder-set.js";
import type { ChannelId, ISO8601 } from "../ids.js";
import type {
  ScheduledReminderRecord,
  ScheduledRemindersSlice,
  WorldStateSnapshot,
} from "../world-state.js";
import type { ExpectedDelta } from "../expected-delta.js";

const REMINDER_ID = "reminder-test-1";
const OWNER_IDENTITY = "identity:operator-a" as IdentityId;
const FIRE_AT = "2026-05-08T12:00:00Z" as ISO8601;
const CREATED_AT = "2026-05-07T10:00:00Z" as ISO8601;

function buildRecord(
  overrides: Partial<ScheduledReminderRecord> = {},
): ScheduledReminderRecord {
  return Object.freeze({
    reminderId: REMINDER_ID,
    ownerIdentityId: OWNER_IDENTITY,
    fireAt: FIRE_AT,
    content: "позвонить клиенту X",
    deliveryChannel: "telegram" as ChannelId,
    deliveryTo: "6533456892",
    createdAt: CREATED_AT,
    status: "pending",
    ...overrides,
  });
}

function buildState(
  records: readonly ScheduledReminderRecord[] | undefined,
): WorldStateSnapshot {
  if (records === undefined) {
    return Object.freeze({});
  }
  const slice: ScheduledRemindersSlice = Object.freeze({
    records: Object.freeze([...records]),
  });
  return Object.freeze({ scheduledReminders: slice });
}

function buildDelta(addedReminderIds: readonly string[] | undefined): ExpectedDelta {
  if (addedReminderIds === undefined) {
    return Object.freeze({});
  }
  // Forward-compat shape — Phase 5 will widen `ExpectedDelta`. The
  // predicate reads via structural cast (slice K precedent).
  return Object.freeze({
    scheduledReminders: Object.freeze({
      added: Object.freeze([...addedReminderIds]),
    }),
  } as unknown as ExpectedDelta);
}

function buildCtx(
  state: WorldStateSnapshot,
  delta: ExpectedDelta,
): Parameters<typeof reminderSetPredicate>[0] {
  return {
    stateBefore: Object.freeze({}),
    stateAfter: state,
    expectedDelta: delta,
    receipts: { entries: [] },
    trace: { steps: [] },
  };
}

describe("reminderSetPredicate (Cron/Scheduler Phase 4 done-predicate)", () => {
  it("returns scheduled_reminders.slice_absent when WorldStateSnapshot.scheduledReminders is undefined", () => {
    const result = reminderSetPredicate(
      buildCtx(buildState(undefined), buildDelta([REMINDER_ID])),
    );
    expect(result.satisfied).toBe(false);
    expect(result.satisfied === false ? result.missing : []).toEqual([
      "scheduled_reminders.slice_absent",
    ]);
  });

  it("returns scheduled_reminders.records.empty when slice present but records list is empty", () => {
    const result = reminderSetPredicate(
      buildCtx(buildState([]), buildDelta([REMINDER_ID])),
    );
    expect(result.satisfied).toBe(false);
    expect(result.satisfied === false ? result.missing : []).toEqual([
      "scheduled_reminders.records.empty",
    ]);
  });

  it("returns scheduled_reminders.delta_empty when expectedDelta.scheduledReminders.added is missing or empty", () => {
    const stateWithRecord = buildState([buildRecord()]);

    const noDelta = reminderSetPredicate(buildCtx(stateWithRecord, buildDelta(undefined)));
    expect(noDelta.satisfied).toBe(false);
    expect(noDelta.satisfied === false ? noDelta.missing : []).toEqual([
      "scheduled_reminders.delta_empty",
    ]);

    const emptyDelta = reminderSetPredicate(buildCtx(stateWithRecord, buildDelta([])));
    expect(emptyDelta.satisfied).toBe(false);
    expect(emptyDelta.satisfied === false ? emptyDelta.missing : []).toEqual([
      "scheduled_reminders.delta_empty",
    ]);
  });

  it("satisfies when matching record carries status='pending'", () => {
    const result = reminderSetPredicate(
      buildCtx(buildState([buildRecord({ status: "pending" })]), buildDelta([REMINDER_ID])),
    );
    expect(result.satisfied).toBe(true);
    if (result.satisfied) {
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]?.kind).toBe("reminder.scheduled");
    }
  });

  it("returns reminder_record_status_unexpected:<id>:cancelled when matching record is cancelled", () => {
    const result = reminderSetPredicate(
      buildCtx(
        buildState([buildRecord({ status: "cancelled" })]),
        buildDelta([REMINDER_ID]),
      ),
    );
    expect(result.satisfied).toBe(false);
    expect(result.satisfied === false ? result.missing : []).toEqual([
      `reminder_record_status_unexpected:${REMINDER_ID}:cancelled`,
    ]);
  });

  it("returns reminder_record_status_unexpected:<id>:fired when matching record fired before predicate ran", () => {
    // Sub-plan §1 todo Phase 4: «status `fired` → audit decides ... sub-plan
    // suggests `pending` is canonical satisfy». Cron-fire happens via the
    // scheduler at fireAt; the done-predicate runs immediately after the
    // RecordReminderTool emit, so a `fired` status at that boundary is a
    // structural anomaly (not a satisfy).
    const result = reminderSetPredicate(
      buildCtx(buildState([buildRecord({ status: "fired" })]), buildDelta([REMINDER_ID])),
    );
    expect(result.satisfied).toBe(false);
    expect(result.satisfied === false ? result.missing : []).toEqual([
      `reminder_record_status_unexpected:${REMINDER_ID}:fired`,
    ]);
  });

  it("returns reminder_record_missing:<id> when expected reminderId is not in the slice", () => {
    const result = reminderSetPredicate(
      buildCtx(
        buildState([buildRecord({ reminderId: "other-reminder" })]),
        buildDelta([REMINDER_ID]),
      ),
    );
    expect(result.satisfied).toBe(false);
    expect(result.satisfied === false ? result.missing : []).toEqual([
      `reminder_record_missing:${REMINDER_ID}`,
    ]);
  });

  it("with multiple records, satisfies on the matching record only and emits one evidence fact", () => {
    const matching = buildRecord({ reminderId: REMINDER_ID, status: "pending" });
    const sibling = buildRecord({
      reminderId: "sibling-reminder",
      status: "pending",
    });
    const result = reminderSetPredicate(
      buildCtx(buildState([sibling, matching]), buildDelta([REMINDER_ID])),
    );
    expect(result.satisfied).toBe(true);
    if (result.satisfied) {
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]?.kind).toBe("reminder.scheduled");
      const value = result.evidence[0]?.value as { reminderId?: string };
      expect(value.reminderId).toBe(REMINDER_ID);
    }
  });

  it("sentinel-proxy: never throws on malformed/missing inputs (#9)", () => {
    // Empty everything.
    expect(() =>
      reminderSetPredicate(buildCtx(Object.freeze({}), Object.freeze({}))),
    ).not.toThrow();

    // Slice present, records missing key entirely.
    const malformedSlice = {
      scheduledReminders: Object.freeze({}),
    } as unknown as WorldStateSnapshot;
    expect(() =>
      reminderSetPredicate(buildCtx(malformedSlice, buildDelta([REMINDER_ID]))),
    ).not.toThrow();

    // Record without a reminderId field.
    const broken = {
      scheduledReminders: Object.freeze({
        records: Object.freeze([
          Object.freeze({ status: "pending" }),
        ] as unknown as readonly ScheduledReminderRecord[]),
      }),
    } as unknown as WorldStateSnapshot;
    expect(() =>
      reminderSetPredicate(buildCtx(broken, buildDelta([REMINDER_ID]))),
    ).not.toThrow();

    // Delta with non-array `added`.
    const malformedDelta = {
      scheduledReminders: { added: "not-an-array" },
    } as unknown as ExpectedDelta;
    expect(() =>
      reminderSetPredicate(
        buildCtx(buildState([buildRecord()]), malformedDelta),
      ),
    ).not.toThrow();
  });

  it("emits evidence carrying the matched record's identity-scoped fields", () => {
    const result = reminderSetPredicate(
      buildCtx(buildState([buildRecord()]), buildDelta([REMINDER_ID])),
    );
    expect(result.satisfied).toBe(true);
    if (result.satisfied) {
      const value = result.evidence[0]?.value as {
        reminderId?: string;
        ownerIdentityId?: string;
        fireAt?: string;
        status?: string;
      };
      expect(value.reminderId).toBe(REMINDER_ID);
      expect(value.ownerIdentityId).toBe(OWNER_IDENTITY);
      expect(value.fireAt).toBe(FIRE_AT);
      expect(value.status).toBe("pending");
    }
  });
});
