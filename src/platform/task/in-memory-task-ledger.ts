import type { IdentityId } from "../identity/identity-id.js";

import { asTaskId, type TaskId } from "./task-id.js";
import type { TaskLedger, TaskNotFound } from "./task-ledger.js";
import {
  TaskCreateInputSchema,
  TaskListQuerySchema,
  TaskUpdatePatchSchema,
  isTaskTerminalStatus,
  isTaskTransitionAllowed,
  type TaskCreateInput,
  type TaskListQuery,
  type TaskListResult,
  type TaskRecord,
  type TaskStatus,
  type TaskUpdatePatch,
} from "./task-record.js";

/**
 * Default cap for `list` when the caller does not supply an explicit
 * `limit`. Mirrors `InMemoryMemoryStore`'s `DEFAULT_LIMIT` (slice E
 * PR-#156) so early integration tests behave consistently across the
 * memory and task surfaces.
 */
const DEFAULT_LIMIT = 50;

/**
 * Logger seam used for idempotent-warn paths (`cancel` on already-
 * cancelled / `complete` on already-completed). Decoupled from the
 * project logger so tests can inject a capturing stub without pulling
 * logging infrastructure in. Mirrors slice E's
 * `LlmExtractorMemoryStoreLogger` shape (PR-#170).
 */
