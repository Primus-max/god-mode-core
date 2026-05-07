import {
  createConcurrentTurnBroker,
  type BrokerCapacityConfig,
  type ConcurrentTurnBroker,
} from "../platform/broker/index.js";

/**
 * Slice "PR-MT concurrent broker" — Phase 6 (production bootstrap binder).
 *
 * Process-scoped bootstrap that wires a default `ConcurrentTurnBroker`
 * singleton at gateway startup. Sibling of `persistent-worker-push-
 * bootstrap.ts` / `memory-store-bootstrap.ts` / `reminder-store-
 * bootstrap.ts` / `session-reset-bootstrap.ts`. Same per-process discipline:
 *   - one bind per process (idempotent — second call returns
 *     `'alreadyBound'`);
 *   - boundary lives in `src/server/`, NOT in `src/platform/commitment/`
 *     and NOT in `src/platform/decision/` (invariant #8);
 *   - no raw user text reads (#5/#6); the broker is structurally
 *     oblivious to turn content.
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_pr_mt_concurrent_broker.plan.md`
 * Phase 6.
 *
 * Behaviour change disclosure:
 *   - Pre-Phase-6 (dev HEAD): no bootstrap binder; the Phase 5 wiring at
 *     `agent-runner-execution.ts` runs with `concurrentBroker: undefined`
 *     so every dispatch falls through to the byte-identical pre-broker
 *     direct-invocation path. No production turns are routed through
 *     the broker.
 *   - Post-Phase-6: once the gateway calls
 *     `bindProcessConcurrentTurnBroker(...)`, the wiring resolves the
 *     bound broker via `getProcessConcurrentTurnBroker()` and routes
 *     production turns through it. Per-`(identityId, channelKey)` FIFO
 *     + cross-key concurrency become LIVE for the first time. Capacity
 *     caps + backpressure envelope (this slice) bound the worst case.
 *
 * Invariants honored:
 * - #8 — bootstrap module imports only the broker barrel; no commitment
 *   or decision imports.
 * - #11 — frozen contracts BYTE-IDENTICAL.
 * - #15 — bootstrap returns `{kind: 'bound' | 'alreadyBound'}`; never
 *   throws on a normal call. (The factory passes through to the broker
 *   constructor, which is itself non-throwing per Phase 4.)
 */

const BOOTSTRAP_KEY = Symbol.for(
  "openclaw.pr-mt.concurrent-turn-broker-bootstrap-singleton",
);

type Singleton = {
  bound: boolean;
  broker?: ConcurrentTurnBroker;
};

function getStore(): Singleton {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[BOOTSTRAP_KEY]) {
    g[BOOTSTRAP_KEY] = { bound: false };
  }
  return g[BOOTSTRAP_KEY] as Singleton;
}

/**
 * Caller-supplied bootstrap dependencies. Both fields optional:
 *   - `logger`: forwarded to the broker so the `[broker] *` telemetry
 *     lines reach the gateway log surface. When omitted the broker
 *     defaults to a no-op logger (matches the Phase 4 default).
 *   - `capacityConfig`: forwarded to `createConcurrentTurnBroker`. The
 *     factory applies `resolveBrokerCapacityConfig` so omitted fields
 *     fall back to Phase 2 defaults.
 */
export type BindProcessConcurrentTurnBrokerDeps = {
  readonly logger?: {
    log: (message: string, level?: "info" | "debug") => void;
  };
  readonly capacityConfig?: BrokerCapacityConfig;
};

/**
 * Result envelope of `bindProcessConcurrentTurnBroker`. Tests assert on
 * `kind === 'bound'` for the first call and `kind === 'alreadyBound'`
 * for subsequent calls.
 */
export type BindProcessConcurrentTurnBrokerResult = {
  readonly kind: "bound" | "alreadyBound";
};

/**
 * Binds the process-scoped `ConcurrentTurnBroker` singleton.
 *
 * Idempotent: a second call is a no-op (`kind: 'alreadyBound'`). The
 * gateway boot path can call this every restart without leaking an
 * extra binding. Test-only reset is exposed via
 * `__resetConcurrentTurnBrokerBootstrapForTests`.
 */
export function bindProcessConcurrentTurnBroker(
  deps: BindProcessConcurrentTurnBrokerDeps,
): BindProcessConcurrentTurnBrokerResult {
  const store = getStore();
  if (store.bound) {
    return { kind: "alreadyBound" };
  }

  const broker = createConcurrentTurnBroker(deps.capacityConfig, {
    ...(deps.logger ? { logger: deps.logger } : {}),
  });

  store.broker = broker;
  store.bound = true;
  deps.logger?.log?.(
    "[concurrent-turn-broker-bootstrap] bound process-scoped concurrent turn broker",
    "info",
  );
  return { kind: "bound" };
}

/**
 * Returns the process-scoped broker bound by
 * `bindProcessConcurrentTurnBroker`. Returns `undefined` when bootstrap
 * has not been called yet — callers (notably `agent-runner-execution.ts`
 * Phase 5 wiring) treat `undefined` as the broker-bypass path so unit
 * tests and pre-bootstrap startup paths see byte-identical pre-broker
 * direct-invocation behaviour.
 */
export function getProcessConcurrentTurnBroker(): ConcurrentTurnBroker | undefined {
  return getStore().broker;
}

/**
 * Test-only reset. Production never calls this. Clears the bootstrap
 * singleton so the next test starts from a clean state.
 */
export function __resetConcurrentTurnBrokerBootstrapForTests(): void {
  const store = getStore();
  store.bound = false;
  store.broker = undefined;
}
