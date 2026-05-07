/**
 * Cron/Scheduler Phase 5 — cron-fire callback for reminder.set.
 *
 * Invoked by the existing cron scheduler when a `kind:'at'` reminder
 * job reaches its `fireAt` boundary. The callback:
 *  1. loads the matching `ReminderRecord` from the injected
 *     `ReminderStore` keyed on `(reminderId, ownerIdentityId)` —
 *     cross-identity reads return `undefined` (defense in depth);
 *  2. marks `status='fired'` (idempotent on retry — `markFired` no-ops
 *     when the record is already `fired`);
 *  3. constructs a `ReminderFireDispatchPayload` carrying
 *     `wrappedScopeIdentityId = record.ownerIdentityId` (slice K
 *     precedent — the fired turn respects the operator's identity scope
 *     even though no operator-initiated request triggered it);
 *  4. calls the injected `deliveryDispatch` (production wires through
 *     `dispatchCronDelivery` from `delivery-dispatch.ts` — REUSE, no
 *     fork);
 *  5. returns a typed envelope. NEVER throws (invariant #15).
 *
 * Boundary discipline:
 *  - Lives in `src/cron/isolated-agent/`, alongside the existing cron-
 *    fired turn execution (`run.ts`) + delivery dispatch
 *    (`delivery-dispatch.ts`).
 *  - Reads STRUCTURAL inputs only — never raw user text (#5/#6).
 *  - `deliveryDispatch` is dependency-injected as a closed-shape
 *    function so the callback stays decoupled from the production
 *    cron-delivery internals (mirrors the `cronAdd` injection in
 *    `record-reminder-tool.ts`).
 *  - Identity NEVER cross-leaks: every `ReminderStore.get` predicates
 *    on the injected `identityId`, and the dispatch payload carries
 *    the persisted record's `ownerIdentityId` (NOT a caller-supplied
 *    value — see the `identity_mismatch` reverse test).
 */

import type { IdentityId } from "../../platform/identity/identity-id.js";
import { isIdentityId } from "../../platform/identity/identity-id.js";
import type { ReminderRecord, ReminderStore } from "../../platform/reminder/reminder-store.js";

/**
 * Closed-shape payload handed to the injected delivery sink. The
 * `wrappedScopeIdentityId` field MUST be the persisted record's
 * `ownerIdentityId` — the cron driver does not have direct access to
 * the operator's session scope, so we re-inject the identity at the
 * delivery boundary so identity NEVER cross-leaks (slice K precedent;
 * sub-plan §1 todo Phase 5 acceptance).
 */
export type ReminderFireDispatchPayload = {
  readonly reminderId: string;
  readonly wrappedScopeIdentityId: IdentityId;
  readonly fireAt: string;
  readonly content: string;
  readonly channel: string;
  readonly to: string;
};

export type DeliveryDispatchResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type DeliveryDispatchFn = (
  payload: ReminderFireDispatchPayload,
) => Promise<DeliveryDispatchResult>;

export type FireReminderInput = {
  readonly reminderId: string;
  readonly ownerIdentityId: IdentityId;
  readonly reminderStore: ReminderStore | undefined;
  readonly deliveryDispatch: DeliveryDispatchFn;
  readonly logger?: (line: string) => void;
};

export type FireReminderFailureReason =
  | "reminder_store_unavailable"
  | "record_missing"
  | "dispatch_failed"
  | "identity_unavailable"
  | "internal_error";

export type FireReminderResult =
  | {
      readonly ok: true;
      readonly reminderId: string;
      readonly wrappedScopeIdentityId: IdentityId;
    }
  | {
      readonly ok: false;
      readonly reason: FireReminderFailureReason;
      readonly detail?: string;
    };

/**
 * Fires a registered reminder. NEVER throws — every failure path
 * returns a typed envelope (invariant #15).
 */
export async function fireReminder(
  input: FireReminderInput,
): Promise<FireReminderResult> {
  if (input === null || typeof input !== "object") {
    return { ok: false, reason: "internal_error" };
  }

  const ownerIdentityIdRaw =
    typeof input.ownerIdentityId === "string"
      ? (input.ownerIdentityId as string).trim()
      : "";
  if (ownerIdentityIdRaw.length === 0 || !isIdentityId(ownerIdentityIdRaw)) {
    return { ok: false, reason: "identity_unavailable" };
  }
  const identityId = ownerIdentityIdRaw as IdentityId;

  if (
    !input.reminderStore ||
    typeof input.reminderStore.get !== "function" ||
    typeof input.reminderStore.markFired !== "function"
  ) {
    return { ok: false, reason: "reminder_store_unavailable" };
  }

  const reminderId =
    typeof input.reminderId === "string" ? input.reminderId.trim() : "";
  if (reminderId.length === 0) {
    return { ok: false, reason: "record_missing" };
  }

  let record: ReminderRecord | undefined;
  try {
    record = await input.reminderStore.get(reminderId, identityId);
  } catch (err) {
    return {
      ok: false,
      reason: "reminder_store_unavailable",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!record) {
    // Either the record was never persisted, or `(reminderId,
    // identityId)` does not match (cross-identity defense — the get()
    // predicate filters by `identity_id = ?` at the SQL layer in Phase
    // 6; the in-memory impl filters in code).
    return { ok: false, reason: "record_missing", detail: reminderId };
  }

  // 2. Mark fired BEFORE dispatch — idempotent on retry. If dispatch
  //    fails, the cron driver will not replay infinitely (the record
  //    is `fired`, so the next callback no-ops). The operator-facing
  //    failure is surfaced via the dispatch result envelope; live-
  //    verify (Phase 8) flags missed deliveries via the
  //    `[telegram] sendMessage` log absence.
  try {
    await input.reminderStore.markFired(reminderId, identityId);
  } catch (err) {
    return {
      ok: false,
      reason: "internal_error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // 3. Construct dispatch payload — `wrappedScopeIdentityId` is the
  //    persisted record's `ownerIdentityId`, NOT a caller-supplied
  //    value (defense in depth).
  const payload: ReminderFireDispatchPayload = {
    reminderId: record.reminderId,
    wrappedScopeIdentityId: record.ownerIdentityId,
    fireAt: record.fireAt,
    content: record.content,
    channel: record.deliveryChannel,
    to: record.deliveryTo,
  };

  input.logger?.(
    `[reminder-fire-callback] reminderId=${record.reminderId} wrappedScopeIdentityId=${record.ownerIdentityId} channel=${record.deliveryChannel} to=${record.deliveryTo}`,
  );

  // 4. Call deliveryDispatch — REUSE existing transport (sub-plan §1
  //    todo Phase 5 — `delivery-dispatch.ts` not forked). On dispatch
  //    failure we surface `dispatch_failed`; the record stays `fired`
  //    so we don't replay (operator can re-issue manually).
  let dispatchResult: DeliveryDispatchResult;
  try {
    dispatchResult = await input.deliveryDispatch(payload);
  } catch (err) {
    return {
      ok: false,
      reason: "dispatch_failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!dispatchResult.ok) {
    return {
      ok: false,
      reason: "dispatch_failed",
      detail: dispatchResult.reason,
    };
  }

  return {
    ok: true,
    reminderId: record.reminderId,
    wrappedScopeIdentityId: record.ownerIdentityId,
  };
}
