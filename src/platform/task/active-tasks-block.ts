import type { ResolvedFreshnessConfig } from "../freshness/freshness-config.js";
import { scoreByRecency } from "../freshness/score-by-recency.js";

import type { TaskRecord, TaskStatus } from "./task-record.js";

/**
 * Closed set of statuses surfaced to the contractor's `<active_tasks>`
 * block. Per sub-plan §6 the LLM should only see live work — terminal
 * states (completed / cancelled / failed) are filtered out at the
 * formatter so the block reflects "what's still in flight".
 */
const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set(["open", "in_progress"]);

/**
 * Slice "intent-contractor freshness/recency" Phase 4 / Change 4 —
 * optional freshness reorder option. When provided, the formatter
 * applies `scoreByRecency` to the filtered task list using
 * `task.updatedAt ?? task.createdAt` (parsed via `Date.parse` to epoch
 * ms) BEFORE the existing `createdAt` DESC + `id` DESC defensive
 * sort. Omitting the option preserves the slice F P6 behaviour
 * byte-identically.
 *
 * Per audit §c.3 the resolved-config + clock value are caller-supplied
 * so a single `classify` call sees lock-step parameters across both
 * `<memory>` and `<active_tasks>` blocks.
 */
export type ActiveTasksFreshnessOption = {
  readonly now: number;
  readonly freshnessConfig: ResolvedFreshnessConfig;
};

/**
 * Parse an ISO-8601 timestamp string to epoch ms; returns `null` when
 * the string is missing or unparseable. Used by the freshness
 * extractor below; never throws (sub-plan §1 invariant #15).
 */
function parseIsoToEpoch(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

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
export function buildActiveTasksBlock(
  tasks: ReadonlyArray<TaskRecord>,
  freshness?: ActiveTasksFreshnessOption,
): string {
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

  // Slice "intent-contractor freshness/recency" Phase 4 / Change 4:
  // when the freshness option is supplied, apply the recency reorder
  // BEFORE the defensive createdAt-DESC sort. Without the option, the
  // pre-Phase-4 slice F P6 behaviour is preserved byte-identically.
  let ordered: TaskRecord[];
  if (freshness !== undefined) {
    // Primary key: `updatedAt` epoch; fallback to `createdAt` epoch.
    const scored = scoreByRecency<TaskRecord>({
      items: filtered,
      getTimestamp: (task) =>
        parseIsoToEpoch(task.updatedAt) ?? parseIsoToEpoch(task.createdAt),
      nowMs: freshness.now,
      config: freshness.freshnessConfig,
    });
    ordered = scored.map((s) => s.item);
  } else {
    ordered = filtered;
  }

  // Defense-in-depth: secondary sort by `createdAt` DESC + `id` DESC
  // remains. With the freshness reorder the input is already
  // recency-weighted; this secondary pass is stable and disambiguates
  // ties on `recencyDecay` (e.g. identical `updatedAt`). Without
  // freshness this is the primary (and only) sort — slice F P6
  // behaviour preserved.
  if (freshness === undefined) {
    ordered.sort((a, b) => {
      if (a.createdAt !== b.createdAt) {
        return a.createdAt < b.createdAt ? 1 : -1;
      }
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
  } else {
    // With freshness: stable sort that only reorders ties on
    // updatedAt. Group by updatedAt (already preserved by
    // `scoreByRecency` stability when timestamps are equal) and tie-
    // break within each group by createdAt DESC + id DESC.
    ordered = stableTieBreak(ordered);
  }

  const payload = {
    tasks: ordered.map((task) => ({
      id: String(task.id),
      label: task.label,
      status: task.status,
    })),
  };

  return `<active_tasks>${JSON.stringify(payload)}</active_tasks>`;
}

/**
 * Stable tie-break: items with the same `updatedAt` are reordered
 * locally by `createdAt` DESC + `id` DESC so the freshness output is
 * deterministic across engines without changing the freshness
 * ordering itself. Original ordering between distinct `updatedAt`
 * groups is preserved.
 */
function stableTieBreak(items: readonly TaskRecord[]): TaskRecord[] {
  const out: TaskRecord[] = [];
  let i = 0;
  while (i < items.length) {
    let j = i + 1;
    while (j < items.length && items[j]!.updatedAt === items[i]!.updatedAt) {
      j += 1;
    }
    const group = items.slice(i, j);
    group.sort((a, b) => {
      if (a.createdAt !== b.createdAt) {
        return a.createdAt < b.createdAt ? 1 : -1;
      }
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
    out.push(...group);
    i = j;
  }
  return out;
}
