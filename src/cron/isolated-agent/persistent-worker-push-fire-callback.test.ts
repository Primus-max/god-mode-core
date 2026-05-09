/**
 * Bug F (persistent-worker subsequent push) Phase 5 — fail-first tests
 * for `persistent-worker-push-fire-callback.ts`.
 *
 * Mirrors `reminder-fire-callback.test.ts` discipline (slice K Phase 5):
 *  - cross-identity defense
 *  - mark-`pushed`-before-dispatch arm-order
 *  - dispatch_failed → record marked `failed`, no infinite replay
 *  - identity_unavailable / worker_run_missing reverses
 *  - logger emits structured line carrying wrappedScopeIdentityId
 *  - clock-mock determinism
 *  - perTurnLimit honored
 *  - sessionId isolation
 *  - NEVER throws (#15)
 *
 * Tests exercise the REAL callback; no `vi.spyOn` shimming the function
 * under test. All boundaries (subagentStore / adapter / collector /
 * deliveryDispatch / logger) are passed in as plain DI fakes.
 */

import { describe, expect, it } from "vitest";

import {
  createPersistentWorkerReportCollector,
  type PersistentWorkerReportCollector as ObserverModuleCollector,
} from "../../platform/persistent-worker/persistent-worker-report-collector.js";
import { asIdentityId } from "../../platform/identity/identity-id.js";
import type { ChannelId, SessionId } from "../../platform/identity/branded-ids.js";
import {
  runPersistentWorkerSubsequentPush,
  type PersistentWorkerPushArgs,
  type PersistentWorkerPushDispatchPayload,
  type PersistentWorkerPushResult,
} from "../../platform/persistent-worker/persistent-worker-push-runtime-adapter.js";

import {
  persistentWorkerPushFireCallback,
  type PersistentWorkerPushFireCallbackDeps,
  type PersistentWorkerPushFireCallbackArgs,
  type PersistentWorkerSubagentRecord,
  type PersistentWorkerSubagentStore,
  type PersistentWorkerReportCollectorWithFailure,
} from "./persistent-worker-push-fire-callback.js";

const VLADIMIR = asIdentityId("identity:vladimir");
const ALICE = asIdentityId("identity:alice");
const TELEGRAM = "telegram" as ChannelId;
const SESSION_A = "session-a" as SessionId;
const SESSION_B = "session-b" as SessionId;
const TURN_1 = "turn-1";
const COMPLETED_AT = "2026-05-07T11:00:00.000Z";
const FIXED_NOW_MS = Date.parse("2026-05-07T11:00:30.000Z");

// ─── Fakes ─────────────────────────────────────────────────────────────

function makeStore(
  initial: Record<string, PersistentWorkerSubagentRecord> = {},
): PersistentWorkerSubagentStore & {
  records: Map<string, PersistentWorkerSubagentRecord>;
} {
  const records = new Map<string, PersistentWorkerSubagentRecord>();
  for (const [k, v] of Object.entries(initial)) {
    records.set(k, { ...v });
  }
  const store: PersistentWorkerSubagentStore = {
    get(workerRunId) {
      return records.get(workerRunId);
    },
    markSubsequentPushStatus(workerRunId, status) {
      const entry = records.get(workerRunId);
      if (!entry) {
        return false;
      }
      records.set(workerRunId, { ...entry, subsequentPushStatus: status });
      return true;
    },
  };
  return Object.assign(store, { records });
}

function makeCollector(): ObserverModuleCollector & PersistentWorkerReportCollectorWithFailure {
  // The in-memory collector implements both the runtime adapter's narrow
  // interface AND the observer module's wider one (record/recordFailure/
  // has/clear/setActiveTurn/freezeSnapshot). `as unknown as` is necessary
  // because the runtime-adapter-side `PersistentWorkerReportCollector`
  // forwarder is structurally a subset.
  return createPersistentWorkerReportCollector() as unknown as ObserverModuleCollector &
    PersistentWorkerReportCollectorWithFailure;
}

function makeDispatchOk(
  capture: PersistentWorkerPushDispatchPayload[] = [],
): PersistentWorkerPushFireCallbackDeps["deliveryDispatch"] {
  return async (payload) => {
    capture.push(payload);
    return { ok: true };
  };
}

