import type { SessionId } from "./ids.js";
import {
  reminderQueryRecordSchema,
  type ReminderQueryRecord,
  type ReminderWorldState,
} from "./world-state.js";

/**
 * Slice K Phase 4 — `ReminderWorldStateObserver` + collector.
 *
 * Sibling of `repo-world-state-observer.ts` (Cutover-4 P3) and
 * `artifact-world-state-observer.ts` (Cutover-3 P3). The collector is
 * the WRITE side of the Phase 4 `WorldStateSnapshot.reminder` slice;
 * the observer is the READ side consumed by the kernel runtime via
 * `createMonitoredRuntime` in `production-runtime-defaults.ts`.
 *
 * Per-(sessionId, turnId) keying. `perTurnLimit = 1` — the reminder
 * surface is single-shot per turn (sub-plan §1 todo Phase 4).
 * Last-writer-wins on `queryId` (the runtime adapter mints a fresh id
 * per `RecallReminderTool` invocation; if the same id collides
 * within a turn — e.g. caller passed a stable id — the new record
 * replaces the old one).
 *
 * Boundary discipline:
 * - Lives in `src/platform/commitment/`, sibling of the artifact / repo
 *   observers — additive frozen-layer extension only (cutover-3 / cutover-4
 *   precedent; sub-plan §1 / §6).
 * - Validates records via `reminderQueryRecordSchema` (Zod) before
 *   appending — observer reads stay total even if a malformed record
 *   reaches `record(...)` (defense in depth).
 * - The collector is process-scoped (singleton) for production wiring;
 *   `setProcessReminderWorldStateCollectorForTests` injects a fixture
 *   instance so tests can pin determinism.
 */

export type ReminderTurnKey = {
  readonly sessionId: SessionId;
  readonly turnId: string;
};

const DEFAULT_PER_TURN_LIMIT = 1;

export interface ReminderWorldStateCollector {
  /**
   * Records a reminder-query record under `(sessionId, turnId)`. Last-
   * writer-wins on `queryId` — when a record with the same `queryId`
   * already exists for the key, the previous entry is replaced. Beyond
   * `perTurnLimit` (default 1), the oldest entry is dropped.
   *
   * Malformed records (missing fields, malformed ISO-8601, negative
   * `resultCount`) throw — invalid data is never persisted into the
   * WorldState.
   *
   * @param record - Reminder-query record produced by the Phase 4 runtime adapter.
   * @param key - Turn-scoped bucket key.
   */
  record(record: ReminderQueryRecord, key: ReminderTurnKey): void;

  /**
   * Drops every record bucketed under `(sessionId, turnId)`. Called by
   * the runtime adapter at turn-start to enforce per-turn isolation.
   *
   * @param key - Turn-scoped bucket key to clear.
   */
  resetForTurn(key: ReminderTurnKey): void;

  /**
   * Marks the bucket the observer should expose via `observe()`.
   * Production callers (Phase 4 runtime adapter) set this once per
   * turn; tests pin a fixture key explicitly. `undefined` clears the
   * active pointer so `observe()` returns `undefined` (the WorldState
   * slice is absent — the default state when no reminder query has run
   * on this turn).
   *
   * @param key - Turn key to expose, or `undefined` to clear.
   */
  setActiveTurn(key: ReminderTurnKey | undefined): void;

  /**
   * Returns the most-recent reminder query bucketed under the
   * currently-active turn. Returns `undefined` when no active turn is
   * set or when the active turn's bucket is empty. The reminder
   * surface stores a SINGLE record per turn (perTurnLimit = 1) so this
   * accessor returns at most one record.
   *
   * @returns Frozen `ReminderQueryRecord` for the active turn, or
   *   `undefined`.
   */
  getActiveLastQuery(): ReminderQueryRecord | undefined;

  /**
   * Test-only convenience: read the most-recent record for an
   * arbitrary `(sessionId, turnId)` without flipping the active
   * pointer. Production callers MUST go through `setActiveTurn` +
   * `getActiveLastQuery`; this surface exists so tests can assert
   * sessionId-isolation reverse cases without leaking the active
   * pointer between test cases.
   *
   * @param key - Turn-scoped bucket key.
   * @returns Frozen `ReminderQueryRecord` for the bucket, or `undefined`.
   */
  getLastQueryForTurn(key: ReminderTurnKey): ReminderQueryRecord | undefined;
}

export interface ReminderWorldStateObserver {
  /**
   * Reads a deterministic `ReminderWorldState` snapshot for the
   * currently-active turn. Returns `undefined` when the kernel runs
   * through a turn that produced no reminder query — the predicate
   * sees `reminder.slice_absent` rather than a slice with `lastQuery
   * === undefined` (slice E precedent / Cutover-3 / Cutover-4).
   *
   * @returns Frozen `ReminderWorldState` derived from the collector,
   *   or `undefined` when no active turn is set.
   */
  observe(): ReminderWorldState | undefined;
}

