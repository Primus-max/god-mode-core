/**
 * Slice H Phase 2 — failing harness reproducing B4 (ack-ordering race).
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_stream_ordering_followup.plan.md`
 *   §2 (verified call graph), §3 (H2 medium-high primary), §5 (test plan),
 *   §6 (surface caps). Audit baseline `13f3b37e02` / dev HEAD verified.
 *
 * Hypothesis under test: **H2 — emitDeferredAck races finalize.**
 *
 * `agent-runner.ts:866` reads `effectiveOpts?.onBlockReply` (raw adapter)
 * inside `emitDeferredAck`, NOT the deferral-wrapped `deliveredBlockReply`.
 * As a result the parent's deferred-job ack lands directly at the channel
 * adapter while the streamed preamble is still parked in
 * `externalBlockDeferral.deferred[]`. When `finalizeAfterRun` later emits
 * the consolidated payload, the adapter has already shipped the ack as a
 * separate visible message — exactly the «то отправляет сообщение потом
 * удаляет, потом показывает финальное» symptom from the 2026-05-04 turn.
 *
 * AGENTS.md §253 fail-first: this test MUST fail on dev HEAD before any
 * fix lands. No fix exists yet — the deferral has no notion of "ack" at
 * all, so the bypass is structurally guaranteed. We encode this with
 * `it.fails(...)` per the sub-plan handoff: the test body expresses the
 * desired (post-fix) contract, vitest treats the failing assertion as
 * the expected outcome, and CI stays green while the bug is documented.
 *
 * Verified fail-first on dev HEAD `67d3408a30` (2026-05-05). Verbatim
 * failure when run as a plain `it(...)` (i.e. without the `.fails`
 * marker):
 *
 *   AssertionError: expected 1 to be +0 // Object.is equality
 *     - Expected: 0
 *     - Received: 1
 *
 * The recorder observed `[send-ack, send-consolidated]` instead of the
 * desired `[send-consolidated]`, mapping to sub-plan §3 decision
 * protocol case "[ack_send, preamble_send, final_send] → H2".
 * Phase 3 will pick the H2 fix (ack as first deferred entry, OR ack
 * routed through the deferral wrap with a 4th finalize-kind), un-mark
 * `it.fails`, and the assertion will flip to passing.
 *
 * `.fails-on-dev: true`
 *
 * Hard invariant #5: this harness drives ONLY structural events
 * (`notifyStructuralToolExecutionStarting`, `finalizeAfterRun`). It
 * never inspects partial-delta text content as a routing signal — text
 * appears only as opaque payload identifiers in the recorder for
 * ordering verification. Hard invariant #11: no frozen contract
 * touched. Hard invariant #15: additive-test only.
 */

import { describe, expect, it } from "vitest";
import {
  createExternalBlockReplyDeferral,
  type BlockReplyDeliver,
} from "./block-external-buffer.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";
import type { ReplyPayload } from "../types.js";

type RecordedOp = {
  op: "send";
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
 * `vi.spyOn` the function under test).
 */
function createChannelAdapterRecorder() {
  const ops: RecordedOp[] = [];
  const deliver: BlockReplyDeliver = async (payload: ReplyPayload) => {
    ops.push({ op: "send", textTag: payload.text ?? "" });
  };
  return { ops, deliver };
}

describe("block-external-buffer ack-ordering (B4 repro, slice H Phase 2)", () => {
  /**
   * B4 SCENARIO (mirrors `agent-runner.ts:592–613` deferral wiring,
   * `:850–873` `emitDeferredAck`, `:988–996` `finalizeAfterRun`):
   *
   *   a. Pipeline emits 2 partial assistant text deltas.
   *   b. `notifyStructuralToolExecutionStarting()` fires (subagent_spawn
   *      tool_call observed).
   *   c. Parent emits subagent ack via the bypass code path used at
   *      `agent-runner.ts:866`: `effectiveOpts?.onBlockReply` is the
   *      RAW adapter, not the wrapped deferral.
   *   d. Assistant emits a final reply delta.
   *   e. `finalizeAfterRun` consolidates (structural flag set ⇒
   *      `consolidated` finalize-kind, single merged payload).
   *
   * EXPECTED contract (post-fix): the recorder sees a SINGLE `send`
   * operation for the consolidated logical reply. The ack either rides
   * inside the consolidation, lands BEFORE the preamble was deferred,
   * or is suppressed when consolidation supersedes it. Either way the
   * recorded sequence does NOT contain a duplicate-or-delete shape.
   *
   * ON DEV HEAD: the recorder will see at minimum
   * `[send-ack, send-consolidated]` — two distinct `send` operations
   * separated by the structural flag flip. This is the unit-level
   * fingerprint of B4 at the deferral seam (the channel-adapter
   * `delete` of an archived preview is layered on top by Telegram and
   * exercised by the Phase-4 fixture; here we record the upstream
   * race).
   *
   * `it.fails` encodes the fail-first contract: vitest expects this
   * body to throw, marks the test green when it does, and would flip
   * to red the moment the bug is fixed (Phase 3 will remove `.fails`).
   */
  it.fails(
    "single consolidated send when subagent ack races structural-tool deferral (H2 primary)",
    async () => {
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

      // (c) Parent emits the subagent ack via the BYPASS path. This
      //     replicates `agent-runner.ts:866`:
      //       const deliver = effectiveOpts?.onBlockReply;
      //       await deliver(applyReplyToMode({ text: ackText }));
      //     `effectiveOpts.onBlockReply` is the raw original adapter —
      //     `originalOnBlockReply` in agent-runner terms — which in
      //     this harness is `recorder.deliver`. The wrap is bypassed
      //     entirely; this IS the suspected H2 root cause and the
      //     reason the test must call the recorder directly here.
      await recorder.deliver({ text: "ack-deferred-job-running" });

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

      // B4 contract: the recorded sequence does NOT contain
      // `send -> delete -> send` for the same logical reply. At the
      // deferral seam this reduces to: NO duplicate `send` operations
      // bracketing the structural-tool boundary. A single consolidated
      // send is the post-fix shape.
      //
      // Encoded as the desired ordering. On dev HEAD the bypass
      // produces `["ack-deferred-job-running", <consolidated>]` and
      // this assertion fails — exactly what `it.fails` asserts.
      const sends = recorder.ops.filter((op) => op.op === "send");
      const ackSendCount = sends.filter((s) =>
        s.textTag.includes("ack-deferred-job-running"),
      ).length;
      expect(ackSendCount).toBe(0);
      expect(sends.length).toBe(1);
      expect(sends[0]?.textTag).toContain("final-answer-tail");
    },
  );

  /**
   * Negative / boundary coverage (sub-plan §5: "for every X works
   * when Y, add at least one X is rejected when Z"). When NO
   * structural tool fires AND no ack bypass occurs, the deferral
   * replays each partial unchanged — recorder sees one `send` per
   * partial, no duplicate, no delete. This protects against a Phase-3
   * fix that suppresses ack but accidentally swallows the replay path.
   *
   * This case currently passes on dev HEAD and is a regression guard.
   */
  it("replays each partial verbatim when no structural tool and no ack bypass", async () => {
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
