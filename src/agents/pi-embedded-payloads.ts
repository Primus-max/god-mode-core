export type BlockReplyPayload = {
  text?: string;
  mediaUrls?: string[];
  audioAsVoice?: boolean;
  isReasoning?: boolean;
  replyToId?: string;
  replyToTag?: boolean;
  replyToCurrent?: boolean;
  /**
   * V1-CLOSE T9 — terminal-vs-intermediate gate for the streaming
   * `wrapStreamingOutboundWithCoalescer` wrapper. `true` ONLY for the
   * terminal block emission of a turn (matches LLM `message_end` /
   * post-run flush in `pi-embedded-subscribe.handlers.lifecycle.ts`).
   * Intermediate `text_end`-driven block-chunker breaks must set
   * `false` so the coalescer registers them as `kind=intermediate`
   * rather than collapsing every emission into `kind=final`.
   *
   * Production symptom this pins (charter §6 turn
   * `d6e5e41c-256d-4824-81be-8699f682df89`, 2026-05-08): a 15,675-char
   * essay generated zero `[outbound-coalescer] event=registered
   * kind=intermediate` events because every emission was hardcoded
   * `final` at `outbound-coalescer-wiring.ts:152`. Operator could not
   * verify Slice H Phase 6 streaming-ordering invariants.
   *
   * Absent / `undefined` is treated as `false` by the wrapper (see
   * `outbound-coalescer-wiring.ts`).
   */
  isFinal?: boolean;
};
