import { describe, expect, it } from "vitest";
import { CHAT_CHANNEL_ORDER } from "../../channels/ids.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import {
  REPLY_SANITIZER_SURFACES,
  isReplySanitizerSurface,
  resolveReplySanitizerPolicy,
} from "./reply-sanitizer-policy.js";

describe("reply-sanitizer-policy / resolveReplySanitizerPolicy", () => {
  it.each([
    ["telegram"],
    ["whatsapp"],
    ["signal"],
    ["imessage"],
    ["max"],
    ["voice"],
    ["sms"],
    ["irc"],
    ["googlechat"],
    ["line"],
  ])("maps plaintext channel %s -> reasoning=strip", (channel) => {
    expect(resolveReplySanitizerPolicy(channel)).toEqual({ reasoning: "strip" });
  });

  it("maps webchat (INTERNAL_MESSAGE_CHANNEL) -> reasoning=structured", () => {
    expect(resolveReplySanitizerPolicy(INTERNAL_MESSAGE_CHANNEL)).toEqual({
      reasoning: "structured",
    });
    expect(resolveReplySanitizerPolicy("webchat")).toEqual({ reasoning: "structured" });
  });

  it.each([["slack"], ["discord"]])(
    "maps thread-capable channel %s -> reasoning=deferred",
    (channel) => {
      expect(resolveReplySanitizerPolicy(channel)).toEqual({ reasoning: "deferred" });
    },
  );

  it("defaults unknown channel -> reasoning=strip (defense-against-leak default)", () => {
    expect(resolveReplySanitizerPolicy("unknown_channel_xyz")).toEqual({ reasoning: "strip" });
    expect(resolveReplySanitizerPolicy("")).toEqual({ reasoning: "strip" });
    expect(resolveReplySanitizerPolicy("tui")).toEqual({ reasoning: "strip" });
    expect(resolveReplySanitizerPolicy("stdout")).toEqual({ reasoning: "strip" });
  });

  it("MUST NEVER default unknown channel to structured (would leak reasoning to plaintext)", () => {
    for (const candidate of ["webcat", "WEBCHAT", " webchat", "web-chat", "tg", "tlg"]) {
      const policy = resolveReplySanitizerPolicy(candidate);
      expect(policy.reasoning).not.toBe("structured");
      expect(policy.reasoning).toBe("strip");
    }
  });

  it("returns frozen policy objects (callers cannot mutate the policy in-place)", () => {
    const policy = resolveReplySanitizerPolicy("telegram");
    expect(() => Object.freeze(policy)).not.toThrow();
    expect(() => {
      (policy as { reasoning: string }).reasoning = "structured";
    }).toThrow(TypeError);
    expect(resolveReplySanitizerPolicy("telegram").reasoning).toBe("strip");
  });
});

describe("reply-sanitizer-policy / REPLY_SANITIZER_SURFACES", () => {
  it("contains every chat channel from CHAT_CHANNEL_ORDER", () => {
    for (const channel of CHAT_CHANNEL_ORDER) {
      expect(REPLY_SANITIZER_SURFACES.has(channel)).toBe(true);
    }
  });

  it("contains webchat (INTERNAL_MESSAGE_CHANNEL)", () => {
    expect(REPLY_SANITIZER_SURFACES.has(INTERNAL_MESSAGE_CHANNEL)).toBe(true);
    expect(REPLY_SANITIZER_SURFACES.has("webchat")).toBe(true);
  });

  it("contains voice and sms (audit finding 6.2 - outbound-only surfaces)", () => {
    expect(REPLY_SANITIZER_SURFACES.has("voice")).toBe(true);
    expect(REPLY_SANITIZER_SURFACES.has("sms")).toBe(true);
  });

  it("explicitly contains irc (audit finding 6.1 - was missing from EXTERNAL_DELIVERY_SURFACES)", () => {
    expect(REPLY_SANITIZER_SURFACES.has("irc")).toBe(true);
  });

  it("explicitly contains max (audit confirmed it is absent from EXTERNAL_DELIVERY_SURFACES today)", () => {
    expect(REPLY_SANITIZER_SURFACES.has("max")).toBe(true);
  });

  it("does NOT contain unknown channels", () => {
    expect(REPLY_SANITIZER_SURFACES.has("unknown_channel_xyz")).toBe(false);
    expect(REPLY_SANITIZER_SURFACES.has("")).toBe(false);
    expect(REPLY_SANITIZER_SURFACES.has("tui")).toBe(false);
    expect(REPLY_SANITIZER_SURFACES.has("stdout")).toBe(false);
  });
});

describe("reply-sanitizer-policy / isReplySanitizerSurface", () => {
  it("returns true for webchat", () => {
    expect(isReplySanitizerSurface("webchat")).toBe(true);
    expect(isReplySanitizerSurface(INTERNAL_MESSAGE_CHANNEL)).toBe(true);
  });

  it("returns true for telegram and other external chat surfaces", () => {
    for (const channel of [
      "telegram",
      "whatsapp",
      "signal",
      "imessage",
      "googlechat",
      "slack",
      "discord",
      "irc",
      "line",
      "max",
      "voice",
      "sms",
    ]) {
      expect(isReplySanitizerSurface(channel)).toBe(true);
    }
  });

  it("returns false for unknown channels (defense-in-depth: resolver still falls back to strip)", () => {
    expect(isReplySanitizerSurface("unknown_channel_xyz")).toBe(false);
    expect(resolveReplySanitizerPolicy("unknown_channel_xyz").reasoning).toBe("strip");
  });

  it("returns false for empty string", () => {
    expect(isReplySanitizerSurface("")).toBe(false);
  });
});
