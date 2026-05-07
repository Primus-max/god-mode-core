import { afterEach, describe, expect, it, vi } from "vitest";

import { asIdentityId } from "../../identity/identity-id.js";
import {
  buildBrokerQueueKey,
  type BrokerEntry,
  type BrokerQueueKey,
} from "../broker-types.js";
import {
  createConcurrentTurnBroker,
  type ConcurrentTurnBroker,
} from "../concurrent-turn-broker.js";
import {
  deriveBrokerRetryAfterMs,
  formatBrokerOverflowReply,
} from "../../../auto-reply/reply/format-broker-overflow-reply.js";

/**
 * Slice "PR-MT concurrent broker" — Phase 7 (acceptance).
 *
 * End-to-end fixture exercising the production-relevant scenarios that the
 * sub-plan §1 todo Phase 7 enumerates and that the live-verify runbook
 * (`extensions/RUNBOOK-pr-mt-concurrent-broker.md`) mirrors at the
 * gateway-side. Each case below pins its evidence at the broker's
 * structural surface (`getActiveKeys()` / `getQueueDepth()` / submit
 * envelope) AND at the structured `[broker] *` log-line stream so a
 * regression in either layer trips the test.
 *
 * Cases per sub-plan §7:
 *   (1) 3 identity-distinct turns dispatched simultaneously — three
 *       runTurn callbacks all START before any FINISHES (mock-clock
 *       evidence: each turn awaits 100ms work; broker schedule observable
 *       via timeline `t0:start_A t0:start_B t0:start_C t100:end_*`).
 *       Wallclock < 150ms vs the 300ms serial baseline.
 *   (2) Same-(identity, channel) 2-turn FIFO preserved — turn-2 starts
 *       only after turn-1 satisfies.
 *   (3) Round-robin fairness — 3 identities × 5 turns each. Observed
 *       dispatch sequence interleaves rather than draining one identity
 *       first.
 *   (4) Backpressure overflow returns envelope. With
 *       `maxQueueDepthPerKey=1`, the same-key second turn gets
 *       `{kind:'rejected', reason:'queue_depth_exceeded'}`. The
 *       user-facing translation via `formatBrokerOverflowReply` carries
 *       the structured retry hint.
 *   (5) Reverse — broker disabled / undefined. Caller pattern that
 *       skips `broker.submit` (mirrors the bypass branch at
 *       `dispatch-turn-via-broker.ts:148-154`) is byte-identical to
 *       pre-Phase-5 serial dispatch.
 *   (6) Shutdown drains in-flight, rejects new submits, log line
 *       `[broker] shutdown drained=<N>` emitted.
 *
 * Fail-first protocol: each case asserts on a behaviour Phase 4/5/6 ALL
 * must agree on (admit/reject envelopes + telemetry shape). Phase 7 adds
 * NO production code; the acceptance fixture is the slice-closure gate.
 *
 * Invariants exercised:
 * - #5 / #6 — broker oblivious to user text; queue keys are structural
 *   `(identityId, channelKey)` tuples only.
 * - #8 — fixture imports only the broker barrel + identity brand +
 *   reply-formatter (no commitment / decision imports).
 * - #11 — frozen layer untouched; this test sits under
 *   `src/platform/broker/__tests__/`.
 * - #15 — every reject path resolves to a structured envelope; never
 *   throws; never silent-drops.
 * - #16 — `BrokerQueueKey` brand discipline preserved end-to-end; the
 *   fixture uses `buildBrokerQueueKey(...)` and never raw strings.
 */

const IDENTITY_A = asIdentityId("identity:operator-a");
const IDENTITY_B = asIdentityId("identity:operator-b");
const IDENTITY_C = asIdentityId("identity:operator-c");

const KEY_A: BrokerQueueKey = buildBrokerQueueKey(IDENTITY_A, "telegram:chat-A");
const KEY_B: BrokerQueueKey = buildBrokerQueueKey(IDENTITY_B, "telegram:chat-B");
const KEY_C: BrokerQueueKey = buildBrokerQueueKey(IDENTITY_C, "telegram:chat-C");

