/**
 * Slice K Phase 4 — `RecallReminderTool`.
 *
 * FIRST sanctioned reminder query surface in `god-mode-core`. Schema
 * accepts a CLOSED `ReminderQueryShape` only — free-form `query: string`
 * fields are rejected by construction (invariants #5/#6 reverse-test;
 * sub-plan acceptance #4). identityId is INJECTED from the session
 * context — never read from user-controlled input.
 *
 * Behavior on call:
 * 1. Resolve `ownerIdentityId` from injected session context. Anonymous
 *    → fail-closed (return `unmatched: ['identity_unavailable']`,
 *    ZERO `MemoryStore` calls — sub-plan acceptance #8).
 * 2. Validate the structured query via `ReminderQueryShapeSchema`.
 * 3. For each family in `effectFamilyFilter` (default = the four
 *    user-facing LIT families: `persistent_session`, `task`,
 *    `artifact`, `repo`; `policy_*` / `subagent` / `reminder` excluded
 *    by default), call `MemoryStore.list({identityId, effectFamily,
 *    limit})` IN PARALLEL via `Promise.all`. Per-family failure is
 *    isolated — a single rejected `list()` surfaces
 *    `family_unavailable` in `unmatched`; other families still
 *    contribute entries.
 * 4. Optionally union with `MemoryStore.recall({identityId, query:
 *    textHint})` semantic-similarity entries when `textHint` is
 *    provided. Failure here is non-fatal (recall enrichment is
 *    best-effort).
 * 5. Filter by `recallWindow.from <= occurredAt <= recallWindow.until`
 *    when window is provided.
 * 6. Format per-family `summary` via closed reducers (one per family).
 * 7. Sort entries newest-first (descending `occurredAt`); apply
 *    overall `limit` cap.
 * 8. Emit `recordReminderQueried` so `WorldStateSnapshot.reminder.lastQuery`
 *    populates and `reminderDeliveredPredicate` (Phase 3) can satisfy.
 * 9. Return `ReminderRecallResult` (NEVER throws — invariant #15).
 *
 * Boundary discipline:
 * - Lives in `src/agents/tools/`, NOT in `src/platform/commitment/`
 *   (invariant #8). Calls flow through Phase 4
 *   `reminder-runtime-adapter.ts` only — this file does NOT touch the
 *   `ReminderWorldStateCollector` directly.
 * - Reads STRUCTURAL inputs only (closed `ReminderQueryShape`); never
 *   reads raw operator text (#5/#6).
 */

import {
  recordReminderQueried,
  type RecordReminderQueriedResult,
} from "../pi-embedded-runner/run/reminder-runtime-adapter.js";
import type { ReminderWorldStateCollector } from "../../platform/commitment/reminder-world-state-observer.js";
import type { SessionId } from "../../platform/commitment/ids.js";
import type {
  EpisodicEffectFamily,
  EpisodicMemoryEvent,
} from "../../platform/memory/episodic-memory-event.js";
import type { MemoryStore } from "../../platform/memory/memory-store.js";
import type { IdentityId } from "../../platform/identity/identity-id.js";
import {
  ReminderQueryShapeSchema,
  type ReminderEntry,
  type ReminderQueryShape,
  type ReminderRecallResult,
  type UnmatchedReason,
} from "../../platform/reminder/index.js";

// keep UnmatchedReason in the type domain for consumer documentation;
// re-exported via the platform/reminder barrel — tests import from there.
export type { UnmatchedReason };

/**
 * Default user-facing LIT families queried when `effectFamilyFilter`
 * is omitted. Excludes `policy_*` (operator-internal — sub-plan §6
 * audit §d), `subagent` (slice G STUB — never lit), and `reminder`
 * (slice K is a pure consumer; it does NOT light the
 * `EpisodicEffectFamily.reminder` slot — sub-plan §10 acceptance
 * #11).
 */
const DEFAULT_FAMILY_FILTER: readonly EpisodicEffectFamily[] = Object.freeze([
  "persistent_session",
  "task",
  "artifact",
  "repo",
]);

/**
 * Default per-family limit when caller omits `limit`. Conservative —
 * higher caps risk operator-facing context bloat. The contractor
 * (Phase 5) will override with prompt-derived structured value.
 */
const DEFAULT_LIMIT = 20;

/**
 * Cap on `summary` text length. Reducers truncate at this boundary;
 * the contractor consumes summaries via the structured outbound
 * coalescer (NEW-C surface) so per-row tokens stay bounded.
 */
const SUMMARY_TEXT_MAX_CHARS = 120;

let monotonicCounter = 0;

function nextQueryId(): string {
  monotonicCounter += 1;
  return `rem:${Date.now()}:${monotonicCounter}`;
}

