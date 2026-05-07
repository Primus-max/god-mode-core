/**
 * Bug F (persistent-worker subsequent push) Phase 4 — fail-first tests
 * for the runtime adapter (`persistent-worker-push-runtime-adapter.ts`).
 *
 * Sibling of `scheduled-reminder-runtime-adapter.test.ts` (Cron/Scheduler
 * P5) and `repo-runtime-adapter.test.ts` (Cutover-4 P5). Validates:
 *
 * - happy path: `runPersistentWorkerSubsequentPush(...)` invokes
 *   `deliveryDispatch`, then appends a `pushed` record to the
 *   collector, then returns `{ kind:'ok', messageId, recordedAt }`;
 * - closed failure set (every reason exhaustively reachable);
 * - identity / Zod / channel structural fail-closed paths;
 * - idempotency short-circuit (`report_already_pushed`);
 * - logger emit verification (Phase 7 acceptance grep precedent);
 * - NEVER throws (invariant #15) — every malformed shape returns a
 *   typed result envelope.
 *
 * Tests exercise the REAL adapter; no `vi.spyOn` shimming the function
 * under test. All boundaries (collector / deliveryDispatch / logger)
 * are passed in as plain DI fakes that the adapter calls through to.
 */

import { describe, expect, it } from "vitest";

import { asIdentityId } from "../../identity/identity-id.js";
import type { ChannelId, SessionId } from "../../commitment/ids.js";

import {
  runPersistentWorkerSubsequentPush,
  type DeliveredWorkerReportRecordInput,
  type DeliveryDispatchFn,
  type PersistentWorkerPushArgs,
  type PersistentWorkerPushDeps,
  type PersistentWorkerPushDispatchPayload,
  type PersistentWorkerReportCollector,
  type PersistentWorkerReportTurnKey,
} from "../persistent-worker-push-runtime-adapter.js";
import { WORKER_REPORT_CONTENT_MAX_LENGTH } from "../persistent-worker-push-types.js";

const VLADIMIR = asIdentityId("identity:vladimir");
const SESSION = "session-a" as SessionId;
const TURN = "turn-1";
const TELEGRAM = "telegram" as ChannelId;
const COMPLETED_AT = "2026-05-07T11:00:00.000Z";
const FIXED_NOW_MS = Date.parse("2026-05-07T11:00:30.000Z");

// ─── Fakes ─────────────────────────────────────────────────────────────

type RecordedEvent = {
  readonly record: DeliveredWorkerReportRecordInput;
  readonly key: PersistentWorkerReportTurnKey;
};

function makeCollector(initialPushedIds: readonly string[] = []): {
  collector: PersistentWorkerReportCollector;
  recorded: RecordedEvent[];
  pushedIds: Set<string>;
} {
  const recorded: RecordedEvent[] = [];
  const pushedIds = new Set<string>(initialPushedIds);
  const collector: PersistentWorkerReportCollector = {
    record(record, key) {
      recorded.push({ record, key });
      pushedIds.add(record.workerRunId);
    },
    has(workerRunId) {
      return pushedIds.has(workerRunId);
    },
  };
  return { collector, recorded, pushedIds };
}

function makeDispatchOk(
  capture: PersistentWorkerPushDispatchPayload[] = [],
): DeliveryDispatchFn {
  return async (payload) => {
    capture.push(payload);
    return { ok: true };
  };
}

function makeDispatchFail(
  reason: string,
  capture: PersistentWorkerPushDispatchPayload[] = [],
): DeliveryDispatchFn {
  return async (payload) => {
    capture.push(payload);
    return { ok: false, reason };
  };
}

function makeDispatchThrows(
  capture: PersistentWorkerPushDispatchPayload[] = [],
): DeliveryDispatchFn {
  return async (payload) => {
    capture.push(payload);
    throw new Error("transport blew up");
  };
}

function buildDeps(
  overrides: Partial<PersistentWorkerPushDeps> = {},
): PersistentWorkerPushDeps {
  const { collector } = makeCollector();
  const dispatch = makeDispatchOk();
  return {
    collector,
    deliveryDispatch: dispatch,
    now: () => FIXED_NOW_MS,
    ...overrides,
  };
}

