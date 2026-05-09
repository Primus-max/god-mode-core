/**
 * Bug F (persistent-worker subsequent push) Phase 5 — cron-fire callback.
 *
 * Sibling of Slice K Phase 5 `reminder-fire-callback.ts`. Invoked at the
 * worker-completion seam inside `src/cron/isolated-agent/run.ts` (audit §a.1
 * — between lines 832 and 873) when a persistent-worker run completes and
 * its scheduled subsequent push needs to dispatch back to the operator's
 * external channel.
 *
 * Behavior:
 *  1. Load the matching `SubagentRunRecord` from the injected
 *     `subagentStore.get(workerRunId)` — cross-identity reads return
 *     `undefined` (defense in depth; sub-plan §1 audit §i NEW invariant).
 *  2. Anonymous fail-closed when `record.ownerIdentityId` is missing /
 *     unbranded — the cron-driver does not have direct access to the
 *     operator's session scope, so we re-inject identity at the delivery
 *     boundary (slice K precedent).
 *  3. Mark `subsequentPushStatus='pushed'` BEFORE invoking the adapter
 *     (mark-before-dispatch parity with the slice K
 *     `reminder-fire-callback.ts:149-157` `markFired` order).
 *     Idempotent on retry: a concurrent re-fire from a crashed callback
 *     short-circuits at the adapter's `report_already_pushed` predicate
 *     (`runPersistentWorkerSubsequentPush` step 4).
 *  4. Construct `PersistentWorkerPushArgs` carrying `ownerIdentityId =
 *     record.ownerIdentityId` (NEVER caller-supplied — sub-plan §1 audit
 *     §i NEW structural invariant).
 *  5. Invoke `runPersistentWorkerSubsequentPush`. On `kind:'fail'`, mark
 *     `subsequentPushStatus='failed'` so the cron driver does not replay
 *     infinitely (operator re-issues manually) AND record a `failed`
 *     entry on the observer slice so the done-predicate can see the
 *     attempt rather than a slice-absent state.
 *  6. Emit `[persistent-worker-push-fire-callback]` log line carrying
 *     `workerRunId`, `wrappedScopeIdentityId`, `channel`, `result`.
 *  7. Return a typed envelope. NEVER throws (invariant #15) — every
 *     failure path returns `{ kind:'fail', reason }`.
 *
 * Wiring choice (CONSERVATIVE — sub-plan §3.4):
 *   This module ships the callback IMPLEMENTATION but does NOT yet flip
 *   the `subagent_ended` plugin hook (`subagent-registry-completion.ts:44-96`)
 *   to invoke it unconditionally. Production wiring is Phase 5b — a
 *   deliberately separate slice so live-verify can isolate the regression
 *   surface (cron run.ts seam edit) from the kernel surface (this file +
 *   the observer + the world-state slice). Pre-flip, the subagent_ended
 *   path is byte-identical to dev HEAD, eliminating behavior-changing
 *   risk on every persistent_worker completion.
 *
 * Boundary discipline:
 *  - Lives in `src/cron/isolated-agent/`, alongside `reminder-fire-callback.ts`.
 *  - Reads STRUCTURAL inputs only (workerRunId, branded IdentityId, ISO-8601
 *    completedAt, branded ChannelId, to, content) — NEVER raw user text
 *    (#5/#6). The cron-fire boundary runs OUTSIDE any user-text reading
 *    context.
 *  - `subagentStore` / `adapter` / `collector` / `deliveryDispatch` are
 *    all dependency-injected closed-shape interfaces so the callback stays
 *    decoupled from the production cron internals (mirrors the `cronAdd`
 *    injection in `record-reminder-tool.ts` / the slice K callback's
 *    `reminderStore` injection).
 */

import type { ChannelId, SessionId } from "../../platform/identity/branded-ids.js";
import {
  isIdentityId,
  type IdentityId,
} from "../../platform/identity/identity-id.js";
import type {
  PersistentWorkerPushArgs,
  PersistentWorkerPushResult,
  PersistentWorkerReportCollector,
  runPersistentWorkerSubsequentPush as RunPersistentWorkerSubsequentPushFn,
} from "../../platform/persistent-worker/persistent-worker-push-runtime-adapter.js";
import type { DeliveryDispatchFn as PersistentWorkerDeliveryDispatchFn } from "../../platform/persistent-worker/persistent-worker-push-runtime-adapter.js";

/**
 * Closed-shape view onto the `SubagentRunRecord` carrier the callback
 * needs. Wide structural typing so callers can pass either the full
 * `SubagentRunRecord` (production) or a fixture object (tests). The
 * `ownerIdentityId` field is the ONLY load-bearing field for cross-
 * identity defense — sub-plan §1 audit §i NEW invariant.
 */
