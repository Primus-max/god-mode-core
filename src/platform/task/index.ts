/**
 * Public surface of the platform task module — slice F.
 *
 * Phase 2 ships types + Zod schemas + the `TaskLedger` interface.
 * Phase 3 adds the Map-backed `InMemoryTaskLedger`.
 * Phase 4 adds the persistent `SqliteTaskLedger` + `defaultSqliteTaskLedgerPath`.
 *
 * Per invariant #8, this module imports ONLY from
 * `src/platform/identity/`, the standard library, Zod, and the
 * project's existing `src/utils.ts` / `src/memory/sqlite.ts` /
 * `node:sqlite` shims used by the Phase 4 sqlite impl. It does
 * NOT import from `src/platform/decision/` or any decision-layer
 * adapter, and it does NOT touch `src/platform/commitment/` (the
 * frozen 5-contract layer). The frozen `TaskContract`
 * (`src/platform/decision/contracts.ts`) is a SIBLING concept —
 * a planner-input shape — and is intentionally NOT re-exported
 * here.
 */

export { asTaskId, isTaskId, type TaskId } from "./task-id.js";

export {
  TASK_STATUSES,
  TaskCreateInputSchema,
  TaskListQuerySchema,
  TaskListResultSchema,
  TaskRecordSchema,
  TaskUpdatePatchSchema,
  assertNeverTaskStatus,
  isTaskTerminalStatus,
  isTaskTransitionAllowed,
  type TaskCreateInput,
  type TaskListQuery,
  type TaskListResult,
  type TaskRecord,
  type TaskStatus,
  type TaskUpdatePatch,
} from "./task-record.js";

export type { TaskLedger, TaskNotFound } from "./task-ledger.js";

export {
  InMemoryTaskLedger,
  type InMemoryTaskLedgerLogger,
  type InMemoryTaskLedgerOptions,
} from "./in-memory-task-ledger.js";

export {
  SQLITE_TASK_LEDGER_SCHEMA_VERSION,
  SqliteTaskLedger,
  defaultSqliteTaskLedgerPath,
  type SqliteTaskLedgerLogger,
  type SqliteTaskLedgerOpenOptions,
} from "./sqlite-task-ledger.js";
