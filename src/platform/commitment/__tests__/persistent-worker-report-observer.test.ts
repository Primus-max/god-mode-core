/**
 * Bug F (persistent-worker subsequent push) Phase 5 — fail-first tests
 * for `persistent-worker-report-observer.ts` (collector + observer +
 * process singleton).
 *
 * Mirrors `scheduled-reminder-world-state-observer.test.ts` (Cron/Scheduler
 * P3) discipline: per-(sessionId, turnId) keying, last-writer-wins on
 * `workerRunId`, perTurnLimit=2, factory vs singleton isolation. Tests
 * exercise the REAL observer; no `vi.spyOn` shimming.
 */

import { describe, expect, it } from "vitest";

import { asIdentityId } from "../../identity/identity-id.js";
import type { ChannelId, SessionId } from "../ids.js";
import {
  createPersistentWorkerReportCollector,
  createPersistentWorkerReportObserver,
  getProcessPersistentWorkerReportCollector,
  setProcessPersistentWorkerReportCollectorForTests,
  type PersistentWorkerReportCollector,
  type PersistentWorkerReportTurnKey,
} from "../persistent-worker-report-observer.js";
import type { DeliveredWorkerReportRecordInput } from "../../persistent-worker/persistent-worker-push-runtime-adapter.js";

const VLADIMIR = asIdentityId("identity:vladimir");
const ALICE = asIdentityId("identity:alice");
const TELEGRAM = "telegram" as ChannelId;
const SESSION_A = "session-a" as SessionId;
const SESSION_B = "session-b" as SessionId;
const TURN_1 = "turn-1";
const TURN_2 = "turn-2";
const RECORDED_AT_A = "2026-05-07T12:00:30.000Z";
const RECORDED_AT_B = "2026-05-07T12:01:30.000Z";

function buildDeliveredInput(
  overrides: Partial<DeliveredWorkerReportRecordInput> = {},
): DeliveredWorkerReportRecordInput {
  return {
    workerRunId: "wrk-001",
    ownerIdentityId: VLADIMIR,
    completedAt: "2026-05-07T12:00:00.000Z",
    channel: TELEGRAM,
    to: "6533456892",
    status: "pushed",
    recordedAt: RECORDED_AT_A,
    messageId: "pwpush:wrk-001:1",
    ...overrides,
  };
}

const KEY_A1: PersistentWorkerReportTurnKey = {
  sessionId: SESSION_A,
  turnId: TURN_1,
};

describe("PersistentWorkerReportCollector — record + freezeSnapshot round-trip", () => {
  it("records a delivered entry and freezes a snapshot containing it", () => {
    const collector = createPersistentWorkerReportCollector();
    collector.record(buildDeliveredInput(), KEY_A1);
    const snapshot = collector.freezeSnapshot(KEY_A1);
    expect(snapshot).toBeDefined();
    expect(snapshot?.delivered.length).toBe(1);
    expect(snapshot?.failed.length).toBe(0);
    expect(snapshot?.delivered[0]?.workerRunId).toBe("wrk-001");
    expect(snapshot?.delivered[0]?.status).toBe("pushed");
  });

  it("records a failed entry via recordFailure and freezes a snapshot containing it", () => {
    const collector = createPersistentWorkerReportCollector();
    collector.recordFailure(
      {
        workerRunId: "wrk-002",
        ownerIdentityId: VLADIMIR,
        channel: TELEGRAM,
        to: "6533456892",
        status: "failed",
        recordedAt: RECORDED_AT_A,
        reason: "dispatch_failed",
      },
      KEY_A1,
    );
    const snapshot = collector.freezeSnapshot(KEY_A1);
    expect(snapshot?.delivered.length).toBe(0);
    expect(snapshot?.failed.length).toBe(1);
    expect(snapshot?.failed[0]?.reason).toBe("dispatch_failed");
  });

  it("freezeSnapshot returns undefined when bucket has never been written", () => {
    const collector = createPersistentWorkerReportCollector();
    const snapshot = collector.freezeSnapshot(KEY_A1);
    expect(snapshot).toBeUndefined();
  });
});

