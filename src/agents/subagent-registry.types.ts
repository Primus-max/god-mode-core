import type { IdentityId } from "../platform/identity/identity-id.js";
import type { DeliveryContext } from "../utils/delivery-context.js";
import type { SubagentRunOutcome } from "./subagent-announce.js";
import type { SubagentLifecycleEndedReason } from "./subagent-lifecycle-events.js";
import type { SpawnSubagentMode } from "./subagent-spawn.js";

export type SubagentRunRecord = {
  runId: string;
  childSessionKey: string;
  controllerSessionKey?: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  cleanup: "delete" | "keep";
  label?: string;
  model?: string;
  workspaceDir?: string;
  runTimeoutSeconds?: number;
  spawnMode?: SpawnSubagentMode;
  createdAt: number;
  /** Start time of the current run attempt. */
  startedAt?: number;
  /** Stable start time for the child session across follow-up runs. */
  sessionStartedAt?: number;
  /** Accumulated runtime from prior completed runs for this child session. */
  accumulatedRuntimeMs?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  archiveAtMs?: number;
  cleanupCompletedAt?: number;
  cleanupHandled?: boolean;
  suppressAnnounceReason?: "steer-restart" | "killed";
  expectsCompletionMessage?: boolean;
  /** Number of announce delivery attempts that returned false (deferred). */
  announceRetryCount?: number;
  /** Timestamp of the last announce retry attempt (for backoff). */
  lastAnnounceRetryAt?: number;
  /** Terminal lifecycle reason recorded when the run finishes. */
  endedReason?: SubagentLifecycleEndedReason;
  /** Run ended while descendants were still pending and should be re-invoked once they settle. */
  wakeOnDescendantSettle?: boolean;
  /**
   * Latest frozen completion output captured for announce delivery.
   * Seeded at first end transition and refreshed by later assistant turns
   * while completion delivery is still pending for this session.
   */
  frozenResultText?: string | null;
  /** Timestamp when frozenResultText was last captured. */
  frozenResultCapturedAt?: number;
  /**
   * Fallback completion output preserved across wake continuation restarts.
   * Used when a late wake run replies with NO_REPLY after the real final
   * summary was already produced by the prior run.
   */
  fallbackFrozenResultText?: string | null;
  /** Timestamp when fallbackFrozenResultText was preserved. */
  fallbackFrozenResultCapturedAt?: number;
  /** Set after the subagent_ended hook has been emitted successfully once. */
  endedHookEmittedAt?: number;
  attachmentsDir?: string;
  attachmentsRootDir?: string;
  retainAttachmentsOnKeep?: boolean;
  /**
   * Bug F (persistent-worker subsequent push) Phase 5 — ADDITIVE optional
   * field carrying the operator's branded `IdentityId`. Resolved from
   * `requesterOrigin` at spawn time (via the existing identity resolver
   * that already gates the cron-fire boundary; sub-plan §1 audit §i NEW
   * invariant). The Phase 5 cron-fire callback re-reads this from the
   * persisted record at the worker-completion boundary so
   * `wrappedScopeIdentityId` is NEVER caller-supplied (slice K precedent).
   *
   * Optional preserves backward-compat invariant #11 — pre-Phase-5 code
   * paths that registered runs without identity resolution still work; the
   * cron-fire callback fail-closes with `identity_unavailable` when the
   * field is missing.
   */
  ownerIdentityId?: IdentityId;
  /**
   * Bug F Phase 5 — ADDITIVE closed-set lifecycle marker for the daily
   * push state machine: `pending` (run ended, push not yet attempted),
   * `pushed` (cron-fire callback marked the record before invoking the
   * adapter — idempotent on retry; mark-before-dispatch parity with the
   * slice K reminder-fire `markFired` order), `failed` (adapter returned
   * `kind:'fail'`; record stays `failed` so the cron driver does not
   * replay infinitely — operator re-issues manually). Optional preserves
   * backward-compat invariant #11.
   */
  subsequentPushStatus?: "pending" | "pushed" | "failed";
};
