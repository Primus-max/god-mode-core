import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

/**
 * Phase 4 — fail-first tests for `ConcurrentTurnBroker` runtime.
 *
 * The broker is the process-scoped scheduler that sits between
 * inbound-channel callers and `runTurnDecision`. It owns the mutable
 * `Map<BrokerQueueKey, BrokerEntry[]>` per-key FIFO state, the round-robin
 * `keyOrder` cursor, and the bounded `inFlight` set; it consumes the
 * Phase 3 pure helpers (`decideQueuePlacement`, `decideNextDispatch`)
 * verbatim and translates each decision into a state mutation + log line.
 *
 * Invariants verified here:
 * - #15 — every code path returns a structured envelope; the broker
 *   NEVER throws (including when the inner `runTurn` callback throws).
 * - Single-key serial FIFO; cross-key concurrency bounded by
 *   `maxConcurrentKeys`; round-robin fairness across keys.
 * - All five `[broker] *` log lines emitted at the documented filter
 *   exits (enqueued/dispatch/complete/rejected/shutdown).
 * - Clock injection — `now` is the only wall-clock source so tests pin
 *   timing deterministically.
 */

const IDENTITY = asIdentityId("identity:operator-a");
const KEY_A: BrokerQueueKey = buildBrokerQueueKey(IDENTITY, "telegram:1");
const KEY_B: BrokerQueueKey = buildBrokerQueueKey(IDENTITY, "telegram:2");
const KEY_C: BrokerQueueKey = buildBrokerQueueKey(IDENTITY, "telegram:3");

type ResolverHandle = {
  readonly promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
};

