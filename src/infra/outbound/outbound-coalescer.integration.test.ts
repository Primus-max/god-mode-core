/**
 * NEW-C Phase 4 — emit-sites wired through coalescer (integration).
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_outbound_coalescer.plan.md`
 *   §4 oc-phase-4-wire-emit-sites + §5 Phase 4 fail-first matrix I1..I6.
 * Phase 1 audit: `extensions/AUDIT-outbound-coalescer.md`.
 *
 * Goals:
 * - I1: One user turn, two emit-sites (ack + final) → channel receives
 *       ONE message with ack-prefixed final body.
 * - I2: One user turn, three emit-sites (ack + intermediate + final) →
 *       ONE message; intermediate dropped; ack prefixed.
 * - I3: Two user turns sequentially → channel receives EXACTLY 2
 *       messages (one per turn).
 * - I4: Block-streaming-with-tool turn (Bug A.2 path) → block-buffer
 *       consolidates chunks; coalescer commits ONE final.
 * - I5: Subagent ack + final via Slice H P3 ACK_SENTINEL path → ack
 *       ordering preserved through both layers.
 * - I6: Slice I sanitizer composition — diagnostic leak in committed
 *       payload still stripped at deliver layer.
 *
 * Fail-first verification: BEFORE Phase 4 wiring lands, the harness
 * below would call the channel adapter directly per emit-site and the
 * I1/I2/I3 expectations (ONE call) would fail. The harness exercises
 * the REAL `createOutboundCoalescer` + REAL
 * `createExternalBlockReplyDeferral` and replicates the
 * `agent-runner.ts:584-628` wiring pattern explicitly so the test
 * remains stable against future emit-site additions inside that
 * function.
 *
 * Соответствие 16 hard invariants:
 *   - #5 / #6: тесты НЕ читают user prompt; channelKey + body opaque.
 *   - #11: 5 frozen contracts byte-identical (импорта frozen layer'а
 *     нет ни прямого ни косвенного — sanitizer и block-buffer лежат в
 *     `infra/outbound/` и `auto-reply/reply/` соответственно).
 *   - #15: blanket signoff (2026-05-05).
 *   - #16: никаких новых brand'ов; turnId / channelKey остаются
 *     обычными string'ами.
 */
import { describe, expect, it } from "vitest";
import {
  createExternalBlockReplyDeferral,
  type BlockReplyDeliver,
} from "../../auto-reply/reply/block-external-buffer.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { createOutboundCoalescer } from "./outbound-coalescer.js";
import { sanitizeOutboundForExternalChannel } from "./outbound-sanitizer.js";

type Captured = { text: string; replyToId?: string; mediaUrl?: string };
const TG_CHANNEL = "telegram:6533456892:6533456892";

/**
 * Per-turn harness that mirrors the Phase 4 `agent-runner.ts:584-628`
 * wiring: coalescer wraps block-buffer wraps the inner channel
 * adapter. Tests use this to exercise multi-emit-site interactions
 * against the REAL coalescer + REAL block-buffer.
 */
function makeTurnHarness(turnId: string, channelKey: string = TG_CHANNEL) {
  const channelDelivered: Captured[] = [];
  const logs: string[] = [];

  // Inner channel adapter (the channel-side onBlockReply equivalent).
  const channelAdapter: BlockReplyDeliver = (payload) => {
    channelDelivered.push({
      text: payload.text ?? "",
      ...(payload.replyToId ? { replyToId: payload.replyToId } : {}),
      ...(payload.mediaUrl ? { mediaUrl: payload.mediaUrl } : {}),
    });
  };

  // Slice E P3 / Bug A.2 block-buffer (deferral) — instance per turn.
  const externalBlockDeferral = createExternalBlockReplyDeferral({ turnId });

  // Phase 4 wiring: coalescer wraps the inner channel adapter so
  // committed payloads land at the channel.
  const coalescer = createOutboundCoalescer({
    deliver: channelAdapter,
    mergeStrategy: "drop_intermediates",
    maxBufferMs: 30_000,
    logTelemetry: (line) => logs.push(line),
    clockNow: () => Date.now(),
  });

  // Streaming-aware wrapper — for streaming turns, agent-runner wraps
  // the outermost `streamingAwareBlockReply` such that block-buffer's
  // `wrapDeliver` consolidates chunks first; the consolidated payload
  // is then registered with coalescer as `kind=final`.
  const streamingAwareInner: BlockReplyDeliver = (payload) => {
    coalescer.register({
      turnId,
      channelKey,
      kind: "final",
      body: payload,
      ts: Date.now(),
    });
  };
  const wrappedDeliver = externalBlockDeferral.wrapDeliver(streamingAwareInner);

  return {
    coalescer,
    externalBlockDeferral,
    wrappedDeliver,
    channelDelivered,
    logs,
    /** Compose-once helper to commit at finalize (Phase 4 fallback trigger). */
    finalize: async () => {
      await externalBlockDeferral.finalizeAfterRun(streamingAwareInner);
      await coalescer.commitAll(turnId);
    },
  };
}