describe("PersistentWorkerReportCollector — last-writer-wins on workerRunId", () => {
  it("re-recording the same workerRunId replaces the previous delivered entry", () => {
    const collector = createPersistentWorkerReportCollector();
    collector.record(
      buildDeliveredInput({ messageId: "pwpush:wrk-001:1" }),
      KEY_A1,
    );
    collector.record(
      buildDeliveredInput({
        messageId: "pwpush:wrk-001:2",
        recordedAt: RECORDED_AT_B,
      }),
      KEY_A1,
    );
    const snapshot = collector.freezeSnapshot(KEY_A1);
    expect(snapshot?.delivered.length).toBe(1);
    expect(snapshot?.delivered[0]?.messageId).toBe("pwpush:wrk-001:2");
  });

  it("recordFailure for a workerRunId that was previously delivered REPLACES the delivered entry", () => {
    // last-writer-wins ACROSS sub-shapes — the failed record displaces
    // the previous delivered record for the same workerRunId.
    const collector = createPersistentWorkerReportCollector();
    collector.record(buildDeliveredInput(), KEY_A1);
    collector.recordFailure(
      {
        workerRunId: "wrk-001",
        ownerIdentityId: VLADIMIR,
        channel: TELEGRAM,
        to: "6533456892",
        status: "failed",
        recordedAt: RECORDED_AT_B,
        reason: "transport_error",
      },
      KEY_A1,
    );
    const snapshot = collector.freezeSnapshot(KEY_A1);
    expect(snapshot?.delivered.length).toBe(0);
    expect(snapshot?.failed.length).toBe(1);
  });
});

describe("PersistentWorkerReportCollector — perTurnLimit", () => {
  it("perTurnLimit=2 (default) drops the oldest entry when 3 distinct workerRunIds are recorded on the same turn", () => {
    const collector = createPersistentWorkerReportCollector();
    collector.record(buildDeliveredInput({ workerRunId: "wrk-1" }), KEY_A1);
    collector.record(buildDeliveredInput({ workerRunId: "wrk-2" }), KEY_A1);
    collector.record(buildDeliveredInput({ workerRunId: "wrk-3" }), KEY_A1);
    const snapshot = collector.freezeSnapshot(KEY_A1);
    // Combined cap = 2; oldest dropped.
    const total =
      (snapshot?.delivered.length ?? 0) + (snapshot?.failed.length ?? 0);
    expect(total).toBe(2);
    const ids = (snapshot?.delivered ?? []).map((r) => r.workerRunId);
    expect(ids).toContain("wrk-3");
    expect(ids).not.toContain("wrk-1");
  });

  it("perTurnLimit=4 (custom) retains 4 entries", () => {
    const collector = createPersistentWorkerReportCollector({ perTurnLimit: 4 });
    collector.record(buildDeliveredInput({ workerRunId: "wrk-1" }), KEY_A1);
    collector.record(buildDeliveredInput({ workerRunId: "wrk-2" }), KEY_A1);
    collector.record(buildDeliveredInput({ workerRunId: "wrk-3" }), KEY_A1);
    collector.record(buildDeliveredInput({ workerRunId: "wrk-4" }), KEY_A1);
    const snapshot = collector.freezeSnapshot(KEY_A1);
    expect(snapshot?.delivered.length).toBe(4);
  });
});

describe("PersistentWorkerReportCollector — clear (sessionId, turnId) isolation", () => {
  it("clear (sessionId, turnId) drops only the named bucket", () => {
    const collector = createPersistentWorkerReportCollector();
    const KEY_A2: PersistentWorkerReportTurnKey = {
      sessionId: SESSION_A,
      turnId: TURN_2,
    };
    collector.record(buildDeliveredInput({ workerRunId: "wrk-A1" }), KEY_A1);
    collector.record(buildDeliveredInput({ workerRunId: "wrk-A2" }), KEY_A2);
    collector.clear(KEY_A1);
    expect(collector.freezeSnapshot(KEY_A1)).toBeUndefined();
    expect(collector.freezeSnapshot(KEY_A2)?.delivered.length).toBe(1);
  });

  it("sessionId isolation: A's records do not leak into B's bucket", () => {
    const collector = createPersistentWorkerReportCollector();
    const KEY_B1: PersistentWorkerReportTurnKey = {
      sessionId: SESSION_B,
      turnId: TURN_1,
    };
    collector.record(
      buildDeliveredInput({ workerRunId: "wrk-A1", ownerIdentityId: VLADIMIR }),
      KEY_A1,
    );
    collector.record(
      buildDeliveredInput({ workerRunId: "wrk-B1", ownerIdentityId: ALICE }),
      KEY_B1,
    );
    expect(collector.freezeSnapshot(KEY_A1)?.delivered[0]?.workerRunId).toBe(
      "wrk-A1",
    );
    expect(collector.freezeSnapshot(KEY_B1)?.delivered[0]?.workerRunId).toBe(
      "wrk-B1",
    );
  });
});

