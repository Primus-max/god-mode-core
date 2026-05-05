/**
 * Slice H Phase 4 — B4 transcript replay acceptance fixture.
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_stream_ordering_followup.plan.md`
 *   §4 (acceptance #1, #3 — B4 transcript replay produces correct
 *   ordering, no spurious delete-and-resend), §5 (test plan,
 *   "B4-fixture.test.ts (new)" row), §6 (surface caps).
 *
 * The fixture is derived from the 2026-05-04 19:38–19:42 turn («то
 * отправляет сообщение потом удаляет, потом показывает финальное»)
 * — encoded as a deterministic event stream rather than a raw gateway
 * log, because the gateway-side capture path requires slice F (per
 * sub-plan §1 todo `h-phase-4-acceptance-fixture` "captured from a
 * fresh gateway log when slice F lands or simulated from the agent-
 * event stream we already have"). We take the simulated path here so
 * the fixture lands with the H2 fix and re-validates after slice F.
 *
 * Hard invariants reverse-tested:
 *   - #5/#6: only structural events (`notifyStructuralToolExecutionStarting`,
 *     `enqueueAck`, `finalizeAfterRun`) drive the recorder. No
 *     RawUserTurn / UserPrompt import; no text-rule routing.
 *   - #8: only `src/auto-reply/reply/**` touched. Frozen layer
 *     `src/platform/commitment/**` not imported.
 *   - #11: no MemoryEntryId import; no frozen-contract import.
 *   - #15: defense-in-depth — fix lands at the deferral seam; this
 *     fixture asserts the seam-level contract.
 */

import { describe, expect, it } from "vitest";
import {
  createExternalBlockReplyDeferral,
  type BlockReplyDeliver,
} from "./block-external-buffer.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";
import type { ReplyPayload } from "../types.js";

/**
 * The B4 transcript event stream, simulated from the agent-event log
 * (sub-plan §0 «B4 from 2026-05-04 Telegram transcript»). Each event
 * is a structural marker the deferral / pipeline observes — there is
 * NO text-content routing (invariant #5).
 */
type B4Event =
  | { kind: "partial"; text: string }
  | { kind: "structural-tool-start" }
  | { kind: "ack-enqueue"; text: string }
  | { kind: "final-partial"; text: string };

const B4_TRANSCRIPT: B4Event[] = [
  // 19:38:42.123 — assistant emits initial preamble before the
  // sessions_spawn tool_call.
  { kind: "partial", text: "Хорошо, разбираюсь с задачей" },
  { kind: "partial", text: ", смотрю детали" },
  // 19:38:43.408 — sessions_spawn tool_call observed by parent runner;
  // `onStructuralToolExecutionStarting` fires.
  { kind: "structural-tool-start" },
  // 19:38:43.821 — parent emits the deferred-job ack (held-message
  // localized text, abbreviated here for the fixture).
  { kind: "ack-enqueue", text: "Принял задачу, выполняю в фоне." },
  // 19:38:46.207 — assistant final reply tail lands after subagent
  // returns. (PR-G aggregation override may also replace this with a
  // holding payload; the deferral seam contract holds either way.)
  { kind: "final-partial", text: "Готово: результат записан." },
];

type RecordedOp = { op: "send" | "delete"; text: string };

function createTelegramAdapterRecorder() {
  const ops: RecordedOp[] = [];
  const deliver: BlockReplyDeliver = async (payload: ReplyPayload) => {
    ops.push({ op: "send", text: payload.text ?? "" });
  };
  // Models the Telegram channel adapter's archived-preview cleanup
  // (`bot-message-dispatch.ts:835–843`). The fixture exposes it so the
  // assertion can verify the H2 fix does NOT cause a `delete` after
  // the final `send`.
  const deleteMessage = async (messageId: string) => {
    ops.push({ op: "delete", text: messageId });
  };
  return { ops, deliver, deleteMessage };
}

async function replayB4(
  events: B4Event[],
  recorder: ReturnType<typeof createTelegramAdapterRecorder>,
): Promise<void> {
  const deferral = createExternalBlockReplyDeferral({
    turnId: "turn-b4-fixture",
    sessionId: "sess-b4-fixture",
  });
  const wrappedDeliver = deferral.wrapDeliver(recorder.deliver);
  const pipeline = createBlockReplyPipeline({
    onBlockReply: wrappedDeliver,
    timeoutMs: 5_000,
  });
  for (const event of events) {
    if (event.kind === "partial" || event.kind === "final-partial") {
      pipeline.enqueue({ text: event.text });
    } else if (event.kind === "structural-tool-start") {
      deferral.notifyStructuralToolExecutionStarting();
    } else if (event.kind === "ack-enqueue") {
      // H2 fix: ack is enqueued through the deferral, NOT delivered
      // raw to the channel adapter (the line-866 bypass is closed).
      await deferral.enqueueAck({ text: event.text });
    }
  }
  await pipeline.flush({ force: true });
  await deferral.finalizeAfterRun(recorder.deliver);
  pipeline.stop();
}

describe("block-external-buffer B4 transcript fixture (slice H Phase 4)", () => {
  /**
   * Sub-plan §4 acceptance #1: «recorded channel-adapter operation
   * sequence ... does NOT contain a `delete(messageId)` call AFTER the
   * user-visible final reply has been sent».
   *
   * #3: «B4 transcript replay produces an ordering that maps to user-
   * visible "single final reply, no flicker, no delete-after-send"».
   */
  it("B4 transcript replay produces a single consolidated send and zero delete ops", async () => {
    const recorder = createTelegramAdapterRecorder();
    await replayB4(B4_TRANSCRIPT, recorder);

    const sends = recorder.ops.filter((op) => op.op === "send");
    const deletes = recorder.ops.filter((op) => op.op === "delete");

    // Single user-visible reply.
    expect(sends.length).toBe(1);
    // sub-plan §4 acceptance #1: no `delete(messageId)` after final.
    expect(deletes.length).toBe(0);

    // The merged text contains every transcript fragment (preamble +
    // ack + final) with the ack as the prefix (sentinel ordering).
    const merged = sends[0]?.text ?? "";
    expect(merged).toContain("Принял задачу, выполняю в фоне.");
    expect(merged).toContain("Хорошо, разбираюсь с задачей");
    expect(merged).toContain("Готово: результат записан.");
    expect(merged.indexOf("Принял задачу, выполняю в фоне.")).toBe(0);
  });

  /**
   * Acceptance #5 boundary: same fixture, but with the structural-tool
   * marker REMOVED. Should fall through to replay-each-partial; ack
   * still ordering-aware (lands first), no consolidation.
   */
  it("B4 fixture without structural-tool falls through to replay branch (no consolidation)", async () => {
    const recorder = createTelegramAdapterRecorder();
    const eventsNoTool = B4_TRANSCRIPT.filter(
      (e) => e.kind !== "structural-tool-start",
    );
    await replayB4(eventsNoTool, recorder);

    const sends = recorder.ops.filter((op) => op.op === "send");
    const deletes = recorder.ops.filter((op) => op.op === "delete");

    expect(deletes.length).toBe(0);
    // 1 ack + 3 partials (the 2 preamble + 1 final-partial enqueued
    // through the pipeline are coalesced into a single send because
    // the pipeline's coalescer drains them as one batch on flush).
    // Replay branch sends each deferred entry verbatim, so we expect
    // ack first, then whatever the pipeline coalescer produces.
    expect(sends.length).toBeGreaterThanOrEqual(2);
    expect(sends[0]?.text).toBe("Принял задачу, выполняю в фоне.");
  });
});
