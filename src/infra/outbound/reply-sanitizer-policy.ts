/**
 * Reply-sanitizer channel policy (slice I, Phase 2).
 *
 * Per-channel structural policy describing how the outbound sanitizer should
 * treat assistant-emitted reasoning / English meta-thinking text. v1 ships
 * three values:
 *
 *   - `"strip"`     — drop reasoning entirely (plaintext messengers; default).
 *   - `"structured"` — wrap reasoning in a `<thinking lang="…">` block so a
 *                     UI-aware adapter (today: webchat) can render it.
 *   - `"deferred"`  — sanitizer surfaces this so slack / discord adapters can
 *                     opt into a thread / sidebar later. v1 callers MUST
 *                     treat it as `"strip"` for the inline payload (Phase 5
 *                     wiring lands the explicit branch).
 *
 * This module is types + resolver only. It does NOT consume policy at any
 * call site. Phase 5 (`deliver.ts:404`) wires `resolveReplySanitizerPolicy`
 * into the existing outbound-sanitizer call.
 *
 * Channel coverage (per Phase 1 audit `extensions/AUDIT-reply-sanitizer.md`
 * §6.1 + §6.2):
 *
 *   policy domain = CHAT_CHANNEL_ORDER ∪ EXTERNAL_DELIVERY_SURFACE_LIST
 *                   ∪ { INTERNAL_MESSAGE_CHANNEL }
 *
 * `irc` and `max` are in `CHAT_CHANNEL_ORDER` but absent from the existing
 * `EXTERNAL_DELIVERY_SURFACES` set; this module names them explicitly so the
 * policy mapping does not silently fall through to the safe-default branch.
 * `voice` and `sms` exist as outbound delivery surfaces only (not chat
 * channel ids) and likewise need explicit listing.
 *
 * Hard invariants (`.cursor/rules/commitment-kernel-invariants.mdc`):
 * - #5: resolver consumes a `string` channel id, NOT raw user text. No
 *   `RawUserTurn` / `UserPrompt` import anywhere in this file.
 * - #6: `IntentContractor` is the sole reader of raw user text; this module
 *   reads only a channel id, never user text — the invariant is upheld in
 *   spirit.
 * - #8: `src/infra/outbound/` does NOT import from `src/platform/decision/`.
 *   This module imports only from sibling channel registry modules.
 * - #11, #15: 5 frozen contracts untouched. Phase 2 is types + resolver
 *   only; pattern curation (Phase 3) and prompt-side wiring (Phase 4)
 *   require additional signoff.
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_reply_sanitizer.plan.md` §6.1.
 */

import { CHAT_CHANNEL_ORDER } from "../../channels/ids.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";

/**
 * Per-channel structural policy. Frozen object — callers MUST NOT mutate.
 *
 * Field history:
 *   - `reasoning` — slice I P5+P6 ADDITIVE-policy surface (v1).
 *   - `localeFilter` — NEW-D Phase 2 ADDITIVE optional field (live evidence
 *     L2392: ALERT-style English text reached telegram channel with audience
 *     locale=ru; Phase 3 introduces the in-sanitizer locale gate that
 *     consumes this policy field).
 *
 * Existing call sites that destructure `{ reasoning }` continue to compile
 * unchanged; the locale-aware resolver
 * (`resolveReplySanitizerPolicyWithLocale`) is opt-in until Phase 4 wires
 * deliver.ts.
 */
export type ReplySanitizerPolicy = {
  readonly reasoning: "strip" | "structured" | "deferred";
  readonly localeFilter?: LocaleFilterPolicy;
};

/**
 * Per-channel audience-locale filter for the outbound sanitizer.
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_locale_aware_sanitizer.plan.md`
 * §2 / phase 2 todo. Phase 3 introduces the in-sanitizer detector that
 * mirrors the predominant-locale arithmetic from
 * `src/agents/pi-embedded-subscribe.handlers.messages.ts:350-354` (Cyrillic
 * via `/[Ѐ-ӿ]/g` count vs. Latin via `/[A-Za-z]/g` count). When the detected
 * predominant locale is NOT in `allowedLocales`, the sanitizer blocks the
 * chunk by emitting a synthetic `locale_filter_block` strip event.
 *
 * Locale ids in v1 are tri-valued: `'ru'` | `'en'` | `'other'` (per the
 * existing detector verdict). The shape allows additional ids without a
 * breaking change.
 */
export type LocaleFilterPolicy = {
  /**
   * Audience locales allowed on this channel. The chunk is blocked when the
   * detected predominant locale is absent from this list. Empty list is
   * unsupported (operators should remove the channel entry from
   * `CHANNEL_LOCALE_DEFAULTS` to disable the gate instead of supplying an
   * empty list).
   */
  readonly allowedLocales: readonly string[];
  /**
   * Minimum predominance ratio for the locale verdict to count. Default 0.5
   * — half the alphabetic chars must match the predominant locale. The
   * Phase 3 detector also requires a minimum-alphabetic-char threshold
   * (proposed 8 chars) before firing the gate; this avoids false-blocks on
   * short / numeric / emoji-only replies (`OK`, `5`, `👍`).
   */
  readonly minimumRatio: number;
};