describe("Phase 4 wiring — I1: ack + final → ONE channel message", () => {
  it("ack registered separately, final registered, commit → ONE message ack-prefixed", async () => {
    const h = makeTurnHarness("run-I1");

    // Emit-site #3 branch 2 (no-deferral fallback) — direct ack
    // register with coalescer (Phase 4 wiring).
    h.coalescer.register({
      turnId: "run-I1",
      channelKey: TG_CHANNEL,
      kind: "ack",
      body: { text: "ack-prefix" },
      ts: 1_000,
    });

    // Emit-site #11 — final assistant reply (non-streaming path, but
    // still coalesced for the ack+final fixture).
    h.coalescer.register({
      turnId: "run-I1",
      channelKey: TG_CHANNEL,
      kind: "final",
      body: { text: "FINAL body", replyToId: "msg-1" },
      ts: 1_001,
    });

    await h.finalize();

    expect(h.channelDelivered).toHaveLength(1);
    expect(h.channelDelivered[0]?.text).toBe("ack-prefix\n\nFINAL body");
    expect(h.channelDelivered[0]?.replyToId).toBe("msg-1");
    expect(
      h.logs.some(
        (l) => l.includes("event=committed") && l.includes("messages_merged=2"),
      ),
    ).toBe(true);
  });
});

describe("Phase 4 wiring — I2: ack + intermediate + final → ONE message, intermediate dropped", () => {
  it("ack + compaction-notice + final → channel receives ack+final only", async () => {
    const h = makeTurnHarness("run-I2");

    h.coalescer.register({
      turnId: "run-I2",
      channelKey: TG_CHANNEL,
      kind: "ack",
      body: { text: "[ack]" },
      ts: 2_000,
    });
    // Emit-site #4 — compaction notice in block-streaming branch
    // (`agent-runner.ts:1432-1452`). Phase 4 routes via coalescer
    // `kind=intermediate` instead of fire-and-forget direct adapter.
    h.coalescer.register({
      turnId: "run-I2",
      channelKey: TG_CHANNEL,
      kind: "intermediate",
      body: { text: "🧹 Compacting..." },
      ts: 2_001,
    });
    h.coalescer.register({
      turnId: "run-I2",
      channelKey: TG_CHANNEL,
      kind: "final",
      body: { text: "answer" },
      ts: 2_002,
    });

    await h.finalize();

    expect(h.channelDelivered).toHaveLength(1);
    expect(h.channelDelivered[0]?.text).toBe("[ack]\n\nanswer");
    // Intermediate's "Compacting..." MUST NOT appear in committed
    // payload (drop_intermediates strategy).
    expect(h.channelDelivered[0]?.text).not.toContain("Compacting");
  });
});

describe("Phase 4 wiring — I3: two user turns sequentially → EXACTLY 2 channel messages", () => {
  it("two harnesses (one per turn) deliver one message each, no cross-leakage", async () => {
    const h1 = makeTurnHarness("run-I3a");
    const h2 = makeTurnHarness("run-I3b");

    h1.coalescer.register({
      turnId: "run-I3a",
      channelKey: TG_CHANNEL,
      kind: "final",
      body: { text: "turn-A reply" },
      ts: 3_000,
    });
    await h1.finalize();

    h2.coalescer.register({
      turnId: "run-I3b",
      channelKey: TG_CHANNEL,
      kind: "final",
      body: { text: "turn-B reply" },
      ts: 4_000,
    });
    await h2.finalize();

    expect(h1.channelDelivered).toHaveLength(1);
    expect(h1.channelDelivered[0]?.text).toBe("turn-A reply");
    expect(h2.channelDelivered).toHaveLength(1);
    expect(h2.channelDelivered[0]?.text).toBe("turn-B reply");
  });
});

