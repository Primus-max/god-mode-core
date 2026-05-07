import { describe, expect, it } from "vitest";

import { asIdentityId } from "../../identity/identity-id.js";
import {
  buildBrokerQueueKey,
  resolveBrokerCapacityConfig,
  type BrokerEntry,
  type BrokerQueueKey,
} from "../broker-types.js";
import {
  decideNextDispatch,
  decideQueuePlacement,
  type BrokerState,
} from "../decide-queue-placement.js";

/**
 * Phase 3 — fail-first tests for the pure broker placement helpers.
 *
 * Both helpers are pure functions: clock-injected (`nowMs` parameter for
 * placement; `inFlight` snapshot for dispatch), NEVER throw (#15), and
 * NEVER mutate input state (`state.queues`, `state.inFlight`,
 * `state.keyOrder` references unchanged after every call). Phase 4
 * `ConcurrentTurnBroker` will apply each decision to its mutable state.
 */

const IDENTITY = asIdentityId("identity:operator-a");
const KEY_A: BrokerQueueKey = buildBrokerQueueKey(IDENTITY, "telegram:1");
const KEY_B: BrokerQueueKey = buildBrokerQueueKey(IDENTITY, "telegram:2");
const KEY_C: BrokerQueueKey = buildBrokerQueueKey(IDENTITY, "telegram:3");

function makeEntry(
  queueKey: BrokerQueueKey,
  overrides: Partial<BrokerEntry> = {},
): BrokerEntry {
  return {
    turnId: overrides.turnId ?? "turn-1",
    queueKey,
    enqueuedAtMs: overrides.enqueuedAtMs ?? 1_000,
    runTurn: overrides.runTurn ?? (async () => undefined),
  };
}

function makeState(overrides: Partial<BrokerState> = {}): BrokerState {
  return {
    queues: overrides.queues ?? new Map(),
    inFlight: overrides.inFlight ?? new Set(),
    keyOrder: overrides.keyOrder ?? [],
    lastServedKey: overrides.lastServedKey,
    shutdown: overrides.shutdown ?? false,
  };
}

describe("decideQueuePlacement — admit", () => {
  it("admits an entry against an empty state with queueDepth=0", () => {
    const config = resolveBrokerCapacityConfig();
    const entry = makeEntry(KEY_A, { enqueuedAtMs: 1_000 });
    const state = makeState();

    const result = decideQueuePlacement({
      entry,
      state,
      config,
      nowMs: 1_000,
    });

    expect(result).toEqual({ kind: "admit", queueDepth: 0 });
  });

  it("admits when current queue depth is below the cap", () => {
    const config = resolveBrokerCapacityConfig({ maxQueueDepthPerKey: 8 });
    const entry = makeEntry(KEY_A, { enqueuedAtMs: 1_000 });
    const queues = new Map<BrokerQueueKey, readonly BrokerEntry[]>([
      [
        KEY_A,
        [
          makeEntry(KEY_A, { turnId: "turn-prev-1" }),
          makeEntry(KEY_A, { turnId: "turn-prev-2" }),
          makeEntry(KEY_A, { turnId: "turn-prev-3" }),
        ],
      ],
    ]);
    const state = makeState({ queues, keyOrder: [KEY_A] });

    const result = decideQueuePlacement({
      entry,
      state,
      config,
      nowMs: 1_000,
    });

    expect(result).toEqual({ kind: "admit", queueDepth: 3 });
  });
});

