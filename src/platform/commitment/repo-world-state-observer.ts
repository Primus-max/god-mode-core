import type { SessionId } from "./ids.js";
import {
  repoOperationRecordSchema,
  type RepoOperationRecord,
  type RepoWorldState,
} from "./world-state.js";

export type RepoTurnKey = {
  readonly sessionId: SessionId;
  readonly turnId: string;
};

const DEFAULT_PER_TURN_LIMIT = 8;

export interface RepoWorldStateCollector {
  /**
   * Appends a repo-operation record to the bucket for `(sessionId, turnId)`.
   * Records with the same `repoOperationId` for the same key dedupe last-
   * writer-wins (the previous entry is removed before the new one is
   * appended). Malformed records (missing fields, unknown kind, malformed
   * sha / timestamp) throw — invalid data is never persisted into the
   * WorldState.
   *
   * @param record - Repo-operation record produced by the Phase 5 runtime adapter.
   * @param key - Turn-scoped bucket key.
   */
  record(record: RepoOperationRecord, key: RepoTurnKey): void;

  /**
   * Drops every record bucketed under `(sessionId, turnId)`. Called by the
   * runtime adapter at turn-start to enforce per-turn isolation.
   *
   * @param key - Turn-scoped bucket key to clear.
   */
  resetForTurn(key: RepoTurnKey): void;

  /**
   * Marks the bucket the observer should expose via `observe()`. Production
   * callers (Phase 5 runtime adapter) set this once per turn; tests pin a
   * fixture key explicitly. `undefined` clears the active pointer so
   * `observe()` returns `undefined` (the WorldState slice is absent — the
   * default state when no repo-touching tool has run on this turn).
   *
   * @param key - Turn key to expose, or `undefined` to clear.
   */
  setActiveTurn(key: RepoTurnKey | undefined): void;

  /**
   * Returns the records bucketed under the currently-active turn, oldest
   * first. Returns `undefined` when no active turn is set or when the active
   * turn's bucket has never been written.
   *
   * @returns Frozen list of records for the active turn, or `undefined`.
   */
  getActiveSlice(): readonly RepoOperationRecord[] | undefined;
}

export interface RepoWorldStateObserver {
  /**
   * Reads a deterministic `RepoWorldState` snapshot for the currently-active
   * turn. Returns `undefined` when the kernel runs through a turn that
   * produced no repo operations — the predicate sees `repo.slice_absent`
   * rather than an empty `records` list (slice E precedent / Cutover-3
   * artifacts precedent).
   *
   * @returns Frozen `RepoWorldState` derived from the collector, or
   *   `undefined` when no active turn is set.
   */
  observe(): RepoWorldState | undefined;
}

export type CreateRepoWorldStateCollectorOptions = {
  /**
   * Soft cap on the number of records retained per `(sessionId, turnId)`.
   * Older records are dropped from the head when exceeded. Defaults to 8
   * (cutover-4 sub-plan §1 todo Phase 3, mirrors Cutover-3 artifact
   * collector).
   */
  readonly perTurnLimit?: number;
};

function bucketKey(key: RepoTurnKey): string {
  return `${key.sessionId} ${key.turnId}`;
}

class InMemoryRepoWorldStateCollector implements RepoWorldStateCollector {
  readonly #buckets = new Map<string, RepoOperationRecord[]>();
  readonly #perTurnLimit: number;
  #activeKey: string | undefined;

  constructor(options: CreateRepoWorldStateCollectorOptions) {
    this.#perTurnLimit = Math.max(1, options.perTurnLimit ?? DEFAULT_PER_TURN_LIMIT);
  }

  record(record: RepoOperationRecord, key: RepoTurnKey): void {
    // Validate via Zod; throws on missing fields / unknown kind / malformed
    // sha / timestamp. The runtime adapter (Phase 5) is the only writer in
    // production; tests exercise the rejection path explicitly.
    const parsed = repoOperationRecordSchema.parse(record) as RepoOperationRecord;
    const bk = bucketKey(key);
    const bucket = this.#buckets.get(bk) ?? [];
    const filtered = bucket.filter(
      (entry) => entry.repoOperationId !== parsed.repoOperationId,
    );
    filtered.push(Object.freeze({ ...parsed }));
    while (filtered.length > this.#perTurnLimit) {
      filtered.shift();
    }
    this.#buckets.set(bk, filtered);
  }

  resetForTurn(key: RepoTurnKey): void {
    this.#buckets.delete(bucketKey(key));
  }

  setActiveTurn(key: RepoTurnKey | undefined): void {
    this.#activeKey = key === undefined ? undefined : bucketKey(key);
  }

  getActiveSlice(): readonly RepoOperationRecord[] | undefined {
    if (this.#activeKey === undefined) {
      return undefined;
    }
    const bucket = this.#buckets.get(this.#activeKey);
    return bucket ? Object.freeze([...bucket]) : undefined;
  }
}

/**
 * Creates an in-memory `RepoWorldStateCollector` used by the Cutover-4 repo
 * runtime adapter (Phase 5) and the kernel's `RepoWorldStateObserver`.
 *
 * @param options - Optional capacity tuning.
 * @returns Frozen collector handle.
 */
export function createRepoWorldStateCollector(
  options: CreateRepoWorldStateCollectorOptions = {},
): RepoWorldStateCollector {
  return new InMemoryRepoWorldStateCollector(options);
}

/**
 * Creates a read-only observer over an injected collector. The observer reads
 * `getActiveSlice()` and wraps it as a frozen `RepoWorldState`. When no
 * active turn is set, returns `undefined` (the kernel's per-family repo
 * predicates then report `repo.slice_absent`).
 *
 * @param collector - Append-only collector written by the runtime adapter.
 * @returns Observer that maps the collector into `RepoWorldState`.
 */
export function createRepoWorldStateObserver(
  collector: RepoWorldStateCollector,
): RepoWorldStateObserver {
  return Object.freeze({
    observe(): RepoWorldState | undefined {
      const records = collector.getActiveSlice();
      return records === undefined ? undefined : Object.freeze({ records });
    },
  });
}

let processCollector: RepoWorldStateCollector | undefined;

/**
 * Returns the lazily-initialized process-scoped `RepoWorldStateCollector`.
 * The Phase 5 runtime adapter writes to this collector; the kernel observer
 * reads from it. Tests can inject a fixture instance via
 * `setProcessRepoWorldStateCollectorForTests`.
 *
 * @returns Singleton collector shared across the running process.
 */
export function getProcessRepoWorldStateCollector(): RepoWorldStateCollector {
  if (!processCollector) {
    processCollector = createRepoWorldStateCollector();
  }
  return processCollector;
}

/**
 * Replaces the process collector; intended for tests that need a
 * deterministic instance distinct from the singleton lifecycle.
 *
 * @param collector - Replacement collector, or `undefined` to reset.
 */
export function setProcessRepoWorldStateCollectorForTests(
  collector: RepoWorldStateCollector | undefined,
): void {
  processCollector = collector;
}
