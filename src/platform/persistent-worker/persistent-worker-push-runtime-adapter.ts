/**
 * Bug F (persistent-worker subsequent push) Phase 4 — runtime adapter.
 *
 * Sibling of Cron/Scheduler P5 `scheduled-reminder-runtime-adapter.ts`
 * and Cutover-4 P5 `repo-runtime-adapter.ts`, but lifted up to the
 * cron-fire boundary instead of the in-turn tool boundary: the adapter
 * receives a structural `PersistentWorkerPushArgs` produced by the
 * Phase 5 cron-fire callback (NOT by an in-turn tool), validates it
 * via the Phase 2 `WorkerReportRefSchema`, dispatches the outbound
 * push via the injected `deliveryDispatch` (REUSED transport — sub-
 * plan §3.3, audit §a.3), and records the resulting
 * `DeliveredWorkerReportRecord`-shaped event on the injected
 * `PersistentWorkerReportCollector` (forward-declared interface;
 * concrete impl deferred to Phase 5).
 *
 * Boundary discipline:
 * - Lives under `src/platform/persistent-worker/`, sibling of the
 *   Phase 2 types module — invariant #8. The directory imports ONLY
 *   from `src/platform/identity/`, `src/platform/commitment/ids.js`
 *   (for the existing `ChannelId` / `SessionId` brands), Zod,
 *   `src/cron/isolated-agent/reminder-fire-callback.js` for the shared
 *   `DeliveryDispatchResult` envelope, and stdlib. It does NOT import
 *   from `src/platform/decision/`, does NOT touch the 5-contract
 *   frozen surface (`TaskContract` / `OutcomeContract` /
 *   `QualificationExecutionContract` / `ResolutionContract` /
 *   `RecipeRoutingHints`), and does NOT widen `EpisodicEffectFamily`
 *   (sub-plan §3.1: REUSE `COMMUNICATION_EFFECT_FAMILY`; audit §e).
 * - Reads STRUCTURAL inputs only (`workerRunId`, branded
 *   `ownerIdentityId`, ISO-8601 `completedAt`, branded `channel`,
 *   `to`, `content`). NEVER reads `RawUserTurn` / `UserPrompt`
 *   (invariants #5, #6). The cron-fire boundary runs OUTSIDE any
 *   user-text reading context.
 * - Identity is the canonical scope (slice K precedent, sub-plan §1
 *   audit §i NEW invariant): adapter rechecks `ownerIdentityId`
 *   non-empty + branded via `isIdentityId(...)` even though the Phase
 *   5 cron-fire callback fail-closes earlier — defense in depth so a
 *   buggy future caller cannot smuggle a ZERO-identity emit past the
 *   gate.
 * - Failure surface is a closed string union of 8 reasons (audit §h
 *   Phase 4: `transport_error` / `identity_unavailable` /
 *   `channel_invalid` / `worker_run_missing` / `observer_unavailable`
 *   / `report_already_pushed` / `dispatch_failed` / `internal_error`).
 *   The adapter NEVER throws — invariant #15. Push tracking is
 *   observability plus done-predicate evidence, not gating; emit-site
 *   failure must not downgrade the calling cron-fire turn.
 *
 * Phase 5 wiring (out of scope for Phase 4):
 * - Concrete `PersistentWorkerReportCollector` implementation (the
 *   process-scoped singleton wired into `createDefaultMonitoredRuntime`
 *   alongside the Cron/Scheduler P3 collector).
 * - Cron-fire callback at `src/cron/isolated-agent/persistent-worker-
 *   push-fire-callback.ts` that constructs `PersistentWorkerPushArgs`
 *   from the persisted `WorkerRunRecord` (`wrappedScopeIdentityId =
 *   record.ownerIdentityId`, NEVER caller-supplied) and invokes
 *   `runPersistentWorkerSubsequentPush(...)`.
 * - Cron-fire callback's `markPushed`-BEFORE-dispatch arm-order
 *   (idempotency-on-retry parity with the slice K reminder-fire
 *   callback `markFired`-BEFORE-dispatch).
 */

import type { ChannelId, SessionId } from "../commitment/ids.js";
import type { DeliveryDispatchResult } from "../../cron/isolated-agent/reminder-fire-callback.js";
import { isIdentityId, type IdentityId } from "../identity/identity-id.js";

