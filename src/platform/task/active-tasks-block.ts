import type { TaskRecord, TaskStatus } from "./task-record.js";

/**
 * Closed set of statuses surfaced to the contractor's `<active_tasks>`
 * block. Per sub-plan §6 the LLM should only see live work — terminal
 * states (completed / cancelled / failed) are filtered out at the
 * formatter so the block reflects "what's still in flight".
 */
const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set(["open", "in_progress"]);

/**
 * Format a list of `TaskRecord`s into the closed-shape `<active_tasks>`
 * block consumed by `IntentContractor` (slice F Phase 6, mirror of slice
 * E's `<memory>` block). Empty / all-terminal inputs return the empty
 * string so the contractor injects ZERO whitespace into the prompt
 * when there is nothing to surface.
 *
 * Output shape:
 *   `<active_tasks>{"tasks":[{ id, label, status }, ...]}</active_tasks>`
 *
 * Each entry carries ONLY `id` / `label` / `status` (sub-plan §6 — keep
 * the block compact; the LLM cross-references back to the ledger via
 * `id` if it needs more detail). `summary`, `result`, `createdAt`,
 * `updatedAt`, `ownerIdentityId`, etc. are intentionally omitted.
 *
 * Sort discipline mirrors `InMemoryTaskLedger.list` (slice F Phase 3):
 * newest-first by `createdAt`, then `id` descending as a deterministic
 * tie-breaker. The formatter applies its own sort even when the caller
 * supplied an already-sorted list — defense-in-depth so the block
 * shape is independent of the ledger backend's read order.
 *
 * Per invariant #5 the block payload is structured JSON; raw user
 * text is never inlined. Adversarial labels (e.g. one containing
 * `</active_tasks>`) are JSON-encoded by `JSON.stringify`, so the
 * outer wrapper tags remain unambiguous when the consumer extracts
 * via literal slices anchored at the LAST occurrence of the closing
 * tag (the formatter guarantees that occurrence is the trailing
 * literal).
 */
export function buildActiveTasksBlock(tasks: ReadonlyArray<TaskRecord>): string {
  if (tasks.length === 0) {
    return "";
  }

  const filtered: TaskRecord[] = [];
  for (const task of tasks) {
    if (ACTIVE_STATUSES.has(task.status)) {
      filtered.push(task);
    }
  }
  if (filtered.length === 0) {
    return "";
  }

  filtered.sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? 1 : -1;
    }
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });

  const payload = {
    tasks: filtered.map((task) => ({
      id: String(task.id),
      label: task.label,
      status: task.status,
    })),
  };

  return `<active_tasks>${JSON.stringify(payload)}</active_tasks>`;
}
