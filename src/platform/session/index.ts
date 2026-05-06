/**
 * Public surface of the platform session module — NEW-B Phase 2.
 *
 * Phase 2 ships ONLY the unified-session-reset types + Zod schemas +
 * the `SessionResetSubscriber` interface. No registry, no
 * `resetTurnSession()` function, no call-site wiring, no Phase-4
 * subscriber implementations — those land in Phases 3-5.
 *
 * Per invariant #8 this module is decision-adjacent: it imports
 * brands (`SessionId`, `IdentityId`) and ReadonlyRecord type alias
 * from `src/platform/commitment/ids.ts` (one-way: commitment is the
 * lower stable layer) and from `src/platform/identity/`, and does
 * NOT modify any frozen contract. The five frozen contracts
 * (`TaskContract`, `OutcomeContract`, `QualificationExecutionContract`,
 * `ResolutionContract`, `RecipeRoutingHints`) remain byte-identical.
 *
 * The pre-existing exports of this directory (`intent-ledger`,
 * `identity-facts`, `workspace-probe`, `intent-fingerprint`,
 * `execution-evidence`, `workspace-invalidation`) are NOT re-exported
 * here — they were authored before this barrel existed and have
 * established direct-import call sites across the repo. This barrel
 * is therefore additive: it surfaces only the NEW-B Phase-2 names.
 */

export {
  SESSION_RESET_REASONS,
  SESSION_RESET_SUBSCRIBER_CATEGORIES,
  SessionResetEventSchema,
  SessionResetSubscriberOutcomeSchema,
  asSessionResetSubscriberId,
  assertNeverSessionResetReason,
  assertNeverSessionResetSubscriberCategory,
  assertNeverSessionResetSubscriberOutcome,
  createSessionResetSubscriberRegistry,
  isSessionResetSubscriberId,
  resetTurnSession,
  type SessionResetEvent,
  type SessionResetReason,
  type SessionResetSubscriber,
  type SessionResetSubscriberCategory,
  type SessionResetSubscriberId,
  type SessionResetSubscriberOutcome,
  type SessionResetSubscriberRegistry,
  type SessionResetSubscriberResult,
  type SessionResetSummary,
} from "./reset.js";