import {
  PERSISTENT_WORKER_SUBSEQUENT_PUSH_EFFECT,
  WORKER_REPORT_CONTENT_MAX_LENGTH,
  WorkerReportRefSchema,
  type WorkerReportRef,
} from "./persistent-worker-push-types.js";

/**
 * Closed-shape payload handed to the injected delivery sink. Sibling of
 * `ReminderFireDispatchPayload` from `reminder-fire-callback.ts:47-54`.
 *
 * The `wrappedScopeIdentityId` field MUST be the persisted
 * `WorkerRunRecord.ownerIdentityId` — the cron driver does not have
 * direct access to the operator's session scope, so the Phase 5
 * cron-fire callback re-injects identity at the delivery boundary so
 * identity NEVER cross-leaks (slice K precedent; audit §i NEW
 * invariant). The Phase 4 adapter forwards this opaquely from
 * `args.ownerIdentityId` — production wiring guarantees the value is
 * sourced from the persisted record (Phase 5 callback discipline).
 */
export type PersistentWorkerPushDispatchPayload = {
  readonly workerRunId: string;
  readonly wrappedScopeIdentityId: IdentityId;
  readonly completedAt: string;
  readonly channel: ChannelId;
  readonly to: string;
  readonly content: string;
};

/**
 * Delivery-dispatch function shape for the persistent-worker push.
 * Mirrors `DeliveryDispatchFn` from `reminder-fire-callback.ts:60-62`
 * but typed against the `PersistentWorkerPushDispatchPayload` shape.
 * The result envelope is REUSED directly from the slice K module
 * (`DeliveryDispatchResult`) — both adapters share the same
 * `{ ok: true } | { ok: false, reason: string }` discriminator surface
 * so production transport wiring can fan a single dispatch helper into
 * both call-sites without an extra translation layer.
 */
export type DeliveryDispatchFn = (
  payload: PersistentWorkerPushDispatchPayload,
) => Promise<DeliveryDispatchResult>;

/**
 * Forward-declared shape of the per-(sessionId, turnId) scoped
 * collector backing `WorldStateSnapshot.persistentWorkerReports`
 * (Phase 5). The Phase 4 adapter only depends on the structural
 * `record(...)` + `has(workerRunId)` predicates so concrete impl is
 * deferred (Phase 5 introduces
 * `PersistentWorkerReportObserver` + the singleton wired into
 * `createDefaultMonitoredRuntime` — slice K Phase 3 / Cutover-4 P3
 * precedent).
 *
 * `has(workerRunId)` is the idempotency predicate: the Phase 5 cron-
 * fire callback marks `subsequentPushStatus='pushed'` BEFORE invoking
 * the adapter, but a concurrent re-fire (cron driver retry on a
 * crashed callback) could still call the adapter twice. The adapter's
 * `report_already_pushed` reverse short-circuits the second call so
 * the operator does not receive a duplicate push (mark-before-
 * dispatch parity with reminder-fire-callback `markFired`).
 *
 * Failure surface: the collector's `record(...)` throws on a malformed
 * record (Phase 5 will validate via the Phase 5 Zod schema); the
 * adapter wraps the call in try/catch and surfaces
 * `transport_error` (#15 — adapter NEVER throws).
 */
export type DeliveredWorkerReportRecordInput = {
  readonly workerRunId: string;
  readonly ownerIdentityId: IdentityId;
  readonly completedAt: string;
  readonly channel: ChannelId;
  readonly to: string;
  readonly status: "pushed";
  readonly recordedAt: string;
  readonly messageId: string;
};

export type PersistentWorkerReportTurnKey = {
  readonly sessionId: SessionId;
  readonly turnId: string;
};

export interface PersistentWorkerReportCollector {
  /**
   * Records a `pushed` worker-report event on the active turn bucket.
   * Phase 5 implements the canonical Zod-validated record shape +
   * per-(sessionId, turnId) keying with `perTurnLimit=2` (daily push;
   * cross-turn rare). For Phase 4 the adapter only depends on the
   * structural `(record, key)` arity.
   *
   * Throws on a malformed record or a transport-level append failure;
   * the Phase 4 adapter wraps the call in try/catch and surfaces
   * `transport_error` (#15 — adapter NEVER throws).
   */
  record(
    record: DeliveredWorkerReportRecordInput,
    key: PersistentWorkerReportTurnKey,
  ): void;

