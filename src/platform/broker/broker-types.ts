import { z } from "zod";

import type { IdentityId } from "../identity/identity-id.js";

/**
 * Slice "PR-MT concurrent broker" — Phase 2 (types only).
 *
 * Pure-types module for the per-`(identityId, channelKey)` FIFO admission
 * broker that will sit between inbound-channel callers and `runTurnDecision`.
 * Phase 2 ships ONLY the brand (`BrokerQueueKey`), the entry envelope
 * (`BrokerEntry`), the operator-tunable capacity surface
 * (`BrokerCapacityConfig` + Zod schema + default-application helper), the
 * closed-set overflow reason discriminator, and stable defaults. NO impl
 * lives here — Phase 3 lands the placement helper, Phase 4 lands the broker
 * runtime, Phase 5 wires it at `agent-runner-execution.ts`.
 *
 * Audit: `extensions/AUDIT-pr-mt-concurrent-broker.md` §c (identity wiring),
 * §e (operator surface), §f (gap list). Sub-plan:
 * `.cursor/plans/commitment_kernel_pr_mt_concurrent_broker.plan.md`.
 *
 * Invariants honored:
 * - #8 — pure-types module; only `zod` + the `IdentityId` brand are
 *   imported. No platform or commitment imports.
 * - #11 — `src/platform/commitment/` and `src/platform/decision/` are NOT
 *   touched. Phase 2 byte-identical evidence accompanies the PR.
 * - #16 — `BrokerQueueKey` is composed from a (validated) `IdentityId` and a
 *   per-channel string; sessions are NOT used for queue identity. Each
 *   inbound channel gets its own queue under one identity.
 */

/**
 * Default cap on per-`(identityId, channelKey)` queue depth before new
 * entries are rejected with `'queue_depth_exceeded'`. Mirrors operator
 * scenarios where the same identity bursts ~6-8 messages from a single
 * channel client (audit §e); the floor preserves headroom for legitimate
 * bursty input without unbounded memory growth. Tuned by
 * `BrokerCapacityConfig.maxQueueDepthPerKey`.
 */
export const DEFAULT_MAX_QUEUE_DEPTH_PER_KEY = 8;

/**
 * Default cap on the number of distinct `(identityId, channelKey)` queues
 * the broker tracks concurrently before rejecting new keys with
 * `'queue_depth_exceeded'`. Sized to comfortably exceed the steady-state
 * cardinality of a single-operator deployment (one identity * a handful of
 * channels * a few threads each) while bounding worst-case memory.
 */
export const DEFAULT_MAX_CONCURRENT_KEYS = 32;

/**
 * Default upper bound on how long a queued entry waits at the head of its
 * key's queue for `runTurn` to be invoked before the broker rejects it
 * with `'wait_timeout'`. Two minutes mirrors today's classifier-LLM upper
 * bound; the wait timeout MUST be the only deadline the broker enforces —
 * the inner `runTurn` callback owns its own per-step deadlines.
 */
export const DEFAULT_QUEUE_WAIT_TIMEOUT_MS = 120_000;

/**
 * Default fairness mode across keys. `round_robin` cycles keys per drain
 * tick so a single hot identity cannot starve the rest; `fifo_global`
 * (Phase 4 alternative) preserves global enqueue order at the cost of
 * starvation risk. Sub-plan §6 records the round-robin choice as the v1
 * default.
 */
export const DEFAULT_FAIRNESS_MODE = "round_robin" as const;

/**
 * Closed set of reasons the broker may reject (or dequeue) an entry
 * without invoking its `runTurn`. The discriminator is surfaced verbatim
 * in the Phase 4 overflow envelope and Phase 6 telemetry so operators
 * can diagnose pressure mode (depth vs latency vs shutdown).
 */
export const BROKER_OVERFLOW_REASONS = [
  "queue_depth_exceeded",
  "wait_timeout",
  "broker_shutdown",
] as const;

