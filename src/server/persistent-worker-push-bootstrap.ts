/**
 * Bug F (persistent-worker subsequent push) Phase 5c — production
 * bootstrap that wires `setProcessPersistentWorkerPushFireCallback`
 * with the cron-fire callback closure (Phase 5b shipped the binder
 * mechanism + the `subagent_ended` hook flip; this slice closes the
 * production-wiring gap that was explicitly listed as out-of-scope in
 * the Phase 5b PR body).
 *
 * Sibling of `memory-store-bootstrap.ts` / `reminder-store-bootstrap.ts`
 * / `session-reset-bootstrap.ts`. Same per-process singleton discipline:
 *   - one bind per process (idempotent — a second call is a no-op);
 *   - boundary lives in `src/server/`, NOT in `src/platform/commitment/`
 *     and NOT in `src/platform/decision/` (invariant #8);
 *   - no raw user text is read; the closure threads only structural
 *     `PersistentWorkerPushFireCallbackArgs` (sessionId, turnId,
 *     workerRunId, completedAt, channel, to, frozen-result content) at
 *     callback-invocation time (#5/#6).
 *
 * Dependency wiring (sub-plan §3.4):
 *   - `subagentStore`: closure over the registry's `getSubagentRunRecord`
 *     and `markSubagentRunSubsequentPushStatus` accessors (Phase 5c
 *     additive helper for the `get(workerRunId)` predicate).
 *   - `adapter`: `runPersistentWorkerSubsequentPush` from Phase 4.
 *   - `collector`: process-scoped `PersistentWorkerReportCollector`
 *     singleton (Phase 5 — `getProcessPersistentWorkerReportCollector()`).
 *   - `deliveryDispatch`: REQUIRED dependency-injected at bootstrap
 *     time — caller (gateway startup) supplies the production transport
 *     wiring. The shape mirrors slice K's `DeliveryDispatchFn` so a
 *     future fan-out helper can drive both call-sites without an extra
 *     translation layer.
 *   - `logger`: optional; defaults to a `createSubsystemLogger`
 *     ("persistent-worker") wrapper so the structured log lines emitted
 *     by the cron-fire callback reach the gateway log surface.
 *
 * Bootstrap-order discipline (acceptance #5):
 *   - The collector + observer must be initialised BEFORE the binder is
 *     set; otherwise a worker_completion arriving between
 *     `setProcessPersistentWorkerPushFireCallback(...)` and the first
 *     observer read would push without recording, leaving the
 *     done-predicate slice-absent. The bootstrap evaluates the
 *     collector accessor inside the binder closure (lazy resolution) so
 *     the singleton is observable before the first callback fires; the
 *     collector accessor itself is idempotent (returns the same
 *     instance on every call — `getProcessPersistentWorkerReportCollector()`
 *     in `persistent-worker-report-observer.ts:354-369`). Caller order
 *     is documented in the test plan; the bootstrap also calls the
 *     collector accessor once eagerly at bind time so a malformed
 *     factory surfaces during boot rather than at the first cron-fire.
 *
 * Behaviour change disclosure:
 *   - Pre-Phase-5c (dev HEAD): the binder is unset, so the
 *     `subagent_ended` hook short-circuits and persistent-worker
 *     completions do NOT push to the operator's external channel.
 *   - Post-Phase-5c: once the gateway calls
 *     `bindProcessPersistentWorkerPushFireCallback({ deliveryDispatch })`,
 *     persistent-worker completions LIVE-PUSH back to the operator's
 *     channel via the sanctioned codepath. The Phase 5b gating
 *     predicates (spawnMode === 'session', branded ownerIdentityId,
 *     non-empty frozenResultText, resolvable channel/to) are still
 *     enforced at the `subagent_ended` seam, and the callback's
 *     anonymous-fail-closed defence-in-depth still guards against an
 *     unbranded record reaching the dispatch boundary.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  getSubagentRunRecord,
  markSubagentRunSubsequentPushStatus,
  setProcessPersistentWorkerPushFireCallback,
} from "../agents/subagent-registry.js";
import {
  persistentWorkerPushFireCallback,
  type PersistentWorkerPushFireCallbackArgs,
  type PersistentWorkerPushFireCallbackDeps,
  type PersistentWorkerPushFireCallbackResult,
  type PersistentWorkerReportCollectorWithFailure,
  type PersistentWorkerSubagentRecord,
  type PersistentWorkerSubagentStore,
} from "../cron/isolated-agent/persistent-worker-push-fire-callback.js";
import { runPersistentWorkerSubsequentPush } from "../platform/persistent-worker/persistent-worker-push-runtime-adapter.js";
import {
  getProcessPersistentWorkerReportCollector,
  type PersistentWorkerReportCollector,
} from "../platform/commitment/persistent-worker-report-observer.js";

const log = createSubsystemLogger("persistent-worker");

const BOOTSTRAP_KEY = Symbol.for(
  "openclaw.bug-f.persistent-worker-push-bootstrap-singleton",
);

type Singleton = {
  bound: boolean;
};

function getStore(): Singleton {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[BOOTSTRAP_KEY]) {
    g[BOOTSTRAP_KEY] = { bound: false };
  }
  return g[BOOTSTRAP_KEY] as Singleton;
}

/**
 * Caller-supplied bootstrap dependencies. `deliveryDispatch` is the only
 * required field; every other field has a production default sourced
 * from the matching Phase 4/Phase 5 singleton accessor. Tests inject all
 * fields so the closure can be exercised without touching the real
 * registry / collector.
 */