  /**
   * Returns `true` if a `pushed` record for `workerRunId` is already
   * present in any active turn bucket. Phase 5 implements the cross-
   * turn predicate over the persisted `WorkerRunRecord` store; Phase
   * 4 only depends on the structural boolean predicate.
   *
   * The predicate exists at the adapter boundary so a concurrent
   * re-fire (cron driver retry on a crashed callback) short-circuits
   * before the dispatch invocation — the operator does not receive a
   * duplicate push (mark-before-dispatch parity with
   * reminder-fire-callback `markFired`).
   *
   * Throws on a transport-level read failure; the Phase 4 adapter
   * wraps the call in try/catch and surfaces `observer_unavailable`
   * (#15 — adapter NEVER throws).
   */
  has(workerRunId: string): boolean;
}

export type PersistentWorkerPushDeps = {
  /**
   * Per-(sessionId, turnId) scoped collector backing
   * `WorldStateSnapshot.persistentWorkerReports`. Production wires the
   * Phase 5 process-scoped singleton; tests inject a deterministic
   * fixture instance.
   */
  readonly collector: PersistentWorkerReportCollector;
  /**
   * REUSED transport — sub-plan §3.3 / audit §a.3. Production wires
   * through `dispatchCronDelivery(...)` from
   * `src/cron/isolated-agent/delivery-dispatch.ts:299` (or its sub-
   * helpers `deliverViaDirect`+`retryTransientDirectCronDelivery`); no
   * fork. The dispatch result is the closed-shape `DeliveryDispatchResult`
   * REUSED from the slice K cron-fire callback module.
   */
  readonly deliveryDispatch: DeliveryDispatchFn;
  /**
   * Optional structured-line emitter. Defaults to a no-op so tests do
   * not pollute stdout; production wiring (Phase 5 cron-fire callback)
   * injects the gateway logger. The emitted line shape is fixed at
   * Phase 4 for Phase 7 acceptance grep:
   * `[persistent-worker-push-runtime-adapter] runPersistentWorkerSubsequentPush
   *  workerRunId=<...> identityId=<...> channel=<...> to=<...>
   *  result=<ok|fail:<reason>>`.
   */
  readonly logger?: { readonly log: (message: string) => void };
  /**
   * Injected clock — defaults to `Date.now`. Tests pin a deterministic
   * value to exercise the `recordedAt` ISO-8601 field. Same DI pattern
   * as the Cron/Scheduler P5 `scheduled-reminder-runtime-adapter` and
   * the slice K reminder-fire callback (`now?: () => number`).
   */
  readonly now?: () => number;
};

export type PersistentWorkerPushArgs = {
  readonly sessionId: SessionId;
  readonly turnId: string;
  readonly workerRunId: string;
  readonly ownerIdentityId: IdentityId;
  /** ISO-8601 timestamp of the worker-completion event. */
  readonly completedAt: string;
  readonly channel: ChannelId;
  readonly to: string;
  readonly content: string;
};

/**
 * Closed failure-reason union for the Phase 4 runtime adapter (8
 * entries; audit §h Phase 4):
 *
 * - `identity_unavailable` — `ownerIdentityId` empty / unbranded
 *   (anonymous fail-closed; sub-plan §1 audit §i NEW invariant).
 *   Defense in depth — the Phase 5 cron-fire callback fail-closes
 *   earlier on the same predicate.
 * - `channel_invalid` — `WorkerReportRefSchema` rejects an empty
 *   `channel` / `to` field, OR the `content` length exceeds
 *   `WORKER_REPORT_CONTENT_MAX_LENGTH`, OR the `completedAt` regex
 *   fails. Surfaced as a single closed-shape rejection; the
 *   `detail` field carries the underlying Zod issue message for
 *   debug.
 * - `worker_run_missing` — `workerRunId` empty after trim. Phase 5's
 *   cron-fire callback short-circuits earlier when the persisted
 *   `WorkerRunRecord.get(workerRunId, identityId)` returns
 *   `undefined`; the adapter rechecks structurally so a buggy future
 *   caller cannot smuggle a ZERO-id emit past the gate.
 * - `observer_unavailable` — `deps.collector` missing / malformed;
 *   `collector.has(...)` or `collector.record(...)` throws.
 * - `report_already_pushed` — `collector.has(workerRunId)` is `true`
 *   at adapter entry; the cron driver re-fired a callback whose
 *   record is already `pushed`. Idempotency short-circuit BEFORE
 *   dispatch.
 * - `dispatch_failed` — `deliveryDispatch(...)` returns
 *   `{ ok: false, reason: <...> }` OR throws. The underlying reason
 *   is propagated via `detail`.
 * - `transport_error` — generic envelope for upstream Zod / collector
 *   transport failures that don't fall under one of the above.
 * - `internal_error` — terminal catch-all (#15 — every malformed
 *   shape returns a typed envelope; never throws).
 */
