/**
 * V1-CONTRACT-ONLY — In-memory implementation of `TurnStateStore`.
 *
 * Process-scoped Map<chatKey, PendingTurn>. TTL eviction on read; on a
 * stale read the entry is also dropped, so a long-idle chat doesn't leak.
 *
 * Per-chat serialization is owned by `chat-lock.ts` upstream — this store
 * does NOT add its own locking. Two concurrent get/put/clear calls for
 * the same chatKey are safe at the Map level (single-threaded JS); the
 * upstream lock guarantees they're never interleaved with logic that
 * cares about ordering.
 */

import type { PendingTurn, TurnStateStore } from "./types.js";

/** Default TTL for a pending turn — operator-tuned heuristic. */
export const DEFAULT_TURN_STATE_TTL_MS = 10 * 60 * 1000; // 10 min

export type CreateInMemoryTurnStateStoreOptions = {
  /** Override the wall-clock for tests. */
  now?: () => number;
};

/**
 * Build an in-memory `TurnStateStore`. Each instance has its own Map so
 * tests can construct a fresh store without resetting global state.
 */
export function createInMemoryTurnStateStore(
  opts: CreateInMemoryTurnStateStoreOptions = {},
): TurnStateStore {
  const now = opts.now ?? (() => Date.now());
  const map = new Map<string, PendingTurn>();
  return {
    async get(chatKey: string): Promise<PendingTurn | undefined> {
      const entry = map.get(chatKey);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        map.delete(chatKey);
        return undefined;
      }
      return entry;
    },
    async put(chatKey: string, state: PendingTurn): Promise<void> {
      map.set(chatKey, state);
    },
    async clear(chatKey: string): Promise<void> {
      map.delete(chatKey);
    },
  };
}