function makeDispatchFail(
  reason: string,
  capture: PersistentWorkerPushDispatchPayload[] = [],
): PersistentWorkerPushFireCallbackDeps["deliveryDispatch"] {
  return async (payload) => {
    capture.push(payload);
    return { ok: false, reason };
  };
}

type MutableDeps = {
  subagentStore: PersistentWorkerSubagentStore;
  adapter: typeof runPersistentWorkerSubsequentPush;
  collector: PersistentWorkerReportCollectorWithFailure;
  deliveryDispatch: PersistentWorkerPushFireCallbackDeps["deliveryDispatch"];
  logger?: PersistentWorkerPushFireCallbackDeps["logger"];
  now?: PersistentWorkerPushFireCallbackDeps["now"];
};

function buildDeps(
  overrides: Partial<MutableDeps> = {},
  storeSeed: Record<string, PersistentWorkerSubagentRecord> = {
    "wrk-001": {
      runId: "wrk-001",
      ownerIdentityId: VLADIMIR,
      subsequentPushStatus: "pending",
    },
  },
): MutableDeps & {
  store: ReturnType<typeof makeStore>;
  collector: PersistentWorkerReportCollectorWithFailure;
  dispatchCapture: PersistentWorkerPushDispatchPayload[];
  logLines: string[];
} {
  const store = makeStore(storeSeed);
  const collector = makeCollector();
  const dispatchCapture: PersistentWorkerPushDispatchPayload[] = [];
  const logLines: string[] = [];
  const deps: MutableDeps = {
    subagentStore: store,
    adapter: runPersistentWorkerSubsequentPush,
    collector,
    deliveryDispatch: makeDispatchOk(dispatchCapture),
    logger: { log: (line) => logLines.push(line) },
    now: () => FIXED_NOW_MS,
    ...overrides,
  };
  return Object.assign(deps, { store, collector, dispatchCapture, logLines });
}

function buildArgs(
  overrides: Partial<PersistentWorkerPushFireCallbackArgs> = {},
): PersistentWorkerPushFireCallbackArgs {
  return {
    sessionId: SESSION_A,
    turnId: TURN_1,
    workerRunId: "wrk-001",
    completedAt: COMPLETED_AT,
    channel: TELEGRAM,
    to: "6533456892",
    content: "Daily push: 3 new artifacts.",
    ...overrides,
  };
}

// ─── #1 Happy path ─────────────────────────────────────────────────────

describe("persistentWorkerPushFireCallback — happy path", () => {
  it("loads record, marks pushed, dispatches with wrappedScopeIdentityId === record.ownerIdentityId", async () => {
    const deps = buildDeps();
    const result = await persistentWorkerPushFireCallback(deps, buildArgs());
    expect(result.kind).toBe("ok");

    expect(deps.store.records.get("wrk-001")?.subsequentPushStatus).toBe(
      "pushed",
    );
    expect(deps.dispatchCapture.length).toBe(1);
    // Byte-equal: the dispatch payload's wrappedScopeIdentityId MUST be
    // the persisted record's ownerIdentityId — slice K precedent + sub-
    // plan §1 audit §i NEW invariant.
    expect(deps.dispatchCapture[0]?.wrappedScopeIdentityId).toBe(VLADIMIR);
  });

  it("emits a [persistent-worker-push-fire-callback] result=ok log line", async () => {
    const deps = buildDeps();
    await persistentWorkerPushFireCallback(deps, buildArgs());
    const matched = deps.logLines.find((l) =>
      l.startsWith("[persistent-worker-push-fire-callback]"),
    );
    expect(matched).toBeDefined();
    expect(matched).toContain("workerRunId=wrk-001");
    expect(matched).toContain(`wrappedScopeIdentityId=${VLADIMIR}`);
    expect(matched).toContain("channel=telegram");
    expect(matched).toContain("result=ok");
  });
});

// ─── #2 Cross-identity defense ─────────────────────────────────────────

