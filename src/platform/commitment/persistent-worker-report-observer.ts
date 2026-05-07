import type { ChannelId, ISO8601, SessionId } from "./ids.js";
import type { IdentityId } from "../identity/identity-id.js";
import type {
  PersistentWorkerReportCollector as RuntimePersistentWorkerReportCollector,
  PersistentWorkerReportTurnKey as RuntimePersistentWorkerReportTurnKey,
  DeliveredWorkerReportRecordInput,
} from "../persistent-worker/persistent-worker-push-runtime-adapter.js";
import {
  deliveredWorkerReportRecordSchema,
  failedWorkerReportRecordSchema,
  type DeliveredWorkerReportRecord,
  type FailedWorkerReportRecord,
  type PersistentWorkerReportsSlice,
} from "./world-state.js";

/**
 * Bug F (persistent-worker subsequent push) Phase 5 — `PersistentWorkerReportObserver` + collector.
 *
 * Sibling of `scheduled-reminder-world-state-observer.ts` (Cron/Scheduler P3) +
 * `repo-world-state-observer.ts` (Cutover-4 P3) + `delivery-receipt-registry.ts`.
 * The collector is the WRITE side of the Phase 5
 * `WorldStateSnapshot.persistentWorkerReports` slice; the observer is the READ
 * side consumed by the kernel runtime via `createDefaultMonitoredRuntime` in
 * `production-runtime-defaults.ts`.
 *
 * Per-(sessionId, turnId) keying. `perTurnLimit = 2` — daily push is rare
 * cross-turn (sub-plan §3.2 last-writer-wins on `workerRunId`); the cap
 * guards against a single classifier turn spraying multiple events.
 *
 * Boundary discipline:
 * - Lives in `src/platform/commitment/`, sibling of the artifact / repo /
 *   reminder / scheduled-reminder observers — additive frozen-layer
 *   extension only (cutover-3 / cutover-4 / slice K precedent; sub-plan
 *   §1 / §6).
 * - Validates records via `deliveredWorkerReportRecordSchema` /
 *   `failedWorkerReportRecordSchema` (Zod) before appending — observer
 *   reads stay total even if a malformed record reaches `record(...)`.
 * - Implements the forward-declared `PersistentWorkerReportCollector`
 *   interface from the Phase 4 runtime adapter — the same singleton
 *   handle is wired into both the cron-fire callback (writer) and the
 *   monitored runtime (reader) so the dispatch+done-predicate edge sees
 *   identical state.
 * - The collector is process-scoped (singleton) for production wiring;
 *   `setProcessPersistentWorkerReportCollectorForTests` injects a fixture
 *   instance so tests can pin determinism.
 */

export type PersistentWorkerReportTurnKey = {
  readonly sessionId: SessionId;
  readonly turnId: string;
};

const DEFAULT_PER_TURN_LIMIT = 2;

export type FailedWorkerReportRecordInput = {
  readonly workerRunId: string;
  readonly ownerIdentityId: IdentityId;
  readonly channel: ChannelId;
  readonly to: string;
  readonly status: "failed";
  readonly recordedAt: string;
  readonly reason: string;
};

export interface PersistentWorkerReportCollector
  extends RuntimePersistentWorkerReportCollector {
  /**
   * Appends a `pushed` worker-report record to the bucket for
   * `(sessionId, turnId)`. Records with the same `workerRunId` for the
   * same key dedupe last-writer-wins (the previous entry — `delivered`
   * OR `failed` — is removed before the new one is appended). Beyond
   * `perTurnLimit` (default 2), the oldest entry is dropped from the
   * appropriate bucket. Malformed records (missing fields, malformed
   * ISO-8601, unbranded identity) throw — invalid data is never
   * persisted into the WorldState.
   *
   * The Phase 4 runtime adapter is the only writer in production for the
   * `delivered` shape; the Phase 5 cron-fire callback is the only writer
   * for the `failed` shape (when adapter returns `kind:'fail'`).
   */
  record(
    record: DeliveredWorkerReportRecordInput,
    key: RuntimePersistentWorkerReportTurnKey,
  ): void;

  /**
   * Appends a `failed` worker-report record. Used by the Phase 5
   * cron-fire callback to surface a structural absence-of-delivery
   * (sub-plan §3.2) so the done-predicate can decide on observed state
   * rather than silently leaving the slice empty.
   */
  recordFailure(
    record: FailedWorkerReportRecordInput,
    key: PersistentWorkerReportTurnKey,
  ): void;

  /**
   * Returns `true` if a `pushed` record for `workerRunId` is present in
   * any active turn bucket. The Phase 4 adapter calls this BEFORE
   * dispatch as the second belt-and-braces idempotency line (the Phase
   * 5 callback's `subsequentPushStatus='pushed'` is the upstream guard).
   */
  has(workerRunId: string): boolean;

  /**
   * Drops every record bucketed under `(sessionId, turnId)`. Called by
   * the cron-fire callback at turn-start to enforce per-turn isolation.
   */
  clear(key: PersistentWorkerReportTurnKey): void;

  /**
   * Marks the bucket the observer should expose via `observe()`. Production
   * callers (Phase 5 cron-fire callback) set this once per turn; tests
   * pin a fixture key explicitly. `undefined` clears the active pointer
   * so `observe()` returns `undefined` (slice is absent).
   */
  setActiveTurn(key: PersistentWorkerReportTurnKey | undefined): void;

  /**
   * Returns a frozen snapshot of the records bucketed under `key`,
   * grouped by status. Returns `undefined` when the bucket has never
   * been written. Test harnesses use this to inspect collector state
   * without going through `observe()` / the active-turn pointer.
   */
  freezeSnapshot(
    key: PersistentWorkerReportTurnKey,
  ): PersistentWorkerReportsSlice | undefined;
}