/** Frozen singletons returned by the resolver. Per-call allocation avoided. */
const POLICY_STRIP: ReplySanitizerPolicy = Object.freeze({ reasoning: "strip" });
const POLICY_STRUCTURED: ReplySanitizerPolicy = Object.freeze({ reasoning: "structured" });
const POLICY_DEFERRED: ReplySanitizerPolicy = Object.freeze({ reasoning: "deferred" });

/**
 * Channel → policy map. Values cover the union of three sets per audit §6.2.
 * Unknown channel ids fall through to `POLICY_STRIP` (safe default; see
 * `resolveReplySanitizerPolicy`).
 */
const CHANNEL_POLICY: ReadonlyMap<string, ReplySanitizerPolicy> = new Map([
  // Plaintext messengers — strip reasoning entirely.
  ["telegram", POLICY_STRIP],
  ["whatsapp", POLICY_STRIP],
  ["signal", POLICY_STRIP],
  ["imessage", POLICY_STRIP],
  ["googlechat", POLICY_STRIP],
  ["line", POLICY_STRIP],
  // Audit §6.1: irc / max are in CHAT_CHANNEL_ORDER but absent from
  // EXTERNAL_DELIVERY_SURFACES — name them explicitly.
  ["irc", POLICY_STRIP],
  ["max", POLICY_STRIP],
  // Audit §6.2: voice / sms exist as outbound delivery surfaces only
  // (not chat channel ids) — name them explicitly so callers passing the
  // outbound-only id resolve the right policy.
  ["voice", POLICY_STRIP],
  ["sms", POLICY_STRIP],
  // Internal UI channel — sanitizer wraps reasoning in <thinking lang="…">
  // for the webchat UI to render. MUST NEVER be reachable from a plaintext
  // channel id (the unknown-channel default is `strip`, not `structured`,
  // precisely so a typo cannot leak reasoning).
  [INTERNAL_MESSAGE_CHANNEL, POLICY_STRUCTURED],
  // Thread-capable surfaces — sanitizer surfaces `deferred` so future
  // adapter work can opt into a thread / sidebar. v1 callers treat this as
  // `strip` for the inline payload (Phase 5 wiring).
  ["slack", POLICY_DEFERRED],
  ["discord", POLICY_DEFERRED],
]);

/**
 * Set of channels for which the sanitizer should run. Superset of:
 *   - `EXTERNAL_DELIVERY_SURFACES` (telegram/whatsapp/slack/discord/signal/
 *     imessage/sms/voice/googlechat) — defined in `outbound-sanitizer.ts`.
 *   - `INTERNAL_MESSAGE_CHANNEL` (`webchat`) — for the structured wrap.
 *   - `irc`, `max`, `line` — chat channels not yet in
 *     `EXTERNAL_DELIVERY_SURFACES` today (audit §6.1; Phase 5 / 6 will
 *     either add them there or rely on this superset).
 *
 * Derived directly from `CHANNEL_POLICY.keys()` so the two stay in sync —
 * adding a channel to the policy map automatically enrolls it as a
 * sanitizer surface. Unknown channels (no entry in the map) are NOT in this
 * set; the sanitizer should bypass them entirely.
 */
export const REPLY_SANITIZER_SURFACES: ReadonlySet<string> = new Set(CHANNEL_POLICY.keys());

/**
 * Resolves the sanitizer policy for a channel id.
 *
 * @param channel - channel id (chat channel, outbound delivery surface, or
 *   `INTERNAL_MESSAGE_CHANNEL`).
 * @returns frozen `ReplySanitizerPolicy` instance. Unknown channel ids
 *   resolve to `{ reasoning: "strip" }` — the SAFE default. The default
 *   MUST NEVER be `"structured"` because that would leak reasoning to
 *   plaintext channels for any channel id the resolver fails to recognise.
 *
 * Defense-in-depth: `isReplySanitizerSurface(channel)` returns false for
 * unknown channels, so the call site in Phase 5 will skip the sanitizer
 * entirely. But IF a future caller bypasses the gate, this resolver still
 * returns a strip policy — both layers must fail safe.
 */
export function resolveReplySanitizerPolicy(channel: string): ReplySanitizerPolicy {
  return CHANNEL_POLICY.get(channel) ?? POLICY_STRIP;
}

/**
 * True when `channel` is a known sanitizer surface (chat channel, outbound
 * surface, or `webchat`). False for unknown / internal-only ids.
 */
export function isReplySanitizerSurface(channel: string): boolean {
  return REPLY_SANITIZER_SURFACES.has(channel);
}

/**
 * @internal Test-only: list of channel ids covered by an explicit policy
 * entry. Used by `reply-sanitizer-policy.test.ts` to smoke-check coverage
 * against `CHAT_CHANNEL_ORDER` + `INTERNAL_MESSAGE_CHANNEL`.
 */
export const __REPLY_SANITIZER_POLICY_CHANNELS_FOR_TESTS: readonly string[] = Array.from(
  CHANNEL_POLICY.keys(),
);

