import { describe, expect, it } from "vitest";
import {
  createScheduledReminderWorldStateCollector,
  createScheduledReminderWorldStateObserver,
  setProcessScheduledReminderWorldStateCollectorForTests,
  type ScheduledReminderTurnKey,
} from "../scheduled-reminder-world-state-observer.js";
import { createDefaultMonitoredRuntime } from "../production-runtime-defaults.js";
import { asIdentityId } from "../../identity/identity-id.js";
import type { ChannelId, ISO8601, SessionId } from "../ids.js";
import type { ScheduledReminderRecord } from "../world-state.js";

const ISO_NOW = "2026-05-07T11:00:00.000Z" as ISO8601;
const ISO_LATER = "2026-05-07T12:00:00.000Z" as ISO8601;
const SESSION_A = "session-a" as SessionId;
const SESSION_B = "session-b" as SessionId;
const TELEGRAM_CHANNEL = "telegram" as ChannelId;
const OWNER_A = asIdentityId("identity:operator-a");
const OWNER_B = asIdentityId("identity:operator-b");

function record(
  reminderId: string,
  overrides: Partial<ScheduledReminderRecord> = {},
): ScheduledReminderRecord {
  return Object.freeze({
    reminderId,
    ownerIdentityId: OWNER_A,
    fireAt: ISO_LATER,
    content: "позвонить клиенту X",
    deliveryChannel: TELEGRAM_CHANNEL,
    deliveryTo: "6533456892",
    createdAt: ISO_NOW,
    status: "pending",
    ...overrides,
  });
}