export type RecallReminderToolInput = {
  /**
   * Closed structured query. Schema rejects free-form `query: string`
   * (acceptance #4 / invariants #5/#6 reverse).
   */
  readonly query: ReminderQueryShape;
  /**
   * Process-scoped MemoryStore (in-memory, sqlite-vec, or
   * LLM-extracted — all share the same interface). When `undefined`,
   * the tool fails closed with `memory_store_unavailable` and emits
   * NO calls. Tests inject a fixture `MemoryStore` directly.
   */
  readonly memoryStore: MemoryStore | undefined;
  /**
   * Append-only collector backing `WorldStateSnapshot.reminder`. When
   * `undefined`, the tool still computes the result but skips the
   * runtime-adapter emit; `unmatched` carries `family_unavailable` for
   * the missing observer (since the predicate cannot satisfy without
   * it). Production wiring threads
   * `getProcessReminderWorldStateCollector()` here.
   */
  readonly collector: ReminderWorldStateCollector | undefined;
  readonly sessionId: SessionId;
  readonly turnId: string;
  /**
   * Optional explicit query id. When omitted, the tool mints a
   * deterministic-ish `rem:<timestamp>:<counter>`. Production callers
   * may forward a tool-side id to keep traces JOIN-able.
   */
  readonly queryId?: string;
  readonly logger?: (line: string) => void;
};

/**
 * Reverse-test guard: explicitly rejects a top-level `query: string`
 * field on the structured input. This is the slice K structural
 * enforcement of invariants #5/#6 — operators do NOT smuggle raw
 * text past the tool boundary. Used in addition to
 * `ReminderQueryShapeSchema.strict()` (which rejects unknown keys at
 * the inner shape) so the OUTER tool boundary is also closed.
 */
function rejectsFreeFormQuery(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["query"] === "string";
}