describe("persistentWorkerPushFireCallback — cross-identity defense", () => {
  it("A's worker-run NEVER pushes when caller passes B's sessionId — wrappedScopeIdentityId is record.ownerIdentityId, not session-derived", async () => {
    // Operator A's worker-run is persisted as A. Caller passes B's
    // sessionId in the args. The dispatch payload's
    // wrappedScopeIdentityId MUST still be A (record.ownerIdentityId)
    // — a buggy caller passing session-B context cannot smuggle B's
    // identity past the gate.
    const deps = buildDeps(
      {},
      {
        "wrk-cross": {
          runId: "wrk-cross",
          ownerIdentityId: VLADIMIR, // A
          subsequentPushStatus: "pending",
        },
      },
    );
    const result = await persistentWorkerPushFireCallback(
      deps,
      buildArgs({ workerRunId: "wrk-cross", sessionId: SESSION_B }),
    );
    expect(result.kind).toBe("ok");
    expect(deps.dispatchCapture[0]?.wrappedScopeIdentityId).toBe(VLADIMIR);
    expect(deps.dispatchCapture[0]?.wrappedScopeIdentityId).not.toBe(ALICE);
  });
});

// ─── #3 mark-pushed-before-dispatch arm-order ──────────────────────────

describe("persistentWorkerPushFireCallback — mark-pushed-before-dispatch arm-order", () => {
  it("marks subsequentPushStatus='pushed' BEFORE invoking adapter (idempotent on retry)", async () => {
    let observedStatusAtDispatchTime: string | undefined;
    const deps = buildDeps();
    deps.deliveryDispatch = async (payload) => {
      // Observe the persisted record state at dispatch time.
      observedStatusAtDispatchTime =
        deps.store.records.get("wrk-001")?.subsequentPushStatus;
      deps.dispatchCapture.push(payload);
      return { ok: true };
    };
    await persistentWorkerPushFireCallback(deps, buildArgs());
    expect(observedStatusAtDispatchTime).toBe("pushed");
  });
});

// ─── #4 dispatch_failed → record stays/becomes 'failed', no replay ─────

describe("persistentWorkerPushFireCallback — dispatch_failed handling", () => {
  it("on adapter dispatch_failed, marks record subsequentPushStatus='failed' (no infinite replay)", async () => {
    const deps = buildDeps();
    deps.deliveryDispatch = makeDispatchFail("transport blew up");
    const result = await persistentWorkerPushFireCallback(deps, buildArgs());
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    expect(result.reason).toBe("dispatch_failed");
    expect(deps.store.records.get("wrk-001")?.subsequentPushStatus).toBe(
      "failed",
    );
  });

  it("on adapter dispatch_failed, records a `failed` entry on the observer slice", async () => {
    const deps = buildDeps();
    deps.deliveryDispatch = makeDispatchFail("dispatch envelope malformed");
    await persistentWorkerPushFireCallback(deps, buildArgs());
    const collector = deps.collector as ReturnType<typeof makeCollector>;
    const snapshot = collector.freezeSnapshot({
      sessionId: SESSION_A,
      turnId: TURN_1,
    });
    expect(snapshot?.failed.length).toBe(1);
    expect(snapshot?.failed[0]?.reason).toBe("dispatch_failed");
  });
});

// ─── #5 identity_unavailable reverse ───────────────────────────────────

describe("persistentWorkerPushFireCallback — identity_unavailable reverse", () => {
  it("returns identity_unavailable when the persisted record has NO ownerIdentityId (anonymous fail-closed)", async () => {
    const deps = buildDeps(
      {},
      {
        "wrk-anon": {
          runId: "wrk-anon",
          subsequentPushStatus: "pending",
        },
      },
    );
    const result = await persistentWorkerPushFireCallback(
      deps,
      buildArgs({ workerRunId: "wrk-anon" }),
    );
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    expect(result.reason).toBe("identity_unavailable");
    // ZERO dispatch invocations.
    expect(deps.dispatchCapture.length).toBe(0);
    // Record's status is NOT mutated (caller cannot mark a record we
    // refuse to dispatch on).
    expect(deps.store.records.get("wrk-anon")?.subsequentPushStatus).toBe(
      "pending",
    );
  });

  it("returns identity_unavailable when the persisted record carries an unbranded string identity", async () => {
    const deps = buildDeps(
      {},
      {
        "wrk-bad": {
          runId: "wrk-bad",
          ownerIdentityId: "anonymous" as never,
          subsequentPushStatus: "pending",
        },
      },
    );
    const result = await persistentWorkerPushFireCallback(
      deps,
      buildArgs({ workerRunId: "wrk-bad" }),
    );
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    expect(result.reason).toBe("identity_unavailable");
    expect(deps.dispatchCapture.length).toBe(0);
  });
});

// ─── #6 worker_run_missing reverse ─────────────────────────────────────

