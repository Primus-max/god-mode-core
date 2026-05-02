import { describe, expect, it } from "vitest";
import { splitTelegramCaption, TELEGRAM_MAX_CAPTION_LENGTH } from "./caption.js";

describe("splitTelegramCaption", () => {
  it("returns empty parts for blank captions", () => {
    expect(splitTelegramCaption("   ")).toEqual({
      caption: undefined,
      followUpText: undefined,
    });
  });

  it("keeps short captions inline", () => {
    expect(splitTelegramCaption(" hello ")).toEqual({
      caption: "hello",
      followUpText: undefined,
    });
  });

  it("packs the caption to the limit and overflow into follow-up text when the input has no whitespace", () => {
    const text = "x".repeat(TELEGRAM_MAX_CAPTION_LENGTH + 5);
    const result = splitTelegramCaption(text);
    expect(result.caption).toBeDefined();
    expect(result.caption?.length).toBe(TELEGRAM_MAX_CAPTION_LENGTH);
    expect(result.followUpText).toBe("xxxxx");
  });

  it("splits at the last whitespace inside the caption window when one is available in the back half", () => {
    const head = "word ".repeat(200);
    const tail = "tail".repeat(50);
    const result = splitTelegramCaption(head + tail);
    expect(result.caption).toBeDefined();
    expect(result.caption?.length).toBeLessThanOrEqual(TELEGRAM_MAX_CAPTION_LENGTH);
    expect(result.caption?.endsWith("word")).toBe(true);
    expect(result.followUpText).toBeDefined();
    expect(result.followUpText?.startsWith("word") || result.followUpText?.startsWith("tail")).toBe(
      true,
    );
    expect((result.caption ?? "").length + (result.followUpText ?? "").length).toBeLessThanOrEqual(
      head.length + tail.length,
    );
  });

  it("hard-cuts at the limit when no whitespace appears in the back half of the window", () => {
    const giantWord = "y".repeat(TELEGRAM_MAX_CAPTION_LENGTH);
    const text = `${giantWord} tail-text`;
    const result = splitTelegramCaption(text);
    expect(result.caption?.length).toBe(TELEGRAM_MAX_CAPTION_LENGTH);
    expect(result.followUpText).toBe("tail-text");
  });

  it("preserves trailing words when overflow lands across multiple paragraphs", () => {
    const paragraph = "paragraph text ".repeat(80);
    const text = paragraph + "\n\nsecond paragraph remainder text";
    const result = splitTelegramCaption(text);
    expect(result.caption).toBeDefined();
    expect(result.caption?.length).toBeLessThanOrEqual(TELEGRAM_MAX_CAPTION_LENGTH);
    expect(result.followUpText).toBeDefined();
    expect((result.caption ?? "").trim().length).toBeGreaterThan(0);
    expect((result.followUpText ?? "").trim().length).toBeGreaterThan(0);
  });
});