describe("decideQueuePlacement — rejections", () => {
  it("rejects with 'queue_depth_exceeded' when the queue is at the cap", () => {
    const config = resolveBrokerCapacityConfig({ maxQueueDepthPerKey: 8 });
    const fullQueue: BrokerEntry[] = Array.from({ length: 8 }, (_, i) =>
      makeEntry(KEY_A, { turnId: `turn-prev-${i}` }),
    );
    const state = makeState({
      queues: new Map([[KEY_A, fullQueue]]),
      keyOrder: [KEY_A],
    });
    const entry = makeEntry(KEY_A, { enqueuedAtMs: 2_000 });

    const result = decideQueuePlacement({
      entry,
      state,
      config,
      nowMs: 2_000,
    });

    expect(result).toEqual({
      kind: "reject",
      reason: "queue_depth_exceeded",
    });
  });

  it("rejects with 'broker_shutdown' when state.shutdown is true", () => {
    const config = resolveBrokerCapacityConfig();
    const entry = makeEntry(KEY_A, { enqueuedAtMs: 1_000 });
    const state = makeState({ shutdown: true });

    const result = decideQueuePlacement({
      entry,
      state,
      config,
      nowMs: 1_000,
    });

    expect(result).toEqual({ kind: "reject", reason: "broker_shutdown" });
  });

  it("rejects with 'wait_timeout' when entry age exceeds queueWaitTimeoutMs", () => {
    const config = resolveBrokerCapacityConfig({ queueWaitTimeoutMs: 5_000 });
    const entry = makeEntry(KEY_A, { enqueuedAtMs: 1_000 });
    const state = makeState();

    const result = decideQueuePlacement({
      entry,
      state,
      config,
      // age = 7_000ms > 5_000ms cap
      nowMs: 8_000,
    });

    expect(result).toEqual({ kind: "reject", reason: "wait_timeout" });
  });

  it("evaluates 'broker_shutdown' before 'queue_depth_exceeded'", () => {
    // Defense-in-depth: when the broker is shutting down, no further
    // admission decisions are made — even a full queue is reported as
    // shutdown rather than depth so the operator sees the true cause.
    const config = resolveBrokerCapacityConfig({ maxQueueDepthPerKey: 1 });
    const fullQueue: BrokerEntry[] = [makeEntry(KEY_A, { turnId: "turn-x" })];
    const state = makeState({
      queues: new Map([[KEY_A, fullQueue]]),
      keyOrder: [KEY_A],
      shutdown: true,
    });
    const entry = makeEntry(KEY_A, { enqueuedAtMs: 1_000 });

    const result = decideQueuePlacement({
      entry,
      state,
      config,
      nowMs: 1_000,
    });

    expect(result).toEqual({ kind: "reject", reason: "broker_shutdown" });
  });
});

describe("decideQueuePlacement — purity", () => {
  it("never throws for any structurally valid input", () => {
    const config = resolveBrokerCapacityConfig();
    const entry = makeEntry(KEY_A);
    const state = makeState();

    expect(() =>
      decideQueuePlacement({ entry, state, config, nowMs: 1_000 }),
    ).not.toThrow();
  });

  it("does not mutate state references (queues/inFlight/keyOrder)", () => {
    const config = resolveBrokerCapacityConfig();
    const queues = new Map<BrokerQueueKey, readonly BrokerEntry[]>([
      [KEY_A, [makeEntry(KEY_A, { turnId: "turn-prev" })]],
    ]);
    const inFlight = new Set<BrokerQueueKey>([KEY_B]);
    const keyOrder: readonly BrokerQueueKey[] = [KEY_A, KEY_B];
    const state = makeState({ queues, inFlight, keyOrder });
    const entry = makeEntry(KEY_A, { enqueuedAtMs: 1_000 });

    const queuesBefore = state.queues;
    const inFlightBefore = state.inFlight;
    const keyOrderBefore = state.keyOrder;
    const queueABefore = queues.get(KEY_A);
    const queueALenBefore = queueABefore?.length ?? 0;
    const inFlightSizeBefore = inFlight.size;

    decideQueuePlacement({ entry, state, config, nowMs: 1_000 });

    expect(state.queues).toBe(queuesBefore);
    expect(state.inFlight).toBe(inFlightBefore);
    expect(state.keyOrder).toBe(keyOrderBefore);
    expect(queues.get(KEY_A)).toBe(queueABefore);
    expect(queues.get(KEY_A)?.length).toBe(queueALenBefore);
    expect(inFlight.size).toBe(inFlightSizeBefore);
    expect(inFlight.has(KEY_B)).toBe(true);
  });

  it("clock determinism — same state produces different decisions for different nowMs", () => {
    // Witness that the helper reads its clock from the `nowMs` parameter
    // ONLY (no `Date.now()` inside). Two invocations with identical state
    // and identical entry but different nowMs must straddle the timeout
    // boundary and yield admit vs reject deterministically.
    const config = resolveBrokerCapacityConfig({ queueWaitTimeoutMs: 5_000 });
    const entry = makeEntry(KEY_A, { enqueuedAtMs: 1_000 });
    const state = makeState();

    const stillFresh = decideQueuePlacement({
      entry,
      state,
      config,
      nowMs: 5_000, // age = 4_000 < 5_000
    });
    const expired = decideQueuePlacement({
      entry,
      state,
      config,
      nowMs: 7_000, // age = 6_000 > 5_000
    });

    expect(stillFresh.kind).toBe("admit");
    expect(expired).toEqual({ kind: "reject", reason: "wait_timeout" });
  });
});