// ---------------------------------------------------------------------------
// NEW-D Phase 2 — locale-aware resolver (additive)
// ---------------------------------------------------------------------------
//
// Sub-plan: `.cursor/plans/commitment_kernel_locale_aware_sanitizer.plan.md`
// §2 / phase 2 todo + audit deliverable `extensions/AUDIT-locale-aware-
// sanitizer.md` §b.
//
// The locale-aware surface co-exists with the original `resolveReplySanitizer
// Policy`. Phase 4 will rebind the single `deliver.ts:419` call-site to the
// locale-aware variant. Both functions return the SAME shape; the locale-
// aware variant additionally populates the optional `localeFilter` field
// from the operator-curated `CHANNEL_LOCALE_DEFAULTS` map.
//
// Map curation discipline matches slice I 16-pattern list — additions only
// under live-log evidence. v1 ships ONLY the two channels with documented
// audience-locale evidence (telegram via L2392, webchat as multi-locale UI);
// every other channel is opt-in.

/**
 * Minimum predominance ratio for `LocaleFilterPolicy`. Half the alphabetic
 * chars must match the predominant locale before the gate fires.
 */
const DEFAULT_LOCALE_MINIMUM_RATIO = 0.5;

/**
 * Operator-curated audience-locale defaults per channel id. Values are
 * frozen `readonly string[]` arrays of locale ids (`'ru'` / `'en'` /
 * `'other'`). Channels ABSENT from this map resolve to a policy with
 * `localeFilter === undefined` — the Phase 3 sanitizer branch is skipped and
 * behavior is byte-identical to today.
 *
 * Curation v1 (sub-plan §6 implementation notes):
 *   - `telegram` → `['ru']` — live test channel; L2392 evidence (`lang=en
 *     cyr=0`) of English ALERT leak motivated the slice.
 *   - `webchat` (`INTERNAL_MESSAGE_CHANNEL`) → `['ru','en']` — multi-locale
 *     UI default; both locales acceptable on the same channel.
 *
 * The remaining 11 channel-policy entries (whatsapp / signal / imessage /
 * googlechat / line / irc / max / voice / sms / slack / discord) are
 * intentionally absent so the gate stays evidence-driven. Operators add a
 * channel here only after observing a leak class on that surface.
 */
export const CHANNEL_LOCALE_DEFAULTS: ReadonlyMap<string, readonly string[]> = new Map<
  string,
  readonly string[]
>([
  ["telegram", Object.freeze(["ru"]) as readonly string[]],
  [INTERNAL_MESSAGE_CHANNEL, Object.freeze(["ru", "en"]) as readonly string[]],
]);

/**
 * Per-channel locale-aware policy singletons. Built once at module init from
 * the existing reasoning-based singletons + the locale entries above. Two
 * calls to `resolveReplySanitizerPolicyWithLocale` for the same channel
 * return the IDENTICAL frozen reference — no per-call object allocation.
 *
 * Channels absent from `CHANNEL_LOCALE_DEFAULTS` are NOT placed in this map;
 * the resolver falls back to the existing `resolveReplySanitizerPolicy`
 * singleton (same `{ reasoning }` shape, no `localeFilter` property).
 */
const CHANNEL_POLICY_WITH_LOCALE: ReadonlyMap<string, ReplySanitizerPolicy> = new Map(
  Array.from(CHANNEL_LOCALE_DEFAULTS, ([channel, allowedLocales]): [string, ReplySanitizerPolicy] => {
    const base = CHANNEL_POLICY.get(channel) ?? POLICY_STRIP;
    const localeFilter: LocaleFilterPolicy = Object.freeze({
      allowedLocales,
      minimumRatio: DEFAULT_LOCALE_MINIMUM_RATIO,
    });
    const merged: ReplySanitizerPolicy = Object.freeze({
      reasoning: base.reasoning,
      localeFilter,
    });
    return [channel, merged];
  }),
);

/**
 * Locale-aware variant of `resolveReplySanitizerPolicy`. Returns the existing
 * frozen singleton (`POLICY_STRIP` / `POLICY_STRUCTURED` / `POLICY_DEFERRED`)
 * merged with the operator-curated `localeFilter` from
 * `CHANNEL_LOCALE_DEFAULTS` when one is configured. Channels absent from the
 * map return the SAME singleton as `resolveReplySanitizerPolicy(channel)` —
 * `localeFilter === undefined`, behavior byte-identical.
 *
 * Phase 4 wires this into `deliver.ts:419` (single resolver swap). Until
 * then, `resolveReplySanitizerPolicy` remains the live call-site and this
 * function is exercised only by tests.
 *
 * @param channel - channel id (chat channel, outbound delivery surface, or
 *   `INTERNAL_MESSAGE_CHANNEL`).
 * @returns frozen `ReplySanitizerPolicy`. The result is reference-stable
 *   across calls for any given channel (configured or not).
 */
export function resolveReplySanitizerPolicyWithLocale(channel: string): ReplySanitizerPolicy {
  return CHANNEL_POLICY_WITH_LOCALE.get(channel) ?? resolveReplySanitizerPolicy(channel);
}
