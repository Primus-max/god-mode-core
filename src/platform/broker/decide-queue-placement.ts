import type {
  BrokerEntry,
  BrokerOverflowReason,
  BrokerQueueKey,
  ResolvedBrokerCapacityConfig,
} from "./broker-types.js";

/**
 * Slice "PR-MT concurrent broker" — Phase 3 (pure placement helpers).
 *
 * Two pure decision functions consumed by the Phase 4 `ConcurrentTurnBroker`
 * runtime: `decideQueuePlacement(...)` evaluates whether a fresh `BrokerEntry`
 * should be admitted to its per-key FIFO; `decideNextDispatch(...)` selects
 * the next per-key queue head to drain under the round-robin fairness
 * scheduler. Phase 4 will own the mutable `Map<BrokerQueueKey, BrokerEntry[]>`
 * + `Set<BrokerQueueKey>` cursors and apply each decision; this module
 * carries NO mutable state.
 *
 * Audit: `extensions/AUDIT-pr-mt-concurrent-broker.md` §c (identity wiring),
 * §e (operator surface). Sub-plan:
 * `.cursor/plans/commitment_kernel_pr_mt_concurrent_broker.plan.md` Phase 3.
 *
 * Invariants honored:
 * - #8 — pure module; only types from `./broker-types.js` are imported. No
 *   platform / commitment / decision imports. No clock, no logger.
 * - #11 — frozen contracts BYTE-IDENTICAL. Phase 3 lives entirely under
 *   `src/platform/broker/` and never touches `commitment/` or `decision/`.
 * - #15 — every code path returns a structured envelope; the helpers
 *   NEVER throw and NEVER mutate input state (`state.queues`,
 *   `state.inFlight`, `state.keyOrder` references unchanged after every
 *   call). Overflow rejections carry one of the closed `BrokerOverflowReason`
 *   discriminants.
 * - #16 — `BrokerQueueKey` brand discipline preserved; the helpers consume
 *   keys verbatim and never re-derive identity from raw text.
 *
 * Clock injection: `decideQueuePlacement` reads its wall-clock from the
 * `nowMs` parameter ONLY — no `Date.now()` inside — so Phase 4 tests can
 * pin timing deterministically and Phase 7 acceptance can replay placement
 * decisions with synthetic clocks.
 */

/**
 * Read-only snapshot of the broker's mutable scheduling state. Phase 4
 * builds and updates the actual `Map`/`Set` instances; the helpers in
 * this module never mutate them. The `readonly` modifiers on the Map /
 * Set / Array types are advisory at the type level only — the helpers
 * additionally avoid `.set(...)` / `.add(...)` / `.push(...)` on the
 * concrete instances handed in.
 */
export type BrokerState = {
  readonly queues: ReadonlyMap<BrokerQueueKey, readonly BrokerEntry[]>;
  readonly inFlight: ReadonlySet<BrokerQueueKey>;
  readonly keyOrder: readonly BrokerQueueKey[];
  readonly lastServedKey?: BrokerQueueKey;
  readonly shutdown: boolean;
};

/**
 * Outcome of `decideQueuePlacement`. Discriminated by `kind`:
 * - `admit` — the broker should append the entry to its per-key FIFO and
 *   schedule a drain tick. `queueDepth` is the depth observed at decision
 *   time (pre-append), surfaced for telemetry.
 * - `reject` — the broker MUST translate the rejection into a structured
 *   envelope per invariant #15. `reason` is one of the closed
 *   `BrokerOverflowReason` discriminants.
 */
export type BrokerPlacement =
  | { readonly kind: "admit"; readonly queueDepth: number }
  | { readonly kind: "reject"; readonly reason: BrokerOverflowReason };

export type DecideQueuePlacementParams = {
  readonly entry: BrokerEntry;
  readonly state: BrokerState;
  readonly config: ResolvedBrokerCapacityConfig;
  readonly nowMs: number;
};

/**
 * Decide whether to admit a fresh `BrokerEntry` to its per-key FIFO.
 *
 * Order of checks (each gate short-circuits the rest):
 *   1. `state.shutdown` → reject `'broker_shutdown'`. Defense-in-depth: when
 *      the broker is draining, no further admission is offered regardless of
 *      depth or wait — operators see the true cause first.
 *   2. Per-key depth ≥ `maxQueueDepthPerKey` → reject `'queue_depth_exceeded'`.
 *      The depth read is the snapshot length of `state.queues.get(queueKey)`;
 *      a missing entry is treated as depth 0.
 *   3. Entry age (`nowMs - entry.enqueuedAtMs`) > `queueWaitTimeoutMs` →
 *      reject `'wait_timeout'`. Strict greater-than: an entry whose age
 *      EQUALS the cap is still admitted (the cap is the inclusive upper
 *      bound; only entries STRICTLY beyond it are rejected). Negative ages
 *      (clock skew) are treated as 0 and admitted.
 *   4. Otherwise admit with `queueDepth = pre-admit depth`.
 *
 * Pure: never throws (#15), never mutates input state, returns a fresh
 * decision object on every call.
 */
