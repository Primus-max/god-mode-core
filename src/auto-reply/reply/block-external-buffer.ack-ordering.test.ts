/**
 * Slice H Phase 3 — B4 ack-ordering acceptance (H2 fix landed).
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_stream_ordering_followup.plan.md`
 *   §2 (verified call graph), §3 (H2 chosen), §4 (acceptance), §5 (test
 *   plan), §6 (surface caps). Audit baseline dev HEAD `fc26c16bce`.
 *
 * Phase 2 (PR-#155) landed this harness with `it.fails` because the
 * deferral had no notion of "ack" at all. Phase 3 (this PR) introduces
 * `deferral.enqueueAck(payload)` (sentinel-entry path; sub-plan §3 H2
 * option (a)) AND re-routes `agent-runner.ts:866 emitDeferredAck` to use
 * the new API when a deferral is active. The bypass is closed; the ack
 * now lands ordering-aware through the same wrapped deliver as every
 * other block payload.
 *
 * Phase 2 verbatim failure (recorded on dev HEAD `67d3408a30`):
 *   AssertionError: expected 1 to be +0 // Object.is equality
 *     - Expected: 0
 *     - Received: 1
 *   Recorded order: `[send-ack, send-consolidated]`.
 * Mapping per sub-plan §3 decision protocol:
 *   `[ack_send, preamble_send, final_send] → H2 (medium-high primary)`.
 *
 * Post-fix contract (asserted below):
 *   - On a turn where structural tool fires AND ack is enqueued through
 *     the deferral, the recorder observes a SINGLE consolidated `send`
 *     whose text contains BOTH the ack prefix AND the streamed
 *     preamble + final tail. No standalone ack send.
 *   - The recorder NEVER observes a `delete` operation (sub-plan §4
 *     acceptance #1: no `delete(messageId)` after final `sendMessage`).
 *
 * Hard invariant #5: this harness drives ONLY structural events
 * (`notifyStructuralToolExecutionStarting`, `enqueueAck`,
 * `finalizeAfterRun`). It never inspects partial-delta text content as
 * a routing signal — text appears only as opaque payload identifiers
 * in the recorder for ordering verification. Hard invariant #11: no
 * frozen contract touched. Hard invariant #15: defense-in-depth — the
 * fix lands at the deferral seam, not by removing emit-ack from
 * agent-runner.
 */

import { describe, expect, it } from "vitest";
import {
  createExternalBlockReplyDeferral,
  type BlockReplyDeliver,
} from "./block-external-buffer.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";
import type { ReplyPayload } from "../types.js";

type RecordedOp = {
  op: "send" | "delete";
  /**
   * Opaque tag derived from payload `text` purely for ordering audit
   * (NOT for routing). Allowed under invariant #5 because the recorder
   * is test infrastructure that observes structural ordering, not a
   * code path that branches on user/assistant text content.
   */
  textTag: string;
};

/**
 * Mock channel-adapter recorder. Stands in for the Telegram bot-message-
 * dispatch adapter. The recorder is the only stub permitted per the
 * sub-plan §5: it is real test infrastructure (it records, it does not
 * `vi.spyOn` the function under test). The recorder also exposes a
 * `deleteMessage` hook to surface any `delete(messageId)` operation —
 * sub-plan §4 acceptance #1 forbids `delete` after final `sendMessage`.
 */
function createChannelAdapterRecorder() {
  const ops: RecordedOp[] = [];
  const deliver: BlockReplyDeliver = async (payload: ReplyPayload) => {
    ops.push({ op: "send", textTag: payload.text ?? "" });
  };
  const deleteMessage = async (messageId: string) => {
    ops.push({ op: "delete", textTag: messageId });
  };
  return { ops, deliver, deleteMessage };
}