export type PersistentWorkerSubagentRecord = {
  readonly runId: string;
  readonly ownerIdentityId?: IdentityId;
  readonly subsequentPushStatus?: "pending" | "pushed" | "failed";
};

/**
 * Closed-shape store interface — `get(workerRunId)` predicates by
 * `runId` ONLY (cross-identity defense lives at the callback layer:
 * the callback fail-closes when `record.ownerIdentityId` does not
 * exist, AND every dispatch payload re-uses `record.ownerIdentityId`
 * — never caller-supplied). Production wires through the
 * `subagentRuns` registry's `getSubagentRunRecord(runId)` accessor;
 * tests inject a fixture map.
 */
export interface PersistentWorkerSubagentStore {
  get(
    workerRunId: string,
  ): PersistentWorkerSubagentRecord | undefined;
  /**
   * Marks the persisted record's `subsequentPushStatus`. Returns `true`
   * on a successful update (or already-in-status idempotent no-op);
   * returns `false` when the run is unknown.
   */
  markSubsequentPushStatus(
    workerRunId: string,
    status: "pending" | "pushed" | "failed",
  ): boolean;
}

/**
 * Closed-shape view onto the Phase 5 collector — same `recordFailure`
 * method the in-memory observer exposes. Forward-declared so this
 * module compiles against the runtime adapter's narrower
 * `PersistentWorkerReportCollector` interface AND the observer's wider
 * `recordFailure` extension.
 */
export interface PersistentWorkerReportCollectorWithFailure
  extends PersistentWorkerReportCollector {
  recordFailure(
    record: {
      readonly workerRunId: string;
      readonly ownerIdentityId: IdentityId;
      readonly channel: ChannelId;
      readonly to: string;
      readonly status: "failed";
      readonly recordedAt: string;
      readonly reason: string;
    },
    key: { readonly sessionId: SessionId; readonly turnId: string },
  ): void;
}

export type PersistentWorkerPushFireCallbackDeps = {
  readonly subagentStore: PersistentWorkerSubagentStore;
  readonly adapter: typeof RunPersistentWorkerSubsequentPushFn;
  readonly collector: PersistentWorkerReportCollectorWithFailure;
  readonly deliveryDispatch: PersistentWorkerDeliveryDispatchFn;
  readonly logger?: { readonly log: (message: string) => void };
  /**
   * Injected clock — defaults to `Date.now`. Tests pin a deterministic
   * value to exercise the `recordedAt` ISO-8601 field on the failure
   * record (the success path's `recordedAt` is minted inside the
   * adapter).
   */
  readonly now?: () => number;
};

export type PersistentWorkerPushFireCallbackArgs = {
  readonly sessionId: SessionId;
  readonly turnId: string;
  readonly workerRunId: string;
  readonly completedAt: string;
  readonly channel: ChannelId;
  readonly to: string;
  readonly content: string;
};

export type PersistentWorkerPushFireCallbackResult =
  | { readonly kind: "ok"; readonly messageId?: string }
  | {
      readonly kind: "fail";
      readonly reason: PersistentWorkerPushFireCallbackFailReason;
      readonly detail?: string;
    };

/**
 * Closed failure-reason union for the Phase 5 cron-fire callback. The
 * adapter's 8-entry failure surface is a strict subset of this union —
 * any adapter `kind:'fail'` result propagates the underlying reason
 * unchanged so Phase 7 acceptance grep can match on either layer.
 */
export type PersistentWorkerPushFireCallbackFailReason =
  | "identity_unavailable"
  | "worker_run_missing"
  | "channel_invalid"
  | "report_already_pushed"
  | "observer_unavailable"
  | "transport_error"
  | "dispatch_failed"
  | "internal_error";

const CALLBACK_LOG_PREFIX = "[persistent-worker-push-fire-callback]";

/**
 * Sole contract entry point. NEVER throws — every failure path returns
 * a typed envelope (invariant #15).
 *
 * Order of operations:
 *  1. Validate `deps` shape (defense in depth).
 *  2. Load `record = subagentStore.get(workerRunId)`. Missing →
 *     `worker_run_missing`.
 *  3. Validate `record.ownerIdentityId` via `isIdentityId(...)` —
 *     anonymous fail-closed; identity NEVER cross-leaks (slice K
 *     precedent; sub-plan §1 audit §i NEW invariant).
 *  4. `subagentStore.markSubsequentPushStatus(workerRunId, 'pushed')` —
 *     mark-before-dispatch (idempotent on retry; parity with slice K
 *     reminder-fire `markFired` at `:149-157`).
 *  5. Construct `PersistentWorkerPushArgs` carrying `ownerIdentityId =
 *     record.ownerIdentityId` (NEVER caller-supplied at the dispatch
 *     boundary). The lint-guard test
 *     `persistent-worker-push-fire-callback.identity-injection.test.ts`
 *     asserts the byte-equal property.
 *  6. Invoke `deps.adapter({ collector, deliveryDispatch, logger }, args)`.
 *  7. On adapter `kind:'fail'`: mark `subsequentPushStatus='failed'`
 *     AND record a `failed` entry on the observer (so the done-predicate
 *     sees the attempt rather than a slice-absent state). Surface the
 *     adapter's failure-reason unchanged.
 *  8. Emit success/failure log line carrying `workerRunId`,
 *     `wrappedScopeIdentityId`, `channel`, `result`.
 */