function makeResolver(): ResolverHandle {
  let resolveFn: () => void = () => undefined;
  let rejectFn: (err: Error) => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

function makeEntry(
  queueKey: BrokerQueueKey,
  overrides: Partial<BrokerEntry> = {},
): BrokerEntry {
  return {
    turnId: overrides.turnId ?? "turn-1",
    queueKey,
    enqueuedAtMs: overrides.enqueuedAtMs ?? Date.now(),
    runTurn: overrides.runTurn ?? (async () => undefined),
  };
}

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

describe("createConcurrentTurnBroker — single-key serial FIFO", () => {
  it("dispatches three entries to the same key in submission order", async () => {
    const sequence: string[] = [];
    const broker = createConcurrentTurnBroker();

    const r1 = makeResolver();
    const r2 = makeResolver();
    const r3 = makeResolver();

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
    const p3 = broker.submit(
      makeEntry(KEY_A, {
        turnId: "t3",
        runTurn: async () => {
          sequence.push("start-3");
          await r3.promise;
          sequence.push("end-3");
        },
      }),
    );

    await flushMicrotasks();
    // Only first runTurn started; others queued behind same-key in-flight
    expect(sequence).toEqual(["start-1"]);

    r1.resolve();
    await flushMicrotasks();
    expect(sequence).toEqual(["start-1", "end-1", "start-2"]);

    r2.resolve();
    await flushMicrotasks();
    expect(sequence).toEqual([
      "start-1",
      "end-1",
      "start-2",
      "end-2",
      "start-3",
    ]);

    r3.resolve();
    const [res1, res2, res3] = await Promise.all([p1, p2, p3]);
    expect(res1).toEqual({ kind: "completed" });
    expect(res2).toEqual({ kind: "completed" });
    expect(res3).toEqual({ kind: "completed" });
  });
});

describe("createConcurrentTurnBroker — two-key concurrency", () => {
  it("starts both keys before either completes", async () => {
    const broker = createConcurrentTurnBroker();
    const rA = makeResolver();
    const rB = makeResolver();
    let aStarted = false;
    let bStarted = false;

    const pA = broker.submit(
      makeEntry(KEY_A, {
        turnId: "tA",
        runTurn: async () => {
          aStarted = true;
          await rA.promise;
        },
      }),
    );
    const pB = broker.submit(
      makeEntry(KEY_B, {
        turnId: "tB",
        runTurn: async () => {
          bStarted = true;
          await rB.promise;
        },
      }),
    );

    await flushMicrotasks();
    // Two distinct keys -> both runTurn started before any completed
    expect(aStarted).toBe(true);
    expect(bStarted).toBe(true);

    rA.resolve();
    rB.resolve();
    const [resA, resB] = await Promise.all([pA, pB]);
    expect(resA.kind).toBe("completed");
    expect(resB.kind).toBe("completed");
  });
});

describe("createConcurrentTurnBroker — round-robin fairness across 3 keys", () => {
  it("interleaves dispatches across keys A/B/C", async () => {
    // Force serial dispatch across keys via maxConcurrentKeys=1 so the
    // round-robin cursor is observable — the broker dispatches one key at
    // a time and the cursor advances each cycle.
    const order: BrokerQueueKey[] = [];
    const broker = createConcurrentTurnBroker({ maxConcurrentKeys: 1 });

    const total = 5;
    const submissions: Promise<unknown>[] = [];
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
    // First three dispatches must visit each key once (round-robin across
    // keyOrder); strict-serial since maxConcurrentKeys=1.
    const firstWindow = new Set(order.slice(0, 3));
    expect(firstWindow.size).toBe(3);
    const secondWindow = new Set(order.slice(3, 6));
    expect(secondWindow.size).toBe(3);
  });
});

describe("createConcurrentTurnBroker — queue_depth_exceeded", () => {
  it("rejects entries beyond the per-key depth cap", async () => {
    const broker = createConcurrentTurnBroker({ maxQueueDepthPerKey: 2 });
    const r = makeResolver();

    // First entry occupies in-flight slot
    const p1 = broker.submit(
      makeEntry(KEY_A, {
        turnId: "t1",
        runTurn: async () => {
          await r.promise;
        },
      }),
    );
    await flushMicrotasks();

    // Two entries fill the per-key queue (cap=2)
    const p2 = broker.submit(makeEntry(KEY_A, { turnId: "t2" }));
    const p3 = broker.submit(makeEntry(KEY_A, { turnId: "t3" }));
    await flushMicrotasks();

    // Third entry beyond cap → rejected
    const rejected = await broker.submit(
      makeEntry(KEY_A, { turnId: "t4-rejected" }),
    );
    expect(rejected).toEqual({
      kind: "rejected",
      reason: "queue_depth_exceeded",
    });

    r.resolve();
    await Promise.all([p1, p2, p3]);
  });
});

describe("createConcurrentTurnBroker — wait_timeout", () => {
  it("rejects when entry age exceeds queueWaitTimeoutMs at admission", async () => {
    const clock = { current: 10_000 };
    const broker = createConcurrentTurnBroker(
      { queueWaitTimeoutMs: 1_000 },
      { now: () => clock.current },
    );

    // Entry enqueuedAtMs is BEFORE the cap-window — already-stale at admission.
    const result = await broker.submit(
      makeEntry(KEY_A, { turnId: "stale", enqueuedAtMs: 0 }),
    );
    expect(result).toEqual({ kind: "rejected", reason: "wait_timeout" });
  });
});

describe("createConcurrentTurnBroker — shutdown rejects new submits", () => {
  it("returns broker_shutdown after shutdown() is called", async () => {
    const broker = createConcurrentTurnBroker();
    await broker.shutdown();

    const result = await broker.submit(makeEntry(KEY_A, { turnId: "after" }));
    expect(result).toEqual({ kind: "rejected", reason: "broker_shutdown" });
  });

  it("drains in-flight entries before shutdown completes", async () => {
    const broker = createConcurrentTurnBroker();
    const r = makeResolver();
    let completed = false;

    const submitP = broker.submit(
      makeEntry(KEY_A, {
        turnId: "in-flight",
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
    // shutdown does NOT resolve while runTurn is still pending
    expect(shutdownDone).toBe(false);
    expect(completed).toBe(false);

    r.resolve();
    await Promise.all([submitP, shutdownP]);
    expect(shutdownDone).toBe(true);
    expect(completed).toBe(true);
  });
});

describe("createConcurrentTurnBroker — maxConcurrentKeys cap", () => {
  it("caps in-flight set; (N+1)th key waits", async () => {
    const broker = createConcurrentTurnBroker({ maxConcurrentKeys: 2 });
    const rA = makeResolver();
    const rB = makeResolver();
    const rC = makeResolver();
    let cStarted = false;

    const pA = broker.submit(
      makeEntry(KEY_A, {
        turnId: "tA",
        runTurn: async () => {
          await rA.promise;
        },
      }),
    );
    const pB = broker.submit(
      makeEntry(KEY_B, {
        turnId: "tB",
        runTurn: async () => {
          await rB.promise;
        },
      }),
    );
    const pC = broker.submit(
      makeEntry(KEY_C, {
        turnId: "tC",
        runTurn: async () => {
          cStarted = true;
          await rC.promise;
        },
      }),
    );

    await flushMicrotasks();
    // A and B are in-flight; C is queued because maxConcurrentKeys=2
    expect(cStarted).toBe(false);

    rA.resolve();
    await flushMicrotasks();
    // A completed → C now allowed to dispatch
    expect(cStarted).toBe(true);

    rB.resolve();
    rC.resolve();
    await Promise.all([pA, pB, pC]);
  });
});

describe("createConcurrentTurnBroker — reverse: NEVER drops, always envelopes", () => {
  it("returns structured rejection on every overflow path", async () => {
    // queue_depth_exceeded
    const broker1 = createConcurrentTurnBroker({ maxQueueDepthPerKey: 1 });
    const r = makeResolver();
    const p1 = broker1.submit(
      makeEntry(KEY_A, {
        turnId: "live",
        runTurn: async () => {
          await r.promise;
        },
      }),
    );
    await flushMicrotasks();
    // queue is at cap
    broker1.submit(makeEntry(KEY_A, { turnId: "queued" }));
    const overflow = await broker1.submit(
      makeEntry(KEY_A, { turnId: "rejected" }),
    );
    expect(overflow.kind).toBe("rejected");
    if (overflow.kind === "rejected") {
      expect(overflow.reason).toBe("queue_depth_exceeded");
    }
    r.resolve();
    await p1;

    // wait_timeout
    const clock = { current: 100_000 };
    const broker2 = createConcurrentTurnBroker(
      { queueWaitTimeoutMs: 1_000 },
      { now: () => clock.current },
    );
    const stale = await broker2.submit(
      makeEntry(KEY_A, { turnId: "stale", enqueuedAtMs: 0 }),
    );
    expect(stale.kind).toBe("rejected");
    if (stale.kind === "rejected") expect(stale.reason).toBe("wait_timeout");

    // broker_shutdown
    const broker3 = createConcurrentTurnBroker();
    await broker3.shutdown();
    const shut = await broker3.submit(makeEntry(KEY_A, { turnId: "after" }));
    expect(shut.kind).toBe("rejected");
    if (shut.kind === "rejected") expect(shut.reason).toBe("broker_shutdown");
  });

  it("does NOT throw when runTurn rejects; envelope still returned", async () => {
    const broker = createConcurrentTurnBroker();
    const result = await broker.submit(
      makeEntry(KEY_A, {
        turnId: "throwing",
        runTurn: async () => {
          throw new Error("boom");
        },
      }),
    );
    // Broker swallows runTurn rejection; submit resolves to completed because
    // the entry was admitted and dispatched. The error is logged, not thrown.
    expect(result).toEqual({ kind: "completed" });
  });
});

describe("createConcurrentTurnBroker — telemetry log lines", () => {
  let logs: { message: string; level: string | undefined }[];
  let logger: { log: (m: string, level?: "info" | "debug") => void };
  let broker: ConcurrentTurnBroker;

  beforeEach(() => {
    logs = [];
    logger = {
      log: (message, level) => {
        logs.push({ message, level });
      },
    };
  });

  afterEach(async () => {
    if (broker) await broker.shutdown();
  });

  it("emits enqueued + dispatch + complete + rejected + shutdown", async () => {
    broker = createConcurrentTurnBroker(
      { maxQueueDepthPerKey: 1 },
      { logger },
    );
    const r = makeResolver();

    const p1 = broker.submit(
      makeEntry(KEY_A, {
        turnId: "t1",
        runTurn: async () => {
          await r.promise;
        },
      }),
    );
    await flushMicrotasks();

    // Triggers queue_depth_exceeded → rejected log
    broker.submit(makeEntry(KEY_A, { turnId: "t2-q" }));
    await broker.submit(makeEntry(KEY_A, { turnId: "t3-rej" }));

    r.resolve();
    await p1;
    await broker.shutdown();

    const messages = logs.map((l) => l.message);
    expect(messages.some((m) => m.startsWith("[broker] enqueued"))).toBe(true);
    expect(messages.some((m) => m.startsWith("[broker] dispatch"))).toBe(true);
    expect(messages.some((m) => m.startsWith("[broker] complete"))).toBe(true);
    expect(messages.some((m) => m.startsWith("[broker] rejected"))).toBe(true);
    expect(messages.some((m) => m.startsWith("[broker] shutdown"))).toBe(true);
  });

  it("dispatch log carries waitMs computed from injected clock", async () => {
    const clock = { current: 1_000 };
    broker = createConcurrentTurnBroker(undefined, {
      logger,
      now: () => clock.current,
    });

    // Advance clock between enqueue and dispatch by using a deferred runTurn.
    // The broker computes waitMs = now() - entry.enqueuedAtMs at dispatch.
    const entry = makeEntry(KEY_A, {
      turnId: "wait-meas",
      enqueuedAtMs: 1_000,
    });
    clock.current = 1_500; // 500ms wait at admission moment
    const p = broker.submit(entry);
    await p;

    const dispatchLog = logs
      .map((l) => l.message)
      .find((m) => m.startsWith("[broker] dispatch"));
    expect(dispatchLog).toBeDefined();
    expect(dispatchLog).toMatch(/waitMs=500/);
    expect(dispatchLog).toMatch(/turnId=wait-meas/);
  });
});

describe("createConcurrentTurnBroker — clock-injectable", () => {
  it("uses injected now() exclusively (no Date.now leakage)", async () => {
    const realDateNow = Date.now;
    const dateNowSpy = vi.spyOn(Date, "now");
    try {
      const clock = { current: 5_000 };
      const broker = createConcurrentTurnBroker(
        { queueWaitTimeoutMs: 1_000 },
        { now: () => clock.current },
      );

      // Stale entry: age = 5_000 - 0 = 5_000 > 1_000 → reject wait_timeout
      const result = await broker.submit(
        makeEntry(KEY_A, { turnId: "t-stale", enqueuedAtMs: 0 }),
      );
      expect(result).toEqual({ kind: "rejected", reason: "wait_timeout" });

      // Date.now must not have been consulted by the broker for this decision
      expect(dateNowSpy).not.toHaveBeenCalled();
    } finally {
      dateNowSpy.mockRestore();
      Date.now = realDateNow;
    }
  });
});

describe("createConcurrentTurnBroker — public surface introspection", () => {
  it("getQueueDepth + getActiveKeys reflect runtime state", async () => {
    const broker = createConcurrentTurnBroker({ maxConcurrentKeys: 1 });
    const r = makeResolver();

    const p1 = broker.submit(
      makeEntry(KEY_A, {
        turnId: "t1",
        runTurn: async () => {
          await r.promise;
        },
      }),
    );
    await flushMicrotasks();

    // t1 in-flight on KEY_A — depth 0, active keys includes KEY_A
    expect(broker.getQueueDepth(KEY_A)).toBe(0);
    expect(broker.getActiveKeys()).toContain(KEY_A);

    // Queue more behind in-flight to bump depth
    broker.submit(makeEntry(KEY_A, { turnId: "t2" }));
    broker.submit(makeEntry(KEY_A, { turnId: "t3" }));
    await flushMicrotasks();
    expect(broker.getQueueDepth(KEY_A)).toBe(2);

    r.resolve();
    await p1;
    // After drain
    await flushMicrotasks(20);
    expect(broker.getQueueDepth(KEY_A)).toBe(0);
    await broker.shutdown();
  });
});