function buildArgs(
  overrides: Partial<PersistentWorkerPushArgs> = {},
): PersistentWorkerPushArgs {
  return {
    sessionId: SESSION,
    turnId: TURN,
    workerRunId: "wrk-001",
    ownerIdentityId: VLADIMIR,
    completedAt: COMPLETED_AT,
    channel: TELEGRAM,
    to: "6533456892",
    content: "Daily push: 3 new artifacts.",
    ...overrides,
  };
}

// ─── #1 Success path ───────────────────────────────────────────────────

describe("runPersistentWorkerSubsequentPush — success path", () => {
  it("dispatches the payload, records the pushed event, and returns ok", async () => {
    const { collector, recorded } = makeCollector();
    const dispatchCapture: PersistentWorkerPushDispatchPayload[] = [];
    const dispatch = makeDispatchOk(dispatchCapture);
    const lines: string[] = [];
    const deps: PersistentWorkerPushDeps = {
      collector,
      deliveryDispatch: dispatch,
      logger: { log: (line) => lines.push(line) },
      now: () => FIXED_NOW_MS,
    };
    const result = await runPersistentWorkerSubsequentPush(deps, buildArgs());

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.messageId).toContain("wrk-001");
    expect(result.recordedAt).toBe(new Date(FIXED_NOW_MS).toISOString());

    // Dispatch invoked exactly once with the correct payload.
    expect(dispatchCapture.length).toBe(1);
    expect(dispatchCapture[0]?.workerRunId).toBe("wrk-001");
    expect(dispatchCapture[0]?.wrappedScopeIdentityId).toBe(VLADIMIR);
    expect(dispatchCapture[0]?.channel).toBe(TELEGRAM);
    expect(dispatchCapture[0]?.to).toBe("6533456892");
    expect(dispatchCapture[0]?.content).toBe("Daily push: 3 new artifacts.");

    // Collector recorded exactly once with the pushed status.
    expect(recorded.length).toBe(1);
    expect(recorded[0]?.record.workerRunId).toBe("wrk-001");
    expect(recorded[0]?.record.status).toBe("pushed");
    expect(recorded[0]?.record.ownerIdentityId).toBe(VLADIMIR);
    expect(recorded[0]?.record.recordedAt).toBe(
      new Date(FIXED_NOW_MS).toISOString(),
    );
    expect(recorded[0]?.key.sessionId).toBe(SESSION);
    expect(recorded[0]?.key.turnId).toBe(TURN);

    // Log line matches Phase 7 acceptance grep shape.
    const matched = lines.find((l) =>
      l.startsWith(
        "[persistent-worker-push-runtime-adapter] runPersistentWorkerSubsequentPush",
      ),
    );
    expect(matched).toBeDefined();
    expect(matched).toContain("workerRunId=wrk-001");
    expect(matched).toContain(`identityId=${VLADIMIR}`);
    expect(matched).toContain(`channel=${TELEGRAM}`);
    expect(matched).toContain("to=6533456892");
    expect(matched).toContain("result=ok");
  });
});

// ─── #2 identity_unavailable reverse ───────────────────────────────────

describe("runPersistentWorkerSubsequentPush — identity_unavailable reverse", () => {
  it("returns identity_unavailable when ownerIdentityId is empty (anonymous fail-closed)", async () => {
    const { collector, recorded } = makeCollector();
    const dispatchCapture: PersistentWorkerPushDispatchPayload[] = [];
    const dispatch = makeDispatchOk(dispatchCapture);
    const result = await runPersistentWorkerSubsequentPush(
      { collector, deliveryDispatch: dispatch },
      buildArgs({
        ownerIdentityId: "" as unknown as ReturnType<typeof asIdentityId>,
      }),
    );
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    expect(result.reason).toBe("identity_unavailable");
    // ZERO collector.record + ZERO dispatch invocation.
    expect(recorded.length).toBe(0);
    expect(dispatchCapture.length).toBe(0);
  });

  it("returns identity_unavailable on an unbranded ownerIdentityId (rogue string)", async () => {
    const { collector, recorded } = makeCollector();
    const dispatchCapture: PersistentWorkerPushDispatchPayload[] = [];
    const dispatch = makeDispatchOk(dispatchCapture);
    const result = await runPersistentWorkerSubsequentPush(
      { collector, deliveryDispatch: dispatch },
      buildArgs({
        ownerIdentityId: "rogue-string" as unknown as ReturnType<
          typeof asIdentityId
        >,
      }),
    );
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    expect(result.reason).toBe("identity_unavailable");
    expect(recorded.length).toBe(0);
    expect(dispatchCapture.length).toBe(0);
  });
});