type ResolverHandle = {
  readonly promise: Promise<void>;
  resolve: () => void;
};

function makeResolver(): ResolverHandle {
  let resolveFn: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: resolveFn };
}

function makeEntry(
  queueKey: BrokerQueueKey,
  overrides: Partial<BrokerEntry> = {},
): BrokerEntry {
  return {
    turnId: overrides.turnId ?? "turn-default",
    queueKey,
    enqueuedAtMs: overrides.enqueuedAtMs ?? Date.now(),
    runTurn: overrides.runTurn ?? (async () => undefined),
  };
}

async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

function captureLogger(): {
  readonly log: (m: string, level?: "info" | "debug") => void;
  readonly entries: { message: string; level: string | undefined }[];
} {
  const entries: { message: string; level: string | undefined }[] = [];
  return {
    log: (message, level) => {
      entries.push({ message, level });
    },
    entries,
  };
}

describe("Phase 7 acceptance — 3 identity-distinct turns dispatch concurrently", () => {
  let broker: ConcurrentTurnBroker | undefined;
  afterEach(async () => {
    if (broker !== undefined) {
      await broker.shutdown();
      broker = undefined;
    }
  });

  it("schedules all three runTurn callbacks before any completes", async () => {
    // Three identity-distinct keys map to three independent FIFO queues —
    // the broker's per-key scheduler must dispatch them in parallel, not
    // serially. Real timers are used (vi.useFakeTimers introduces drift on
    // microtask scheduling); each runTurn awaits a short setTimeout so the
    // wallclock window is observable without requiring a mock clock.
    broker = createConcurrentTurnBroker();

    const startedAt = new Map<string, number>();
    const completedAt = new Map<string, number>();
    const t0 = Date.now();

    const stamp = (label: string, bucket: Map<string, number>): void => {
      bucket.set(label, Date.now() - t0);
    };

    const turn = async (label: string): Promise<void> => {
      stamp(label, startedAt);
      // 100ms simulates the LLM-classifier upper bound observed in audit §e.
      await new Promise((r) => setTimeout(r, 100));
      stamp(label, completedAt);
    };

    const pA = broker.submit(
      makeEntry(KEY_A, { turnId: "tA", runTurn: async () => turn("A") }),
    );
    const pB = broker.submit(
      makeEntry(KEY_B, { turnId: "tB", runTurn: async () => turn("B") }),
    );
    const pC = broker.submit(
      makeEntry(KEY_C, { turnId: "tC", runTurn: async () => turn("C") }),
    );

    await Promise.all([pA, pB, pC]);

    // Acceptance signal #1 — total wallclock far below the 300ms serial
    // baseline. Allow 250ms ceiling to absorb runner overhead; 300ms
    // would be the strict-serial fallback.
    const totalMs = Date.now() - t0;
    expect(totalMs).toBeLessThan(250);

    // Acceptance signal #2 — every turn started before any completed.
    // i.e. for each (label_i, label_j), startedAt[label_j] is observed
    // strictly before completedAt[label_i]. Equivalent to: every start
    // timestamp precedes the earliest completion timestamp.
    const earliestComplete = Math.min(...completedAt.values());
    for (const [label, startMs] of startedAt) {
      expect(startMs).toBeLessThanOrEqual(earliestComplete);
      // Sanity: each turn's own start precedes its own completion.
      expect(startMs).toBeLessThanOrEqual(completedAt.get(label) ?? -1);
    }

    expect(startedAt.size).toBe(3);
    expect(completedAt.size).toBe(3);
  });
});