describe("decideQueuePlacement — FIFO discipline", () => {
  it("preserves per-key FIFO order in state.queues (helper does not reorder)", () => {
    // The helper reads, never reorders. Phase 4 broker is responsible for
    // appending; this test asserts that observed depth equals the
    // caller-supplied per-key array length and the head entry remains
    // first in the snapshot the helper inspects.
    const config = resolveBrokerCapacityConfig({ maxQueueDepthPerKey: 8 });
    const orderedQueue: BrokerEntry[] = [
      makeEntry(KEY_A, { turnId: "turn-1", enqueuedAtMs: 1_000 }),
      makeEntry(KEY_A, { turnId: "turn-2", enqueuedAtMs: 1_010 }),
      makeEntry(KEY_A, { turnId: "turn-3", enqueuedAtMs: 1_020 }),
    ];
    const state = makeState({
      queues: new Map([[KEY_A, orderedQueue]]),
      keyOrder: [KEY_A],
    });
    const entry = makeEntry(KEY_A, {
      turnId: "turn-4",
      enqueuedAtMs: 1_030,
    });

    const result = decideQueuePlacement({
      entry,
      state,
      config,
      nowMs: 1_030,
    });

    expect(result).toEqual({ kind: "admit", queueDepth: 3 });
    // The snapshot the helper saw is unchanged; head is still turn-1.
    expect(state.queues.get(KEY_A)?.[0]?.turnId).toBe("turn-1");
    expect(state.queues.get(KEY_A)?.length).toBe(3);
  });
});

describe("decideNextDispatch — idle paths", () => {
  it("returns idle 'no_pending' when queues are empty", () => {
    const config = resolveBrokerCapacityConfig();
    const state = makeState({ keyOrder: [KEY_A, KEY_B] });

    const result = decideNextDispatch({ state, config });

    expect(result).toEqual({ kind: "idle", reason: "no_pending" });
  });

  it("returns idle 'no_pending' when every key with pending is in-flight", () => {
    const config = resolveBrokerCapacityConfig({ maxConcurrentKeys: 32 });
    const queues = new Map<BrokerQueueKey, readonly BrokerEntry[]>([
      [KEY_A, [makeEntry(KEY_A)]],
      [KEY_B, [makeEntry(KEY_B)]],
    ]);
    const state = makeState({
      queues,
      inFlight: new Set([KEY_A, KEY_B]),
      keyOrder: [KEY_A, KEY_B],
    });

    const result = decideNextDispatch({ state, config });

    expect(result).toEqual({ kind: "idle", reason: "no_pending" });
  });

  it("returns idle 'concurrency_cap_reached' when inFlight.size >= maxConcurrentKeys", () => {
    const config = resolveBrokerCapacityConfig({ maxConcurrentKeys: 2 });
    const queues = new Map<BrokerQueueKey, readonly BrokerEntry[]>([
      [KEY_C, [makeEntry(KEY_C)]],
    ]);
    const state = makeState({
      queues,
      inFlight: new Set([KEY_A, KEY_B]),
      keyOrder: [KEY_A, KEY_B, KEY_C],
    });

    const result = decideNextDispatch({ state, config });

    expect(result).toEqual({
      kind: "idle",
      reason: "concurrency_cap_reached",
    });
  });

  it("returns idle 'shutdown' when state.shutdown is true", () => {
    const config = resolveBrokerCapacityConfig();
    const queues = new Map<BrokerQueueKey, readonly BrokerEntry[]>([
      [KEY_A, [makeEntry(KEY_A)]],
    ]);
    const state = makeState({
      queues,
      keyOrder: [KEY_A],
      shutdown: true,
    });

    const result = decideNextDispatch({ state, config });

    expect(result).toEqual({ kind: "idle", reason: "shutdown" });
  });
});