export type PersistentWorkerPushBootstrapDeps = {
  /**
   * Production transport — sub-plan §3.3 / audit §a.3. Mirrors slice
   * K's `DeliveryDispatchFn` shape (re-exported through the runtime
   * adapter as `DeliveryDispatchFn`). The bootstrap does NOT construct
   * this; gateway startup wires the transport closure that fan-outs
   * into the existing channel resolver.
   */
  readonly deliveryDispatch: PersistentWorkerPushFireCallbackDeps["deliveryDispatch"];
  /**
   * Test-only override for the registry's `get(workerRunId) +
   * markSubsequentPushStatus(workerRunId, status)` accessor pair.
   * Production threads through the `subagent-registry.ts` module-level
   * accessors so the closure observes the live registry without an
   * extra indirection.
   */
  readonly subagentStore?: PersistentWorkerSubagentStore;
  /**
   * Test-only override for the process-scoped collector. Production
   * always resolves through `getProcessPersistentWorkerReportCollector()`
   * (idempotent — returns the same instance on every call).
   */
  readonly collector?: PersistentWorkerReportCollectorWithFailure;
  /**
   * Optional structured-line emitter override. Production threads the
   * `createSubsystemLogger("persistent-worker")` wrapper so the
   * callback's `[persistent-worker-push-fire-callback]` lines reach
   * the gateway log surface.
   */
  readonly logger?: { readonly log: (message: string) => void };
};

/**
 * Result envelope of `bindProcessPersistentWorkerPushFireCallback`.
 * Tests assert on `bound === true` for the first call and
 * `alreadyBound === true` for subsequent calls.
 */
export type PersistentWorkerPushBootstrapResult = {
  readonly bound: boolean;
  readonly alreadyBound: boolean;
};

/**
 * Constructs the production `PersistentWorkerSubagentStore` closure on
 * top of the registry's `getSubagentRunRecord` + `markSubagentRunSubsequentPushStatus`
 * exports. Lifted to a top-level helper so test callers that want to
 * assert against the production wiring (rather than injecting a fixture
 * store) can re-use the exact closure used at bind time.
 */
