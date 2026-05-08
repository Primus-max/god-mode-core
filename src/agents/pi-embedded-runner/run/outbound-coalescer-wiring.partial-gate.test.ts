import { describe, expect, it } from "vitest";
import type { BlockReplyPayload } from "../../pi-embedded-payloads.js";
import { wrapStreamingOutboundWithCoalescer } from "./outbound-coalescer-wiring.js";

/**
 * V1-CLOSE T9 — Streaming partial-emission gate.
 *
 * Pins the production symptom captured in §6 of the V1-CLOSE charter:
 * turn `d6e5e41c-256d-4824-81be-8699f682df89` (2026-05-08 18:13)
 * produced a 15,675-cyrillic-char essay over 116s of streaming yet the
 * coalescer registered ZERO `kind=intermediate` events — only one
 * `kind=final` commit. Operator could not verify Slice H Phase 6
 * because streaming-dark hides the partial-emission lane.
 *
 * Root cause: `outbound-coalescer-wiring.ts:152` hardcoded
 * `kind: "final"` on every `coalescer.register` call. PR #310 added
 * the wrapper with hardcoded `final` (dead code at the time); PR #312
 * threaded `outboundCoalescerStreamingTurnId` +
 * `outboundCoalescerStreamingChannelKey` parameters → wrapper became
 * active → every block emission registers as final → coalescer
 * dedupes → single message comes out non-streamed.
 *
 * Fix gate (this test): the wrapper must propagate `payload.isFinal`
 * onto the registration kind. `isFinal=true` → `kind=final`;
 * `isFinal=false` (or absent) → `kind=intermediate`. The closed
 * `OutboundMessageKind` union already pairs `intermediate` with
 * `final` (see `outbound-coalescer-types.ts` ~line 52) — no widening
 * required. Live-verify acceptance reads "≥1 `kind=partial`" — that
 * is the operator's colloquial label; the typed contract uses
 * `intermediate`, which surfaces in `[outbound-coalescer]
 * event=registered kind=intermediate` log lines on the hot path.
 *
 * Test exercises the REAL coalescer (`createOutboundCoalescer` via
 * `wrapStreamingOutboundWithCoalescer`) — no `vi.spyOn` on the
 * function under test, no mocks of `coalescer.register`. Per-kind
 * registration is observed via the structured `[outbound-coalescer]
 * event=registered kind=<...>` telemetry that the real coalescer
 * already emits on every `register(msg)` call (impl in
 * `outbound-coalescer.ts:441-446`).
 */
