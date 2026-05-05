---
name: Slice I — Reply Sanitizer (English Reasoning Leak Fix; v1 UX Fix)
overview: "Defense in depth against English meta-thinking text leaking into Russian-language external channels (B5 from 2026-05-04 transcript: «Let me check memory for any context about Vladimir's preferences»). Two layers: (1) prompt-side hint that Anthropic/Opus must wrap reasoning in `<thinking>` blocks (today only google/minimax get this hint via `isReasoningTagProvider` — Opus does not); (2) post-filter at the existing `outbound-sanitizer` boundary in `src/infra/outbound/deliver.ts:404` that adds an English-meta-text pattern family on top of the existing curated list, with a per-channel visibility policy keyed off the new `webchat` internal channel and the existing `EXTERNAL_DELIVERY_SURFACES` allowlist. False-positive risk for legitimate English content (code, quotes, identifiers) is mitigated by line-anchored regexes, code-region awareness via `findCodeRegions`, language-mix gate (cyr/lat ratio already logged), and a curated leading-verb whitelist that targets meta-thinking imperatives only."
todos:
  - id: i-phase-1-audit-pipeline
    content: "Phase 1 — pipeline audit (READ ONLY, output `extensions/AUDIT-reply-sanitizer.md`). Trace one assistant turn from `pi-coding-agent` `completeSimple`/streaming → `pi-embedded-subscribe.ts::stripBlockTags` (Level 1 streaming chunker, line ~385) → `handleMessageEnd` (`handlers.messages.ts:322`, log line `[assistant-reply] runId=… lang=… cyr=… lat=… head=…` at line 354) → `flushBlockReplyBuffer` → `block-reply-pipeline` → `deliverOutboundPayloads` → `normalizePayloadsForChannelDelivery` (`deliver.ts:376`, current outbound sanitizer at line 404) → channel adapter. Confirm exact current behaviour: (a) `isReasoningTagProvider` returns `false` for Anthropic provider — Opus gets no `<think>/<final>` system-prompt hint today; (b) `extractAssistantText` calls `stripThinkingTagsFromText` strictly — but Anthropic's English meta-prose is in plain `text` blocks, not in `<thinking>` tags, so nothing is stripped; (c) the only language signal today is the diagnostic log at `handlers.messages.ts:354` — value is observational, not enforced. No code change in this phase."
    status: completed
  - id: i-phase-2-channel-policy-types
    content: "Phase 2 — channel-keyed sanitizer policy types. New module `src/infra/outbound/reply-sanitizer-policy.ts` with `ReplySanitizerPolicy = { reasoning: \"strip\" | \"structured\" | \"deferred\" }` and `resolveReplySanitizerPolicy(channel: string): ReplySanitizerPolicy`. Mapping (per roadmap §6 D5): telegram/whatsapp/signal/imessage/max → `strip`; webchat → `structured`; slack/discord → `deferred` (= `strip` for the inline payload, but a `structured` sidecar attached when the surrounding adapter implements it; v1 ships `strip` semantics for both, with `policy.reasoning === \"deferred\"` exposed for the slack/discord adapters to opt-in later). Tests: each channel id resolves to the documented policy; unknown channel → `strip` (safe default — must NEVER default to `structured` because that leaks reasoning to plaintext channels)."
    status: completed
  - id: i-phase-3-meta-text-pattern-family
    content: "Phase 3 — extend `OUTBOUND_LEAK_PATTERNS` with an English-meta-text pattern family (curated, line-anchored, code-region-aware via `findCodeRegions`). Patterns target the FIRST sentence of an assistant text-block only — meta-thinking always leads, content follows. Curated list (initial, evidence-driven from B5 + similar logs): `^\\s*Let me\\s+(check|look|search|verify|see)\\b`, `^\\s*I'?ll\\s+(check|look|search|verify|see)\\b`, `^\\s*I should\\s+\\w+`, `^\\s*First,?\\s+I'?ll\\b`, `^\\s*Let'?s\\s+(check|look|verify|see)\\b`, `^\\s*Looking at\\s+\\w+`, `^\\s*Checking\\s+(memory|context|the|for)\\b`. Each pattern: `kind=\"strip\"` for `policy.reasoning === \"strip\"`; for `\"structured\"` → wrap match's containing line in a JSON-tagged `<thinking lang=\"en\">…</thinking>` block. Patterns operate on the SAME `OutboundSanitizerResult` shape; new `OutboundSanitizerStripEvent.patternId` values prefixed `english_meta_*` so existing telemetry continues working. Tests reverse-test each pattern (positive + negative + code-block-protected)."
    status: pending
  - id: i-phase-4-prompt-side-hint
    content: "Phase 4 — prompt-side defense. Add a NEW system-prompt hint `internalReasoningHint` (distinct from `reasoningTagHint` which is the strict `<think>+<final>` enforcement for google/minimax). Triggered when (a) `runtimeChannel` is in `EXTERNAL_DELIVERY_SURFACES`, AND (b) `isReasoningTagProvider(provider) === false` (i.e. Anthropic/Opus and similar). Text: «If you have any internal reasoning, planning, or English meta-thinking like \"Let me check…\" / \"I'll search…\" / \"First, I'll…\", wrap it in `<thinking>...</thinking>` blocks. ONLY user-facing reply text in the user's language goes outside `<thinking>` blocks. The user will not see anything inside `<thinking>`.» This is ADVISORY (does not gate output, unlike `<final>` which is strict). Files: `src/agents/system-prompt.ts` (new param + new section between line 602's `reasoningHint` block and the next `## …` section); `src/agents/pi-embedded-runner/system-prompt.ts` (thread the new param through `buildEmbeddedSystemPrompt`); `src/agents/pi-embedded-runner/run/attempt.ts` (compute the value at line 2067 alongside `reasoningTagHint`). Tests: golden-snapshot for telegram+anthropic includes the hint; webchat+anthropic excludes the hint (UI shows reasoning); google+telegram excludes the new hint (already covered by the strict `<think>+<final>` block)."
    status: pending
  - id: i-phase-5-policy-aware-sanitizer-call
    content: "Phase 5 — wire policy into the outbound sanitizer. Change signature: `sanitizeOutboundForExternalChannel(text, policy: ReplySanitizerPolicy)` — non-breaking via overload preserving the no-arg variant for existing callers' tests. Call site in `deliver.ts:404` passes the resolved policy from `resolveReplySanitizerPolicy(channel)`. For `webchat` (which is NOT in `EXTERNAL_DELIVERY_SURFACES` today), expand the gate: a NEW `isReplySanitizerSurface(channel)` returns true for both external channels AND webchat (because webchat WANTS the structured wrap, not silent passthrough). Backward-compat: existing 16 leak patterns remain unchanged for all surfaces; only the new `english_meta_*` family branches on `policy.reasoning`. Tests: telegram + meta-text → stripped; webchat + meta-text → wrapped in `<thinking lang=\"en\">…</thinking>`; slack + meta-text → stripped (deferred = strip in v1); existing 16 patterns still strip on all surfaces; webchat does NOT strip the existing 16 (those are diagnostics that webchat may also want to show — but v1 keeps them stripped because they are non-reasoning leaks; webchat-specific handling is a follow-up)."
    status: pending
  - id: i-phase-6-acceptance-fixture
    content: "Phase 6 — replay B5 fixture. New test `src/infra/outbound/deliver.b5-replay.test.ts` constructs an assistant payload with mixed Russian content + English meta-text + a fenced ```bash``` code block whose first line happens to start with «Let me run …» (false-positive trap). For channel=telegram: assert (a) Russian content reaches the channel verbatim; (b) English meta-text outside code block stripped; (c) code block content untouched; (d) `[outbound-sanitizer]` log records `english_meta_let_me*1` event. For channel=webchat: assert (a) Russian content reaches verbatim; (b) English meta-text wrapped in `<thinking lang=\"en\">…</thinking>` block (JSON-tagged so the UI can render); (c) code block content untouched. For channel=slack: assert behaviour matches telegram in v1 (deferred policy = strip until adapter implements sidebar)."
    status: pending