// ─── #3 transport_error / dispatch_failed reverse ──────────────────────

describe("runPersistentWorkerSubsequentPush — dispatch failure paths", () => {
  it("returns dispatch_failed when deliveryDispatch returns { ok: false } and does NOT record on the success bucket", async () => {
    const { collector, recorded } = makeCollector();
    const dispatchCapture: PersistentWorkerPushDispatchPayload[] = [];
    const dispatch = makeDispatchFail("transport_error", dispatchCapture);
    const result = await runPersistentWorkerSubsequentPush(
      { collector, deliveryDispatch: dispatch },
      buildArgs(),
    );
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    expect(result.reason).toBe("dispatch_failed");
    expect(result.detail).toBe("transport_error");
    expect(dispatchCapture.length).toBe(1);
    // ZERO collector.record on the failure path — Phase 5 callback's
    // `subsequentPushStatus='pushed'` mark-before-dispatch lives ABOVE
    // this adapter; the slice WRITE is success-only.
    expect(recorded.length).toBe(0);
  });

  it("returns dispatch_failed when deliveryDispatch throws", async () => {
    const { collector, recorded } = makeCollector();
    const dispatch = makeDispatchThrows();
    const result = await runPersistentWorkerSubsequentPush(
      { collector, deliveryDispatch: dispatch },
      buildArgs(),
    );
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    expect(result.reason).toBe("dispatch_failed");
    expect(result.detail).toContain("transport blew up");
    expect(recorded.length).toBe(0);
  });

  it("returns dispatch_failed mapping channel_unavailable from the underlying envelope", async () => {
    const { collector } = makeCollector();
    const dispatch = makeDispatchFail("channel_unavailable");
    const result = await runPersistentWorkerSubsequentPush(
      { collector, deliveryDispatch: dispatch },
      buildArgs(),
    );
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    expect(result.reason).toBe("dispatch_failed");
    expect(result.detail).toBe("channel_unavailable");
  });
});

// ─── #4 report_already_pushed idempotency reverse ──────────────────────

describe("runPersistentWorkerSubsequentPush — report_already_pushed idempotency", () => {
  it("short-circuits when collector.has(workerRunId) is true and never invokes deliveryDispatch", async () => {
    const { collector, recorded } = makeCollector(["wrk-001"]);
    const dispatchCapture: PersistentWorkerPushDispatchPayload[] = [];
    const dispatch = makeDispatchOk(dispatchCapture);
    const result = await runPersistentWorkerSubsequentPush(
      { collector, deliveryDispatch: dispatch },
      buildArgs({ workerRunId: "wrk-001" }),
    );
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    expect(result.reason).toBe("report_already_pushed");
    // ZERO dispatch invocation + ZERO collector.record (only the
    // pre-existing membership remained).
    expect(dispatchCapture.length).toBe(0);
    expect(recorded.length).toBe(0);
  });
});

// ─── #5 observer_unavailable reverse ───────────────────────────────────

describe("runPersistentWorkerSubsequentPush — observer_unavailable reverse", () => {
  it("returns observer_unavailable when collector is undefined", async () => {
    const dispatch = makeDispatchOk();
    const result = await runPersistentWorkerSubsequentPush(
      {
        collector: undefined as unknown as PersistentWorkerReportCollector,
        deliveryDispatch: dispatch,
      },
      buildArgs(),
    );
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    expect(result.reason).toBe("observer_unavailable");
  });

  it("returns observer_unavailable when collector.has throws", async () => {
    const collector: PersistentWorkerReportCollector = {
      record() {
        throw new Error("never reached");
      },
      has() {
        throw new Error("collector blew up");
      },
    };
    const dispatchCapture: PersistentWorkerPushDispatchPayload[] = [];
    const dispatch = makeDispatchOk(dispatchCapture);
    const result = await runPersistentWorkerSubsequentPush(
      { collector, deliveryDispatch: dispatch },
      buildArgs(),
    );
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    expect(result.reason).toBe("observer_unavailable");
    // dispatch never invoked — the has() short-circuit fired BEFORE
    // dispatch.
    expect(dispatchCapture.length).toBe(0);
  });

  it("returns transport_error when collector.record throws on the success path (dispatch already landed)", async () => {
    const collector: PersistentWorkerReportCollector = {
      record() {
        throw new Error("collector append blew up");
      },
      has() {
        return false;
      },
    };
    const dispatchCapture: PersistentWorkerPushDispatchPayload[] = [];
    const dispatch = makeDispatchOk(dispatchCapture);
    const result = await runPersistentWorkerSubsequentPush(
      { collector, deliveryDispatch: dispatch },
      buildArgs(),
    );
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    // The dispatch ALREADY landed (operator received the push) — the
    // slice-write failure surfaces as `transport_error` so the Phase 5
    // callback's logging records the failure for ops follow-up,
    // distinct from the `dispatch_failed` bucket.
    expect(result.reason).toBe("transport_error");
    expect(dispatchCapture.length).toBe(1);
  });
});