export type InMemoryTaskLedgerLogger = {
  warn(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
};

const NO_OP_LOGGER: InMemoryTaskLedgerLogger = {
  warn() {
    /* swallow — production callers should inject a real logger */
  },
  debug() {
    /* swallow */
  },
};

/**
 * Construction options. All optional — a `new InMemoryTaskLedger()` is
 * a fully-functional instance for tests / fixture-mode callers.
 *
 * - `now`: a clock function returning an ISO-8601 string. Tests inject
 *   a controllable clock to reproduce equal-`createdAt` rows + verify
 *   the id-desc tie-breaker on `list`. Defaults to
 *   `() => new Date().toISOString()`.
 * - `logger`: idempotent-warn channel. Defaults to a no-op so
 *   production callers must opt in to observability.
 */
export type InMemoryTaskLedgerOptions = {
  readonly now?: () => string;
  readonly logger?: InMemoryTaskLedgerLogger;
};

/**
 * Map-backed `TaskLedger` impl with NO I/O. Every read and write is
 * synchronous-in-spirit (the async signature is for `TaskLedger`
 * interface conformance + a future persistent backend; the in-memory
 * impl resolves immediately).
 *
 * Storage layout:
 * - `byIdentity` — `Map<IdentityId, TaskRecord[]>` keeps task records
 *   in insertion order per identity. Per-`IdentityId` isolation is
 *   enforced by keying on `IdentityId` — a query for one identity
 *   NEVER reads another identity's array. There is no cross-identity
 *   index of any kind. A `TaskId` minted under one owner cannot be
 *   resolved under another (per invariant #16).
 *
 * Per-`IdentityId` isolation discipline mirrors `InMemoryMemoryStore`
 * (slice E PR-#156). The state-machine guard mirrors sub-plan §6:
 * - `open → in_progress`, `open → cancelled`
 * - `in_progress → completed`, `in_progress → cancelled`,
 *   `in_progress → failed`
 * - `completed`, `cancelled`, `failed` are TERMINAL — no transition
 *   out is allowed. `update` rejects the promise when the requested
 *   transition violates the table; this matches the contract on
 *   `TaskLedger.update` (`task-ledger.ts:92-94`): "Rejects on backend
 *   failure or on a state-machine violation — those are caller bugs,
 *   not no-op cases."
 *
 * Idempotent terminal-same-state via `cancel` / `complete`:
 * - `cancel` on a `cancelled` task → no-op + warn, returns the
 *   existing record;
 * - `complete` on a `completed` task → no-op + warn, returns the
 *   existing record.
 * Both paths call the injected logger's `warn` exactly once per
 * idempotent invocation (tests assert this with a capturing logger).
 *
 * Per invariant #5/#6: the ledger accepts ONLY structured types
 * (`TaskCreateInput`, `TaskUpdatePatch`, `TaskListQuery`). Inputs are
 * re-validated via the Phase-2 Zod schemas at the call site; a
 * malformed input is a caller bug and is rejected synchronously
 * (the returned promise rejects with the underlying ZodError).
 *
 * Per invariant #8: this module imports only from
 * `src/platform/identity/`, the sibling task module, and Zod
 * (transitively via the Phase-2 schemas). It does NOT import from
 * `src/platform/commitment/` (the frozen layer) or
 * `src/platform/decision/`.
 */
export class InMemoryTaskLedger implements TaskLedger {
  private readonly byIdentity = new Map<IdentityId, TaskRecord[]>();
  private readonly clock: () => string;
  private readonly logger: InMemoryTaskLedgerLogger;
  /**
   * Monotonic counter for unique slug generation. Combined with the
   * brand validator in `asTaskId`, this guarantees every minted id is
   * well-formed AND distinct across the lifetime of the instance.
   * Zero-padded so lexicographic sort matches numeric sort — load-
   * bearing for the `list`-tie-breaker contract (newer id > older id
   * in `Array.prototype.sort` descending).
   */
  private nextSeq = 1;

  constructor(opts: InMemoryTaskLedgerOptions = {}) {
    this.clock = opts.now ?? (() => new Date().toISOString());
    this.logger = opts.logger ?? NO_OP_LOGGER;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async create(input: TaskCreateInput): Promise<TaskRecord> {
    // Re-validate at the call site — the type annotation alone does
    // not protect against unsafe-cast / unknown-typed callers, and the
    // Phase-2 schema reverse-tests prove this schema rejects every
    // malformed shape.
    const parsed = TaskCreateInputSchema.parse(input);
    const id = this.mintId();
    const ts = this.clock();
    const record: TaskRecord = {
      id,
      ownerIdentityId: parsed.ownerIdentityId,
      label: parsed.label,
      status: "open",
      summary: parsed.summary,
      createdAt: ts,
      updatedAt: ts,
      ...(parsed.sourceEffectFamily !== undefined
        ? { sourceEffectFamily: parsed.sourceEffectFamily }
        : {}),
      ...(parsed.sourceEffectId !== undefined
        ? { sourceEffectId: parsed.sourceEffectId }
        : {}),
    };
    const bucket = this.getOrCreate(parsed.ownerIdentityId);
    bucket.push(record);
    return record;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async list(query: TaskListQuery): Promise<TaskListResult> {
    const parsed = TaskListQuerySchema.parse(query);
    const limit = parsed.limit ?? DEFAULT_LIMIT;
    if (limit <= 0) {
      return { tasks: [] };
    }

    const bucket = this.byIdentity.get(parsed.ownerIdentityId);
    if (bucket === undefined || bucket.length === 0) {
      return { tasks: [] };
    }

    const statusFilter =
      parsed.statuses === undefined ? undefined : new Set<TaskStatus>(parsed.statuses);
    const sinceFilter = parsed.since;

    const filtered: TaskRecord[] = [];
    for (const row of bucket) {
      if (statusFilter !== undefined && !statusFilter.has(row.status)) {
        continue;
      }
      if (sinceFilter !== undefined && row.updatedAt < sinceFilter) {
        continue;
      }
      filtered.push(row);
    }

    // Newest-first by createdAt, then id descending as a deterministic
    // tie-breaker. Zero-padded ids guarantee lexicographic order ==
    // mint order; descending puts the most-recently-created row first
    // when timestamps collide. `Array.prototype.sort` is stable on
    // Node 22+ which keeps reads deterministic across consumers.
    filtered.sort((a, b) => {
      if (a.createdAt !== b.createdAt) {
        return a.createdAt < b.createdAt ? 1 : -1;
      }
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });

    return { tasks: filtered.slice(0, limit) };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async get(ownerIdentityId: IdentityId, taskId: TaskId): Promise<TaskRecord | undefined> {
    const bucket = this.byIdentity.get(ownerIdentityId);
    if (bucket === undefined) {
      return undefined;
    }
    return bucket.find((row) => row.id === taskId);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async update(
    ownerIdentityId: IdentityId,
    taskId: TaskId,
    patch: TaskUpdatePatch,
  ): Promise<TaskRecord | TaskNotFound> {
    // Re-validate the patch at the call site — the schema's empty-
    // patch refinement + status-transition refinement (when
    // `currentStatus` is supplied) catches caller bugs before they
    // touch the row.
    const parsed = TaskUpdatePatchSchema.parse(patch);

    const bucket = this.byIdentity.get(ownerIdentityId);
    if (bucket === undefined) {
      return { kind: "not_found" };
    }
    const idx = bucket.findIndex((row) => row.id === taskId);
    if (idx < 0) {
      return { kind: "not_found" };
    }
    const row = bucket[idx]!;

    // State-machine guard at the impl boundary (defense-in-depth
    // alongside the schema-level refinement). When the patch supplies
    // a new `status` we authoritatively check the transition against
    // the row's CURRENT status — this catches the case where the
    // caller did NOT supply `currentStatus` to the schema (the schema
    // skips the check in that case).
    if (parsed.status !== undefined && parsed.status !== row.status) {
      if (!isTaskTransitionAllowed(row.status, parsed.status)) {
        throw new Error(
          `InMemoryTaskLedger: illegal task status transition (${row.status} → ${parsed.status}) for ${row.id}`,
        );
      }
    }

    const updated = applyPatch(row, parsed, this.clock());
    bucket[idx] = updated;
    return updated;
  }

  async complete(
    ownerIdentityId: IdentityId,
    taskId: TaskId,
    result?: string,
  ): Promise<TaskRecord | TaskNotFound> {
    const bucket = this.byIdentity.get(ownerIdentityId);
    if (bucket === undefined) {
      return { kind: "not_found" };
    }
    const idx = bucket.findIndex((row) => row.id === taskId);
    if (idx < 0) {
      return { kind: "not_found" };
    }
    const row = bucket[idx]!;

    // Idempotent: complete on already-completed → no-op + warn.
    // Returns the existing record so callers' happy path stays
    // branch-free.
    if (row.status === "completed") {
      this.logger.warn(
        `InMemoryTaskLedger: complete called on already-completed task ${row.id} (no-op)`,
        { taskId: row.id, ownerIdentityId },
      );
      return row;
    }

    // Delegate to update — re-uses the state-machine guard so an
    // illegal "complete" on a `cancelled` / `failed` row rejects.
    const patch: TaskUpdatePatch = {
      status: "completed",
      ...(result !== undefined ? { result } : {}),
    };
    return this.update(ownerIdentityId, taskId, patch);
  }

  async cancel(
    ownerIdentityId: IdentityId,
    taskId: TaskId,
    reason?: string,
  ): Promise<TaskRecord | TaskNotFound> {
    const bucket = this.byIdentity.get(ownerIdentityId);
    if (bucket === undefined) {
      return { kind: "not_found" };
    }
    const idx = bucket.findIndex((row) => row.id === taskId);
    if (idx < 0) {
      return { kind: "not_found" };
    }
    const row = bucket[idx]!;

    // Idempotent: cancel on already-cancelled → no-op + warn.
    if (row.status === "cancelled") {
      this.logger.warn(
        `InMemoryTaskLedger: cancel called on already-cancelled task ${row.id} (no-op)`,
        { taskId: row.id, ownerIdentityId },
      );
      return row;
    }

    const patch: TaskUpdatePatch = {
      status: "cancelled",
      ...(reason !== undefined ? { result: reason } : {}),
    };
    return this.update(ownerIdentityId, taskId, patch);
  }

  private mintId(): TaskId {
    const slug = `inmem-${String(this.nextSeq).padStart(8, "0")}`;
    this.nextSeq += 1;
    return asTaskId(`task:${slug}`);
  }

  private getOrCreate(key: IdentityId): TaskRecord[] {
    const existing = this.byIdentity.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const fresh: TaskRecord[] = [];
    this.byIdentity.set(key, fresh);
    return fresh;
  }
}

/**
 * Build the patched `TaskRecord` — pure function so the storage map
 * mutation in `update` is a single assignment and easier to audit.
 *
 * `completedAt` is set when the patch transitions the row INTO a
 * terminal state for the first time; once set, it is never cleared
 * (terminal states do not transition out per sub-plan §6, so an
 * already-set `completedAt` survives the `applyPatch` call).
 */
function applyPatch(
  current: TaskRecord,
  patch: TaskUpdatePatch,
  updatedAt: string,
): TaskRecord {
  const nextStatus = patch.status ?? current.status;
  const enteringTerminal =
    patch.status !== undefined &&
    patch.status !== current.status &&
    isTaskTerminalStatus(patch.status);

  const completedAt = enteringTerminal
    ? updatedAt
    : current.completedAt;

  return {
    ...current,
    status: nextStatus,
    label: patch.label ?? current.label,
    summary: patch.summary ?? current.summary,
    ...(patch.result !== undefined
      ? { result: patch.result }
      : current.result !== undefined
        ? { result: current.result }
        : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    updatedAt,
  };
}
