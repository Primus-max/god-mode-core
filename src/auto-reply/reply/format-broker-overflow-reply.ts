import type {
  BrokerOverflowReason,
  ConcurrentTurnBroker,
} from "../../platform/broker/index.js";

/**
 * Slice "PR-MT concurrent broker" — Phase 6 (backpressure envelope).
 *
 * User-facing reply formatter and deterministic retry-after derivation.
 * Phase 4 broker emits structured `BrokerOverflowReason` rejections;
 * Phase 5 wiring at `agent-runner-execution.ts` translates the rejection
 * into a `final` payload. This module owns the translation surface so
 * the wiring callsite stays minimal.
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_pr_mt_concurrent_broker.plan.md`
 * Phase 6.
 *
 * Locale choice — Russian. The gateway's primary operator surface is
 * Russian-locale Telegram; the inbound channel reply must be reachable to
 * the operator without language toggling. The text intentionally avoids
 * machine-readable structure (JSON / brand prefixes) — operators read it
 * directly in the channel client, the structured `[broker] rejected`
 * telemetry remains the source of truth for ops follow-up.
 *
 * Invariants honored:
 * - #5/#6 — formatter inputs are a closed `BrokerOverflowReason`
 *   discriminator + a numeric retry-after; raw user text never reaches
 *   this module.
 * - #15 — every reason maps to a defined string; no path throws or
 *   returns `undefined`.
 * - #8 — module imports only the broker barrel + stdlib types.
 */

/**
 * Per-queued-turn millisecond estimate used by `deriveBrokerRetryAfterMs`
 * when computing a retry hint from the broker's queue depth. Sized to the
 * median turn wallclock observed in the audit (`extensions/AUDIT-pr-mt-
 * concurrent-broker.md` §e — operator turns averaging 4-6s including LLM
 * classifier latency); rounded to 5_000 for clean second display. The
 * derivation is deterministic — no clock or randomness — so tests can
 * assert exact values.
 */
export const MS_PER_QUEUED_TURN_ESTIMATE = 5_000;

/**
 * Default retry-after for `queue_depth_exceeded` when the broker has no
 * useful queue-depth signal (e.g. zero active keys at derivation time).
 * 10s mirrors the spec's documented retry hint so the formatted reply
 * stays predictable for ops.
 */
const DEFAULT_QUEUE_DEPTH_RETRY_AFTER_MS = 10_000;

/**
 * Default retry-after for `broker_shutdown`. Shutdown is process-scoped;
 * 30s gives the gateway time to restart and rebind the broker.
 */
const SHUTDOWN_RETRY_AFTER_MS = 30_000;

/**
 * Closed-set Russian-locale message map. Each branch produces a single
 * sentence the operator sees in their inbound channel reply; the retry
 * hint is interpolated where applicable. Sentences end without trailing
 * whitespace / formatting punctuation so callers can append channel-
 * specific suffixes without normalising.
 */
export function formatBrokerOverflowReply(
  reason: BrokerOverflowReason,
  retryAfterMs?: number,
): string {
  switch (reason) {
    case "queue_depth_exceeded": {
      const seconds = Math.ceil(
        (retryAfterMs ?? DEFAULT_QUEUE_DEPTH_RETRY_AFTER_MS) / 1000,
      );
      return `Перегрузка очереди для этого канала. Повторите через ~${seconds} секунд.`;
    }
    case "wait_timeout": {
      return `Запрос превысил время ожидания в очереди. Попробуйте позже.`;
    }
    case "broker_shutdown": {
      const seconds = Math.ceil(
        (retryAfterMs ?? SHUTDOWN_RETRY_AFTER_MS) / 1000,
      );
      return `Сервис перезагружается. Попробуйте через ${seconds} секунд.`;
    }
  }
}

/**
 * Deterministic retry-after derivation from the broker's introspection
 * surface. Walks `getActiveKeys()` and `getQueueDepth()` to read the
 * minimum non-empty queue depth; multiplies by `MS_PER_QUEUED_TURN_ESTIMATE`
 * so the hint scales with observed pressure without hitting wallclock.
 *
 * Reason mapping:
 *   - `queue_depth_exceeded` — derive from min depth across active keys.
 *     If all queues are empty (only inFlight keys), fall back to the
 *     `DEFAULT_QUEUE_DEPTH_RETRY_AFTER_MS` floor (no zero retry-after, ever).
 *   - `wait_timeout` — return `undefined` (no deterministic hint; caller
 *     surfaces a static "try later" message).
 *   - `broker_shutdown` — fixed `SHUTDOWN_RETRY_AFTER_MS` (independent of
 *     queue state because shutdown drains all queues).
 *
 * Pure with respect to wall-clock: the derivation reads only the broker's
 * synchronous introspection helpers. Tests pin behaviour by submitting
 * deterministic entries before invoking the helper.
 */
export function deriveBrokerRetryAfterMs(
  broker: ConcurrentTurnBroker,
  reason: BrokerOverflowReason,
): number | undefined {
  switch (reason) {
    case "broker_shutdown":
      return SHUTDOWN_RETRY_AFTER_MS;
    case "wait_timeout":
      return undefined;
    case "queue_depth_exceeded": {
      const activeKeys = broker.getActiveKeys();
      let minDepth = Number.POSITIVE_INFINITY;
      for (const key of activeKeys) {
        const depth = broker.getQueueDepth(key);
        if (depth > 0 && depth < minDepth) {
          minDepth = depth;
        }
      }
      if (!Number.isFinite(minDepth)) {
        // No queued backlog (only inFlight keys, or no active keys at
        // all). Clamp to the documented default so the operator reply
        // still carries a non-zero retry hint.
        return DEFAULT_QUEUE_DEPTH_RETRY_AFTER_MS;
      }
      return minDepth * MS_PER_QUEUED_TURN_ESTIMATE;
    }
  }
}
