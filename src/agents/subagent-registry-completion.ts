import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { ChannelId, SessionId } from "../platform/commitment/ids.js";
import type {
  PersistentWorkerPushFireCallbackArgs,
  PersistentWorkerPushFireCallbackResult,
} from "../cron/isolated-agent/persistent-worker-push-fire-callback.js";
import type { SubagentRunOutcome } from "./subagent-announce.js";
import {
  SUBAGENT_ENDED_OUTCOME_ERROR,
  SUBAGENT_ENDED_OUTCOME_OK,
  SUBAGENT_ENDED_OUTCOME_TIMEOUT,
  SUBAGENT_TARGET_KIND_SUBAGENT,
  type SubagentLifecycleEndedOutcome,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function runOutcomesEqual(
  a: SubagentRunOutcome | undefined,
  b: SubagentRunOutcome | undefined,
): boolean {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  if (a.status !== b.status) {
    return false;
  }
  if (a.status === "error" && b.status === "error") {
    return (a.error ?? "") === (b.error ?? "");
  }
  return true;
}

export function resolveLifecycleOutcomeFromRunOutcome(
  outcome: SubagentRunOutcome | undefined,
): SubagentLifecycleEndedOutcome {
  if (outcome?.status === "error") {
    return SUBAGENT_ENDED_OUTCOME_ERROR;
  }
  if (outcome?.status === "timeout") {
    return SUBAGENT_ENDED_OUTCOME_TIMEOUT;
  }
  return SUBAGENT_ENDED_OUTCOME_OK;
}

export async function emitSubagentEndedHookOnce(params: {
  entry: SubagentRunRecord;
  reason: SubagentLifecycleEndedReason;
  sendFarewell?: boolean;
  accountId?: string;
  outcome?: SubagentLifecycleEndedOutcome;
  error?: string;
  inFlightRunIds: Set<string>;
  persist: () => void;
}) {
  const runId = params.entry.runId.trim();
  if (!runId) {
    return false;
  }
  if (params.entry.endedHookEmittedAt) {
    return false;
  }
  if (params.inFlightRunIds.has(runId)) {
    return false;
  }

  params.inFlightRunIds.add(runId);
  try {
    const hookRunner = getGlobalHookRunner();
    if (hookRunner?.hasHooks("subagent_ended")) {
      await hookRunner.runSubagentEnded(
        {
          targetSessionKey: params.entry.childSessionKey,
          targetKind: SUBAGENT_TARGET_KIND_SUBAGENT,
          reason: params.reason,
          sendFarewell: params.sendFarewell,
          accountId: params.accountId,
          runId: params.entry.runId,
          endedAt: params.entry.endedAt,
          outcome: params.outcome,
          error: params.error,
        },
        {
          runId: params.entry.runId,
          childSessionKey: params.entry.childSessionKey,
          requesterSessionKey: params.entry.requesterSessionKey,
        },
      );
    }
    params.entry.endedHookEmittedAt = Date.now();
    params.persist();
    return true;
  } catch {
    return false;
  } finally {
    params.inFlightRunIds.delete(runId);
  }
}

/**
 * Bug F (persistent-worker subsequent push) Phase 5b — companion emitter
 * to `emitSubagentEndedHookOnce` that fires the persistent-worker push
 * callback at the worker-completion seam.
 *
 * The audit (extensions/AUDIT-persistent-worker-push.md §c.2) identified
 * the worker-completion event as the cron-fire wiring point, and the
 * `subagent_ended` lifecycle is the canonical close-of-run signal for
 * subagent runs. For `spawnMode === 'session'` runs (the persistent-
 * worker mode), the existing `subagent_ended` hook is conditionally
 * suppressed by `shouldKeepThreadBindingAfterRun` so the announce flow
 * does not steal the parent's reply slot. This emitter is a PARALLEL
 * fan-out path that fires for `spawnMode === 'session'` regardless of
 * whether the announce hook itself emits — the persistent-worker push
 * is observability + delivery, not a reply.
 *
 * Gating predicates (ALL must pass — anything else short-circuits to
 * `invoked: false` and the surrounding cleanup flow continues normally):
 *  1. `entry.spawnMode === 'session'` (persistent_worker mode marker;
 *     audit §c.1 — `SubagentRunRecord.spawnMode === 'session'` is the
 *     LIT discriminator on dev HEAD).
 *  2. `entry.ownerIdentityId` is defined (Phase 5b spawn-site wiring
 *     populates the field; Phase 5 callback fail-closes when the field
 *     is absent — sub-plan §1 audit §i NEW invariant). Skipping when
 *     undefined is the same observable behavior as letting the callback
 *     fire and return `identity_unavailable`, but avoids the no-op
 *     overhead.
 *  3. `entry.requesterOrigin.channel` + `entry.requesterOrigin.to` —
 *     channel is resolvable from the run record (sub-plan §3.4: «push
 *     goes to operator's channel»). The pre-existing
 *     `normalizeDeliveryContext` already filters empty strings.
 *  4. `entry.frozenResultText` is non-empty — there is deliverable
 *     output. The frozen-result text is captured at completion time
 *     (`subagent-registry.ts:freezeRunResultAtCompletion`); when it is
 *     `null` / `undefined`, the worker produced no replyable output
 *     (the cron-fire boundary's acceptance gate has nothing to push).
 *
 * NEVER throws (#15) — the emitter is a defense-in-depth wrapper:
 *  - `try/catch` around the callback invocation so a thrown error from
 *    a misbehaving callback is downgraded to a synthetic
 *    `internal_error` fail result.
 *  - On callback fail (any reason), the surrounding cleanup flow
 *    continues normally — the operator's announce/cleanup discipline
 *    is independent of the push outcome.
 *
 * Boundary discipline:
 *  - Lives in `src/agents/`, NOT in the frozen layer (#8).
 *  - Reads STRUCTURAL fields only — `spawnMode`, branded
 *    `ownerIdentityId`, `requesterOrigin.channel/to`, `frozenResultText`
 *    (already-frozen output text — NOT a `RawUserTurn` / `UserPrompt`).
 *  - The callback (typed shape) is dependency-injected so this module
 *    does NOT import the cron-fire callback's runtime shape — the
 *    binder pattern keeps the module's import graph stable.
 */
export type PersistentWorkerPushFireCallbackFn = (
  args: PersistentWorkerPushFireCallbackArgs,
) => Promise<PersistentWorkerPushFireCallbackResult>;

export type EmitPersistentWorkerSubsequentPushIfApplicableParams = {
  readonly entry: SubagentRunRecord;
  readonly sessionId: string;
  readonly turnId: string;
  /**
   * Injected callback. Production wires this through
   * `persistentWorkerPushFireCallback(deps, args)` with deps bound at
   * server bootstrap (separate slice — the binder is wired against
   * `getProcessPersistentWorkerReportCollector()` + the production
   * `subagentStore` accessor + `runPersistentWorkerSubsequentPush`
   * adapter + the production `deliveryDispatch`). Tests inject a
   * fixture closure with a deterministic in-memory collector and
   * fake `deliveryDispatch`.
   */
  readonly callback: PersistentWorkerPushFireCallbackFn | undefined;
  /**
   * Optional structured-line emitter. Defaults to no-op so the emitter
   * stays silent in tests; production wiring threads
   * `defaultRuntime.log` or a subsystem logger.
   */
  readonly logger?: { readonly log: (message: string) => void };
};

export type EmitPersistentWorkerSubsequentPushIfApplicableResult = {
  /** Whether the gating predicates passed and the callback was invoked. */
  readonly invoked: boolean;
  /**
   * Underlying callback result when `invoked === true`. `undefined` when
   * the gating predicates short-circuited.
   */
  readonly result?: PersistentWorkerPushFireCallbackResult;
};

const PUSH_EMITTER_LOG_PREFIX = "[subagent-ended-pwpush]";

export async function emitPersistentWorkerSubsequentPushIfApplicable(
  params: EmitPersistentWorkerSubsequentPushIfApplicableParams,
): Promise<EmitPersistentWorkerSubsequentPushIfApplicableResult> {
  const { entry, sessionId, turnId, callback, logger } = params;

  // Predicate 1 — persistent-worker mode discriminator.
  if (entry.spawnMode !== "session") {
    return { invoked: false };
  }

  // Predicate 2 — branded identity available on the persisted record.
  const ownerIdentityId = entry.ownerIdentityId;
  if (typeof ownerIdentityId !== "string" || ownerIdentityId.trim() === "") {
    return { invoked: false };
  }

  // Predicate 3 — channel + to resolvable from `requesterOrigin`.
  const channelRaw = entry.requesterOrigin?.channel;
  const toRaw = entry.requesterOrigin?.to;
  if (
    typeof channelRaw !== "string" ||
    channelRaw.trim() === "" ||
    typeof toRaw !== "string" ||
    toRaw.trim() === ""
  ) {
    return { invoked: false };
  }

  // Predicate 4 — deliverable output.
  const content = entry.frozenResultText;
  if (typeof content !== "string" || content.trim() === "") {
    return { invoked: false };
  }

  // Predicate 5 (defense-in-depth) — callback bound. When unbound, the
  // production binder has not yet been wired — preserve byte-identical
  // pre-Phase-5b behavior (no push). Tests always inject a callback.
  if (typeof callback !== "function") {
    return { invoked: false };
  }

  const completedAt =
    typeof entry.endedAt === "number" && Number.isFinite(entry.endedAt)
      ? new Date(entry.endedAt).toISOString()
      : new Date().toISOString();

  const callbackArgs: PersistentWorkerPushFireCallbackArgs = {
    sessionId: sessionId as SessionId,
    turnId,
    workerRunId: entry.runId,
    completedAt,
    channel: channelRaw as ChannelId,
    to: toRaw,
    content,
  };

  let result: PersistentWorkerPushFireCallbackResult;
  try {
    result = await callback(callbackArgs);
  } catch (err) {
    // Defense-in-depth (#15) — a thrown callback MUST NOT bubble out
    // of the worker-completion seam. Synthesise an `internal_error`
    // result so the cleanup flow continues normally.
    const detail = err instanceof Error ? err.message : String(err);
    safePushEmitterLog(
      logger,
      `${PUSH_EMITTER_LOG_PREFIX} workerRunId=${entry.runId} result=fail:internal_error throw=${detail}`,
    );
    return {
      invoked: true,
      result: { kind: "fail", reason: "internal_error", detail },
    };
  }

  if (result.kind === "fail") {
    safePushEmitterLog(
      logger,
      `${PUSH_EMITTER_LOG_PREFIX} workerRunId=${entry.runId} result=fail:${result.reason}`,
    );
  } else {
    safePushEmitterLog(
      logger,
      `${PUSH_EMITTER_LOG_PREFIX} workerRunId=${entry.runId} result=ok`,
    );
  }
  return { invoked: true, result };
}

function safePushEmitterLog(
  logger: { readonly log: (message: string) => void } | undefined,
  line: string,
): void {
  if (!logger || typeof logger.log !== "function") {
    return;
  }
  try {
    logger.log(line);
  } catch {
    // swallow — emitter MUST NEVER throw on logger failure (#15).
  }
}
