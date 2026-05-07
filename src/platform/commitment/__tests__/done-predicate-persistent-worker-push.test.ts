import { describe, expect, it } from "vitest";
import type { IdentityId } from "../../identity/identity-id.js";
import { persistentWorkerPushDeliveredPredicate } from "../done-predicate-persistent-worker-push.js";
import type { ChannelId, ISO8601 } from "../ids.js";
import type { WorldStateSnapshot } from "../world-state.js";
import type { ExpectedDelta } from "../expected-delta.js";

const WORKER_RUN_ID = "worker-run-test-1";
const OWNER_IDENTITY = "identity:operator-a" as IdentityId;
const COMPLETED_AT = "2026-05-07T10:00:00Z" as ISO8601;

type DeliveredWorkerReportFixture = {
  readonly workerRunId: string;
  readonly status: string;
  readonly ownerIdentityId?: string;
  readonly completedAt?: string;
  readonly channel?: string;
  readonly to?: string;
};

function buildRecord(
  overrides: Partial<DeliveredWorkerReportFixture> = {},
): DeliveredWorkerReportFixture {
  return Object.freeze({
    workerRunId: WORKER_RUN_ID,
    status: "pushed",
    ownerIdentityId: OWNER_IDENTITY,
    completedAt: COMPLETED_AT,
    channel: "telegram" as ChannelId,
    to: "6533456892",
    ...overrides,
  });
}

function buildState(
  delivered: readonly DeliveredWorkerReportFixture[] | undefined,
): WorldStateSnapshot {
  if (delivered === undefined) {
    return Object.freeze({});
  }
  // Forward-compat shape — Phase 5 widens `world-state.ts` with the real
  // `PersistentWorkerReportsSlice`. The predicate reads via structural cast
  // (slice K + Cron-Scheduler P4 precedent) so Phase 3 lands without
  // entangling the frozen-layer world-state surface.
  const slice = Object.freeze({
    delivered: Object.freeze([...delivered]),
  });
  return Object.freeze({
    persistentWorkerReports: slice,
  } as unknown as WorldStateSnapshot);
}

function buildDelta(
  addedWorkerRunIds: readonly string[] | undefined,
): ExpectedDelta {
  if (addedWorkerRunIds === undefined) {
    return Object.freeze({});
  }
  // Forward-compat shape — Phase 5 will widen `ExpectedDelta`. The
  // predicate reads via structural cast (slice K precedent).
  return Object.freeze({
    persistentWorkerReports: Object.freeze({
      added: Object.freeze([...addedWorkerRunIds]),
    }),
  } as unknown as ExpectedDelta);
}

function buildCtx(
  state: WorldStateSnapshot,
  delta: ExpectedDelta,
): Parameters<typeof persistentWorkerPushDeliveredPredicate>[0] {
  return {
    stateBefore: Object.freeze({}),
    stateAfter: state,
    expectedDelta: delta,
    receipts: { entries: [] },
    trace: { steps: [] },
  };
}