// ─── #6 Logger never throws on adapter return ─────────────────────────

describe("runPersistentWorkerSubsequentPush — logger discipline", () => {
  it("returns a valid envelope even if logger.log throws on the success path", async () => {
    const { collector, recorded } = makeCollector();
    const dispatch = makeDispatchOk();
    const deps: PersistentWorkerPushDeps = {
      collector,
      deliveryDispatch: dispatch,
      logger: {
        log: () => {
          throw new Error("logger blew up");
        },
      },
      now: () => FIXED_NOW_MS,
    };
    const result = await runPersistentWorkerSubsequentPush(deps, buildArgs());
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.messageId).toContain("wrk-001");
    // Collector.record still ran — the success path completed.
    expect(recorded.length).toBe(1);
  });

  it("returns a valid envelope even if logger.log throws on the failure path", async () => {
    const { collector } = makeCollector();
    const dispatch = makeDispatchFail("transport_error");
    const deps: PersistentWorkerPushDeps = {
      collector,
      deliveryDispatch: dispatch,
      logger: {
        log: () => {
          throw new Error("logger blew up");
        },
      },
    };
    const result = await runPersistentWorkerSubsequentPush(deps, buildArgs());
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    expect(result.reason).toBe("dispatch_failed");
  });
});

// ─── #7 Closed-shape `to` rejection ───────────────────────────────────

describe("runPersistentWorkerSubsequentPush — Zod rejection paths", () => {
  it("returns channel_invalid when `to` is empty (Zod rejects)", async () => {
    const { collector, recorded } = makeCollector();
    const dispatchCapture: PersistentWorkerPushDispatchPayload[] = [];
    const dispatch = makeDispatchOk(dispatchCapture);
    const result = await runPersistentWorkerSubsequentPush(
      { collector, deliveryDispatch: dispatch },
      buildArgs({ to: "" }),
    );
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    expect(result.reason).toBe("channel_invalid");
    expect(recorded.length).toBe(0);
    expect(dispatchCapture.length).toBe(0);
  });

  it("returns channel_invalid when `channel` is empty (Zod rejects)", async () => {
    const { collector } = makeCollector();
    const dispatch = makeDispatchOk();
    const result = await runPersistentWorkerSubsequentPush(
      { collector, deliveryDispatch: dispatch },
      buildArgs({ channel: "" as unknown as ChannelId }),
    );
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    expect(result.reason).toBe("channel_invalid");
  });

  it("returns channel_invalid when completedAt is malformed (not ISO-8601)", async () => {
    const { collector } = makeCollector();
    const dispatch = makeDispatchOk();
    const result = await runPersistentWorkerSubsequentPush(
      { collector, deliveryDispatch: dispatch },
      buildArgs({ completedAt: "yesterday morning" }),
    );
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    expect(result.reason).toBe("channel_invalid");
  });

  it("returns worker_run_missing when workerRunId is empty", async () => {
    const { collector, recorded } = makeCollector();
    const dispatchCapture: PersistentWorkerPushDispatchPayload[] = [];
    const dispatch = makeDispatchOk(dispatchCapture);
    const result = await runPersistentWorkerSubsequentPush(
      { collector, deliveryDispatch: dispatch },
      buildArgs({ workerRunId: "" }),
    );
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    expect(result.reason).toBe("worker_run_missing");
    expect(recorded.length).toBe(0);
    expect(dispatchCapture.length).toBe(0);
  });
});

// ─── #8 Oversized content tolerance ───────────────────────────────────