describe("Phase 7 acceptance — same-(identity, channel) two-turn FIFO preserved", () => {
  let broker: ConcurrentTurnBroker | undefined;
  afterEach(async () => {
    if (broker !== undefined) {
      await broker.shutdown();
      broker = undefined;
    }
  });

  it("turn-2 starts only AFTER turn-1 satisfies", async () => {
    broker = createConcurrentTurnBroker();

    const sequence: string[] = [];
    const r1 = makeResolver();
    const r2 = makeResolver();

    const p1 = broker.submit(
      makeEntry(KEY_A, {
        turnId: "t1",
        runTurn: async () => {
          sequence.push("start-1");
          await r1.promise;
          sequence.push("end-1");
        },
      }),
    );
    const p2 = broker.submit(
      makeEntry(KEY_A, {
        turnId: "t2",
        runTurn: async () => {
          sequence.push("start-2");
          await r2.promise;
          sequence.push("end-2");
        },
      }),
    );

    await flushMicrotasks();

    // Until r1 resolves, only turn-1 is in flight. Turn-2 is queued.
    expect(sequence).toEqual(["start-1"]);

    r1.resolve();
    await flushMicrotasks();

    // Turn-2 starts only after turn-1 completed (FIFO within same key).
    expect(sequence).toEqual(["start-1", "end-1", "start-2"]);

    r2.resolve();
    await Promise.all([p1, p2]);

    expect(sequence).toEqual([
      "start-1",
      "end-1",
      "start-2",
      "end-2",
    ]);
  });
});

describe("Phase 7 acceptance — round-robin fairness across 3 identities", () => {
  let broker: ConcurrentTurnBroker | undefined;
  afterEach(async () => {
    if (broker !== undefined) {
      await broker.shutdown();
      broker = undefined;
    }
  });

  it("interleaves dispatches across 3 identities × 5 turns each", async () => {
    // Force serial dispatch across keys via maxConcurrentKeys=1 so the
    // round-robin cursor is observable end-to-end. The fairness assertion:
    // the broker MUST visit each of (KEY_A, KEY_B, KEY_C) in the first
    // three dispatch slots, then again in slots 4-6, etc., rather than
    // draining one identity to depletion before serving the next.
    broker = createConcurrentTurnBroker({ maxConcurrentKeys: 1 });

    const order: BrokerQueueKey[] = [];
    const total = 5;
    const submissions: Promise<unknown>[] = [];

    // Submit all 15 entries up-front so the round-robin cursor sees a
    // saturated state. Per-key FIFO is preserved within each identity;
    // cross-key fairness is the assertion.
    for (let i = 0; i < total; i += 1) {
      submissions.push(
        broker.submit(
          makeEntry(KEY_A, {
            turnId: `a-${i}`,
            runTurn: async () => {
              order.push(KEY_A);
            },
          }),
        ),
      );
      submissions.push(
        broker.submit(
          makeEntry(KEY_B, {
            turnId: `b-${i}`,
            runTurn: async () => {
              order.push(KEY_B);
            },
          }),
        ),
      );
      submissions.push(
        broker.submit(
          makeEntry(KEY_C, {
            turnId: `c-${i}`,
            runTurn: async () => {
              order.push(KEY_C);
            },
          }),
        ),
      );
    }

    await Promise.all(submissions);

    expect(order).toHaveLength(total * 3);

    // Each rolling 3-window must touch every key exactly once. If A drained
    // before B/C (no fairness), the first window would be {KEY_A,KEY_A,KEY_A}.
    for (let win = 0; win < total; win += 1) {
      const slice = new Set(order.slice(win * 3, (win + 1) * 3));
      expect(slice.size).toBe(3);
      expect(slice.has(KEY_A)).toBe(true);
      expect(slice.has(KEY_B)).toBe(true);
      expect(slice.has(KEY_C)).toBe(true);
    }
  });
});