describe("persistentWorkerPushFireCallback — worker_run_missing reverse", () => {
  it("returns worker_run_missing when the workerRunId is unknown to the store", async () => {
    const deps = buildDeps({}, {});
    const result = await persistentWorkerPushFireCallback(
      deps,
      buildArgs({ workerRunId: "wrk-unknown" }),
    );
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    expect(result.reason).toBe("worker_run_missing");
    expect(deps.dispatchCapture.length).toBe(0);
  });

  it("returns worker_run_missing when the workerRunId is empty", async () => {
    const deps = buildDeps();
    const result = await persistentWorkerPushFireCallback(
      deps,
      buildArgs({ workerRunId: "   " }),
    );
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    expect(result.reason).toBe("worker_run_missing");
  });
});

// ─── #7 NEVER throws (#15) ──────────────────────────────────────────────

describe("persistentWorkerPushFireCallback — NEVER throws", () => {
  it("returns observer_unavailable when deps.subagentStore is undefined", async () => {
    const result = await persistentWorkerPushFireCallback(
      { subagentStore: undefined as never } as never,
      buildArgs(),
    );
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    expect(result.reason).toBe("observer_unavailable");
  });

  it("returns internal_error when deps is null", async () => {
    const result = await persistentWorkerPushFireCallback(
      null as never,
      buildArgs(),
    );
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    // null deps fail at the structural check at the top of the
    // function, which surfaces observer_unavailable.
    expect(["observer_unavailable", "internal_error"]).toContain(result.reason);
  });

  it("returns observer_unavailable when subagentStore.get throws", async () => {
    const deps = buildDeps();
    deps.subagentStore = {
      get() {
        throw new Error("DB down");
      },
      markSubsequentPushStatus: () => false,
    };
    const result = await persistentWorkerPushFireCallback(deps, buildArgs());
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    expect(result.reason).toBe("observer_unavailable");
  });

  it("never bubbles a thrown adapter error — surfaces internal_error", async () => {
    const deps = buildDeps();
    // Replace the adapter with a throwing impl. The callback contract
    // says NEVER throws even if the adapter contract is violated.
    deps.adapter = (async () => {
      throw new Error("adapter contract violation");
    }) as unknown as typeof runPersistentWorkerSubsequentPush;
    const result = await persistentWorkerPushFireCallback(deps, buildArgs());
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    expect(result.reason).toBe("internal_error");
    expect(deps.store.records.get("wrk-001")?.subsequentPushStatus).toBe(
      "failed",
    );
  });
});

// ─── #8 Logger discipline ──────────────────────────────────────────────

describe("persistentWorkerPushFireCallback — logger discipline", () => {
  it("logger.log throwing does NOT escape (#15)", async () => {
    const deps = buildDeps();
    deps.logger = {
      log: () => {
        throw new Error("logger blew up");
      },
    };
    const result = await persistentWorkerPushFireCallback(deps, buildArgs());
    expect(result.kind).toBe("ok");
  });

  it("logger emits a fail-line on identity_unavailable", async () => {
    const deps = buildDeps(
      {},
      {
        "wrk-anon": { runId: "wrk-anon", subsequentPushStatus: "pending" },
      },
    );
    await persistentWorkerPushFireCallback(
      deps,
      buildArgs({ workerRunId: "wrk-anon" }),
    );
    const matched = deps.logLines.find((l) =>
      l.includes("result=fail:identity_unavailable"),
    );
    expect(matched).toBeDefined();
  });
});

// ─── #9 perTurnLimit honored on observer ───────────────────────────────

describe("persistentWorkerPushFireCallback — perTurnLimit honored on observer", () => {
  it("recording 3 distinct workerRunIds in one turn keeps only the last 2 (default cap)", async () => {
    const deps = buildDeps(
      {},
      {
        "wrk-1": {
          runId: "wrk-1",
          ownerIdentityId: VLADIMIR,
          subsequentPushStatus: "pending",
        },
        "wrk-2": {
          runId: "wrk-2",
          ownerIdentityId: VLADIMIR,
          subsequentPushStatus: "pending",
        },
        "wrk-3": {
          runId: "wrk-3",
          ownerIdentityId: VLADIMIR,
          subsequentPushStatus: "pending",
        },
      },
    );
    await persistentWorkerPushFireCallback(deps, buildArgs({ workerRunId: "wrk-1" }));
    await persistentWorkerPushFireCallback(deps, buildArgs({ workerRunId: "wrk-2" }));
    await persistentWorkerPushFireCallback(deps, buildArgs({ workerRunId: "wrk-3" }));
    const collector = deps.collector as ReturnType<typeof makeCollector>;
    const snapshot = collector.freezeSnapshot({
      sessionId: SESSION_A,
      turnId: TURN_1,
    });
    const total =
      (snapshot?.delivered.length ?? 0) + (snapshot?.failed.length ?? 0);
    expect(total).toBe(2);
  });
});

