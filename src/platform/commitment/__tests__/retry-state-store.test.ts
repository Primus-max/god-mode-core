import { describe, expect, it } from "vitest";

import { asIdentityId } from "../../identity/identity-id.js";
import type { EffectId } from "../ids.js";
import {
  RETRY_STATE_STORE_DEFAULT_MAX_KEYS,
  buildRetryStateKey,
  createInMemoryRetryStateStore,
  type RetryStateKey,
} from "../retry-state-store.js";

/**
 * Phase 6 — Stage 5 (Retry policies) `RetryStateStore` tests.
 *
 * Coverage matrix (sub-plan §3 Phase 6 + §h):
 *   (1)  get/increment/reset round-trip semantics.
 *   (2)  Atomic increment under concurrency
 *        (`Promise.all` of N increments → counter ends at N).
 *   (3)  LRU eviction policy (write past max size → first key evicted).
 *   (4)  Per-key isolation (siblings advance independently).
 *   (5)  `reset(key)` clears only the specified key.
 *   (6)  `get(key)` returns 0 when key not present.
 */

const VLADIMIR = asIdentityId("identity:vladimir");
const ALICE = asIdentityId("identity:alice");
const POST_EFFECT = "external_effect.performed" as EffectId;
const ANSWER_EFFECT = "communication.answer_delivered" as EffectId;
const SESSION_A = "session:a";
const SESSION_B = "session:b";