export type PersistentWorkerPushFailReason =
  | "transport_error"
  | "identity_unavailable"
  | "channel_invalid"
  | "worker_run_missing"
  | "observer_unavailable"
  | "report_already_pushed"
  | "dispatch_failed"
  | "internal_error";

export type PersistentWorkerPushResult =
  | {
      readonly kind: "ok";
      readonly messageId: string;
      readonly recordedAt: string;
    }
  | {
      readonly kind: "fail";
      readonly reason: PersistentWorkerPushFailReason;
      readonly detail?: string;
    };

const ADAPTER_LOG_PREFIX =
  "[persistent-worker-push-runtime-adapter] runPersistentWorkerSubsequentPush";

/**
 * Sole contract entry point. NEVER throws — every failure path returns
 * a typed envelope (invariant #15).
 *
 * Order of operations (mirrors slice K reminder-fire-callback +
 * Cron/Scheduler P5 scheduled-reminder-runtime-adapter):
 *
 *  1. Validate `deps.collector` shape (defense in depth — Phase 5
 *     callback already fail-closes when the singleton is uninitialized).
 *  2. Validate `args.ownerIdentityId` via `isIdentityId(...)` —
 *     anonymous fail-closed.
 *  3. Validate the args envelope via `WorkerReportRefSchema.safeParse`
 *     (Phase 2 schema). Closed-shape rejections fan into
 *     `worker_run_missing` (empty `workerRunId`) /
 *     `channel_invalid` (everything else — empty channel/to, oversize
 *     content, malformed ISO-8601, etc.).
 *  4. Idempotency short-circuit — `collector.has(workerRunId)` returns
 *     `report_already_pushed` BEFORE invoking dispatch. Phase 5 cron-
 *     fire callback's mark-BEFORE-dispatch is the upstream guard;
 *     this is the second belt-and-braces line.
 *  5. Build `PersistentWorkerPushDispatchPayload` carrying
 *     `wrappedScopeIdentityId = args.ownerIdentityId`. Phase 5
 *     callback discipline guarantees this value originates from the
 *     persisted record.
 *  6. Invoke `deps.deliveryDispatch(payload)`. On `{ ok: false }` or
 *     a thrown error, surface `dispatch_failed` with the underlying
 *     reason in `detail`. The collector is NOT updated on failure
 *     (the Phase 5 cron-fire callback's `subsequentPushStatus='pushed'`
 *     mark-before-dispatch lives ABOVE this adapter).
 *  7. On dispatch success, mint a deterministic `messageId` (the
 *     dispatch result envelope is the slice K `{ ok: true }` shape
 *     today — no `messageId` field; we synthesize a stable id from
 *     `workerRunId` so the predicate evidence trail can fingerprint
 *     the push) and append a `pushed` record to the collector keyed
 *     on `(sessionId, turnId)`.
 *  8. Emit the `[persistent-worker-push-runtime-adapter]` log line.
 *  9. Return `{ kind: 'ok', messageId, recordedAt }`.
 */
