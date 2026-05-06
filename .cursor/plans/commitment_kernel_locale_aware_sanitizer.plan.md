---
name: NEW-D — Locale-aware outbound sanitizer
slice: locale-aware-sanitizer
status: in_progress
signoff: GRANTED via blanket authorization 2026-05-05
overview: "Master §0.5.6 NEW-D. Live evidence (gateway log L2392): `[assistant-reply] runId=4407441e lang=en cyr=0 head=\"ALERT: Vladimir is waiting f...\"` — English system-meta string emitted on channel whose audience locale is `ru`. Slice I sanitizer (`src/infra/outbound/outbound-sanitizer.ts`) covers 16 diagnostic patterns plus the (since-reverted) `english_meta_*` family, but is structurally NOT aware of the channel's audience locale. ALERT-style strings that aren't diagnostics and not in curated patterns pass through. Architectural fix: ADDITIVE on slice I P5+P6 surface — extend `ReplySanitizerPolicy` with optional `localeFilter?: { allowedLocales, minimumRatio }`, reuse existing predominant-locale detector that already produced the `cyr=0` evidence (Cyrillic vs Latin char ratio at `pi-embedded-subscribe.handlers.messages.ts:350-354`), block chunks whose detected locale doesn't match `allowedLocales`. Wired at `deliver.ts:417-433` resolver call. Frozen layer untouched. Backward-compat total: when `localeFilter` absent, sanitizer behavior byte-identical."
todos:
  - id: lc-phase-1-audit
    content: "Phase 1 — Audit (read-only). Output `extensions/AUDIT-locale-aware-sanitizer.md`. Confirm: (a) `outbound-sanitizer.ts` current API: `sanitizeOutboundForExternalChannel(text, policy = DEFAULT_STRIP_POLICY): OutboundSanitizerResult`; 16 patterns active post-revert; `policy` parameter consumed only via `void policy` today. (b) `ReplySanitizerPolicy` shape at `reply-sanitizer-policy.ts`: single field `reasoning: 'strip'|'structured'|'deferred'`; 12 channel entries in `CHANNEL_POLICY` map. No locale field. (c) Predominant-locale detector at `src/agents/pi-embedded-subscribe.handlers.messages.ts:350-354` — Cyrillic via `/[Ѐ-ӿ]/g`, Latin via `/[A-Za-z]/g`, `langGuess = cyrillic > latin ? 'ru' : latin > 0 ? 'en' : 'other'` — produced the L2392 evidence. (d) Channel-policy plug-in surface at `src/plugin-sdk/channel-policy.ts` has NO locale field today. (e) `deliver.ts:417-433` is single wiring point — gate `isReplySanitizerSurface(channel)`, policy resolved from `resolveReplySanitizerPolicy(channel)`, telemetry via `formatOutboundSanitizerLog`. (f) Confirm NO new reader of RawUserTurn — sanitizer continues reading assistant OUTPUT only. NO source changes."
    status: pending
  - id: lc-phase-2-types
    content: "Phase 2 — types ADDITIVELY. Extend `src/infra/outbound/reply-sanitizer-policy.ts`: NEW `LocaleFilterPolicy = { allowedLocales: readonly string[]; minimumRatio: number }` (locale ids 'ru'|'en'|'other'; minimumRatio default 0.5). Extend `ReplySanitizerPolicy` ADDITIVELY: `localeFilter?: LocaleFilterPolicy`. Existing 12 frozen singletons (`POLICY_STRIP`, `POLICY_STRUCTURED`, `POLICY_DEFERRED`) keep `localeFilter=undefined` ⇒ existing behavior byte-identical. NEW per-channel locale defaults `CHANNEL_LOCALE_DEFAULTS: ReadonlyMap<string, readonly string[]>` — operator-curated audience locale (telegram → ['ru'] for live test channel, webchat → ['ru','en'], slack → ['en']). NEW resolver `resolveReplySanitizerPolicyWithLocale(channel: string): ReplySanitizerPolicy` returns existing frozen singleton merged with `localeFilter` derived from `CHANNEL_LOCALE_DEFAULTS` (or undefined when channel has no entry). Existing `resolveReplySanitizerPolicy` UNCHANGED — both functions co-exist; deliver.ts switches in Phase 4. Tests: per-channel resolver returns documented locale filter; channels with no entry return policy with `localeFilter === undefined`; resolver returns frozen object (no per-call alloc regression). Frozen layer: `src/infra/outbound/` is NOT frozen; additive type extension. 5 frozen contracts byte-identical."
    status: pending
  - id: lc-phase-3-sanitizer-extension
    content: "Phase 3 — extend sanitizer with locale gate. NEW internal `detectPredominantLocale(text): { locale: 'ru'|'en'|'other', cyrillic, latin, ratio }` co-located in `outbound-sanitizer.ts` (mirrors arithmetic at `pi-embedded-subscribe.handlers.messages.ts:350` byte-for-byte: `/[Ѐ-ӿ]/g` Cyrillic count + `/[A-Za-z]/g` Latin count + `cyrillic > latin ? 'ru' : latin > 0 ? 'en' : 'other'`). Sanitizer flow: (1) run existing 16-pattern strip path UNCHANGED; (2) IF `policy.localeFilter` defined AND resulting text non-empty AND `detectPredominantLocale(text).locale` NOT in `allowedLocales` AND alphabetic-char-count >= minimum threshold (avoid false-blocks on short/numeric/emoji replies — proposed threshold 8 chars): block chunk by setting text empty + emit synthetic `OutboundSanitizerStripEvent { patternId: 'locale_filter_block', count: 1 }`. Caller substitutes `EMPTY_AFTER_SANITIZATION_FALLBACK_TEXT` (existing path). (3) Return `OutboundSanitizerResult` shape unchanged — no caller migration. Tests (each fail-first): (a) text 'ALERT: Vladimir is waiting for confirmation' + policy `{localeFilter: {allowedLocales: ['ru'], minimumRatio: 0.5}}` → blocked, stripped contains `locale_filter_block`. (b) text 'Привет' + same policy → unchanged. (c) text 'Hello' + policy `{localeFilter: {allowedLocales: ['en']}}` → unchanged. (d) text 'OK' (2 alpha chars) + locale filter → unchanged (under threshold). (e) text 'Привет, here is a code block' (Cyr 6, Lat 18) + allowedLocales: ['ru'] → blocked (Latin predominant per existing arithmetic). (f) regression: text '[planner] route=...' + locale filter on Russian channel → stripped by existing planner_marker pattern (locale gate doesn't fire — text becomes empty before locale check). (g) policy with `localeFilter === undefined` → byte-identical to today across all 16 existing patterns + clean text. Frozen layer: `outbound-sanitizer.ts` is in `src/infra/outbound/` NOT frozen; additive in-function branch."
    status: pending
  - id: lc-phase-4-channel-policy-wiring
    content: "Phase 4 — wire channel locale into deliver.ts. Change `deliver.ts:419` from `resolveReplySanitizerPolicy(channel)` to `resolveReplySanitizerPolicyWithLocale(channel)` (Phase 2 augmented resolver). Same `policy` value continues threading into `sanitizeOutboundForExternalChannel(beforeText, policy)`. NEW telemetry variant in `formatOutboundSanitizerLog` when `locale_filter_block` in stripped: emit `[outbound-sanitizer] locale_filter applied locale=<detected> blocked=true reason=no_cyrillic channel=<c>` (or `reason=no_latin` when allowedLocales=['en']). Existing diagnostic-pattern telemetry shape unchanged. Backward-compat: when `localeFilter === undefined` (channel not in `CHANNEL_LOCALE_DEFAULTS`), Phase 3 branch skipped — pre-Phase-4 logs and outputs byte-identical. Tests in `deliver.outbound-sanitizer.test.ts`: (a) telegram + ALERT-style English text + `CHANNEL_LOCALE_DEFAULTS.telegram = ['ru']` → outbound payload empty-substituted with `EMPTY_AFTER_SANITIZATION_FALLBACK_TEXT`, telemetry includes `locale_filter` line. (b) telegram + Russian text → unchanged passthrough. (c) slack channel (allowedLocales=['en']) + Russian text → blocked (reverse). (d) channel with no locale default → unchanged (regression). Frozen layer: deliver.ts is NOT frozen; 4 frozen call-sites untouched."
    status: pending
  - id: lc-phase-5-acceptance-and-live-verify
    content: "Phase 5 — acceptance + live regression. NEW `src/infra/outbound/deliver.b5-locale-replay.test.ts` (3 cases): (1) construct payload `\"ALERT: Vladimir is waiting for confirmation\"` (L2392 head sample), channel=telegram, channel-locale=ru → outbound = fallback text + `[outbound-sanitizer] locale_filter applied locale=en blocked=true reason=no_cyrillic` log. (2) payload 'Готово', channel=telegram, channel-locale=ru → outbound = 'Готово' verbatim, no locale telemetry. (3) regression: payload with [planner] diagnostic on channel-locale=ru → existing 16-pattern strip fires first, locale gate inert. Per-pattern reverse-tests guaranteed (slice I P5/P6 precedent). LIVE-VERIFY (REQUIRED — invariant #15 + handoff doc «не делать «зелёные unit-тесты» как доказательство»): operator restarts gateway, provokes alert path that produced L2392, asserts in `C:/tmp/openclaw/openclaw-<date>.log`: (a) ZERO new occurrences of `[assistant-reply] ... lang=en cyr=0 ...` followed by outbound payload reaching telegram; (b) at least ONE `[outbound-sanitizer] locale_filter applied locale=en blocked=true reason=no_cyrillic` per regression alert; (c) Telegram receives fallback `\"Запрос не удалось выполнить.\"` instead of English ALERT; (d) Russian replies on same channel pass unchanged. Per HANDOFF: green CI alone is INSUFFICIENT proof — Telegram live verify mandatory."
    status: pending