isProject: false
---

# Slice I — Reply Sanitizer (English Reasoning Leak)

## 0. Provenance

| Field | Value |
| --- | --- |
| Sub-plan of | `.cursor/plans/commitment_kernel_v1_release_roadmap.plan.md` (slice I; group 1 of execution order). |
| Inherits | 16 hard invariants from `.cursor/rules/commitment-kernel-invariants.mdc`. Roadmap §6 D5 (defense in depth) and §6 D6 (channel parity: telegram + webchat full E2E). |
| Trigger | Bug B5 from 2026-05-04 19:38–19:42 Telegram session: assistant emitted English meta-prose «Let me check memory for any context about Vladimir's preferences for agents» reaching the user channel. Audit (this plan §2) confirms two contributing factors — (a) Anthropic provider gets NO `<think>` system-prompt hint today (`isReasoningTagProvider` returns false); (b) the existing `outbound-sanitizer.ts` curated list does not include English meta-text patterns. |
| Out of scope | (a) The `webchat` adapter's UI rendering of `<thinking lang="en">…</thinking>` blocks (separate UI roadmap; sanitizer only emits the structured form). (b) Slack/Discord sidebar implementation — sanitizer exposes `policy.reasoning === "deferred"` so adapters can opt in later; v1 ships `strip` semantics for both. (c) Russian meta-text detection (no evidence in B1..B7; if it surfaces later, add to pattern family without architectural change). (d) Detecting reasoning leaks INSIDE `<thinking>` blocks promoted by `promoteThinkingTagsToBlocks` — those are already stripped by `extractAssistantText`. |
| Maintainer signoff | REQUIRED at slice level (per invariant #15). Two checkpoint subsignoffs: Phase 3 (pattern-family curation — false-positive risk requires explicit review of each regex) and Phase 4 (system-prompt addition — affects every Anthropic turn). |

## 1. Hard invariants this slice keeps

- **#5 (text-rule matching on UserPrompt outside whitelist)**: sanitizer operates on **assistant OUTPUT**, never on UserPrompt/RawUserTurn. The existing `outbound-sanitizer.ts` documents this same boundary (header JSDoc lines 21–34); the English-meta-text family inherits the same protection. Reverse-test: assert no new code reads `RawUserTurn` or `UserPrompt`.
- **#6 (IntentContractor sole reader of raw user text)**: untouched. Sanitizer reads only `payload.text` (assistant-emitted). Documented explicitly in §2.4.
- **#8 (`platform/commitment/` does not import from `platform/decision/`)**: untouched — sanitizer lives in `src/infra/outbound/` per the existing module's location, NOT in `platform/commitment/`. New policy module `src/infra/outbound/reply-sanitizer-policy.ts` imports nothing from `platform/`.
- **#11 (5 frozen contracts read-only)**: untouched. Sanitizer post-processes payload text after every commitment-decision boundary has executed.
- **#15 (PR signoff)**: Phase 3 (pattern curation) + Phase 4 (system-prompt change) require named maintainer signoff before commit.

## 2. Audit findings (2026-05-05)

### 2.1. Pipeline (assistant output → channel adapter)

The path from model output to channel send is well-mapped today:

1. **Provider stream** → `pi-coding-agent` emits `assistant_message_chunk`/`assistant_message_end` events via `pi-embedded-subscribe.ts`.
2. **Streaming chunker (Level 1 strip)** — `pi-embedded-subscribe.ts:385–473` `stripBlockTags`: strips `<think>` / `<final>` tags + content-inside-thinking + downgraded tool-call XML + universal tool-call markers. Stateful across stream chunks. Operates on `text_delta` events. Path: `emitBlockChunk` (line 495) → `block-reply-pipeline.enqueue`.
3. **Per-message diagnostic log** — `handlers.messages.ts:354`:
   ```
   [assistant-reply] runId=<8c> lang=<ru|en|other> cyr=<n> lat=<n> head="<120ch>"
   ```
   Today this is **observational only** — `langGuess` is computed but never gates delivery. The log is the only evidence of language-mix per turn; B5 leak is visible here as `lang=en cyr=0 lat=120+`.
4. **Final extraction** — `handlers.messages.ts:339` `extractAssistantText` calls `stripThinkingTagsFromText` (`shared/text/reasoning-tags.ts:19`) in `strict` mode — strips both `<thinking>` tags AND content inside them. Anthropic native `thinking` content blocks are extracted separately by `extractAssistantThinking` (`pi-embedded-utils.ts:306`). However: when Opus emits English meta-prose as **plain `text` content blocks** (not `<thinking>` tags, not `thinking` typed blocks), no strip occurs.
5. **Block reply pipeline** → coalescer → `onBlockReply` callback → `deliverOutboundPayloads` (`infra/outbound/deliver.ts`) → `normalizePayloadsForChannelDelivery` (`deliver.ts:376`).
6. **Existing outbound sanitizer (Level 2 strip)** — `deliver.ts:404` calls `sanitizeOutboundForExternalChannel(beforeText)` for channels in `EXTERNAL_DELIVERY_SURFACES` (telegram/whatsapp/slack/discord/signal/imessage/sms/voice/googlechat — note: `max` and `webchat` are NOT in this set today). Curated list of 16 patterns, none of which match English meta-prose.

### 2.2. Why B5 leaks today

- Opus is configured WITHOUT the `<think>+<final>` strict reasoning-tag system-prompt block. `attempt.ts:2067` `reasoningTagHint = isReasoningTagProvider(params.provider)` — `provider-utils.ts:10` returns `false` for `anthropic*`, only `true` for `google*` and `minimax*`. (Anthropic's reasoning is delivered via native `thinking` content blocks instead, when extended-thinking is enabled.)
- When Opus emits English meta-prose as plain text (no native `thinking` block, no `<thinking>` tag), nothing in the current pipeline strips it. The Level-1 chunker only handles `<think>` / `<final>` / tool-call XML; the Level-2 outbound sanitizer's 16 patterns are diagnostics (`[planner]`, stack traces, tool-error envelopes), not English meta-prose.

### 2.3. Where to insert the fix

- **Prompt-side (Phase 4)**: a NEW `internalReasoningHint` system-prompt section, distinct from `reasoningTagHint`. Triggered when `runtimeChannel ∈ EXTERNAL_DELIVERY_SURFACES` AND `!isReasoningTagProvider(provider)`. Advisory ("wrap in `<thinking>`"), not strict (does not gate output via `<final>` enforcement). The strict path remains reserved for google/minimax which truly need it.
- **Post-filter (Phase 3+5)**: the existing `outbound-sanitizer.ts` is the correct insertion point — it already proves the architectural pattern (curated, line-anchored, code-region-aware patterns at the channel-emission boundary). Extend with an `english_meta_*` pattern family branched on a new per-channel `ReplySanitizerPolicy`. Reuse `OutboundSanitizerStripEvent` telemetry shape.

### 2.4. Channel registry today

`src/channels/ids.ts:4–15` `CHAT_CHANNEL_ORDER` includes telegram, whatsapp, discord, irc, googlechat, slack, signal, imessage, line, max. `INTERNAL_MESSAGE_CHANNEL = "webchat"` is defined separately at `src/utils/message-channel.ts:19` and is NOT a chat channel id (it's an internal gateway concept). `EXTERNAL_DELIVERY_SURFACES` in `outbound-sanitizer.ts:38` includes 9 surfaces but NOT `max` and NOT `webchat`. v1 must add `max` to `EXTERNAL_DELIVERY_SURFACES` (it's a plaintext messenger; reasoning must be stripped) and add `webchat` to a new `REPLY_SANITIZER_SURFACES` superset (reasoning is wrapped, not stripped).

### 2.5. Existing thinking infrastructure

Already present:
- `shared/text/reasoning-tags.ts` — `stripReasoningTagsFromText` (strict + preserve modes).
- `shared/text/assistant-visible-text.ts` — `stripAssistantInternalScaffolding` (preserves `<thinking>` content for non-final-tag providers).
- `pi-embedded-utils.ts:412` — `promoteThinkingTagsToBlocks` (converts inline `<thinking>` text to native typed blocks).
- `pi-embedded-runner/thinking.ts:25` — `dropThinkingBlocks` (used in session sanitization to remove typed `thinking` blocks before re-sending to providers).

These confirm the codebase already treats `<thinking>` as a first-class concept; slice I builds on top, doesn't reinvent.

## 3. Hypothesis

The fix is **two layers, additive**, and re-uses existing primitives:

1. **Prompt-side**: a new `internalReasoningHint` for Anthropic+external-channel turns, advising Opus to wrap meta-thinking in `<thinking>...</thinking>`. Already-existing `stripThinkingTagsFromText` in the extraction path will then handle the wrap automatically; no extra strip logic needed for the `<thinking>`-wrapped case.
2. **Post-filter safety net**: extend `outbound-sanitizer.ts` with an `english_meta_*` pattern family branched on a per-channel `ReplySanitizerPolicy` resolved from `resolveReplySanitizerPolicy(channel)`. The pattern family is line-anchored, code-region-aware (via `findCodeRegions`), and curated to a small set of leading-imperative English verbs that signal meta-thinking. False-positive risk for legitimate English content (code, quotes, identifiers) is mitigated by the line-anchoring + code-block protection + first-line-only scope.

NO sweeping rewrite. Both the sanitizer module and the system-prompt builder already exist and have signoff history; this slice adds one new module + one pattern family + one prompt section.

## 4. Acceptance criteria

1. **Anthropic+external turn includes new system-prompt hint.** Golden snapshot diff shows the `<thinking>` advisory is emitted for `(provider=anthropic, channel=telegram)` and is NOT emitted for `(provider=anthropic, channel=webchat)` or `(provider=google, channel=*)` (google already has the strict `<think>+<final>` block).
2. **Telegram strip semantics.** B5-replay fixture: Russian content delivered verbatim; English meta-prose stripped; code blocks untouched; telemetry `[outbound-sanitizer] event=stripped channel=telegram patterns=[english_meta_let_me*1] …`.
3. **Webchat structured semantics.** Same fixture: English meta-prose wrapped in `<thinking lang="en">…</thinking>` (JSON-tagged form: `lang` attribute, content escaped if it contains `<`/`>`); webchat UI rendering is downstream-only.
4. **Slack/Discord deferred = strip in v1.** Same as telegram for v1; sanitizer surfaces `policy.reasoning === "deferred"` so future adapter work can opt into a sidebar without re-touching this module.
5. **Defense-in-depth audit.** When Opus respects the prompt hint and DOES wrap reasoning in `<thinking>` blocks: the existing `stripThinkingTagsFromText` strips them in `extractAssistantText` (Anthropic+strict) AND in `stripBlockTags` (streaming). Post-filter does not see them at all. When Opus IGNORES the prompt: post-filter catches the leak. Test both paths.
6. **No false-positive on legitimate English.** Reverse-tests: «Here is the code:» followed by `Let me run` inside a fenced block does NOT trigger strip. «Quoting the docs: "Let me check the API"» as a quoted passage on a single line — currently WILL match (false positive accepted, documented in §6); evidence-driven mitigation deferred.
7. **Frozen layer untouched.** No new imports into `src/platform/commitment/`. Reverse-tested via existing import-graph fixture.
8. **Existing 16 patterns still strip on all external surfaces.** Regression test: every existing pattern from `outbound-sanitizer.test.ts` continues to strip identically for telegram/slack/discord; the new policy parameter does not change their behaviour.

## 5. Per-phase tests (must catch real bugs — see AGENTS.md "Tests must catch real bugs")

Each phase's tests must:
- **Fail-first.** Land the test in a separate first commit; assert it fails against current `dev` HEAD (no fix yet); land the fix in a second commit; assert it now passes.
- **No `vi.spyOn` on the function under test.** `sanitizeOutboundForExternalChannel`, `resolveReplySanitizerPolicy`, and the new `internalReasoningHint` formatter are tested with real instances.
- **Negative coverage explicit.** For Phase 3: each pattern has at least one positive case AND one negative case AND one code-block-protected case. For Phase 4: each (provider, channel) cell of the 2×N matrix is asserted (telegram/anthropic includes the hint; webchat/anthropic excludes; telegram/google excludes — already has strict block).
- **Stress test for Phase 6.** A single turn with ≥3 of: Russian prose paragraphs, English meta-text leading sentence, fenced code block, inline code spans, a quoted English string starting with «Let me». Assert the policy yields the right output for telegram (strip non-code English meta) and webchat (wrap non-code English meta).
- **Cross-policy fuzz (Phase 5).** Generate 20 random combinations of (existing-pattern leak + new-pattern leak + clean text) and assert the result is identical to applying patterns sequentially in policy-aware mode.

## 6. Implementation notes

### 6.1. Module layout

- `src/infra/outbound/reply-sanitizer-policy.ts` — NEW. `ReplySanitizerPolicy` type, `resolveReplySanitizerPolicy(channel)`, `REPLY_SANITIZER_SURFACES` (superset of `EXTERNAL_DELIVERY_SURFACES` + `webchat`).
- `src/infra/outbound/outbound-sanitizer.ts` — MODIFIED. New `english_meta_*` pattern family. New `sanitizeOutboundForExternalChannel(text, policy?)` signature with policy-aware branching. Keep old no-arg signature working (defaults to `{ reasoning: "strip" }`) so existing call sites keep passing.
- `src/infra/outbound/deliver.ts` — MODIFIED. `normalizePayloadsForChannelDelivery` resolves policy via `resolveReplySanitizerPolicy(channel)` and gates on `isReplySanitizerSurface(channel)` (broader than `isExternalDeliverySurface`).
- `src/agents/system-prompt.ts` — MODIFIED. New optional `internalReasoningHint?: string` param, new section emitted when present.
- `src/agents/pi-embedded-runner/system-prompt.ts` — MODIFIED. Thread the new param.
- `src/agents/pi-embedded-runner/run/attempt.ts` — MODIFIED. Compute the hint at line ~2067 alongside `reasoningTagHint`. Logic: `internalReasoningHint = !isReasoningTagProvider(provider) && runtimeChannel && isExternalDeliverySurface(runtimeChannel) ? INTERNAL_REASONING_HINT_TEXT : undefined;`.

### 6.2. Pattern family curation (Phase 3 — REQUIRES SIGNOFF)

Each pattern is **line-anchored** (`^…`) on a multi-line/unicode regex (`gmu`), **code-region-protected** (apply `findCodeRegions(text)` before regex matching, skip indices inside code), and limited to **the first non-empty line** of the assistant text (meta-thinking always leads). Initial curated list (subject to evidence-driven extension):

| id | regex (sketch) | example match | example non-match |
| --- | --- | --- | --- |
| `english_meta_let_me` | `^\s*Let me\s+(check|look|search|verify|see)\b` | "Let me check memory for any context" | "Let me know if that works" (negative; "know" not in list) |
| `english_meta_ill_check` | `^\s*I'?ll\s+(check|look|search|verify|see)\b` | "I'll search the registry first" | "I'll be there in 5 minutes" |
| `english_meta_i_should` | `^\s*I should\s+\w+` | "I should verify this first" | "I should think a real user would say…" (false positive accepted; document) |
| `english_meta_first_ill` | `^\s*First,?\s+I'?ll\b` | "First, I'll search memory" | "First, the user said X" |
| `english_meta_lets_check` | `^\s*Let'?s\s+(check|look|verify|see)\b` | "Let's check what's available" | "Let's go to the park" |
| `english_meta_looking_at` | `^\s*Looking at\s+\w+` | "Looking at the previous turn" | (no obvious false positive) |
| `english_meta_checking` | `^\s*Checking\s+(memory|context|the|for)\b` | "Checking memory for prefs" | "Checking out tomorrow" |

False-positive policy: a curated regex MUST NOT trigger on `[a-z]\.\s+Let me…` (i.e. mid-paragraph), MUST NOT trigger inside fenced code (`findCodeRegions`), MUST NOT trigger inside inline code (`buildCodeSpanIndex` reused if available; otherwise document as known gap and accept). Each new addition requires evidence in a gateway log entry attached to the maintainer signoff request.

### 6.3. Policy-aware sanitizer flow

```
input: payload.text, channel
1. policy = resolveReplySanitizerPolicy(channel)
2. if not isReplySanitizerSurface(channel): return text (no-op)
3. for each existing pattern in OUTBOUND_LEAK_PATTERNS: apply unchanged (always strip)
4. for each english_meta_* pattern:
   - if policy.reasoning === "strip" or "deferred": apply as kind=strip
   - if policy.reasoning === "structured": replace match's containing line with
     `<thinking lang="en">{escaped_line}</thinking>`
5. collapse blank lines, trim trailing whitespace (existing logic)
6. return { text, stripped: events }
```

### 6.4. System-prompt hint text (Phase 4)

```
## Internal Reasoning Format
If you have any internal reasoning, planning, or English meta-thinking like
"Let me check…" / "I'll search…" / "First, I'll…", wrap it in
<thinking>...</thinking> blocks. ONLY user-facing reply text in the user's
language goes outside <thinking> blocks. The user will not see anything inside
<thinking>.
```

This is **advisory only** — does not gate output via a `<final>` requirement (that path is reserved for google/minimax via `reasoningTagHint`). Anthropic with extended-thinking enabled will continue to use native `thinking` content blocks; the hint covers the case where Opus emits English meta-prose as plain text without a native thinking block.

### 6.5. Defense-in-depth verification

When **both** layers are active, three scenarios:

- **A. Opus respects hint.** Output is `<thinking>Let me check…</thinking>Привет!`. `extractAssistantText` strips the thinking block; post-filter sees only "Привет!"; nothing to strip; clean delivery.
- **B. Opus ignores hint, emits raw English meta.** `extractAssistantText` returns "Let me check… Привет!"; post-filter matches `english_meta_let_me`, strips the leading sentence; user sees "Привет!" with optional collapse-of-empty-line. Telemetry fires.
- **C. Opus emits both — `<thinking>X</thinking>Let me also Y. Привет!`** Strip handles inner; post-filter handles trailing English meta. Clean delivery.

Tests assert each scenario.

### 6.6. False-positive acceptance

Two known false-positive shapes documented:
1. A user-quoted English passage where the quote starts with one of the imperative verbs at line start (e.g., user pastes a tutorial that begins «Let me check the docs:» and asks the bot to translate). v1 will strip this. Mitigation: bot is instructed to wrap quoted content in code blocks or inline code (existing channel formatting guidance); plus bot's own reply rarely echoes the verbatim leading line of a user quote.
2. A bot reply in English (rare but possible — user explicitly asked for English). The cyr/lat ratio at `handlers.messages.ts:354` is observational; we do NOT gate on it (would create false negatives when content is mostly Cyrillic with English code identifiers). Pattern family is curated to imperative meta-thinking leading the first line, not generic English. Accepted residual risk — surface in telemetry, address with evidence.

## 7. Handoff Log

### 2026-05-04 — Sub-plan kickoff

- Sub-plan written. Phase 1 (read-only audit) is the first action. No code-touching phase begins without slice-level signoff per invariant #15.
- Audit (this plan §2) confirms two distinct insertion points: prompt-side at `system-prompt.ts:602` (after the existing `reasoningHint` block); post-filter at `outbound-sanitizer.ts:98` (extending `OUTBOUND_LEAK_PATTERNS`) and at `deliver.ts:404` (passing the new policy).
- `webchat` is NOT in `EXTERNAL_DELIVERY_SURFACES` today; slice I introduces a broader `REPLY_SANITIZER_SURFACES` that includes it for the `structured` policy path. Existing 16 patterns continue to apply only on `EXTERNAL_DELIVERY_SURFACES` (no behaviour change for webchat on those).
- `max` is in `CHAT_CHANNEL_ORDER` but NOT in `EXTERNAL_DELIVERY_SURFACES`; slice I adds it (per roadmap §6 D5: max gets `strip` semantics).
- Predecessor: none in roadmap §3 group 1 (slice I is independent of D and E).
- Branch (TBD): `feat/v1-slice-i-reply-sanitizer-en-leak`.

### 2026-05-05 — Phase 1 audit landed (PR #152, merge SHA `714c907d6b94615bc757aa2a02e8d2d06fa1d50b`)

- Phase 1 (READ-ONLY) audit verified all five §2 sketch areas against `dev` HEAD `d8e51cdc0a`. Audit doc landed at `extensions/AUDIT-reply-sanitizer.md`. Branch: `audit/v1-slice-i-reply-sanitizer-phase-1`.
- Pipeline trace verified: `stripBlockTags` at `pi-embedded-subscribe.ts:385–473`; `handleMessageEnd` at `handlers.messages.ts:322`; diagnostic log expression at `handlers.messages.ts:353–355` (template body on line 354 — exact match with §2); `extractAssistantText` at `pi-embedded-utils.ts:284`; `stripThinkingTagsFromText` strict-mode at `pi-embedded-utils.ts:280`; `normalizePayloadsForChannelDelivery` at `deliver.ts:376` with sanitizer call at `deliver.ts:406` and gate at `deliver.ts:404`.
- B5 root cause confirmed: (a) `isReasoningTagProvider` (`provider-utils.ts:10`) returns true only for `google*` and substring `minimax`; Anthropic returns false. `attempt.ts:2067` threads this into `buildEmbeddedSystemPrompt:2138`. (b) The 16 patterns in `OUTBOUND_LEAK_PATTERNS` (`outbound-sanitizer.ts:98–189`) match only diagnostics / tool-call markup, not English imperative meta-prose. Pattern ids verified: `tool_error_marker`, `tool_error_envelope`, `task_classifier_marker`, `planner_marker`, `provenance_guard_marker`, `subagent_aggregation_marker`, `intent_ledger_marker`, `debug_marker`, `node_stack_trace`, `node_error_path`, `universal_tool_call_xml`, `universal_tool_use_xml`, `universal_function_call_xml`, `universal_tool_call_json_envelope`, `universal_tool_call_orphan_open`, `universal_tool_call_orphan_close`.
- Channel registry confirmed: `EXTERNAL_DELIVERY_SURFACES` (9 members at `outbound-sanitizer.ts:38–52`) does NOT contain `webchat` or `max`; `INTERNAL_MESSAGE_CHANNEL = "webchat"` lives at `message-channel.ts:19`; `max` is at `channels/ids.ts:14`.
- Existing thinking helpers all present: `stripReasoningTagsFromText` (`reasoning-tags.ts:19`), `stripThinkingTagsFromText` (`pi-embedded-utils.ts:280`), `extractAssistantText` (`:284`), `extractAssistantThinking` (`:306`), `splitThinkingTaggedText` (`:345`), `promoteThinkingTagsToBlocks` (`:412`), `extractThinkingFromTaggedText` (`:459`), `dropThinkingBlocks` (`thinking.ts:25`), `stripAssistantInternalScaffolding` (`assistant-visible-text.ts:44`).
- Three new findings affect Phase 2+ (full detail in `extensions/AUDIT-reply-sanitizer.md` §6):
  1. `irc` channel is in `CHAT_CHANNEL_ORDER` (`channels/ids.ts:8`) but absent from `EXTERNAL_DELIVERY_SURFACES`; Phase 2 should add explicit policy mapping (likely `strip` by analogy with `telegram` / `max`).
  2. The Phase 2 channel-id space the policy resolver must cover is the union of `CHAT_CHANNEL_ORDER` ∪ `EXTERNAL_DELIVERY_SURFACE_LIST` ∪ `{INTERNAL_MESSAGE_CHANNEL}` — `voice` and `sms` exist as outbound surfaces but not as chat channel ids.
  3. `extractThinkingFromTaggedText` (`pi-embedded-utils.ts:459`) is a reusable primitive for the `policy.reasoning === "structured"` webchat wrap; reference it in Phase 3 design notes to avoid double-wrapping when the model already emitted tagged thinking.
- No code under `src/` was modified. Phase 1 frontmatter status set to `completed`. Next: Phase 2 (`reply-sanitizer-policy.ts` types + resolver) requires slice-level maintainer signoff per invariant #15 before code-touching phases begin.

### 2026-05-05 — Phase 2 landed (PR #157)

- Phase 2 `i-phase-2-channel-policy-types` shipped.
- PR: https://github.com/Primus-max/god-mode-core/pull/157
- Squash-merge SHA on `dev`: `6dcba2258e7c5fdd2c964724962273d14248d7d2`.
- Files added (no production code modified):
  - `src/infra/outbound/reply-sanitizer-policy.ts` (+148) — NEW. `ReplySanitizerPolicy = { reasoning: "strip" | "structured" | "deferred" }`, frozen-singleton `resolveReplySanitizerPolicy(channel)`, predicate `isReplySanitizerSurface`, superset `REPLY_SANITIZER_SURFACES` covering `CHAT_CHANNEL_ORDER` ∪ `EXTERNAL_DELIVERY_SURFACE_LIST` ∪ `{INTERNAL_MESSAGE_CHANNEL}` per Phase 1 audit §6.1+§6.2 (`irc`, `max`, `voice`, `sms`, `webchat` named explicitly).
  - `src/infra/outbound/reply-sanitizer-policy.test.ts` (+131) — 26 cases over 3 describe blocks (resolver mappings, surface inventory, predicate). Fail-first verified.
- Mapping: telegram/whatsapp/signal/imessage/googlechat/line/irc/max/voice/sms → `strip`; webchat → `structured`; slack/discord → `deferred`. Unknown channel → `strip` (defense-against-leak default — MUST NEVER default to `structured`, which would leak reasoning to plaintext).
- Gate: `pnpm tsgo` 0 errors in slice; `pnpm vitest run src/infra/outbound/reply-sanitizer-policy.test.ts` 26/26 pass; no `vi.spyOn` on the function under test.
- Invariant audit: #5/#6/#8/#11/#15 reverse-tested (no `RawUserTurn` / `UserPrompt` / `src/platform/` import in the new module; frozen contracts untouched).
- Auto-merge note: admin-squashed via `gh pr merge 157 --admin --squash --delete-branch` per Vladimir's standing delegation. No call-site wiring yet — Phase 5 will wire `deliver.ts:404`.
- Phase 3 (english-meta pattern family) requires explicit maintainer signoff per sub-plan §0 todo + §6.2 ("REQUIRES SIGNOFF") before commit. Phase 4 (system-prompt addition) similarly gated.

## 8. Adjacent / deferred (out of scope)

| Item | Why deferred |
| --- | --- |
| Webchat UI rendering of `<thinking lang="en">…</thinking>` blocks | Frontend roadmap; sanitizer only emits the structured form. |
| Slack/Discord sidebar/thread rendering of stripped reasoning | Adapter-side feature; sanitizer surfaces `policy.reasoning === "deferred"` for opt-in. |
| Russian-language meta-text detection | No B1..B7 evidence today. If it surfaces, extend pattern family without architectural change. |
| Promoting cyr/lat ratio (`handlers.messages.ts:354`) from log to gate | False-negative risk on Cyrillic-heavy replies with English code identifiers. v1 keeps it observational. |
| Auto-promotion of plain-text English meta into a synthetic `<thinking>` block at extraction time | Architecturally cleaner but invasive (`extractAssistantText` is in the hot path). Defer; defense-in-depth via post-filter is sufficient for v1. |
| `tool-error-sanitizer.ts` Level-2 tightening (mentioned in `commitment_kernel_outbound_sanitizer.plan.md`) | Out of scope for B5; tracked separately. |

## 9. References

- Roadmap: `.cursor/plans/commitment_kernel_v1_release_roadmap.plan.md` (slice I row in §3; D5 + D6 in §6).
- Sibling sub-plan: `.cursor/plans/commitment_kernel_outbound_sanitizer.plan.md` (Bug E — establishes the outbound-sanitizer architectural pattern that slice I extends).
- Sibling sub-plan: `.cursor/plans/commitment_kernel_streaming_leak.plan.md` (Bug A — Level-1 streaming chunker `stripBlockTags` in `pi-embedded-subscribe.ts`).
- Hard invariants: `.cursor/rules/commitment-kernel-invariants.mdc`.
- Existing modules touched: `src/infra/outbound/outbound-sanitizer.ts`, `src/infra/outbound/deliver.ts`, `src/agents/system-prompt.ts`, `src/agents/pi-embedded-runner/run/attempt.ts`, `src/agents/pi-embedded-runner/system-prompt.ts`.
- Existing thinking primitives (re-used, not duplicated): `src/shared/text/reasoning-tags.ts`, `src/shared/text/assistant-visible-text.ts`, `src/agents/pi-embedded-utils.ts` (`extractAssistantThinking`, `promoteThinkingTagsToBlocks`, `splitThinkingTaggedText`).
- Diagnostic log baseline: `src/agents/pi-embedded-subscribe.handlers.messages.ts:354` `[assistant-reply] runId=… lang=… cyr=… lat=…`.
- Provider check: `src/utils/provider-utils.ts:10` `isReasoningTagProvider` (returns false for Anthropic — root contributor to B5).
- Channel registry: `src/channels/ids.ts`, `src/utils/message-channel.ts` (`INTERNAL_MESSAGE_CHANNEL = "webchat"`).
- Live evidence baseline: B5 from 2026-05-04 19:38–19:42 Telegram transcript provided by Vladimir.
