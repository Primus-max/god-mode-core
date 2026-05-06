/**
 * NEW-B Phase 4 — `subscriber:task-scope-reaffirm`.
 *
 * Sibling of `subscriber:memory-scope-reaffirm`. Observability-only
 * subscriber that REAFFIRMS the slice F PR-#188 contract: TaskLedger
 * records are identity-scoped (per `IdentityId`) and SURVIVE `/new` BY
 * DESIGN — the operator's open / completed / cancelled tasks remain
 * visible after a session rotation.
 *
 * Per Phase 1 audit §a row 12 the canonical posture is:
 *   `kind: 'skipped', reason: 'identity-scoped — survives /new by design (slice F B7)'`
 *
 * Boundary discipline: same as the memory-scope variant — no
 * `TaskLedger` read/write/list/update; lives in
 * `src/auto-reply/reply/session-reset-subscribers/` (decision-adjacent)
 * per invariant #8; cannot throw because there is no work.
 */

import {
  asSessionResetSubscriberId,
  type SessionResetEvent,
  type SessionResetSubscriber,
  type SessionResetSubscriberOutcome,
} from "../../../platform/session/reset.js";

const SUBSCRIBER_ID = asSessionResetSubscriberId(
  "subscriber:task-scope-reaffirm",
);

const REAFFIRM_REASON =
  "identity-scoped — survives /new by design (slice F B7)";

/**
 * Construct the task-scope-reaffirm subscriber. Returns a fresh
 * subscriber instance — no DI required (no work) but the factory shape
 * matches the rest of Phase 4 for symmetry.
 */
export function createTaskScopeReaffirmSubscriber(): SessionResetSubscriber {
  return {
    id: SUBSCRIBER_ID,
    category: "task-scope",
    async onReset(
      _event: SessionResetEvent,
    ): Promise<SessionResetSubscriberOutcome> {
      return { kind: "skipped", reason: REAFFIRM_REASON };
    },
  };
}