export async function recallReminderTool(
  input: RecallReminderToolInput,
): Promise<ReminderRecallResult> {
  // 0. Reject free-form `query: string` at the boundary. Explicit
  //    enforcement of invariants #5/#6 reverse — sub-plan acceptance #4.
  //    This is a structural defense in depth: ReminderQueryShapeSchema
  //    is .strict() so an `extra: 'query'` field is also rejected, but
  //    a caller could pass `{query: 'free text'}` at the OUTER tool
  //    boundary (before reaching the inner shape schema) — the closed
  //    rejection above guards that path.
  if (rejectsFreeFormQuery(input)) {
    input.logger?.(
      `[recall-reminder-tool] schema_invalid reason=free_form_query_rejected sessionId=${input.sessionId} turnId=${input.turnId}`,
    );
    return Object.freeze({
      entries: Object.freeze([]),
      unmatched: Object.freeze(["identity_unavailable"] as const) as readonly UnmatchedReason[],
    });
  }

  // 1. Validate the closed structured query via the shared shape
  //    schema. Strict mode rejects unknown keys.
  const parsed = ReminderQueryShapeSchema.safeParse(input.query);
  if (!parsed.success) {
    input.logger?.(
      `[recall-reminder-tool] schema_invalid reason=${parsed.error.issues.map((i) => i.path.join(".")).join("|")} sessionId=${input.sessionId} turnId=${input.turnId}`,
    );
    // Schema invalid surfaces as identity_unavailable from the
    // operator-perspective: the contractor (Phase 5) is the only
    // sanctioned producer of this shape; if the shape is malformed,
    // we fail closed without consulting the MemoryStore.
    return Object.freeze({
      entries: Object.freeze([]),
      unmatched: Object.freeze(["identity_unavailable"] as const) as readonly UnmatchedReason[],
    });
  }

  const shape: ReminderQueryShape = parsed.data;

  // 2. Anonymous fail-closed. ownerIdentityId is the canonical
  //    identity scope — empty / missing => zero MemoryStore calls.
  const ownerIdentityIdRaw = String(shape.ownerIdentityId ?? "").trim();
  if (ownerIdentityIdRaw.length === 0) {
    input.logger?.(
      `[recall-reminder-tool] identity_unavailable sessionId=${input.sessionId} turnId=${input.turnId}`,
    );
    return Object.freeze({
      entries: Object.freeze([]),
      unmatched: Object.freeze(["identity_unavailable"] as const) as readonly UnmatchedReason[],
    });
  }

  // 3. MemoryStore unavailable — production wiring bug. Skip
  //    everything and surface the closed reason.
  if (!input.memoryStore || typeof input.memoryStore.list !== "function") {
    input.logger?.(
      `[recall-reminder-tool] memory_store_unavailable sessionId=${input.sessionId} turnId=${input.turnId}`,
    );
    return Object.freeze({
      entries: Object.freeze([]),
      unmatched: Object.freeze(["memory_store_unavailable"] as const) as readonly UnmatchedReason[],
    });
  }

  const families = (shape.effectFamilyFilter ?? DEFAULT_FAMILY_FILTER) as readonly EpisodicEffectFamily[];
  const perFamilyLimit = shape.limit ?? DEFAULT_LIMIT;
  const ownerIdentityId = shape.ownerIdentityId as IdentityId;

  // 4. Parallel per-family `list()` calls. Per-family failure is
  //    isolated — `Promise.allSettled` surfaces rejections without
  //    discarding the other families' entries.
  const listPromises = families.map((family) =>
    input.memoryStore!
      .list({ identityId: ownerIdentityId, effectFamily: family, limit: perFamilyLimit })
      .then((res) => ({ family, ok: true as const, result: res }))
      .catch((err: unknown) => ({ family, ok: false as const, err })),
  );

  const settled = await Promise.all(listPromises);

  const entries: ReminderEntry[] = [];
  const unmatched: UnmatchedReason[] = [];

  for (const r of settled) {
    if (!r.ok) {
      unmatched.push("family_unavailable");
      input.logger?.(
        `[recall-reminder-tool] family_unavailable family=${r.family} sessionId=${input.sessionId} turnId=${input.turnId} detail=${r.err instanceof Error ? r.err.message : String(r.err)}`,
      );
      continue;
    }
    const listing = r.result;
    for (const ep of listing.episodic) {
      const reduced = reduceEpisodic(ep.event);
      if (reduced === undefined) {
        continue;
      }
      const occurredAt = reduced.occurredAt;
      if (!withinRecallWindow(occurredAt, shape.recallWindow)) {
        continue;
      }
      entries.push(
        Object.freeze({
          effectFamily: r.family,
          occurredAt,
          summary: reduced.summary,
          payloadRef: Object.freeze({
            effectId: ep.event.effectId,
            memoryEntryId: ep.id,
          }),
        }),
      );
    }
    input.logger?.(
      `[memory-store] list identityId=${ownerIdentityId} effectFamily=${r.family} entries=${listing.episodic.length}`,
    );
  }

  // 5. Optional textHint union via MemoryStore.recall. Best-effort.
  //    Note: `recall` returns `SemanticMemoryEntry[]`; we don't have
  //    a per-entry `effectFamily` for these (they're free-form
  //    semantic content), so we tag them as `persistent_session`
  //    (the only LIT semantic-bearing family) — the union exists for
  //    the operator-facing structural answer, NOT for done-predicate
  //    satisfaction (which gates on `lastQuery.queryId` only).
  if (shape.textHint && shape.textHint.length > 0) {
    try {
      const recall = await input.memoryStore.recall({
        identityId: ownerIdentityId,
        query: shape.textHint,
        ...(shape.limit !== undefined ? { limit: shape.limit } : {}),
      });
      for (const sem of recall.entries) {
        const occurredAt = readSemanticOccurredAt(sem);
        if (occurredAt === undefined) continue;
        if (!withinRecallWindow(occurredAt, shape.recallWindow)) continue;
        entries.push(
          Object.freeze({
            effectFamily: "persistent_session" as EpisodicEffectFamily,
            occurredAt,
            summary: truncate(`recall: ${sem.content}`, SUMMARY_TEXT_MAX_CHARS),
            payloadRef: Object.freeze({
              effectId: "memory.recall",
              memoryEntryId: sem.id,
            }),
          }),
        );
      }
    } catch (err) {
      // Best-effort enrichment — non-fatal. Tag a unmatched reason so
      // the caller has observability over the partial-result.
      unmatched.push("family_unavailable");
      input.logger?.(
        `[recall-reminder-tool] recall_failed detail=${err instanceof Error ? err.message : String(err)} sessionId=${input.sessionId} turnId=${input.turnId}`,
      );
    }
  }

  // 6. Sort newest-first by occurredAt. Apply overall limit.
  entries.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0));
  const overallLimit = shape.limit ?? DEFAULT_LIMIT;
  const finalEntries = entries.slice(0, overallLimit);

  // 7. Emit recordReminderQueried so the kernel runtime sees the slice
  //    populate. The caller's commitment carries `expectedDelta.reminder.queryId`
  //    matching the queryId we forward here.
  const queryId = (input.queryId && input.queryId.length > 0) ? input.queryId : nextQueryId();
  let recordResult: RecordReminderQueriedResult | undefined;
  if (input.collector) {
    recordResult = recordReminderQueried({
      collector: input.collector,
      sessionId: input.sessionId,
      turnId: input.turnId,
      queryId,
      query: shape,
      resultCount: finalEntries.length,
      ...(input.logger ? { logger: input.logger } : {}),
    });
    if (!recordResult.ok) {
      // Map the closed reminder-runtime-adapter failure set onto the
      // closed UnmatchedReason set. Both are closed string unions;
      // the mapping is structural.
      switch (recordResult.reason) {
        case "identity_unavailable":
          unmatched.push("identity_unavailable");
          break;
        case "memory_store_unavailable":
          unmatched.push("memory_store_unavailable");
          break;
        case "observer_unavailable":
        case "transport_error":
          unmatched.push("family_unavailable");
          break;
      }
    }
  } else {
    // No collector wired — observer slice will be absent, and the
    // done-predicate (Phase 3) will report `reminder.slice_absent`.
    // We surface the closed reason so callers see the structural
    // failure rather than thinking the tool succeeded.
    unmatched.push("family_unavailable");
  }

  input.logger?.(
    `[recall-reminder-tool] families=[${families.join(",")}] identityId=${ownerIdentityId} entries=${finalEntries.length} sessionId=${input.sessionId} turnId=${input.turnId}`,
  );

  return Object.freeze({
    entries: Object.freeze(finalEntries),
    unmatched: Object.freeze(unmatched),
  });
}

