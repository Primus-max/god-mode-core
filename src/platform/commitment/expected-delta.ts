import type { AgentId, SessionId } from "./ids.js";
import type { DeliveryReceiptKind } from "./world-state.js";

export type SessionRecordRef = {
  readonly sessionId: SessionId;
  readonly agentId: AgentId;
};

export type SessionExpectedDelta = {
  readonly followupRegistry?: {
    readonly added?: readonly SessionRecordRef[];
    readonly removed?: readonly { readonly sessionId: SessionId }[];
  };
};

export type DeliveryReceiptRef = {
  readonly deliveryContextKey: string;
  readonly kind: DeliveryReceiptKind;
};

export type DeliveryExpectedDelta = {
  readonly receipts?: {
    readonly added?: readonly DeliveryReceiptRef[];
  };
};

/**
 * Cutover-3 Phase 5 — additive widening of the artifacts slice. Phase 4
 * shipped done-predicates that read `delta.artifacts.added` via a
 * forward-compat structural cast; Phase 5 lights this up by extending
 * the type itself. `added` is the closed list of `artifactId` values
 * the runtime adapter (`artifact-runtime-adapter.ts`) emitted during
 * the turn — the predicates JOIN against
 * `WorldStateSnapshot.artifacts.records[*].artifactId`.
 *
 * Pure additive extension (cutover-2 PR-#104 / slice E P6 precedent):
 * existing `ArtifactExpectedDelta` consumers expected `Record<string,
 * never>`; the new shape is structurally assignable from the empty
 * object, so callers that did not populate `added` continue to compile
 * and behave byte-identical.
 */
export type ArtifactExpectedDelta = {
  readonly added?: readonly string[];
};
export type WorkspaceExpectedDelta = Record<string, never>;

/**
 * Cutover-4 Phase 5 — additive widening of the repo slice. Phase 4
 * shipped done-predicates that read `delta.repo.added` via a forward-
 * compat structural cast (returning the closed sentinel
 * `repo.delta_empty` until this widening lands); Phase 5 lights it up
 * by extending the type itself. `added` is the closed list of
 * `repoOperationId` values the runtime adapter
 * (`repo-runtime-adapter.ts`) emitted during the turn — the predicates
 * JOIN against `WorldStateSnapshot.repo.records[*].repoOperationId`.
 *
 * Pure additive extension (Cutover-3 P5 / slice E P6 precedent): existing
 * consumers do not populate `repo`, so pre-Phase-5 callers stay byte-
 * identical and the Phase 4 forward-compat shim continues to surface
 * `repo.delta_empty` until the runtime adapter populates `added`.
 */
export type RepoExpectedDelta = {
  readonly added?: readonly string[];
};

/**
 * Cron/Scheduler Phase 5 — additive widening of the scheduled-reminder
 * slice. Phase 4 shipped the `reminderSetPredicate` reading
 * `delta.scheduledReminders.added` via a forward-compat structural cast
 * (returning the closed sentinel `scheduled_reminders.delta_empty` until
 * this widening lands); Phase 5 lights it up by extending the type
 * itself. `added` is the closed list of `reminderId` values the runtime
 * adapter (`scheduled-reminder-runtime-adapter.ts`) emitted during the
 * turn — the predicate JOINs against
 * `WorldStateSnapshot.scheduledReminders.records[*].reminderId`.
 *
 * Pure additive extension (Cutover-3 P5 / Cutover-4 P5 / slice E P6
 * precedent): existing consumers do not populate `scheduledReminders`,
 * so pre-Phase-5 callers stay byte-identical and the Phase 4 forward-
 * compat shim continues to surface `scheduled_reminders.delta_empty`
 * until the runtime adapter populates `added`.
 */
export type ScheduledRemindersExpectedDelta = {
  readonly added?: readonly string[];
};

export type ExpectedDelta = {
  readonly sessions?: SessionExpectedDelta;
  readonly artifacts?: ArtifactExpectedDelta;
  readonly workspace?: WorkspaceExpectedDelta;
  readonly repo?: RepoExpectedDelta;
  readonly scheduledReminders?: ScheduledRemindersExpectedDelta;
  readonly deliveries?: DeliveryExpectedDelta;
};
