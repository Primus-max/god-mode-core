import { describe, expect, it } from "vitest";
import { CHAT_CHANNEL_ORDER } from "../../channels/ids.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import {
  CHANNEL_LOCALE_DEFAULTS,
  REPLY_SANITIZER_SURFACES,
  isReplySanitizerSurface,
  resolveReplySanitizerPolicy,
  resolveReplySanitizerPolicyWithLocale,
  type LocaleFilterPolicy,
  type ReplySanitizerPolicy,
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

// ---------------------------------------------------------------------------
// NEW-D Phase 2 — additive locale filter surface
// ---------------------------------------------------------------------------
//
// Phase 2 extends `ReplySanitizerPolicy` with an optional `localeFilter` field
// (slice I P5+P6 ADDITIVE-policy precedent). Existing 13 channel-entry tests
// above MUST remain green — Phase 2 is type extension + new resolver only.
// Existing `resolveReplySanitizerPolicy` is byte-identical and continues to
// return the three frozen singletons (`POLICY_STRIP` / `POLICY_STRUCTURED` /
// `POLICY_DEFERRED`) without a `localeFilter` field — those callers are
// untouched until Phase 4 wires deliver.ts to the new resolver.

describe("reply-sanitizer-policy / CHANNEL_LOCALE_DEFAULTS (NEW-D Phase 2)", () => {
  it("documents telegram audience locale = ru (live evidence L2392)", () => {
    expect(CHANNEL_LOCALE_DEFAULTS.get("telegram")).toEqual(["ru"]);
  });

  it("documents webchat audience locale = ru,en (multi-locale UI)", () => {
    expect(CHANNEL_LOCALE_DEFAULTS.get("webchat")).toEqual(["ru", "en"]);
    expect(CHANNEL_LOCALE_DEFAULTS.get(INTERNAL_MESSAGE_CHANNEL)).toEqual(["ru", "en"]);
  });

  it("does NOT pre-populate other channels — opt-in by operator under live evidence", () => {
    // The 11 remaining channel-policy entries (whatsapp, signal, imessage,
    // googlechat, line, irc, max, voice, sms, slack, discord) are ABSENT from
    // CHANNEL_LOCALE_DEFAULTS in v1. Operators add them explicitly when they
    // observe a leak class on that channel. This keeps the gate evidence-
    // driven (slice I 16-pattern curation discipline).
    for (const channel of [
      "whatsapp",
      "signal",
      "imessage",
      "googlechat",
      "line",
      "irc",
      "max",
      "voice",
      "sms",
      "slack",
      "discord",
    ]) {
      expect(CHANNEL_LOCALE_DEFAULTS.has(channel)).toBe(false);
    }
  });

  it("returns a readonly map (callers cannot mutate)", () => {
    // Map itself is exposed as ReadonlyMap; structural-readonly guarantees
    // the entries cannot be mutated through the type. Defense-in-depth at
    // runtime: each value is also a frozen array.
    const tel = CHANNEL_LOCALE_DEFAULTS.get("telegram");
    expect(tel).toBeDefined();
    expect(Object.isFrozen(tel)).toBe(true);
  });
});

