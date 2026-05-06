/**
 * NEW-B Phase 5 — process-singleton bootstrap for the
 * `SessionResetSubscriberRegistry`. Mirrors `memory-store-bootstrap.ts`
 * (slice E precedent): a single `globalThis`-backed singleton built once
 * per process at the first `getSessionResetRegistry()` call.
 *
 * Boundary discipline:
 * - Lives in `src/server/`, NOT in `src/platform/commitment/` (invariant
 *   #8) and NOT in `src/platform/decision/`.
 * - Registers 8 subscribers in DETERMINISTIC ORDER matching the Phase 1
 *   audit closed list (`extensions/AUDIT-unified-session-reset.md` §d).
 *   Phase 6 acceptance asserts both `subscribers=8` and the order so the
 *   operator-grep anchor stays stable.
 * - Idempotent: a second call to `getSessionResetRegistry()` returns the
 *   SAME registry instance — re-bootstrap does NOT re-register or
 *   shuffle the order.
 * - Failure-isolated: registration is synchronous and cannot fail
 *   (subscribers are pure factories with no IO). The plugin-hooks
 *   subscriber is wired with a thunk that resolves the active hook
 *   runner per-event so the registry can be built BEFORE the plugin
 *   loader has run; pre-load events skip with `no_global_hook_runner`.
 *
 * Per-call cfg wiring: the plugin-hooks subscriber needs `agentId`
 * resolution, which depends on the live `OpenClawConfig`. The registry
 * itself is process-scoped (cfg-agnostic), so a small mutable
 * `setSessionResetActiveCfg(cfg)` setter is exposed; `session.ts` calls
 * it once per `resetTurnSession()` invocation just before the call so
 * the subscriber's `resolveAgentId` thunk reads the freshest cfg. When
 * no cfg has been set yet, the thunk returns `undefined` and the plugin
 * hooks fire without `agentId` (parity with the absent-cfg path of the
 * old inline call at `session.ts:601-630`).
 */

import { resolveSessionAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { createArtifactObserverSubscriber } from "../agents/pi-embedded-runner/run/session-reset-subscribers/artifact-observer-subscriber.js";
import { createWorldStateSessionsSubscriber } from "../agents/pi-embedded-runner/run/session-reset-subscribers/world-state-sessions-subscriber.js";
import { createFollowupQueueClearSubscriber } from "../auto-reply/reply/session-reset-subscribers/followup-queue-clear-subscriber.js";
import { createMemoryScopeReaffirmSubscriber } from "../auto-reply/reply/session-reset-subscribers/memory-scope-reaffirm-subscriber.js";
import { createMemoryWiringResolverSubscriber } from "../auto-reply/reply/session-reset-subscribers/memory-wiring-resolver-subscriber.js";
import { createPluginHooksSubscriber } from "../auto-reply/reply/session-reset-subscribers/plugin-hooks-subscriber.js";
import { createTaskScopeReaffirmSubscriber } from "../auto-reply/reply/session-reset-subscribers/task-scope-reaffirm-subscriber.js";
import { clearFollowupQueue } from "../auto-reply/reply/queue/state.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  createSessionResetSubscriberRegistry,
  type SessionResetSubscriberRegistry,
} from "../platform/session/reset.js";
import { intentLedger } from "../platform/session/intent-ledger.js";
import { createIntentLedgerResetSubscriber } from "../platform/session/intent-ledger-reset-subscriber.js";

/**
 * Process-singleton container shape. Stored on `globalThis` keyed by
 * `Symbol.for(...)` so ESM module-level dedup quirks (re-imports across
 * bundle chunks) do not duplicate the registry.
 */
type Singleton = {
  registry: SessionResetSubscriberRegistry;
  activeCfg: OpenClawConfig | undefined;
};

const REGISTRY_KEY = Symbol.for(
  "openclaw.new-b.session-reset-registry-singleton",
);

function getStore(): { current?: Singleton } {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[REGISTRY_KEY]) {
    g[REGISTRY_KEY] = { current: undefined };
  }
  return g[REGISTRY_KEY] as { current?: Singleton };
}

/**
 * Resolve the per-process session-reset subscriber registry. First call
 * builds the registry and registers the 8 Phase-4 subscribers in
 * deterministic order; subsequent calls return the SAME registry
 * instance (idempotent). Tests wishing to start from a clean slate call
 * `__resetSessionResetRegistryForTests()`.
 *
 * Deterministic registration order (Phase 6 acceptance asserts this
 * order; do NOT reorder without updating the assertion):
 *
 *   1. subscriber:followup-queue-clear              (chat-history)
 *   2. subscriber:memory-scope-reaffirm             (memory-scope)
 *   3. subscriber:task-scope-reaffirm               (task-scope)
 *   4. subscriber:artifact-observer-clear           (observer)
 *   5. subscriber:world-state-sessions-current-flip (world-state)
 *   6. subscriber:plugin-hooks                      (plugin)
 *   7. subscriber:intent-ledger-clear               (misc)
 *   8. subscriber:memory-wiring-resolver-clear      (misc)
 */