export type BrokerOverflowReason = (typeof BROKER_OVERFLOW_REASONS)[number];

declare const BrokerQueueKeyBrand: unique symbol;

/**
 * Branded composite key uniquely identifying ONE per-channel FIFO queue
 * under ONE operator identity. Distinct from `SessionId` (#16): a single
 * session can carry multiple channel-key queues over its lifetime; a
 * single channel key may serve multiple sessions sequentially.
 *
 * Format: `<identityId>::<channelKey>` where `identityId` is a validated
 * `IdentityId` (`identity:<slug>`) and `channelKey` is an opaque
 * caller-supplied string. The `::` delimiter mirrors the
 * `buildRecentMessageIdKey` precedent (`enqueue.ts:22-38`) but uses a
 * fixed two-colon separator rather than JSON-tuple serialization because
 * `IdentityId` slugs are restricted to `[A-Za-z0-9._-]+` and cannot
 * collide with the delimiter; `channelKey` is opaque to the broker.
 *
 * Construct via `buildBrokerQueueKey(...)`. Direct casting from `string`
 * is a TypeScript error; use the factory.
 */
export type BrokerQueueKey = string & { readonly [BrokerQueueKeyBrand]: true };

/**
 * Compose a `BrokerQueueKey` from a validated `IdentityId` and an opaque
 * channel key. The `IdentityId` is already brand-validated by
 * `asIdentityId(...)`; this helper performs no further input validation
 * and never throws. The result is byte-stable for a given `(identityId,
 * channelKey)` pair so that the Phase 4 broker can use it as a `Map` key
 * and the Phase 6 telemetry can group by it.
 */
export function buildBrokerQueueKey(
  identityId: IdentityId,
  channelKey: string,
): BrokerQueueKey {
  return `${identityId}::${channelKey}` as BrokerQueueKey;
}

/**
 * Type-guard for `BrokerQueueKey`. Defensive against non-string inputs so
 * it can be used at boundaries where input is `unknown` (telemetry
 * decoders, structured-log replay). Recognises the `<identityId>::<...>`
 * shape: requires a `string` containing `::` with non-empty halves and
 * the left half starting with the `identity:` prefix that
 * `asIdentityId(...)` enforces.
 */
export function isBrokerQueueKey(value: unknown): value is BrokerQueueKey {
  if (typeof value !== "string") {
    return false;
  }
  const delimiterIndex = value.indexOf("::");
  if (delimiterIndex <= 0) {
    return false;
  }
  if (delimiterIndex >= value.length - 2) {
    return false;
  }
  const identityHalf = value.slice(0, delimiterIndex);
  if (!identityHalf.startsWith("identity:")) {
    return false;
  }
  return true;
}

/**
 * Envelope the broker holds in its FIFO queue per `BrokerQueueKey`. The
 * `runTurn` callback is the deferred dispatch into `runTurnDecision` (or
 * `agent-runner-execution.ts` wrapper); the broker invokes it exactly
 * once when the entry reaches the head of its queue and is admitted by
 * the fairness scheduler. Phase 4 implementation details (rejection
 * envelopes, telemetry hooks) build on this shape WITHOUT modifying it.
 *
 * Field semantics:
 * - `turnId` — opaque caller-supplied turn identifier; the broker treats
 *   it as a string and passes it through into Phase 6 telemetry. NOT
 *   used for dedup (callers own dedup at the queue layer above).
 * - `queueKey` — the `BrokerQueueKey` this entry is admitted under.
 *   Stored on the entry so drain telemetry can recover the key after
 *   the entry has been popped.
 * - `enqueuedAtMs` — wall-clock epoch ms at admission. The Phase 4
 *   wait-timeout check compares `Date.now() - enqueuedAtMs` against
 *   `queueWaitTimeoutMs`.
 * - `runTurn` — the deferred dispatch. Phase 4 awaits it inside its
 *   try/finally so that thrown rejections do NOT corrupt queue state.
 *   The callback resolves to `void` because the broker does not consume
 *   the result; downstream consumers receive the result through the
 *   normal `runTurnDecision` return path inside the closure.
 */