describe("block-external-buffer ack-ordering (B4 acceptance, slice H Phase 3)", () => {
  /**
   * B4 SCENARIO (mirrors `agent-runner.ts:592–613` deferral wiring,
   * `:850–873` `emitDeferredAck`, `:988–996` `finalizeAfterRun`):
   *
   *   a. Pipeline emits 2 partial assistant text deltas.
   *   b. `notifyStructuralToolExecutionStarting()` fires (subagent_spawn
   *      tool_call observed).
   *   c. Parent enqueues subagent ack via the new H2 sentinel API:
   *      `deferral.enqueueAck(payload)`. Replaces the bypass at
   *      `agent-runner.ts:866` (`effectiveOpts?.onBlockReply`), keeping
   *      the ack ordering-aware with the rest of the deferred stream.
   *   d. Assistant emits a final reply delta.
   *   e. `finalizeAfterRun` consolidates (structural flag set ⇒
   *      `consolidated` finalize-kind). Per the sentinel contract the
   *      ack rides as the FIRST line of the merged payload — single
   *      `send` operation total, ack text is a prefix of the merged
   *      text, no standalone ack send, no `delete(messageId)`.
   *
   * Post-fix recorded ordering (asserted): `[send-consolidated]` (1
   * op). The ack is rolled into the consolidated send so the visible
   * UX is "one final reply, no flicker" (sub-plan §4 acceptance #2,
   * "ack rides inside the consolidation" branch).
   */
  it("single consolidated send with ack-prefix when subagent ack arrives mid-deferral (H2 sentinel)", async () => {
    const recorder = createChannelAdapterRecorder();

    // Real deferral instance — NOT spied. (sub-plan §5)
    const deferral = createExternalBlockReplyDeferral({
      turnId: "turn-b4-h2",
      sessionId: "sess-b4-h2",
    });

    // Wrap the recorder with the deferral, exactly as
    // `agent-runner.ts:606–614` does:
    //   wrapped = externalBlockDeferral.wrapDeliver(streamingAwareBlockReply)
    //   deliveredBlockReply = (payload, options) => wrapped(payload, options)
    const wrappedDeliver = deferral.wrapDeliver(recorder.deliver);

    // Real pipeline instance — NOT spied. The pipeline's
    // `onBlockReply` is the wrapped deferral, mirroring
    // `agent-runner.ts:625–633`.
    const pipeline = createBlockReplyPipeline({
      onBlockReply: wrappedDeliver,
      timeoutMs: 5_000,
    });

    // (a) Two partial assistant text deltas through the pipeline.
    //     These get queued via `wrapDeliver` into `deferred[]` (no
    //     send to recorder yet).
    pipeline.enqueue({ text: "preamble-part-1" });
    pipeline.enqueue({ text: "preamble-part-2" });

    // (b) Structural tool execution observed (e.g. `subagent_spawn`).
    //     This is the only signal `block-external-buffer` exposes for
    //     finalize-kind selection. Per invariant #5 the test reaches
    //     for this structural API directly — no text inspection.
    deferral.notifyStructuralToolExecutionStarting();

    // (c) Parent enqueues the subagent ack through the H2 sentinel
    //     API. Mirrors the post-fix `agent-runner.ts:865–872` re-route:
    //     when `externalBlockDeferral` is active, `emitDeferredAck`
    //     calls `externalBlockDeferral.enqueueAck(payload)` instead of
    //     pulling `effectiveOpts.onBlockReply` directly. The ack
    //     payload is queued as the FIRST entry of `deferred[]` with a
    //     sentinel marker.
    await deferral.enqueueAck({ text: "ack-deferred-job-running" });

    // (d) Assistant final reply delta lands. After the structural
    //     flag flipped at (b), the wrap still defers — finalize is
    //     where the consolidation actually emits.
    pipeline.enqueue({ text: "final-answer-tail" });

    // Drain the pipeline so any queued send-chain promises settle
    // (mirrors `agent-runner.ts:989` `pipeline.flush({ force: true })`).
    await pipeline.flush({ force: true });

    // (e) Finalize the deferral with the same `streamingAwareBlockReply`
    //     the production wiring uses (the recorder, here). Mirrors
    //     `agent-runner.ts:991–992`. With the structural flag set, the
    //     deferral takes the `consolidated` branch and emits ONE
    //     merged payload.
    await deferral.finalizeAfterRun(recorder.deliver);

    pipeline.stop();

    // B4 acceptance: NO duplicate `send` operations bracketing the
    // structural-tool boundary. A single consolidated send is the
    // post-fix shape; the ack rides as a prefix of the merged text.
    const sends = recorder.ops.filter((op) => op.op === "send");
    const deletes = recorder.ops.filter((op) => op.op === "delete");
    expect(sends.length).toBe(1);
    expect(deletes.length).toBe(0); // sub-plan §4 acceptance #1
    const consolidated = sends[0]?.textTag ?? "";
    expect(consolidated).toContain("ack-deferred-job-running");
    expect(consolidated).toContain("preamble-part-1");
    expect(consolidated).toContain("preamble-part-2");
    expect(consolidated).toContain("final-answer-tail");
    // Ack must be the FIRST line of the merged text (sentinel-prefix).
    expect(consolidated.indexOf("ack-deferred-job-running")).toBe(0);
  });

  /**
   * Replay path: structural tool DID NOT fire. The ack is enqueued
   * via the sentinel API and finalize takes the `replay` branch (no
   * consolidation). The ack must replay as the FIRST `send` so the
   * recorded ordering stays ack-before-preamble (sub-plan §4 #2:
   * "lands BEFORE the streaming preamble").
   */
  it("ack replays first when no structural tool fires (H2 sentinel replay branch)", async () => {
    const recorder = createChannelAdapterRecorder();
    const deferral = createExternalBlockReplyDeferral({
      turnId: "turn-b4-h2-replay",
      sessionId: "sess-b4-h2-replay",
    });
    const wrappedDeliver = deferral.wrapDeliver(recorder.deliver);
    const pipeline = createBlockReplyPipeline({
      onBlockReply: wrappedDeliver,
      timeoutMs: 5_000,
    });
    pipeline.enqueue({ text: "preamble-1" });
    await deferral.enqueueAck({ text: "ack-msg" });
    pipeline.enqueue({ text: "preamble-2" });
    await pipeline.flush({ force: true });
    // No `notifyStructuralToolExecutionStarting()` — replay branch.
    await deferral.finalizeAfterRun(recorder.deliver);
    pipeline.stop();
    const sends = recorder.ops.filter((op) => op.op === "send");
    const deletes = recorder.ops.filter((op) => op.op === "delete");
    expect(deletes.length).toBe(0);
    expect(sends.map((s) => s.textTag)).toEqual([
      "ack-msg",
      "preamble-1",
      "preamble-2",
    ]);
  });

  /**
   * Negative coverage (sub-plan §4 acceptance #5): turn with NO
   * tool-call → no ack → recorder sees ONLY the streaming replay /
   * single-payload send. Protects against a Phase-3 fix that
   * accidentally injects an empty ack into every turn.
   */
  it("no ack at all → ordering = [send-consolidated] only (negative coverage)", async () => {
    const recorder = createChannelAdapterRecorder();
    const deferral = createExternalBlockReplyDeferral({
      turnId: "turn-b4-no-ack",
      sessionId: "sess-b4-no-ack",
    });
    const wrappedDeliver = deferral.wrapDeliver(recorder.deliver);
    const pipeline = createBlockReplyPipeline({
      onBlockReply: wrappedDeliver,
      timeoutMs: 5_000,
    });
    pipeline.enqueue({ text: "alpha" });
    pipeline.enqueue({ text: "beta" });
    deferral.notifyStructuralToolExecutionStarting();
    pipeline.enqueue({ text: "gamma" });
    await pipeline.flush({ force: true });
    await deferral.finalizeAfterRun(recorder.deliver);
    pipeline.stop();
    const sends = recorder.ops.filter((op) => op.op === "send");
    const deletes = recorder.ops.filter((op) => op.op === "delete");
    expect(deletes.length).toBe(0);
    expect(sends.length).toBe(1);
    expect(sends[0]?.textTag).toBe("alpha\n\nbeta\n\ngamma");
  });

  /**
   * Idempotency boundary: a duplicate `enqueueAck` for the same turn
   * must NOT insert a duplicate ack into the deferred buffer (sub-plan
   * §6 implementation note: "ack key tracked so a second
   * `emitDeferredAck` call does not insert a duplicate").
   */
  it("duplicate enqueueAck is suppressed (idempotency, sub-plan §6)", async () => {
    const recorder = createChannelAdapterRecorder();
    const deferral = createExternalBlockReplyDeferral({
      turnId: "turn-b4-h2-dup",
      sessionId: "sess-b4-h2-dup",
    });
    const wrappedDeliver = deferral.wrapDeliver(recorder.deliver);
    const pipeline = createBlockReplyPipeline({
      onBlockReply: wrappedDeliver,
      timeoutMs: 5_000,
    });
    pipeline.enqueue({ text: "preamble" });
    deferral.notifyStructuralToolExecutionStarting();
    await deferral.enqueueAck({ text: "ack-once" });
    await deferral.enqueueAck({ text: "ack-twice" }); // suppressed
    pipeline.enqueue({ text: "final" });
    await pipeline.flush({ force: true });
    await deferral.finalizeAfterRun(recorder.deliver);
    pipeline.stop();
    const sends = recorder.ops.filter((op) => op.op === "send");
    expect(sends.length).toBe(1);
    const consolidated = sends[0]?.textTag ?? "";
    expect(consolidated).toContain("ack-once");
    expect(consolidated).not.toContain("ack-twice");
  });

  /**
   * Negative / boundary coverage (sub-plan §5: "for every X works
   * when Y, add at least one X is rejected when Z"). When NO
   * structural tool fires AND no ack is enqueued, the deferral
   * replays each partial unchanged — recorder sees one `send` per
   * partial, no duplicate, no delete.
   */
  it("replays each partial verbatim when no structural tool and no ack", async () => {
    const recorder = createChannelAdapterRecorder();
    const deferral = createExternalBlockReplyDeferral({
      turnId: "turn-b4-no-tool",
      sessionId: "sess-b4-no-tool",
    });
    const wrappedDeliver = deferral.wrapDeliver(recorder.deliver);
    const pipeline = createBlockReplyPipeline({
      onBlockReply: wrappedDeliver,
      timeoutMs: 5_000,
    });
    pipeline.enqueue({ text: "alpha" });
    pipeline.enqueue({ text: "beta" });
    await pipeline.flush({ force: true });
    await deferral.finalizeAfterRun(recorder.deliver);
    pipeline.stop();
    const sends = recorder.ops.filter((op) => op.op === "send");
    expect(sends.map((s) => s.textTag)).toEqual(["alpha", "beta"]);
  });
});
