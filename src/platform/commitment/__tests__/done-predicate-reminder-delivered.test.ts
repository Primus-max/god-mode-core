import { describe, expect, it } from "vitest";
import { reminderDeliveredPredicate } from "../done-predicate-reminder-delivered.js";
import type { DonePredicateCtx } from "../affordance.js";
import type { ExpectedDelta } from "../expected-delta.js";
import type { WorldStateSnapshot } from "../world-state.js";

const EMPTY_DELTA: ExpectedDelta = Object.freeze({});

function makeCtx(
  stateAfter: WorldStateSnapshot,
  expectedDelta: ExpectedDelta = EMPTY_DELTA,
): DonePredicateCtx {
  return {
    stateBefore: Object.freeze({}),
    stateAfter,
    expectedDelta,
    receipts: { entries: [] },
    trace: { steps: [] },
  };
}

// Slice K Phase 3 forward-compat shim — `WorldStateSnapshot.reminder` and
// `ExpectedDelta.reminder` are widened in Phase 4 (cutover-3/4 precedent).
// The Phase 3 predicate reads via structural cast; the test bench mirrors
// that by carrying the future shape through `as unknown as ...` casts.
function withReminderState(
  reminder: { lastQuery?: { queryId: string; resultCount: number; observedAt?: string } } | undefined,
): WorldStateSnapshot {
  if (reminder === undefined) {
    return Object.freeze({});
  }
  return Object.freeze({
    reminder: Object.freeze({
      ...(reminder.lastQuery !== undefined
        ? { lastQuery: Object.freeze({ ...reminder.lastQuery }) }
        : {}),
    }),
  } as unknown as WorldStateSnapshot);
}

function withDelta(queryId: string | undefined): ExpectedDelta {
  if (queryId === undefined) {
    return EMPTY_DELTA;
  }
  return Object.freeze({
    reminder: Object.freeze({ queryId }),
  } as unknown as ExpectedDelta);
}

describe("reminderDeliveredPredicate — slice K Phase 3", () => {
  it("returns satisfied with one `reminder.queried` evidence fact when lastQuery.queryId matches the delta and resultCount > 0", () => {
    const ctx = makeCtx(
      withReminderState({
        lastQuery: { queryId: "rem-q-1", resultCount: 3, observedAt: "2026-05-07T12:00:00.000Z" },
      }),
      withDelta("rem-q-1"),
    );

    const result = reminderDeliveredPredicate(ctx);

    expect(result.satisfied).toBe(true);
    if (result.satisfied) {
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]?.kind).toBe("reminder.queried");
      expect(
        (result.evidence[0]?.value as { queryId: string }).queryId,
      ).toBe("rem-q-1");
      expect(
        (result.evidence[0]?.value as { entriesReturned: number }).entriesReturned,
      ).toBe(3);
    }
  });

  it("CRITICAL: returns satisfied when resultCount === 0 (zero entries IS success — operator was answered with structurally correct «no entries in window»)", () => {
    const ctx = makeCtx(
      withReminderState({
        lastQuery: { queryId: "rem-q-empty", resultCount: 0, observedAt: "2026-05-07T12:00:00.000Z" },
      }),
      withDelta("rem-q-empty"),
    );

    const result = reminderDeliveredPredicate(ctx);

    expect(result.satisfied).toBe(true);
    if (result.satisfied) {
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]?.kind).toBe("reminder.queried");
      expect(
        (result.evidence[0]?.value as { entriesReturned: number }).entriesReturned,
      ).toBe(0);
      expect(
        (result.evidence[0]?.value as { queryId: string }).queryId,
      ).toBe("rem-q-empty");
    }
  });

  it("returns unsatisfied with `reminder.slice_absent` when WorldStateSnapshot lacks the slice", () => {
    const ctx = makeCtx(Object.freeze({}), withDelta("rem-q-1"));

    const result = reminderDeliveredPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["reminder.slice_absent"]);
    }
  });

  it("returns unsatisfied with `reminder.slice_absent` when reminder slice is explicitly undefined", () => {
    const ctx = makeCtx(withReminderState(undefined), withDelta("rem-q-1"));

    const result = reminderDeliveredPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["reminder.slice_absent"]);
    }
  });

  it("returns unsatisfied with `reminder.last_query.empty` when slice exists but lastQuery is undefined", () => {
    const ctx = makeCtx(
      // Empty reminder slice, no lastQuery yet.
      Object.freeze({ reminder: Object.freeze({}) } as unknown as WorldStateSnapshot),
      withDelta("rem-q-1"),
    );

    const result = reminderDeliveredPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["reminder.last_query.empty"]);
    }
  });

  it("returns unsatisfied with `reminder.delta_empty` when expectedDelta carries no reminder.queryId (Phase 3 forward-compat shim)", () => {
    const ctx = makeCtx(
      withReminderState({
        lastQuery: { queryId: "rem-q-1", resultCount: 2 },
      }),
      EMPTY_DELTA,
    );

    const result = reminderDeliveredPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["reminder.delta_empty"]);
    }
  });

  it("returns unsatisfied with `reminder_query_missing:<id>` when lastQuery.queryId differs from the expected delta queryId", () => {
    const ctx = makeCtx(
      withReminderState({
        lastQuery: { queryId: "rem-q-other", resultCount: 5 },
      }),
      withDelta("rem-q-1"),
    );

    const result = reminderDeliveredPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["reminder_query_missing:rem-q-1"]);
    }
  });

  it("does not throw on hostile / sentinel state-before access (invariant #9 sentinel-proxy)", () => {
    let touchedRawText = false;
    const sentinelStateBefore = new Proxy({}, {
      get(_target, prop) {
        if (prop === "rawUserTurn" || prop === "taskContract") {
          touchedRawText = true;
        }
        return undefined;
      },
    }) as WorldStateSnapshot;
    const ctx: DonePredicateCtx = {
      stateBefore: sentinelStateBefore,
      stateAfter: withReminderState({
        lastQuery: { queryId: "rem-q-1", resultCount: 0 },
      }),
      expectedDelta: withDelta("rem-q-1"),
      receipts: { entries: [] },
      trace: { steps: [] },
    };

    expect(() => reminderDeliveredPredicate(ctx)).not.toThrow();
    expect(touchedRawText).toBe(false);
  });

  it("does not throw when receipts/trace are present (sub-plan §3 — receipts may be supplied; predicate stays observation-only)", () => {
    const ctx: DonePredicateCtx = {
      stateBefore: Object.freeze({}),
      stateAfter: withReminderState({
        lastQuery: { queryId: "rem-q-1", resultCount: 1 },
      }),
      expectedDelta: withDelta("rem-q-1"),
      receipts: {
        entries: [
          { kind: "reminder.queried", payload: Object.freeze({ queryId: "rem-q-1" }) },
        ],
      },
      trace: { steps: [{ at: "2026-05-07T11:00:00.000Z" as never, note: "shadow" }] },
    };

    expect(() => reminderDeliveredPredicate(ctx)).not.toThrow();
    const result = reminderDeliveredPredicate(ctx);
    expect(result.satisfied).toBe(true);
  });
});
