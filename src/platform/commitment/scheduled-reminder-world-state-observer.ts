import type { SessionId } from "./ids.js";
import {
  scheduledReminderRecordSchema,
  type ScheduledReminderRecord,
  type ScheduledRemindersSlice,
} from "./world-state.js";

/**
 * Cron/Scheduler Phase 3 — `ScheduledReminderWorldStateObserver` + collector.
 *
 * Sibling of `repo-world-state-observer.ts` (Cutover-4 P3) and
 * `artifact-world-state-observer.ts` (Cutover-3 P3). The collector is the
 * WRITE side of the Phase 3 `WorldStateSnapshot.scheduledReminders` slice;
 * the observer is the READ side consumed by the kernel runtime via
 * `createDefaultMonitoredRuntime` in `production-runtime-defaults.ts`.
 *
 * Per-(sessionId, turnId) keying. `perTurnLimit = 4` — sub-plan §1 todo
 * Phase 3 (cron-scheduler reminders are batched at most a few per turn;
 * the cap prevents a single classifier turn from spraying schedules).
 * Last-writer-wins on `reminderId` (the runtime adapter mints a fresh id
 * per `RecordReminderTool` invocation; if the same id collides within a
 * turn — e.g. caller passed a stable id — the new record replaces the
 * old one).
 *
 * Boundary discipline:
 * - Lives in `src/platform/commitment/`, sibling of the artifact / repo /
 *   reminder observers — additive frozen-layer extension only (cutover-3 /
 *   cutover-4 / slice K precedent; sub-plan §1 / §6).
 * - Validates records via `scheduledReminderRecordSchema` (Zod) before
 *   appending — observer reads stay total even if a malformed record
 *   reaches `record(...)` (defense in depth).
 * - The collector is process-scoped (singleton) for production wiring;
 *   `setProcessScheduledReminderWorldStateCollectorForTests` injects a
 *   fixture instance so tests can pin determinism.
 */

export type ScheduledReminderTurnKey = {
  readonly sessionId: SessionId;
  readonly turnId: string;
};

const DEFAULT_PER_TURN_LIMIT = 4;

export interface ScheduledReminderWorldStateCollector {
  /**
   * Appends a scheduled-reminder record to the bucket for `(sessionId,
   * turnId)`. Records with the same `reminderId` for the same key dedupe
   * last-writer-wins (the previous entry is removed before the new one is
   * appended). Beyond `perTurnLimit` (default 4), the oldest entry is
   * dropped. Malformed records (missing fields, malformed ISO-8601,
   * unbranded identity, content over the length cap, unknown status)
   * throw — invalid data is never persisted into the WorldState.
   *
   * @param record - Scheduled-reminder record produced by the Phase 5
   *   runtime adapter.
   * @param key - Turn-scoped bucket key.
   */
  record(record: ScheduledReminderRecord, key: ScheduledReminderTurnKey): void;

  /**
   * Drops every record bucketed under `(sessionId, turnId)`. Called by the
   * runtime adapter at turn-start to enforce per-turn isolation.
   *
   * @param key - Turn-scoped bucket key to clear.
   */
  resetForTurn(key: ScheduledReminderTurnKey): void;

  /**
   * Marks the bucket the observer should expose via `observe()`. Production
   * callers (Phase 5 runtime adapter) set this once per turn; tests pin a
   * fixture key explicitly. `undefined` clears the active pointer so
   * `observe()` returns `undefined` (the WorldState slice is absent — the
   * default state when no reminder-set tool has run on this turn).
   *
   * @param key - Turn key to expose, or `undefined` to clear.
   */
  setActiveTurn(key: ScheduledReminderTurnKey | undefined): void;

  /**
   * Returns the records bucketed under the currently-active turn, oldest
   * first. Returns `undefined` when no active turn is set or when the
   * active turn's bucket has never been written.
   *
   * @returns Frozen list of records for the active turn, or `undefined`.
   */
  getActiveSlice(): readonly ScheduledReminderRecord[] | undefined;
}

export interface ScheduledReminderWorldStateObserver {
  /**
   * Reads a deterministic `ScheduledRemindersSlice` snapshot for the
   * currently-active turn. Returns `undefined` when the kernel runs through
   * a turn that produced no reminder-set invocation — the predicate sees
   * `scheduled_reminders.slice_absent` rather than an empty `records`
   * list (slice E precedent / Cutover-3 / Cutover-4 / Slice K).
   *
   * @returns Frozen `ScheduledRemindersSlice` derived from the collector,
   *   or `undefined` when no active turn is set.
   */
  observe(): ScheduledRemindersSlice | undefined;
}