isProject: false
---

# NEW-D — Locale-aware outbound sanitizer

## 0. Provenance

| Field | Value |
| --- | --- |
| Sub-plan of | `.cursor/plans/commitment_kernel_v1_master.plan.md` (§0.5.6 row NEW-D) |
| Inherits | 16 hard invariants from `.cursor/rules/commitment-kernel-invariants.mdc` |
| Predecessors | Slice I (sanitizer P5+P6 — additive policy field surface; PRs #161/#162/#166); outbound sanitizer side-plan; streaming-leak Bug A; slice E P5/P6 + slice F P5/P6 (additive frozen-layer extension shape) |
| Trigger | Master §0.5.6 NEW-D — gateway log L2392 `[assistant-reply] runId=4407441e lang=en cyr=0 head="ALERT: Vladimir is waiting f..."` reached telegram channel with audience locale=ru. Slice I sanitizer's diagnostic-pattern coverage doesn't block this; reverted `english_meta_*` family was the prior catch |
| Out of scope | (a) Re-introducing reverted `english_meta_*` patterns (master roadmap §3 «LLM-mediated, not regex»). (b) Translating outbound text — slice BLOCKS, doesn't translate. (c) Multi-locale users where one channel has speakers of both locales — addressed via `allowedLocales: readonly string[]` accepting multiple ids. (d) Transliteration heuristics. (e) `src/platform/commitment/**` (frozen). (f) 4 frozen call-sites + 5 frozen contracts. (g) NEW-A/B/C — separate sub-plans |
| Maintainer signoff | GRANTED via blanket authorization 2026-05-05 |

## 1. Hard invariants this slice keeps

- **#5**: Locale detector reads assistant OUTPUT only — same boundary as existing 16 diagnostic patterns. Reverse-test: assert no new code path reads `RawUserTurn`/`UserPrompt`/`commandBody`.
- **#6**: Sanitizer reads only assistant `payload.text`; locale resolver reads only channel id (string), never raw user text.
- **#8**: This slice modifies only `src/infra/outbound/`; no imports from `decision/` either way.
- **#11**: 5 frozen decision contracts byte-identical.
- **#12**: No emergency phrase patches. Locale gate is STRUCTURAL filter on (channel id → audience locale → predominant-locale-of-text) — three structural primitives, no phrase rules.
- **#15**: Blanket signoff. Live Telegram verify mandatory at Phase 5.
- **#16**: `EffectFamilyId` ≠ `EffectId` — untouched (no new effect ids).

## 2. Audit findings (TO BE FILLED IN BY PHASE 1)

> Phase 1 produces `extensions/AUDIT-locale-aware-sanitizer.md`. Sketches:

### 2.1. Existing sanitizer surface
`src/infra/outbound/outbound-sanitizer.ts:250-284` — `sanitizeOutboundForExternalChannel(text, policy)`. The `policy` argument consumed only by `void policy` today; 16 diagnostic patterns strip identically under all three `policy.reasoning` values. Locale gate is FIRST consumer of policy beyond signature stability.

### 2.2. Existing policy surface
`src/infra/outbound/reply-sanitizer-policy.ts:55` — `ReplySanitizerPolicy = { readonly reasoning: 'strip'|'structured'|'deferred' }`. 12 channel entries (9 plaintext messengers → strip, webchat → structured, slack/discord → deferred). `reasoning` is the slice I P5+P6 surface; THIS slice adds ADDITIVE second field `localeFilter?` per same precedent.

### 2.3. Predominant-locale detector — ALREADY EXISTS
`src/agents/pi-embedded-subscribe.handlers.messages.ts:350-354`:
```ts
const cyrillic = (rawText.match(/[Ѐ-ӿ]/g) ?? []).length;
const latin = (rawText.match(/[A-Za-z]/g) ?? []).length;
const langGuess = cyrillic > latin ? "ru" : latin > 0 ? "en" : "other";
```
Produced the literal `lang=en cyr=0` value in NEW-D evidence. Phase 3 co-locates `detectPredominantLocale(text)` inside `outbound-sanitizer.ts` with byte-identical semantics.

### 2.4. Channel-policy locale field — DOES NOT EXIST
Phase 2 introduces `CHANNEL_LOCALE_DEFAULTS` inside `src/infra/outbound/reply-sanitizer-policy.ts` — operator-curated map keyed by channel id. Avoids modifying public plugin SDK in v1.

### 2.5. Deliver.ts wiring point
`src/infra/outbound/deliver.ts:417-433` — single block where `isReplySanitizerSurface(channel)` gates the call.

## 3. Hypothesis

Three forces:
1. **Slice I P5+P6 ADDITIVE-policy precedent**: existing `ReplySanitizerPolicy.reasoning` field landed via additive extension. Adding `localeFilter?` is same pattern, second field.
2. **Existing predominant-locale detector**: arithmetic at `pi-embedded-subscribe.handlers.messages.ts:350` ALREADY produced `cyr=0 lang=en` for L2392 evidence — re-using byte-for-byte avoids inventing parallel detector.
3. **Out-of-frozen-layer surgery**: all edits land in `src/infra/outbound/`. No commitment-kernel module touched. Backward-compat total when channel not in `CHANNEL_LOCALE_DEFAULTS`.

The slice ships exactly what NEW-D requires: structural gate that blocks ALERT-style English on `locale=ru` channel, identically to how slice I diagnostic gate blocks `[planner] ...` on every external channel.

## 4. Acceptance criteria

1. **L2392 regression closed**: replay fixture with payload `"ALERT: Vladimir is waiting for confirmation"` on telegram (channel-locale=ru) → outbound becomes `EMPTY_AFTER_SANITIZATION_FALLBACK_TEXT` (`"Запрос не удалось выполнить."`); telemetry contains `[outbound-sanitizer] locale_filter applied locale=en blocked=true reason=no_cyrillic channel=telegram`.
2. **Russian content unchanged**: 'Готово' → byte-identical passthrough; zero locale-filter telemetry.
3. **Reverse direction**: slack channel (allowedLocales=['en']) + Russian payload → blocked.
4. **No-locale channels unchanged**: channel id absent from `CHANNEL_LOCALE_DEFAULTS` → policy `localeFilter === undefined` → Phase 3 branch skipped → behavior byte-identical.
5. **Existing 16 patterns regression**: all slice-I sanitizer fixtures continue passing.
6. **Frozen layer untouched**: no new imports into `src/platform/commitment/`.
7. **No new raw-user-text reader**: reverse-test asserts no new file reads `RawUserTurn`/`UserPrompt`/`commandBody`.
8. **Live Telegram verify (mandatory)**: Phase 5 verify confirms in real gateway log that ALERT-style English no longer leaks on live `locale=ru` channel and Russian replies pass.

## 5. Per-phase tests

- Fail-first per phase.
- No `vi.spyOn` on function under test. `sanitizeOutboundForExternalChannel`, `resolveReplySanitizerPolicyWithLocale`, `detectPredominantLocale` run real instances.
- Negative coverage explicit per Phase-3 branch: positive (English ALERT on ru channel → blocked); negative (Russian text on ru channel → passthrough); reverse (Russian text on en channel → blocked); no-locale-config (channel absent → byte-identical).

Log-line evidence to assert in Phase 5 live verify:
- `[outbound-sanitizer] locale_filter applied locale=en blocked=true reason=no_cyrillic channel=telegram` — must appear at least once when ALERT-class English would otherwise reach channel.
- `[assistant-reply] ... lang=en cyr=0 ...` followed by SAME-runId outbound success on telegram — must NOT appear after fix lands.
- Existing `[outbound-sanitizer] event=stripped channel=...` lines unchanged.

## 6. Implementation notes

- All edits in `src/infra/outbound/` (NOT frozen layer).
- Touched files: `reply-sanitizer-policy.ts` (additive type + `CHANNEL_LOCALE_DEFAULTS` + new resolver); `outbound-sanitizer.ts` (additive `detectPredominantLocale` + in-function branch); `deliver.ts` (single-line resolver swap + telemetry augmentation); 4 test files extended/new.
- NOT TOUCHED: `src/platform/commitment/**` (frozen); `pi-embedded-subscribe.handlers.messages.ts` (predominant-locale arithmetic stays observational; sanitizer co-locates independent copy); `src/plugin-sdk/channel-policy.ts` (audit-only; SDK widening deferred); 4 frozen call-sites; 5 frozen decision contracts.
- Locale defaults v1: telegram → ['ru'], webchat → ['ru', 'en'], others ABSENT (opt-in by operator under live evidence).
- Threshold: `minimumRatio: 0.5`; minimum-alphabetic-char threshold 8 chars (avoid blocking 'OK', '5', '👍').
- Operator-curated map discipline matches slice I 16-pattern list — additions only under live-log evidence.

## 7. Maintainer signoff

GRANTED via blanket authorization 2026-05-05. Live Telegram verify in Phase 5 mandatory before status flip to completed.

## 8. Deferred / out-of-scope

| Item | Why deferred |
| --- | --- |
| Multi-locale users on single channel | `allowedLocales` accepts list; per-recipient routing requires recipient metadata not available at delivery layer today |
| Transliteration edge case | Cyrillic-to-Latin transliterated Russian counts as Latin under existing detector — would be blocked. Mitigation via `allowedLocales: ['ru', 'en']` |
| Per-recipient locale override | Channel-level default sufficient for v1 |
| Plugin SDK locale field | v1 keeps `CHANNEL_LOCALE_DEFAULTS` inside `reply-sanitizer-policy.ts` |
| NEW-A/B/C | Separate sub-plans |
| Re-introducing reverted `english_meta_*` patterns | Out of scope per master roadmap §3 |

## 9. Handoff Log

(Empty — filled by handoff-writer post-phase-merge.)

## 10. References

- Master plan §0.5.6 row NEW-D
- Hard invariants `.cursor/rules/commitment-kernel-invariants.mdc`
- Slice I sub-plan `.cursor/plans/commitment_kernel_reply_sanitizer.plan.md` (P5+P6 ADDITIVE-policy precedent)
- Original outbound sanitizer sub-plan `.cursor/plans/commitment_kernel_outbound_sanitizer.plan.md`
- Streaming-leak Bug A sub-plan `.cursor/plans/commitment_kernel_streaming_leak.plan.md`
- Live evidence `C:/tmp/openclaw/openclaw-2026-05-06.log:L2392`
- Frozen layer `src/platform/commitment/**` (untouched)
- 4 frozen call-sites `src/platform/plugin.ts:80,340`; `src/platform/decision/input.ts:444,481` (untouched)
- Sanitizer module `src/infra/outbound/outbound-sanitizer.ts:250` (current API)
- Policy module `src/infra/outbound/reply-sanitizer-policy.ts:55` (current shape)
- Predominant-locale detector source-of-truth `src/agents/pi-embedded-subscribe.handlers.messages.ts:350-354`
- Deliver wiring point `src/infra/outbound/deliver.ts:417-433`
- HANDOFF doc `.cursor/plans/HANDOFF-2026-05-06-policy-gate-cutover3.md`
