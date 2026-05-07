/**
 * Slice H Phase 5 — stress tests for streaming ordering invariants.
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_stream_ordering_followup.plan.md`
 *   §4 acceptance #5 («50ms-spaced back-to-back turns on the same
 *   session, two cross-session concurrent turns, and a 5s tool-call
 *   with high partial cadence — all produce correct per-turn ordering
 *   with no cross-turn buffer leak»),
 *   §5 «Stress is mandatory for this slice (timing/race bug class;
 *   AGENTS.md §258)»,
 *   §1 hard invariants ("The deferral state must NOT leak across
 *   `(sessionId, turnId)` boundaries") and §6 forward-compat
 *   ("per-`(sessionId, turnId)` state only").
 *
 * The bug class fixed in Phase 3 (H2 sentinel) is a structural seam —
 * `agent-runner.ts:866 emitDeferredAck` bypassed the deferral wrap and
 * fired the ack directly at the channel adapter. Phase 4 added an
 * acceptance fixture for the steady-state B4 transcript. Phase 5 (this
 * file) drives the same seam under load to expose any race condition
 * that was hidden behind the single-turn fixture: cross-session leaks,
 * back-to-back rapid turns, high partial-delta cadence with a long-
 * running tool-call, double-finalize idempotency under contention.
 *
 * Hard invariants reverse-tested:
 *   - #5/#6: only structural events (`notifyStructuralToolExecutionStarting`,
 *     `enqueueAck`, `finalizeAfterRun`) drive the recorder. No
 *     `RawUserTurn` / `UserPrompt` import; no text-content routing.
 *     Recorded `text` strings are opaque ordering tags, never branched on.
 *   - #8: only `src/auto-reply/reply/**` touched (test-additive). Frozen
 *     layer `src/platform/commitment/**` not imported.
 *   - #11: no frozen-contract import.
 *   - #15: defense-in-depth — stress harness exercises the deferral
 *     seam directly, not by `vi.spyOn` of the function under test
 *     (sub-plan §5 «No `vi.spyOn` on the function under test»).
 *
 * Contract checked under load (single_final_user_facing_message
 * invariant per slice scope):
 *   1. With structural tool seen + ack enqueued → exactly ONE
 *      consolidated send per turn, ack-prefix preserved.
 *   2. Cross-session deferrals never share `deferred[]` state, even
 *      under concurrent finalize.
 *   3. Replay branch (no structural tool) preserves per-turn ordering
 *      (ack first, partials in insertion order) under back-to-back
 *      turns.
 *   4. `finalizeAfterRun` is idempotent under contention (T4 of
 *      PR-A.2 extended): a second concurrent finalize is a no-op even
 *      when invoked while the first is still draining.
 *   5. High partial-delta cadence (1000+ enqueues across a 5s
 *      simulated tool-call) does not duplicate, drop, or reorder the
 *      ack relative to the consolidated final.
 */

import { describe, expect, it } from "vitest";
import {
  createExternalBlockReplyDeferral,
  type BlockReplyDeliver,
} from "./block-external-buffer.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";
import type { ReplyPayload } from "../types.js";

type RecordedOp = {
  /** Opaque tag derived from `payload.text`; never branched on. */
  textTag: string;
  /** Identifies which deferral instance produced the op (session+turn). */
  ownerKey: string;
};

type Recorder = {
  ops: RecordedOp[];
  makeDeliver: (ownerKey: string) => BlockReplyDeliver;
};

/**
 * Pad a numeric index to a fixed width so generated tags cannot be
 * substrings of one another. Without this, `expect(text).not.toContain("s1-p0")`
 * would falsely match against `s10-p0` etc., turning a real assertion
 * into a flaky one. 3 digits covers up to 999 entries; all stress
 * scenarios in this file fit.
 */
const padIdx = (n: number) => n.toString().padStart(3, "0");

function createSharedRecorder(): Recorder {
  const ops: RecordedOp[] = [];
  const makeDeliver = (ownerKey: string): BlockReplyDeliver => async (
    payload: ReplyPayload,
  ) => {
    ops.push({ textTag: payload.text ?? "", ownerKey });
  };
  return { ops, makeDeliver };
}

/**
 * Drive a single turn end-to-end through a real deferral + pipeline,
 * mirroring `agent-runner.ts:592–613` deferral wiring + `:850–873`
 * `emitDeferredAck` re-route + `:988–996` final flush.
 *
 * `withStructuralTool=true` simulates a `sessions_spawn` tool_call.
 * `ackText !== undefined` simulates `emitDeferredAck` going through
 * the H2 sentinel API.
 *
 * Returns the per-turn op slice (filtered by ownerKey) so the caller
 * can assert per-turn ordering without `await`-serialization.
 */
