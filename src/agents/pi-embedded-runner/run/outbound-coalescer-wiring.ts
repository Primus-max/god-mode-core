import type { OutboundCoalescerLogEvent } from "../../../infra/outbound/outbound-coalescer-types.js";
/**
 * Wraps the streaming-pipeline `onBlockReply` (and only that callback)
 * with an OutboundCoalescer so per-message-end emissions during a
 * single agent run are aggregated into ONE consolidated outbound
 * delivery.
 *
 * Production symptom this pins (gateway-dev-2026-05-07.log, session
 * 78ff2b60 turn 1): Opus 4.6 emitted four separate assistant messages
 * within ONE logical answer; each `message_end` fired `onBlockReply`,
 * each became its own Telegram message, and two of them were
 * chain-of-thought preambles ("ser is asking about", "on for agent
 * management. Actually, I think...") that should never have left the
 * model. The legacy `agent-runner.ts` coalescer wrapping at line ~660
 * only engages when `externalBlockDeferral` is constructed, which
 * required several upstream conditions and was inert for that turn —
 * `[outbound-coalescer] event=committed` never appeared in the log.
 *
 * This module attaches a coalescer DIRECTLY to the streaming emit
 * pipeline (driven from `attempt.ts`) so the wrapping is always
 * available for the streaming-text lane. Structural tool-call routing
 * (`onStructuralToolExecutionStarting`, `onAgentEvent` tool stream,
 * `onToolResult`) is intentionally NOT touched — the coalescer
 * operates on the text-block emit lane only, mirroring the audit §a
 * mapping (only `final` / `intermediate` text-bearing payloads enter
 * the bucket store).
 *
 * Backwards compat: when the upstream `agent-runner.ts` coalescer is
 * already attached, `params.onBlockReply` passed into attempt.ts is
 * the upstream coalescer-register shim. Wrapping it again here means
 * the merged streaming-final body register-flushes through the
 * upstream shim → upstream coalescer fires once with `kind=final` →
 * exactly one outbound delivery. No double-emit. The two-level
 * composition is the same precedent already established at
 * `agent-runner.ts:658-682` (block-buffer → coalescer → channel).
 */
import type { OutboundCoalescer } from "../../../infra/outbound/outbound-coalescer.js";
import { createOutboundCoalescer } from "../../../infra/outbound/outbound-coalescer.js";
import type { BlockReplyPayload } from "../../pi-embedded-payloads.js";

/**
 * Function shape matching `RunEmbeddedPiAgentParams.onBlockReply`.
 * Re-declared locally to avoid a cycle through `params.ts`.
 */
export type StreamingBlockReplyCallback = (payload: BlockReplyPayload) => void | Promise<void>;

/**
 * Inputs for `wrapStreamingOutboundWithCoalescer`. All explicit DI —
 * no module-level singletons. One instance per attempt invocation.
 */
export type WrapStreamingOutboundInputs = {
  /**
   * The original outbound delivery callback from caller (chain that
   * eventually reaches the channel adapter). When the upstream
   * `agent-runner.ts` coalescer is engaged, this is its register shim;
   * either way, the wrapper treats it as opaque `deliver`.
   */
  readonly onBlockReply: StreamingBlockReplyCallback;
  /** Same `runId` carried in `[assistant-reply]` log lines. */
  readonly turnId: string;
  /**
   * Structural channel key, format `${channel}:${accountId}:${target}`
   * (mirrors `agent-runner.ts:633`). Coalescer key — never inspected
   * for content (#5).
   */
  readonly channelKey: string;
  /** Telemetry sink. One line per coalescer event. */
  readonly logTelemetry: (line: string) => void;
  /** Injectable clock for stable test ordering. Defaults to `Date.now`. */
  readonly clockNow?: () => number;
  /**
   * Per-bucket watchdog ms. Defaults to 60_000 to match
   * `agent-runner.ts:640`. Tests can shorten.
   */
  readonly maxBufferMs?: number;
};

/**
 * Returned wiring. Caller passes `onBlockReply` to
 * `subscribeEmbeddedPiSession` and calls `commit` from the post-run
 * `finally` block (after `unsubscribe()`).
 */
