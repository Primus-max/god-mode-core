/**
 * V1-CONTRACT-ONLY S11c — non-kernel persistent-worker report collector.
 *
 * Migrated out of `src/platform/commitment/persistent-worker-report-observer.ts`
 * so the production push-fire bootstrap (`src/server/persistent-worker-push-bootstrap.ts`)
 * can drop its only import from the commitment-kernel surface. The kernel
 * directory is being deleted as part of V1-CUTOVER; the bootstrap is a
 * production-path importer that fires on every gateway boot, so it had to
 * gain a non-kernel home before the directory disappears.
 *
 * Behaviour parity:
 * - Same collector interface (`record`, `recordFailure`, `has`, `clear`,
 *   `setActiveTurn`, `freezeSnapshot`).
 * - Same Zod-validated record shapes — copied verbatim from
 *   `world-state.ts` so the runtime adapter keeps observing identical
 *   validation behaviour.
 * - Same per-`(sessionId, turnId)` keying with `perTurnLimit = 2`.
 * - Same lazy process-scoped singleton accessor with a test-only setter.
 *
 * Boundary discipline:
 * - Lives in `src/platform/persistent-worker/`, alongside the runtime
 *   adapter that already declares the forward-typed interface this
 *   module satisfies. No kernel dependency.
 * - Reads STRUCTURAL inputs only (workerRunId, branded IdentityId,
 *   ISO-8601 recordedAt, branded ChannelId, to, status, reason | messageId)
 *   — never raw user text (#5/#6).
 * - The kernel-side `persistent-worker-report-observer.ts` keeps its own
 *   collector wired into `createDefaultMonitoredRuntime` for the kernel
 *   runtime (which is itself orphan and queued for deletion). The two
 *   collectors are intentionally distinct: the production push-fire
 *   pipeline writes to THIS module's singleton; the kernel pipeline (if
 *   anything still consumes it) writes to its own. There is no shared
 *   state because there is no shared consumer in production.
 */

import { z } from "zod";

import type { ChannelId, ISO8601 } from "../identity/branded-ids.js";
import { isIdentityId, type IdentityId } from "../identity/identity-id.js";
import type {
  PersistentWorkerReportCollector as RuntimePersistentWorkerReportCollector,
  PersistentWorkerReportTurnKey as RuntimePersistentWorkerReportTurnKey,
  DeliveredWorkerReportRecordInput,
} from "./persistent-worker-push-runtime-adapter.js";

// Verbatim copy of `world-state.ts:232` — keeping the regex local so the
// new collector module has zero kernel dependency.
const ISO8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

/** Verbatim copy of the kernel `DeliveredWorkerReportRecord` shape. */
export type DeliveredWorkerReportRecord = {
  readonly workerRunId: string;
  readonly ownerIdentityId: IdentityId;
  readonly channel: ChannelId;
  readonly to: string;
  readonly status: "pushed";
  readonly recordedAt: ISO8601;
  readonly messageId?: string;
};

/** Verbatim copy of the kernel `FailedWorkerReportRecord` shape. */
export type FailedWorkerReportRecord = {
  readonly workerRunId: string;
  readonly ownerIdentityId: IdentityId;
  readonly channel: ChannelId;
  readonly to: string;
  readonly status: "failed";
  readonly recordedAt: ISO8601;
  readonly reason: string;
};

/** Verbatim copy of the kernel `PersistentWorkerReportsSlice` shape. */
export type PersistentWorkerReportsSlice = {
  readonly delivered: readonly DeliveredWorkerReportRecord[];
  readonly failed: readonly FailedWorkerReportRecord[];
};

export type PersistentWorkerReportTurnKey = RuntimePersistentWorkerReportTurnKey;

const DEFAULT_PER_TURN_LIMIT = 2;

/**
 * Shape consumed by the cron-fire callback's `recordFailure(...)` path.
 * Mirrors `FailedWorkerReportRecord` modulo the `recordedAt` brand.
 */
export type FailedWorkerReportRecordInput = {
  readonly workerRunId: string;
  readonly ownerIdentityId: IdentityId;
  readonly channel: ChannelId;
  readonly to: string;
  readonly status: "failed";
  readonly recordedAt: string;
  readonly reason: string;
};

/**
 * Closed-shape Zod schema for `record(...)` inputs. Verbatim copy of
 * `world-state.ts:374`.
 */
export const deliveredWorkerReportRecordSchema = z
  .object({
    workerRunId: z.string().min(1),
    ownerIdentityId: z
      .string()
      .refine((v) => isIdentityId(v), {
        message: "ownerIdentityId must be a branded IdentityId (identity:<slug>)",
      }),
    channel: z.string().min(1),
    to: z.string().min(1),
    status: z.literal("pushed"),
    recordedAt: z.string().regex(ISO8601_PATTERN),
    messageId: z.string().min(1).optional(),
  })
  .strict();