export function createDefaultPersistentWorkerSubagentStore(): PersistentWorkerSubagentStore {
  return Object.freeze({
    get(workerRunId: string): PersistentWorkerSubagentRecord | undefined {
      const entry = getSubagentRunRecord(workerRunId);
      if (!entry) {
        return undefined;
      }
      // Project to the closed-shape `PersistentWorkerSubagentRecord`
      // structure so the callback never sees mutable internal state of
      // the live `SubagentRunRecord` map (defense in depth — a closure
      // mutation here would leak directly into the registry).
      const projected: PersistentWorkerSubagentRecord = {
        runId: entry.runId,
        ...(entry.ownerIdentityId !== undefined
          ? { ownerIdentityId: entry.ownerIdentityId }
          : {}),
        ...(entry.subsequentPushStatus !== undefined
          ? { subsequentPushStatus: entry.subsequentPushStatus }
          : {}),
      };
      return projected;
    },
    markSubsequentPushStatus(
      workerRunId: string,
      status: "pending" | "pushed" | "failed",
    ): boolean {
      return markSubagentRunSubsequentPushStatus(workerRunId, status);
    },
  });
}

/**
 * Resolves the production collector via the Phase 5 singleton. Cast to
 * the wider `PersistentWorkerReportCollectorWithFailure` shape because
 * the `recordFailure(...)` method is defined by the observer module
 * (`PersistentWorkerReportCollector` extends the runtime adapter's
 * narrower `PersistentWorkerReportCollector` with `recordFailure`).
 * The cast is sound — the in-memory implementation always carries
 * `recordFailure`; tests can inject a fixture that asserts the same
 * surface.
 */
function resolveDefaultCollector(): PersistentWorkerReportCollectorWithFailure {
  const collector: PersistentWorkerReportCollector =
    getProcessPersistentWorkerReportCollector();
  return collector as unknown as PersistentWorkerReportCollectorWithFailure;
}

/**
 * Binds the process-scoped persistent-worker push fire callback.
 *
 * Idempotent: a second call is a no-op (`alreadyBound: true`); the
 * gateway boot path can call this every restart without leaking an
 * extra binding. The bootstrap evaluates the collector accessor once
 * eagerly so a malformed factory surfaces here rather than at the
 * first cron-fire.
 */
export function bindProcessPersistentWorkerPushFireCallback(
  deps: PersistentWorkerPushBootstrapDeps,
): PersistentWorkerPushBootstrapResult {
  if (!deps || typeof deps !== "object") {
    throw new TypeError(
      "bindProcessPersistentWorkerPushFireCallback: deps required",
    );
  }
  if (typeof deps.deliveryDispatch !== "function") {
    throw new TypeError(
      "bindProcessPersistentWorkerPushFireCallback: deps.deliveryDispatch required",
    );
  }

  const store = getStore();
  if (store.bound) {
    log.info?.(
      "[persistent-worker-push-bootstrap] already bound — second call ignored (idempotent)",
    );
    return { bound: false, alreadyBound: true };
  }

  const subagentStore =
    deps.subagentStore ?? createDefaultPersistentWorkerSubagentStore();
  // Eager resolve so a malformed factory throws at boot time, not at
  // the first cron-fire boundary.
  const collector = deps.collector ?? resolveDefaultCollector();
  const logger = deps.logger ?? { log: (message: string) => log.info?.(message) };

  const bound: PersistentWorkerPushFireCallbackDeps = {
    subagentStore,
    adapter: runPersistentWorkerSubsequentPush,
    collector,
    deliveryDispatch: deps.deliveryDispatch,
    logger,
  };

  const closure = (
    args: PersistentWorkerPushFireCallbackArgs,
  ): Promise<PersistentWorkerPushFireCallbackResult> =>
    persistentWorkerPushFireCallback(bound, args);

  setProcessPersistentWorkerPushFireCallback(closure);
  store.bound = true;
  log.info?.(
    "[persistent-worker-push-bootstrap] bound process-scoped persistent_worker push fire callback",
  );
  return { bound: true, alreadyBound: false };
}

/**
 * Test-only reset. Production never calls this. Clears the bootstrap
 * singleton AND clears the binder so the next test starts from a
 * clean state.
 */
export function __resetPersistentWorkerPushBootstrapForTests(): void {
  const store = getStore();
  store.bound = false;
  setProcessPersistentWorkerPushFireCallback(undefined);
}
