/**
 * NEW-B Phase 4 — `subscriber:memory-wiring-resolver-clear`.
 *
 * Observability-only subscriber that REAFFIRMS the Phase 1 audit
 * finding (`extensions/AUDIT-unified-session-reset.md` §a row 10): the
 * `memory-wiring.ts` resolver is a PURE FACTORY rebuilt on every turn
 * from the process-scoped `getMemoryRuntime(cfg)` runtime — there is
 * no per-turn cache to invalidate. The subscriber surfaces this in the
 * structured-log line so reviewers can confirm the no-clear decision
 * was intentional.
 *
 * Per audit row 10 the canonical posture is:
 *   `kind: 'skipped',
 *    reason: 'memory-wiring resolver is a per-turn pure factory — no cache to clear (audit §a row 10)'`
 *
 * If a future slice introduces a per-(sessionId, turnId) cache on the
 * resolver layer (e.g. memo'ing the identity-resolution probe), the
 * optional `clearCache` dep below provides the wiring point — flipping
 * this subscriber to `kind: 'cleared'` is then a one-line change.
 *
 * Boundary discipline: lives in
 * `src/auto-reply/reply/session-reset-subscribers/` per spec table
 * row 8. No frozen-layer touch.
 */

import {
  asSessionResetSubscriberId,
  type SessionResetEvent,
  type SessionResetSubscriber,
  type SessionResetSubscriberOutcome,
} from "../../../platform/session/reset.js";

export type MemoryWiringResolverSubscriberDeps = {
  /**
   * Optional per-(sessionId, turnId) cache invalidator. Production
   * default is `undefined` per audit §a row 10 (no cache exists).
   */
  readonly clearCache?: (sessionId: string) => number;
};

const SUBSCRIBER_ID = asSessionResetSubscriberId(
  "subscriber:memory-wiring-resolver-clear",
);

const SKIP_REASON =
  "memory-wiring resolver is a per-turn pure factory — no cache to clear (audit §a row 10)";

export function createMemoryWiringResolverSubscriber(
  deps: MemoryWiringResolverSubscriberDeps = {},
): SessionResetSubscriber {
  return {
    id: SUBSCRIBER_ID,
    category: "misc",
    async onReset(
      event: SessionResetEvent,
    ): Promise<SessionResetSubscriberOutcome> {
      if (deps.clearCache === undefined) {
        return { kind: "skipped", reason: SKIP_REASON };
      }
      try {
        const target = event.previousSessionId ?? event.sessionId;
        const cleared = deps.clearCache(target);
        if (cleared > 0) {
          return {
            kind: "cleared",
            details: { sessionId: target, entriesCleared: cleared },
          };
        }
        return { kind: "skipped", reason: "no_cache_entries_for_session" };
      } catch (error: unknown) {
        const reason =
          error instanceof Error ? error.message : `non_error_throw:${String(error)}`;
        return { kind: "failed", reason };
      }
    },
  };
}