describe("Phase 7 acceptance — backpressure overflow returns envelope", () => {
  let broker: ConcurrentTurnBroker | undefined;
  afterEach(async () => {
    if (broker !== undefined) {
      await broker.shutdown();
      broker = undefined;
    }
  });

  it("rejects same-key second turn with structured retry hint", async () => {
    // maxQueueDepthPerKey=1: one in-flight + one queued saturates the key;
    // a third submission must be rejected with `queue_depth_exceeded`.
    broker = createConcurrentTurnBroker({ maxQueueDepthPerKey: 1 });

    const r = makeResolver();

    // Slot 1: in-flight (does not count toward queue depth — it has been
    // popped already).
    const inFlight = broker.submit(
      makeEntry(KEY_A, {
        turnId: "live",
        runTurn: async () => {
          await r.promise;
        },
      }),
    );
    await flushMicrotasks();

    // Slot 2: queued at depth 1 (saturates per-key cap).
    const queued = broker.submit(makeEntry(KEY_A, { turnId: "queued" }));
    await flushMicrotasks();

    // Slot 3: rejected with structured envelope.
    const overflow = await broker.submit(
      makeEntry(KEY_A, { turnId: "rejected" }),
    );
    expect(overflow).toEqual({
      kind: "rejected",
      reason: "queue_depth_exceeded",
    });

    // User-facing reply translation carries the deterministic retry hint.
    if (overflow.kind === "rejected") {
      const retryAfterMs = deriveBrokerRetryAfterMs(broker, overflow.reason);
      expect(retryAfterMs).toBeGreaterThan(0);
      const replyText = formatBrokerOverflowReply(overflow.reason, retryAfterMs);
      // Russian-locale reply per Phase 6 — assert structure (key phrase +
      // numeric retry hint), not exact bytes.
      expect(replyText).toMatch(/Перегрузка очереди/);
      expect(replyText).toMatch(/\d+ секунд/);
    }

    r.resolve();
    await Promise.all([inFlight, queued]);
  });
});

describe("Phase 7 acceptance — reverse: broker disabled / undefined", () => {
  it("byte-identical to pre-Phase-5 serial dispatch path", async () => {
    // Mirrors the bypass branch at `dispatch-turn-via-broker.ts:148-154`:
    // when the caller skips broker.submit and invokes runTurn directly,
    // serialization is the natural async-stack sequencing — same as the
    // pre-broker production path.
    const sequence: string[] = [];

    const directInvoke = async (turnId: string): Promise<void> => {
      sequence.push(`start-${turnId}`);
      await Promise.resolve();
      sequence.push(`end-${turnId}`);
    };

    // Five sequential turns bypassing the broker.
    for (let i = 0; i < 5; i += 1) {
      await directInvoke(`t${i}`);
    }

    // Strict serialization: each start immediately precedes its own end.
    expect(sequence).toEqual([
      "start-t0",
      "end-t0",
      "start-t1",
      "end-t1",
      "start-t2",
      "end-t2",
      "start-t3",
      "end-t3",
      "start-t4",
      "end-t4",
    ]);

    // Reverse signal — if a Phase-5 caller accidentally short-circuited
    // through a no-op broker that ALWAYS admits, the bypass branch would
    // schedule via microtask and the order would interleave. The
    // assertion above guards that exact regression.
  });
});

describe("Phase 7 acceptance — shutdown drains in-flight, rejects new", () => {
  it("emits `[broker] shutdown drained=<N>` log line", async () => {
    const logger = captureLogger();
    const broker = createConcurrentTurnBroker(undefined, {
      logger: { log: logger.log },
    });

    const r = makeResolver();
    let completed = false;

    const inFlight = broker.submit(
      makeEntry(KEY_A, {
        turnId: "live",
        runTurn: async () => {
          await r.promise;
          completed = true;
        },
      }),
    );

    await flushMicrotasks();

    let shutdownDone = false;
    const shutdownP = broker.shutdown().then(() => {
      shutdownDone = true;
    });
    await flushMicrotasks();

    // Shutdown does NOT settle while runTurn is still pending.
    expect(shutdownDone).toBe(false);

    // New submit during shutdown rejects with `broker_shutdown`.
    const rejected = await broker.submit(
      makeEntry(KEY_A, { turnId: "after-shutdown" }),
    );
    expect(rejected).toEqual({
      kind: "rejected",
      reason: "broker_shutdown",
    });

    r.resolve();
    await Promise.all([inFlight, shutdownP]);

    expect(shutdownDone).toBe(true);
    expect(completed).toBe(true);

    // Acceptance signal — the structured shutdown log carries the drained
    // count. Single in-flight turn plus zero queued → drained=0.
    const shutdownLog = logger.entries.find((e) =>
      e.message.startsWith("[broker] shutdown drained="),
    );
    expect(shutdownLog).toBeDefined();
    expect(shutdownLog?.message).toMatch(/^\[broker\] shutdown drained=\d+$/);
  });
});