export async function runPersistentWorkerSubsequentPush(
  deps: PersistentWorkerPushDeps,
  args: PersistentWorkerPushArgs,
): Promise<PersistentWorkerPushResult> {
  try {
    // 1. Validate collector shape. The Phase 5 callback fail-closes
    //    earlier when the singleton is uninitialized, but the adapter
    //    rechecks so a buggy future caller can't smuggle past the gate.
    if (
      !deps ||
      typeof deps !== "object" ||
      !deps.collector ||
      typeof deps.collector.record !== "function" ||
      typeof deps.collector.has !== "function" ||
      typeof deps.deliveryDispatch !== "function"
    ) {
      return emitFail(
        deps,
        args,
        { kind: "fail", reason: "observer_unavailable" },
      );
    }

    // 2. Anonymous fail-closed (slice K precedent + sub-plan §1 audit
    //    §i NEW invariant). Defense in depth — Phase 5 callback
    //    fail-closes on the same predicate.
    const ownerIdentityIdRaw =
      typeof args?.ownerIdentityId === "string"
        ? args.ownerIdentityId.trim()
        : "";
    if (
      ownerIdentityIdRaw.length === 0 ||
      !isIdentityId(ownerIdentityIdRaw)
    ) {
      return emitFail(
        deps,
        args,
        { kind: "fail", reason: "identity_unavailable" },
      );
    }
    const ownerIdentityId = ownerIdentityIdRaw as IdentityId;

    // 3. Closed-shape Zod validation (Phase 2 schema). Empty
    //    `workerRunId` fans into `worker_run_missing`; everything
    //    else (empty channel/to, oversize content, malformed
    //    ISO-8601, unknown extra keys) fans into `channel_invalid`.
    const workerRunIdRaw =
      typeof args.workerRunId === "string" ? args.workerRunId.trim() : "";
    if (workerRunIdRaw.length === 0) {
      return emitFail(
        deps,
        args,
        { kind: "fail", reason: "worker_run_missing" },
      );
    }

    const refCandidate = {
      workerRunId: args.workerRunId,
      ownerIdentityId,
      completedAt: args.completedAt,
      channel: args.channel,
      to: args.to,
      content: args.content,
    };
    const parsed = WorkerReportRefSchema.safeParse(refCandidate);
    if (!parsed.success) {
      // Closed-shape rejection — surface `channel_invalid` (the broad
      // Zod-failure bucket) carrying the first issue's message in
      // `detail` for debug. Oversize content > 4096 fans into the
      // same bucket per sub-plan §1 todo Phase 4 test case #9.
      const issue = parsed.error.issues[0];
      const detail = issue ? issue.message : "WorkerReportRefSchema rejected";
      return emitFail(
        deps,
        args,
        { kind: "fail", reason: "channel_invalid", detail },
      );
    }
    const ref: WorkerReportRef = parsed.data;

    // 4. Idempotency short-circuit. The Phase 5 cron-fire callback
    //    marks `subsequentPushStatus='pushed'` BEFORE invoking the
    //    adapter; this `has(...)` predicate is the second belt-and-
    //    braces line so a concurrent re-fire from a crashed callback
    //    short-circuits BEFORE dispatch.
    let alreadyPushed: boolean;
    try {
      alreadyPushed = deps.collector.has(ref.workerRunId);
    } catch (err) {
      return emitFail(
        deps,
        args,
        {
          kind: "fail",
          reason: "observer_unavailable",
          detail: err instanceof Error ? err.message : String(err),
        },
      );
    }
    if (alreadyPushed) {
      return emitFail(
        deps,
        args,
        { kind: "fail", reason: "report_already_pushed" },
      );
    }

    // 5. Build dispatch payload. `wrappedScopeIdentityId = ref.ownerIdentityId`
    //    — the persisted record's identity (NOT a caller-supplied
    //    value at the dispatch boundary; the Phase 5 callback
    //    upstream guarantees this provenance).
    const payload: PersistentWorkerPushDispatchPayload = {
      workerRunId: ref.workerRunId,
      wrappedScopeIdentityId: ref.ownerIdentityId,
      completedAt: ref.completedAt,
      channel: ref.channel,
      to: ref.to,
      content: ref.content,
    };

    // 6. Invoke deliveryDispatch. Both throw and `{ ok: false }`
    //    paths fan into `dispatch_failed` with the underlying reason
    //    in `detail`.
    let dispatchResult: DeliveryDispatchResult;
    try {
      dispatchResult = await deps.deliveryDispatch(payload);
    } catch (err) {
      return emitFail(
        deps,
        args,
        {
          kind: "fail",
          reason: "dispatch_failed",
          detail: err instanceof Error ? err.message : String(err),
        },
      );
    }
    if (!dispatchResult || dispatchResult.ok !== true) {
      const detail =
        dispatchResult && dispatchResult.ok === false
          ? dispatchResult.reason
          : "dispatch envelope malformed";
      return emitFail(
        deps,
        args,
        { kind: "fail", reason: "dispatch_failed", detail },
      );
    }

    // 7. Mint deterministic messageId + recordedAt. The dispatch
    //    envelope today is the slice K shape `{ ok: true }` with no
    //    `messageId` field; we synthesize a stable id from the
    //    `workerRunId` so the predicate evidence trail can
    //    fingerprint the push (a future widening of
    //    `DeliveryDispatchResult.ok` to carry `messageId` is
    //    additive and slots in here without re-flowing the result
    //    shape).
    const nowMs = (deps.now ?? Date.now)();
    const recordedAt = new Date(nowMs).toISOString();
    const messageId = `pwpush:${ref.workerRunId}:${nowMs}`;

    const record: DeliveredWorkerReportRecordInput = {
      workerRunId: ref.workerRunId,
      ownerIdentityId: ref.ownerIdentityId,
      completedAt: ref.completedAt,
      channel: ref.channel,
      to: ref.to,
      status: "pushed",
      recordedAt,
      messageId,
    };
    const turnKey: PersistentWorkerReportTurnKey = {
      sessionId: args.sessionId,
      turnId: args.turnId,
    };
    try {
      deps.collector.record(record, turnKey);
    } catch (err) {
      // Collector append failure on the success path — the dispatch
      // ALREADY landed (the operator received the push) so we do NOT
      // surface `dispatch_failed`. Surface `transport_error` so the
      // Phase 5 callback's logging records the slice-write failure
      // for ops follow-up.
      return emitFail(
        deps,
        args,
        {
          kind: "fail",
          reason: "transport_error",
          detail: err instanceof Error ? err.message : String(err),
        },
      );
    }

    // 8. Emit success log line.
    safeLog(
      deps,
      `${ADAPTER_LOG_PREFIX} workerRunId=${ref.workerRunId} identityId=${ref.ownerIdentityId} channel=${ref.channel} to=${ref.to} result=ok`,
    );

    return { kind: "ok", messageId, recordedAt };
  } catch (err) {
    // Terminal catch-all (#15) — every malformed shape (deeply
    // malformed args, etc.) returns a typed envelope; never throws.
    return emitFail(
      undefined,
      undefined,
      {
        kind: "fail",
        reason: "internal_error",
        detail: err instanceof Error ? err.message : String(err),
      },
    );
  }
}

