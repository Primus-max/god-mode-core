import {
  buildBrokerQueueKey,
  type BrokerEntry,
  type BrokerOverflowReason,
  type BrokerQueueKey,
  type ConcurrentTurnBroker,
} from "../../platform/broker/index.js";
import type { IdentityId } from "../../platform/identity/identity-id.js";

/**
 * Slice "PR-MT concurrent broker" — Phase 5 (wiring helper).
 *
 * Thin wrapper that translates an inbound-channel turn closure into a
 * `BrokerEntry` and routes it through the process-scoped
 * `ConcurrentTurnBroker`. Phase 5 does NOT yet bind a default production
 * broker; the helper accepts `broker: undefined` cleanly and falls back to
 * direct invocation of the supplied `runTurn` callback. That preserves
 * byte-identical baseline behavior for existing callers (and for every
 * test that does not opt in to broker scheduling), satisfying the
 * sub-plan §7 reverse-leg ("broker disabled regression").
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_pr_mt_concurrent_broker.plan.md`
 * Phase 5. Audit: `extensions/AUDIT-pr-mt-concurrent-broker.md`.
 *
 * Invariants honored:
 * - #8 — wrapper imports only the broker barrel + `IdentityId` brand. No
 *   commitment / decision imports.
 * - #11 — `src/platform/commitment/**` and `src/platform/decision/**`
 *   untouched. The helper composes a `BrokerQueueKey` and submits to the
 *   broker; it does NOT call `runTurnDecision` directly.
 * - #15 — every return path is a structured envelope. Submit rejection is
 *   surfaced as `{kind:'rejected', reason, queueKey}` so callers can
 *   translate it into a user-facing reply (Phase 6 owns that translation).
 *   When `broker` is undefined, the inner `runTurn` may still throw — the
 *   helper does NOT swallow that exception; broker-managed turns have
 *   their `runTurn` errors caught by the broker itself, see
 *   `concurrent-turn-broker.ts`.
 * - #16 — `BrokerQueueKey` brand discipline preserved end-to-end. The
 *   queue key is composed strictly from the validated `IdentityId` and a
 *   stable JSON-tuple of routing metadata; no raw user text reaches the
 *   key.
 *
 * Channel-key derivation mirrors the `buildRecentMessageIdKey` precedent
 * (`enqueue.ts:22-38`): `JSON.stringify([channel, to, accountId ?? null,
 * threadId ?? null])`. Stable across calls for a given inbound tuple, so
 * same-`(identity, channel)` turns hash to one queue.
 */

/**
 * Channel-key construction surface.
 *
 * The four originating fields populate at `get-reply-run.ts:529-532` from
 * inbound webhooks (Telegram / Discord / etc.) and travel forward via
 * `FollowupRun` to the Phase 5 wiring site. Any field may be undefined when
 * the inbound surface omits it (e.g. DM threads have no `threadId`); the
 * helper substitutes `null` so the JSON tuple stays length-stable.
 */
export type DispatchTurnViaBrokerArgs = {
  /**
   * The process-scoped `ConcurrentTurnBroker` instance, or `undefined` to
   * bypass broker scheduling and invoke `runTurn` directly. Phase 5 does
   * not yet bind a default broker — every existing caller passes
   * `undefined` and observes byte-identical pre-broker behavior. Phase 5b
   * (or Phase 6) will bind the production singleton.
   */
  readonly broker?: ConcurrentTurnBroker;
  /** Opaque caller-supplied turn id — passed through into broker telemetry. */
  readonly turnId: string;
  /** Validated identity brand. */
  readonly identityId: IdentityId;
  /** Originating routing fields — see module docstring. */
  readonly originatingChannel: string;
  readonly originatingTo: string;
  readonly originatingAccountId?: string | undefined;
  readonly originatingThreadId?: string | undefined;
  /**
   * The deferred turn body. The helper invokes it exactly once on admission
   * (or directly when `broker` is undefined). Errors thrown inside
   * `runTurn` propagate when the broker is undefined; broker-managed
   * invocations have errors swallowed by the broker (see
   * `concurrent-turn-broker.ts`).
   */
  readonly runTurn: () => Promise<void>;
  /**
   * Optional clock injection for the broker's `enqueuedAtMs` timestamp.
   * Defaults to `Date.now`. Tests pin timing via this hook.
   */
  readonly now?: () => number;
};