describe("RetryStateStore — in-memory LRU (Phase 6 §b)", () => {
  it("(6) returns 0 for a key not yet seen", () => {
    const store = createInMemoryRetryStateStore();
    const key = buildRetryStateKey({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
    });
    expect(store.get(key)).toBe(0);
  });

  it("(1) round-trip get/increment/reset", () => {
    const store = createInMemoryRetryStateStore();
    const key = buildRetryStateKey({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
    });

    expect(store.get(key)).toBe(0);
    expect(store.increment(key)).toBe(1);
    expect(store.get(key)).toBe(1);
    expect(store.increment(key)).toBe(2);
    expect(store.increment(key)).toBe(3);
    expect(store.get(key)).toBe(3);

    store.reset(key);
    expect(store.get(key)).toBe(0);

    // After reset, the next increment starts again from 1.
    expect(store.increment(key)).toBe(1);
  });

  it("(2) atomic increment under structural concurrency (Node single-thread)", async () => {
    const store = createInMemoryRetryStateStore();
    const key = buildRetryStateKey({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
    });

    // 100 parallel-issued increments via Promise.all. The store is
    // synchronous and Node is single-threaded; structurally each
    // `increment()` reads-then-writes within one tick, so the final
    // count MUST be exactly 100.
    const results = await Promise.all(
      Array.from({ length: 100 }, () => Promise.resolve().then(() => store.increment(key))),
    );

    expect(store.get(key)).toBe(100);
    // Every observed return value is a unique integer 1..100.
    const sorted = [...results].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: 100 }, (_v, i) => i + 1));
  });

  it("(4) per-key isolation: distinct (identity, effect, session) advance independently", () => {
    const store = createInMemoryRetryStateStore();
    const k1 = buildRetryStateKey({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
    });
    const k2 = buildRetryStateKey({
      identityId: ALICE,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
    });
    const k3 = buildRetryStateKey({
      identityId: VLADIMIR,
      effectId: ANSWER_EFFECT,
      sessionId: SESSION_A,
    });
    const k4 = buildRetryStateKey({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_B,
    });

    expect(store.increment(k1)).toBe(1);
    expect(store.increment(k1)).toBe(2);
    expect(store.increment(k2)).toBe(1);
    expect(store.increment(k3)).toBe(1);
    expect(store.increment(k4)).toBe(1);

    expect(store.get(k1)).toBe(2);
    expect(store.get(k2)).toBe(1);
    expect(store.get(k3)).toBe(1);
    expect(store.get(k4)).toBe(1);
  });

  it("(5) reset clears only the specified key", () => {
    const store = createInMemoryRetryStateStore();
    const k1 = buildRetryStateKey({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
    });
    const k2 = buildRetryStateKey({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_B,
    });

    store.increment(k1);
    store.increment(k1);
    store.increment(k2);
    store.increment(k2);
    store.increment(k2);

    store.reset(k1);

    expect(store.get(k1)).toBe(0);
    expect(store.get(k2)).toBe(3);
  });

  it("(3) LRU eviction: writing past max size evicts the least-recently-used entry", () => {
    const maxKeys = 4;
    const store = createInMemoryRetryStateStore({ maxKeys });

    const keys: RetryStateKey[] = [
      buildRetryStateKey({ identityId: VLADIMIR, effectId: POST_EFFECT, sessionId: "s:0" }),
      buildRetryStateKey({ identityId: VLADIMIR, effectId: POST_EFFECT, sessionId: "s:1" }),
      buildRetryStateKey({ identityId: VLADIMIR, effectId: POST_EFFECT, sessionId: "s:2" }),
      buildRetryStateKey({ identityId: VLADIMIR, effectId: POST_EFFECT, sessionId: "s:3" }),
    ];

    // Fill the LRU exactly to capacity.
    for (const k of keys) {
      store.increment(k);
    }
    expect(store.get(keys[0]!)).toBe(1);
    expect(store.get(keys[3]!)).toBe(1);

    // The fifth entry must evict the LEAST-recently-used. After the
    // four `get` operations above, key 0 was just touched (most
    // recent reads bump it to MRU position). So when we add a fifth,
    // the oldest unaccessed becomes evicted. To make the test
    // deterministic, build a fresh store and avoid `get`'s recency
    // bumping concern.
    const freshStore = createInMemoryRetryStateStore({ maxKeys });
    for (const k of keys) {
      freshStore.increment(k);
    }
    // Now insert a 5th distinct key — capacity exceeded.
    const k5 = buildRetryStateKey({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: "s:4",
    });
    freshStore.increment(k5);

    // The first inserted key (`s:0`) is the LRU and must have been
    // evicted; observers see its counter as 0 again.
    expect(freshStore.get(keys[0]!)).toBe(0);
    // Newer entries remain.
    expect(freshStore.get(keys[1]!)).toBe(1);
    expect(freshStore.get(keys[2]!)).toBe(1);
    expect(freshStore.get(keys[3]!)).toBe(1);
    expect(freshStore.get(k5)).toBe(1);
  });

  it("(3 cont.) writing 10_001 entries with default capacity keeps the most-recent and evicts the oldest", () => {
    // Validates RETRY_STATE_STORE_DEFAULT_MAX_KEYS = 10_000 boundary.
    const store = createInMemoryRetryStateStore();

    const firstKey = buildRetryStateKey({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: "s:0",
    });
    store.increment(firstKey);

    for (let i = 1; i < RETRY_STATE_STORE_DEFAULT_MAX_KEYS; i += 1) {
      store.increment(
        buildRetryStateKey({
          identityId: VLADIMIR,
          effectId: POST_EFFECT,
          sessionId: `s:${String(i)}`,
        }),
      );
    }

    // After 10_000 entries, the first one is still present (LRU
    // capacity is exactly 10_000).
    expect(store.get(firstKey)).toBe(1);

    // The 10_001st insertion forces eviction of the LRU entry.
    // Re-compute a fresh `firstKey` lookup BEFORE the eviction triggers
    // would otherwise bump it to MRU. Use a sibling read that relies
    // only on the eviction semantics: insert one more distinct key
    // and observe `firstKey` going to 0.
    const overflow = buildRetryStateKey({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: `s:${String(RETRY_STATE_STORE_DEFAULT_MAX_KEYS)}`,
    });
    store.increment(overflow);

    // First key (LRU) evicted.
    expect(store.get(firstKey)).toBe(0);
    // Overflow key present.
    expect(store.get(overflow)).toBe(1);
  });

  it("buildRetryStateKey produces identical strings for identical inputs (structural equality)", () => {
    const k1 = buildRetryStateKey({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
    });
    const k2 = buildRetryStateKey({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
    });
    expect(k1).toBe(k2);
  });

  it("buildRetryStateKey distinguishes anonymous (undefined) from named identities", () => {
    const named = buildRetryStateKey({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
    });
    const anon = buildRetryStateKey({
      identityId: undefined,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
    });
    expect(named).not.toBe(anon);

    // Two anonymous keys for the same effect+session are equal —
    // anonymous turns are pooled under one bucket per effect+session.
    const anon2 = buildRetryStateKey({
      identityId: undefined,
      effectId: POST_EFFECT,
      sessionId: SESSION_A,
    });
    expect(anon).toBe(anon2);
  });
});
