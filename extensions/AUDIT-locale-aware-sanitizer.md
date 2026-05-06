# NEW-D — Locale-Aware Outbound Sanitizer Phase 1 Audit (READ-ONLY)

Branch: `audit/new-d-locale-aware-sanitizer-phase-1`
Base SHA: `dev` HEAD at audit time = `86ff73353f` (PR #225 — slice-unified-session-reset Phase 6 acceptance fixture, NEW-B SLICE COMPLETE).
Maintainer signoff: blanket maintainer signoff for v1 commitment-kernel slices granted 2026-05-05 by Vladimir; read-only audit phases always cleared.

This document VERIFIES the §2 audit sketch in
`.cursor/plans/commitment_kernel_locale_aware_sanitizer.plan.md` against live
source on `dev`. No code was executed. No source under `src/` was modified.
Findings are line-anchored to current `dev` HEAD.

Hard invariants kept by Phase 1: #5 (no text matching on `UserPrompt` outside
whitelist), #6 (`IntentContractor` sole reader of raw user text), #8
(`src/platform/commitment/` does not import from `src/platform/decision/`),
#11 (5 frozen contracts read-only), #12 (no emergency phrase patches —
locale gate is structural, not phrase-curated), #15 (signoff required for
code-touching phases — Phase 1 is read-only), #16 (`EffectFamilyId` ≠
`EffectId` — untouched, no new effect ids).

Live evidence motivating the slice (`C:/tmp/openclaw/openclaw-2026-05-06.log`,
gateway log L2392):

```
[assistant-reply] runId=4407441e lang=en cyr=0 head="ALERT: Vladimir is waiting f..."
```

The English-meta `ALERT:` prefix reached a telegram channel whose audience
locale is `ru`. Slice I sanitizer (`outbound-sanitizer.ts`) covers 16
diagnostic patterns plus the (since-reverted) `english_meta_*` family, but is
structurally NOT aware of the channel's audience locale — `ALERT:`-style
strings that aren't diagnostics and aren't in a curated phrase list pass
through.

---

## §a — `outbound-sanitizer.ts` current API

File: `src/infra/outbound/outbound-sanitizer.ts`.

### a.1. Export signature

The single public sanitization entry point is at lines 250–284:

```ts
export function sanitizeOutboundForExternalChannel(
  text: string,
  policy: ReplySanitizerPolicy = DEFAULT_STRIP_POLICY,
): OutboundSanitizerResult {
```

`DEFAULT_STRIP_POLICY` is the local frozen singleton at line 223:

```ts
const DEFAULT_STRIP_POLICY: ReplySanitizerPolicy = Object.freeze({ reasoning: "strip" });
```

`OutboundSanitizerResult` shape at lines 216–221:

```ts
export type OutboundSanitizerResult = {
  readonly text: string;
  readonly stripped: readonly OutboundSanitizerStripEvent[];
};
```

`OutboundSanitizerStripEvent` shape at lines 211–214:

```ts
export type OutboundSanitizerStripEvent = {
  readonly patternId: string;
  readonly count: number;
};
```

Verified: matches plan §2.1 sketch. The signature is the slice I P5+P6
ADDITIVE-policy surface; no caller migration needed when Phase 2 widens the
`ReplySanitizerPolicy` shape with an optional `localeFilter` field.

### a.2. `policy` parameter consumed only via `void policy`

Lines 257–261:

```ts
// Slice I rollback: `policy` is intentionally inspected only for type-shape
// compatibility — every value branches identically until the future
// tag-based wrap consumer lands. Reference the parameter to avoid an
// unused-binding lint while keeping the signature stable.
void policy;
```

Verified: the only reference to `policy` inside the function body is the
`void policy;` lint-suppress at line 261. Phase 3 of NEW-D is the FIRST
consumer of the policy beyond signature stability (locale-filter branch
introduced before the existing 16-pattern loop has nothing to do; the gate
fires AFTER the 16 patterns ran — see plan §2 / §6 implementation notes).

### a.3. 16 patterns active post-revert

The pattern array `OUTBOUND_LEAK_PATTERNS` is declared at line 118; it
contains exactly 16 entries, listed verbatim below with their `id` values
(line numbers are the `id:` field anchor):

