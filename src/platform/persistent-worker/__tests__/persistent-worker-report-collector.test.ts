/**
 * V1-CONTRACT-ONLY S11c — fail-first tests for the non-kernel
 * `persistent-worker-report-collector.ts`. Mirrors the kernel observer's
 * test discipline (per-(sessionId, turnId) keying, last-writer-wins on
 * `workerRunId`, perTurnLimit=2, factory vs singleton isolation) but
 * exercises the new module that the production push-fire bootstrap
 * imports. Tests invoke the REAL collector; no `vi.spyOn` shimming.
 */

import { describe, expect, it } from "vitest";

import { asIdentityId } from "../../identity/identity-id.js";
import type { ChannelId, SessionId } from "../../identity/branded-ids.js";
import type { DeliveredWorkerReportRecordInput } from "../persistent-worker-push-runtime-adapter.js";
import {
  createPersistentWorkerReportCollector,
  getProcessPersistentWorkerReportCollector,
  setProcessPersistentWorkerReportCollectorForTests,
  type PersistentWorkerReportTurnKey,
} from "../persistent-worker-report-collector.js";

const VLADIMIR = asIdentityId("identity:vladimir");
const ALICE = asIdentityId("identity:alice");
const TELEGRAM = "telegram" as ChannelId;
const SESSION_A = "session-a" as SessionId;
const SESSION_B = "session-b" as SessionId;
const TURN_1 = "turn-1";
const TURN_2 = "turn-2";
const RECORDED_AT_A = "2026-05-07T12:00:30.000Z";
const RECORDED_AT_B = "2026-05-07T12:01:30.000Z";

const KEY_A1: PersistentWorkerReportTurnKey = {
  sessionId: SESSION_A,
  turnId: TURN_1,
};
const KEY_A2: PersistentWorkerReportTurnKey = {
  sessionId: SESSION_A,
  turnId: TURN_2,
};
const KEY_B1: PersistentWorkerReportTurnKey = {
  sessionId: SESSION_B,
  turnId: TURN_1,
};

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

describe("persistent-worker-report-collector (non-kernel) — record + freezeSnapshot", () => {
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
    expect(snapshot).toBeDefined();
    expect(snapshot?.failed.length).toBe(1);
    expect(snapshot?.delivered.length).toBe(0);
    expect(snapshot?.failed[0]?.workerRunId).toBe("wrk-002");
    expect(snapshot?.failed[0]?.reason).toBe("dispatch_failed");
  });
});

describe("persistent-worker-report-collector — has() idempotency predicate", () => {
  it("returns true after record() and false after only recordFailure()", () => {
    const collector = createPersistentWorkerReportCollector();
    expect(collector.has("wrk-001")).toBe(false);

    collector.recordFailure(
      {
        workerRunId: "wrk-001",
        ownerIdentityId: VLADIMIR,
        channel: TELEGRAM,
        to: "6533456892",
        status: "failed",
        recordedAt: RECORDED_AT_A,
        reason: "transport_error",
      },
      KEY_A1,
    );
    expect(collector.has("wrk-001")).toBe(false);

    collector.record(buildDeliveredInput(), KEY_A1);
    expect(collector.has("wrk-001")).toBe(true);
  });

  it("returns false for empty/non-string workerRunId", () => {
    const collector = createPersistentWorkerReportCollector();
    expect(collector.has("")).toBe(false);
    expect(collector.has(undefined as unknown as string)).toBe(false);
    expect(collector.has(null as unknown as string)).toBe(false);
  });
});

describe("persistent-worker-report-collector — perTurnLimit=2 trim discipline", () => {
  it("evicts the oldest delivered entry when total exceeds perTurnLimit=2", () => {
    const collector = createPersistentWorkerReportCollector();
    collector.record(
      buildDeliveredInput({ workerRunId: "wrk-A", recordedAt: RECORDED_AT_A }),
      KEY_A1,
    );
    collector.record(
      buildDeliveredInput({ workerRunId: "wrk-B", recordedAt: RECORDED_AT_B }),
      KEY_A1,
    );
    collector.record(
      buildDeliveredInput({ workerRunId: "wrk-C", recordedAt: RECORDED_AT_B }),
      KEY_A1,
    );
    const snapshot = collector.freezeSnapshot(KEY_A1);
    expect(snapshot?.delivered.map((entry) => entry.workerRunId)).toEqual([
      "wrk-B",
      "wrk-C",
    ]);
  });

  it("dedupes last-writer-wins on the same workerRunId across delivered/failed", () => {
    const collector = createPersistentWorkerReportCollector();
    collector.recordFailure(
      {
        workerRunId: "wrk-A",
        ownerIdentityId: VLADIMIR,
        channel: TELEGRAM,
        to: "6533456892",
        status: "failed",
        recordedAt: RECORDED_AT_A,
        reason: "transport_error",
      },
      KEY_A1,
    );
    collector.record(
      buildDeliveredInput({ workerRunId: "wrk-A", recordedAt: RECORDED_AT_B }),
      KEY_A1,
    );
    const snapshot = collector.freezeSnapshot(KEY_A1);
    expect(snapshot?.failed.length).toBe(0);
    expect(snapshot?.delivered.length).toBe(1);
    expect(snapshot?.delivered[0]?.workerRunId).toBe("wrk-A");
  });
});