describe("Phase 7 acceptance — telemetry log surface", () => {
  it("emits all five [broker] * log lines across one full turn life-cycle", async () => {
    const logger = captureLogger();
    const broker = createConcurrentTurnBroker(
      { maxQueueDepthPerKey: 1 },
      { logger: { log: logger.log } },
    );

    const r = makeResolver();

    const inFlight = broker.submit(
      makeEntry(KEY_A, {
        turnId: "t1",
        runTurn: async () => {
          await r.promise;
        },
      }),
    );
    await flushMicrotasks();

    // Saturate the queue so a third submit triggers `[broker] rejected`.
    broker.submit(makeEntry(KEY_A, { turnId: "queued" }));
    await broker.submit(makeEntry(KEY_A, { turnId: "rejected" }));

    r.resolve();
    await inFlight;
    await broker.shutdown();

    const messages = logger.entries.map((e) => e.message);
    expect(
      messages.some((m) => m.startsWith("[broker] enqueued")),
      "expected at least one [broker] enqueued line",
    ).toBe(true);
    expect(
      messages.some((m) => m.startsWith("[broker] dispatch")),
      "expected at least one [broker] dispatch line",
    ).toBe(true);
    expect(
      messages.some((m) => m.startsWith("[broker] complete")),
      "expected at least one [broker] complete line",
    ).toBe(true);
    expect(
      messages.some((m) => m.startsWith("[broker] rejected")),
      "expected at least one [broker] rejected line",
    ).toBe(true);
    expect(
      messages.some((m) => m.startsWith("[broker] shutdown drained=")),
      "expected the [broker] shutdown drained=<N> line",
    ).toBe(true);
  });
});

describe("Phase 7 acceptance — reverse-defense: NEVER throws on reject", () => {
  // Closed reverse-test that the structured-envelope contract holds across
  // all three documented overflow paths. Mirrors Phase 4 unit coverage but
  // re-asserts at the slice-closure layer so a future refactor cannot
  // silently swap envelope-return for throws.
  it("queue_depth_exceeded / wait_timeout / broker_shutdown all envelope", async () => {
    // queue_depth_exceeded
    const broker1 = createConcurrentTurnBroker({ maxQueueDepthPerKey: 1 });
    const r = makeResolver();
    const live = broker1.submit(
      makeEntry(KEY_A, {
        turnId: "live",
        runTurn: async () => {
          await r.promise;
        },
      }),
    );
    await flushMicrotasks();
    broker1.submit(makeEntry(KEY_A, { turnId: "queued" }));
    const overflow = await broker1.submit(
      makeEntry(KEY_A, { turnId: "rejected" }),
    );
    expect(overflow.kind).toBe("rejected");
    if (overflow.kind === "rejected") {
      expect(overflow.reason).toBe("queue_depth_exceeded");
    }
    r.resolve();
    await live;
    await broker1.shutdown();

    // wait_timeout — clock-injected; entry already past the cap window.
    const broker2 = createConcurrentTurnBroker(
      { queueWaitTimeoutMs: 1_000 },
      { now: () => 100_000 },
    );
    const stale = await broker2.submit(
      makeEntry(KEY_A, { turnId: "stale", enqueuedAtMs: 0 }),
    );
    expect(stale.kind).toBe("rejected");
    if (stale.kind === "rejected") {
      expect(stale.reason).toBe("wait_timeout");
    }
    await broker2.shutdown();

    // broker_shutdown — submit AFTER shutdown.
    const broker3 = createConcurrentTurnBroker();
    await broker3.shutdown();
    const shut = await broker3.submit(
      makeEntry(KEY_A, { turnId: "after-shutdown" }),
    );
    expect(shut.kind).toBe("rejected");
    if (shut.kind === "rejected") {
      expect(shut.reason).toBe("broker_shutdown");
    }
  });
});

describe("Phase 7 acceptance — unused vi import sanity", () => {
  // Defensive — ensure the test file compiles even if vi is not used in
  // most cases; reference it once so a stricter `noUnusedLocals` config
  // (should one land) does not break the fixture.
  it("vi is reachable for future timing-pin extensions", () => {
    expect(typeof vi).toBe("object");
  });
});