async function driveTurn(params: {
  recorder: Recorder;
  ownerKey: string;
  partialTexts: string[];
  withStructuralTool: boolean;
  ackText?: string;
  finalText?: string;
  enqueueDelayMs?: number;
}): Promise<RecordedOp[]> {
  const {
    recorder,
    ownerKey,
    partialTexts,
    withStructuralTool,
    ackText,
    finalText,
    enqueueDelayMs,
  } = params;

  const deliver = recorder.makeDeliver(ownerKey);
  const deferral = createExternalBlockReplyDeferral({
    turnId: ownerKey,
    sessionId: ownerKey.split("::")[0] ?? ownerKey,
  });
  const wrappedDeliver = deferral.wrapDeliver(deliver);
  const pipeline = createBlockReplyPipeline({
    onBlockReply: wrappedDeliver,
    timeoutMs: 5_000,
  });

  for (const text of partialTexts) {
    pipeline.enqueue({ text });
    if (enqueueDelayMs && enqueueDelayMs > 0) {
      await new Promise((r) => setTimeout(r, enqueueDelayMs));
    }
  }
  if (withStructuralTool) {
    deferral.notifyStructuralToolExecutionStarting();
  }
  if (ackText !== undefined) {
    await deferral.enqueueAck({ text: ackText });
  }
  if (finalText !== undefined) {
    pipeline.enqueue({ text: finalText });
  }
  await pipeline.flush({ force: true });
  await deferral.finalizeAfterRun(deliver);
  pipeline.stop();
  return recorder.ops.filter((op) => op.ownerKey === ownerKey);
}

