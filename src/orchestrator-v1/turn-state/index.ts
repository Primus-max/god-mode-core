/**
 * V1-CONTRACT-ONLY — Turn-state service public surface.
 *
 * Only the types + factory are exported. The Map-backed impl is an
 * implementation detail callers should not reach into.
 */

export type { PartialAction, PendingTurn, TurnStateStore } from "./types.js";
export {
  createInMemoryTurnStateStore,
  DEFAULT_TURN_STATE_TTL_MS,
  type CreateInMemoryTurnStateStoreOptions,
} from "./in-memory-store.js";
export {
  getProcessTurnStateStore,
  setProcessTurnStateStoreForTesting,
} from "./singleton.js";
