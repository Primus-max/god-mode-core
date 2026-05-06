/**
 * NEW-B Phase 4 — `subscriber:intent-ledger-clear`.
 *
 * Co-located with the rest of `src/platform/session/` (sibling of
 * `intent-ledger.ts` and `reset.ts`). Adapter that wires the
 * `IntentLedger.invalidate(predicate)` API into the unified-reset bus
 * so per-session ledger entries for the rotating `previousSessionId`
 * are dropped explicitly instead of being silently orphaned.
 *
 * Per Phase 1 audit §a rows 4-6 the ledger entries today are
 * sessionId-scoped (composite key `${sessionId}::${channelId}`) and
 * become unreachable on rotation but are NOT actively cleared. This
 * subscriber makes the cleanup explicit and observable through the
 * structured log line.
 *
 * Boundary discipline:
 * - Lives INSIDE `src/platform/session/` per spec table row 6 — the
 *   intent-ledger module is decision-adjacent, not frozen-layer; no
 *   invariant-#8 violation.
 * - Calls `IntentLedger.invalidate(predicate)` via DI rather than via
 *   the singleton import so tests can pass an isolated ledger
 *   instance.
 * - The predicate matches on `entry.sessionId === previousSessionId`
 *   so rotation-triggered events drop only the leaving session's
 *   rows; entries under the new sessionId are preserved.
 * - Failure-isolated try/catch around the invalidate call.
 */

import {
  asSessionResetSubscriberId,
  type SessionResetEvent,
  type SessionResetSubscriber,
  type SessionResetSubscriberOutcome,
} from "./reset.js";

/**
 * Minimal structural shape the subscriber needs from `IntentLedger`.
 * Defined as a dep type rather than imported from the ledger module
 * so test code can pass a fixture without instantiating the whole
 * ledger (the ledger has a process-singleton at
 * `intent-ledger.ts:718` whose state would otherwise leak between
 * tests).
 */
export type IntentLedgerInvalidator = {
  /**
   * Drop every entry for which `predicate(entry)` returns `true`.
   * Returns the number of dropped entries. Mirrors
   * `IntentLedger.invalidate` at `intent-ledger.ts:679-701`.
   */
  invalidate(predicate: (entry: { sessionId: string }) => boolean): number;
};

export type IntentLedgerResetSubscriberDeps = {
  readonly ledger: IntentLedgerInvalidator;
};

const SUBSCRIBER_ID = asSessionResetSubscriberId(
  "subscriber:intent-ledger-clear",
);

export function createIntentLedgerResetSubscriber(
  deps: IntentLedgerResetSubscriberDeps,
): SessionResetSubscriber {
  return {
    id: SUBSCRIBER_ID,
    category: "misc",
    async onReset(
      event: SessionResetEvent,
    ): Promise<SessionResetSubscriberOutcome> {
      // Without a previousSessionId there is no "rotating" session to
      // clean up — we still surface the call as observability.
      const target = event.previousSessionId;
      if (target === undefined) {
        return {
          kind: "skipped",
          reason: "no_previous_session_id",
        };
      }
      try {
        const removed = deps.ledger.invalidate(
          (entry) => entry.sessionId === target,
        );
        if (removed > 0) {
          return {
            kind: "cleared",
            details: { sessionId: target, entriesCleared: removed },
          };
        }
        return { kind: "skipped", reason: "no_entries_for_session" };
      } catch (error: unknown) {
        const reason =
          error instanceof Error ? error.message : `non_error_throw:${String(error)}`;
        return { kind: "failed", reason };
      }
    },
  };
}
