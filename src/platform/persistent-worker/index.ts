/**
 * Public surface of the platform persistent-worker module — Bug F
 * (persistent-worker subsequent push) Phase 2.
 *
 * Phase 2 ships ONLY types + Zod schemas + the effect/precondition id
 * constants. No implementation is exported here yet; Phases 3-7 land
 * the affordance + done-predicate (P3), the runtime adapter (P4), the
 * cron-fire callback + WorldState slice + observer (P5), the
 * `OutboundCoalescer` bypass-reason removal (P6), and the acceptance
 * + live-verify runbook (P7).
 *
 * Per invariant #8, this module imports ONLY from
 * `src/platform/identity/`, `src/platform/commitment/ids.js` (for the
 * existing `EffectId` / `PreconditionId` / `ChannelId` brands), Zod,
 * and the standard library. It does NOT import from
 * `src/platform/decision/`, does NOT touch the 5-contract frozen
 * surface (`TaskContract` / `OutcomeContract` /
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
