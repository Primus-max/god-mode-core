/**
 * NEW-C Phase 5 — outbound-coalescer commit-on-satisfied hook.
 *
 * Sibling of slice E PR-#169 (`memory-write-on-satisfied.ts`), slice F
 * PR-#185 (`task-write-on-satisfied.ts`) and cutover-3 PR-#207
 * (`recordArtifactOnCommitmentSatisfied.ts`). Pure function
 * `commitOutboundOnCommitmentSatisfied` invoked from the
 * pi-embedded-runner orchestration path AFTER a `RuntimeAttestation`
 * surfaces with `commitmentSatisfied === true`. Provides the PRIMARY
 * commit trigger of the NEW-C three-line defense:
 *
 *   1. PRIMARY  — this hook, fired on `commitmentSatisfied === true`.
 *   2. FALLBACK — `agent-runner.ts` function-level finally block calls
 *                  `coalescer.commitAll(runId)` (Phase 4).
 *   3. WATCHDOG — `setTimeout(maxBufferMs)` per-bucket inside
 *                  `outbound-coalescer.ts` (Phase 3).
 *
 * Idempotency: `commit(turnId, channelKey)` on an empty bucket = noop
 * (Phase 3 invariant). Both primary (this hook) and fallback firing on
 * the same turn produce at most ONE actual deliver call per channel —
 * the second call sees an empty bucket and noops. Telemetry logs both
 * `commit_signal` lines but only one `event=committed`.
 *
 * Boundary discipline:
 * - Lives in `src/agents/pi-embedded-runner/run/`, NOT in
 *   `src/platform/commitment/` — invariant #8.
 * - Reads the attestation via the structural
 *   `CommitmentSatisfiedAttestationLike` type re-exported from the
 *   slice E hook — no NEW runtime import from
 *   `src/platform/commitment/` source.
 * - Failure-isolated per invariant #15: if `coalescer.commitAll`
 *   throws, the hook logs warn and SWALLOWS — the calling commitment
 *   STILL satisfies. This mirrors the slice E / slice F / cutover-3
 *   precedent.
 * - The hook NEVER reads user text — invariants #5, #6.
 */

import type { OutboundCoalescer } from "../../../infra/outbound/outbound-coalescer-types.js";

import type { CommitmentSatisfiedAttestationLike } from "./memory-write-on-satisfied.js";

/**
 * Telemetry sink. Mirrors the line-string surface of `defaultRuntime.log`
 * used by the rest of the commitment-runtime path so production wiring
 * can pass `defaultRuntime.log` directly.
 */
export type CommitOutboundLogger = (line: string) => void;

export type CommitOutboundOnSatisfiedDeps = {
  readonly coalescer: OutboundCoalescer;
  readonly attestation: CommitmentSatisfiedAttestationLike;
  readonly turnId: string;
  /**
   * Optional telemetry sink. When omitted, telemetry is silently
   * dropped — the hook still invokes `coalescer.commitAll`. Tests omit
   * this to keep harness setup minimal; production wiring passes
   * `defaultRuntime.log`.
   */
  readonly logger?: CommitOutboundLogger;
};

/**
 * Fire the PRIMARY commit signal for the outbound coalescer when a
 * commitment satisfies. Behaviour:
 *
 * 1. If `attestation.commitmentSatisfied !== true`, skip (no commit
 *    signal, no log line). The fallback `finalizeAfterRun` finally
 *    block in `agent-runner.ts` covers the unsatisfied path
 *    (policy-denied early-return etc.).
 * 2. Emit `[outbound-coalescer] event=commit_signal source=commitment_satisfied turnId=<id>`
 *    BEFORE invoking `commitAll` so the telemetry pair is
 *    `commit_signal` → `committed` (or `commit_noop` on empty bucket).
 * 3. Invoke `coalescer.commitAll(turnId)`. The coalescer iterates every
 *    open `(turnId, channelKey)` bucket and flushes one merged payload
 *    per channel. Empty turn → silent noop (no `commit_noop` per
 *    bucket; the `commitAll` API drops empty-turn calls without
 *    telemetry to keep idempotent retries quiet).
 * 4. On `commitAll` throw, log warn and SWALLOW (invariant #15). The
 *    fallback or watchdog will retry; the calling turn STILL satisfies.
 */
export async function commitOutboundOnCommitmentSatisfied(
  deps: CommitOutboundOnSatisfiedDeps,
): Promise<void> {
  const { coalescer, attestation, turnId, logger } = deps;

  if (attestation.commitmentSatisfied !== true) {
    // Unsatisfied path: do NOT signal commit. Fallback +
    // finalizeAfterRun finally block handles flushing whatever was
    // buffered (likely the policy-denial final body). This branch is
    // intentionally silent — telemetry on every unsatisfied turn
    // would dwarf the signal-of-interest in operator logs.
    return;
  }

  if (logger) {
    logger(
      `[outbound-coalescer] event=commit_signal source=commitment_satisfied turnId=${turnId}`,
    );
  }

  try {
    await coalescer.commitAll(turnId);
  } catch (err) {
    // Failure isolation per invariant #15 — `commitAll` is internally
    // failure-isolated (per-bucket deliver throws are absorbed) but the
    // outer wrapper is still defensive. The fallback or watchdog will
    // retry on a fresh trigger.
    if (logger) {
      const message = err instanceof Error ? err.message : String(err);
      logger(`[commit-outbound] event=commit_failed err=${message}`);
    }
  }
}
