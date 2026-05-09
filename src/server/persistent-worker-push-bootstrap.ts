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

import type { CliDeps } from "../cli/deps.js";
import { createOutboundSendDeps } from "../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  deliverOutboundPayloads as deliverOutboundPayloadsImpl,
  type DeliverOutboundPayloadsParams,
  type OutboundDeliveryResult,
} from "../infra/outbound/deliver.js";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";
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
import type { DeliveryDispatchResult } from "../cron/isolated-agent/reminder-fire-callback.js";
import { runPersistentWorkerSubsequentPush } from "../platform/persistent-worker/persistent-worker-push-runtime-adapter.js";
import type {
  DeliveryDispatchFn as PersistentWorkerDeliveryDispatchFn,
  PersistentWorkerPushDispatchPayload,
} from "../platform/persistent-worker/persistent-worker-push-runtime-adapter.js";
import {
  getProcessPersistentWorkerReportCollector,
  type PersistentWorkerReportCollector,
} from "../platform/persistent-worker/persistent-worker-report-collector.js";

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
 * Phase 5d — production `deliveryDispatch` transport closure factory.
 *
 * Phase 5c (PR #281) wired `setProcessPersistentWorkerPushFireCallback`
 * but the `deliveryDispatch` parameter shipped with a
 * `transport_not_wired` stub that returned a structured `dispatch_failed`
 * envelope without throwing. Phase 5d closes this gap so production
 * push'ы actually arrive in Telegram/Slack.
 *
 * Wiring choice (sub-plan §3.3 — REUSE, no fork):
 *   The closure adapts `PersistentWorkerPushDispatchPayload` →
 *   `deliverOutboundPayloads` (the lower-level outbound primitive that
 *   `dispatchCronDelivery` itself sits on top of). Calling
 *   `deliverOutboundPayloads` directly here is the minimum-surface
 *   wiring: the cron-fire callback already supplies the resolved
 *   `channel` + `to` from the persisted `SubagentRunRecord.requesterOrigin`
 *   (Phase 5b discipline), and the runtime adapter performs the closed-
 *   shape Zod validation upstream. Nothing in this closure constructs
 *   a `CronJob` (the upstream cron-fire boundary is structural — there
 *   is no job to attach).
 *
 * Failure mapping (audit §h Phase 4 — closed 8-entry surface preserved):
 *   - empty/non-deliverable `payload.channel`           → `channel_invalid`
 *   - deliverer returns `[]` (no channel accepted send) → `dispatch_failed`
 *   - deliverer throws (paranoia)                       → `dispatch_failed`
 *   - everything else                                   → `{ ok: true }`
 *   The runtime adapter (Phase 4) maps `{ ok: false, reason }` into the
 *   same closed-set 8-entry failure surface so #15 holds end-to-end.
 *
 * Behaviour change disclosure:
 *   Pre-Phase-5d: persistent-worker completions surface a structured
 *   `dispatch_failed` (reason=`transport_not_wired`) and the operator
 *   never receives a push.
 *   Post-Phase-5d: persistent-worker completions LIVE-PUSH back to the
 *   operator's external channel via `deliverOutboundPayloads`. The
 *   Phase 5b gating predicates (spawnMode === 'session', branded
 *   ownerIdentityId, non-empty frozenResultText, resolvable channel/to)
 *   AND the callback's anonymous-fail-closed defence-in-depth still
 *   apply at the upstream `subagent_ended` seam.
 */
export type ProductionDeliveryDispatchDeps = {
  /** Gateway config — opaque pass-through to `deliverOutboundPayloads`. */
  readonly cfg: OpenClawConfig;
  /** Lazy-loaded channel sender map — opaque pass-through. */
  readonly deps: CliDeps;
  /**
   * DI seam for the outbound delivery primitive. Production wires the
   * real `deliverOutboundPayloads` from `infra/outbound/deliver.ts`;
   * tests inject a fixture that returns a deterministic results array.
   */
  readonly deliverOutboundPayloads?: (
    params: DeliverOutboundPayloadsParams,
  ) => Promise<OutboundDeliveryResult[]>;
  /**
   * Optional structured-line emitter for ops follow-up. Defaults to a
   * no-op so the closure stays silent in unit tests; production wiring
   * threads the gateway logger.
   */
  readonly logger?: { readonly log: (message: string) => void };
};

export function createProductionPersistentWorkerPushDeliveryDispatch(
  deps: ProductionDeliveryDispatchDeps,
): PersistentWorkerDeliveryDispatchFn {
  if (!deps || typeof deps !== "object") {
    throw new TypeError(
      "createProductionPersistentWorkerPushDeliveryDispatch: deps required",
    );
  }
  const deliverer =
    typeof deps.deliverOutboundPayloads === "function"
      ? deps.deliverOutboundPayloads
      : deliverOutboundPayloadsImpl;

  return async (
    payload: PersistentWorkerPushDispatchPayload,
  ): Promise<DeliveryDispatchResult> => {
    try {
      // Closed-shape channel guard. The runtime adapter's Phase 2 schema
      // rejects empty `channel` upstream (fans into `channel_invalid`),
      // but this is defense-in-depth so the outbound adapter never sees
      // a malformed channel that would synthesize an "unknown channel"
      // error message. We accept any non-empty deliverable channel id;
      // the outbound adapter resolves the concrete plugin downstream.
      const channelRaw =
        typeof payload?.channel === "string" ? payload.channel.trim() : "";
      if (channelRaw.length === 0) {
        return { ok: false, reason: "channel_invalid" };
      }
      const toRaw =
        typeof payload?.to === "string" ? payload.to.trim() : "";
      if (toRaw.length === 0) {
        return { ok: false, reason: "channel_invalid" };
      }
      const contentRaw =
        typeof payload?.content === "string" ? payload.content : "";
      // Deliverable check is best-effort — plugin channels register
      // dynamically. If the channel id is in the static list we narrow
      // the type; otherwise we still attempt delivery (the outbound
      // adapter's plugin loader is the source of truth).
      const isStaticDeliverable = isDeliverableMessageChannel(channelRaw);

      // Cast through `unknown` — `OutboundChannel` is a union of branded
      // channel ids; this closure cannot enumerate plugin channels at
      // module-load time so we trust the outbound adapter to validate
      // the resolved channel plugin downstream.
      const channelForOutbound = channelRaw as unknown as DeliverOutboundPayloadsParams["channel"];

      let results: OutboundDeliveryResult[];
      try {
        results = await deliverer({
          cfg: deps.cfg,
          channel: channelForOutbound,
          to: toRaw,
          payloads: [{ text: contentRaw }],
          deps: createOutboundSendDeps(deps.deps),
          // Best-effort: the cron-fire callback's mark-before-dispatch
          // already records `subsequentPushStatus='pushed'` (idempotent
          // on retry). A best-effort send mirrors `dispatchCronDelivery`'s
          // direct-cron path so a transient channel error does not bubble
          // out as a thrown exception.
          bestEffort: true,
          // Skip write-ahead delivery queue: the cron-fire callback owns
          // its own retry semantics (the failure record + the run record's
          // `subsequentPushStatus='failed'` flag prevent infinite replay).
          skipQueue: true,
        });
      } catch (err) {
        // #15 — never throw out of the closure. Surface
        // `dispatch_failed` so the runtime adapter maps it into the
        // closed-set surface; the underlying error message is logged
        // but never propagated.
        deps.logger?.log?.(
          `[persistent-worker-push-bootstrap] deliverOutboundPayloads threw — workerRunId=${payload.workerRunId} channel=${channelRaw} reason=${err instanceof Error ? err.message : String(err)}`,
        );
        return { ok: false, reason: "dispatch_failed" };
      }

      if (!Array.isArray(results) || results.length === 0) {
        // Empty results array: no channel adapter accepted the send.
        // Either the channel is unknown (best-effort suppression) or
        // the outbound queue suppressed the send. Map to
        // `dispatch_failed` so the runtime adapter records the failure.
        deps.logger?.log?.(
          `[persistent-worker-push-bootstrap] deliverOutboundPayloads returned empty results — workerRunId=${payload.workerRunId} channel=${channelRaw} isStaticDeliverable=${isStaticDeliverable}`,
        );
        return { ok: false, reason: "dispatch_failed" };
      }

      return { ok: true };
    } catch (err) {
      // Catch-all #15 — every failure path returns the closed-shape
      // envelope. A thrown exception from a deeply-malformed payload
      // (e.g. a getter that throws) should never bubble out of the
      // dispatch boundary.
      deps.logger?.log?.(
        `[persistent-worker-push-bootstrap] dispatch closure caught unexpected error — reason=${err instanceof Error ? err.message : String(err)}`,
      );
      return { ok: false, reason: "dispatch_failed" };
    }
  };
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
