import type { IdentityId } from "../identity/identity-id.js";

import type { TaskId } from "./task-id.js";
import type {
  TaskCreateInput,
  TaskListQuery,
  TaskListResult,
  TaskRecord,
  TaskUpdatePatch,
} from "./task-record.js";

/**
 * Sentinel returned by `update` / `complete` / `cancel` when the
 * supplied `TaskId` does not exist for the given owner. Returning
 * a structured value (rather than throwing) keeps the caller's
 * happy path branch-free while still surfacing the miss; this
 * mirrors slice E's `MemoryStore.forget` discipline (no-op on
 * unknown id, never throws).
 */
export type TaskNotFound = { readonly kind: "not_found" };

/**
 * Task ledger contract — the single seam through which slice F's
 * commitment-runtime hook (Phase 5) writes per-`IdentityId` task
 * lifecycle, and through which the contractor (Phase 6) lists
 * active tasks for the `<active_tasks>` block.
 *
 * Keys on `IdentityId` (slice D). The ledger NEVER receives a
 * `RawUserTurn` / `UserPrompt` / `SessionId` as a primary key —
 * those brands are out-of-scope by design (per invariants #5/#6/#16
 * they are distinct types and the compiler enforces
 * non-substitutability; `task-ledger.contract.test.ts` enforces
 * this with `@ts-expect-error`).
 *
 * Implementations may be:
 * - in-memory (Phase 3 — Map-backed, zero I/O — for tests + early
 *   integration);
 * - sqlite-backed (Phase 4 — persistent, per-`IdentityId` isolation
 *   via `WHERE identity_id = ?` predicates).
 *
 * All implementations MUST honour:
 * - `get` returns `undefined` (never throws) when nothing matches;
 * - `update` / `complete` / `cancel` return `{ kind: "not_found" }`
 *   for an unknown id under the supplied owner — never throw on
 *   miss;
 * - state-machine guard rejects illegal transitions at the impl
 *   boundary (defense-in-depth alongside the schema refinement on
 *   `TaskUpdatePatchSchema`);
 * - per-`IdentityId` isolation: `TaskId` alone never crosses
 *   operators; every read AND every write predicates on
 *   `ownerIdentityId`;
 * - backend write failures are SURFACED (rejected promise) but DO
 *   NOT downgrade the calling commitment — slice F Phase 5's hook
 *   catches the rejection and logs it without re-throwing
 *   (invariant #15).
 *
 * Phase 2 ships ONLY this interface — no impl, no callers wire it
 * in. Phase 3 lands the in-memory impl; Phases 4-7 wire impl + call
 * sites.
 */
export interface TaskLedger {
  /**
   * Create a new task under the supplied owner. Always starts in
   * `open` status; `id`, `createdAt`, `updatedAt` are ledger-assigned.
   * Resolves the new `TaskRecord` on success; rejects on backend
   * failure (e.g. sqlite I/O error).
   */
  create(input: TaskCreateInput): Promise<TaskRecord>;

  /**
   * List tasks for the supplied owner, optionally filtered by
   * `statuses` / `since` and capped by `limit`. Returns
   * `{ tasks: [] }` when nothing matches — never throws on no-match.
   * Per-`IdentityId` isolation: rows under a different owner are
   * NEVER returned, even if a malformed `TaskId` collides.
   */
  list(query: TaskListQuery): Promise<TaskListResult>;

  /**
   * Fetch one task by id under the supplied owner. Returns
   * `undefined` when the id is unknown for that owner — including
   * when the id exists under a DIFFERENT owner (per-`IdentityId`
   * isolation). Never throws on miss.
   */
  get(ownerIdentityId: IdentityId, taskId: TaskId): Promise<TaskRecord | undefined>;

  /**
   * Apply a structured patch to the task. Validates the patch at
   * the impl boundary (state-machine guard rejects illegal
   * transitions even when `currentStatus` was omitted from the
   * patch). Returns the updated record on success or
   * `{ kind: "not_found" }` when the id is unknown for the supplied
   * owner. Rejects on backend failure or on a state-machine
   * violation — those are caller bugs, not no-op cases.
   */
  update(
    ownerIdentityId: IdentityId,
    taskId: TaskId,
    patch: TaskUpdatePatch,
  ): Promise<TaskRecord | TaskNotFound>;

  /**
   * Mark a task `completed`. Convenience wrapper around `update`
   * for the most common terminal-transition path. `result` is
   * operator-facing summary text (e.g. "Posted retrospective to
   * #eng-leads"). Idempotent on already-completed tasks: per
   * sub-plan §6, calling `complete` on a `completed` task is a
   * no-op + warn (the impl emits the warn; the contract here
   * surfaces the success branch with the existing record).
   * Returns `{ kind: "not_found" }` when the id is unknown.
   */
  complete(
    ownerIdentityId: IdentityId,
    taskId: TaskId,
    result?: string,
  ): Promise<TaskRecord | TaskNotFound>;

  /**
   * Mark a task `cancelled`. Convenience wrapper around `update`.
   * `reason` is operator-facing free text (stored in the
   * `result` field on the record — there is no separate
   * cancellation reason column; v1 keeps the row shape narrow).
   * Idempotent on already-cancelled: no-op + warn. Returns
   * `{ kind: "not_found" }` when the id is unknown.
   */
  cancel(
    ownerIdentityId: IdentityId,
    taskId: TaskId,
    reason?: string,
  ): Promise<TaskRecord | TaskNotFound>;
}