export type BrokerEntry = {
  readonly turnId: string;
  readonly queueKey: BrokerQueueKey;
  readonly enqueuedAtMs: number;
  readonly runTurn: () => Promise<void>;
};

/**
 * Operator-tunable broker capacity surface. All fields optional; the
 * Phase 4 broker calls `resolveBrokerCapacityConfig(...)` exactly once
 * at construction so all admission paths see the same parameters. The
 * Zod schema (`BrokerCapacityConfigSchema`) decodes from operator config
 * (e.g. `~/.openclaw/openclaw.json`) under strict mode — unknown keys
 * fail decode so misspellings do not silently fall through to defaults.
 *
 * Defaults documented at `DEFAULT_*` constants above.
 */
export type BrokerCapacityConfig = {
  readonly maxQueueDepthPerKey?: number;
  readonly maxConcurrentKeys?: number;
  readonly queueWaitTimeoutMs?: number;
  readonly fairnessMode?: "round_robin" | "fifo_global";
};

/**
 * Same shape as `BrokerCapacityConfig` but with every field REQUIRED —
 * the post-default-resolution form. Phase 4 broker constructor accepts
 * this fully-resolved variant; Phase 6 telemetry includes the resolved
 * values so operators can confirm the effective configuration.
 */
export type ResolvedBrokerCapacityConfig = Required<BrokerCapacityConfig>;

const PositiveIntegerSchema = z.number().int().positive();

/**
 * Zod decode schema for `BrokerCapacityConfig`. Strict posture: any
 * unknown top-level key is rejected at decode (sub-plan acceptance for
 * Phase 2). Each field is independently optional; the empty object
 * decodes successfully and `resolveBrokerCapacityConfig` applies
 * defaults.
 *
 * Decode rejections covered:
 * - `maxQueueDepthPerKey <= 0` or fractional
 * - `maxConcurrentKeys <= 0` or fractional
 * - `queueWaitTimeoutMs <= 0` or fractional
 * - `fairnessMode` outside `{round_robin, fifo_global}`
 * - any unknown top-level key (strict mode)
 * - non-object input (null, array, string, number)
 */
export const BrokerCapacityConfigSchema = z
  .object({
    maxQueueDepthPerKey: PositiveIntegerSchema.optional(),
    maxConcurrentKeys: PositiveIntegerSchema.optional(),
    queueWaitTimeoutMs: PositiveIntegerSchema.optional(),
    fairnessMode: z.enum(["round_robin", "fifo_global"]).optional(),
  })
  .strict();

/**
 * Apply Phase 2 defaults to a caller-supplied `BrokerCapacityConfig`,
 * returning a fully-populated `ResolvedBrokerCapacityConfig`.
 *
 * Pure function — no clock, no logger, no mutation. The Phase 4 broker
 * calls this exactly once at construction; downstream paths read the
 * resolved object so the broker is deterministic with respect to its
 * input config.
 */
export function resolveBrokerCapacityConfig(
  input?: BrokerCapacityConfig,
): ResolvedBrokerCapacityConfig {
  return {
    maxQueueDepthPerKey:
      input?.maxQueueDepthPerKey ?? DEFAULT_MAX_QUEUE_DEPTH_PER_KEY,
    maxConcurrentKeys:
      input?.maxConcurrentKeys ?? DEFAULT_MAX_CONCURRENT_KEYS,
    queueWaitTimeoutMs:
      input?.queueWaitTimeoutMs ?? DEFAULT_QUEUE_WAIT_TIMEOUT_MS,
    fairnessMode: input?.fairnessMode ?? DEFAULT_FAIRNESS_MODE,
  };
}
