import {
  decideNextDispatch,
  decideQueuePlacement,
  type BrokerState,
} from "./decide-queue-placement.js";
import {
  resolveBrokerCapacityConfig,
  type BrokerCapacityConfig,
  type BrokerEntry,
  type BrokerOverflowReason,
  type BrokerQueueKey,
} from "./broker-types.js";

/**
 * Slice "PR-MT concurrent broker" — Phase 4 (broker runtime).
 *
 * Process-scoped scheduler that sits between inbound-channel callers and
 * `runTurnDecision` (Phase 5 wires the wrapper at
 * `agent-runner-execution.ts`). The broker owns the mutable state the
 * Phase 3 helpers leave abstract:
 *   - `Map<BrokerQueueKey, BrokerEntry[]>` — per-key FIFO queues
 *   - `Set<BrokerQueueKey>` — in-flight key set, bounded by
 *     `maxConcurrentKeys`
 *   - `BrokerQueueKey[]` — round-robin cursor (`keyOrder`) +
 *     `lastServedKey`
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_pr_mt_concurrent_broker.plan.md`
 * Phase 4. Audit: `extensions/AUDIT-pr-mt-concurrent-broker.md`.
 *
 * Invariants honored:
 * - #8 — module lives under `src/platform/broker/` only; imports limited
 *   to the local `broker-types.js` and `decide-queue-placement.js` (no
 *   commitment / decision / runtime imports).
 * - #11 — frozen layer untouched. `src/platform/commitment/**` and
 *   `src/platform/decision/**` are not modified.
 * - #15 — every code path returns a structured envelope. Submit always
 *   resolves with `{kind:'completed'}` or `{kind:'rejected', reason}`;
 *   submit never throws. The inner `runTurn` callback may reject; the
 *   broker catches and logs the rejection but resolves the submit promise
 *   with `{kind:'completed'}` because the entry was admitted and
 *   dispatched (the caller-supplied callback owns its own error
 *   propagation through the closure).
 * - #16 — `BrokerQueueKey` brand discipline preserved end-to-end; the
 *   broker never re-derives identity from raw text.
 *
 * Clock injection: the broker reads wall-clock from `deps.now` ONLY (it
 * defaults to `Date.now`). Tests pin timing deterministically via the
 * injected clock; `decideQueuePlacement` receives the same clock value.
 */

/** Outcome of `submit(entry)`. Discriminated by `kind`:
 * - `completed` — the entry's `runTurn` callback was invoked and settled.
 *   The broker swallows runtime exceptions thrown from `runTurn` (logged,
 *   not propagated) so the submit promise can carry an envelope.
 * - `rejected` — the broker refused admission or aborted before dispatch;
 *   `reason` carries one of the closed `BrokerOverflowReason` values.
 */
export type BrokerSubmitResult =
  | { readonly kind: "completed" }
  | { readonly kind: "rejected"; readonly reason: BrokerOverflowReason };

/** Constructor dependencies; both fields optional. */
export type ConcurrentTurnBrokerDeps = {
  readonly logger?: {
    log: (message: string, level?: "info" | "debug") => void;
  };
  readonly now?: () => number;
};

/** Public surface of the broker. Pure-function-style: no internal events
 * surfaced; the only escape hatch is the submit promise, the introspection
 * helpers, and the structured log lines.
 */
export interface ConcurrentTurnBroker {
  submit(entry: BrokerEntry): Promise<BrokerSubmitResult>;
  getQueueDepth(queueKey: BrokerQueueKey): number;
  getActiveKeys(): readonly BrokerQueueKey[];
  shutdown(): Promise<void>;
}

/**
 * Construct a fresh broker. Phase 5 will use a process-scoped singleton
 * built via this factory; Phase 4 tests construct one per test for
 * isolation. The factory applies `resolveBrokerCapacityConfig` exactly
 * once so all admission/dispatch paths share the resolved values.
 */
