/**
 * NEW-B Phase 4 — `subscriber:world-state-sessions-current-flip`.
 *
 * Frozen-layer adapter for the
 * `SessionWorldStateObserver`/`WorldStateSnapshot.sessions` slice. Per
 * Phase 1 audit §a row 8 + §d row 8, the `WorldStateSnapshot.sessions`
 * field is a PURE PROJECTION derived dynamically from
 * `getSubagentRunsSnapshotForRead(inMemoryRuns)`
 * (`src/platform/commitment/session-world-state-observer.ts:24-49`).
 * There is no "current pointer" to flip — the followup-registry
 * field is rebuilt on every `observe()` call from the live subagent
 * runs Map, so a session rotation has no derived-view side effect.
 *
 * Per audit posture, the canonical outcome is
 *   `kind: 'skipped', reason: 'derived projection — no per-session pointer to flip'`
 *
 * The optional `flipCurrentSession` dep is shaped so a successor slice
 * (e.g. one that materialises a per-snapshot current-session pointer
 * for cron / multi-tenant routing) can ADDITIVELY supply a real
 * implementation and flip this subscriber to `kind: 'cleared'` without
 * widening the interface.
 *
 * Boundary discipline: lives in
 * `src/agents/pi-embedded-runner/run/session-reset-subscribers/` per
 * the established frozen-layer adapter precedent (slice E P5 / slice F
 * P5 / cutover-3 P5). Imports types from
 * `src/platform/session/reset.ts`, NOT from `src/platform/commitment/`.
 */

import {
  asSessionResetSubscriberId,
  type SessionResetEvent,
  type SessionResetSubscriber,
  type SessionResetSubscriberOutcome,
} from "../../../../platform/session/reset.js";

/**
 * Optional dep — bound only if a future cutover materialises a real
 * per-snapshot current-session pointer. Today this is `undefined` for
 * production callers (audit §a row 8 confirms the field is a derived
 * projection).
 */
export type WorldStateSessionsSubscriberDeps = {
  /**
   * Optional flip function. Receives the new sessionId; returns `true`
   * if a flip was performed (i.e. the underlying state actually
   * rotated). When `undefined` (production default per audit) the
   * subscriber emits `kind: 'skipped'`.
   */
  readonly flipCurrentSession?: (sessionId: string) => boolean;
};

const SUBSCRIBER_ID = asSessionResetSubscriberId(
  "subscriber:world-state-sessions-current-flip",
);

const SKIP_REASON =
  "derived projection — no per-session pointer to flip (audit §a row 8 / §d row 8)";

export function createWorldStateSessionsSubscriber(
  deps: WorldStateSessionsSubscriberDeps = {},
): SessionResetSubscriber {
  return {
    id: SUBSCRIBER_ID,
    category: "world-state",
    async onReset(
      event: SessionResetEvent,
    ): Promise<SessionResetSubscriberOutcome> {
      if (deps.flipCurrentSession === undefined) {
        return { kind: "skipped", reason: SKIP_REASON };
      }
      try {
        const flipped = deps.flipCurrentSession(event.sessionId);
        if (flipped) {
          return {
            kind: "cleared",
            details: { sessionId: event.sessionId },
          };
        }
        return { kind: "skipped", reason: "no_pointer_change" };
      } catch (error: unknown) {
        const reason =
          error instanceof Error ? error.message : `non_error_throw:${String(error)}`;
        return { kind: "failed", reason };
      }
    },
  };
}
