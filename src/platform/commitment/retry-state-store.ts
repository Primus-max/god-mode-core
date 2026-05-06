import type { IdentityId } from "../identity/identity-id.js";
import type { EffectId } from "./ids.js";

/**
 * Phase 6 — Stage 5 (Retry policies) state-store interface and the
 * default in-memory LRU implementation.
 *
 * Architectural notes:
 *
 *  1. **Non-persistent by design.** Retry counters reset across `/new`
 *     boundaries — that lifecycle concern is the caller's
 *     (sub-plan §3 row Phase 6). The store keeps an in-memory LRU
 *     keyed `(identityId | 'anonymous', effectId, sessionId)`; the
 *     wrapper that consumes the store decides when to reset (e.g. on
 *     `terminalState=action_completed` the runtime wrapper resets the
 *     counter for the same `(identity, effect, session)`).
 *  2. **Atomic increment under structural concurrency.** The
 *     `increment` method is synchronous and Node is single-threaded;
 *     each call performs read-modify-write within one tick. There is
 *     no shared-memory concurrency to defend against — atomicity is
 *     structural.
 *  3. **LRU eviction policy.** When the store reaches `maxKeys`
 *     entries, the oldest unreferenced entry is evicted on the next
 *     write. The default capacity is `RETRY_STATE_STORE_DEFAULT_MAX_KEYS
 *     = 10_000` keys — large enough that production workloads never
 *     hit it, small enough that a misbehaving caller cannot leak
 *     unbounded memory.
 *  4. **Anonymous turns share one bucket per (effect, session).** The
 *     key string distinguishes a `null`-identity row from a
 *     named-identity row — anonymous turns CANNOT inherit a named
 *     identity's counter, and vice versa.
 *  5. **No frozen-layer touch.** This file is wholly new and does
 *     NOT modify `policy-gate.ts` / `monitored-runtime.ts` /
 *     `effect-family-registry.ts` / the 5 frozen contracts. The
 *     `MonitoredRuntime` BYTE-IDENTICAL constraint is honoured by
 *     consulting the store from the runner-layer wrapper, not from
 *     inside the runtime's own loop (sub-plan §3 row Phase 6 + §10
 *     invariant #11).
 */

/**
 * Opaque, structurally-equal string key used by the store. The brand
 * is informational only — we deliberately do NOT lock callers out
 * from `string` so external observability tools can log the key
 * verbatim. Use `buildRetryStateKey(...)` to construct one.
 */
declare const RetryStateKeyBrand: unique symbol;
export type RetryStateKey = string & {
  readonly [RetryStateKeyBrand]: true;
};

export type BuildRetryStateKeyInput = {
  /**
   * The operator identity. `undefined` marks an anonymous turn —
   * those share one bucket per `(effectId, sessionId)`. Using a
   * sentinel literal in the key string keeps the structurally-equal
   * keys distinct from any literal `IdentityId` that happens to
   * stringify the same way (the `identity:` prefix discipline on
   * `IdentityId` makes that collision impossible in practice).
   */
  readonly identityId: IdentityId | undefined;
  readonly effectId: EffectId;
  readonly sessionId: string;
};

/**
 * Builds a stable retry-state key. Two calls with structurally-equal
 * inputs return the same string; comparison is straightforward
 * `===`.
 *
 * Format: `retry:<identity>:<effect>:<session>` where `<identity>`
 * is either the literal `IdentityId` value or the sentinel
 * `anonymous` for `identityId === undefined`. Field separators are
 * `:` for parity with `IdentityId` formatting.
 */
export function buildRetryStateKey(input: BuildRetryStateKeyInput): RetryStateKey {
  const identityPart = input.identityId !== undefined ? String(input.identityId) : "anonymous";
  return `retry:${identityPart}:${String(input.effectId)}:${input.sessionId}` as RetryStateKey;
}

/**
 * Storage interface consumed by `createRetryPolicy(...)`. Production
 * wiring uses `createInMemoryRetryStateStore(...)`; tests may inject a
 * deterministic fake.
 */
export interface RetryStateStore {
  /**
   * Returns the current attempt counter for `key`. Returns `0` for an
   * unknown key.
   */
  get(key: RetryStateKey): number;
  /**
   * Atomically increments the counter for `key` and returns the new
   * value. Creates the entry at `1` when missing.
   */
  increment(key: RetryStateKey): number;
  /**
   * Clears the counter for `key`. The next `get` returns `0` and the
   * next `increment` returns `1`.
   */
  reset(key: RetryStateKey): void;
}

export const RETRY_STATE_STORE_DEFAULT_MAX_KEYS = 10_000;

export type CreateInMemoryRetryStateStoreOptions = {
  /**
   * Maximum number of distinct keys held in memory. Once exceeded,
   * the least-recently-used entry is evicted on the next write.
   * Defaults to `RETRY_STATE_STORE_DEFAULT_MAX_KEYS` (10_000).
   */
  readonly maxKeys?: number;
};

/**
 * Creates the default in-memory LRU-backed `RetryStateStore`.
 *
 * Implementation note: a `Map` in V8 maintains insertion order for
 * iteration. We exploit that by deleting-then-setting on every
 * touch, which moves the key to the tail of the iteration order;
 * the head is then the LRU candidate. This is the same trick used
 * by tiny LRU shims across the codebase.
 *
 * The eviction step on overflow removes the head exactly once per
 * write — the loop is degenerate (it runs at most once with the
 * default capacity) but kept defensive in case a caller ever
 * down-sizes the store at runtime.
 */
export function createInMemoryRetryStateStore(
  options: CreateInMemoryRetryStateStoreOptions = {},
): RetryStateStore {
  const maxKeys = options.maxKeys ?? RETRY_STATE_STORE_DEFAULT_MAX_KEYS;
  if (!Number.isFinite(maxKeys) || maxKeys <= 0) {
    throw new Error(
      `createInMemoryRetryStateStore: maxKeys must be a positive integer; received ${String(maxKeys)}`,
    );
  }

  const counters = new Map<RetryStateKey, number>();

  function touch(key: RetryStateKey, value: number): void {
    counters.delete(key);
    counters.set(key, value);
  }

  function evictIfOverflow(): void {
    while (counters.size > maxKeys) {
      const oldest = counters.keys().next();
      if (oldest.done) {
        break;
      }
      counters.delete(oldest.value);
    }
  }

  return {
    get(key: RetryStateKey): number {
      // Plain read — does NOT bump recency, so observers can probe
      // the store without disturbing eviction order. (A `peek` /
      // `get` distinction is a common LRU footgun; here we choose
      // read-without-bump to keep eviction policy predictable in
      // tests.)
      return counters.get(key) ?? 0;
    },
    increment(key: RetryStateKey): number {
      const next = (counters.get(key) ?? 0) + 1;
      touch(key, next);
      evictIfOverflow();
      return next;
    },
    reset(key: RetryStateKey): void {
      counters.delete(key);
    },
  };
}