describe("wrapStreamingOutboundWithCoalescer — partial-emission gate (T9)", () => {
  it("registers 3 intermediate kinds + 1 final when payload.isFinal=false×3, true×1", async () => {
    // Capture the structured `event=registered` telemetry lines so we
    // can assert the kind in arrival order — this is the same
    // observable surface the operator inspects in the gateway log on
    // the hot path.
    const logLines: string[] = [];
    const wiring = wrapStreamingOutboundWithCoalescer({
      onBlockReply: () => {
        // Sink — coalescer.deliver invokes this exactly once at
        // commit time (drop_intermediates: last final wins).
      },
      turnId: "run-t9-partial-gate",
      channelKey: "telegram:test-account:chat:9001",
      logTelemetry: (line) => logLines.push(line),
      maxBufferMs: 5_000,
    });

    // Mirror the LLM streaming sequence on a long-essay turn:
    // multiple block-chunker breaks (intermediate / `kind=partial` in
    // operator logs), one terminal `message_end` flush (final).
    const intermediate1: BlockReplyPayload = {
      text: "Введение. Рим, основанный, по легенде, Ромулом и Ремом",
      isFinal: false,
    };
    const intermediate2: BlockReplyPayload = {
      text: " прошёл путь от деревни на Палатинском холме до",
      isFinal: false,
    };
    const intermediate3: BlockReplyPayload = {
      text: " империи, объединившей Средиземноморье. Трансформация",
      isFinal: false,
    };
    const terminal: BlockReplyPayload = {
      text: "[the consolidated 15,675-char body the operator actually expects]",
      isFinal: true,
    };

    await wiring.onBlockReply(intermediate1);
    await wiring.onBlockReply(intermediate2);
    await wiring.onBlockReply(intermediate3);
    await wiring.onBlockReply(terminal);
    await wiring.commit();

    // Extract the kind= field from each `event=registered` line in
    // arrival order. This is the exact substring shape that the
    // operator's grep on the hot-path gateway log will see.
    const registeredKinds = logLines
      .filter((l) => l.includes("event=registered"))
      .map((l) => {
        const match = /\bkind=(\S+)/.exec(l);
        return match ? match[1] : undefined;
      });

    // Acceptance per V1-CLOSE charter §4 T9:
    // "coalescer registers `kind=partial` ×3 then `kind=final` ×1".
    // The closed kind union maps `partial` → `intermediate`.
    expect(registeredKinds).toEqual(["intermediate", "intermediate", "intermediate", "final"]);
  });

  it("treats payload without isFinal as intermediate (defensive default)", async () => {
    // Defensive coverage: a caller that forgets to set `isFinal`
    // must NOT collapse into the `final` kind (which is the broken
    // pre-T9 behaviour). The gate is `isFinal === true ? final :
    // intermediate`, so any falsy value (undefined, false, null)
    // routes to intermediate.
    const logLines: string[] = [];
    const wiring = wrapStreamingOutboundWithCoalescer({
      onBlockReply: () => {},
      turnId: "run-t9-default",
      channelKey: "telegram:test-account:chat:9002",
      logTelemetry: (line) => logLines.push(line),
      maxBufferMs: 5_000,
    });

    await wiring.onBlockReply({ text: "no-isfinal-flag" } as BlockReplyPayload);
    await wiring.commit();

    const registeredKind = logLines
      .filter((l) => l.includes("event=registered"))
      .map((l) => /\bkind=(\S+)/.exec(l)?.[1])[0];

    expect(registeredKind).toBe("intermediate");
  });

  it("reasoning bypass branch is unchanged — isFinal value does not matter for isReasoning=true", async () => {
    // The diagnosis explicitly preserved the
    // `payload.isReasoning === true` early-return: reasoning
    // payloads bypass the coalescer entirely so dedicated reasoning
    // lanes (internal canvas, etc.) keep their independent path.
    // T9 must not regress that branch — reasoning payloads emit
    // ZERO `event=registered` lines, regardless of `isFinal`.
    const logLines: string[] = [];
    const delivered: Array<{ text?: string; isReasoning?: boolean }> = [];
    const wiring = wrapStreamingOutboundWithCoalescer({
      onBlockReply: (payload) => {
        delivered.push({ text: payload.text, isReasoning: payload.isReasoning });
      },
      turnId: "run-t9-reasoning",
      channelKey: "telegram:test-account:chat:9003",
      logTelemetry: (line) => logLines.push(line),
      maxBufferMs: 5_000,
    });

    await wiring.onBlockReply({
      text: "Internal CoT trace",
      isReasoning: true,
      isFinal: false,
    });
    await wiring.onBlockReply({
      text: "Another reasoning chunk",
      isReasoning: true,
      isFinal: true,
    });
    // Plus one normal text-lane emit so the bucket has something to
    // commit through deliver — proves the reasoning branch did not
    // accidentally fall through into the bucket.
    await wiring.onBlockReply({ text: "user-facing", isFinal: true });
    await wiring.commit();

    // Reasoning emissions deliver verbatim (no coalescing) and emit
    // no `event=registered` line.
    const registeredCount = logLines.filter((l) => l.includes("event=registered")).length;
    expect(registeredCount).toBe(1); // only the user-facing emit registered
    expect(delivered.filter((d) => d.isReasoning === true)).toHaveLength(2);
    expect(delivered.find((d) => d.isReasoning !== true)?.text).toBe("user-facing");
  });
});
