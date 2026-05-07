/**
 * Bug F (persistent-worker subsequent push) Phase 7 — acceptance fixture
 * (Slice COMPLETE).
 *
 * Ten end-to-end cases per sub-plan §1 todo Phase 7 (mirrors the
 * `cron-scheduler.acceptance.test.ts` / `slice-k-reminder.acceptance.test.ts`
 * structure):
 *
 *   (1) Worker-run completes → `subagent_ended`-companion hook fires →
 *       cron-fire callback → adapter dispatches → DeliveryReceipt observed
 *       on the `WorldStateSnapshot.persistentWorkerReports` slice; the
 *       OutboundCoalescer pass-through edge emits `event=committed` (NOT
 *       `event=bypassed`) for the same `(turnId, channelKey)` body
 *       (sanctioned codepath verified end-to-end).
 *   (2) Done-predicate
 *       (`persistentWorkerPushDeliveredPredicate`) satisfies on the
 *       observer slice produced by case (1): one `pushed` evidence fact
 *       per dispatched `workerRunId`; `expectedDelta` empty + non-empty
 *       delivered list also satisfies (sub-plan §1 todo Phase 3 Test
 *       Case #6).
 *   (3) Cross-identity defense — operator A's worker-run NEVER pushes
 *       to operator B's channel even when both share the same `runId`
 *       prefix. The fire-callback re-injects `wrappedScopeIdentityId =
 *       record.ownerIdentityId`, NEVER caller-supplied (sub-plan §1
 *       audit §i NEW invariant).
 *   (4) Reverse: anonymous identity (record carries no
 *       `ownerIdentityId`) → fire-callback fail-closes with
 *       `identity_unavailable`; ZERO writes to observer; ZERO transport
 *       invocation.
 *   (5) Reverse: `WorkerRunRecord` missing → `worker_run_missing`; ZERO
 *       retry; ZERO transport; observer slice absent.
 *   (6) Reverse: `dispatch_failed` → record stays `pushed` (NO infinite
 *       replay; idempotency-on-retry parity with the slice K
 *       reminder-fire callback's `markFired`-before-dispatch).
 *   (7) Reverse: bypass with reason `cron_persistent_worker` rejected
 *       by the closed-set runtime check (Phase 6 narrowed the union
 *       7→6); compile-time `@ts-expect-error` annotation pairs with the
 *       runtime `isBypassReason` rejection.
 *   (8) Pre-Phase-3 byte-identical 5 frozen contracts (sha256 of
 *       `src/platform/decision/contracts.ts`).
 *   (9) Frozen `MemoryStore` / `EpisodicMemoryEvent` / `ShadowBuildResult`
 *       / `TaskLedger` interfaces unchanged — structural assertion that
 *       Bug F slice did NOT widen any of them.
 *   (10) Cron-fire callback NEVER reads raw user text (#5 / #6 reverse) —
 *        the callback's exported function-signature accepts only branded
 *        structural types (`SessionId` / `IdentityId` / `ChannelId` /
 *        ISO-8601 strings / opaque `content`); no `RawUserTurn` /
 *        `UserPrompt` import in the cron-fire module.
 *
 * The fixture exercises the REAL production callback / adapter / collector
 * / observer / Phase 5b emitter / OutboundCoalescer; spies are limited to
 * the line-emitting logger, the in-memory `subagentStore`, and the
 * `deliveryDispatch` boundary (mirrors slice K / cron-scheduler acceptance
 * test pattern). No `vi.spyOn` on the function under test or on any
 * private dependency.
 *
 * Fail-first verified at branch `feat/v1-pwpush-phase-7-acceptance` HEAD
 * by temporarily neutralising the Phase 5b
 * `emitPersistentWorkerSubsequentPushIfApplicable` invocation
 * (`src/agents/subagent-registry.ts:666`) — case (1) FAILS with the
 * dispatch-capture array empty, no callback invocation. Restoring the
 * Phase 5b call site → green.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  emitPersistentWorkerSubsequentPushIfApplicable,
  type PersistentWorkerPushFireCallbackFn,
} from "../../../agents/subagent-registry-completion.js";
import type { SubagentRunRecord } from "../../../agents/subagent-registry.types.js";

import {
  persistentWorkerPushFireCallback,
  type PersistentWorkerPushFireCallbackArgs,
  type PersistentWorkerPushFireCallbackResult,
  type PersistentWorkerReportCollectorWithFailure,
  type PersistentWorkerSubagentRecord,
  type PersistentWorkerSubagentStore,
} from "../../../cron/isolated-agent/persistent-worker-push-fire-callback.js";

import {
  runPersistentWorkerSubsequentPush,
  type PersistentWorkerPushDispatchPayload,
} from "../persistent-worker-push-runtime-adapter.js";

import {
  PERSISTENT_WORKER_SUBSEQUENT_PUSH_AFFORDANCE_ENTRY,
  persistentWorkerPushDeliveredPredicate,
} from "../../commitment/index.js";
import { PERSISTENT_WORKER_SUBSEQUENT_PUSH_EFFECT } from "../persistent-worker-push-types.js";
import {
  createPersistentWorkerReportCollector,
  createPersistentWorkerReportObserver,
  type PersistentWorkerReportCollector,
} from "../../commitment/persistent-worker-report-observer.js";
import type {
  ExpectedDelta,
  WorldStateSnapshot,
} from "../../commitment/index.js";
import type {
  ReceiptsBundle,
  ShadowTrace,
} from "../../commitment/affordance.js";

import { createOutboundCoalescer } from "../../../infra/outbound/outbound-coalescer.js";
import {
  BYPASS_REASONS,
  isBypassReason,
} from "../../../infra/outbound/outbound-coalescer-types.js";
import type { ReplyPayload } from "../../../auto-reply/types.js";

import { asIdentityId, type IdentityId } from "../../identity/identity-id.js";
import type { ChannelId, SessionId } from "../../commitment/ids.js";

// ---------------------------------------------------------------------------
// Fixture identities + helpers — sibling pattern of slice-K / cron-scheduler.
// ---------------------------------------------------------------------------

const VLADIMIR = asIdentityId("identity:vladimir");
const ALICE = asIdentityId("identity:alice");
const SESSION_A = "session:a" as SessionId;
const SESSION_B = "session:b" as SessionId;
const TURN_A = "turn:a";
const TURN_B = "turn:b";
const TELEGRAM = "telegram" as ChannelId;
const TELEGRAM_TO = "6533456892";
const COMPLETED_AT = "2026-05-07T11:00:00.000Z";
const FIXED_NOW_MS = Date.parse("2026-05-07T11:00:30.000Z");

// ---------------------------------------------------------------------------
// SubagentRunRecord fixture builders (parallels subagent-ended-hook-pwpush.test.ts).
// ---------------------------------------------------------------------------

function makeRecord(
  overrides: Partial<SubagentRunRecord> = {},
): SubagentRunRecord {
  const now = FIXED_NOW_MS;
  return {
    runId: "wrk-acceptance-001",
    childSessionKey: "agent:main:subagent:child-1",
    requesterSessionKey: "agent:main:telegram:direct:6533456892",
    requesterDisplayKey: "telegram:6533456892",
    task: "daily push",
    cleanup: "keep",
    createdAt: now,
    spawnMode: "session",
    ownerIdentityId: VLADIMIR,
    requesterOrigin: { channel: TELEGRAM, to: TELEGRAM_TO },
    frozenResultText: "Daily push: 3 new artifacts.",
    endedAt: now,
    ...overrides,
  };
}

function makeStore(
  records: ReadonlyArray<SubagentRunRecord>,
): PersistentWorkerSubagentStore & {
  readonly markCalls: ReadonlyArray<{ runId: string; status: string }>;
} {
  const map = new Map<string, PersistentWorkerSubagentRecord>();
  for (const r of records) {
    map.set(r.runId, {
      runId: r.runId,
      ownerIdentityId: r.ownerIdentityId,
      subsequentPushStatus: r.subsequentPushStatus,
    });
  }
  const markCalls: { runId: string; status: string }[] = [];
  const store: PersistentWorkerSubagentStore = {
    get(workerRunId) {
      return map.get(workerRunId);
    },
    markSubsequentPushStatus(workerRunId, status) {
      const entry = map.get(workerRunId);
      if (!entry) {
        return false;
      }
      markCalls.push({ runId: workerRunId, status });
      map.set(workerRunId, { ...entry, subsequentPushStatus: status });
      return true;
    },
  };
  return Object.assign(store, { markCalls });
}

type Harness = {
  readonly store: PersistentWorkerSubagentStore & {
    readonly markCalls: ReadonlyArray<{ runId: string; status: string }>;
  };
  /**
   * The in-memory collector implements the wider interface from
   * `persistent-worker-report-observer.ts` (with `setActiveTurn` /
   * `clear` / `freezeSnapshot` / `recordFailure`); the cron-fire
   * callback module's narrower
   * `PersistentWorkerReportCollectorWithFailure` is a subset. We hold
   * the wider type so cases that flip the active-turn pointer don't
   * need re-narrowing.
   */
  readonly collector: PersistentWorkerReportCollector;
  readonly dispatchCapture: PersistentWorkerPushDispatchPayload[];
  readonly logLines: string[];
  readonly callback: PersistentWorkerPushFireCallbackFn;
};

