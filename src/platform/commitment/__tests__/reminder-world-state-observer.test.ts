import { describe, expect, it } from "vitest";

import type { SessionId } from "../ids.js";
import {
  createReminderWorldStateCollector,
  createReminderWorldStateObserver,
  type ReminderTurnKey,
} from "../reminder-world-state-observer.js";
import type { ReminderQueryRecord } from "../world-state.js";

const SESSION_A = "session:a" as SessionId;
const SESSION_B = "session:b" as SessionId;
const ISO_NOW = "2026-05-07T12:00:00.000Z";

function turnKey(sessionId: SessionId, turnId: string): ReminderTurnKey {
  return { sessionId, turnId };
}

function rec(
  overrides: Partial<ReminderQueryRecord> = {},
): ReminderQueryRecord {
  return {
    queryId: "rem:q-1",
    resultCount: 3,
    observedAt: ISO_NOW as ReminderQueryRecord["observedAt"],
    ...overrides,
  };
}

describe("ReminderWorldStateObserver — slice K Phase 4", () => {
  it("round-trips a recorded reminder query through the observer (active turn)", () => {
    const collector = createReminderWorldStateCollector();
    const observer = createReminderWorldStateObserver(collector);

    collector.record(rec(), turnKey(SESSION_A, "turn-1"));
    collector.setActiveTurn(turnKey(SESSION_A, "turn-1"));

    const snapshot = observer.observe();
    expect(snapshot).toBeDefined();
    expect(snapshot?.lastQuery?.queryId).toBe("rem:q-1");
    expect(snapshot?.lastQuery?.resultCount).toBe(3);
  });

  it("returns undefined from observe() when no active turn is set", () => {
    const collector = createReminderWorldStateCollector();
    const observer = createReminderWorldStateObserver(collector);
    collector.record(rec(), turnKey(SESSION_A, "turn-1"));
    expect(observer.observe()).toBeUndefined();
  });

  it("resetForTurn drops every record bucketed under the key", () => {
    const collector = createReminderWorldStateCollector();
    const observer = createReminderWorldStateObserver(collector);

    collector.record(rec(), turnKey(SESSION_A, "turn-1"));
    collector.setActiveTurn(turnKey(SESSION_A, "turn-1"));
    expect(observer.observe()?.lastQuery?.queryId).toBe("rem:q-1");

    collector.resetForTurn(turnKey(SESSION_A, "turn-1"));
    expect(observer.observe()).toBeUndefined();
  });

  it("perTurnLimit defaults to 1 — second record in the same turn evicts the first (single-shot per turn)", () => {
    const collector = createReminderWorldStateCollector();
    const observer = createReminderWorldStateObserver(collector);

    collector.record(rec({ queryId: "rem:first", resultCount: 1 }), turnKey(SESSION_A, "turn-1"));
    collector.record(rec({ queryId: "rem:second", resultCount: 2 }), turnKey(SESSION_A, "turn-1"));
    collector.setActiveTurn(turnKey(SESSION_A, "turn-1"));

    const snapshot = observer.observe();
    expect(snapshot?.lastQuery?.queryId).toBe("rem:second");
    expect(snapshot?.lastQuery?.resultCount).toBe(2);
  });

  it("sessionId isolation — operator A's record never appears in operator B's active slice", () => {
    const collector = createReminderWorldStateCollector();
    const observer = createReminderWorldStateObserver(collector);

    collector.record(rec({ queryId: "rem:A" }), turnKey(SESSION_A, "turn-1"));
    collector.record(rec({ queryId: "rem:B" }), turnKey(SESSION_B, "turn-1"));

    collector.setActiveTurn(turnKey(SESSION_A, "turn-1"));
    expect(observer.observe()?.lastQuery?.queryId).toBe("rem:A");

    collector.setActiveTurn(turnKey(SESSION_B, "turn-1"));
    expect(observer.observe()?.lastQuery?.queryId).toBe("rem:B");

    // sessionId-isolation reverse — neither bucket leaks into the other.
    expect(collector.getLastQueryForTurn(turnKey(SESSION_A, "turn-1"))?.queryId).toBe("rem:A");
    expect(collector.getLastQueryForTurn(turnKey(SESSION_B, "turn-1"))?.queryId).toBe("rem:B");
  });

  it("last-writer-wins on queryId (forward-compat — perTurnLimit=2 fixture)", () => {
    const collector = createReminderWorldStateCollector({ perTurnLimit: 2 });

    collector.record(rec({ queryId: "rem:dup", resultCount: 1 }), turnKey(SESSION_A, "turn-1"));
    collector.record(rec({ queryId: "rem:other", resultCount: 9 }), turnKey(SESSION_A, "turn-1"));
    collector.record(rec({ queryId: "rem:dup", resultCount: 7 }), turnKey(SESSION_A, "turn-1"));
    collector.setActiveTurn(turnKey(SESSION_A, "turn-1"));

    // perTurnLimit=2 keeps the two unique entries; rem:dup's resultCount
    // is the new value (7), not the old (1).
    const last = collector.getActiveLastQuery();
    expect(last?.queryId).toBe("rem:dup");
    expect(last?.resultCount).toBe(7);
  });

  it("rejects malformed records — empty queryId throws via Zod", () => {
    const collector = createReminderWorldStateCollector();
    expect(() =>
      collector.record(
        { queryId: "", resultCount: 0, observedAt: ISO_NOW as ReminderQueryRecord["observedAt"] },
        turnKey(SESSION_A, "turn-1"),
      ),
    ).toThrow();
  });

  it("rejects malformed records — negative resultCount throws via Zod", () => {
    const collector = createReminderWorldStateCollector();
    expect(() =>
      collector.record(
        {
          queryId: "rem:bad",
          resultCount: -1,
          observedAt: ISO_NOW as ReminderQueryRecord["observedAt"],
        },
        turnKey(SESSION_A, "turn-1"),
      ),
    ).toThrow();
  });

  it("setActiveTurn(undefined) clears the pointer so observe() returns undefined", () => {
    const collector = createReminderWorldStateCollector();
    const observer = createReminderWorldStateObserver(collector);

    collector.record(rec(), turnKey(SESSION_A, "turn-1"));
    collector.setActiveTurn(turnKey(SESSION_A, "turn-1"));
    expect(observer.observe()).toBeDefined();

    collector.setActiveTurn(undefined);
    expect(observer.observe()).toBeUndefined();
  });
});
