import type { OpenClawConfig } from "../../config/config.js";
import { defaultRuntime } from "../../runtime.js";
import type { IdentityId } from "../identity/identity-id.js";
import type { MemoryStore } from "../memory/memory-store.js";

import type { EffectId } from "./ids.js";
import {
  RETRY_POLICY_REASONS,
  type RetryPolicyDecision,
  type RetryPolicyEvaluateInput,
  type RetryPolicyReader,
} from "./policy-gate-stages.js";
import {
  buildRetryStateKey,
  type RetryStateStore,
} from "./retry-state-store.js";

/**
 * Phase 6 — Stage 5 (Retry policies) implementation of the
 * `RetryPolicyReader` interface scaffolded in Phase 2
 * (`policy-gate-stages.ts`).
 *
 * Architectural notes:
 *
 *  1. **Orthogonal pattern preserved.** Reader consumes the frozen
 *     `RETRY_POLICY_REASONS = ['retry_limit_exceeded']` tuple. The
 *     legacy `POLICY_GATE_REASONS` (`policy-gate.ts`) stays
 *     BYTE-IDENTICAL — see `policy-gate-stages.ts` block comment §1-§2.
 *  2. **`MonitoredRuntime` BYTE-IDENTICAL.** This module never
 *     imports / extends `monitored-runtime.ts`. The retry consultation
 *     happens in the runner-layer wrapper (Phase 6 wiring inside the
 *     pi-embedded-runner) which calls `evaluate(...)` on
 *     `terminalState=transient_failure` and either backs off + re-runs
 *     OR emits the `policy_retry` episodic event and rolls forward to
 *     a terminal failure (sub-plan §3 row Phase 6 + §10 invariant #11).
 *  3. **Counter scoping.** Per `(identityId | 'anonymous', effectId,
 *     sessionId)` triple — different sessions do NOT inherit the
 *     count. Anonymous turns share one bucket per `(effectId,
 *     sessionId)`. The store key is derived via
 *     `buildRetryStateKey(...)`; all keying lives there so a future
 *     persistent store impl can swap in by interface.
 *  4. **Backoff strategy.** Exponential `100 * 2^(attemptCount-1)` ms,
 *     capped at `maxBackoffMs` (default `30_000`). The `attemptCount`
 *     is supplied by the CALLER — it is the number of failures
 *     observed so far, not a counter the reader auto-increments. The
 *     store-side counter is a parallel observability surface (used
 *     by future cross-call recall — Phase 6 wiring may compare
 *     caller-supplied `attemptCount` to the store row to detect
 *     wrapper-level drift).
 *  5. **Per-effect override.** `policy.retry.perEffect[<effectId>]`
 *     entries pin per-effect `(maxAttempts, maxBackoffMs?)` overrides;
 *     `maxBackoffMs` falls back to the top-level default when the
 *     per-effect entry omits it.
 *  6. **Episodic event emission.** On `retry=false` the reader emits
 *     a `policy_retry` episodic event into the injected
 *     `MemoryStore` (when present). The store-write failure is
 *     contained — observability MUST NOT gate the calling commitment
 *     turn (invariant #15). Anonymous turns drop the event silently
 *     (the `EpisodicMemoryEvent.identityId` field is required).
 *  7. **Log-line evidence (sub-plan §3 row Phase 6).** Two lines are
 *     emitted via `defaultRuntime.log`:
 *       - `[policy-gate] event=retry_checked stage=5
 *          attempt=<n>/<max> backoff_ms=<n>` on every evaluation.
 *       - `[policy-gate] event=retry_exhausted effect=<id>` on every
 *         `retry=false` decision.
 *     These are observable in `C:\\tmp\\openclaw\\openclaw-<date>.log`
 *     during live-verify (sub-plan §3, Phase 10 acceptance).
 */

export const RETRY_POLICY_DEFAULT_MAX_ATTEMPTS = 3;
export const RETRY_POLICY_DEFAULT_MAX_BACKOFF_MS = 30_000;
const RETRY_POLICY_BASE_BACKOFF_MS = 100;

/**
 * Per-effect override entry. `maxAttempts` is required (the only
 * reason to add a per-effect row is to override the global default);
 * `maxBackoffMs` is optional and falls back to the top-level
 * `defaultMaxBackoffMs`.
 */
export type RetryPolicyConfigEntry = {
  readonly maxAttempts: number;
  readonly maxBackoffMs?: number;
};

/**
 * Subset of `OpenClawConfig` the retry policy reads. Defined locally
 * so callers do not need to plumb the full config when the rest of
 * it is irrelevant (especially in tests).
 */
type RetryPolicyConfigShape = {
  readonly policy?: {
    readonly retry?: {
      readonly defaultMaxAttempts?: number;
      readonly defaultMaxBackoffMs?: number;
      readonly perEffect?: Readonly<Record<string, RetryPolicyConfigEntry>>;
    };
  };
};

export type CreateRetryPolicyOptions = {
  readonly cfg: OpenClawConfig;
  readonly retryStateStore: RetryStateStore;
  readonly memoryStore?: MemoryStore;
};

/**
 * Creates the Stage 5 (Retry policies) policy reader.
 *
 * The returned reader is async — the `MemoryStore.storeEpisodic` hook
 * is async; the rest of the evaluation is synchronous.
 *
 * @param options - Config + retry state store + optional memory store.
 * @returns Frozen `RetryPolicyReader`.
 */
