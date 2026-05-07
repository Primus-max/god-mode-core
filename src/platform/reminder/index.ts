/**
 * Public surface of the platform reminder module — slice K Phase 2.
 *
 * Phase 2 ships ONLY types + Zod schemas. No implementation is
 * exported here yet; Phases 3-6 land the effect-family + affordance
 * + done-predicate (Phase 3), the `RecallReminderTool` +
 * `WorldStateSnapshot.reminder` slice + runtime adapter (Phase 4),
 * the `IntentContractor` extension (Phase 5), and the cutover flip
 * + acceptance tests (Phase 6).
 *
 * Per invariant #8, this module imports ONLY from
 * `src/platform/identity/`, `src/platform/memory/` (type-only), Zod,
 * and the standard library. It does NOT import from
 * `src/platform/decision/`, does NOT touch `src/platform/commitment/`
 * (the 5-contract frozen layer), and does NOT widen the
 * `MemoryStore` interface.
 *
 * Slice K is a pure CONSUMER over LIT episodic slots — it neither
 * emits new episodic events nor extends `EpisodicEffectFamily`
 * (acceptance criteria #10 + #11 of the slice K sub-plan).
 */

export {
  ReminderEntrySchema,
  ReminderQueryShapeSchema,
  ReminderRecallResultSchema,
  UNMATCHED_REASONS,
  assertNeverUnmatchedReason,
  type ReminderEntry,
  type ReminderQueryShape,
  type ReminderRecallResult,
  type UnmatchedReason,
} from "./reminder-query-shape.js";
