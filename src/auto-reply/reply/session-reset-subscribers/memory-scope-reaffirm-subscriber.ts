/**
 * NEW-B Phase 4 — `subscriber:memory-scope-reaffirm`.
 *
 * Observability-only subscriber that REAFFIRMS the slice E PR-#170
 * contract: operator memory (`MemoryStore`) is identity-scoped, not
 * session-scoped, and SURVIVES `/new` BY DESIGN. The unified-reset bus
 * iterates this subscriber so the structured log line + per-subscriber
 * outcome surface make the no-clear decision auditable on every reset.
 *
 * Per Phase 1 audit §a row 11 the canonical posture is:
 *   `kind: 'skipped', reason: 'identity-scoped — survives /new by design'`
 *
 * Boundary discipline:
 * - Does NOT touch `MemoryStore` (no read, no write, no list, no
 *   forget). The subscriber is a typed no-op — its sole purpose is to
 *   appear in the registry so the Phase 6 `subscribers=N` assertion
 *   stays exact.
 * - Does NOT depend on the frozen 5 contracts; lives in
 *   `src/auto-reply/reply/session-reset-subscribers/` (decision-adjacent)
 *   per invariant #8.
 * - Failure-isolated: cannot throw because there is no work to throw
 *   from; the try/catch is symmetric with the other subscribers in
 *   case future telemetry is added.
 */

import {
  asSessionResetSubscriberId,
  type SessionResetEvent,
  type SessionResetSubscriber,
  type SessionResetSubscriberOutcome,
} from "../../../platform/session/reset.js";

const SUBSCRIBER_ID = asSessionResetSubscriberId(
  "subscriber:memory-scope-reaffirm",
);

const REAFFIRM_REASON =
  "identity-scoped — survives /new by design (slice E B1)";

/**
 * Construct the memory-scope-reaffirm subscriber. Returns a fresh
 * subscriber instance — no DI required (no work) but the factory shape
 * matches the rest of Phase 4 for symmetry.
 */
export function createMemoryScopeReaffirmSubscriber(): SessionResetSubscriber {
  return {
    id: SUBSCRIBER_ID,
    category: "memory-scope",
    async onReset(
      _event: SessionResetEvent,
    ): Promise<SessionResetSubscriberOutcome> {
      return { kind: "skipped", reason: REAFFIRM_REASON };
    },
  };
}