export function getSessionResetRegistry(): SessionResetSubscriberRegistry {
  const store = getStore();
  if (store.current) {
    return store.current.registry;
  }
  const registry = createSessionResetSubscriberRegistry();
  // 1. PRIMARY fix per audit §f — clears process-global FOLLOWUP_QUEUES
  registry.register(
    createFollowupQueueClearSubscriber({
      clearFollowupQueue: (key: string) => clearFollowupQueue(key),
    }),
  );
  // 2. Memory identity-scope reaffirm (slice E B1 contract)
  registry.register(createMemoryScopeReaffirmSubscriber());
  // 3. Task identity-scope reaffirm (slice F B7 contract)
  registry.register(createTaskScopeReaffirmSubscriber());
  // 4. Artifact observer (frozen-layer adapter; default skipped per audit §g)
  registry.register(createArtifactObserverSubscriber());
  // 5. World-state-sessions adapter (derived projection; default skipped)
  registry.register(createWorldStateSessionsSubscriber());
  // 6. Plugin hooks fan-out (replaces inline call at old session.ts:601-630).
  //    `resolveHookRunner` is a thunk so the registry can be built BEFORE
  //    the plugin loader has run (pre-load events skip with
  //    `no_global_hook_runner`).
  //    `resolveAgentId` reads the active cfg via `getActiveCfg()`; when
  //    `session.ts` has not yet called `setSessionResetActiveCfg(cfg)` the
  //    thunk returns `undefined` and hooks fire without `agentId`.
  registry.register(
    createPluginHooksSubscriber({
      resolveHookRunner: () => getGlobalHookRunner(),
      resolveAgentId: (params: {
        sessionId: string;
        sessionKey: string;
      }): string | undefined => {
        const cfg = getActiveCfg();
        if (cfg === undefined) {
          return undefined;
        }
        return resolveSessionAgentId({
          sessionKey: params.sessionKey,
          config: cfg,
        });
      },
    }),
  );
  // 7. IntentLedger session-scope clear
  registry.register(
    createIntentLedgerResetSubscriber({
      ledger: {
        invalidate: (predicate) => intentLedger.invalidate(predicate),
      },
    }),
  );
  // 8. Memory-wiring resolver (no per-turn cache today; observability skip)
  registry.register(createMemoryWiringResolverSubscriber());
  store.current = { registry, activeCfg: undefined };
  return registry;
}

/**
 * Stash the live `OpenClawConfig` for the next `resetTurnSession()`
 * call. Read by the plugin-hooks subscriber's `resolveAgentId` thunk.
 * Idempotent and order-independent — calling this AFTER
 * `getSessionResetRegistry()` is fine; the singleton is built lazily and
 * reads the cfg via the closure on every event.
 *
 * `session.ts` calls this once per `if (isNewSession)` block just before
 * `resetTurnSession()` so the subscriber pool sees the freshest config
 * (mirrors the per-call lookup the old inline plugin-hook block did via
 * `buildSessionStartHookPayload({...cfg})`).
 */
export function setSessionResetActiveCfg(cfg: OpenClawConfig): void {
  // Ensure the singleton exists so the cfg is stored on it; the field
  // is read via `getActiveCfg()` from the same singleton container.
  const registry = getSessionResetRegistry();
  const store = getStore();
  if (store.current) {
    store.current.activeCfg = cfg;
    return;
  }
  // Defensive: `getSessionResetRegistry` always sets `current`, but if
  // a future refactor removes that, fall back to creating a fresh slot.
  store.current = { registry, activeCfg: cfg };
}

/**
 * Read the active cfg (set via `setSessionResetActiveCfg`). Returns
 * `undefined` when no cfg has been set yet (pre-bootstrap or test
 * fixtures that never wired one) — callers MUST handle that case.
 */
function getActiveCfg(): OpenClawConfig | undefined {
  const store = getStore();
  return store.current?.activeCfg;
}

/**
 * Reset the per-process singleton. Test-only — production never calls
 * this. Mirrors `__resetMemoryRuntimeForTests` from
 * `memory-store-bootstrap.ts`.
 */
export function __resetSessionResetRegistryForTests(): void {
  const store = getStore();
  store.current = undefined;
}