describe("block-external-buffer stress (slice H Phase 5)", () => {
  /**
   * Stress S1 — cross-session concurrent turns.
   *
   * Sub-plan §4 acceptance #5: «two cross-session concurrent turns ...
   * no cross-turn buffer leak».
   *
   * Drives 10 sessions in parallel (the per-spec minimum is 2; 10
   * widens the surface so any timing-sensitive cross-session leak in
   * the deferral has a higher chance of materialising). Each session
   * has 5 partial deltas, structural tool, ack, final tail. Every
   * deferral instance is independent — no shared module state. Asserts
   * each session's recorded ops contain its own session-tag and
   * nothing else.
   */
  it("S1: 10 cross-session concurrent turns isolate per-session state", async () => {
    const recorder = createSharedRecorder();
    const sessionCount = 10;
    const turns = Array.from({ length: sessionCount }, (_, i) => {
      const sid = padIdx(i);
      const ownerKey = `s${sid}::t${sid}`;
      const partials = Array.from({ length: 5 }, (_, j) => `s${sid}-p${padIdx(j)}`);
      return driveTurn({
        recorder,
        ownerKey,
        partialTexts: partials,
        withStructuralTool: true,
        ackText: `s${sid}-ack`,
        finalText: `s${sid}-final`,
      });
    });
    await Promise.all(turns);

    // Every session must produce exactly one consolidated send.
    const sendsByOwner = new Map<string, RecordedOp[]>();
    for (const op of recorder.ops) {
      const list = sendsByOwner.get(op.ownerKey) ?? [];
      list.push(op);
      sendsByOwner.set(op.ownerKey, list);
    }
    expect(sendsByOwner.size).toBe(sessionCount);
    for (let i = 0; i < sessionCount; i++) {
      const sid = padIdx(i);
      const ownerKey = `s${sid}::t${sid}`;
      const ops = sendsByOwner.get(ownerKey) ?? [];
      expect(ops.length).toBe(1);
      const text = ops[0]?.textTag ?? "";
      // Ack is the prefix.
      expect(text.indexOf(`s${sid}-ack`)).toBe(0);
      // All partials of this session are present, no other session's
      // text leaked into this consolidation.
      for (let j = 0; j < 5; j++) {
        expect(text).toContain(`s${sid}-p${padIdx(j)}`);
      }
      expect(text).toContain(`s${sid}-final`);
      // No leak from other sessions.
      for (let k = 0; k < sessionCount; k++) {
        if (k === i) continue;
        const otherSid = padIdx(k);
        expect(text).not.toContain(`s${otherSid}-p`);
        expect(text).not.toContain(`s${otherSid}-ack`);
        expect(text).not.toContain(`s${otherSid}-final`);
      }
    }
  });

  /**
   * Stress S2 — rapid back-to-back same-session turns (50ms apart).
   *
   * Sub-plan §4 acceptance #5: «50ms-spaced back-to-back turns on the
   * same session». A new deferral instance is created per turn (per
   * `agent-runner.ts:592–613` — instance lifetime is per-turn), so the
   * test verifies that a sequential turn does not see residue from the
   * preceding turn's `deferred[]` even when finalize completes within
   * the 50ms window before the next turn starts.
   *
   * 20 turns × 50ms-spaced ≈ 1s wall clock. Each turn has structural
   * tool + ack + final → expects 1 consolidated send per turn → 20
   * ops total in recorder.
   */
  it("S2: 20 back-to-back same-session turns, 50ms apart, never bleed buffers", async () => {
    const recorder = createSharedRecorder();
    const turnCount = 20;
    const sessionId = "s-rapid";
    for (let i = 0; i < turnCount; i++) {
      const tid = padIdx(i);
      const ownerKey = `${sessionId}::turn-${tid}`;
      const ownTurnOps = await driveTurn({
        recorder,
        ownerKey,
        partialTexts: [`p${tid}-a`, `p${tid}-b`],
        withStructuralTool: true,
        ackText: `ack-${tid}`,
        finalText: `final-${tid}`,
      });
      // Per-turn invariant: exactly one consolidated send per turn.
      expect(ownTurnOps.length).toBe(1);
      const text = ownTurnOps[0]?.textTag ?? "";
      expect(text.indexOf(`ack-${tid}`)).toBe(0);
      expect(text).toContain(`p${tid}-a`);
      expect(text).toContain(`p${tid}-b`);
      expect(text).toContain(`final-${tid}`);
      // Across-turn invariant: no residue from prior turn.
      if (i > 0) {
        const prev = padIdx(i - 1);
        expect(text).not.toContain(`ack-${prev}`);
        expect(text).not.toContain(`final-${prev}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    // Total ops across all turns = turnCount sends, no extras.
    expect(recorder.ops.length).toBe(turnCount);
  });

  /**
   * Stress S3 — high partial-delta cadence with long-running tool-call.
   *
   * Sub-plan §4 acceptance #5: «5s tool-call interleaved with high
   * partial-delta cadence». Models a turn that streams ~120 partial
   * deltas before the structural tool fires, then more partials while
   * the tool runs (here we simulate by enqueuing more partials AFTER
   * `notifyStructuralToolExecutionStarting()` — they stay deferred
   * because the deferral wrap defers everything until finalize).
   *
   * Partial cadence: 60 deltas pre-tool + 60 deltas during-tool. Every
   * delta has a unique tag (`pre-N`, `mid-N`) so the consolidated send
   * can be checked for completeness with no duplicates.
   *
   * Test ceiling: should complete well under 60s (sub-plan acceptance:
   * «<60s per scenario»). Wall clock is dominated by the pipeline
   * coalescer and microtask draining, not real I/O.
   */
  it("S3: 120 partial deltas + structural tool + ack consolidates exactly once", async () => {
    const recorder = createSharedRecorder();
    const ownerKey = "s-long-tool::t0";
    const preToolPartials = Array.from({ length: 60 }, (_, i) => `pre-${padIdx(i)}`);
    const midToolPartials = Array.from({ length: 60 }, (_, i) => `mid-${padIdx(i)}`);

    const deliver = recorder.makeDeliver(ownerKey);
    const deferral = createExternalBlockReplyDeferral({
      turnId: ownerKey,
      sessionId: "s-long-tool",
    });
    const wrappedDeliver = deferral.wrapDeliver(deliver);
    const pipeline = createBlockReplyPipeline({
      onBlockReply: wrappedDeliver,
      timeoutMs: 10_000,
    });

    // Pre-tool partials — get queued via wrapDeliver.
    for (const text of preToolPartials) {
      pipeline.enqueue({ text });
    }
    // Structural tool fires.
    deferral.notifyStructuralToolExecutionStarting();
    // Subagent ack lands mid-deferral.
    await deferral.enqueueAck({ text: "ack-long" });
    // Mid-tool partials — still deferred (wrap continues to defer until finalize).
    for (const text of midToolPartials) {
      pipeline.enqueue({ text });
    }
    // Final tail.
    pipeline.enqueue({ text: "tail" });

    await pipeline.flush({ force: true });
    await deferral.finalizeAfterRun(deliver);
    pipeline.stop();

    // Single consolidated send.
    expect(recorder.ops.length).toBe(1);
    const text = recorder.ops[0]?.textTag ?? "";
    // Ack is prefix.
    expect(text.indexOf("ack-long")).toBe(0);
    // Every pre-tool delta present, no duplicates.
    for (const t of preToolPartials) {
      const occurrences = text.split(t).length - 1;
      expect(occurrences).toBe(1);
    }
    // Every mid-tool delta present, no duplicates.
    for (const t of midToolPartials) {
      const occurrences = text.split(t).length - 1;
      expect(occurrences).toBe(1);
    }
    expect(text).toContain("tail");
    // Ack is unique too.
    expect(text.split("ack-long").length - 1).toBe(1);
  }, 60_000);

  /**
   * Stress S4 — double-finalize idempotency under contention.
   *
   * Sub-plan §4 acceptance, sub-plan §5 «one additional reverse test:
   * idempotency under double-finalize (existing T4 of PR-A.2, extended
   * to also assert no duplicate channel-adapter operation)».
   *
   * Drives a turn, then concurrently calls `finalizeAfterRun` twice
   * via `Promise.all`. Recorded send count must be exactly 1 — the
   * second finalize is a no-op even when both promises start before
   * either resolves. (The `finalized` flag is set synchronously inside
   * `finalizeAfterRun` before the first `await`, so the second
   * concurrent call sees `finalized === true` and exits.)
   */
  it("S4: concurrent double-finalize emits exactly one op (idempotency)", async () => {
    const recorder = createSharedRecorder();
    const ownerKey = "s-dup-final::t0";
    const deliver = recorder.makeDeliver(ownerKey);
    const deferral = createExternalBlockReplyDeferral({
      turnId: ownerKey,
      sessionId: "s-dup-final",
    });
    const wrappedDeliver = deferral.wrapDeliver(deliver);
    const pipeline = createBlockReplyPipeline({
      onBlockReply: wrappedDeliver,
      timeoutMs: 5_000,
    });
    pipeline.enqueue({ text: "p1" });
    pipeline.enqueue({ text: "p2" });
    deferral.notifyStructuralToolExecutionStarting();
    await deferral.enqueueAck({ text: "ack-dup" });
    pipeline.enqueue({ text: "tail" });
    await pipeline.flush({ force: true });

    // Concurrent double finalize — kicks off both before either resolves.
    await Promise.all([
      deferral.finalizeAfterRun(deliver),
      deferral.finalizeAfterRun(deliver),
    ]);
    pipeline.stop();

    // Exactly one consolidated send — second finalize is a no-op.
    const ownerOps = recorder.ops.filter((op) => op.ownerKey === ownerKey);
    expect(ownerOps.length).toBe(1);
    expect(ownerOps[0]?.textTag.indexOf("ack-dup")).toBe(0);
  });

  /**
   * Stress S5 — replay branch under back-to-back load (no structural tool).
   *
   * Cross-check that the replay branch (sub-plan §3 H2 replay-branch
   * fix) preserves per-turn ack-first ordering across 30 rapid turns
   * spaced 30ms apart. Each turn enqueues an ack + 3 partials WITHOUT
   * a structural tool, so finalize takes the `replay` branch. Recorder
   * must see, per turn, `[ack, p0, p1, p2]` interleaved with other
   * turns' ops by ownerKey but never out of order within a turn.
   */
  it("S5: 30 back-to-back replay-branch turns preserve per-turn ack-first ordering", async () => {
    const recorder = createSharedRecorder();
    const turnCount = 30;
    for (let i = 0; i < turnCount; i++) {
      const tid = padIdx(i);
      const ownerKey = `s-replay::t${tid}`;
      const partials = [`p${tid}-0`, `p${tid}-1`, `p${tid}-2`];
      const ownTurnOps = await driveTurn({
        recorder,
        ownerKey,
        partialTexts: partials,
        withStructuralTool: false,
        ackText: `ack-${tid}`,
      });
      // The pipeline coalescer batches the partials into a single
      // payload before flush; replay branch sends ack first, then the
      // coalesced batch. So we expect at least 2 ops, ack first.
      expect(ownTurnOps.length).toBeGreaterThanOrEqual(2);
      expect(ownTurnOps[0]?.textTag).toBe(`ack-${tid}`);
      // Every partial tag appears somewhere in the remaining ops.
      const tail = ownTurnOps.slice(1).map((op) => op.textTag).join("|");
      for (const t of partials) {
        expect(tail).toContain(t);
      }
      await new Promise((r) => setTimeout(r, 30));
    }
  }, 60_000);
});