/**
 * Emits the `[persistent-worker-push-runtime-adapter]` failure log
 * line and returns the `result` envelope unchanged. The logger never
 * throws — wraps in try/catch (sub-plan §1 todo Phase 4 test case #7
 * — «Logger never throws on adapter return»).
 */
function emitFail(
  deps: PersistentWorkerPushDeps | undefined,
  args: PersistentWorkerPushArgs | undefined,
  result: PersistentWorkerPushResult & { readonly kind: "fail" },
): PersistentWorkerPushResult {
  if (deps !== undefined) {
    const workerRunId =
      args && typeof args.workerRunId === "string" ? args.workerRunId : "";
    const identityId =
      args && typeof args.ownerIdentityId === "string"
        ? args.ownerIdentityId
        : "";
    const channel =
      args && typeof args.channel === "string" ? args.channel : "";
    const to = args && typeof args.to === "string" ? args.to : "";
    safeLog(
      deps,
      `${ADAPTER_LOG_PREFIX} workerRunId=${workerRunId} identityId=${identityId} channel=${channel} to=${to} result=fail:${result.reason}`,
    );
  }
  return result;
}

/**
 * Calls `deps.logger.log(line)` if available, swallowing any error so
 * the adapter never throws (#15) — sub-plan §1 todo Phase 4 test case
 * #7 («Logger never throws on adapter return»).
 */
function safeLog(deps: PersistentWorkerPushDeps | undefined, line: string): void {
  if (
    deps &&
    deps.logger &&
    typeof deps.logger.log === "function"
  ) {
    try {
      deps.logger.log(line);
    } catch {
      // swallow — adapter MUST NEVER throw on logger failure (#15).
    }
  }
}

// Re-exports for the Phase 5 callback so the wiring point can import
// the effect id + content cap from the same module surface as the
// adapter (slice K Phase 5 / Cutover-4 P5 precedent — adapter modules
// re-export the Phase 2 effect/precondition constants).
export {
  PERSISTENT_WORKER_SUBSEQUENT_PUSH_EFFECT,
  WORKER_REPORT_CONTENT_MAX_LENGTH,
};