describe("decideNextDispatch — round-robin selection", () => {
  it("dispatches first key in keyOrder when there is no lastServedKey", () => {
    const config = resolveBrokerCapacityConfig();
    const queues = new Map<BrokerQueueKey, readonly BrokerEntry[]>([
      [KEY_A, [makeEntry(KEY_A)]],
      [KEY_B, [makeEntry(KEY_B)]],
      [KEY_C, [makeEntry(KEY_C)]],
    ]);
    const state = makeState({
      queues,
      keyOrder: [KEY_A, KEY_B, KEY_C],
    });

    const result = decideNextDispatch({ state, config });

    expect(result).toEqual({ kind: "dispatch", queueKey: KEY_A });
  });

  it("dispatches the key after lastServedKey in keyOrder", () => {
    const config = resolveBrokerCapacityConfig();
    const queues = new Map<BrokerQueueKey, readonly BrokerEntry[]>([
      [KEY_A, [makeEntry(KEY_A)]],
      [KEY_B, [makeEntry(KEY_B)]],
      [KEY_C, [makeEntry(KEY_C)]],
    ]);
    const state = makeState({
      queues,
      keyOrder: [KEY_A, KEY_B, KEY_C],
      lastServedKey: KEY_A,
    });

    const result = decideNextDispatch({ state, config });

    expect(result).toEqual({ kind: "dispatch", queueKey: KEY_B });
  });

  it("wraps around to the start of keyOrder after the last entry", () => {
    const config = resolveBrokerCapacityConfig();
    const queues = new Map<BrokerQueueKey, readonly BrokerEntry[]>([
      [KEY_A, [makeEntry(KEY_A)]],
      [KEY_B, [makeEntry(KEY_B)]],
      [KEY_C, [makeEntry(KEY_C)]],
    ]);
    const state = makeState({
      queues,
      keyOrder: [KEY_A, KEY_B, KEY_C],
      lastServedKey: KEY_C,
    });

    const result = decideNextDispatch({ state, config });

    expect(result).toEqual({ kind: "dispatch", queueKey: KEY_A });
  });

  it("skips keys that are already in-flight while round-robin walks", () => {
    const config = resolveBrokerCapacityConfig();
    const queues = new Map<BrokerQueueKey, readonly BrokerEntry[]>([
      [KEY_A, [makeEntry(KEY_A)]],
      [KEY_B, [makeEntry(KEY_B)]],
      [KEY_C, [makeEntry(KEY_C)]],
    ]);
    const state = makeState({
      queues,
      inFlight: new Set([KEY_B]),
      keyOrder: [KEY_A, KEY_B, KEY_C],
      lastServedKey: KEY_A,
    });

    const result = decideNextDispatch({ state, config });

    // After A, B is in-flight — round-robin advances to C.
    expect(result).toEqual({ kind: "dispatch", queueKey: KEY_C });
  });

  it("does not mutate state references on dispatch", () => {
    const config = resolveBrokerCapacityConfig();
    const queues = new Map<BrokerQueueKey, readonly BrokerEntry[]>([
      [KEY_A, [makeEntry(KEY_A)]],
      [KEY_B, [makeEntry(KEY_B)]],
    ]);
    const inFlight = new Set<BrokerQueueKey>();
    const keyOrder: readonly BrokerQueueKey[] = [KEY_A, KEY_B];
    const state = makeState({ queues, inFlight, keyOrder });

    const queuesBefore = state.queues;
    const inFlightBefore = state.inFlight;
    const keyOrderBefore = state.keyOrder;

    decideNextDispatch({ state, config });

    expect(state.queues).toBe(queuesBefore);
    expect(state.inFlight).toBe(inFlightBefore);
    expect(state.keyOrder).toBe(keyOrderBefore);
    expect(inFlight.size).toBe(0);
  });
});