describe("reply-sanitizer-policy / resolveReplySanitizerPolicyWithLocale (NEW-D Phase 2)", () => {
  it("merges telegram strip policy with localeFilter={ru} from CHANNEL_LOCALE_DEFAULTS", () => {
    const policy = resolveReplySanitizerPolicyWithLocale("telegram");
    expect(policy.reasoning).toBe("strip");
    expect(policy.localeFilter).toBeDefined();
    expect(policy.localeFilter).toEqual({ allowedLocales: ["ru"], minimumRatio: 0.5 });
  });

  it("merges webchat structured policy with localeFilter={ru,en}", () => {
    const policy = resolveReplySanitizerPolicyWithLocale("webchat");
    expect(policy.reasoning).toBe("structured");
    expect(policy.localeFilter).toEqual({ allowedLocales: ["ru", "en"], minimumRatio: 0.5 });
    const policySym = resolveReplySanitizerPolicyWithLocale(INTERNAL_MESSAGE_CHANNEL);
    expect(policySym.reasoning).toBe("structured");
    expect(policySym.localeFilter).toEqual({ allowedLocales: ["ru", "en"], minimumRatio: 0.5 });
  });

  it("returns localeFilter=undefined when channel absent from CHANNEL_LOCALE_DEFAULTS (slack)", () => {
    const policy = resolveReplySanitizerPolicyWithLocale("slack");
    expect(policy.reasoning).toBe("deferred");
    expect(policy.localeFilter).toBeUndefined();
  });

  it("returns localeFilter=undefined for plaintext channels without a configured default (whatsapp)", () => {
    const policy = resolveReplySanitizerPolicyWithLocale("whatsapp");
    expect(policy.reasoning).toBe("strip");
    expect(policy.localeFilter).toBeUndefined();
  });

  it("returns localeFilter=undefined for unknown channels (safe-strip default)", () => {
    const policy = resolveReplySanitizerPolicyWithLocale("unknown_channel_xyz");
    expect(policy.reasoning).toBe("strip");
    expect(policy.localeFilter).toBeUndefined();
    expect(resolveReplySanitizerPolicyWithLocale("").reasoning).toBe("strip");
    expect(resolveReplySanitizerPolicyWithLocale("").localeFilter).toBeUndefined();
  });

  it("returns the SAME frozen object across calls for a no-locale channel (no per-call alloc)", () => {
    // Channels absent from CHANNEL_LOCALE_DEFAULTS resolve to the existing
    // module-level frozen singletons (POLICY_STRIP / POLICY_STRUCTURED /
    // POLICY_DEFERRED). Two calls must return the identical reference.
    const a = resolveReplySanitizerPolicyWithLocale("slack");
    const b = resolveReplySanitizerPolicyWithLocale("slack");
    expect(a).toBe(b);
    const c = resolveReplySanitizerPolicyWithLocale("whatsapp");
    const d = resolveReplySanitizerPolicyWithLocale("whatsapp");
    expect(c).toBe(d);
    const e = resolveReplySanitizerPolicyWithLocale("unknown_xyz");
    const f = resolveReplySanitizerPolicyWithLocale("unknown_xyz");
    expect(e).toBe(f);
  });

  it("returns the SAME frozen object across calls for a configured-locale channel (no per-call alloc)", () => {
    // Channels in CHANNEL_LOCALE_DEFAULTS resolve to a per-channel frozen
    // singleton built once at module init. Two calls return the identical
    // reference — no per-call object allocation.
    const a = resolveReplySanitizerPolicyWithLocale("telegram");
    const b = resolveReplySanitizerPolicyWithLocale("telegram");
    expect(a).toBe(b);
    const c = resolveReplySanitizerPolicyWithLocale("webchat");
    const d = resolveReplySanitizerPolicyWithLocale("webchat");
    expect(c).toBe(d);
  });

  it("returned objects are deep-frozen (caller cannot mutate localeFilter)", () => {
    const policy = resolveReplySanitizerPolicyWithLocale("telegram");
    expect(Object.isFrozen(policy)).toBe(true);
    expect(() => {
      (policy as { reasoning: string }).reasoning = "structured";
    }).toThrow(TypeError);
    expect(policy.localeFilter).toBeDefined();
    if (policy.localeFilter) {
      expect(Object.isFrozen(policy.localeFilter)).toBe(true);
      expect(() => {
        (policy.localeFilter as unknown as { minimumRatio: number }).minimumRatio = 0.9;
      }).toThrow(TypeError);
      expect(Object.isFrozen(policy.localeFilter.allowedLocales)).toBe(true);
    }
  });

  it("does NOT mutate the existing frozen singletons returned by resolveReplySanitizerPolicy", () => {
    // Backward-compat invariant: the original POLICY_STRIP / POLICY_STRUCTURED
    // / POLICY_DEFERRED singletons must remain { reasoning } objects WITHOUT a
    // localeFilter property. The locale-aware resolver builds a SEPARATE
    // frozen object for the configured-locale entries; it must not retro-fit
    // a localeFilter onto the original three singletons.
    const stripExisting = resolveReplySanitizerPolicy("telegram");
    const structuredExisting = resolveReplySanitizerPolicy("webchat");
    const deferredExisting = resolveReplySanitizerPolicy("slack");
    expect(Object.prototype.hasOwnProperty.call(stripExisting, "localeFilter")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(structuredExisting, "localeFilter")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(deferredExisting, "localeFilter")).toBe(false);
  });

  it("preserves type discipline — LocaleFilterPolicy / ReplySanitizerPolicy compile-time check", () => {
    // Compile-time assertion: the new types must be assignable to the
    // documented shape. If the production type narrows / widens incorrectly
    // this assignment fails typecheck.
    const localeFilter: LocaleFilterPolicy = {
      allowedLocales: ["ru"],
      minimumRatio: 0.5,
    };
    const policy: ReplySanitizerPolicy = {
      reasoning: "strip",
      localeFilter,
    };
    expect(policy.reasoning).toBe("strip");
    expect(policy.localeFilter?.allowedLocales).toEqual(["ru"]);
    // ReplySanitizerPolicy without a localeFilter must remain assignable
    // (additive optional field — no breaking change to existing callers).
    const noLocale: ReplySanitizerPolicy = { reasoning: "strip" };
    expect(noLocale.localeFilter).toBeUndefined();
  });
});

describe("reply-sanitizer-policy / Phase 2 backward-compat regression", () => {
  it("resolveReplySanitizerPolicy (existing function) is byte-identical for all 13 entries", () => {
    // The existing 13 channel entries must continue resolving to the
    // pre-Phase-2 frozen singletons via the ORIGINAL resolver — no widening,
    // no localeFilter, no behavior drift. The locale-aware resolver is a
    // SEPARATE function that lives alongside the original.
    const expected: ReadonlyArray<readonly [string, ReplySanitizerPolicy["reasoning"]]> = [
      ["telegram", "strip"],
      ["whatsapp", "strip"],
      ["signal", "strip"],
      ["imessage", "strip"],
      ["googlechat", "strip"],
      ["line", "strip"],
      ["irc", "strip"],
      ["max", "strip"],
      ["voice", "strip"],
      ["sms", "strip"],
      [INTERNAL_MESSAGE_CHANNEL, "structured"],
      ["slack", "deferred"],
      ["discord", "deferred"],
    ];
    for (const [channel, reasoning] of expected) {
      const policy = resolveReplySanitizerPolicy(channel);
      expect(policy.reasoning).toBe(reasoning);
      expect(Object.prototype.hasOwnProperty.call(policy, "localeFilter")).toBe(false);
    }
  });
});