describe("persistentWorkerPushDeliveredPredicate (Bug F Phase 3 done-predicate)", () => {
  it("returns persistent_worker_reports.slice_absent when WorldStateSnapshot.persistentWorkerReports is undefined", () => {
    const result = persistentWorkerPushDeliveredPredicate(
      buildCtx(buildState(undefined), buildDelta([WORKER_RUN_ID])),
    );
    expect(result.satisfied).toBe(false);
    expect(result.satisfied === false ? result.missing : []).toEqual([
      "persistent_worker_reports.slice_absent",
    ]);
  });

  it("returns persistent_worker_reports.delivered.empty when slice present but delivered list is empty", () => {
    const result = persistentWorkerPushDeliveredPredicate(
      buildCtx(buildState([]), buildDelta([WORKER_RUN_ID])),
    );
    expect(result.satisfied).toBe(false);
    expect(result.satisfied === false ? result.missing : []).toEqual([
      "persistent_worker_reports.delivered.empty",
    ]);
  });

  it("returns worker_report_missing:<id> when expected workerRunId is not in delivered", () => {
    const result = persistentWorkerPushDeliveredPredicate(
      buildCtx(
        buildState([buildRecord({ workerRunId: "other-worker-run" })]),
        buildDelta([WORKER_RUN_ID]),
      ),
    );
    expect(result.satisfied).toBe(false);
    expect(result.satisfied === false ? result.missing : []).toEqual([
      `worker_report_missing:${WORKER_RUN_ID}`,
    ]);
  });

  it("returns worker_report_status_unexpected:<id>:<status> when matching record carries non-pushed status", () => {
    const result = persistentWorkerPushDeliveredPredicate(
      buildCtx(
        buildState([buildRecord({ status: "failed" })]),
        buildDelta([WORKER_RUN_ID]),
      ),
    );
    expect(result.satisfied).toBe(false);
    expect(result.satisfied === false ? result.missing : []).toEqual([
      `worker_report_status_unexpected:${WORKER_RUN_ID}:failed`,
    ]);
  });

  it("satisfies when matching record carries status='pushed' and emits one evidence fact per delivered record", () => {
    const result = persistentWorkerPushDeliveredPredicate(
      buildCtx(buildState([buildRecord()]), buildDelta([WORKER_RUN_ID])),
    );
    expect(result.satisfied).toBe(true);
    if (result.satisfied) {
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]?.kind).toBe("persistent_worker.subsequent_push");
      const value = result.evidence[0]?.value as {
        workerRunId?: string;
        ownerIdentityId?: string;
        completedAt?: string;
        channel?: string;
        to?: string;
        status?: string;
      };
      expect(value.workerRunId).toBe(WORKER_RUN_ID);
      expect(value.ownerIdentityId).toBe(OWNER_IDENTITY);
      expect(value.status).toBe("pushed");
    }
  });

  it("empty expectedDelta + non-empty delivered → satisfied=true (just observed; no specific assertion required)", () => {
    const result = persistentWorkerPushDeliveredPredicate(
      buildCtx(buildState([buildRecord()]), buildDelta(undefined)),
    );
    expect(result.satisfied).toBe(true);
    if (result.satisfied) {
      // Observed-only path: predicate emits one evidence fact per delivered
      // record so the trace can fingerprint the cron-fire effect even when
      // the commitment carried no expected delta (sub-plan §1 todo Phase 3
      // test case #6).
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]?.kind).toBe("persistent_worker.subsequent_push");
    }

    // Explicit empty-array `added` is also satisfied (sub-plan §1 todo
    // Phase 3 test case #6 — distinct from `scheduled_reminders.delta_empty`
    // semantics for the reminder.set predicate, which fails closed because
    // the runtime adapter MUST populate `added` on a successful emit;
    // persistent-worker push is structural at the cron-fire boundary, not
    // tool-emit, so an empty-`added` commitment shape is structurally
    // legitimate).
    const explicitEmpty = persistentWorkerPushDeliveredPredicate(
      buildCtx(buildState([buildRecord()]), buildDelta([])),
    );
    expect(explicitEmpty.satisfied).toBe(true);
  });

  it("multiple expected + multiple delivered → all reasons collected", () => {
    const matching = buildRecord({ workerRunId: WORKER_RUN_ID, status: "pushed" });
    const sibling = buildRecord({
      workerRunId: "sibling-worker-run",
      status: "pushed",
    });
    const stuck = buildRecord({
      workerRunId: "stuck-worker-run",
      status: "failed",
    });
    const result = persistentWorkerPushDeliveredPredicate(
      buildCtx(
        buildState([sibling, matching, stuck]),
        buildDelta([
          WORKER_RUN_ID,
          "missing-worker-run-A",
          "stuck-worker-run",
          "missing-worker-run-B",
        ]),
      ),
    );
    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      // All reasons collected (sub-plan §1 todo Phase 3 test case #7) — both
      // missing workerRunIds AND the unexpected-status record surface.
      expect([...result.missing]).toEqual([
        "worker_report_missing:missing-worker-run-A",
        "worker_report_status_unexpected:stuck-worker-run:failed",
        "worker_report_missing:missing-worker-run-B",
      ]);
    }
  });

  it("sentinel-proxy: never throws on malformed/missing inputs (#15)", () => {
    // Empty everything.
    expect(() =>
      persistentWorkerPushDeliveredPredicate(
        buildCtx(Object.freeze({}), Object.freeze({})),
      ),
    ).not.toThrow();

    // Slice present, delivered missing key entirely.
    const malformedSlice = {
      persistentWorkerReports: Object.freeze({}),
    } as unknown as WorldStateSnapshot;
    expect(() =>
      persistentWorkerPushDeliveredPredicate(
        buildCtx(malformedSlice, buildDelta([WORKER_RUN_ID])),
      ),
    ).not.toThrow();

    // Record without a workerRunId field.
    const broken = {
      persistentWorkerReports: Object.freeze({
        delivered: Object.freeze([
          Object.freeze({ status: "pushed" }),
        ]) as unknown as readonly DeliveredWorkerReportFixture[],
      }),
    } as unknown as WorldStateSnapshot;
    expect(() =>
      persistentWorkerPushDeliveredPredicate(
        buildCtx(broken, buildDelta([WORKER_RUN_ID])),
      ),
    ).not.toThrow();

    // Delta with non-array `added`.
    const malformedDelta = {
      persistentWorkerReports: { added: "not-an-array" },
    } as unknown as ExpectedDelta;
    expect(() =>
      persistentWorkerPushDeliveredPredicate(
        buildCtx(buildState([buildRecord()]), malformedDelta),
      ),
    ).not.toThrow();

    // Delivered list contains a null entry — predicate must skip it without
    // throwing.
    const nullableDelivered = {
      persistentWorkerReports: Object.freeze({
        delivered: Object.freeze(
          [null, undefined, buildRecord()] as unknown as readonly DeliveredWorkerReportFixture[],
        ),
      }),
    } as unknown as WorldStateSnapshot;
    expect(() =>
      persistentWorkerPushDeliveredPredicate(
        buildCtx(nullableDelivered, buildDelta([WORKER_RUN_ID])),
      ),
    ).not.toThrow();

    // Record with a non-string status — predicate surfaces it via the
    // unexpected-status sentinel without throwing.
    const numericStatus = {
      persistentWorkerReports: Object.freeze({
        delivered: Object.freeze([
          Object.freeze({
            workerRunId: WORKER_RUN_ID,
            status: 42,
          }),
        ] as unknown as readonly DeliveredWorkerReportFixture[]),
      }),
    } as unknown as WorldStateSnapshot;
    const result = persistentWorkerPushDeliveredPredicate(
      buildCtx(numericStatus, buildDelta([WORKER_RUN_ID])),
    );
    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect([...result.missing]).toEqual([
        `worker_report_status_unexpected:${WORKER_RUN_ID}:42`,
      ]);
    }
  });

  it("emits evidence carrying the matched record's identity-scoped fields (channel/to/completedAt/status)", () => {
    const result = persistentWorkerPushDeliveredPredicate(
      buildCtx(buildState([buildRecord()]), buildDelta([WORKER_RUN_ID])),
    );
    expect(result.satisfied).toBe(true);
    if (result.satisfied) {
      const value = result.evidence[0]?.value as {
        workerRunId?: string;
        ownerIdentityId?: string;
        completedAt?: string;
        channel?: string;
        to?: string;
        status?: string;
      };
      expect(value.workerRunId).toBe(WORKER_RUN_ID);
      expect(value.ownerIdentityId).toBe(OWNER_IDENTITY);
      expect(value.completedAt).toBe(COMPLETED_AT);
      expect(value.channel).toBe("telegram");
      expect(value.to).toBe("6533456892");
      expect(value.status).toBe("pushed");
    }
  });
});