export interface PersistentWorkerReportObserver {
  /**
   * Reads a deterministic `PersistentWorkerReportsSlice` snapshot for the
   * currently-active turn. Returns `undefined` when the kernel runs
   * through a turn that produced no persistent-worker push — the
   * predicate sees `persistent_worker_reports.slice_absent` rather than
   * an empty `delivered` / `failed` list (slice E precedent; sub-plan
   * §3.1).
   */
  observe(): PersistentWorkerReportsSlice | undefined;
}

export type CreatePersistentWorkerReportCollectorOptions = {
  /**
   * Soft cap on the number of records retained per `(sessionId, turnId)`,
   * counted across `delivered` + `failed` combined. Older records are
   * dropped from the head of the appropriate bucket when exceeded.
   * Defaults to 2 (sub-plan §3.2 — daily push cross-turn is rare).
   */
  readonly perTurnLimit?: number;
};

function bucketKey(key: PersistentWorkerReportTurnKey): string {
  return `${key.sessionId} ${key.turnId}`;
}

type Bucket = {
  delivered: DeliveredWorkerReportRecord[];
  failed: FailedWorkerReportRecord[];
};

class InMemoryPersistentWorkerReportCollector
  implements PersistentWorkerReportCollector
{
  readonly #buckets = new Map<string, Bucket>();
  readonly #perTurnLimit: number;
  #activeKey: string | undefined;

  constructor(options: CreatePersistentWorkerReportCollectorOptions) {
    this.#perTurnLimit = Math.max(
      1,
      options.perTurnLimit ?? DEFAULT_PER_TURN_LIMIT,
    );
  }

  record(
    record: DeliveredWorkerReportRecordInput,
    key: PersistentWorkerReportTurnKey,
  ): void {
    // The runtime adapter passes `DeliveredWorkerReportRecordInput` which
    // carries `completedAt` and a required `messageId`; the WorldState
    // shape only needs the structural identity / channel fields. Project
    // the input down to the slice shape, validate via Zod, and persist.
    const slim = {
      workerRunId: record.workerRunId,
      ownerIdentityId: record.ownerIdentityId,
      channel: record.channel,
      to: record.to,
      status: "pushed" as const,
      recordedAt: record.recordedAt,
      messageId: record.messageId,
    };
    const parsed = deliveredWorkerReportRecordSchema.parse(
      slim,
    ) as DeliveredWorkerReportRecord;
    this.#appendDelivered(key, parsed);
  }

  recordFailure(
    record: FailedWorkerReportRecordInput,
    key: PersistentWorkerReportTurnKey,
  ): void {
    const slim = {
      workerRunId: record.workerRunId,
      ownerIdentityId: record.ownerIdentityId,
      channel: record.channel,
      to: record.to,
      status: "failed" as const,
      recordedAt: record.recordedAt,
      reason: record.reason,
    };
    const parsed = failedWorkerReportRecordSchema.parse(
      slim,
    ) as FailedWorkerReportRecord;
    this.#appendFailed(key, parsed);
  }

  has(workerRunId: string): boolean {
    if (typeof workerRunId !== "string" || workerRunId.length === 0) {
      return false;
    }
    for (const bucket of this.#buckets.values()) {
      for (const entry of bucket.delivered) {
        if (entry.workerRunId === workerRunId) {
          return true;
        }
      }
    }
    return false;
  }

  clear(key: PersistentWorkerReportTurnKey): void {
    this.#buckets.delete(bucketKey(key));
  }

  setActiveTurn(key: PersistentWorkerReportTurnKey | undefined): void {
    this.#activeKey = key === undefined ? undefined : bucketKey(key);
  }

  freezeSnapshot(
    key: PersistentWorkerReportTurnKey,
  ): PersistentWorkerReportsSlice | undefined {
    const bucket = this.#buckets.get(bucketKey(key));
    if (!bucket) {
      return undefined;
    }
    return Object.freeze({
      delivered: Object.freeze([...bucket.delivered]),
      failed: Object.freeze([...bucket.failed]),
    });
  }

  /** @internal — used by the observer to honor the active-turn pointer. */
  getActiveSlice(): PersistentWorkerReportsSlice | undefined {
    if (this.#activeKey === undefined) {
      return undefined;
    }
    const bucket = this.#buckets.get(this.#activeKey);
    if (!bucket) {
      return undefined;
    }
    return Object.freeze({
      delivered: Object.freeze([...bucket.delivered]),
      failed: Object.freeze([...bucket.failed]),
    });
  }

  #ensureBucket(bk: string): Bucket {
    let bucket = this.#buckets.get(bk);
    if (!bucket) {
      bucket = { delivered: [], failed: [] };
      this.#buckets.set(bk, bucket);
    }
    return bucket;
  }

  #removeFromBoth(bucket: Bucket, workerRunId: string): void {
    bucket.delivered = bucket.delivered.filter(
      (entry) => entry.workerRunId !== workerRunId,
    );
    bucket.failed = bucket.failed.filter(
      (entry) => entry.workerRunId !== workerRunId,
    );
  }

  #appendDelivered(
    key: PersistentWorkerReportTurnKey,
    record: DeliveredWorkerReportRecord,
  ): void {
    const bk = bucketKey(key);
    const bucket = this.#ensureBucket(bk);
    this.#removeFromBoth(bucket, record.workerRunId);
    bucket.delivered.push(Object.freeze({ ...record }));
    this.#trim(bucket);
  }

  #appendFailed(
    key: PersistentWorkerReportTurnKey,
    record: FailedWorkerReportRecord,
  ): void {
    const bk = bucketKey(key);
    const bucket = this.#ensureBucket(bk);
    this.#removeFromBoth(bucket, record.workerRunId);
    bucket.failed.push(Object.freeze({ ...record }));
    this.#trim(bucket);
  }

  #trim(bucket: Bucket): void {
    // Trim by total count across both arrays — drop oldest from whichever
    // array has more entries, oldest-first within that array.
    while (bucket.delivered.length + bucket.failed.length > this.#perTurnLimit) {
      if (bucket.delivered.length >= bucket.failed.length) {
        bucket.delivered.shift();
      } else {
        bucket.failed.shift();
      }
    }
  }
}

