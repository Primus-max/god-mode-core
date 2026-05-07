import type { DonePredicate, EvidenceFact } from "./affordance.js";
import type { ExpectedDelta } from "./expected-delta.js";

/**
 * Slice K Phase 3 — done-predicate for `reminder.delivered`.
 *
 * Verifies that the runtime adapter (Phase 4 `RecallReminderTool`) recorded
 * a reminder query whose `queryId` matches the commitment's expected delta.
 * The predicate observes only `state` / `delta` / `receipts` / `trace` per
 * invariant #9; raw user text and `TaskContract` are NEVER read.
 *
 * Phase 4 wiring: reads `ctx.stateAfter.reminder?.lastQuery` only.
 * Population of the slice is a Phase 4 observer concern
 * (`ReminderWorldStateObserver`); emit is a Phase 4 runtime-adapter
 * concern (`reminder-runtime-adapter.ts`); this predicate is
 * observation-only.
 *
 * `WorldStateSnapshot.reminder` is widened in Phase 4 (cutover-3/4
 * forward-compat shim precedent — see
 * `done-predicate-repo-branch-created.ts`). For Phase 3 the predicate
 * accepts the future shape via a structural cast so the audit
 * deliverable, the registry wiring, and the test bench can land
 * AHEAD of the observer wiring without lying about Phase 4's
 * progress. Predicates must NEVER throw on the empty shape and emit
 * a closed-string sentinel until Phase 4 wiring (#9 sentinel-proxy).
 *
 * Closed missing-key set:
 *  - `reminder.slice_absent` — `WorldStateSnapshot.reminder` slice missing.
 *  - `reminder.last_query.empty` — slice present but `lastQuery` undefined.
 *  - `reminder.delta_empty` — `expectedDelta.reminder.queryId` is absent
 *    (forward-compat shim — Phase 4 runtime adapter populates this).
 *  - `reminder_query_missing:<queryId>` — `lastQuery.queryId` differs
 *    from the delta's expected queryId.
 *
 * **CRITICAL** (sub-plan §3 / acceptance #3):
 * `resultCount === 0` SATISFIES. An operator who asked «какой PDF я
 * делал на прошлой неделе?» and got back zero entries was answered
 * with a structurally correct «no entries in window» — that is a
 * success, not a failure. The predicate emits one
 * `reminder.queried` evidence fact carrying `entriesReturned: 0`
 * for the empty case, not a missing-key sentinel.
 *
 * @param ctx - Predicate context with state snapshots, expected delta,
 *   receipts, and trace.
 * @returns Satisfied with one `reminder.queried` evidence fact when the
 *   queryId matches; otherwise `unsatisfied` with closed-string missing
 *   keys.
 */
export const reminderDeliveredPredicate: DonePredicate = (ctx) => {
  const reminderSlice = readReminderSlice(ctx.stateAfter);
  if (reminderSlice === undefined) {
    return {
      satisfied: false,
      missing: Object.freeze(["reminder.slice_absent"]),
    };
  }

  const lastQuery = reminderSlice.lastQuery;
  if (lastQuery === undefined) {
    return {
      satisfied: false,
      missing: Object.freeze(["reminder.last_query.empty"]),
    };
  }

  const reminderDelta = readReminderExpectedDelta(ctx.expectedDelta);
  const expectedQueryId = reminderDelta?.queryId;
  if (typeof expectedQueryId !== "string" || expectedQueryId.length === 0) {
    return {
      satisfied: false,
      missing: Object.freeze(["reminder.delta_empty"]),
    };
  }

  if (lastQuery.queryId !== expectedQueryId) {
    return {
      satisfied: false,
      missing: Object.freeze([`reminder_query_missing:${expectedQueryId}`]),
    };
  }

  // resultCount=0 SATISFIES — zero entries IS success per sub-plan §3.
  const evidence: EvidenceFact[] = [
    {
      kind: "reminder.queried",
      value: Object.freeze({
        queryId: lastQuery.queryId,
        entriesReturned: lastQuery.resultCount,
        observedAt: lastQuery.observedAt,
      }),
    },
  ];

  return { satisfied: true, evidence: Object.freeze(evidence) };
};

/**
 * Forward-compat shape for `WorldStateSnapshot.reminder.lastQuery` —
 * Phase 4 will widen `world-state.ts` with a real
 * `ReminderWorldState` slice. The done-predicate reads via a
 * structural cast so Phase 3 lands the affordance + predicate
 * without entangling the observer wiring (cutover-4 Phase 4
 * precedent: `repo` delta accessed via the same shape-only cast).
 */
type ReminderQueryRecordShape = {
  readonly queryId: string;
  readonly resultCount: number;
  readonly observedAt?: string;
};

type ReminderWorldStateShape = {
  readonly lastQuery?: ReminderQueryRecordShape;
};

/**
 * Reads the forward-compat `reminder` slice from `WorldStateSnapshot`
 * without widening the frozen-layer `WorldStateSnapshot` type. Returns
 * the closed `lastQuery` shape the runtime adapter (Phase 4) will
 * populate, or `undefined` when the observer is not yet wired.
 */
function readReminderSlice(
  stateAfter: Parameters<DonePredicate>[0]["stateAfter"],
): ReminderWorldStateShape | undefined {
  const slice = (stateAfter as { reminder?: ReminderWorldStateShape })
    .reminder;
  return slice;
}

type ReminderExpectedDelta = {
  readonly queryId?: string;
};

/**
 * Reads the forward-compat `reminder.queryId` slice from
 * `ExpectedDelta`. Phase 4 will declare the corresponding type on
 * `ExpectedDelta`; for Phase 3 the predicate reads via a structural
 * cast — predicates must NEVER widen the frozen-layer delta type
 * themselves (#9 / #11).
 */
function readReminderExpectedDelta(
  expectedDelta: ExpectedDelta,
): ReminderExpectedDelta | undefined {
  const reminder = (expectedDelta as { reminder?: ReminderExpectedDelta })
    .reminder;
  return reminder;
}
