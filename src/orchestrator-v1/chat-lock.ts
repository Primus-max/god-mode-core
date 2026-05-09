/**
 * V1-CONTRACT-ONLY — Per-chat serialization lock.
 *
 * Replaces the deleted `concurrent-turn-broker` for this orchestrator.
 * Same-chat turns serialize so two messages 2s apart don't race tool
 * calls (e.g. both writing to the same file). Different-chat turns
 * proceed concurrently — each chat has its own lock entry.
 *
 * Implementation: `Map<chatKey, Promise<void>>`. Each new turn awaits
 * the prior promise, runs its work, then resolves. The map entry is
 * deleted when the promise settles (no leak under sustained traffic).
 *
 * Per V1-CONTRACT-ONLY plan §"What stays / is reused" — minimum lock,
 * NOT the full broker. ~30 LOC.
 */

const LOCKS = new Map<string, Promise<void>>();

/**
 * Run `fn` inside the lock for `chatKey`. If another turn is in flight
 * for the same chat, wait for it before starting.
 */
export async function withChatLock<T>(
  chatKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = LOCKS.get(chatKey);
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Chain after prev so we run sequentially per-chat.
  const ourPromise = (prev ?? Promise.resolve()).then(() => next);
  LOCKS.set(chatKey, ourPromise);
  try {
    if (prev) {
      await prev;
    }
    return await fn();
  } finally {
    release();
    // Only clear our own entry — a later turn may have already replaced it.
    if (LOCKS.get(chatKey) === ourPromise) {
      LOCKS.delete(chatKey);
    }
  }
}

/** Test-only: count active locks. */
export function activeLockCount(): number {
  return LOCKS.size;
}

/** Test-only: drop all locks (for unit-test isolation). */
export function clearAllLocksForTesting(): void {
  LOCKS.clear();
}