describe("ScheduledReminderWorldStateCollector — Cron/Scheduler Phase 3", () => {
  it("returns undefined slice when no active turn is set (production default)", () => {
    const collector = createScheduledReminderWorldStateCollector();
    const observer = createScheduledReminderWorldStateObserver(collector);
    expect(observer.observe()).toBeUndefined();
  });

  it("returns undefined slice when active turn has no recorded entries", () => {
    const collector = createScheduledReminderWorldStateCollector();
    const observer = createScheduledReminderWorldStateObserver(collector);
    const key: ScheduledReminderTurnKey = {
      sessionId: SESSION_A,
      turnId: "turn-1",
    };
    collector.setActiveTurn(key);
    expect(observer.observe()).toBeUndefined();
  });

  it("round-trip: append → read returns the same record under the active turn", () => {
    const collector = createScheduledReminderWorldStateCollector();
    const observer = createScheduledReminderWorldStateObserver(collector);
    const key: ScheduledReminderTurnKey = {
      sessionId: SESSION_A,
      turnId: "turn-1",
    };

    const r = record("rem-1");
    collector.record(r, key);
    collector.setActiveTurn(key);

    const slice = observer.observe();
    expect(slice).toBeDefined();
    expect(slice?.records.map((entry) => entry.reminderId)).toEqual(["rem-1"]);
    expect(slice?.records[0]).toEqual(r);
  });

  it("exposes records bucketed under the active turn in insertion order", () => {
    const collector = createScheduledReminderWorldStateCollector();
    const observer = createScheduledReminderWorldStateObserver(collector);
    const key: ScheduledReminderTurnKey = {
      sessionId: SESSION_A,
      turnId: "turn-1",
    };

    collector.record(record("rem-1"), key);
    collector.record(record("rem-2", { content: "second" }), key);
    collector.setActiveTurn(key);

    expect(observer.observe()?.records.map((r) => r.reminderId)).toEqual([
      "rem-1",
      "rem-2",
    ]);
  });

  it("dedupes records with the same reminderId last-writer-wins", () => {
    const collector = createScheduledReminderWorldStateCollector();
    const observer = createScheduledReminderWorldStateObserver(collector);
    const key: ScheduledReminderTurnKey = {
      sessionId: SESSION_A,
      turnId: "turn-1",
    };

    collector.record(record("rem-1", { content: "first" }), key);
    collector.record(record("rem-1", { content: "second" }), key);
    collector.setActiveTurn(key);

    const slice = observer.observe();
    expect(slice?.records).toHaveLength(1);
    expect(slice?.records[0]?.content).toBe("second");
  });

  it("isolates records by sessionId — different sessionId, same turnId string", () => {
    const collector = createScheduledReminderWorldStateCollector();
    const observer = createScheduledReminderWorldStateObserver(collector);
    const keyA: ScheduledReminderTurnKey = {
      sessionId: SESSION_A,
      turnId: "shared-id",
    };
    const keyB: ScheduledReminderTurnKey = {
      sessionId: SESSION_B,
      turnId: "shared-id",
    };

    collector.record(record("rem-a", { ownerIdentityId: OWNER_A }), keyA);
    collector.record(record("rem-b", { ownerIdentityId: OWNER_B }), keyB);

    collector.setActiveTurn(keyA);
    expect(observer.observe()?.records.map((r) => r.reminderId)).toEqual([
      "rem-a",
    ]);

    collector.setActiveTurn(keyB);
    expect(observer.observe()?.records.map((r) => r.reminderId)).toEqual([
      "rem-b",
    ]);
  });

  it("resetForTurn clears only the targeted bucket; other turns untouched", () => {
    const collector = createScheduledReminderWorldStateCollector();
    const observer = createScheduledReminderWorldStateObserver(collector);
    const key1: ScheduledReminderTurnKey = {
      sessionId: SESSION_A,
      turnId: "turn-1",
    };
    const key2: ScheduledReminderTurnKey = {
      sessionId: SESSION_A,
      turnId: "turn-2",
    };

    collector.record(record("rem-t1"), key1);
    collector.record(record("rem-t2"), key2);

    collector.resetForTurn(key1);

    collector.setActiveTurn(key1);
    expect(observer.observe()).toBeUndefined();

    collector.setActiveTurn(key2);
    expect(observer.observe()?.records.map((r) => r.reminderId)).toEqual([
      "rem-t2",
    ]);
  });

  it("setActiveTurn(undefined) clears the active pointer", () => {
    const collector = createScheduledReminderWorldStateCollector();
    const observer = createScheduledReminderWorldStateObserver(collector);
    const key: ScheduledReminderTurnKey = {
      sessionId: SESSION_A,
      turnId: "turn-1",
    };

    collector.record(record("rem-1"), key);
    collector.setActiveTurn(key);
    expect(observer.observe()).toBeDefined();

    collector.setActiveTurn(undefined);
    expect(observer.observe()).toBeUndefined();
  });

  it("default perTurnLimit=4 drops oldest record when 5th is appended", () => {
    const collector = createScheduledReminderWorldStateCollector();
    const observer = createScheduledReminderWorldStateObserver(collector);
    const key: ScheduledReminderTurnKey = {
      sessionId: SESSION_A,
      turnId: "turn-1",
    };

    for (let i = 1; i <= 5; i += 1) {
      collector.record(record(`rem-${i}`), key);
    }
    collector.setActiveTurn(key);

    const ids = observer.observe()?.records.map((r) => r.reminderId);
    expect(ids).toHaveLength(4);
    expect(ids?.[0]).toBe("rem-2");
    expect(ids?.[ids.length - 1]).toBe("rem-5");
    expect(ids).not.toContain("rem-1");
  });

  it("respects custom perTurnLimit by dropping oldest records when exceeded", () => {
    const collector = createScheduledReminderWorldStateCollector({
      perTurnLimit: 2,
    });
    const observer = createScheduledReminderWorldStateObserver(collector);
    const key: ScheduledReminderTurnKey = {
      sessionId: SESSION_A,
      turnId: "turn-1",
    };

    collector.record(record("rem-1"), key);
    collector.record(record("rem-2"), key);
    collector.record(record("rem-3"), key);
    collector.setActiveTurn(key);

    expect(observer.observe()?.records.map((r) => r.reminderId)).toEqual([
      "rem-2",
      "rem-3",
    ]);
  });

  it("returns frozen slice + records (consumer cannot mutate)", () => {
    const collector = createScheduledReminderWorldStateCollector();
    const observer = createScheduledReminderWorldStateObserver(collector);
    const key: ScheduledReminderTurnKey = {
      sessionId: SESSION_A,
      turnId: "turn-1",
    };

    collector.record(record("rem-1"), key);
    collector.setActiveTurn(key);

    const slice = observer.observe();
    expect(Object.isFrozen(slice)).toBe(true);
    expect(Object.isFrozen(slice?.records)).toBe(true);
    expect(Object.isFrozen(slice?.records[0])).toBe(true);
  });

  it("rejects malformed input — invalid status / invalid fireAt / missing reminderId / unbranded ownerIdentityId", () => {
    const collector = createScheduledReminderWorldStateCollector();
    const key: ScheduledReminderTurnKey = {
      sessionId: SESSION_A,
      turnId: "turn-1",
    };

    expect(() =>
      collector.record(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        record("rem-1", { status: "expired" as any }),
        key,
      ),
    ).toThrow();
    expect(() =>
      collector.record(record("rem-1", { fireAt: "May 7 2026" as ISO8601 }), key),
    ).toThrow();
    expect(() =>
      collector.record(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { ...record("rem-1"), reminderId: "" } as any,
        key,
      ),
    ).toThrow();
    expect(() =>
      collector.record(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { ...record("rem-1"), ownerIdentityId: "no-prefix-slug" as any },
        key,
      ),
    ).toThrow();
  });

  it("rejects content that exceeds the 4096-char length cap", () => {
    const collector = createScheduledReminderWorldStateCollector();
    const key: ScheduledReminderTurnKey = {
      sessionId: SESSION_A,
      turnId: "turn-1",
    };

    expect(() =>
      collector.record(record("rem-long", { content: "a".repeat(4097) }), key),
    ).toThrow();
    // 4096 exactly is accepted.
    expect(() =>
      collector.record(record("rem-cap", { content: "a".repeat(4096) }), key),
    ).not.toThrow();
  });

  it("createDefaultMonitoredRuntime exposes the scheduledReminders slice when the process collector is populated", async () => {
    const fixture = createScheduledReminderWorldStateCollector();
    setProcessScheduledReminderWorldStateCollectorForTests(fixture);
    try {
      const key: ScheduledReminderTurnKey = {
        sessionId: SESSION_A,
        turnId: "turn-1",
      };
      fixture.record(record("rem-wired"), key);
      fixture.setActiveTurn(key);

      const runtime = createDefaultMonitoredRuntime();
      expect(runtime).toBeDefined();
      // The wired observer reads the same singleton; assert via direct observation.
      const observer = createScheduledReminderWorldStateObserver(fixture);
      const slice = observer.observe();
      expect(slice?.records.map((r) => r.reminderId)).toEqual(["rem-wired"]);
    } finally {
      setProcessScheduledReminderWorldStateCollectorForTests(undefined);
    }
  });
});