| # | line | id |
|---|------|----|
| 1 | 120 | `tool_error_marker` |
| 2 | 125 | `tool_error_envelope` |
| 3 | 131 | `task_classifier_marker` |
| 4 | 136 | `planner_marker` |
| 5 | 141 | `provenance_guard_marker` |
| 6 | 146 | `subagent_aggregation_marker` |
| 7 | 151 | `intent_ledger_marker` |
| 8 | 156 | `debug_marker` |
| 9 | 161 | `node_stack_trace` |
| 10 | 166 | `node_error_path` |
| 11 | 171 | `universal_tool_call_xml` |
| 12 | 176 | `universal_tool_use_xml` |
| 13 | 181 | `universal_function_call_xml` |
| 14 | 186 | `universal_tool_call_json_envelope` |
| 15 | 197 | `universal_tool_call_orphan_open` |
| 16 | 204 | `universal_tool_call_orphan_close` |

Composition matches the module header comment at lines 105–117:

> 7 line-markers (logger prefixes from kernel/decision/aggregation paths);
> 1 JSON envelope (raw tool-error result); 2 Node stack-trace shapes;
> 6 universal tool-call markers (Bug A) — 3 balanced XML blocks, 2 orphan
> tag forms (streaming-cut), 1 JSON tool-call envelope.

(Note: the comment says "7 line-markers"; the table above counts 8 line/
text markers — `tool_error_marker`, `task_classifier_marker`,
`planner_marker`, `provenance_guard_marker`, `subagent_aggregation_marker`,
`intent_ledger_marker`, `debug_marker`, plus `node_stack_trace` /
`node_error_path` separately. The header comment treats the two
node-shape entries as their own bucket, which matches the table.)

Cross-check via test-only export at lines 308–310:

```ts
export const __OUTBOUND_LEAK_PATTERN_IDS_FOR_TESTS: readonly string[] = OUTBOUND_LEAK_PATTERNS.map(
  (p) => p.id,
);
```