export function decideQueuePlacement(
  params: DecideQueuePlacementParams,
): BrokerPlacement {
  const { entry, state, config, nowMs } = params;

  if (state.shutdown) {
    return { kind: "reject", reason: "broker_shutdown" };
  }

  const existingQueue = state.queues.get(entry.queueKey);
  const queueDepth = existingQueue?.length ?? 0;

  if (queueDepth >= config.maxQueueDepthPerKey) {
    return { kind: "reject", reason: "queue_depth_exceeded" };
  }

  const ageMs = nowMs - entry.enqueuedAtMs;
  if (ageMs > config.queueWaitTimeoutMs) {
    return { kind: "reject", reason: "wait_timeout" };
  }

  return { kind: "admit", queueDepth };
}

/**
 * Outcome of `decideNextDispatch`. Discriminated by `kind`:
 * - `dispatch` — the broker should pop the head entry of `queueKey` and
 *   invoke its `runTurn` callback. The Phase 4 broker is responsible for
 *   marking the key as in-flight, advancing `lastServedKey`, and
 *   re-scheduling itself when the runTurn settles.
 * - `idle` — no work to do this tick. The reason is closed:
 *   - `'no_pending'` — every key with pending entries is already in-flight
 *     (or no key has pending entries at all).
 *   - `'concurrency_cap_reached'` — `inFlight.size ≥ maxConcurrentKeys`.
 *     Phase 4 must wait for an in-flight key to settle before dispatching.
 *   - `'shutdown'` — `state.shutdown` is true.
 */
export type DispatchDecision =
  | { readonly kind: "dispatch"; readonly queueKey: BrokerQueueKey }
  | {
      readonly kind: "idle";
      readonly reason: "no_pending" | "concurrency_cap_reached" | "shutdown";
    };

export type DecideNextDispatchParams = {
  readonly state: BrokerState;
  readonly config: ResolvedBrokerCapacityConfig;
};

/**
 * Round-robin dispatch selector. Walks `state.keyOrder` starting at the
 * slot AFTER `state.lastServedKey` (or at index 0 when no key has been
 * served yet) and returns the first key that has a non-empty queue and is
 * NOT currently in-flight. The walk wraps around the end of `keyOrder`
 * exactly once so a single round visits every key at most once.
 *
 * Idle gates (each short-circuits the walk):
 *   1. `state.shutdown` → idle `'shutdown'`.
 *   2. `inFlight.size ≥ maxConcurrentKeys` → idle `'concurrency_cap_reached'`.
 *   3. No eligible key found in the round-robin pass → idle `'no_pending'`.
 *
 * Pure: never throws (#15), never mutates input state, returns a fresh
 * decision object on every call. The Phase 4 broker is responsible for
 * advancing `lastServedKey` once the dispatched runTurn is invoked.
 */
export function decideNextDispatch(
  params: DecideNextDispatchParams,
): DispatchDecision {
  const { state, config } = params;

  if (state.shutdown) {
    return { kind: "idle", reason: "shutdown" };
  }

  if (state.inFlight.size >= config.maxConcurrentKeys) {
    return { kind: "idle", reason: "concurrency_cap_reached" };
  }

  const keyOrder = state.keyOrder;
  if (keyOrder.length === 0) {
    return { kind: "idle", reason: "no_pending" };
  }

  // Cursor starts at the slot AFTER lastServedKey. When lastServedKey is
  // absent or has been removed from keyOrder, we begin at index 0.
  const lastIndex = state.lastServedKey
    ? keyOrder.indexOf(state.lastServedKey)
    : -1;
  const startIndex = (lastIndex + 1) % keyOrder.length;

  for (let offset = 0; offset < keyOrder.length; offset += 1) {
    const candidate = keyOrder[(startIndex + offset) % keyOrder.length];
    if (candidate === undefined) {
      // Defensive: shouldn't happen given the bounds, but keep the helper
      // total in case `keyOrder` is sparse upstream.
      continue;
    }
    if (state.inFlight.has(candidate)) {
      continue;
    }
    const queue = state.queues.get(candidate);
    if (queue !== undefined && queue.length > 0) {
      return { kind: "dispatch", queueKey: candidate };
    }
  }

  return { kind: "idle", reason: "no_pending" };
}
