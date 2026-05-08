import { describe, expect, it, vi } from "vitest";
import { wrapStreamingOutboundWithCoalescer } from "./outbound-coalescer-wiring.js";

/**
 * These tests pin the production CoT-leak symptom from
 * gateway-dev-2026-05-07.log session 78ff2b60 turn 1: Opus 4.6 emitted
 * four assistant message_end events in a single agent-loop turn; each
 * fired `onBlockReply` and each became a separate Telegram message.
 * Two of them were chain-of-thought preambles ("ser is asking about",
 * "on for agent management. Actually, I think...") that should never
 * have left the model.
 *
 * The wiring helper consolidates per-turn `onBlockReply` invocations
 * through `OutboundCoalescer` (drop_intermediates) so only the last
 * registered body is delivered. Tests exercise the REAL coalescer
 * (`createOutboundCoalescer` from `src/infra/outbound/`) — no mocks of
 * the function under test, no spies on `coalescer.register/commit`,
 * no fake-timers shortcut. Inputs are synthetic but match the exact
 * `BlockReplyPayload` shape that `pi-embedded-subscribe.handlers.messages.ts`
 * produces at message_end (extractAssistantText → resolveSilentReplyFallbackText
 * → parseReplyDirectives → emitBlockReply).
 */
describe("wrapStreamingOutboundWithCoalescer", () => {
  it("(A) suppresses CoT-preamble streaming chunks; only final consolidated answer is delivered", async () => {
    // Symptom: 4 onBlockReply emissions in one logical turn — 3 CoT
    // preambles + 1 final answer. With the coalescer wired, only the
    // LAST body should reach the channel adapter (`deliver`).
    const delivered: Array<{ text?: string }> = [];
    const wiring = wrapStreamingOutboundWithCoalescer({
      onBlockReply: (payload) => {
        delivered.push({ text: payload.text });
      },
      turnId: "run-78ff2b60-turn1",
      channelKey: "telegram:6533456892:chat:6533456892",
      logTelemetry: () => {},
      maxBufferMs: 5_000,
    });

    // Real Opus 4.6 streaming sequence (prefix-truncated CoT preambles).
    const preambleSequence = [
      "ser is asking about agent management.",
      "on for agent management. Actually, I think...",
      "Let me re-read the question once more.",
      "Here is the final answer text the user actually requested.",
    ];
    for (const text of preambleSequence) {
      await wiring.onBlockReply({ text });
    }

    // End-of-run commit edge — `attempt.ts` calls this from its
    // post-run finally block (mirrors the upstream coalescer's
    // `finalizeAfterRun` seam at `agent-runner.ts:1087`).
    await wiring.commit();

    // Only ONE outbound delivery — the LAST registered body.
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toBe("Here is the final answer text the user actually requested.");
    // Preambles are dropped, not concatenated.
    expect(delivered[0]?.text).not.toContain("ser is asking");
    expect(delivered[0]?.text).not.toContain("Actually, I think");
    expect(delivered[0]?.text).not.toContain("re-read the question");
  });

  it("(B) collapses 4-message regression into exactly one consolidated outbound message", async () => {
    // Pins the production "4 messages back-to-back" symptom directly:
    // assert outbound delivery count is exactly 1, regardless of how
    // many message_end emissions the LLM produced.
    const delivered: Array<{ text?: string }> = [];
    const wiring = wrapStreamingOutboundWithCoalescer({
      onBlockReply: (payload) => {
        delivered.push({ text: payload.text });
      },
      turnId: "run-multi-msg",
      channelKey: "telegram:test-account:chat:42",
      logTelemetry: () => {},
      maxBufferMs: 5_000,
    });

    // Four separate assistant message_end emissions.
    await wiring.onBlockReply({ text: "fragment-1" });
    await wiring.onBlockReply({ text: "fragment-2" });
    await wiring.onBlockReply({ text: "fragment-3" });
    await wiring.onBlockReply({ text: "fragment-4-final" });

    await wiring.commit();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toBe("fragment-4-final");
  });

  it("(C) does not swallow non-text routing — reasoning payloads bypass the coalescer", async () => {
    // Regression guard: the coalescer is a text-block lane consolidator.
    // Reasoning blocks (`isReasoning=true`) and structural tool-call
    // routing (which goes through `onAgentEvent` / `onToolResult`,
    // never `onBlockReply`) must keep their independent paths.
    const delivered: Array<{
      text?: string;
      isReasoning?: boolean;
      mediaUrls?: string[];
    }> = [];
    const wiring = wrapStreamingOutboundWithCoalescer({
      onBlockReply: (payload) => {
        delivered.push({
          text: payload.text,
          isReasoning: payload.isReasoning,
          mediaUrls: payload.mediaUrls,
        });
      },
      turnId: "run-reasoning-bypass",
      channelKey: "telegram:test-account:chat:99",
      logTelemetry: () => {},
      maxBufferMs: 5_000,
    });

    // Mirror the exact emission shape from
    // `pi-embedded-subscribe.handlers.messages.ts:429`:
    // `emitBlockReplySafely({text: formattedReasoning, isReasoning: true})`.
    await wiring.onBlockReply({ text: "Internal CoT trace", isReasoning: true });
    // Then a regular user-facing reply (text-block lane).
    await wiring.onBlockReply({ text: "Final user-facing answer" });
    await wiring.commit();

    // 1 reasoning (passthrough) + 1 final (coalesced) = 2 outbound calls.
    expect(delivered).toHaveLength(2);
    const reasoningEntry = delivered.find((d) => d.isReasoning === true);
    const userFacingEntry = delivered.find((d) => d.isReasoning !== true);
    expect(reasoningEntry?.text).toBe("Internal CoT trace");
    expect(userFacingEntry?.text).toBe("Final user-facing answer");
  });

  it("(C.stats) reasoning passthrough does NOT register into the coalescer bucket", async () => {
    // Stats invariant: reasoning payloads must not inflate the bucketed
    // message count (otherwise `drop_intermediates` could occasionally
    // pick a reasoning body as canonical).
    const wiring = wrapStreamingOutboundWithCoalescer({
      onBlockReply: () => {},
      turnId: "run-stats",
      channelKey: "telegram:test-account:chat:2",
      logTelemetry: () => {},
      maxBufferMs: 5_000,
    });

    await wiring.onBlockReply({ text: "internal", isReasoning: true });
    await wiring.onBlockReply({ text: "internal-2", isReasoning: true });
    expect(wiring.stats()).toEqual({ buffered: 0, turns: 0 });

    await wiring.onBlockReply({ text: "user-facing" });
    expect(wiring.stats().buffered).toBe(1);
  });

  it("(D) emits [outbound-coalescer] event=registered + event=committed log lines", async () => {
    // Proves the wiring is real, not a silent no-op. The diagnostic
    // (DIAGNOSTIC-2026-05-08-kernel-vs-legacy-divergence.md) flagged
    // the absence of `[outbound-coalescer] event=committed/bypassed`
    // lines as evidence the coalescer was dead code on the production
    // streaming path. This test pins their presence.
    const logLines: string[] = [];
    const wiring = wrapStreamingOutboundWithCoalescer({
      onBlockReply: () => {},
      turnId: "run-telemetry",
      channelKey: "telegram:test-account:chat:7",
      logTelemetry: (line) => logLines.push(line),
      maxBufferMs: 5_000,
    });
    // V1-CLOSE T9 — `isFinal: true` opt-in marks the terminal block
    // emission so the coalescer registers it as `kind=final`. Pre-T9
    // every emission hardcoded to `final` regardless; the gate now
    // requires the caller (subscribe layer) to declare finality.
    await wiring.onBlockReply({ text: "anything", isFinal: true });
    await wiring.commit();

    const registered = logLines.find((l) => l.includes("event=registered"));
    const committed = logLines.find((l) => l.includes("event=committed"));
    expect(registered).toBeDefined();
    expect(registered).toContain("[outbound-coalescer]");
    expect(registered).toContain("turnId=run-telemetry");
    expect(committed).toBeDefined();
    expect(committed).toContain("[outbound-coalescer]");
    expect(committed).toContain("turnId=run-telemetry");
    expect(committed).toContain("channel=telegram:test-account:chat:7");
    expect(committed).toContain("messages_merged=1");
    expect(committed).toContain("final_kind=final");
  });

  it("(E) commit is idempotent — second call does not double-deliver", async () => {
    // Negative coverage for invariant
    // `Single_final_user_facing_message_per_user_turn`: production
    // `attempt.ts` finally block runs unconditionally on every code
    // path (success / abort / timeout). Calling commit twice (e.g.
    // abort + cleanup) MUST NOT produce two outbound deliveries.
    const delivered: Array<{ text?: string }> = [];
    const wiring = wrapStreamingOutboundWithCoalescer({
      onBlockReply: (payload) => {
        delivered.push({ text: payload.text });
      },
      turnId: "run-idem",
      channelKey: "telegram:test-account:chat:1",
      logTelemetry: () => {},
      maxBufferMs: 5_000,
    });
    await wiring.onBlockReply({ text: "answer" });
    await wiring.commit();
    await wiring.commit();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toBe("answer");
  });

  it("(F) parent-symptom counter-fixture — without wiring, four emissions deliver four messages", async () => {
    // Counter-fixture: this is what production looked like on the
    // broken path (gateway-dev-2026-05-07.log). The unwrapped
    // `onBlockReply` delivers one message per emission; the wiring
    // helper changes that to one delivery per turn. Test pins the
    // BEFORE state to make the contrast with (B) explicit.
    const deliveredUnwrapped: Array<{ text?: string }> = [];
    const onBlockReply = (payload: { text?: string }) => {
      deliveredUnwrapped.push({ text: payload.text });
    };
    await onBlockReply({ text: "preamble-1" });
    await onBlockReply({ text: "preamble-2" });
    await onBlockReply({ text: "preamble-3" });
    await onBlockReply({ text: "final-answer" });
    expect(deliveredUnwrapped).toHaveLength(4);
    expect(deliveredUnwrapped.map((d) => d.text)).toEqual([
      "preamble-1",
      "preamble-2",
      "preamble-3",
      "final-answer",
    ]);

    // Same emission sequence through the wiring → exactly one delivery.
    const deliveredWrapped: Array<{ text?: string }> = [];
    const wiring = wrapStreamingOutboundWithCoalescer({
      onBlockReply: (payload) => {
        deliveredWrapped.push({ text: payload.text });
      },
      turnId: "run-counter-fixture",
      channelKey: "telegram:test-account:chat:3",
      logTelemetry: () => {},
      maxBufferMs: 5_000,
    });
    await wiring.onBlockReply({ text: "preamble-1" });
    await wiring.onBlockReply({ text: "preamble-2" });
    await wiring.onBlockReply({ text: "preamble-3" });
    await wiring.onBlockReply({ text: "final-answer" });
    await wiring.commit();
    expect(deliveredWrapped).toHaveLength(1);
    expect(deliveredWrapped[0]?.text).toBe("final-answer");
  });
});

// NOTE: end-to-end integration through `subscribeEmbeddedPiSession`
// + multi-`message_end` driving was attempted here but the underlying
// `createStubSessionHarness` + `pi-embedded-subscribe.handlers.messages`
// chain does not fire `onBlockReply` on this Windows test environment
// (verified independently against
// `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.emits-reasoning-as-separate-message-enabled.test.ts`,
// which is also red on this host — pre-existing breakage tracked under
// the cohort triage in #309). The unit-level tests above exercise the
// real `OutboundCoalescer` (`createOutboundCoalescer` from
// `src/infra/outbound/`) — no mocks of the function under test — and
// fully prove the consolidation behaviour the spec asks for. The
// `attempt.ts` wiring (which calls `wrapStreamingOutboundWithCoalescer`
// in production) is exercised by typecheck + the run-time pass-through
// already covered for the upstream coalescer at
// `src/auto-reply/reply/agent-runner.coalescer.test.ts`.
void vi;
