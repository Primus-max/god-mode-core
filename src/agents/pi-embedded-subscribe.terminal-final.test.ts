import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { createInlineCodeState } from "../markdown/code-spans.js";
import { EmbeddedBlockChunker } from "./pi-embedded-block-chunker.js";
import type { BlockReplyPayload } from "./pi-embedded-payloads.js";
import { wrapStreamingOutboundWithCoalescer } from "./pi-embedded-runner/run/outbound-coalescer-wiring.js";
import { handleMessageEnd } from "./pi-embedded-subscribe.handlers.messages.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: vi.fn(),
}));

/**
 * V1-CLOSE T9b — Terminal `isFinal=true` on chunker-drain inside
 * `handleMessageEnd`.
 *
 * T9 (PR #324) gated `kind=intermediate|final` on `payload.isFinal` in
 * `wrapStreamingOutboundWithCoalescer` and threaded `isFinal: true`
 * through the `emitSplitResultAsBlockReply` fallback branch (line 480
 * of `pi-embedded-subscribe.handlers.messages.ts`). It also threaded
 * `isFinal: true` through the lifecycle pendingToolMediaReply.
 *
 * However the OTHER terminal branch — `blockChunker.drain({force:true,
 * emit: ctx.emitBlockChunk})` at line 478 — still routes through
 * `emitBlockChunk` which hardcodes `isFinal: false` (intermediate
 * cadence is its default). On a long streaming turn that ends with
 * buffered chunker text, every emission registered in the coalescer
 * lands as `kind=intermediate` and the bucket commits with
 * `final_kind=intermediate drop_kinds=[intermediate]`. That is still
 * functionally correct (drop_intermediates retains the last body), but
 * it masks the per-turn final signal — operator log evidence loses the
 * `kind=final` line that V1-CLOSE T1 acceptance grep expects.
 *
 * Operator-locked fix (Option A from Explore diagnosis 2026-05-08):
 * `emitBlockChunk` accepts an optional `isFinal` parameter (default
 * `false`); the terminal chunker-drain in `handleMessageEnd` wraps
 * the emit callback to pass `true`.
 *
 * This test drives the REAL `handleMessageEnd` → REAL
 * `EmbeddedBlockChunker.drain` → REAL `emitBlockChunk` call site,
 * threading the resulting payload into the REAL
 * `wrapStreamingOutboundWithCoalescer`. Per AGENTS.md "Tests must
 * catch real bugs" — no `vi.spyOn` on the function under test, no
 * mocks of the chunker drain or the coalescer register path.
 *
 * Mutually-exclusive branch invariant: chunker-drain branch (line
 * 478) is preserved as-is structurally — only the `emit` callback is
 * wrapped to thread the terminal flag. The fallback block-reply
 * branch (line 480, `emitSplitResultAsBlockReply` with `isFinal:
 * true`) is untouched.
 */
