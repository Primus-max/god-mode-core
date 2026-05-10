/**
 * V1-CONTRACT-ONLY — Process-scoped `TurnStateStore` singleton.
 *
 * The orchestrator-v1 multi-turn state machine (PR #349) accepts an
 * optional `turnState?: TurnStateStore` input but the feature is dormant
 * unless the 3 dispatch sites that call `runOrchestratorTurn` pass a
 * SHARED store instance. Without sharing, each dispatch helper would
 * create its own Map and a follow-up message coming through a different
 * surface would not see the pending plan stashed by the prior turn.
 *
 * This module mirrors the lazy-init singleton pattern used by S11c's
 * `getProcessPersistentWorkerReportCollector()` in
 * `src/platform/persistent-worker/persistent-worker-report-collector.ts`:
 *
 *   - Lazy-init on first read so module load order does not matter and
 *     processes that never enter the v1 path (env flag unset) pay zero
 *     allocation cost.
 *   - Idempotent: subsequent calls return the same instance so the 3
 *     dispatch sites observe each other's writes.
 *   - Test-only setter so unit tests can pin a deterministic store and
 *     inspect bucket state directly.
 *
 * The singleton uses the in-memory implementation with the default 10-min
 * TTL. A future SQLite / Redis implementation would just swap the factory
 * here without touching the dispatch sites.
 */

import { createInMemoryTurnStateStore } from "./in-memory-store.js";
import type { TurnStateStore } from "./types.js";

let processStore: TurnStateStore | undefined;

/**
 * Returns the lazily-initialised process-scoped `TurnStateStore`. The
 * accessor is idempotent so the 3 orchestrator-v1 dispatch sites
 * (Telegram, plugin-sdk inbound, agent-command ingress) all observe the
 * same pending-turn map.
 */
export function getProcessTurnStateStore(): TurnStateStore {
  if (!processStore) {
    processStore = createInMemoryTurnStateStore();
  }
  return processStore;
}

/**
 * Test-only override of the process-scoped store. Production never
 * calls this; tests pin a deterministic instance so assertions can
 * inspect pending-turn state directly.
 *
 * @param store - Replacement store, or `undefined` to reset to lazy-init
 *   on next read.
 */
export function setProcessTurnStateStoreForTesting(
  store: TurnStateStore | undefined,
): void {
  processStore = store;
}
