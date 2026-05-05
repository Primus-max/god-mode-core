import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";

import { isExternalDeliverySurface } from "../../infra/outbound/outbound-sanitizer.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";

/**
 * Slice I — Anthropic Extended Thinking wrapper (B5 principled fix).
 *
 * Master plan reference:
 *   - `commitment_kernel_v1_release_roadmap.plan.md` line 200 (a):
 *     "(a) is the principled fix" — LLM-mediated reasoning isolation via the
 *     Anthropic API's structured `thinking` block instead of post-filtering
 *     English meta-text with regex.
 *   - Sub-plan `commitment_kernel_reply_sanitizer.plan.md` §6.4: extended
 *     thinking is the deterministic switch; the Phase 4 advisory prompt hint
 *     stays as a redundant nudge for cases where extended thinking isn't
 *     enabled (e.g. budget-token constraints, non-Anthropic providers).
 *
 * Behaviour:
 *   - Sets `payload.thinking = { type: "enabled", budget_tokens: N }` when
 *     BOTH conditions hold:
 *       (a) the model speaks the Anthropic Messages API (`api ===
 *           "anthropic-messages"`) — this is the API contract that accepts
 *           the `thinking` field, and covers vanilla Anthropic, Bedrock-
 *           Anthropic, and any Anthropic-API-compatible deployment;
 *       (b) `runtimeChannel` is supplied AND is in
 *           `EXTERNAL_DELIVERY_SURFACES` (telegram/whatsapp/signal/slack/
 *           discord/sms/voice/imessage/googlechat). These are plaintext
 *           messengers where reasoning would leak to the user.
 *   - No-op for internal channels (webchat) — UI keeps reasoning visible
 *     per master plan §3.
 *   - No-op for non-Anthropic models — they don't accept the `thinking`
 *     field and would reject the payload.
 *   - Does NOT overwrite a pre-existing `payload.thinking` value (defensive:
 *     respects upstream/test-supplied overrides).
 *
 * Default `budget_tokens` is 8000 — chosen as a middle ground between
 * Anthropic's documented minimum (1024) and large-context defaults (~32k):
 * sufficient room for multi-step planning on a typical messenger turn while
 * not consuming the full output budget on simple replies.
 *
 * Response-side handling: the existing `dropThinkingBlocks`
 * (`pi-embedded-runner/thinking.ts`) and `extractAssistantThinking`
 * (`pi-embedded-utils.ts:306`) already process `type: "thinking"` content
 * blocks the API returns, so this slice needs ZERO response-side changes.
 *
 * Hard invariants kept:
 *   - #5/#6: wrapper consumes a structured channel id, never raw user text.
 *   - #8: does not import from `src/platform/commitment/**`.
 *   - #11/#15: defense-in-depth — primary is API-level extended thinking +
 *     existing tag-strip; secondary is the Phase 4 prompt hint.
 */

/** Default extended-thinking budget for Anthropic plaintext-channel turns. */
export const DEFAULT_ANTHROPIC_THINKING_BUDGET_TOKENS = 8000;

export interface AnthropicThinkingWrapperOptions {
  /**
   * Channel the assistant reply will be delivered to. Wrapper enables
   * extended thinking only when this is a plaintext external surface
   * per `isExternalDeliverySurface`. Pass `undefined` to disable.
   */
  runtimeChannel?: string | null;
  /**
   * Override the default `budget_tokens` value. Caller must pass a
   * positive integer; negative/zero/non-finite values fall back to
   * `DEFAULT_ANTHROPIC_THINKING_BUDGET_TOKENS`.
   */
  budgetTokens?: number;
}

function resolveBudgetTokens(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_ANTHROPIC_THINKING_BUDGET_TOKENS;
  }
  return Math.floor(value);
}

function shouldEnableThinking(
  model: { api?: unknown },
  runtimeChannel: string | null | undefined,
): boolean {
  if (model.api !== "anthropic-messages") {
    return false;
  }
  if (typeof runtimeChannel !== "string" || runtimeChannel.length === 0) {
    return false;
  }
  return isExternalDeliverySurface(runtimeChannel);
}

export function createAnthropicThinkingWrapper(
  baseStreamFn: StreamFn | undefined,
  options: AnthropicThinkingWrapperOptions,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  const budgetTokens = resolveBudgetTokens(options.budgetTokens);
  const runtimeChannel = options.runtimeChannel ?? undefined;

  return (model, context, streamOptions) => {
    if (!shouldEnableThinking(model, runtimeChannel)) {
      return underlying(model, context, streamOptions);
    }

    return streamWithPayloadPatch(underlying, model, context, streamOptions, (payloadObj) => {
      // Defensive: respect any pre-existing `thinking` value on the payload
      // (e.g. caller-supplied extraParams.thinking override). Only inject
      // when the field is absent.
      if (payloadObj.thinking === undefined) {
        payloadObj.thinking = { type: "enabled", budget_tokens: budgetTokens };
      }
    });
  };
}