A grep for `english_meta_` across `src/infra/outbound/` returns no hits in
the active source — confirming the master roadmap §3 revert ("LLM-mediated,
not regex"). The L2392 evidence string `ALERT: Vladimir is waiting for
confirmation` does not match any of the 16 active patterns (no `[…]`
prefix, no JSON envelope shape, no XML markup, no Node stack-trace shape) —
verified by visual inspection of every pattern regex.

Verified: matches plan §2.1 sketch.

---

## §b — `ReplySanitizerPolicy` shape

File: `src/infra/outbound/reply-sanitizer-policy.ts`.

### b.1. Type with exactly one field

Lines 55–57:

```ts
export type ReplySanitizerPolicy = {
  readonly reasoning: "strip" | "structured" | "deferred";
};
```

Verified: a single field `reasoning`. NO `locale` field. Plan §2.2 sketch
matches.

### b.2. Frozen singletons (lines 60–62)

```ts
const POLICY_STRIP: ReplySanitizerPolicy = Object.freeze({ reasoning: "strip" });
const POLICY_STRUCTURED: ReplySanitizerPolicy = Object.freeze({ reasoning: "structured" });
const POLICY_DEFERRED: ReplySanitizerPolicy = Object.freeze({ reasoning: "deferred" });
```

Three frozen instances. Resolver returns one of these (or `POLICY_STRIP` as
the safe default for unknown channels).

### b.3. `CHANNEL_POLICY` map — channel-id entries

Lines 69–96. Channel-id entries (literal channel ids only; the
`INTERNAL_MESSAGE_CHANNEL` symbol resolves to `"webchat"`):

| line | channel id | policy |
|------|-----------|--------|
| 71 | `telegram` | `POLICY_STRIP` |
| 72 | `whatsapp` | `POLICY_STRIP` |
| 73 | `signal` | `POLICY_STRIP` |
| 74 | `imessage` | `POLICY_STRIP` |
| 75 | `googlechat` | `POLICY_STRIP` |
| 76 | `line` | `POLICY_STRIP` |
| 79 | `irc` | `POLICY_STRIP` |
| 80 | `max` | `POLICY_STRIP` |
| 84 | `voice` | `POLICY_STRIP` |
| 85 | `sms` | `POLICY_STRIP` |
| 90 | `INTERNAL_MESSAGE_CHANNEL` (`webchat`) | `POLICY_STRUCTURED` |
| 94 | `slack` | `POLICY_DEFERRED` |
| 95 | `discord` | `POLICY_DEFERRED` |

Total: **13 entries**. Plan §2.2 sketch claims "12 channel entries" — the
actual count is 13 on dev HEAD `86ff73353f`. The +1 delta versus the plan
sketch is `line` (line 76); the 9 plaintext messengers + 1 internal +
2 deferred = 12 buckets, but `line` is a 10th plaintext entry. NEW-D Phase 2
should iterate the actual 13-entry map when populating
`CHANNEL_LOCALE_DEFAULTS`. Plan can be amended at handoff time; functional
impact is nil (locale defaults are operator-curated and start from a
narrower set: telegram → ['ru'], webchat → ['ru','en'], others ABSENT per
plan §6).

### b.4. Resolver returns frozen singleton (no per-call alloc)

Lines 129–131:

```ts
export function resolveReplySanitizerPolicy(channel: string): ReplySanitizerPolicy {
  return CHANNEL_POLICY.get(channel) ?? POLICY_STRIP;
}
```

The resolver returns one of the three module-level frozen singletons or
the safe `POLICY_STRIP` default. No per-call object allocation.

Phase 2 of NEW-D introduces a separate resolver
(`resolveReplySanitizerPolicyWithLocale`) that returns a NEW frozen object
when a locale filter is required for the channel and falls back to the
existing `POLICY_STRIP` / `POLICY_STRUCTURED` / `POLICY_DEFERRED` singletons
when no locale entry is configured. Plan §2 / phase 2 todo confirms this
design.

### b.5. Reverse-test: NO `RawUserTurn` / `UserPrompt` / `commandBody` reader

Grep for `RawUserTurn|UserPrompt|commandBody` against
`src/infra/outbound/reply-sanitizer-policy.ts` returns one hit — at line 34,
inside the module doc comment:

```
 *   `RawUserTurn` / `UserPrompt` import anywhere in this file.
```

This is a comment guarding the boundary. There is NO type import, value
import, or string-method usage of `RawUserTurn`, `UserPrompt`, or
`commandBody` anywhere in the module body. Invariant #5 / #6 upheld.

---

## §c — Predominant-locale detector source-of-truth

File: `src/agents/pi-embedded-subscribe.handlers.messages.ts`, lines 348–356:

```ts
if (rawText) {
  const headSample = rawText.replace(/\s+/g, " ").trim().slice(0, 120).replace(/"/g, "'");
  const cyrillic = (rawText.match(/[Ѐ-ӿ]/g) ?? []).length;
  const latin = (rawText.match(/[A-Za-z]/g) ?? []).length;
  const langGuess = cyrillic > latin ? "ru" : latin > 0 ? "en" : "other";
  defaultRuntime.log(
    `[assistant-reply] runId=${String(ctx.params.runId).slice(0, 8)} lang=${langGuess} cyr=${String(cyrillic)} lat=${String(latin)} head="${headSample}"`,
  );
}
```

The arithmetic at lines 350–352 is the signal that produced the literal
`lang=en cyr=0` value in the L2392 evidence head sample. Three structural
primitives:

1. Cyrillic count: `(rawText.match(/[Ѐ-ӿ]/g) ?? []).length` — Unicode block
   `U+0400`–`U+04FF` (`Ѐ`–`ӿ`) covers Russian / Ukrainian / Belarusian /
   etc.
2. Latin count: `(rawText.match(/[A-Za-z]/g) ?? []).length` — ASCII
   alphabet only.
3. Verdict: `cyrillic > latin ? "ru" : latin > 0 ? "en" : "other"` —
   Cyrillic-predominant ⇒ `ru`; otherwise any Latin char ⇒ `en`; else
   `"other"`.

NEW-D Phase 3 co-locates `detectPredominantLocale(text)` inside
`outbound-sanitizer.ts` mirroring the arithmetic byte-for-byte. The
co-location avoids cross-module coupling (`outbound-sanitizer.ts` already
imports nothing from `src/agents/`) and lets the sanitizer return a
structured `{ locale, cyrillic, latin, ratio }` shape internally that the
existing `pi-embedded-subscribe.handlers.messages.ts` log-line callsite
does not need.

Reverse-test: the detector reads `rawText` (assistant message body, an
OUTPUT artifact), NOT `RawUserTurn` / `UserPrompt` / `commandBody`. The
existing `cyr=0 lat=…` log line on L2392 was produced for the assistant
reply — confirming the boundary.

---

## §d — Channel-policy plug-in surface — NO locale field

File: `src/plugin-sdk/channel-policy.ts`.

This module is the public plug-in SDK helper for channel security policies
(DM allowlist resolvers, restrict-senders warning collectors, group-policy
warning composers). A line-by-line review of the full module (96 lines)
confirms:

- Re-exports DM / group-policy types and helpers from
  `src/channels/plugins/...` and `src/config/...`.
- Single function export `createRestrictSendersChannelSecurity` at line 50,
  whose params (lines 52–69) cover channel security (`channelKey`, DM
  policy resolvers, group-policy resolvers, surface, openScope, group
  policy / allow-from paths, mention-gating, default DM policy, normalize-
  entry hooks).
- NO field, parameter, type member, or string-method use of `locale`.
- Grep `locale|Locale` over the module body returns ZERO hits.

The module-wide grep for `locale` across `src/plugin-sdk/` matches only
`localeCompare` (a `String.prototype` sort helper) at
`src/plugin-sdk/api-baseline.ts:331` and `:424`. Neither is a locale
configuration field; both are case-insensitive sort utilities.

Verified: NEW-D Phase 2 does NOT widen `src/plugin-sdk/channel-policy.ts`.
The locale defaults map (`CHANNEL_LOCALE_DEFAULTS`) lives inside
`src/infra/outbound/reply-sanitizer-policy.ts` per plan §2 phase 2 todo
and §6 deferred item ("Plugin SDK locale field — v1 keeps
`CHANNEL_LOCALE_DEFAULTS` inside `reply-sanitizer-policy.ts`"). v1 ships
the locale gate without touching the public plug-in SDK shape.

---

## §e — Deliver call site (single wiring point)

File: `src/infra/outbound/deliver.ts`, lines 401–434.

The block at lines 417–433 is the single place where the sanitizer fires
on outbound payloads:

```ts
if (isReplySanitizerSurface(channel) && sanitizedPayload.text) {
  const beforeText = sanitizedPayload.text;
  const policy = resolveReplySanitizerPolicy(channel);
  const sanitizationResult = sanitizeOutboundForExternalChannel(beforeText, policy);
  if (sanitizationResult.stripped.length > 0) {
    const finalText = sanitizationResult.text || EMPTY_AFTER_SANITIZATION_FALLBACK_TEXT;
    sanitizedPayload = { ...sanitizedPayload, text: finalText };
    log.warn(
      formatOutboundSanitizerLog({
        channel,
        stripped: sanitizationResult.stripped,
        sessionKey,
        bytesBefore: beforeText.length,
        bytesAfter: finalText.length,
      }),
    );
  }
}
```

Three structural primitives:

1. **Gate** — `isReplySanitizerSurface(channel)` at line 417. Returns
   true for channels in `REPLY_SANITIZER_SURFACES` (the set derived from
   `CHANNEL_POLICY.keys()` in `reply-sanitizer-policy.ts:112`). For
   channels with no entry in the policy map the sanitizer is bypassed
   entirely (no behavior change for unknown / internal-only channels).
2. **Policy resolution** — `resolveReplySanitizerPolicy(channel)` at line
   419. Phase 4 of NEW-D rebinds this single `const policy` line to
   `resolveReplySanitizerPolicyWithLocale(channel)` — the only call-site
   migration. `sanitizeOutboundForExternalChannel(beforeText, policy)` at
   line 420 continues threading the same `policy` value through; the
   widened `ReplySanitizerPolicy` shape is backward-compatible because
   the locale field is optional.
3. **Telemetry** — `formatOutboundSanitizerLog(...)` at line 425 emits one
   `[outbound-sanitizer] event=stripped channel=… patterns=[…] session=…
   bytes_before=… bytes_after=…` line per delivery (see
   `outbound-sanitizer.ts:290`). Phase 4 of NEW-D adds a new line variant
   `[outbound-sanitizer] locale_filter applied locale=<detected>
   blocked=true reason=no_cyrillic channel=<c>` when the locale gate
   fires, without changing the existing `event=stripped` shape.

Verified: matches plan §2.5 sketch. Single wiring point; defense-in-depth
gate already in place; Phase 4 needs ONE-line resolver swap plus the new
telemetry variant — no other callers of
`sanitizeOutboundForExternalChannel` exist on `dev` HEAD `86ff73353f`
that need migration (verified by grep — the only call site within
`src/infra/outbound/` is at `deliver.ts:420`; tests reach the function
directly).

---

## §f — Reverse-test: no new reader of `RawUserTurn` / `UserPrompt`

NEW-D's locale gate must read assistant OUTPUT only — same boundary as
the existing 16 diagnostic patterns. Phase 1 confirms the current state
on dev:

- `outbound-sanitizer.ts` — grep `RawUserTurn|UserPrompt|commandBody`
  returns hits only inside the module-doc header comment (lines 22, 29,
  30) discussing the boundary; ZERO type imports / value imports / string
  matches against those types in the module body. The function reads only
  the `text: string` parameter that the caller passes in — and that
  parameter is `sanitizedPayload.text` (assistant OUTPUT) at
  `deliver.ts:418`.
- `reply-sanitizer-policy.ts` — grep returns one hit at line 34 (module-
  doc comment guarding the boundary). Resolver consumes only a `string`
  channel id.
- The predominant-locale detector source at
  `pi-embedded-subscribe.handlers.messages.ts:350–352` reads `rawText`
  (the assistant message body, an OUTPUT artifact), NOT user input. The
  L2392 log line was produced for the assistant reply — confirming the
  boundary holds today.

NEW-D Phase 3 introduces `detectPredominantLocale(text)` co-located
inside `outbound-sanitizer.ts`. The function takes `text: string` (the
already-sanitized OUTPUT after the 16 diagnostic patterns ran) and
returns the same `{ locale, cyrillic, latin, ratio }` structural verdict
the detector produces today. NO new reader of `RawUserTurn` / `UserPrompt`
/ `commandBody` is added. Invariants #5, #6 upheld; lint
`lint:commitment:no-raw-user-text-import` continues to pass (the locale
gate reads only assistant payload text and a channel id).

---

## Summary

| § | Sketch claim | Verified | Notes |
|---|--------------|----------|-------|
| a | `sanitizeOutboundForExternalChannel(text, policy = DEFAULT_STRIP_POLICY)` at lines 250–284 | YES | DEFAULT_STRIP_POLICY at line 223; policy used only via `void policy` at line 261 |
| a | 16 patterns active post-revert | YES | Table above; `english_meta_*` family removed; ALERT-style strings not matched |
| b | `ReplySanitizerPolicy` = single field `reasoning` | YES | Lines 55–57 |
| b | Resolver returns frozen singleton | YES | Lines 129–131; three module-level frozen instances |
| b | NO locale field | YES | Verified |
| b | "12 channel entries" | NO — actual is 13 | `line` is the +1 delta vs. plan sketch; functional impact nil for Phase 2 |
| c | Predominant-locale arithmetic at lines 350–354 | YES | Quoted verbatim above; `cyrillic > latin ? "ru" : latin > 0 ? "en" : "other"` |
| c | Produced L2392 evidence | YES | Same callsite emits `lang=…` / `cyr=…` |
| d | `src/plugin-sdk/channel-policy.ts` has NO locale field | YES | Full-module review; locale-grep returns only `localeCompare` sort helpers in `api-baseline.ts` |
| e | `deliver.ts:417–433` is single wiring point | YES | Three primitives: gate, resolver, telemetry; one-line resolver swap suffices for Phase 4 |
| f | No new reader of `RawUserTurn` / `UserPrompt` | YES | Reverse-grep confirms current state and Phase 3 plan keeps the boundary |

Phase 1 deliverable READY. Phase 2 (additive types + per-channel locale
defaults + Locale-aware resolver) can proceed under blanket signoff.

---

## References

- Plan: `.cursor/plans/commitment_kernel_locale_aware_sanitizer.plan.md`
- Master plan §0.5.6 row NEW-D: `.cursor/plans/commitment_kernel_v1_master.plan.md`
- Hard invariants: `.cursor/rules/commitment-kernel-invariants.mdc`
- Slice I sub-plan (P5+P6 ADDITIVE-policy precedent):
  `.cursor/plans/commitment_kernel_reply_sanitizer.plan.md`
- Slice I audit deliverable: `extensions/AUDIT-reply-sanitizer.md`
- Original outbound-sanitizer sub-plan:
  `.cursor/plans/commitment_kernel_outbound_sanitizer.plan.md`
- Streaming-leak Bug A:
  `.cursor/plans/commitment_kernel_streaming_leak.plan.md`
- Live evidence: `C:/tmp/openclaw/openclaw-2026-05-06.log` line 2392
- Sanitizer module: `src/infra/outbound/outbound-sanitizer.ts:250`
- Policy module: `src/infra/outbound/reply-sanitizer-policy.ts:55`
- Predominant-locale detector source-of-truth:
  `src/agents/pi-embedded-subscribe.handlers.messages.ts:350-354`
- Deliver wiring point: `src/infra/outbound/deliver.ts:417-433`
- Plug-in SDK channel-policy module:
  `src/plugin-sdk/channel-policy.ts` (no locale field)
- HANDOFF doc: `.cursor/plans/HANDOFF-2026-05-06-policy-gate-cutover3.md`
- Frozen layer (untouched): `src/platform/commitment/**`