export type CreateScheduledReminderWorldStateCollectorOptions = {
  /**
   * Soft cap on the number of records retained per `(sessionId, turnId)`.
   * Older records are dropped from the head when exceeded. Defaults to 4
   * (sub-plan §1 todo Phase 3).
   */
  readonly perTurnLimit?: number;
};

function bucketKey(key: ScheduledReminderTurnKey): string {
  return `${key.sessionId} ${key.turnId}`;
}

class InMemoryScheduledReminderWorldStateCollector
  implements ScheduledReminderWorldStateCollector
{
  readonly #buckets = new Map<string, ScheduledReminderRecord[]>();
  readonly #perTurnLimit: number;
  #activeKey: string | undefined;

  constructor(options: CreateScheduledReminderWorldStateCollectorOptions) {
    this.#perTurnLimit = Math.max(1, options.perTurnLimit ?? DEFAULT_PER_TURN_LIMIT);
  }

  record(record: ScheduledReminderRecord, key: ScheduledReminderTurnKey): void {
    // Validate via Zod; throws on missing fields / malformed timestamp /
    // unbranded identity / oversize content / unknown status. The runtime
    // adapter (Phase 5) is the only writer in production; tests exercise
    // the rejection path explicitly.
    const parsed = scheduledReminderRecordSchema.parse(
      record,
    ) as ScheduledReminderRecord;
    const bk = bucketKey(key);
    const bucket = this.#buckets.get(bk) ?? [];
    const filtered = bucket.filter(
      (entry) => entry.reminderId !== parsed.reminderId,
    );
    filtered.push(Object.freeze({ ...parsed }));
    while (filtered.length > this.#perTurnLimit) {
      filtered.shift();
    }
    this.#buckets.set(bk, filtered);
  }

  resetForTurn(key: ScheduledReminderTurnKey): void {
    this.#buckets.delete(bucketKey(key));
  }

  setActiveTurn(key: ScheduledReminderTurnKey | undefined): void {
    this.#activeKey = key === undefined ? undefined : bucketKey(key);
  }

  getActiveSlice(): readonly ScheduledReminderRecord[] | undefined {
    if (this.#activeKey === undefined) {
      return undefined;
    }
    const bucket = this.#buckets.get(this.#activeKey);
    return bucket ? Object.freeze([...bucket]) : undefined;
  }
}

/**
 * Creates an in-memory `ScheduledReminderWorldStateCollector` used by the
 * Cron/Scheduler Phase 5 runtime adapter and the kernel's
 * `ScheduledReminderWorldStateObserver`.
 *
 * @param options - Optional capacity tuning.
 * @returns Frozen collector handle.
 */
export function createScheduledReminderWorldStateCollector(
  options: CreateScheduledReminderWorldStateCollectorOptions = {},
): ScheduledReminderWorldStateCollector {
  return new InMemoryScheduledReminderWorldStateCollector(options);
}

/**
 * Creates a read-only observer over an injected collector. The observer
 * reads `getActiveSlice()` and wraps it as a frozen
 * `ScheduledRemindersSlice`. When no active turn is set, returns
 * `undefined` (the kernel's per-family reminder-set predicate then reports
 * `scheduled_reminders.slice_absent`).
 *
 * @param collector - Append-only collector written by the runtime adapter.
 * @returns Observer that maps the collector into `ScheduledRemindersSlice`.
 */
export function createScheduledReminderWorldStateObserver(
  collector: ScheduledReminderWorldStateCollector,
): ScheduledReminderWorldStateObserver {
  return Object.freeze({
    observe(): ScheduledRemindersSlice | undefined {
      const records = collector.getActiveSlice();
      return records === undefined ? undefined : Object.freeze({ records });
    },
  });
}

let processCollector: ScheduledReminderWorldStateCollector | undefined;

/**
 * Returns the lazily-initialized process-scoped
 * `ScheduledReminderWorldStateCollector`. The Phase 5 runtime adapter
 * writes to this collector; the kernel observer reads from it. Tests can
 * inject a fixture instance via
 * `setProcessScheduledReminderWorldStateCollectorForTests`.
 *
 * @returns Singleton collector shared across the running process.
 */
export function getProcessScheduledReminderWorldStateCollector(): ScheduledReminderWorldStateCollector {
  if (!processCollector) {
    processCollector = createScheduledReminderWorldStateCollector();
  }
  return processCollector;
}

/**
 * Replaces the process collector; intended for tests that need a
 * deterministic instance distinct from the singleton lifecycle.
 *
 * @param collector - Replacement collector, or `undefined` to reset.
 */
export function setProcessScheduledReminderWorldStateCollectorForTests(
  collector: ScheduledReminderWorldStateCollector | undefined,
): void {
  processCollector = collector;
}