/**
 * Outcome of `dispatchTurnViaBroker`. Discriminated by `kind`:
 * - `completed` — the turn body ran (either directly when `broker` was
 *   undefined, or after broker admission + dispatch).
 * - `rejected` — the broker refused admission. `reason` is the closed
 *   `BrokerOverflowReason` discriminant; `queueKey` is the resolved key
 *   (surfaced for Phase 6 user-facing-reply translation + telemetry).
 */
export type DispatchTurnViaBrokerResult =
  | { readonly kind: "completed" }
  | {
      readonly kind: "rejected";
      readonly reason: BrokerOverflowReason;
      readonly queueKey: BrokerQueueKey;
    };

/**
 * Compose the JSON-tuple channel key. Stable across calls for a given
 * `(channel, to, accountId, threadId)` tuple — `JSON.stringify` is
 * deterministic for primitive arrays, and the tuple positions are fixed
 * so undefined fields collapse to `null` rather than shifting indices.
 *
 * Mirrors `buildRecentMessageIdKey` (`enqueue.ts:22-38`) precedent.
 */
function buildChannelKey(args: {
  readonly originatingChannel: string;
  readonly originatingTo: string;
  readonly originatingAccountId?: string | undefined;
  readonly originatingThreadId?: string | undefined;
}): string {
  return JSON.stringify([
    args.originatingChannel,
    args.originatingTo,
    args.originatingAccountId ?? null,
    args.originatingThreadId ?? null,
  ]);
}

/**
 * Route a turn through the concurrent broker, or invoke directly when the
 * broker is undefined.
 *
 * When `broker` is undefined the helper invokes `runTurn` synchronously
 * (in promise-chain terms) and returns `{kind:'completed'}` — byte-
 * identical to the pre-broker dispatch path. Errors thrown inside the
 * direct-invocation path propagate to the caller, matching today's
 * behavior at `agent-runner.ts:973`.
 *
 * When `broker` is present the helper composes a `BrokerQueueKey` from
 * `(identityId, channelKey)` and submits a `BrokerEntry` whose `runTurn`
 * is the supplied closure. The broker enforces per-key FIFO + cross-key
 * concurrency + capacity rejection; the helper translates the
 * `BrokerSubmitResult` into the discriminated `DispatchTurnViaBrokerResult`.
 */
export async function dispatchTurnViaBroker(
  args: DispatchTurnViaBrokerArgs,
): Promise<DispatchTurnViaBrokerResult> {
  if (args.broker === undefined) {
    // Regression guard: broker not yet bound (Phase 5b/6 will bind a
    // default). Direct invocation matches pre-broker dispatch byte-for-
    // byte. Errors propagate to the caller — unchanged from today.
    await args.runTurn();
    return { kind: "completed" };
  }

  const channelKey = buildChannelKey({
    originatingChannel: args.originatingChannel,
    originatingTo: args.originatingTo,
    originatingAccountId: args.originatingAccountId,
    originatingThreadId: args.originatingThreadId,
  });
  const queueKey: BrokerQueueKey = buildBrokerQueueKey(
    args.identityId,
    channelKey,
  );
  const now = args.now ?? Date.now;
  const entry: BrokerEntry = {
    turnId: args.turnId,
    queueKey,
    enqueuedAtMs: now(),
    runTurn: args.runTurn,
  };

  const result = await args.broker.submit(entry);
  if (result.kind === "rejected") {
    return { kind: "rejected", reason: result.reason, queueKey };
  }
  return { kind: "completed" };
}