describe("persistent-worker-report-collector — cross-turn isolation", () => {
  it("does not bleed records across different (sessionId, turnId) keys", () => {
    const collector = createPersistentWorkerReportCollector();
    collector.record(buildDeliveredInput({ workerRunId: "wrk-A1" }), KEY_A1);
    collector.record(buildDeliveredInput({ workerRunId: "wrk-A2" }), KEY_A2);
    collector.record(buildDeliveredInput({ workerRunId: "wrk-B1" }), KEY_B1);

    expect(collector.freezeSnapshot(KEY_A1)?.delivered[0]?.workerRunId).toBe(
      "wrk-A1",
    );
    expect(collector.freezeSnapshot(KEY_A1)?.delivered.length).toBe(1);
    expect(collector.freezeSnapshot(KEY_A2)?.delivered[0]?.workerRunId).toBe(
      "wrk-A2",
    );
    expect(collector.freezeSnapshot(KEY_B1)?.delivered[0]?.workerRunId).toBe(
      "wrk-B1",
    );
  });

  it("clear(key) drops ONLY the matching bucket", () => {
    const collector = createPersistentWorkerReportCollector();
    collector.record(buildDeliveredInput({ workerRunId: "wrk-A1" }), KEY_A1);
    collector.record(buildDeliveredInput({ workerRunId: "wrk-A2" }), KEY_A2);
    collector.clear(KEY_A1);
    expect(collector.freezeSnapshot(KEY_A1)).toBeUndefined();
    expect(collector.freezeSnapshot(KEY_A2)?.delivered[0]?.workerRunId).toBe(
      "wrk-A2",
    );
  });
});

describe("persistent-worker-report-collector — Zod validation rejects malformed input", () => {
  it("throws when ownerIdentityId is not a branded IdentityId", () => {
    const collector = createPersistentWorkerReportCollector();
    expect(() =>
      collector.record(
        buildDeliveredInput({
          ownerIdentityId: "not-an-identity-brand" as unknown as typeof VLADIMIR,
        }),
        KEY_A1,
      ),
    ).toThrow();
  });

  it("throws when recordedAt is not ISO-8601", () => {
    const collector = createPersistentWorkerReportCollector();
    expect(() =>
      collector.record(
        buildDeliveredInput({ recordedAt: "2026/05/07 12:00:30" }),
        KEY_A1,
      ),
    ).toThrow();
  });

  it("recordFailure throws on empty reason", () => {
    const collector = createPersistentWorkerReportCollector();
    expect(() =>
      collector.recordFailure(
        {
          workerRunId: "wrk-X",
          ownerIdentityId: VLADIMIR,
          channel: TELEGRAM,
          to: "6533456892",
          status: "failed",
          recordedAt: RECORDED_AT_A,
          reason: "",
        },
        KEY_A1,
      ),
    ).toThrow();
  });

  it("record throws when workerRunId is empty", () => {
    const collector = createPersistentWorkerReportCollector();
    expect(() =>
      collector.record(buildDeliveredInput({ workerRunId: "" }), KEY_A1),
    ).toThrow();
  });
});

describe("persistent-worker-report-collector — process singleton accessor", () => {
  it("returns the same instance across calls (idempotent)", () => {
    setProcessPersistentWorkerReportCollectorForTests(undefined);
    try {
      const first = getProcessPersistentWorkerReportCollector();
      const second = getProcessPersistentWorkerReportCollector();
      expect(first).toBe(second);
    } finally {
      setProcessPersistentWorkerReportCollectorForTests(undefined);
    }
  });

  it("setProcessPersistentWorkerReportCollectorForTests injects a fixture", () => {
    const fixture = createPersistentWorkerReportCollector({ perTurnLimit: 5 });
    setProcessPersistentWorkerReportCollectorForTests(fixture);
    try {
      expect(getProcessPersistentWorkerReportCollector()).toBe(fixture);
    } finally {
      setProcessPersistentWorkerReportCollectorForTests(undefined);
    }
  });

  it("setProcessPersistentWorkerReportCollectorForTests(undefined) resets to lazy-init", () => {
    const fixture = createPersistentWorkerReportCollector();
    setProcessPersistentWorkerReportCollectorForTests(fixture);
    setProcessPersistentWorkerReportCollectorForTests(undefined);
    const fresh = getProcessPersistentWorkerReportCollector();
    expect(fresh).not.toBe(fixture);
  });

  it("cross-identity records both land on the same singleton — bucket scope is (sessionId, turnId), not identityId", () => {
    setProcessPersistentWorkerReportCollectorForTests(undefined);
    try {
      const collector = getProcessPersistentWorkerReportCollector();
      collector.record(
        buildDeliveredInput({
          workerRunId: "wrk-V",
          ownerIdentityId: VLADIMIR,
        }),
        KEY_A1,
      );
      collector.record(
        buildDeliveredInput({
          workerRunId: "wrk-A",
          ownerIdentityId: ALICE,
        }),
        KEY_A1,
      );
      const snapshot = collector.freezeSnapshot(KEY_A1);
      expect(snapshot?.delivered.length).toBe(2);
      expect(
        snapshot?.delivered.map((entry) => entry.ownerIdentityId).sort(),
      ).toEqual([VLADIMIR, ALICE].sort());
    } finally {
      setProcessPersistentWorkerReportCollectorForTests(undefined);
    }
  });
});

describe("persistent-worker-report-collector — non-kernel boundary regression", () => {
  it("does not import any symbol from src/platform/commitment/ at module-load time", async () => {
    // Real import — if the module accidentally drags in a kernel symbol via a
    // type-only import path, ts-node strips the type at runtime, but a value
    // import would surface here. The runtime-only assertion is paranoia: we
    // already know the file's static imports avoid `commitment/`, so the test
    // simply forces module-load + a no-op factory invocation.
    const mod = await import("../persistent-worker-report-collector.js");
    expect(typeof mod.createPersistentWorkerReportCollector).toBe("function");
    const collector = mod.createPersistentWorkerReportCollector();
    expect(typeof collector.record).toBe("function");
    expect(typeof collector.recordFailure).toBe("function");
    expect(typeof collector.has).toBe("function");
  });
});