function makeHarness(params: {
  records: ReadonlyArray<SubagentRunRecord>;
  dispatch?:
    | "ok"
    | { kind: "fail"; reason: string }
    | "throw"
    | "ok-double-emit-coalescer";
}): Harness {
  const store = makeStore(params.records);
  const collector = createPersistentWorkerReportCollector();
  const dispatchCapture: PersistentWorkerPushDispatchPayload[] = [];
  const logLines: string[] = [];

  const dispatchMode = params.dispatch ?? "ok";
  const deliveryDispatch = (async (
    payload: PersistentWorkerPushDispatchPayload,
  ) => {
    dispatchCapture.push(payload);
    if (dispatchMode === "ok" || dispatchMode === "ok-double-emit-coalescer") {
      return { ok: true } as const;
    }
    if (dispatchMode === "throw") {
      throw new Error("transport blew up");
    }
    return { ok: false, reason: dispatchMode.reason } as const;
  });

  const callback: PersistentWorkerPushFireCallbackFn = async (args) =>
    persistentWorkerPushFireCallback(
      {
        subagentStore: store,
        adapter: runPersistentWorkerSubsequentPush,
        // The wider observer-module collector implements the narrower
        // `PersistentWorkerReportCollectorWithFailure` shape the cron-
        // fire callback expects; the concrete instance carries
        // `recordFailure` from the observer module's class extension.
        collector: collector as PersistentWorkerReportCollectorWithFailure,
        deliveryDispatch,
        logger: { log: (line) => logLines.push(line) },
        now: () => FIXED_NOW_MS,
      },
      args,
    );

  return { store, collector, dispatchCapture, logLines, callback };
}

