/**
 * Public surface of the platform task module — slice F Phase 3.
 *
 * Phase 2 shipped types + Zod schemas + the `TaskLedger` interface.
 * Phase 3 adds the Map-backed `InMemoryTaskLedger` impl below; Phase
 * 4 will add `SqliteTaskLedger`.
 *
 * Per invariant #8, this module imports ONLY from
 * `src/platform/identity/`, the standard library, and Zod. It does
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