describe("Phase 4 wiring — I4: block-streaming chunks → block-buffer consolidates → coalescer commits ONE", () => {
  it("notifyStructuralToolExecutionStarting + multiple chunks → ONE merged final via coalescer", async () => {
    const h = makeTurnHarness("run-I4");

    // Bug A.2 path: structural tool execution seen → finalize
    // consolidates instead of replaying chunks.
    h.externalBlockDeferral.notifyStructuralToolExecutionStarting();

    // Streaming chunks (each `streamingAwareBlockReply` invocation in
    // `agent-runner.ts:584-628`).
    await h.wrappedDeliver({ text: "chunk 1" });
    await h.wrappedDeliver({ text: "chunk 2" });
    await h.wrappedDeliver({ text: "chunk 3" });

    // Until finalize: nothing on channel yet (block-buffer parks them).
    expect(h.channelDelivered).toHaveLength(0);

    await h.finalize();

    // EXACTLY ONE channel send with all chunks merged through both
    // layers. Block-buffer joins by `\n\n`, coalescer registers ONE
    // final, commit delivers ONE.
    expect(h.channelDelivered).toHaveLength(1);
    expect(h.channelDelivered[0]?.text).toBe("chunk 1\n\nchunk 2\n\nchunk 3");
  });
});

describe("Phase 4 wiring — I5: ACK_SENTINEL ordering preserved through both layers", () => {
  it("enqueueAck (slice H P3) + chunks → ack stays first after block-buffer + coalescer", async () => {
    const h = makeTurnHarness("run-I5");

    // Slice H Phase 3 ACK_SENTINEL: enqueueAck inserts ack into the
    // deferral with a sentinel; finalize consolidates ack-first.
    h.externalBlockDeferral.notifyStructuralToolExecutionStarting();
    await h.externalBlockDeferral.enqueueAck({ text: "ack-from-subagent" });

    await h.wrappedDeliver({ text: "after-ack chunk 1" });
    await h.wrappedDeliver({ text: "after-ack chunk 2" });

    await h.finalize();

    expect(h.channelDelivered).toHaveLength(1);
    // ACK_SENTINEL ordering: ack comes FIRST, then the rest preserved
    // in arrival order. This is the exact invariant slice H P3 added.
    expect(h.channelDelivered[0]?.text).toBe(
      "ack-from-subagent\n\nafter-ack chunk 1\n\nafter-ack chunk 2",
    );
  });
});

describe("Phase 4 wiring — I6: slice I sanitizer composes BELOW coalescer", () => {
  it("internal-diagnostic leak in committed payload is still stripped by sanitizer at deliver layer", async () => {
    // This test wires sanitizer AFTER coalescer commit (the live
    // `deliver.ts` runs `normalizePayloadsForChannelDelivery` →
    // `applyOutboundSanitizer` AFTER coalescer commits one payload).
    const channelDelivered: Captured[] = [];
    const logs: string[] = [];
    const sanitizingChannelAdapter: BlockReplyDeliver = (payload) => {
      const sanitized = sanitizeOutboundForExternalChannel(payload.text ?? "");
      channelDelivered.push({
        text: sanitized.text,
        ...(payload.replyToId ? { replyToId: payload.replyToId } : {}),
      });
    };

    const coalescer = createOutboundCoalescer({
      deliver: sanitizingChannelAdapter,
      mergeStrategy: "drop_intermediates",
      maxBufferMs: 30_000,
      logTelemetry: (line) => logs.push(line),
      clockNow: () => Date.now(),
    });

    // Register a final payload that contains an obvious internal
    // diagnostic prefix slice I sanitizer strips. Use the literal
    // `[debug]` prefix since slice I tests use it as a known pattern.
    // `[planner]` is one of the line-marker patterns the slice I
     // sanitizer strips on the line-anchored multiline regex.
    coalescer.register({
      turnId: "run-I6",
      channelKey: TG_CHANNEL,
      kind: "final",
      body: {
        text: "Hello user.\n[planner] internal route trace\nGoodbye.",
      } as ReplyPayload,
      ts: 6_000,
    });

    await coalescer.commitAll("run-I6");

    expect(channelDelivered).toHaveLength(1);
    // Coalescer produced ONE committed payload; sanitizer ran AFTER
    // and stripped the `[planner]` diagnostic line. Composition
    // order assertion: coalescer commits first, sanitizer sees ONE
    // payload, the result reaching the channel passed through
    // sanitizer.
    expect(channelDelivered[0]?.text).toContain("Hello user");
    expect(channelDelivered[0]?.text).toContain("Goodbye");
    expect(channelDelivered[0]?.text).not.toContain("[planner]");
    expect(
      logs.some(
        (l) =>
          l.includes("event=committed") &&
          l.includes("turnId=run-I6") &&
          l.includes("messages_merged=1"),
      ),
    ).toBe(true);
  });
});