/**
 * Creates an in-memory `PersistentWorkerReportCollector` used by the
 * Bug F Phase 4 runtime adapter (success path) + Phase 5 cron-fire
 * callback (failure path), and read by the kernel's
 * `PersistentWorkerReportObserver`.
 */
export function createPersistentWorkerReportCollector(
  options: CreatePersistentWorkerReportCollectorOptions = {},
): PersistentWorkerReportCollector {
  return new InMemoryPersistentWorkerReportCollector(options);
}

/**
 * Creates a read-only observer over an injected collector. The observer
 * reads `getActiveSlice()` and returns the frozen slice unchanged. When
 * no active turn is set, returns `undefined` (the kernel's per-family
 * predicate then reports `persistent_worker_reports.slice_absent`).
 */
export function createPersistentWorkerReportObserver(
  collector: PersistentWorkerReportCollector,
): PersistentWorkerReportObserver {
  return Object.freeze({
    observe(): PersistentWorkerReportsSlice | undefined {
      // Only the in-memory impl exposes `getActiveSlice()`. Other
      // implementations may not — defensively narrow.
      const inMemory = collector as InMemoryPersistentWorkerReportCollector;
      if (typeof inMemory.getActiveSlice !== "function") {
        return undefined;
      }
      return inMemory.getActiveSlice();
    },
  });
}

let processCollector: PersistentWorkerReportCollector | undefined;

/**
 * Returns the lazily-initialized process-scoped
 * `PersistentWorkerReportCollector`. The Phase 4 runtime adapter writes
 * to this collector (success path) AND the Phase 5 cron-fire callback
 * writes to it (failure path); the kernel observer reads from it.
 * Tests can inject a fixture instance via
 * `setProcessPersistentWorkerReportCollectorForTests`.
 */
export function getProcessPersistentWorkerReportCollector(): PersistentWorkerReportCollector {
  if (!processCollector) {
    processCollector = createPersistentWorkerReportCollector();
  }
  return processCollector;
}

/**
 * Replaces the process collector; intended for tests that need a
 * deterministic instance distinct from the singleton lifecycle.
 *
 * @param collector - Replacement collector, or `undefined` to reset.
 */
export function setProcessPersistentWorkerReportCollectorForTests(
  collector: PersistentWorkerReportCollector | undefined,
): void {
  processCollector = collector;
}

/**
 * Re-export of the underlying record types so callers that import the
 * observer module surface the WorldState slice shape without an extra
 * import dance against `world-state.ts`.
 */
export type {
  DeliveredWorkerReportRecord,
  FailedWorkerReportRecord,
  PersistentWorkerReportsSlice,
} from "./world-state.js";

// Suppress unused-import lint noise — these brand types are referenced
// only by the public collector interface signature above.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _Refs = ChannelId | ISO8601;