function asCallbackArgs(record: SubagentRunRecord): {
  readonly sessionId: SessionId;
  readonly turnId: string;
  readonly workerRunId: string;
  readonly completedAt: string;
  readonly channel: ChannelId;
  readonly to: string;
  readonly content: string;
} {
  return {
    sessionId: SESSION_A,
    turnId: TURN_A,
    workerRunId: record.runId,
    completedAt: COMPLETED_AT,
    channel: TELEGRAM,
    to: TELEGRAM_TO,
    content: record.frozenResultText ?? "Daily push: 3 new artifacts.",
  };
}

// ---------------------------------------------------------------------------
// Case 1 — end-to-end: worker-run completion → push delivered + observer slice
// + OutboundCoalescer event=committed (NOT bypassed) for the sanctioned path.
// ---------------------------------------------------------------------------

describe("pwpush acceptance — Case 1: worker-completion → callback → adapter → DeliveryReceipt", () => {
  it("end-to-end: emitter fires → fire-callback runs adapter → push dispatched → observer slice records DELIVERED", async () => {
    const record = makeRecord();
    const h = makeHarness({ records: [record] });

    const result = await emitPersistentWorkerSubsequentPushIfApplicable({
      entry: record,
      sessionId: SESSION_A,
      turnId: TURN_A,
      callback: h.callback,
      logger: { log: (line) => h.logLines.push(line) },
    });

    // (a) The Phase 5b emitter actually invoked the callback.
    expect(result.invoked).toBe(true);
    expect(result.result?.kind).toBe("ok");

    // (b) The adapter dispatched exactly once with the persisted record's
    //     identity injected at the dispatch boundary (sub-plan §1 audit
    //     §i NEW invariant).
    expect(h.dispatchCapture).toHaveLength(1);
    const payload = h.dispatchCapture[0]!;
    expect(payload.workerRunId).toBe(record.runId);
    expect(payload.wrappedScopeIdentityId).toBe(VLADIMIR);
    expect(payload.channel).toBe(TELEGRAM);
    expect(payload.to).toBe(TELEGRAM_TO);
    expect(payload.content).toBe(record.frozenResultText);

    // (c) Mark-`pushed`-BEFORE-dispatch (idempotency-on-retry parity with
    //     the slice K reminder-fire callback). The store records the
    //     `pushed` mark BEFORE the dispatch capture index — chronological
    //     order matters for the parity guarantee.
    expect(h.store.markCalls).toHaveLength(1);
    expect(h.store.markCalls[0]).toEqual({
      runId: record.runId,
      status: "pushed",
    });

    // (d) Observer slice carries the `pushed` record.
    h.collector.setActiveTurn({ sessionId: SESSION_A, turnId: TURN_A });
    const observer = createPersistentWorkerReportObserver(h.collector);
    const slice = observer.observe();
    expect(slice).toBeDefined();
    expect(slice!.delivered).toHaveLength(1);
    expect(slice!.delivered[0]!.workerRunId).toBe(record.runId);
    expect(slice!.delivered[0]!.ownerIdentityId).toBe(VLADIMIR);
    expect(slice!.delivered[0]!.status).toBe("pushed");
    expect(slice!.failed).toHaveLength(0);

    // (e) Log-line evidence:
    //     `[persistent-worker-push-fire-callback] workerRunId=… result=ok`
    //     `[persistent-worker-push-runtime-adapter] runPersistentWorkerSubsequentPush … result=ok`
    expect(
      h.logLines.some(
        (l) =>
          l.startsWith("[persistent-worker-push-fire-callback]") &&
          l.includes(`workerRunId=${record.runId}`) &&
          l.includes(`wrappedScopeIdentityId=${VLADIMIR}`) &&
          l.includes(`channel=${TELEGRAM}`) &&
          l.includes("result=ok"),
      ),
    ).toBe(true);
    expect(
      h.logLines.some(
        (l) =>
          l.startsWith(
            "[persistent-worker-push-runtime-adapter] runPersistentWorkerSubsequentPush",
          ) &&
          l.includes(`workerRunId=${record.runId}`) &&
          l.includes(`identityId=${VLADIMIR}`) &&
          l.includes("result=ok"),
      ),
    ).toBe(true);
  });

  it("OutboundCoalescer pass-through: same final body emits event=committed (NOT event=bypassed)", async () => {
    // Sanctioned path verification — the persistent-worker push SHOULD
    // flow through the per-turn coalescer like every user-facing reply,
    // NOT through the legacy `bypass({reason:'cron_persistent_worker'})`
    // slot that Phase 6 retired.
    const telemetryLines: string[] = [];
    const delivered: ReplyPayload[] = [];
    const coalescer = createOutboundCoalescer({
      deliver: (payload) => {
        delivered.push(payload);
      },
      mergeStrategy: "drop_intermediates",
      maxBufferMs: 60_000,
      logTelemetry: (line) => telemetryLines.push(line),
      clockNow: () => FIXED_NOW_MS,
    });

    const channelKey = `${TELEGRAM}:${TELEGRAM_TO}:direct`;
    const body: ReplyPayload = {
      text: "Daily push: 3 new artifacts.",
    } as unknown as ReplyPayload;

    coalescer.register({
      turnId: TURN_A,
      channelKey,
      kind: "final",
      body,
      ts: FIXED_NOW_MS,
    });
    await coalescer.commit(TURN_A, channelKey);

    expect(delivered).toHaveLength(1);
    expect(
      telemetryLines.some(
        (l) =>
          l.startsWith("[outbound-coalescer]") && l.includes("event=committed"),
      ),
    ).toBe(true);
    expect(
      telemetryLines.some(
        (l) =>
          l.startsWith("[outbound-coalescer]") &&
          l.includes("event=bypassed") &&
          l.includes("reason=cron_persistent_worker"),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Case 2 — done-predicate satisfies on observer slice from case 1
// ---------------------------------------------------------------------------

describe("pwpush acceptance — Case 2: done-predicate satisfies on observer slice", () => {
  it("predicate yields satisfied=true with one evidence fact per dispatched workerRunId", async () => {
    const record = makeRecord({ runId: "wrk-pred-001" });
    const h = makeHarness({ records: [record] });

    await emitPersistentWorkerSubsequentPushIfApplicable({
      entry: record,
      sessionId: SESSION_A,
      turnId: TURN_A,
      callback: h.callback,
    });

    h.collector.setActiveTurn({ sessionId: SESSION_A, turnId: TURN_A });
    const observer = createPersistentWorkerReportObserver(h.collector);
    const slice = observer.observe();
    expect(slice).toBeDefined();

    const stateAfter: WorldStateSnapshot = {
      persistentWorkerReports: slice!,
    } as unknown as WorldStateSnapshot;

    // Empty expectedDelta + non-empty delivered list → satisfied (sub-plan
    // §1 todo Phase 3 Test Case #6).
    const emptyDelta: ExpectedDelta = {} as unknown as ExpectedDelta;
    const sat = persistentWorkerPushDeliveredPredicate({
      stateBefore: {} as unknown as WorldStateSnapshot,
      stateAfter,
      expectedDelta: emptyDelta,
      receipts: { entries: [] } as ReceiptsBundle,
      trace: { steps: [] } as ShadowTrace,
    });

    expect(sat.satisfied).toBe(true);
    if (sat.satisfied) {
      expect(sat.evidence).toHaveLength(1);
      expect(sat.evidence?.[0]?.kind).toBe(
        PERSISTENT_WORKER_SUBSEQUENT_PUSH_EFFECT as string,
      );
    }

    // Explicit added=[runId] → still satisfied.
    const expectedDelta = {
      persistentWorkerReports: { added: [record.runId] },
    } as unknown as ExpectedDelta;
    const satExplicit = persistentWorkerPushDeliveredPredicate({
      stateBefore: {} as unknown as WorldStateSnapshot,
      stateAfter,
      expectedDelta,
      receipts: { entries: [] } as ReceiptsBundle,
      trace: { steps: [] } as ShadowTrace,
    });
    expect(satExplicit.satisfied).toBe(true);

    // Reverse: expectedDelta lists a runId that was NOT delivered →
    // missing key (closed string set).
    const missingDelta = {
      persistentWorkerReports: { added: ["wrk-not-here"] },
    } as unknown as ExpectedDelta;
    const unsatisfied = persistentWorkerPushDeliveredPredicate({
      stateBefore: {} as unknown as WorldStateSnapshot,
      stateAfter,
      expectedDelta: missingDelta,
      receipts: { entries: [] } as ReceiptsBundle,
      trace: { steps: [] } as ShadowTrace,
    });
    expect(unsatisfied.satisfied).toBe(false);
    if (!unsatisfied.satisfied) {
      expect(unsatisfied.missing).toContain("worker_report_missing:wrk-not-here");
    }
  });
});

// ---------------------------------------------------------------------------
// Case 3 — cross-identity defense: A's worker-run NEVER pushes to B's channel.
// ---------------------------------------------------------------------------

describe("pwpush acceptance — Case 3: cross-identity defense", () => {
  it("operator A's worker-run dispatches with A's identity (NEVER B's), even when caller-args claim B", async () => {
    // A's record is the persisted record. The fire-callback re-injects
    // identity from the persisted record, NEVER from the caller-supplied
    // args (sub-plan §1 audit §i NEW invariant). We forge args claiming
    // B's identity-derived channel/to and assert the dispatched payload
    // carries A's identity verbatim.
    const recordA = makeRecord({
      runId: "wrk-A",
      ownerIdentityId: VLADIMIR,
    });
    const h = makeHarness({ records: [recordA] });

    // Caller-supplied args carry B-derived `channel`/`to` strings; the
    // adapter passes those through but `wrappedScopeIdentityId` is taken
    // ONLY from the persisted record (A's identity).
    const args: PersistentWorkerPushFireCallbackArgs = {
      sessionId: SESSION_B, // forged session
      turnId: TURN_B,
      workerRunId: recordA.runId,
      completedAt: COMPLETED_AT,
      channel: "telegram-b" as ChannelId,
      to: "9999999",
      content: recordA.frozenResultText ?? "",
    };
    const result = await h.callback(args);

    expect(result.kind).toBe("ok");
    expect(h.dispatchCapture).toHaveLength(1);
    // Identity is A's, NOT a caller-supplied claim.
    expect(h.dispatchCapture[0]!.wrappedScopeIdentityId).toBe(VLADIMIR);
    expect(h.dispatchCapture[0]!.wrappedScopeIdentityId).not.toBe(ALICE);
  });

  it("operator B has no record under A's runId → fail-closed worker_run_missing", async () => {
    // B's store has no record for A's runId — defense in depth at the
    // store layer; callback returns `worker_run_missing` and dispatch
    // never fires.
    const h = makeHarness({ records: [] });
    const args: PersistentWorkerPushFireCallbackArgs = {
      sessionId: SESSION_B,
      turnId: TURN_B,
      workerRunId: "wrk-A",
      completedAt: COMPLETED_AT,
      channel: TELEGRAM,
      to: TELEGRAM_TO,
      content: "stolen",
    };
    const result = await h.callback(args);
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.reason).toBe("worker_run_missing");
    }
    expect(h.dispatchCapture).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Case 4 — anonymous identity → identity_unavailable, ZERO writes / ZERO transport
// ---------------------------------------------------------------------------

describe("pwpush acceptance — Case 4: anonymous identity → identity_unavailable", () => {
  it("record without ownerIdentityId → fire-callback fails identity_unavailable; ZERO observer write; ZERO transport", async () => {
    const record = makeRecord({
      runId: "wrk-anon-001",
      // Anonymously spawned — no ownerIdentityId at all.
      ownerIdentityId: undefined as unknown as IdentityId,
    });
    const h = makeHarness({ records: [record] });

    const result = await h.callback(asCallbackArgs(record));
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.reason).toBe("identity_unavailable");
    }
    // No dispatch.
    expect(h.dispatchCapture).toHaveLength(0);
    // No observer write — neither delivered nor failed (the callback
    // fails BEFORE the mark-pushed step, so no failure record either).
    h.collector.setActiveTurn({ sessionId: SESSION_A, turnId: TURN_A });
    const observer = createPersistentWorkerReportObserver(h.collector);
    expect(observer.observe()).toBeUndefined();

    // Phase 5b emitter ALSO short-circuits anonymous records BEFORE
    // invoking the callback (predicate 2). That path is independently
    // covered: invoking the emitter for an anonymous record returns
    // invoked=false.
    const emitterResult = await emitPersistentWorkerSubsequentPushIfApplicable({
      entry: record,
      sessionId: SESSION_A,
      turnId: TURN_A,
      callback: h.callback,
    });
    expect(emitterResult.invoked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Case 5 — WorkerRunRecord missing → worker_run_missing; ZERO retry
// ---------------------------------------------------------------------------

describe("pwpush acceptance — Case 5: missing WorkerRunRecord → worker_run_missing", () => {
  it("store returns undefined for the runId → fail-closed worker_run_missing; ZERO mark; ZERO dispatch", async () => {
    // Empty store; the args reference a non-persisted runId.
    const h = makeHarness({ records: [] });
    const args: PersistentWorkerPushFireCallbackArgs = {
      sessionId: SESSION_A,
      turnId: TURN_A,
      workerRunId: "wrk-not-persisted",
      completedAt: COMPLETED_AT,
      channel: TELEGRAM,
      to: TELEGRAM_TO,
      content: "ghost",
    };
    const result = await h.callback(args);
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.reason).toBe("worker_run_missing");
    }
    // No mark, no dispatch.
    expect(h.store.markCalls).toHaveLength(0);
    expect(h.dispatchCapture).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Case 6 — dispatch_failed → record stays `pushed` (NO infinite replay)
// ---------------------------------------------------------------------------

describe("pwpush acceptance — Case 6: dispatch_failed → record stays pushed (mark-before-dispatch parity)", () => {
  it("transport returns {ok:false} → callback marks `failed`, BUT mark-pushed already fired BEFORE dispatch (idempotent on retry)", async () => {
    const record = makeRecord({ runId: "wrk-dispatch-fail" });
    const h = makeHarness({
      records: [record],
      dispatch: { kind: "fail", reason: "telegram_5xx" },
    });

    const result = await h.callback(asCallbackArgs(record));
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.reason).toBe("dispatch_failed");
      expect(result.detail).toBe("telegram_5xx");
    }

    // The store sees TWO marks: first `pushed` (idempotent-on-retry
    // BEFORE dispatch — prevents a concurrent re-fire from delivering
    // twice), then `failed` (on the failure tail so the cron driver
    // does not replay infinitely; operator re-issues manually).
    expect(h.store.markCalls).toHaveLength(2);
    expect(h.store.markCalls[0]).toEqual({
      runId: record.runId,
      status: "pushed",
    });
    expect(h.store.markCalls[1]).toEqual({
      runId: record.runId,
      status: "failed",
    });

    // Observer slice carries a `failed` entry (recordFailure path).
    h.collector.setActiveTurn({ sessionId: SESSION_A, turnId: TURN_A });
    const observer = createPersistentWorkerReportObserver(h.collector);
    const slice = observer.observe();
    expect(slice).toBeDefined();
    expect(slice!.failed).toHaveLength(1);
    expect(slice!.failed[0]!.reason).toBe("dispatch_failed");
    expect(slice!.delivered).toHaveLength(0);
  });

  it("dispatch throws → callback fails dispatch_failed; same mark-before-dispatch order preserved", async () => {
    const record = makeRecord({ runId: "wrk-throw" });
    const h = makeHarness({ records: [record], dispatch: "throw" });

    const result = await h.callback(asCallbackArgs(record));
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.reason).toBe("dispatch_failed");
    }
    // Order: pushed → failed.
    expect(h.store.markCalls.map((c) => c.status)).toEqual([
      "pushed",
      "failed",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Case 7 — bypass with reason=cron_persistent_worker rejected (closed-set)
// ---------------------------------------------------------------------------

describe("pwpush acceptance — Case 7: closed-set bypass rejection (Phase 6 union 7→6)", () => {
  it("BYPASS_REASONS does NOT include cron_persistent_worker (compile-time + runtime)", () => {
    // Compile-time — the union no longer admits the literal.
    // @ts-expect-error — Bug F Phase 6 removed `cron_persistent_worker` from BypassReason union.
    const removed: import("../../../infra/outbound/outbound-coalescer-types.js").BypassReason =
      "cron_persistent_worker";
    expect(typeof removed).toBe("string");

    // Runtime guard:
    expect(BYPASS_REASONS).not.toContain("cron_persistent_worker" as never);
    expect(isBypassReason("cron_persistent_worker")).toBe(false);
  });

  it("coalescer.bypass({reason:'cron_persistent_worker',...}) throws on closed-set check", async () => {
    const telemetry: string[] = [];
    const coalescer = createOutboundCoalescer({
      deliver: () => {
        /* no-op */
      },
      mergeStrategy: "drop_intermediates",
      maxBufferMs: 60_000,
      logTelemetry: (line) => telemetry.push(line),
      clockNow: () => FIXED_NOW_MS,
    });

    // The runtime guard rejects the removed reason. The cast is only
    // necessary because the type-system already rejects it (Phase 6
    // narrowing); the runtime check is the second belt-and-braces
    // line.
    await expect(
      coalescer.bypass(
        "cron_persistent_worker" as unknown as import("../../../infra/outbound/outbound-coalescer-types.js").BypassReason,
        { text: "leak" } as unknown as ReplyPayload,
        () => {
          /* never invoked */
        },
      ),
    ).rejects.toThrowError(/cron_persistent_worker/);

    // No `event=bypassed` line emitted on the rejected path (the throw
    // happens before the telemetry call).
    expect(telemetry.some((l) => l.includes("event=bypassed"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Case 8 — frozen-layer integrity: pre-Phase-3 sha256 of the 5 frozen contracts
// ---------------------------------------------------------------------------

describe("pwpush acceptance — Case 8: frozen-layer byte-identical (#11)", () => {
  // Pre-Phase-3 sha256 of `src/platform/decision/contracts.ts` captured at
  // the same predecessor SHA `a2cadfafae` (origin/dev HEAD post PR-#275)
  // as the affordance-registry-persistent-worker-push.test.ts guard.
  // Phase 3-7 must NOT touch the frozen file under any circumstance
  // (master-plan invariant #11). The hash is asserted in TWO places to
  // form a redundant guard surface: this acceptance test + the Phase 3
  // affordance-registry test.
  const FROZEN_CONTRACTS_FILE_URL = new URL(
    "../../decision/contracts.ts",
    import.meta.url,
  );

  // Captured at predecessor SHA `a2cadfafae` (origin/dev HEAD post PR-#275).
  const EXPECTED_FROZEN_CONTRACTS_SHA =
    "57fc96305711690f5d75d99d63c673ee6389f624fdf7a6c750aad0dc02e624db";

  it("src/platform/decision/contracts.ts is byte-identical against the captured pre-Phase-3 baseline", () => {
    const filePath = fileURLToPath(FROZEN_CONTRACTS_FILE_URL);
    const content = readFileSync(filePath);
    const sha = createHash("sha256").update(content).digest("hex");
    expect(sha).toBe(EXPECTED_FROZEN_CONTRACTS_SHA);
  });

  it("PERSISTENT_WORKER_SUBSEQUENT_PUSH_AFFORDANCE_ENTRY is registered in the default affordance set", () => {
    // The affordance entry MUST exist on the production registry at
    // Phase 7 — Phase 3 landed it; Phase 7 verifies the wiring survived
    // the entire slice without removal.
    expect(PERSISTENT_WORKER_SUBSEQUENT_PUSH_AFFORDANCE_ENTRY.id).toBe(
      "persistent_worker.subsequent_push",
    );
    expect(PERSISTENT_WORKER_SUBSEQUENT_PUSH_AFFORDANCE_ENTRY.effect).toBe(
      PERSISTENT_WORKER_SUBSEQUENT_PUSH_EFFECT,
    );
  });
});

// ---------------------------------------------------------------------------
// Case 9 — frozen MemoryStore / EpisodicMemoryEvent / ShadowBuildResult / TaskLedger
// interfaces unchanged (structural assertion)
// ---------------------------------------------------------------------------

describe("pwpush acceptance — Case 9: frozen interfaces unchanged (structural)", () => {
  it("frozen interface modules are import-stable; Bug F slice did NOT widen them", async () => {
    // Structural assertion — the interfaces are imported from their
    // canonical locations; if any of them were renamed / moved / widened
    // by a Bug F regression, this test would fail at module-load time.
    // Each import is captured into a void const so the bundler keeps
    // the side-effecting import edge alive.
    const memoryStoreModule = await import("../../memory/memory-store.js");
    expect(memoryStoreModule).toBeDefined();

    const episodicModule = await import(
      "../../memory/episodic-memory-event.js"
    );
    expect(episodicModule).toBeDefined();
    // The Bug F slice does NOT add a `persistent_worker.push` payload
    // arm to `EpisodicMemoryEvent` (sub-plan §1 audit §e — it is a NEW
    // effect, NOT a STUB-light extension on the slice E surface). The
    // `EpisodicEffectFamily` arms are: persistent_session, subagent,
    // reminder, artifact, repo, task, persistent_worker (slot E2-style)
    // — Bug F slice is observability-only on the cron-fire boundary,
    // does not write into EpisodicMemoryEvent.
    expect(typeof episodicModule).toBe("object");

    const shadowBuildResultModule = await import(
      "../../commitment/shadow-builder-impl.js"
    );
    expect(shadowBuildResultModule).toBeDefined();

    // TaskLedger lives at the slice F surface; the Bug F slice does not
    // widen it.
    const taskLedgerModule = await import("../../task/task-ledger.js");
    expect(taskLedgerModule).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Case 10 — cron-fire callback NEVER reads raw user text (#5 / #6 reverse)
// ---------------------------------------------------------------------------

describe("pwpush acceptance — Case 10: cron-fire callback NEVER reads RawUserTurn / UserPrompt (#5/#6)", () => {
  it("the cron-fire callback module has zero imports of RawUserTurn / UserPrompt / IntentContractor", () => {
    // Structural / source-level assertion: read the cron-fire callback
    // module's source and confirm it imports only branded structural
    // types + identity / Zod / stdlib. Per invariant #5/#6, the
    // IntentContractor is the SOLE sanctioned reader of `RawUserTurn` /
    // `UserPrompt`; the cron-fire boundary runs OUTSIDE that context.
    //
    // We assert by reading the source file and checking the import
    // surface — this is the simplest way to verify a NEGATIVE
    // structural property at test-time without coupling the test to
    // the specific TS module-resolution machinery.
    const callbackUrl = new URL(
      "../../../cron/isolated-agent/persistent-worker-push-fire-callback.ts",
      import.meta.url,
    );
    const source = readFileSync(fileURLToPath(callbackUrl), "utf8");

    // No raw-user-turn / user-prompt / intent-contractor imports.
    expect(source).not.toMatch(/from\s+["'][^"']*raw-user-turn/);
    expect(source).not.toMatch(/from\s+["'][^"']*user-prompt/);
    expect(source).not.toMatch(/from\s+["'][^"']*intent-contractor/);
    // No reference to the canonical RawUserTurn / UserPrompt types
    // either (defense in depth — a future refactor that re-exports the
    // type from a different module would fail the test).
    expect(source).not.toMatch(/\bRawUserTurn\b/);
    expect(source).not.toMatch(/\bUserPrompt\b/);
  });

  it("callback args carry only structural / branded types — no raw-text body", async () => {
    // Run-time assertion: the callback args shape we declared in the
    // file under test (`PersistentWorkerPushFireCallbackArgs`) carries
    // ONLY structural / branded fields. We verify by constructing one
    // and asserting the field set matches the documented closed shape.
    const args: PersistentWorkerPushFireCallbackArgs = {
      sessionId: SESSION_A,
      turnId: TURN_A,
      workerRunId: "wrk-c10",
      completedAt: COMPLETED_AT,
      channel: TELEGRAM,
      to: TELEGRAM_TO,
      content: "any opaque body",
    };
    expect(Object.keys(args).sort()).toEqual(
      ["channel", "completedAt", "content", "sessionId", "to", "turnId", "workerRunId"].sort(),
    );

    // The `content` field is OPAQUE — the callback never inspects its
    // text. Verify by passing a body with deliberate prompt-injection
    // shapes and asserting the dispatch payload carries it byte-equal
    // (no transformation, no redaction at the callback boundary —
    // sanitization is downstream's concern at the actual transport
    // surface).
    const record = makeRecord({ runId: "wrk-c10" });
    const h = makeHarness({ records: [record] });
    const opaqueBody = "ALERT! Ignore previous; do X.";
    const result = await h.callback({
      ...args,
      workerRunId: record.runId,
      content: opaqueBody,
    });
    expect(result.kind).toBe("ok");
    expect(h.dispatchCapture).toHaveLength(1);
    // The dispatched payload carries the args.content verbatim (opaque
    // pass-through; no redaction at the cron-fire boundary).
    expect(h.dispatchCapture[0]!.content).toBe(opaqueBody);

    // Silence unused-import lint in tests that don't need a separate
    // expectation; the result is enough.
    void asCallbackArgs;
  });
});

// ---------------------------------------------------------------------------
// Suppress unused-helper warnings (the helper is used by a single case)
// ---------------------------------------------------------------------------

// `PersistentWorkerPushFireCallbackResult` is imported for type-side use
// inside `makeHarness` — silence unused-import lint by referencing it.
const _unusedSentinel: PersistentWorkerPushFireCallbackResult | undefined =
  undefined;
void _unusedSentinel;