export function createConcurrentTurnBroker(
  config?: BrokerCapacityConfig,
  deps?: ConcurrentTurnBrokerDeps,
): ConcurrentTurnBroker {
  const resolved = resolveBrokerCapacityConfig(config);
  const queues = new Map<BrokerQueueKey, BrokerEntry[]>();
  const inFlight = new Set<BrokerQueueKey>();
  const keyOrder: BrokerQueueKey[] = [];
  let lastServedKey: BrokerQueueKey | undefined;
  let isShutdown = false;
  const inFlightDrains = new Set<Promise<void>>();
  // S15 — resolvers MUST be indexed on a broker-internal admission id, NOT
  // on `entry.turnId`. The broker contract documents `turnId` as opaque
  // caller-supplied (NOT used for dedup); two `submit(...)` calls with the
  // same turnId (legitimate retries / replays) would otherwise clobber each
  // other in this map, deadlocking the first submit promise and resolving
  // the second one prematurely. The id is monotonic per broker instance;
  // the WeakMap binds it to the (always-fresh) `BrokerEntry` object so the
  // drain `finally` block can recover the resolver key without consulting
  // any caller-supplied field.
  const submitResolvers = new Map<number, (result: BrokerSubmitResult) => void>();
  const entryAdmissionId = new WeakMap<BrokerEntry, number>();
  let nextAdmissionId = 0;

  const now = deps?.now ?? Date.now;
  const log = deps?.logger?.log ?? (() => undefined);

  function snapshotState(): BrokerState {
    return {
      queues,
      inFlight,
      keyOrder,
      lastServedKey,
      shutdown: isShutdown,
    };
  }

  function tryDispatch(): void {
    // Loop drains as many ready keys as the concurrency cap allows in a
    // single tick. Each iteration consults the Phase 3 pure helper, which
    // re-reads the (now mutated) state on every pass.
    while (true) {
      const decision = decideNextDispatch({
        state: snapshotState(),
        config: resolved,
      });
      if (decision.kind !== "dispatch") {
        return;
      }

      const queueKey = decision.queueKey;
      const queue = queues.get(queueKey);
      if (queue === undefined || queue.length === 0) {
        // Phase 3 helper already filters empty queues; defensive guard.
        return;
      }

      const entry = queue.shift();
      if (entry === undefined) {
        return;
      }
      if (queue.length === 0) {
        queues.delete(queueKey);
        // Keep `keyOrder` slot for cursor stability; only prune at
        // shutdown / introspection time. The Phase 3 helper tolerates
        // empty/missing queues in the round-robin walk.
      }

      inFlight.add(queueKey);
      lastServedKey = queueKey;
      const waitMs = now() - entry.enqueuedAtMs;
      log(
        `[broker] dispatch queueKey=${queueKey} waitMs=${waitMs} turnId=${entry.turnId}`,
        "info",
      );

      const drain = (async () => {
        try {
          await entry.runTurn();
        } catch (err) {
          // Defensive — `runTurn` callbacks own their own error handling
          // through their closures; if one leaks an exception, log it and
          // drop so queue state stays consistent (#15: never throw).
          const errMsg =
            err instanceof Error ? err.message : String(err);
          log(
            `[broker] runTurn_threw queueKey=${queueKey} turnId=${entry.turnId} err=${errMsg}`,
            "info",
          );
        } finally {
          inFlight.delete(queueKey);
          log(
            `[broker] complete queueKey=${queueKey} turnId=${entry.turnId}`,
            "info",
          );
          const admissionId = entryAdmissionId.get(entry);
          if (admissionId !== undefined) {
            const resolver = submitResolvers.get(admissionId);
            if (resolver !== undefined) {
              submitResolvers.delete(admissionId);
              resolver({ kind: "completed" });
            }
          }
          // Microtask re-entry so the dispatch loop yields between drains
          // and lets the Promise machinery settle resolvers in order.
          queueMicrotask(() => {
            tryDispatch();
          });
        }
      })();
      inFlightDrains.add(drain);
      void drain.finally(() => {
        inFlightDrains.delete(drain);
      });

      // Continue: dispatch additional non-inFlight keys this tick (the
      // Phase 3 helper will see the updated `inFlight` set).
    }
  }

  function submit(entry: BrokerEntry): Promise<BrokerSubmitResult> {
    const placement = decideQueuePlacement({
      entry,
      state: snapshotState(),
      config: resolved,
      nowMs: now(),
    });

    if (placement.kind === "reject") {
      log(
        `[broker] rejected queueKey=${entry.queueKey} reason=${placement.reason} turnId=${entry.turnId}`,
        "info",
      );
      return Promise.resolve({
        kind: "rejected",
        reason: placement.reason,
      });
    }

    let queue = queues.get(entry.queueKey);
    if (queue === undefined) {
      queue = [];
      queues.set(entry.queueKey, queue);
    }
    if (!keyOrder.includes(entry.queueKey)) {
      keyOrder.push(entry.queueKey);
    }
    queue.push(entry);
    log(
      `[broker] enqueued queueKey=${entry.queueKey} depth=${queue.length} turnId=${entry.turnId}`,
      "debug",
    );

    // S15 — assign a fresh admission id per `submit(...)` call. The id
    // is bound to the entry object (NOT to `entry.turnId`) so retries /
    // replays that reuse a turnId no longer clobber each other's
    // resolvers.
    const admissionId = nextAdmissionId;
    nextAdmissionId += 1;
    entryAdmissionId.set(entry, admissionId);

    return new Promise<BrokerSubmitResult>((resolve) => {
      submitResolvers.set(admissionId, resolve);
      // Schedule a dispatch tick. Microtask defer so the caller sees the
      // promise registration land before the synchronous dispatch path
      // begins (matters when `runTurn` is itself sync / settles
      // immediately).
      queueMicrotask(() => {
        tryDispatch();
      });
    });
  }

  function getQueueDepth(queueKey: BrokerQueueKey): number {
    return queues.get(queueKey)?.length ?? 0;
  }

  function getActiveKeys(): readonly BrokerQueueKey[] {
    const active: BrokerQueueKey[] = [];
    for (const key of keyOrder) {
      const queue = queues.get(key);
      if ((queue !== undefined && queue.length > 0) || inFlight.has(key)) {
        active.push(key);
      }
    }
    return active;
  }

  async function shutdown(): Promise<void> {
    isShutdown = true;
    // Count queued entries that will be dropped (reverse-defense observability).
    let dropped = 0;
    for (const queue of queues.values()) {
      dropped += queue.length;
    }
    // Wait for every in-flight drain to settle. Re-checks the set after
    // each settle because a drain may schedule a follow-up via the
    // microtask path (no-op once `isShutdown` flips because
    // `decideNextDispatch` returns idle/shutdown).
    while (inFlightDrains.size > 0) {
      await Promise.race(inFlightDrains).catch(() => undefined);
    }
    log(`[broker] shutdown drained=${dropped}`, "info");
  }

  return { submit, getQueueDepth, getActiveKeys, shutdown };
}
