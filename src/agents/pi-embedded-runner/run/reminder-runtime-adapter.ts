/**
 * Slice K Phase 4 — reminder runtime adapter.
 *
 * Sibling of Cutover-3 P5 `artifact-runtime-adapter.ts` and Cutover-4 P5
 * `repo-runtime-adapter.ts`. The adapter is the WRITE side of the slice
 * K Phase 4 `WorldStateSnapshot.reminder` slice (Phase 4): it receives
 * a structural reminder-query descriptor produced by the Phase 4
 * `RecallReminderTool`, validates the queryId / collector availability,
 * appends a `ReminderQueryRecord` to the injected
 * `ReminderWorldStateCollector`, and returns a typed result envelope so
 * the calling tool can also surface `expectedDelta.reminder.queryId`
 * (Phase 3 forward-compat shim — `done-predicate-reminder-delivered.ts`).
 *
 * Boundary discipline:
 * - Lives in `src/agents/pi-embedded-runner/run/`, NOT in
 *   `src/platform/commitment/` — invariant #8.
 * - Reads STRUCTURAL inputs only (queryId, query shape, resultCount,
 *   sessionId, turnId). NEVER reads raw user text — invariants #5, #6.
 * - Failure surface is a closed string union (`transport_error` /
 *   `identity_unavailable` / `memory_store_unavailable` /
 *   `observer_unavailable`). The function NEVER throws — invariant
 *   #15. Reminder tracking is observability + done-predicate evidence,
 *   not gating; emit-site failure must not downgrade the calling
 *   commitment turn.
 *
 * The closed `query` shape is `ReminderQueryShape` from
 * `src/platform/reminder/` — slice K modules never receive
 * `RawUserTurn` / `UserPrompt`; the contractor is the only sanctioned
 * raw-text reader (#5/#6).
 */

import {
  type ReminderTurnKey,
  type ReminderWorldStateCollector,
} from "../../../platform/commitment/reminder-world-state-observer.js";
import type { SessionId } from "../../../platform/commitment/ids.js";
import type { ISO8601 } from "../../../platform/commitment/ids.js";
import type { ReminderQueryRecord } from "../../../platform/commitment/world-state.js";
import type { ReminderQueryShape } from "../../../platform/reminder/index.js";

export type RecordReminderQueriedInput = {
  /**
   * Append-only collector backing `WorldStateSnapshot.reminder`. In
   * production this is `getProcessReminderWorldStateCollector()` (the
   * singleton wired into `createDefaultMonitoredRuntime`); tests inject
   * a deterministic instance.
   */
  readonly collector: ReminderWorldStateCollector;
  readonly sessionId: SessionId;
  readonly turnId: string;
  readonly queryId: string;
  /**
   * The structured query that produced this record. Carried for
   * observability (logger emits `[reminder-runtime-adapter]` line
   * referencing the families filtered + the resolved identityId);
   * NEVER persisted into the WorldState. The `ownerIdentityId` field
   * is the canonical identity scope — when missing, the adapter
   * returns `identity_unavailable` without ever calling the collector
   * (defense-in-depth re: anonymous fail-closed; sub-plan acceptance
   * #8).
   */
  readonly query: ReminderQueryShape;
  readonly resultCount: number;
  /**
   * Optional sink for the `[reminder-runtime-adapter]` telemetry line.
   * Defaults to a no-op so tests do not pollute stdout; production
   * wiring (`recall-reminder-tool.ts`) injects the gateway logger.
   */
  readonly logger?: (line: string) => void;
};

export type RecordReminderQueriedFailureReason =
  | "transport_error"
  | "identity_unavailable"
  | "memory_store_unavailable"
  | "observer_unavailable";

export type RecordReminderQueriedResult =
  | {
      readonly ok: true;
      readonly queryId: string;
    }
  | {
      readonly ok: false;
      readonly reason: RecordReminderQueriedFailureReason;
      readonly detail?: string;
    };

/**
 * Records a reminder-query emit on the active turn. Returns a typed
 * result — never throws.
 *
 * The closed failure set is exhaustive:
 * - `observer_unavailable` — collector dependency missing (defensive
 *   guard for production wiring before the singleton is initialized);
 * - `identity_unavailable` — `query.ownerIdentityId` missing or empty
 *   (anonymous session — sub-plan acceptance #8 fail-closed marker);
 * - `memory_store_unavailable` — placeholder for Phase 4 callers that
 *   resolve a MemoryStore through a registry; surfaced when the
 *   resolver returns `undefined`. The adapter itself does not call the
 *   MemoryStore — the calling tool does — but we accept the closed
 *   reason so the caller can route a uniform failure shape through
 *   the same envelope.
 * - `transport_error` — collector throws (Zod schema rejection on
 *   malformed queryId / observedAt / negative resultCount).
 */
export function recordReminderQueried(
  input: RecordReminderQueriedInput,
): RecordReminderQueriedResult {
  if (!input.collector || typeof input.collector.record !== "function") {
    return { ok: false, reason: "observer_unavailable" };
  }

  // Defense-in-depth: the calling tool already fail-closes on anonymous
  // sessions before reaching here, but the adapter rechecks so a buggy
  // future caller cannot smuggle a ZERO-identity emit past the gate
  // (sub-plan acceptance #8).
  const ownerIdentityId =
    typeof input.query?.ownerIdentityId === "string"
      ? input.query.ownerIdentityId.trim()
      : "";
  if (ownerIdentityId.length === 0) {
    return { ok: false, reason: "identity_unavailable" };
  }

  const queryId = typeof input.queryId === "string" ? input.queryId.trim() : "";
  if (queryId.length === 0) {
    // Empty queryId is a caller bug; surface as transport_error so the
    // failure set stays closed without inventing a NEW reason for a
    // structural-input violation (the closed set is exhausted by the
    // four reasons above).
    return {
      ok: false,
      reason: "transport_error",
      detail: "queryId must be a non-empty string",
    };
  }

  if (
    typeof input.resultCount !== "number" ||
    !Number.isInteger(input.resultCount) ||
    input.resultCount < 0
  ) {
    return {
      ok: false,
      reason: "transport_error",
      detail: "resultCount must be a non-negative integer",
    };
  }

  const observedAt = new Date().toISOString();

  const record: ReminderQueryRecord = {
    queryId,
    resultCount: input.resultCount,
    observedAt: observedAt as ISO8601,
  };

  const turnKey: ReminderTurnKey = {
    sessionId: input.sessionId,
    turnId: input.turnId,
  };

  try {
    input.collector.record(record, turnKey);
  } catch (err) {
    return {
      ok: false,
      reason: "transport_error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const familiesField = input.query.effectFamilyFilter
    ? `[${input.query.effectFamilyFilter.join(",")}]`
    : "(default)";
  input.logger?.(
    `[reminder-runtime-adapter] recordReminderQueried queryId=${queryId} sessionId=${input.sessionId} turnId=${input.turnId} resultCount=${input.resultCount} families=${familiesField} identityId=${ownerIdentityId}`,
  );

  return { ok: true, queryId };
}