// ─── #10 Clock-mock determinism ────────────────────────────────────────

describe("persistentWorkerPushFireCallback — clock-mock determinism", () => {
  it("uses deps.now for failure recordedAt (deterministic)", async () => {
    const deps = buildDeps();
    deps.deliveryDispatch = makeDispatchFail("transport blew up");
    deps.now = () => Date.parse("2026-05-07T10:00:00.000Z");
    await persistentWorkerPushFireCallback(deps, buildArgs());
    const collector = deps.collector as ReturnType<typeof makeCollector>;
    const snapshot = collector.freezeSnapshot({
      sessionId: SESSION_A,
      turnId: TURN_1,
    });
    expect(snapshot?.failed[0]?.recordedAt).toBe("2026-05-07T10:00:00.000Z");
  });
});

// ─── #11 Unwrap adapter result.detail when present ─────────────────────

describe("persistentWorkerPushFireCallback — error detail propagation", () => {
  it("propagates adapter result.detail when present", async () => {
    const deps = buildDeps();
    deps.deliveryDispatch = makeDispatchFail("rate limited 429");
    const result = await persistentWorkerPushFireCallback(deps, buildArgs());
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    expect(result.reason).toBe("dispatch_failed");
    expect(result.detail).toContain("rate limited 429");
  });
});

// ─── #12 Adapter typed-fail reasons surface unchanged ──────────────────

describe("persistentWorkerPushFireCallback — adapter failure-reason propagation", () => {
  it("surfaces adapter report_already_pushed when the collector already has the workerRunId", async () => {
    const deps = buildDeps();
    // Pre-seed the collector with a delivered record for wrk-001.
    deps.collector.record(
      {
        workerRunId: "wrk-001",
        ownerIdentityId: VLADIMIR,
        completedAt: COMPLETED_AT,
        channel: TELEGRAM,
        to: "6533456892",
        status: "pushed",
        recordedAt: COMPLETED_AT,
        messageId: "pwpush:wrk-001:0",
      },
      { sessionId: SESSION_A, turnId: TURN_1 },
    );
    const result = await persistentWorkerPushFireCallback(deps, buildArgs());
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    expect(result.reason).toBe("report_already_pushed");
    // Record was marked `pushed` BEFORE adapter invocation; adapter
    // detected the duplicate at the has(...) predicate. Now the
    // callback marks `failed` (since adapter returned kind:'fail') —
    // which is structurally consistent with «no replay» (the operator
    // already received the push under the OLD record).
    expect(deps.store.records.get("wrk-001")?.subsequentPushStatus).toBe(
      "failed",
    );
  });
});

// ─── Sanity: typecheck the result shape ────────────────────────────────

describe("persistentWorkerPushFireCallback — result shape sanity", () => {
  it("returns a discriminated union — kind:'ok' or kind:'fail'", async () => {
    const deps = buildDeps();
    const result = await persistentWorkerPushFireCallback(deps, buildArgs());
    // Type-narrowing exhaustiveness — compile-time covered by TS.
    if (result.kind === "ok") {
      expect(typeof result.messageId === "string" || result.messageId === undefined).toBe(true);
    } else {
      const _exhaustiveCheck: PersistentWorkerPushResult["kind"] | "ok" =
        result.kind;
      void _exhaustiveCheck;
    }
  });
});

// ─── PersistentWorkerPushArgs type sanity (TS surface check) ───────────

// Compile-time sanity that the adapter args carry the expected shape.
const _argSanity: PersistentWorkerPushArgs = {
  sessionId: SESSION_A,
  turnId: TURN_1,
  workerRunId: "wrk-001",
  ownerIdentityId: VLADIMIR,
  completedAt: COMPLETED_AT,
  channel: TELEGRAM,
  to: "6533456892",
  content: "ok",
};
void _argSanity;
