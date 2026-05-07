/**
 * Cron/Scheduler Phase 5 — scheduled-reminder runtime adapter.
 *
 * Sibling of Cutover-3 P5 `artifact-runtime-adapter.ts` and Cutover-4 P5
 * `repo-runtime-adapter.ts`. The adapter is the WRITE side of the
 * Cron/Scheduler Phase 3 `WorldStateSnapshot.scheduledReminders` slice:
 * it receives a structural `ReminderSetShape` produced by the Phase 5
 * `RecordReminderTool`, validates the `fireAt` ISO-8601 + identity +
 * channel surface, appends a `ScheduledReminderRecord` to the injected
 * `ScheduledReminderWorldStateCollector`, and emits the matching
 * `ExpectedDelta.scheduledReminders.added` so the Phase 4
 * `reminderSetPredicate` can resolve the `reminderId` on
 * `commitmentSatisfied`.
 *
 * Boundary discipline:
 * - Lives in `src/agents/pi-embedded-runner/run/`, NOT in
 *   `src/platform/commitment/` — invariant #8. (The sub-plan §1 todo
 *   names `src/platform/reminder/` for symmetry with slice K's recall
 *   surface; we keep the adapter alongside the cutover-3 / cutover-4 /
 *   slice K WRITE adapters that all live in `pi-embedded-runner/run/`
 *   so the import surface stays uniform — `src/platform/reminder/`
 *   imports ONLY identity/memory/Zod/stdlib per invariant #8.)
 * - Reads STRUCTURAL inputs only (`reminderId`, `ownerIdentityId` brand,
 *   `fireAt` ISO-8601, structured channel + target). NEVER reads raw
 *   user text — invariants #5, #6.
 * - Failure surface is a closed string union
 *   (`transport_error` / `identity_unavailable` / `fire_at_invalid` /
 *   `fire_at_in_past` / `observer_unavailable` /
 *   `reminder_store_unavailable` / `channel_invalid`). The function
 *   NEVER throws — invariant #15. Reminder tracking is observability
 *   plus done-predicate evidence, not gating; emit-site failure must
 *   not downgrade the calling commitment turn.
 *
 * Identity is the canonical scope (slice K precedent + sub-plan §1
 * todo): adapter rechecks `ownerIdentityId` non-empty even though the
 * tool fail-closes earlier — defense in depth so a buggy future caller
 * cannot smuggle a ZERO-identity emit past the gate.
 */

import {
  type ScheduledReminderTurnKey,
  type ScheduledReminderWorldStateCollector,
} from "../../../platform/commitment/scheduled-reminder-world-state-observer.js";
import type { ChannelId, ISO8601, SessionId } from "../../../platform/commitment/ids.js";
import type {
  ExpectedDelta,
  ScheduledRemindersExpectedDelta,
} from "../../../platform/commitment/expected-delta.js";
import type { ScheduledReminderRecord } from "../../../platform/commitment/world-state.js";
import { isIdentityId, type IdentityId } from "../../../platform/identity/identity-id.js";

const ISO8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

export type RecordReminderScheduledInput = {
  /**
   * Append-only collector backing `WorldStateSnapshot.scheduledReminders`.
   * Production wires `getProcessScheduledReminderWorldStateCollector()`
   * (the singleton wired into `createDefaultMonitoredRuntime` in Phase 3);
   * tests inject a deterministic instance.
   */
  readonly collector: ScheduledReminderWorldStateCollector;
  readonly sessionId: SessionId;
  readonly turnId: string;
  readonly reminderId: string;
  readonly ownerIdentityId: IdentityId;
  /** ISO-8601 timestamp; must be in the future against `now()`. */
  readonly fireAt: string;
  readonly content: string;
  readonly deliveryChannel: ChannelId;
  readonly deliveryTo: string;
  /**
   * Injected clock — defaults to `Date.now`. Tests pin a deterministic
   * value to exercise the `fire_at_in_past` boundary. Same dependency-
   * injection pattern as the cron-fire callback.
   */
  readonly now?: () => number;
  /**
   * Optional sink for the `[scheduled-reminder-runtime-adapter]`
   * telemetry line. Defaults to a no-op so tests do not pollute stdout;
   * production wiring (`record-reminder-tool.ts`) injects the gateway
   * logger.
   */
  readonly logger?: (line: string) => void;
};

export type RecordReminderScheduledFailureReason =
  | "transport_error"
  | "identity_unavailable"
  | "fire_at_invalid"
  | "fire_at_in_past"
  | "observer_unavailable"
  | "reminder_store_unavailable"
  | "channel_invalid";

export type RecordReminderScheduledResult =
  | {
      readonly ok: true;
      readonly reminderId: string;
      readonly expectedDelta: ExpectedDelta;
    }
  | {
      readonly ok: false;
      readonly reason: RecordReminderScheduledFailureReason;
      readonly detail?: string;
    };

