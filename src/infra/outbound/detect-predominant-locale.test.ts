import { describe, expect, it } from "vitest";

import { __detectPredominantLocaleForTests as detectPredominantLocale } from "./outbound-sanitizer.js";

/**
 * NEW-D Phase 3 — pure-function tests for the in-sanitizer predominant-locale
 * detector. Mirrors the arithmetic at
 * `src/agents/pi-embedded-subscribe.handlers.messages.ts:350-354` byte-for-byte.
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_locale_aware_sanitizer.plan.md`
 * §5 / phase 3 todo.
 */
describe("outbound-sanitizer / detectPredominantLocale", () => {
  it("verdict 'ru' for Cyrillic-heavy text", () => {
    const result = detectPredominantLocale("Привет, как дела?");
    expect(result.locale).toBe("ru");
    expect(result.cyrillic).toBe(13);
    expect(result.latin).toBe(0);
    expect(result.ratio).toBe(1);
  });

  it("verdict 'en' for Latin-heavy text", () => {
    const result = detectPredominantLocale("ALERT: Vladimir is waiting for confirmation");
    expect(result.locale).toBe("en");
    expect(result.cyrillic).toBe(0);
    // 'ALERT' (5) + 'Vladimir' (8) + 'is' (2) + 'waiting' (7) + 'for' (3) + 'confirmation' (12) = 37
    expect(result.latin).toBe(37);
    expect(result.ratio).toBe(1);
  });

  it("verdict 'en' when Latin > Cyrillic in mixed text", () => {
    // 'Привет' = 6 cyrillic; 'here is a code block' = 16 latin (h,e,r,e + i,s
    // + a + c,o,d,e + b,l,o,c,k). Predominant verdict therefore 'en'.
    const result = detectPredominantLocale("Привет, here is a code block");
    expect(result.locale).toBe("en");
    expect(result.cyrillic).toBe(6);
    expect(result.latin).toBe(16);
    expect(result.ratio).toBeCloseTo(16 / 22, 5);
  });

  it("verdict 'other' for empty / numeric-only / emoji-only", () => {
    expect(detectPredominantLocale("").locale).toBe("other");
    expect(detectPredominantLocale("12345").locale).toBe("other");
    expect(detectPredominantLocale("👍🎉").locale).toBe("other");
  });

  it("ratio is 0 for text with zero alphabetic chars", () => {
    expect(detectPredominantLocale("12345").ratio).toBe(0);
    expect(detectPredominantLocale("👍").ratio).toBe(0);
    expect(detectPredominantLocale("").ratio).toBe(0);
  });
});