export type WrapStreamingOutboundResult = {
  /**
   * Wrapped callback; every invocation registers the payload in the
   * coalescer instead of delivering immediately.
   */
  readonly onBlockReply: StreamingBlockReplyCallback;
  /**
   * Flush the coalescer; produces ONE merged outbound delivery (the
   * last-registered body wins under `drop_intermediates`). Idempotent —
   * second call on the same turn becomes a silent noop, matching
   * `OutboundCoalescer.commitAll` semantics.
   */
  readonly commit: () => Promise<void>;
  /** Test/diag hook — current bucket depth for the wrapped channel. */
  readonly stats: () => { buffered: number; turns: number };
};

/**
 * Build the wrapped streaming pipeline. Returns a `onBlockReply`
 * shim and a `commit` function. The merge strategy is hard-pinned to
 * `drop_intermediates` — the same strategy the upstream
 * `agent-runner.ts` coalescer uses (line 639). Under this strategy
 * the LAST registered `final` (or last `intermediate` if no final)
 * is the canonical merged body; earlier `intermediate` bodies are
 * dropped. This is exactly the "CoT preamble suppression" property
 * the production turn lacked.
 *
 * Non-text payloads (reasoning blocks, audio-as-voice, payloads with
 * no `text` field at all) are passed through verbatim WITHOUT entering
 * the bucket — the coalescer is a text-lane consolidator, not a
 * universal proxy. This preserves channel-specific routing for
 * payloads that do not carry assistant-text content.
 */
export function wrapStreamingOutboundWithCoalescer(
  inputs: WrapStreamingOutboundInputs,
): WrapStreamingOutboundResult {
  const clockNow = inputs.clockNow ?? (() => Date.now());
  const maxBufferMs = inputs.maxBufferMs ?? 90_000;
  const coalescer: OutboundCoalescer = createOutboundCoalescer({
    deliver: async (payload) => {
      // Forward the consolidated payload through the original
      // streaming `onBlockReply`. The original may itself be a
      // coalescer-register shim (upstream `agent-runner.ts` wrapping)
      // — that two-level composition is intentional.
      await inputs.onBlockReply(payload as BlockReplyPayload);
    },
    mergeStrategy: "drop_intermediates",
    maxBufferMs,
    logTelemetry: inputs.logTelemetry,
    clockNow,
  });

  const wrapped: StreamingBlockReplyCallback = async (payload) => {
    // Reasoning payloads (`isReasoning=true`) are deliberately routed
    // around the coalescer — channels that have a dedicated reasoning
    // lane (e.g. internal canvas) must continue to see them
    // independently, and channels that suppress reasoning will keep
    // doing so. This matches the structural-routing carve-out in the
    // sub-plan §6 audit (reasoning is not part of the
    // `Single_final_user_facing_message_per_user_turn` invariant).
    if (payload && payload.isReasoning === true) {
      await inputs.onBlockReply(payload);
      return;
    }
    // V1-CLOSE T9 — terminal-vs-intermediate gate. The streaming
    // `onBlockReply` lane fires once per block-chunker break during a
    // long turn AND once at terminal `message_end` / post-run flush.
    // Pre-T9, every register() call hardcoded `kind: "final"`, so the
    // coalescer dedup'd in-flight intermediates and the user only ever
    // saw a single non-streamed message — see charter §6 turn
    // `d6e5e41c-256d-4824-81be-8699f682df89` (15,675-char essay, zero
    // `kind=intermediate` events). The caller (subscribe layer) now
    // populates `payload.isFinal` based on the LLM event boundary;
    // anything not explicitly final maps to `intermediate`. The
    // `drop_intermediates` merge strategy (line 131) still keeps the
    // last `final` body as canonical, so user-visible behaviour after
    // commit is unchanged for short turns — long turns gain visible
    // partial-emission telemetry on the hot path.
    const isFinal = payload?.isFinal === true;
    coalescer.register({
      turnId: inputs.turnId,
      channelKey: inputs.channelKey,
      kind: isFinal ? "final" : "intermediate",
      body: payload,
      ts: clockNow(),
    });
  };

  return {
    onBlockReply: wrapped,
    commit: async () => {
      await coalescer.commitAll(inputs.turnId);
    },
    stats: () => coalescer.stats(),
  };
}

/**
 * Re-exported for convenience so callers/tests do not need to dig
 * into `outbound-coalescer-types.js` to reference event names.
 */
export type StreamingCoalescerEvent = OutboundCoalescerLogEvent;