export type CreateReminderWorldStateCollectorOptions = {
  /**
   * Soft cap on the number of records retained per `(sessionId,
   * turnId)`. Defaults to 1 (sub-plan §1 todo Phase 4 — reminder is
   * single-shot per turn). Larger caps are accepted at the type layer
   * for forward compat (e.g. a future "scrolling reminder" surface),
   * but the production singleton uses the default.
   */
  readonly perTurnLimit?: number;
};

function bucketKey(key: ReminderTurnKey): string {
  return `${key.sessionId} ${key.turnId}`;
}

class InMemoryReminderWorldStateCollector implements ReminderWorldStateCollector {
  readonly #buckets = new Map<string, ReminderQueryRecord[]>();
  readonly #perTurnLimit: number;
  #activeKey: string | undefined;

  constructor(options: CreateReminderWorldStateCollectorOptions) {
    this.#perTurnLimit = Math.max(1, options.perTurnLimit ?? DEFAULT_PER_TURN_LIMIT);
  }

  record(record: ReminderQueryRecord, key: ReminderTurnKey): void {
    // Validate via Zod; throws on missing fields / malformed timestamp /
    // negative resultCount. The runtime adapter (Phase 4) is the only
    // writer in production; tests exercise the rejection path explicitly.
    const parsed = reminderQueryRecordSchema.parse(record) as ReminderQueryRecord;
    const bk = bucketKey(key);
    const bucket = this.#buckets.get(bk) ?? [];
    // Last-writer-wins on queryId: drop any prior entry sharing the
    // queryId before appending the new record. With perTurnLimit=1 in
    // production this is largely defensive — but it keeps the
    // semantics deterministic when a future caller bumps the limit.
    const filtered = bucket.filter((entry) => entry.queryId !== parsed.queryId);
    filtered.push(Object.freeze({ ...parsed }));
    while (filtered.length > this.#perTurnLimit) {
      filtered.shift();
    }
    this.#buckets.set(bk, filtered);
  }

  resetForTurn(key: ReminderTurnKey): void {
    this.#buckets.delete(bucketKey(key));
  }

  setActiveTurn(key: ReminderTurnKey | undefined): void {
    this.#activeKey = key === undefined ? undefined : bucketKey(key);
  }

  getActiveLastQuery(): ReminderQueryRecord | undefined {
    if (this.#activeKey === undefined) {
      return undefined;
    }
    const bucket = this.#buckets.get(this.#activeKey);
    if (!bucket || bucket.length === 0) {
      return undefined;
    }
    return bucket[bucket.length - 1];
  }

  getLastQueryForTurn(key: ReminderTurnKey): ReminderQueryRecord | undefined {
    const bucket = this.#buckets.get(bucketKey(key));
    if (!bucket || bucket.length === 0) {
      return undefined;
    }
    return bucket[bucket.length - 1];
  }
}

/**
 * Creates an in-memory `ReminderWorldStateCollector` used by the slice K
 * Phase 4 reminder runtime adapter and the kernel's
 * `ReminderWorldStateObserver`.
 *
 * @param options - Optional capacity tuning.
 * @returns Frozen collector handle.
 */
export function createReminderWorldStateCollector(
  options: CreateReminderWorldStateCollectorOptions = {},
): ReminderWorldStateCollector {
  return new InMemoryReminderWorldStateCollector(options);
}

/**
 * Creates a read-only observer over an injected collector. The observer
 * reads `getActiveLastQuery()` and wraps it as a frozen
 * `ReminderWorldState`. When no active turn is set, returns `undefined`
 * (the kernel's reminder predicate then reports `reminder.slice_absent`).
 *
 * @param collector - Append-only collector written by the runtime adapter.
 * @returns Observer that maps the collector into `ReminderWorldState`.
 */
export function createReminderWorldStateObserver(
  collector: ReminderWorldStateCollector,
): ReminderWorldStateObserver {
  return Object.freeze({
    observe(): ReminderWorldState | undefined {
      const lastQuery = collector.getActiveLastQuery();
      if (lastQuery === undefined) {
        return undefined;
      }
      return Object.freeze({ lastQuery });
    },
  });
}

let processCollector: ReminderWorldStateCollector | undefined;

/**
 * Returns the lazily-initialized process-scoped
 * `ReminderWorldStateCollector`. The Phase 4 runtime adapter writes to
 * this collector; the kernel observer reads from it. Tests can inject
 * a fixture instance via `setProcessReminderWorldStateCollectorForTests`.
 *
 * @returns Singleton collector shared across the running process.
 */
export function getProcessReminderWorldStateCollector(): ReminderWorldStateCollector {
  if (!processCollector) {
    processCollector = createReminderWorldStateCollector();
  }
  return processCollector;
}

/**
 * Replaces the process collector; intended for tests that need a
 * deterministic instance distinct from the singleton lifecycle.
 *
 * @param collector - Replacement collector, or `undefined` to reset.
 */
export function setProcessReminderWorldStateCollectorForTests(
  collector: ReminderWorldStateCollector | undefined,
): void {
  processCollector = collector;
}