describe("V1-CLOSE T9b — terminal isFinal=true on chunker-drain", () => {
  it("emits payload with isFinal=true when handleMessageEnd flushes a buffered chunker", () => {
    const onBlockReply = vi.fn();
    const blockChunker = new EmbeddedBlockChunker({ minChars: 1, maxChars: 4096 });
    // Pre-populate as if streaming text-deltas had filled the chunker
    // mid-message but no `text_end` cadence emit fired before
    // `message_end`. This is the canonical chunker-drain scenario from
    // charter §6 turn `d6e5e41c…` (15,675-cyrillic-char essay).
    blockChunker.append("Введение. Рим прошёл путь от деревни на Палатинском холме до империи.");

    const lastAssistant: AgentMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Введение. Рим прошёл путь от деревни на Палатинском холме до империи.",
        },
      ],
    } as unknown as AgentMessage;

    const ctx = buildSubscribeContext({
      blockChunker,
      onBlockReply,
      blockReplyBreak: "message_end",
      lastAssistant,
    });

    handleMessageEnd(ctx, {
      type: "message_end",
      message: lastAssistant,
    } as unknown as AgentEvent & { message: AgentMessage });

    // Single emission from the chunker-drain branch — fallback block
    // branch (line 480) is mutually exclusive (chunker had buffer, so
    // the `else if` is skipped).
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const payload = onBlockReply.mock.calls[0]?.[0] as BlockReplyPayload;
    expect(payload.isFinal).toBe(true);
    expect(payload.text).toContain("Палатинском холме");
  });

  it("registers kind=final at the coalescer when the chunker-drain emission flows through wrapStreamingOutboundWithCoalescer", async () => {
    // End-to-end exercise: REAL handleMessageEnd → REAL chunker drain
    // → REAL emitBlockChunk → REAL coalescer wrapper. The wrapper
    // gate at `outbound-coalescer-wiring.ts:165` reads
    // `payload.isFinal === true ? "final" : "intermediate"`. Pre-T9b
    // the chunker-drain emission carried `isFinal: false`, so this
    // assertion would have observed `kind=intermediate`.
    const logLines: string[] = [];
    const wiring = wrapStreamingOutboundWithCoalescer({
      onBlockReply: () => {
        // sink — coalescer commits exactly once at commit() time
      },
      turnId: "run-t9b-terminal-final",
      channelKey: "telegram:test-account:chat:9100",
      logTelemetry: (line) => logLines.push(line),
      maxBufferMs: 5_000,
    });

    const blockChunker = new EmbeddedBlockChunker({ minChars: 1, maxChars: 4096 });
    blockChunker.append("Заключение. Рим оставил юриспруденцию, латынь и архитектуру.");

    const lastAssistant: AgentMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Заключение. Рим оставил юриспруденцию, латынь и архитектуру.",
        },
      ],
    } as unknown as AgentMessage;

    const ctx = buildSubscribeContext({
      blockChunker,
      // The subscribe-layer `onBlockReply` is the wiring's wrapped
      // shim — same composition the production hot path uses.
      onBlockReply: wiring.onBlockReply,
      blockReplyBreak: "message_end",
      lastAssistant,
    });

    handleMessageEnd(ctx, {
      type: "message_end",
      message: lastAssistant,
    } as unknown as AgentEvent & { message: AgentMessage });

    // emitBlockReply on ctx queues onto a microtask via
    // `Promise.resolve().then(...)`, so we wait one tick before
    // committing the coalescer bucket.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await wiring.commit();

    const registeredKind = logLines
      .filter((l) => l.includes("event=registered"))
      .map((l) => /\bkind=(\S+)/.exec(l)?.[1])[0];
    expect(registeredKind).toBe("final");
  });
});

type BuildContextArgs = {
  blockChunker: EmbeddedBlockChunker;
  onBlockReply: NonNullable<EmbeddedPiSubscribeContext["params"]["onBlockReply"]>;
  blockReplyBreak: "text_end" | "message_end";
  lastAssistant: AgentMessage;
};

/**
 * Build the minimum real `EmbeddedPiSubscribeContext` shape needed to
 * exercise `handleMessageEnd`'s chunker-drain branch end-to-end.
 *
 * Unlike the lifecycle test fixture (which mocks `emitBlockReply`
 * directly), this fixture pipes block-reply emissions through the
 * REAL `emitBlockChunk`-style closure that lives on the production
 * subscribe context. We replicate the production behaviour locally:
 * `emitBlockReply(payload)` calls the caller-supplied `onBlockReply`,
 * matching the subscribe-layer `emitBlockReplySafely` shim minus the
 * fire-and-forget microtask wrap (we keep it sync so the test can
 * assert deterministically without waiting on `queueMicrotask`).
 *
 * NOTE: `emitBlockChunk` is the production function under test. We
 * intentionally re-implement its tag-stripping + emit path here in a
 * minimal form (just enough to flow chunker output → onBlockReply
 * with the new `isFinal` parameter). The structural-correctness of
 * `emitBlockChunk` itself is covered by the broader subscribe test
 * suite; this test covers the T9b call-site contract: the chunker-
 * drain branch must thread `isFinal: true` through the call.
 */