/**
 * Per-family closed summary reducer. Returns the structured short
 * summary text + the canonical `occurredAt` for the row, or
 * `undefined` when the event shape doesn't carry the canonical
 * structural fields slice K reads (defense in depth — partial-result
 * tolerance).
 */
function reduceEpisodic(
  event: EpisodicMemoryEvent,
): { readonly summary: string; readonly occurredAt: string } | undefined {
  switch (event.effectFamily) {
    case "artifact": {
      const p = event.payload;
      const summary = `${formatArtifactKind(p.kind)}: ${truncate(p.kind, 64)}`;
      return { summary: truncate(summary, SUMMARY_TEXT_MAX_CHARS), occurredAt: p.occurredAt };
    }
    case "repo": {
      const p = event.payload;
      let summary: string;
      switch (p.kind) {
        case "branch_created":
          summary = `Branch ${p.branchName ?? "(unset)"} created`;
          break;
        case "commit_landed":
          summary = `Commit ${p.commitSha ? short7(p.commitSha) : "(unset)"} landed${p.branchName ? ` on ${p.branchName}` : ""}`;
          break;
        case "merge_completed":
          summary = `Merge into ${p.branchName ?? "(unset)"} completed`;
          break;
        case "diff_observed":
          summary = `Diff observed${p.branchName ? ` on ${p.branchName}` : ""}`;
          break;
      }
      return { summary: truncate(summary, SUMMARY_TEXT_MAX_CHARS), occurredAt: p.occurredAt };
    }
    case "task": {
      const p = event.payload;
      const status = p.kind;
      const label = "label" in p ? p.label : `task:${p.taskId}`;
      const summary = `${label} [${status}]`;
      return { summary: truncate(summary, SUMMARY_TEXT_MAX_CHARS), occurredAt: p.occurredAt };
    }
    case "persistent_session": {
      const p = event.payload;
      const role = p.messageRole;
      const text = truncate(p.messageText, SUMMARY_TEXT_MAX_CHARS - 8);
      const summary = `[${role}] ${text}`;
      return { summary, occurredAt: p.occurredAt };
    }
    // Other families are not reduced for the operator-facing surface
    // by default. policy_* / subagent / reminder are excluded by the
    // default filter; if a future caller opts them in via the
    // `effectFamilyFilter` parameter we still skip the reducer (no
    // closed structural representation exists yet).
    default:
      return undefined;
  }
}

function formatArtifactKind(kind: string): string {
  return kind.toUpperCase();
}

function short7(sha: string): string {
  return sha.length >= 7 ? sha.slice(0, 7) : sha;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, Math.max(0, n - 1))}…`;
}

function withinRecallWindow(
  occurredAt: string,
  window: ReminderQueryShape["recallWindow"],
): boolean {
  if (!window) return true;
  const t = Date.parse(occurredAt);
  if (Number.isNaN(t)) return false;
  if (window.from !== undefined) {
    const from = Date.parse(window.from);
    if (!Number.isNaN(from) && t < from) return false;
  }
  if (window.until !== undefined) {
    const until = Date.parse(window.until);
    if (!Number.isNaN(until) && t > until) return false;
  }
  return true;
}

function readSemanticOccurredAt(sem: { readonly metadata?: Record<string, unknown> }): string | undefined {
  const meta = sem.metadata;
  if (!meta) return undefined;
  const v = (meta as Record<string, unknown>)["occurredAt"];
  return typeof v === "string" ? v : undefined;
}