/**
 * Closed-shape Zod schema for `recordFailure(...)` inputs. Verbatim copy
 * of `world-state.ts:401`.
 */
export const failedWorkerReportRecordSchema = z
  .object({
    workerRunId: z.string().min(1),
    ownerIdentityId: z
      .string()
      .refine((v) => isIdentityId(v), {
        message: "ownerIdentityId must be a branded IdentityId (identity:<slug>)",
      }),
    channel: z.string().min(1),
    to: z.string().min(1),
    status: z.literal("failed"),
    recordedAt: z.string().regex(ISO8601_PATTERN),
    reason: z.string().min(1),
  })
  .strict();

/**
 * Wider collector interface used by the cron-fire callback. Extends the
 * runtime adapter's narrower `record(...) + has(...)` contract with the
 * failure-path / lifecycle methods the callback owns.
 */
export interface PersistentWorkerReportCollector
  extends RuntimePersistentWorkerReportCollector {
  /**
   * Appends a `pushed` worker-report record to the bucket for
   * `(sessionId, turnId)`. Records with the same `workerRunId` for the
   * same key dedupe last-writer-wins (the previous entry — `delivered`
   * OR `failed` — is removed before the new one is appended). Beyond
   * `perTurnLimit` (default 2), the oldest entry is dropped from the
   * appropriate bucket. Malformed records throw.
   */
  record(
    record: DeliveredWorkerReportRecordInput,
    key: RuntimePersistentWorkerReportTurnKey,
  ): void;

  /**
   * Appends a `failed` worker-report record. Used by the cron-fire
   * callback when the runtime adapter returns `kind:'fail'`.
   */
  recordFailure(
    record: FailedWorkerReportRecordInput,
    key: PersistentWorkerReportTurnKey,
  ): void;

  /**
   * Returns `true` if a `pushed` record for `workerRunId` is present in
   * any active turn bucket. Used by the runtime adapter as the second
   * belt-and-braces idempotency line.
   */
  has(workerRunId: string): boolean;

  /** Drops every record bucketed under `(sessionId, turnId)`. */
  clear(key: PersistentWorkerReportTurnKey): void;

  /**
   * Marks the bucket the observer should expose via `freezeSnapshot()`
   * with a `undefined` argument. Production pins this once per turn;
   * tests pin a fixture key explicitly. `undefined` clears the active
   * pointer.
   */
  setActiveTurn(key: PersistentWorkerReportTurnKey | undefined): void;

  /**
   * Returns a frozen snapshot of the records bucketed under `key`,
   * grouped by status. Returns `undefined` when the bucket has never
   * been written.
   */
  freezeSnapshot(
    key: PersistentWorkerReportTurnKey,
  ): PersistentWorkerReportsSlice | undefined;
}

export type CreatePersistentWorkerReportCollectorOptions = {
  /**
   * Soft cap on the number of records retained per `(sessionId, turnId)`,
   * counted across `delivered` + `failed` combined. Defaults to 2.
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

  /**
   * @internal — exposed so a future read-side (if needed) can honor the
   * active-turn pointer without having to re-derive `freezeSnapshot`.
   */
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
 * Creates a fresh in-memory `PersistentWorkerReportCollector`. Production
 * uses the lazy singleton accessor below; tests inject a fresh instance
 * for determinism.
 */
export function createPersistentWorkerReportCollector(
  options: CreatePersistentWorkerReportCollectorOptions = {},
): PersistentWorkerReportCollector {
  return new InMemoryPersistentWorkerReportCollector(options);
}

let processCollector: PersistentWorkerReportCollector | undefined;

/**
 * Returns the lazily-initialized process-scoped collector consumed by the
 * persistent-worker push-fire bootstrap and the runtime adapter. The
 * accessor is idempotent (returns the same instance on every call) so
 * the bootstrap can resolve eagerly at bind time without leaking new
 * instances on subsequent reads.
 */
export function getProcessPersistentWorkerReportCollector(): PersistentWorkerReportCollector {
  if (!processCollector) {
    processCollector = createPersistentWorkerReportCollector();
  }
  return processCollector;
}

/**
 * Test-only override of the process-scoped collector. Production never
 * calls this; tests pin a deterministic instance so assertions can
 * inspect bucket state directly.
 *
 * @param collector - Replacement collector, or `undefined` to reset to
 * lazy-init on next read.
 */
export function setProcessPersistentWorkerReportCollectorForTests(
  collector: PersistentWorkerReportCollector | undefined,
): void {
  processCollector = collector;
}