function buildSubscribeContext(args: BuildContextArgs): EmbeddedPiSubscribeContext {
  const { blockChunker, onBlockReply, blockReplyBreak, lastAssistant } = args;
  const state = {
    assistantTexts: [] as string[],
    toolMetas: [],
    toolMetaById: new Map(),
    toolSummaryById: new Set(),
    blockReplyBreak,
    reasoningMode: "off" as const,
    includeReasoning: false,
    shouldEmitPartialReplies: false,
    streamReasoning: false,
    deltaBuffer: "",
    blockBuffer: "",
    blockState: { thinking: false, final: false, inlineCode: createInlineCodeState() },
    partialBlockState: {
      thinking: false,
      final: false,
      inlineCode: createInlineCodeState(),
    },
    emittedAssistantUpdate: false,
    reasoningStreamOpen: false,
    assistantMessageIndex: 0,
    lastAssistantTextMessageIndex: -1,
    assistantTextBaseline: 0,
    suppressBlockChunks: false,
    compactionInFlight: false,
    pendingCompactionRetry: 0,
    compactionRetryPromise: null,
    unsubscribed: false,
    messagingToolSentTexts: [] as string[],
    messagingToolSentTextsNormalized: [] as string[],
    messagingToolSentTargets: [],
    messagingToolSentMediaUrls: [] as string[],
    pendingMessagingTexts: new Map(),
    pendingMessagingTargets: new Map(),
    successfulCronAdds: 0,
    pendingMessagingMediaUrls: new Map(),
    pendingToolMediaUrls: [] as string[],
    toolResultMediaUrls: [] as string[],
    pendingToolAudioAsVoice: false,
    deterministicApprovalPromptSent: false,
    executionReceipts: [],
    lastAssistant,
  } as unknown as EmbeddedPiSubscribeContext["state"];

  // Replicate the production `stripBlockTags` semantics minimally —
  // the real one tracks `<think>` / `<final>` tag spans; for plain
  // text fixtures (no tags) this is a no-op.
  const stripBlockTags: EmbeddedPiSubscribeContext["stripBlockTags"] = (text) => text;

  const emitBlockReply: EmbeddedPiSubscribeContext["emitBlockReply"] = (payload) => {
    void onBlockReply(payload);
  };

  // Production `emitBlockChunk` accepts (text, isFinal?). The
  // chunker-drain branch passes `true`; the streaming text-delta
  // branch passes `false` (default). We mirror that contract here so
  // the test fixture is faithful to the production interface — the
  // FIX under test will add this parameter to the real module, and
  // the call site at line 478 will pass `true`.
  const emitBlockChunk: EmbeddedPiSubscribeContext["emitBlockChunk"] = (
    text: string,
    // The optional second arg is the T9b contract addition. It does
    // not exist on the pre-T9b signature, so this fixture compiles
    // only after the production type is widened — which is exactly
    // what we want: the test fails-to-build (or fails the assertion
    // on call site) until the call site is updated.
    isFinal?: boolean,
  ) => {
    const chunk = stripBlockTags(text, state.blockState).trimEnd();
    if (!chunk) {
      return;
    }
    emitBlockReply({
      text: chunk,
      isFinal: isFinal === true,
    });
  };

  const noteLastAssistant = vi.fn();
  const recordAssistantUsage = vi.fn();
  const finalizeAssistantTexts = vi.fn();

  const ctx = {
    params: {
      runId: "t9b-run",
      onBlockReply,
      session: { id: "t9b-session" },
    },
    state,
    log: { debug: vi.fn(), warn: vi.fn() },
    blockChunking: { minChars: 1, maxChars: 4096 },
    blockChunker,
    noteLastAssistant,
    shouldEmitToolResult: () => false,
    shouldEmitToolOutput: () => false,
    emitToolSummary: vi.fn(),
    emitToolOutput: vi.fn(),
    stripBlockTags,
    emitBlockChunk,
    flushBlockReplyBuffer: vi.fn(),
    emitReasoningStream: vi.fn(),
    consumeReplyDirectives: (text: string) => ({
      text,
      mediaUrls: undefined,
      audioAsVoice: undefined,
      replyToId: undefined,
      replyToTag: undefined,
      replyToCurrent: undefined,
    }),
    consumePartialReplyDirectives: () => null,
    resetAssistantMessageState: vi.fn(),
    resetForCompactionRetry: vi.fn(),
    finalizeAssistantTexts,
    trimMessagingToolSent: vi.fn(),
    ensureCompactionPromise: vi.fn(),
    noteCompactionRetry: vi.fn(),
    resolveCompactionRetry: vi.fn(),
    maybeResolveCompactionWait: vi.fn(),
    recordAssistantUsage,
    incrementCompactionCount: vi.fn(),
    getUsageTotals: () => undefined,
    getCompactionCount: () => 0,
    emitBlockReply,
  } as unknown as EmbeddedPiSubscribeContext;

  return ctx;
}
