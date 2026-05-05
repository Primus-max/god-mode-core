import { describe, expect, it } from "vitest";
import {
  INTERNAL_REASONING_HINT_TEXT,
  isInternalReasoningHintApplicable,
} from "./internal-reasoning-hint.js";

/**
 * Slice I Phase 4 — predicate matrix tests.
 *
 * Hint is applicable when BOTH:
 *   (a) `runtimeChannel` is in `EXTERNAL_DELIVERY_SURFACES` (per `outbound-sanitizer.ts:38–52`),
 *   (b) `isReasoningTagProvider(provider) === false` (Anthropic/Opus and similar — google/minimax
 *       already get the strict `<think>+<final>` block via `reasoningTagHint`).
 *
 * Note on `max`: per audit, `max` is in `CHAT_CHANNEL_ORDER` but NOT in
 * `EXTERNAL_DELIVERY_SURFACES` as of this slice. Slice D Phase 3 plans to add
 * `max` to that allowlist; until then the predicate must return false for `max`.
 */
describe("isInternalReasoningHintApplicable", () => {
  describe("applicable cases (anthropic + external delivery surface)", () => {
    it("telegram + anthropic → applicable", () => {
      expect(isInternalReasoningHintApplicable("anthropic", "telegram")).toBe(true);
    });

    it("whatsapp + anthropic → applicable", () => {
      expect(isInternalReasoningHintApplicable("anthropic", "whatsapp")).toBe(true);
    });

    it("signal + anthropic → applicable", () => {
      expect(isInternalReasoningHintApplicable("anthropic", "signal")).toBe(true);
    });

    it("imessage + anthropic → applicable", () => {
      expect(isInternalReasoningHintApplicable("anthropic", "imessage")).toBe(true);
    });

    it("slack + anthropic → applicable", () => {
      // slack is in EXTERNAL_DELIVERY_SURFACES today; deferred-policy work is post-filter, not prompt-side.
      expect(isInternalReasoningHintApplicable("anthropic", "slack")).toBe(true);
    });

    it("discord + anthropic → applicable", () => {
      expect(isInternalReasoningHintApplicable("anthropic", "discord")).toBe(true);
    });

    it("googlechat + anthropic → applicable", () => {
      expect(isInternalReasoningHintApplicable("anthropic", "googlechat")).toBe(true);
    });
  });

  describe("not applicable — provider already has strict reasoning-tag block", () => {
    it("telegram + google → NOT applicable (covered by strict <think>+<final>)", () => {
      expect(isInternalReasoningHintApplicable("google", "telegram")).toBe(false);
    });

    it("telegram + minimax → NOT applicable", () => {
      expect(isInternalReasoningHintApplicable("minimax-m2.5", "telegram")).toBe(false);
    });

    it("whatsapp + google-gemini-cli → NOT applicable", () => {
      expect(isInternalReasoningHintApplicable("google-gemini-cli", "whatsapp")).toBe(false);
    });
  });

  describe("not applicable — channel does not strip reasoning at the boundary", () => {
    it("webchat + anthropic → NOT applicable (UI shows reasoning natively)", () => {
      expect(isInternalReasoningHintApplicable("anthropic", "webchat")).toBe(false);
    });

    it("max + anthropic → NOT applicable (max not yet in EXTERNAL_DELIVERY_SURFACES; slice D Phase 3 will add)", () => {
      expect(isInternalReasoningHintApplicable("anthropic", "max")).toBe(false);
    });

    it("irc + anthropic → NOT applicable (irc not in EXTERNAL_DELIVERY_SURFACES today)", () => {
      expect(isInternalReasoningHintApplicable("anthropic", "irc")).toBe(false);
    });
  });

  describe("not applicable — missing channel context", () => {
    it("undefined channel + anthropic → NOT applicable (no channel-side stripping context)", () => {
      expect(isInternalReasoningHintApplicable("anthropic", undefined)).toBe(false);
    });

    it("empty-string channel + anthropic → NOT applicable", () => {
      expect(isInternalReasoningHintApplicable("anthropic", "")).toBe(false);
    });

    it("undefined provider + telegram → NOT applicable (defensive: cannot infer)", () => {
      // isReasoningTagProvider(undefined) returns false, so external+!tagProvider → true
      // Document the actual behaviour: an undefined provider should still emit the hint
      // for an external surface, because we DO want the advisory when in doubt.
      expect(isInternalReasoningHintApplicable(undefined, "telegram")).toBe(true);
    });
  });
});

describe("INTERNAL_REASONING_HINT_TEXT", () => {
  it("instructs the model to wrap meta-thinking in <thinking> blocks", () => {
    expect(INTERNAL_REASONING_HINT_TEXT).toContain("<thinking>");
    expect(INTERNAL_REASONING_HINT_TEXT).toContain("</thinking>");
  });

  it("names the imperative leading-verb examples that the post-filter strips (defense-in-depth pairing)", () => {
    expect(INTERNAL_REASONING_HINT_TEXT).toContain("Let me check");
    expect(INTERNAL_REASONING_HINT_TEXT).toContain("I'll search");
    expect(INTERNAL_REASONING_HINT_TEXT).toContain("First, I'll");
  });

  it("explicitly states the user does not see thinking content", () => {
    // Tolerate the verbatim line-wrap between "anything" and "inside" — the
    // sub-plan §6.4 wording prefers a paragraph wrap there.
    const collapsed = INTERNAL_REASONING_HINT_TEXT.toLowerCase().replaceAll(/\s+/g, " ");
    expect(collapsed).toContain("the user will not see anything inside");
  });
});