describe("runPersistentWorkerSubsequentPush — oversized content tolerance", () => {
  it(`returns channel_invalid when content length exceeds WORKER_REPORT_CONTENT_MAX_LENGTH=${WORKER_REPORT_CONTENT_MAX_LENGTH}`, async () => {
    const { collector, recorded } = makeCollector();
    const dispatchCapture: PersistentWorkerPushDispatchPayload[] = [];
    const dispatch = makeDispatchOk(dispatchCapture);
    const oversizedContent = "x".repeat(WORKER_REPORT_CONTENT_MAX_LENGTH + 1);
    const result = await runPersistentWorkerSubsequentPush(
      { collector, deliveryDispatch: dispatch },
      buildArgs({ content: oversizedContent }),
    );
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    expect(result.reason).toBe("channel_invalid");
    expect(recorded.length).toBe(0);
    expect(dispatchCapture.length).toBe(0);
  });

  it("accepts content at exactly WORKER_REPORT_CONTENT_MAX_LENGTH (boundary)", async () => {
    const { collector, recorded } = makeCollector();
    const dispatch = makeDispatchOk();
    const exactBoundary = "x".repeat(WORKER_REPORT_CONTENT_MAX_LENGTH);
    const result = await runPersistentWorkerSubsequentPush(
      {
        collector,
        deliveryDispatch: dispatch,
        now: () => FIXED_NOW_MS,
      },
      buildArgs({ content: exactBoundary }),
    );
    expect(result.kind).toBe("ok");
    expect(recorded.length).toBe(1);
  });
});

// ─── #9 NEVER throws (#15) ────────────────────────────────────────────

describe("runPersistentWorkerSubsequentPush — NEVER throws (#15)", () => {
  it("returns a typed envelope on deeply malformed args (null deps)", async () => {
    const result = await runPersistentWorkerSubsequentPush(
      null as unknown as PersistentWorkerPushDeps,
      buildArgs(),
    );
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    expect(result.reason).toBe("observer_unavailable");
  });

  it("returns a typed envelope on deeply malformed args (null args)", async () => {
    const deps = buildDeps();
    const result = await runPersistentWorkerSubsequentPush(
      deps,
      null as unknown as PersistentWorkerPushArgs,
    );
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    // Should fan into either identity_unavailable (null args have empty
    // ownerIdentityId after the type guard) or internal_error if the
    // adapter's defensive predicate trips earlier. Either is acceptable
    // — the adapter MUST NOT throw.
    expect([
      "identity_unavailable",
      "internal_error",
      "observer_unavailable",
    ]).toContain(result.reason);
  });

  it("returns a typed envelope when args is undefined", async () => {
    const deps = buildDeps();
    const result = await runPersistentWorkerSubsequentPush(
      deps,
      undefined as unknown as PersistentWorkerPushArgs,
    );
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    // Should be one of the closed-set rejections — adapter MUST NOT throw.
    expect([
      "identity_unavailable",
      "internal_error",
      "observer_unavailable",
    ]).toContain(result.reason);
  });
});

// ─── #10 Cross-test invariant — never collector.record on identity fail ─

describe("runPersistentWorkerSubsequentPush — cross-cutting", () => {
  it("never records on the collector when identity is anonymous (defense in depth)", async () => {
    const { collector, recorded } = makeCollector();
    const dispatchCapture: PersistentWorkerPushDispatchPayload[] = [];
    const dispatch = makeDispatchOk(dispatchCapture);
    await runPersistentWorkerSubsequentPush(
      { collector, deliveryDispatch: dispatch },
      buildArgs({
        ownerIdentityId: "" as unknown as ReturnType<typeof asIdentityId>,
      }),
    );
    expect(recorded.length).toBe(0);
    expect(dispatchCapture.length).toBe(0);
  });

  it("preserves wrappedScopeIdentityId byte-equal to args.ownerIdentityId on dispatch payload", async () => {
    const { collector } = makeCollector();
    const dispatchCapture: PersistentWorkerPushDispatchPayload[] = [];
    const dispatch = makeDispatchOk(dispatchCapture);
    await runPersistentWorkerSubsequentPush(
      {
        collector,
        deliveryDispatch: dispatch,
        now: () => FIXED_NOW_MS,
      },
      buildArgs(),
    );
    expect(dispatchCapture.length).toBe(1);
    expect(dispatchCapture[0]?.wrappedScopeIdentityId).toBe(VLADIMIR);
  });
});
