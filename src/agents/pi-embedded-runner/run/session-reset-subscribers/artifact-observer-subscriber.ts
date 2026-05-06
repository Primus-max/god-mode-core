/**
 * NEW-B Phase 4 — `subscriber:artifact-observer-clear`.
 *
 * Frozen-layer adapter that lives at the established
 * `src/agents/pi-embedded-runner/run/` bridge boundary (per invariant
 * #8). The adapter integrates the `ArtifactWorldStateCollector`
 * (`src/platform/commitment/artifact-world-state-observer.ts`) into the
 * unified-reset bus WITHOUT modifying the frozen-layer source — the
 * subscriber calls only existing public APIs.
 *
 * Per Phase 1 audit §g, the collector's `(sessionId, turnId)` keying
 * naturally orphans old-session buckets on every rotation — there is
 * NO `clearForSession(sessionId)` method on the collector interface
 * today and the audit decision is NO API addition. The subscriber
 * therefore ships as a typed `kind: 'skipped'` no-op; observability
 * only.
 *
 * If a future memory-profiling pass shows growth (slice K cron / slice
 * J subagent recursion), Phase 4 can ADDITIVELY add a
 * `clearForSession(sessionId)` method via the cutover-2 P3 / slice E P6
 * / cutover-3 P3 precedent and flip this subscriber to
 * `kind: 'cleared'`. The adapter signature is purposely shaped to
 * accept that future API: the optional `clearForSession` dep is wired
 * here so the flip is a one-line change.
 *
 * Boundary discipline:
 * - File path is INSIDE `src/agents/pi-embedded-runner/run/` per the
 *   established frozen-layer adapter precedent (slice E P5
 *   `memory-write-on-satisfied.ts`, slice F P5
 *   `task-write-on-satisfied.ts`, cutover-3 P5
 *   `recordArtifactOnCommitmentSatisfied.ts`).
 * - Imports `SessionResetSubscriber` types from
 *   `src/platform/session/reset.ts` (decision-adjacent), NOT from
 *   `src/platform/commitment/`.
 * - Does NOT touch the frozen-layer collector source. The optional dep
 *   binding leaves the door open for an additive API in a successor
 *   slice.
 */

import {
  asSessionResetSubscriberId,
  type SessionResetEvent,
  type SessionResetSubscriber,
  type SessionResetSubscriberOutcome,
} from "../../../../platform/session/reset.js";

/**
 * Optional dep — bound only if a future cutover lands a
 * `clearForSession(sessionId)` API on `ArtifactWorldStateCollector`.
 * Today this is `undefined` for production callers; tests can inject
 * a stub to verify the future-flip path.
 */
export type ArtifactObserverSubscriberDeps = {
  /**
   * Optional clear-for-session function. When `undefined` (production
   * default per audit §g) the subscriber emits `kind: 'skipped'`.
   * When defined the subscriber invokes it with `previousSessionId`
   * (or `sessionId` if `previousSessionId` is absent) and emits
   * `kind: 'cleared'` with the per-session bucket count returned.
   */
  readonly clearForSession?: (sessionId: string) => number;
};

const SUBSCRIBER_ID = asSessionResetSubscriberId(
  "subscriber:artifact-observer-clear",
);

const SKIP_REASON =
  "(sessionId, turnId) keying naturally orphans old-session buckets — audit §g default";

/**
 * Construct the artifact-observer subscriber. Production binding omits
 * `clearForSession` (no API exists today); audit §g + blanket signoff
 * 2026-05-05 confirm the no-op posture.
 */
export function createArtifactObserverSubscriber(
  deps: ArtifactObserverSubscriberDeps = {},
): SessionResetSubscriber {
  return {
    id: SUBSCRIBER_ID,
    category: "observer",
    async onReset(
      event: SessionResetEvent,
    ): Promise<SessionResetSubscriberOutcome> {
      if (deps.clearForSession === undefined) {
        return { kind: "skipped", reason: SKIP_REASON };
      }
      try {
        const target = event.previousSessionId ?? event.sessionId;
        const cleared = deps.clearForSession(target);
        if (cleared > 0) {
          return {
            kind: "cleared",
            details: {
              sessionId: target,
              bucketsCleared: cleared,
            },
          };
        }
        return { kind: "skipped", reason: "no_buckets_for_session" };
      } catch (error: unknown) {
        const reason =
          error instanceof Error ? error.message : `non_error_throw:${String(error)}`;
        return { kind: "failed", reason };
      }
    },
  };
}