describe("PersistentWorkerReportCollector — has(workerRunId)", () => {
  it("returns true after a delivered record was written", () => {
    const collector = createPersistentWorkerReportCollector();
    collector.record(buildDeliveredInput({ workerRunId: "wrk-100" }), KEY_A1);
    expect(collector.has("wrk-100")).toBe(true);
  });

  it("returns false for a workerRunId that has only been recorded as failed", () => {
    // `has(...)` is the idempotency predicate for delivered runs only.
    // Failed records should NOT short-circuit the adapter's
    // report_already_pushed check.
    const collector = createPersistentWorkerReportCollector();
    collector.recordFailure(
      {
        workerRunId: "wrk-200",
        ownerIdentityId: VLADIMIR,
        channel: TELEGRAM,
        to: "6533456892",
        status: "failed",
        recordedAt: RECORDED_AT_A,
        reason: "dispatch_failed",
      },
      KEY_A1,
    );
    expect(collector.has("wrk-200")).toBe(false);
  });

  it("returns false for empty / unknown workerRunIds", () => {
    const collector = createPersistentWorkerReportCollector();
    expect(collector.has("")).toBe(false);
    expect(collector.has("never-written")).toBe(false);
  });
});

describe("PersistentWorkerReportObserver — observe() honors active turn", () => {
  it("observe() returns undefined when no active turn is set", () => {
    const collector = createPersistentWorkerReportCollector();
    collector.record(buildDeliveredInput(), KEY_A1);
    const observer = createPersistentWorkerReportObserver(collector);
    expect(observer.observe()).toBeUndefined();
  });

  it("observe() returns the active-turn slice once setActiveTurn is called", () => {
    const collector = createPersistentWorkerReportCollector();
    collector.record(buildDeliveredInput(), KEY_A1);
    collector.setActiveTurn(KEY_A1);
    const observer = createPersistentWorkerReportObserver(collector);
    const slice = observer.observe();
    expect(slice?.delivered.length).toBe(1);
    expect(slice?.delivered[0]?.workerRunId).toBe("wrk-001");
  });

  it("observe() returns undefined again when setActiveTurn(undefined) clears the pointer", () => {
    const collector = createPersistentWorkerReportCollector();
    collector.record(buildDeliveredInput(), KEY_A1);
    collector.setActiveTurn(KEY_A1);
    collector.setActiveTurn(undefined);
    const observer = createPersistentWorkerReportObserver(collector);
    expect(observer.observe()).toBeUndefined();
  });
});

describe("PersistentWorkerReportCollector — process-singleton vs factory isolation", () => {
  it("each new factory instance is isolated", () => {
    const a = createPersistentWorkerReportCollector();
    const b = createPersistentWorkerReportCollector();
    a.record(buildDeliveredInput({ workerRunId: "wrk-A" }), KEY_A1);
    b.record(buildDeliveredInput({ workerRunId: "wrk-B" }), KEY_A1);
    expect(a.has("wrk-A")).toBe(true);
    expect(a.has("wrk-B")).toBe(false);
    expect(b.has("wrk-A")).toBe(false);
    expect(b.has("wrk-B")).toBe(true);
  });

  it("getProcessPersistentWorkerReportCollector returns the same singleton across calls", () => {
    setProcessPersistentWorkerReportCollectorForTests(undefined);
    const first = getProcessPersistentWorkerReportCollector();
    const second = getProcessPersistentWorkerReportCollector();
    expect(first).toBe(second);
    setProcessPersistentWorkerReportCollectorForTests(undefined);
  });

  it("setProcessPersistentWorkerReportCollectorForTests overrides the singleton", () => {
    const fixture: PersistentWorkerReportCollector =
      createPersistentWorkerReportCollector();
    setProcessPersistentWorkerReportCollectorForTests(fixture);
    expect(getProcessPersistentWorkerReportCollector()).toBe(fixture);
    setProcessPersistentWorkerReportCollectorForTests(undefined);
  });
});

describe("PersistentWorkerReportCollector — Zod rejection at record(...)", () => {
  it("rejects an unbranded ownerIdentityId on record(...)", () => {
    const collector = createPersistentWorkerReportCollector();
    const malformed = buildDeliveredInput({
      ownerIdentityId: "anonymous" as never,
    });
    expect(() => collector.record(malformed, KEY_A1)).toThrow();
  });

  it("rejects an empty workerRunId on recordFailure(...)", () => {
    const collector = createPersistentWorkerReportCollector();
    expect(() =>
      collector.recordFailure(
        {
          workerRunId: "",
          ownerIdentityId: VLADIMIR,
          channel: TELEGRAM,
          to: "6533456892",
          status: "failed",
          recordedAt: RECORDED_AT_A,
          reason: "dispatch_failed",
        },
        KEY_A1,
      ),
    ).toThrow();
  });
});
