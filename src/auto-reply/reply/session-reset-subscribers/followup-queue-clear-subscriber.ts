/**
 * NEW-B Phase 4 — `subscriber:followup-queue-clear`.
 *
 * PRIMARY fix for the live-reproduced 2026-05-06 18:25-18:27 leak.
 * Per Phase 1 audit (`extensions/AUDIT-unified-session-reset.md` §f),
 * the leak is `FOLLOWUP_QUEUES` (`src/auto-reply/reply/queue/state.ts:46-50`),
 * not chat-history kv. The auto-reply `/new` path (`session.ts`) does
 * NOT call `clearFollowupQueue` while the gateway-RPC reset path
 * (`session-reset-service.ts:128-133`) DOES — that is the asymmetry
 * this subscriber closes.
 *
 * The subscriber owns NO state of its own; it adapts the existing
 * `clearFollowupQueue(sessionKey)` API into the subscriber bus so the
 * `/new` and gateway-RPC reset paths converge on a single call site
 * once Phase 5 wires the bus into `session.ts`.
 *
 * Boundary discipline:
 * - Lives in `src/auto-reply/reply/session-reset-subscribers/`, NOT in
 *   `src/platform/commitment/` (invariant #8).
 * - Calls `clearFollowupQueue` from `src/auto-reply/reply/queue/state.ts`
 *   via DI (not a direct module import) so the test can stub the dep
 *   without `vi.spyOn` on the subscriber under test.
 * - Failure-isolated: the subscriber's `onReset` never throws; backend
 *   throws are converted to `kind: 'failed'` so the surrounding
 *   `resetTurnSession()` summary still completes.
 */

import {
  asSessionResetSubscriberId,
  type SessionResetEvent,
  type SessionResetSubscriber,
  type SessionResetSubscriberOutcome,
} from "../../../platform/session/reset.js";

/**
 * Dependency surface — the subscriber needs ONE thing: a function that
 * clears the followup queue for a given `sessionKey`. The production
 * binding is `clearFollowupQueue` from
 * `src/auto-reply/reply/queue/state.ts`. Tests inject a stub.
 */
export type FollowupQueueClearSubscriberDeps = {
  /**
   * Clear every queued followup run for the supplied `sessionKey`.
   * Returns the number of queue entries cleared (items + dropped). The
   * production implementation lives at `state.ts:294-310`.
   */
  readonly clearFollowupQueue: (sessionKey: string) => number;
};

const SUBSCRIBER_ID = asSessionResetSubscriberId(
  "subscriber:followup-queue-clear",
);

/**
 * Construct the followup-queue-clear subscriber. Each call returns a
 * fresh subscriber instance bound to the supplied `deps` so multiple
 * registries (e.g. the production singleton and an isolated test
 * registry) can coexist without coupling.
 */
export function createFollowupQueueClearSubscriber(
  deps: FollowupQueueClearSubscriberDeps,
): SessionResetSubscriber {
  return {
    id: SUBSCRIBER_ID,
    category: "chat-history",
    async onReset(
      event: SessionResetEvent,
    ): Promise<SessionResetSubscriberOutcome> {
      try {
        const cleared = deps.clearFollowupQueue(event.sessionKey);
        if (cleared > 0) {
          return {
            kind: "cleared",
            details: {
              sessionKey: event.sessionKey,
              entriesCleared: cleared,
            },
          };
        }
        return {
          kind: "skipped",
          reason: "no_queued_followups",
        };
      } catch (error: unknown) {
        const reason =
          error instanceof Error ? error.message : `non_error_throw:${String(error)}`;
        return { kind: "failed", reason };
      }
    },
  };
}