export function createRetryPolicy(options: CreateRetryPolicyOptions): RetryPolicyReader {
  const cfg = options.cfg as RetryPolicyConfigShape;
  const retryConfig = cfg.policy?.retry;
  const defaultMaxAttempts = retryConfig?.defaultMaxAttempts ?? RETRY_POLICY_DEFAULT_MAX_ATTEMPTS;
  const defaultMaxBackoffMs =
    retryConfig?.defaultMaxBackoffMs ?? RETRY_POLICY_DEFAULT_MAX_BACKOFF_MS;
  const perEffect = retryConfig?.perEffect ?? {};
  const store = options.retryStateStore;
  const memoryStore = options.memoryStore;

  const reader: RetryPolicyReader = {
    async evaluate(params: RetryPolicyEvaluateInput): Promise<RetryPolicyDecision> {
      const identityId = params.identityId as IdentityId | undefined;
      const limits = resolveLimits({
        effectId: params.effectId,
        perEffect,
        defaultMaxAttempts,
        defaultMaxBackoffMs,
      });

      // Touch the underlying store to record the consultation. The
      // counter advance lets a future caller (the runner-layer
      // wrapper) detect drift between the caller-supplied
      // `attemptCount` and the store-observed count without rewriting
      // the policy's evaluate signature.
      const key = buildRetryStateKey({
        identityId,
        effectId: params.effectId,
        sessionId: params.sessionId,
      });
      // `get` is intentionally read-without-bump (sub-plan §10 — the
      // store row is observability, not source-of-truth). A future
      // wiring may switch to `increment(key)` on the
      // `terminalState=transient_failure` boundary.
      void store.get(key);

      if (params.attemptCount >= limits.maxAttempts) {
        const backoffMs = computeBackoff(params.attemptCount, limits.maxBackoffMs);
        emitChecked({
          attempt: params.attemptCount,
          maxAttempts: limits.maxAttempts,
          backoffMs,
          within: false,
        });
        emitExhausted(params.effectId);

        if (memoryStore && identityId !== undefined) {
          // Memory write is observability-only. A reject is logged
          // and swallowed: the calling commitment turn proceeds with
          // the denial decision regardless of memory-layer health.
          void memoryStore
            .storeEpisodic({
              identityId,
              effectFamily: "policy_retry",
              effectId: String(params.effectId),
              payload: {
                identityId,
                effectId: params.effectId,
                sessionId: params.sessionId,
                reason: RETRY_POLICY_REASONS[0],
                attemptCount: params.attemptCount,
                maxAttempts: limits.maxAttempts,
              },
            })
            .catch((error: unknown) => {
              defaultRuntime.log(
                `[policy-gate] event=retry_episodic_write_failed ` +
                  `error=${error instanceof Error ? error.message : String(error)}`,
              );
            });
        }
        return {
          retry: false,
          reason: RETRY_POLICY_REASONS[0],
          attemptCount: params.attemptCount,
          maxAttempts: limits.maxAttempts,
        };
      }

      const backoffMs = computeBackoff(params.attemptCount, limits.maxBackoffMs);
      emitChecked({
        attempt: params.attemptCount,
        maxAttempts: limits.maxAttempts,
        backoffMs,
        within: true,
      });
      return { retry: true, backoffMs };
    },
  };
  return Object.freeze(reader);
}

type ResolvedLimits = {
  readonly maxAttempts: number;
  readonly maxBackoffMs: number;
};

/**
 * Resolves the effective `(maxAttempts, maxBackoffMs)` for a given
 * `effectId` — per-effect override wins; otherwise the top-level
 * defaults apply. `maxBackoffMs` is independently overridable per
 * effect; an entry that pins only `maxAttempts` inherits the
 * top-level cap.
 */
function resolveLimits(params: {
  readonly effectId: EffectId;
  readonly perEffect: Readonly<Record<string, RetryPolicyConfigEntry>>;
  readonly defaultMaxAttempts: number;
  readonly defaultMaxBackoffMs: number;
}): ResolvedLimits {
  const override = params.perEffect[String(params.effectId)];
  if (!override) {
    return {
      maxAttempts: params.defaultMaxAttempts,
      maxBackoffMs: params.defaultMaxBackoffMs,
    };
  }
  return {
    maxAttempts: override.maxAttempts,
    maxBackoffMs: override.maxBackoffMs ?? params.defaultMaxBackoffMs,
  };
}

/**
 * Exponential backoff with cap. `attemptCount` is the number of
 * failures observed so far (1-indexed by convention — attempt 1 means
 * the first retry). The cap clips an over-large exponential to
 * `maxBackoffMs`.
 *
 * Edge: an `attemptCount <= 0` (defensive) collapses to the base
 * backoff to keep the wrapper observable instead of returning a
 * fractional millisecond.
 */
function computeBackoff(attemptCount: number, maxBackoffMs: number): number {
  if (attemptCount <= 0) {
    return Math.min(RETRY_POLICY_BASE_BACKOFF_MS, maxBackoffMs);
  }
  const exponential = RETRY_POLICY_BASE_BACKOFF_MS * 2 ** (attemptCount - 1);
  return Math.min(exponential, maxBackoffMs);
}

function emitChecked(params: {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly backoffMs: number;
  readonly within: boolean;
}): void {
  // Note: `within` is implicit in the line shape (`attempt=N/MAX` reads
  // the same way for both within and exhausted; the exhausted case
  // also emits `event=retry_exhausted`). Kept as a parameter for
  // future-proofing without forcing every call-site to compute the
  // canonical line two ways.
  void params.within;
  defaultRuntime.log(
    `[policy-gate] event=retry_checked stage=5 attempt=${String(params.attempt)}/${String(
      params.maxAttempts,
    )} backoff_ms=${String(params.backoffMs)}`,
  );
}

function emitExhausted(effectId: EffectId): void {
  defaultRuntime.log(`[policy-gate] event=retry_exhausted effect=${String(effectId)}`);
}