/**
 * Records a scheduled reminder on the active turn. Returns a typed
 * result — never throws.
 *
 * The closed failure set is exhaustive:
 * - `observer_unavailable` — collector dependency missing (defensive
 *   guard for production wiring before the singleton is initialized);
 * - `identity_unavailable` — `ownerIdentityId` empty / unbranded
 *   (anonymous fail-closed — sub-plan §1 todo Phase 5);
 * - `fire_at_invalid` — `fireAt` not a valid ISO-8601 string;
 * - `fire_at_in_past` — `fireAt` resolves before `now()`;
 * - `channel_invalid` — `deliveryChannel` / `deliveryTo` empty;
 * - `reminder_store_unavailable` — surfaced by the calling tool when the
 *   `ReminderStore` resolver returns `undefined`. The adapter itself
 *   does not call the ReminderStore — the calling tool does — but we
 *   accept the closed reason in the union so callers can route a
 *   uniform failure shape through the same envelope (slice K
 *   `memory_store_unavailable` precedent);
 * - `transport_error` — collector throws (Zod schema rejection on
 *   malformed timestamp / identity / oversize content).
 *
 * The `expectedDelta` returned on success carries
 * `scheduledReminders.added: [reminderId]`. Callers MERGE this into the
 * commitment-runtime `expectedDelta` before invoking
 * `monitoredRuntime.run(...)` so the Phase 4 done-predicate resolves the
 * reminderId.
 */
export function recordReminderScheduled(
  input: RecordReminderScheduledInput,
): RecordReminderScheduledResult {
  const collector = input?.collector;
  if (!collector || typeof collector.record !== "function") {
    return { ok: false, reason: "observer_unavailable" };
  }

  // Defense-in-depth: the calling tool already fail-closes on anonymous
  // sessions before reaching here, but the adapter rechecks so a buggy
  // future caller cannot smuggle a ZERO-identity emit past the gate
  // (sub-plan §1 todo Phase 5).
  const ownerIdentityIdRaw =
    typeof input.ownerIdentityId === "string" ? input.ownerIdentityId.trim() : "";
  if (ownerIdentityIdRaw.length === 0 || !isIdentityId(ownerIdentityIdRaw)) {
    return { ok: false, reason: "identity_unavailable" };
  }
  const ownerIdentityId = ownerIdentityIdRaw as IdentityId;

  const reminderId =
    typeof input.reminderId === "string" ? input.reminderId.trim() : "";
  if (reminderId.length === 0) {
    return {
      ok: false,
      reason: "transport_error",
      detail: "reminderId must be a non-empty string",
    };
  }

  const fireAt = typeof input.fireAt === "string" ? input.fireAt.trim() : "";
  if (fireAt.length === 0 || !ISO8601_PATTERN.test(fireAt)) {
    return { ok: false, reason: "fire_at_invalid", detail: fireAt };
  }
  const fireAtMs = Date.parse(fireAt);
  if (Number.isNaN(fireAtMs)) {
    return { ok: false, reason: "fire_at_invalid", detail: fireAt };
  }
  const nowMs = (input.now ?? Date.now)();
  if (fireAtMs < nowMs) {
    return {
      ok: false,
      reason: "fire_at_in_past",
      detail: `fireAt=${fireAt} now=${new Date(nowMs).toISOString()}`,
    };
  }

  const channel = typeof input.deliveryChannel === "string"
    ? input.deliveryChannel.trim()
    : "";
  const to = typeof input.deliveryTo === "string" ? input.deliveryTo.trim() : "";
  if (channel.length === 0 || to.length === 0) {
    return { ok: false, reason: "channel_invalid" };
  }

  const content = typeof input.content === "string" ? input.content : "";
  const createdAt = new Date(nowMs).toISOString();

  const record: ScheduledReminderRecord = {
    reminderId,
    ownerIdentityId,
    fireAt: fireAt as ISO8601,
    content,
    deliveryChannel: channel as ChannelId,
    deliveryTo: to,
    createdAt: createdAt as ISO8601,
    status: "pending" as const,
  };

  const turnKey: ScheduledReminderTurnKey = {
    sessionId: input.sessionId,
    turnId: input.turnId,
  };

  try {
    collector.record(record, turnKey);
  } catch (err) {
    return {
      ok: false,
      reason: "transport_error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  input.logger?.(
    `[scheduled-reminder-runtime-adapter] recordReminderScheduled reminderId=${reminderId} fireAt=${fireAt} sessionId=${input.sessionId} turnId=${input.turnId} identityId=${ownerIdentityId} channel=${channel}`,
  );

  const scheduledReminders: ScheduledRemindersExpectedDelta = {
    added: Object.freeze([reminderId]),
  };
  const expectedDelta: ExpectedDelta = { scheduledReminders };

  return { ok: true, reminderId, expectedDelta };
}