export async function persistentWorkerPushFireCallback(
  deps: PersistentWorkerPushFireCallbackDeps,
  args: PersistentWorkerPushFireCallbackArgs,
): Promise<PersistentWorkerPushFireCallbackResult> {
  try {
    // 1. Validate deps shape.
    if (
      !deps ||
      typeof deps !== "object" ||
      !deps.subagentStore ||
      typeof deps.subagentStore.get !== "function" ||
      typeof deps.subagentStore.markSubsequentPushStatus !== "function" ||
      typeof deps.adapter !== "function" ||
      !deps.collector ||
      typeof deps.collector.record !== "function" ||
      typeof deps.collector.has !== "function" ||
      typeof deps.collector.recordFailure !== "function" ||
      typeof deps.deliveryDispatch !== "function"
    ) {
      // Defensive — caller mis-configured. Treat as observer_unavailable
      // (we cannot even load the persisted record).
      safeLog(
        deps,
        `${CALLBACK_LOG_PREFIX} workerRunId= wrappedScopeIdentityId= channel= result=fail:observer_unavailable`,
      );
      return { kind: "fail", reason: "observer_unavailable" };
    }

    // 2. Validate args shape minimally — adapter does the heavy Zod
    //    validation. We only need to bail out before the store lookup
    //    if `workerRunId` is empty.
    const workerRunId =
      typeof args?.workerRunId === "string" ? args.workerRunId.trim() : "";
    if (workerRunId.length === 0) {
      safeLog(
        deps,
        `${CALLBACK_LOG_PREFIX} workerRunId= wrappedScopeIdentityId= channel=${safeStr(args?.channel)} result=fail:worker_run_missing`,
      );
      return { kind: "fail", reason: "worker_run_missing" };
    }

    // 3. Load the persisted record.
    let record: PersistentWorkerSubagentRecord | undefined;
    try {
      record = deps.subagentStore.get(workerRunId);
    } catch (err) {
      safeLog(
        deps,
        `${CALLBACK_LOG_PREFIX} workerRunId=${workerRunId} wrappedScopeIdentityId= channel=${safeStr(args.channel)} result=fail:observer_unavailable`,
      );
      return {
        kind: "fail",
        reason: "observer_unavailable",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    if (!record) {
      safeLog(
        deps,
        `${CALLBACK_LOG_PREFIX} workerRunId=${workerRunId} wrappedScopeIdentityId= channel=${safeStr(args.channel)} result=fail:worker_run_missing`,
      );
      return { kind: "fail", reason: "worker_run_missing" };
    }

    // 4. Anonymous fail-closed — the persisted record MUST carry a
    //    branded `ownerIdentityId`. Pre-Phase-5 records won't (the
    //    field is ADDITIVE optional); the callback fail-closes here so
    //    pre-Phase-5 worker runs never push (no behavior change for
    //    pre-Phase-5 dev HEAD).
    const ownerIdentityIdRaw =
      typeof record.ownerIdentityId === "string"
        ? record.ownerIdentityId.trim()
        : "";
    if (ownerIdentityIdRaw.length === 0 || !isIdentityId(ownerIdentityIdRaw)) {
      safeLog(
        deps,
        `${CALLBACK_LOG_PREFIX} workerRunId=${workerRunId} wrappedScopeIdentityId= channel=${safeStr(args.channel)} result=fail:identity_unavailable`,
      );
      return { kind: "fail", reason: "identity_unavailable" };
    }
    const ownerIdentityId = ownerIdentityIdRaw as IdentityId;

    // 5. Mark `pushed` BEFORE dispatch — mark-before-dispatch parity
    //    with slice K reminder-fire `markFired` at `:149-157`. If the
    //    mark fails (record disappeared between get + mark), surface
    //    `worker_run_missing` and bail BEFORE invoking the adapter so
    //    a partial state never reaches transport.
    let marked: boolean;
    try {
      marked = deps.subagentStore.markSubsequentPushStatus(
        workerRunId,
        "pushed",
      );
    } catch (err) {
      safeLog(
        deps,
        `${CALLBACK_LOG_PREFIX} workerRunId=${workerRunId} wrappedScopeIdentityId=${ownerIdentityId} channel=${safeStr(args.channel)} result=fail:observer_unavailable`,
      );
      return {
        kind: "fail",
        reason: "observer_unavailable",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    if (!marked) {
      safeLog(
        deps,
        `${CALLBACK_LOG_PREFIX} workerRunId=${workerRunId} wrappedScopeIdentityId=${ownerIdentityId} channel=${safeStr(args.channel)} result=fail:worker_run_missing`,
      );
      return { kind: "fail", reason: "worker_run_missing" };
    }

    // 6. Construct the adapter payload. `ownerIdentityId =
    //    record.ownerIdentityId` — NEVER caller-supplied. Lint-guard
    //    test asserts byte-equal.
    const adapterArgs: PersistentWorkerPushArgs = {
      sessionId: args.sessionId,
      turnId: args.turnId,
      workerRunId,
      ownerIdentityId,
      completedAt: args.completedAt,
      channel: args.channel,
      to: args.to,
      content: args.content,
    };

    // 7. Invoke the adapter. The adapter NEVER throws (#15) but a
    //    deeply-malformed deps could trigger a thrown error from the
    //    transport — try/catch defense-in-depth.
    let result: PersistentWorkerPushResult;
    try {
      result = await deps.adapter(
        {
          collector: deps.collector,
          deliveryDispatch: deps.deliveryDispatch,
          ...(deps.logger ? { logger: deps.logger } : {}),
        },
        adapterArgs,
      );
    } catch (err) {
      // Adapter contract says NEVER throws — but defense-in-depth still
      // applies. Treat as `internal_error` and mark the record `failed`
      // so the cron driver does not replay infinitely.
      tryMarkFailed(deps, workerRunId);
      tryRecordFailure(deps, args, ownerIdentityId, "internal_error");
      safeLog(
        deps,
        `${CALLBACK_LOG_PREFIX} workerRunId=${workerRunId} wrappedScopeIdentityId=${ownerIdentityId} channel=${safeStr(args.channel)} result=fail:internal_error`,
      );
      return {
        kind: "fail",
        reason: "internal_error",
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    if (result.kind === "fail") {
      // Mark `failed` so the cron driver does not replay infinitely
      // (operator re-issues manually). Record a `failed` entry on the
      // observer so the done-predicate sees the attempt — slice-absent
      // is reserved for «no push attempted on this turn».
      tryMarkFailed(deps, workerRunId);
      tryRecordFailure(deps, args, ownerIdentityId, result.reason);
      safeLog(
        deps,
        `${CALLBACK_LOG_PREFIX} workerRunId=${workerRunId} wrappedScopeIdentityId=${ownerIdentityId} channel=${safeStr(args.channel)} result=fail:${result.reason}`,
      );
      return {
        kind: "fail",
        reason: result.reason,
        ...(result.detail ? { detail: result.detail } : {}),
      };
    }

    // 8. Success.
    safeLog(
      deps,
      `${CALLBACK_LOG_PREFIX} workerRunId=${workerRunId} wrappedScopeIdentityId=${ownerIdentityId} channel=${safeStr(args.channel)} result=ok`,
    );
    return { kind: "ok", messageId: result.messageId };
  } catch (err) {
    // Terminal catch-all (#15). Best-effort log; never throws.
    safeLog(
      deps,
      `${CALLBACK_LOG_PREFIX} workerRunId= wrappedScopeIdentityId= channel= result=fail:internal_error`,
    );
    return {
      kind: "fail",
      reason: "internal_error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function safeStr(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeLog(
  deps: PersistentWorkerPushFireCallbackDeps | undefined,
  line: string,
): void {
  if (deps && deps.logger && typeof deps.logger.log === "function") {
    try {
      deps.logger.log(line);
    } catch {
      // swallow — callback MUST NEVER throw on logger failure (#15).
    }
  }
}

function tryMarkFailed(
  deps: PersistentWorkerPushFireCallbackDeps,
  workerRunId: string,
): void {
  try {
    deps.subagentStore.markSubsequentPushStatus(workerRunId, "failed");
  } catch {
    // swallow — defense in depth; the failure is already surfaced via
    // the result envelope and the log line.
  }
}

function tryRecordFailure(
  deps: PersistentWorkerPushFireCallbackDeps,
  args: PersistentWorkerPushFireCallbackArgs,
  ownerIdentityId: IdentityId,
  reason: string,
): void {
  try {
    const nowMs = (deps.now ?? Date.now)();
    const recordedAt = new Date(nowMs).toISOString();
    deps.collector.recordFailure(
      {
        workerRunId: args.workerRunId,
        ownerIdentityId,
        channel: args.channel,
        to: args.to,
        status: "failed",
        recordedAt,
        reason,
      },
      { sessionId: args.sessionId, turnId: args.turnId },
    );
  } catch {
    // swallow — collector recordFailure failures must not bubble.
  }
}
