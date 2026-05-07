/**
 * Public surface of the platform persistent-worker module — Bug F
 * (persistent-worker subsequent push) Phases 2-4.
 *
 * Phase 2 ships types + Zod schemas + the effect/precondition id
 * constants. Phase 3 ships the affordance + done-predicate (registered
 * on `AffordanceRegistry`; predicate lives under
 * `src/platform/commitment/`). Phase 4 ships the runtime adapter
 * + the forward-declared `PersistentWorkerReportCollector` interface.
 * Phase 5 wires the cron-fire callback + WorldState slice + observer;
 * Phase 6 removes the `cron_persistent_worker` bypass; Phase 7 lands
 * acceptance + live-verify runbook.
 *
 * Per invariant #8, this module imports ONLY from
 * `src/platform/identity/`, `src/platform/commitment/ids.js` (for the
 * existing `EffectId` / `PreconditionId` / `ChannelId` / `SessionId`
 * brands), Zod, the slice K cron-fire callback module (for the shared
 * `DeliveryDispatchResult` envelope only), and the standard library.
 * It does NOT import from `src/platform/decision/`, does NOT touch the
 * 5-contract frozen surface (`TaskContract` / `OutcomeContract` /
 * `QualificationExecutionContract` / `ResolutionContract` /
 * `RecipeRoutingHints`), and does NOT widen `EpisodicEffectFamily`
 * (sub-plan §3.1: REUSE `COMMUNICATION_EFFECT_FAMILY`; audit §e: NEW
 * effect, not STUB-light).
 */

export {
  PERSISTENT_WORKER_SUBSEQUENT_PUSH_EFFECT,
  WORKER_REPORT_AVAILABLE_PRECONDITION,
  WORKER_REPORT_CONTENT_MAX_LENGTH,
  WorkerReportRefSchema,
  isPersistentWorkerPushTriggerId,
  type PersistentWorkerPushTriggerId,
  type WorkerReportRef,
} from "./persistent-worker-push-types.js";

export {
  runPersistentWorkerSubsequentPush,
  type DeliveredWorkerReportRecordInput,
  type DeliveryDispatchFn,
  type PersistentWorkerPushArgs,
  type PersistentWorkerPushDeps,
  type PersistentWorkerPushDispatchPayload,
  type PersistentWorkerPushFailReason,
  type PersistentWorkerPushResult,
  type PersistentWorkerReportCollector,
  type PersistentWorkerReportTurnKey,
} from "./persistent-worker-push-runtime-adapter.js";
