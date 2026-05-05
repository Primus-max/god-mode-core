# Slice I — Reply Sanitizer Phase 1 Audit (READ-ONLY)

Branch: `audit/v1-slice-i-reply-sanitizer-phase-1`
Base SHA: `dev` HEAD at audit time (`d8e51cdc0a fix(orchestrator): also drop web_fetch from tool catalog on web_search signal (#144)`).

This document VERIFIES the §2 audit sketch in
`.cursor/plans/commitment_kernel_reply_sanitizer.plan.md` against live source.
No code was executed. No source under `src/` or any sanitizer / system-prompt
file was modified. Findings are line-anchored to current `dev` HEAD.

Hard invariants kept by Phase 1: #5 (no text matching on `UserPrompt`), #6
(`IntentContractor` sole reader of raw user text), #11 (5 frozen contracts
read-only), #15 (signoff is required for code-touching phases — Phase 1 is
read-only and does not need it; Phases 3 and 4 do).

---

## 1. Pipeline trace (assistant output → channel adapter)

The chain on current `dev` HEAD, with each step verified.

### 1.1. Provider stream → assistant events

`pi-coding-agent` emits `assistant_message_chunk` and
`assistant_message_end` events that flow through
`src/agents/pi-embedded-subscribe.ts`. The streaming chunker is the
Level-1 strip.

### 1.2. Level-1 streaming chunker — `stripBlockTags`

File: `src/agents/pi-embedded-subscribe.ts`.

- `stripBlockTags(text, state)` is defined at lines 385–473. The signature
  matches the §2 sketch (`{ thinking, final, inlineCode? }` state).
- Step 1 (lines 396–416): handles `<think>` (and `<thinking>` / `<thought>` /
  `<antthinking>`) start/close tags via `THINKING_TAG_SCAN_RE`, stateful
  across chunks, content INSIDE `<think>` blocks is stripped together with
  the tags. `buildCodeSpanIndex` (line 394) protects inline code spans.
- Step 2 (lines 418–472): handles `<final>` blocks. Two sub-modes:
  - When `params.enforceFinalTag` is false (line 423): strip the `<final>`
    tags themselves but pass content through (`stripTagsOutsideCodeSpans`,
    line 426). This is the Anthropic / Opus path today — no enforcement.
  - When enforcement is enabled (line 429+): only content INSIDE `<final>` is
    returned; everything else is dropped. Strict-mode short-circuit at line
    464 returns `""` if no `<final>` was ever seen. Reserved for
    google / minimax via `reasoningTagHint`.
- The chunker is invoked in `emitBlockChunk` at line 495 and called again
  from `handleMessageEnd` at `pi-embedded-subscribe.handlers.messages.ts:359`
  for the final extraction.

Verified: matches §2 sketch (Bullet 2). The chunker recognizes
`<think>` / `<thinking>` / `<thought>` / `<antthinking>` tags but it does NOT
recognize generic English meta-prose. Tool-call XML tags
(`<tool_call>` / `<tool_use>` / `<function_call>`) are stripped earlier by
`stripUniversalToolCallMarkup` (called inside `extractAssistantText`,
`pi-embedded-utils.ts:290`).

### 1.3. Per-message diagnostic log — `[assistant-reply] …`

File: `src/agents/pi-embedded-subscribe.handlers.messages.ts`.

- `handleMessageEnd` is exported at line 322.
- Promotes inline `<thinking>` text to typed thinking blocks via
  `promoteThinkingTagsToBlocks(assistantMessage)` at line 337.
- Calls `extractAssistantText(assistantMessage)` at line 339 (this calls
  `stripThinkingTagsFromText` strictly — see §1.4).
- The diagnostic log line is at lines 348–356:
  ```ts
  if (rawText) {
    const headSample = rawText.replace(/\s+/g, " ").trim().slice(0, 120).replace(/"/g, "'");
    const cyrillic = (rawText.match(/[Ѐ-ӿ]/g) ?? []).length;
    const latin = (rawText.match(/[A-Za-z]/g) ?? []).length;
    const langGuess = cyrillic > latin ? "ru" : latin > 0 ? "en" : "other";
    defaultRuntime.log(
      `[assistant-reply] runId=${...} lang=${langGuess} cyr=${...} lat=${...} head="${headSample}"`,
    );
  }
  ```
  The exact `defaultRuntime.log(...)` call is at line 353 with the template
  string body on line 354. `langGuess` is computed but NEVER read by any
  downstream gate; it is observational, exactly as §2 claims.

Deviation vs §2 sketch: §2 places the log at line 354. The actual log
expression spans lines 353–355, with the template string itself on line 354.
Sub-plan §2 callout `handlers.messages.ts:354` is consistent — the log
template string is on that line.

### 1.4. `extractAssistantText` + `stripThinkingTagsFromText` (strict)

File: `src/agents/pi-embedded-utils.ts`.

- `stripThinkingTagsFromText` is exported at line 280; it delegates to
  `stripReasoningTagsFromText(text, { mode: "strict", trim: "both" })`
  (file `src/shared/text/reasoning-tags.ts:19`). In strict mode, BOTH the
  `<thinking>` (and `<think>` / `<thought>` / `<antthinking>`) tags AND the
  content inside them are removed. `<final>` tags are also stripped (line
  37+ of `reasoning-tags.ts`).
- `extractAssistantText` is exported at line 284. It composes the strip
  chain (line 287–294):
  ```ts
  stripThinkingTagsFromText(
    stripDowngradedToolCallText(
      stripUniversalToolCallMarkup(
        stripModelSpecialTokens(stripMinimaxToolCallXml(text)),
      ),
    ),
  ).trim()
  ```
  Order: minimax tool-call XML → model special tokens → universal tool-call
  markup → downgraded tool-call text → thinking tags last.
- `extractAssistantThinking` is at line 306; it pulls structured
  `type: "thinking"` blocks out of the assistant message content array (the
  Anthropic native extended-thinking path), distinct from inline
  `<thinking>` tags.

Verified: matches §2 sketch. Anthropic English meta-prose emitted as plain
`text` blocks (no `<thinking>` tags, no native typed `thinking` block) is NOT
stripped here.

### 1.5. Block reply pipeline → outbound delivery

File: `src/infra/outbound/deliver.ts`.

- `normalizePayloadsForChannelDelivery` is at line 376.
- The outbound sanitizer call is at line 406:
  ```ts
  const sanitizationResult = sanitizeOutboundForExternalChannel(beforeText);
  ```
- The gate at line 404 tests `isExternalDeliverySurface(channel)` (computed
  at line 383) AND `sanitizedPayload.text` is non-empty. The HTML strip
  (`isPlainTextSurface`, line 389) runs BEFORE the outbound sanitizer at
  line 406, so the sanitizer sees post-HTML-strip text.
- Telemetry is emitted via `formatOutboundSanitizerLog` at line 411.
- Imports at lines 47–52 confirm `sanitizeOutboundForExternalChannel` and
  `isExternalDeliverySurface` come from `./outbound-sanitizer.js`.

`deliverOutboundPayloads` (the public delivery entry point) is at line 577;
it forwards into `deliverOutboundPayloadsCore` at line 691, which calls
`normalizePayloadsForChannelDelivery` at line 770. So the call chain is:

```
auto-reply / agent-runner
  → block-reply-pipeline (src/auto-reply/reply/block-reply-pipeline.ts)
  → coalescer
  → onBlockReply callback
  → deliverOutboundPayloads               (deliver.ts:577)
  → deliverOutboundPayloadsCore           (deliver.ts:691)
  → normalizePayloadsForChannelDelivery   (deliver.ts:376)
  → sanitizeOutboundForExternalChannel    (deliver.ts:406)
  → channel adapter (handler.normalizePayload at deliver.ts:421)
```

Verified: matches §2 sketch (Bullets 5–6).

---

## 2. Why B5 leaks today

### 2.1. Factor (a) — Anthropic gets no `<think>+<final>` system-prompt hint

File: `src/utils/provider-utils.ts`, `isReasoningTagProvider`.

```ts
// Lines 10–35
export function isReasoningTagProvider(provider: string | undefined | null): boolean {
  if (!provider) {
    return false;
  }
  const normalized = provider.trim().toLowerCase();
  if (
    normalized === "google" ||
    normalized === "google-gemini-cli" ||
    normalized === "google-generative-ai"
  ) {
    return true;
  }
  if (normalized.includes("minimax")) {
    return true;
  }
  return false;
}
```

Verified: returns `true` ONLY for `google` / `google-gemini-cli` /
`google-generative-ai` and any provider name containing `minimax`. Anthropic
returns `false`.

Consumer at `src/agents/pi-embedded-runner/run/attempt.ts:2067`:

```ts
const reasoningTagHint = isReasoningTagProvider(params.provider);
```

Threaded into `buildEmbeddedSystemPrompt` at line 2138. The hint then
becomes the `## Reasoning Format` section in `src/agents/system-prompt.ts`
(line 602) only when `reasoningHint` is truthy. The hint text itself is
constructed at lines 342–353 of `system-prompt.ts`:

```ts
const reasoningHint = params.reasoningTagHint
  ? [
      "ALL internal reasoning MUST be inside <think>...</think>.",
      "Do not output any analysis outside <think>.",
      "Format every reply as <think>...</think> then <final>...</final>, with no other text.",
      ...
    ].join(" ")
  : undefined;
```

Verified: Opus / Anthropic does NOT receive this hint. There is currently no
`internalReasoningHint` (advisory, non-strict) section either.

### 2.2. Factor (b) — `OUTBOUND_LEAK_PATTERNS` does not match English meta-prose

File: `src/infra/outbound/outbound-sanitizer.ts`, lines 98–189.

The 16 patterns currently in `OUTBOUND_LEAK_PATTERNS`:

| # | id | shape |
|---|----|-------|
| 1 | `tool_error_marker` | `^[ \t]*\[tools\][ \t]+\S+[ \t]+failed:.*$` (line marker, gmu) |
| 2 | `tool_error_envelope` | `{"status":"error","tool":"…","error":"…"}` JSON envelope |
| 3 | `task_classifier_marker` | `^[ \t]*\[task-classifier\][^\n]*$` |
| 4 | `planner_marker` | `^[ \t]*\[planner\][^\n]*$` |
| 5 | `provenance_guard_marker` | `^[ \t]*\[provenance-guard\][^\n]*$` |
| 6 | `subagent_aggregation_marker` | `^[ \t]*\[subagent-aggregation\][^\n]*$` |
| 7 | `intent_ledger_marker` | `^[ \t]*\[intent-ledger\][^\n]*$` |
| 8 | `debug_marker` | `^[ \t]*\[DEBUG[^\]]*\][^\n]*$` |
| 9 | `node_stack_trace` | `^[ \t]*at[ \t]+\S+[ \t]+\([^()\n]+:\d+:\d+\)[ \t]*$` |
| 10 | `node_error_path` | `[ \t]+at[ \t]+(?:async[ \t]+)?\S+[ \t]+\(file:///[^)\s]+\)` |
| 11 | `universal_tool_call_xml` | `<tool_call …>…</tool_call>` |
| 12 | `universal_tool_use_xml` | `<tool_use …>…</tool_use>` |
| 13 | `universal_function_call_xml` | `<function_call …>…</function_call>` |
| 14 | `universal_tool_call_json_envelope` | `{"name":"…","arguments":{…}}` (depth ≤ 1) |
| 15 | `universal_tool_call_orphan_open` | `<(?:tool_call|tool_use|function_call) …>` |
| 16 | `universal_tool_call_orphan_close` | `</(?:tool_call|tool_use|function_call) >` |

None of these match the B5 leak shape «Let me check memory for any context
about Vladimir's preferences». They are diagnostics / tool-call markup,
not English imperative meta-prose.

Verified both factors. B5 leaks because:

- Opus is not asked to wrap reasoning in `<thinking>` (factor a), so it
  emits English meta-prose in plain `text` content blocks.
- The 16-pattern post-filter does not recognize plain English imperatives
  (factor b), so the leak passes through `sanitizeOutboundForExternalChannel`
  unchanged to the telegram adapter.

---

## 3. Channel registry today

### 3.1. `EXTERNAL_DELIVERY_SURFACES`

File: `src/infra/outbound/outbound-sanitizer.ts`, lines 38–52.

```ts
const EXTERNAL_DELIVERY_SURFACE_LIST = [
  "telegram",
  "signal",
  "whatsapp",
  "slack",
  "discord",
  "sms",
  "voice",
  "imessage",
  "googlechat",
] as const;
```

- 9 members. Helper `isExternalDeliverySurface(channel)` at line 55.
- Verified: `webchat` is NOT in the set. `max` is NOT in the set.
- §2.4 sketch claim that the set has «9 surfaces but NOT `max` and NOT
  `webchat`» is exact.

### 3.2. `webchat` as `INTERNAL_MESSAGE_CHANNEL`

File: `src/utils/message-channel.ts`, line 19:

```ts
export const INTERNAL_MESSAGE_CHANNEL = "webchat" as const;
```

`isInternalMessageChannel` is exported at line 45. `webchat` is NOT a
`ChatChannelId` and NOT in `CHAT_CHANNEL_ORDER`. It is included in
`MARKDOWN_CAPABLE_CHANNELS` (line 22, line 29) and in
`listGatewayMessageChannels()` (line 87).

### 3.3. `max` is in `CHAT_CHANNEL_ORDER` but not external delivery

File: `src/channels/ids.ts`, lines 4–15:

```ts
export const CHAT_CHANNEL_ORDER = [
  "telegram",
  "whatsapp",
  "discord",
  "irc",
  "googlechat",
  "slack",
  "signal",
  "imessage",
  "line",
  "max",
] as const;
```

Verified: `max` is the 10th member of `CHAT_CHANNEL_ORDER` and absent from
`EXTERNAL_DELIVERY_SURFACE_LIST`. Slice I Phase 5 / 6 plans to add it.

Note (drift since §2 sketch was written): the §2.4 wording «`CHAT_CHANNEL_ORDER`
includes telegram, whatsapp, discord, irc, googlechat, slack, signal, imessage,
line, max» matches exactly — no drift. `irc` is also in `CHAT_CHANNEL_ORDER`
and is absent from `EXTERNAL_DELIVERY_SURFACE_LIST` — the sub-plan does not
mention `irc`; flagged below in §5 as a NEW finding.

---

## 4. Existing thinking infrastructure

All helpers referenced by §2.5 are present today.

| Helper | File / line | Mode / role |
|---|---|---|
| `stripReasoningTagsFromText` | `src/shared/text/reasoning-tags.ts:19` | `mode: "strict" \| "preserve"`, `trim: "none" \| "start" \| "both"`. Strips `<think>`, `<thinking>`, `<thought>`, `<antthinking>`, `<final>` tags. Code-region aware via `findCodeRegions`. |
| `stripThinkingTagsFromText` | `src/agents/pi-embedded-utils.ts:280` | Convenience wrapper over `stripReasoningTagsFromText` with strict + both. |
| `extractAssistantText` | `src/agents/pi-embedded-utils.ts:284` | Walks `msg.content` and applies the strip stack ending in `stripThinkingTagsFromText` (strict). |
| `extractAssistantThinking` | `src/agents/pi-embedded-utils.ts:306` | Pulls native `type: "thinking"` typed blocks (Anthropic extended-thinking path). |
| `splitThinkingTaggedText` | `src/agents/pi-embedded-utils.ts:345` | Splits a string starting with `<think>` into `{type:"thinking"}\|{type:"text"}` blocks. Used by `promoteThinkingTagsToBlocks`. |
| `promoteThinkingTagsToBlocks` | `src/agents/pi-embedded-utils.ts:412` | Mutates an `AssistantMessage` to convert inline `<thinking>` text into typed `thinking` blocks. Called from `handleMessageEnd:337`. |
| `extractThinkingFromTaggedText` | `src/agents/pi-embedded-utils.ts:459` | Extracts only the thinking parts as a string (used at `handlers.messages.ts:364` when reasoning streaming is on). |
| `dropThinkingBlocks` | `src/agents/pi-embedded-runner/thinking.ts:25` | Removes typed `thinking` blocks from message arrays before re-sending to providers. |
| `stripAssistantInternalScaffolding` | `src/shared/text/assistant-visible-text.ts:44` | `mode: "preserve"` strip + relevant-memory tag strip. Used by `gateway/server-methods/chat.ts` and `extensions/imessage/src/monitor/sanitize-outbound.ts`. |

Verified: §2.5 sketch is complete; one extra helper (`extractThinkingFromTaggedText`)
not enumerated in §2.5 is also present and is invoked at the same site that
generates the diagnostic log. Listed here for completeness.

---

## 5. Deviations from §2 sketch / drift since sub-plan was written

The §2 sketch is accurate. Differences are minor and listed for the record
so Phase 2+ can rely on exact line numbers.

| # | Sub-plan §2 claim | Actual code | Severity |
|---|---|---|---|
| D-1 | «Level 1 streaming chunker, line ~385» | `stripBlockTags` is at lines 385–473 in `pi-embedded-subscribe.ts`. Exact. | none |
| D-2 | «`handlers.messages.ts:322` `handleMessageEnd`» | `export function handleMessageEnd` is at line 322. Exact. | none |
| D-3 | «log line at line 354» | `defaultRuntime.log(` call site is at line 353; the template string body is on line 354. Effectively equivalent — the §2 reference identifies the right log line. | none (informational) |
| D-4 | «`extractAssistantText` calls `stripThinkingTagsFromText` strictly» | Verified `pi-embedded-utils.ts:288` — strict mode with `trim: "both"`. The `stripThinkingTagsFromText` wrapper (line 280) hardcodes strict; cannot be relaxed by callers. Exact. | none |
| D-5 | «`deliver.ts:376` `normalizePayloadsForChannelDelivery`, current outbound sanitizer at line 404» | `normalizePayloadsForChannelDelivery` declared at line 376; the gate `if (isExternal && sanitizedPayload.text)` is at line 404 and the call to `sanitizeOutboundForExternalChannel` is at line 406. The gate is on line 404 as the sub-plan says; the actual call is line 406. | none (informational) |
| D-6 | «`attempt.ts:2067` `reasoningTagHint = isReasoningTagProvider(params.provider)`» | Exact match at line 2067. Threaded through `buildEmbeddedSystemPrompt` at line 2138. | none |
| D-7 | «`outbound-sanitizer.ts:98` extending `OUTBOUND_LEAK_PATTERNS`» | The list literal `OUTBOUND_LEAK_PATTERNS: readonly LeakPattern[] = [` is at line 98 of `outbound-sanitizer.ts`. Exact. | none |
| D-8 | «provider-utils.ts:10 `isReasoningTagProvider`» | The exported function declaration is at line 10. Exact. | none |
| D-9 | «`channels/ids.ts:4–15` `CHAT_CHANNEL_ORDER`» | Exact. 10 members. | none |
| D-10 | §2.4 enumerates the 10 members of `CHAT_CHANNEL_ORDER` but does NOT mention `irc` when listing channels absent from `EXTERNAL_DELIVERY_SURFACES`. | `irc` is in `CHAT_CHANNEL_ORDER` (line 8) and NOT in `EXTERNAL_DELIVERY_SURFACE_LIST`. Phase 5 / 6 should consider whether `irc` deserves a sanitizer policy alongside `max`. | informational (NEW finding — see §6) |
| D-11 | §2.5 lists 4 thinking helpers. | A 5th helper (`extractThinkingFromTaggedText`) is also live at `pi-embedded-utils.ts:459` and is exercised at `handlers.messages.ts:364`. Useful when designing structured-policy webchat output: it already separates thinking text out of a tagged block. | informational |

No source files diverge from §2 in a way that invalidates Phase 2+ plans.
Sub-plan §6.1 module layout, §6.2 pattern family curation, §6.3 policy-aware
flow, §6.4 system-prompt hint text, and §6.5 defense-in-depth verification
all remain implementable as written.

---

## 6. New findings not in §2 sketch (affect Phase 2+)

### 6.1. `irc` channel is absent from `EXTERNAL_DELIVERY_SURFACES`

`irc` is the 4th member of `CHAT_CHANNEL_ORDER` (`src/channels/ids.ts:8`) and
is NOT a member of `EXTERNAL_DELIVERY_SURFACE_LIST`. Like `max`, it is a
plaintext messenger that should strip reasoning. Phase 2 (`reply-sanitizer-policy.ts`)
should decide:

- Map `irc` to `policy.reasoning = "strip"` (by analogy with `telegram`).
- Either add `irc` to `EXTERNAL_DELIVERY_SURFACES` (parallel to the planned
  `max` addition) or keep `EXTERNAL_DELIVERY_SURFACES` minimal and rely on
  the new `REPLY_SANITIZER_SURFACES` superset to cover it.

This is not a blocker for Phase 2, but it should be called out in the
maintainer signoff for Phase 5 because it expands the channel mapping
beyond what §2.4 anticipated.

### 6.2. `EXTERNAL_DELIVERY_SURFACE_LIST` already contains `voice` / `sms`

`voice` and `sms` are NOT in `CHAT_CHANNEL_ORDER` (they are pseudo-channels
that route through other adapters). They ARE in
`EXTERNAL_DELIVERY_SURFACE_LIST` (lines 44–46). The sanitizer policy
resolver in Phase 2 must handle channel ids that exist as outbound surfaces
but not as chat channel ids. The §2.4 sketch only enumerates chat channel
ids; the channel-id space the policy must cover is the union of
`CHAT_CHANNEL_ORDER` ∪ `EXTERNAL_DELIVERY_SURFACE_LIST` ∪
`{INTERNAL_MESSAGE_CHANNEL}`.

### 6.3. `extractThinkingFromTaggedText` is a useful primitive for Phase 3

For the `policy.reasoning === "structured"` path on `webchat`, a
line-by-line meta-text wrapper can reuse `extractThinkingFromTaggedText`
(`pi-embedded-utils.ts:459`) when the model emits a mixed-tagged turn.
Worth referencing in Phase 3 / Phase 5 design notes so the structured wrap
does not double-emit `<thinking lang="en">` blocks around content the model
already wrapped.

### 6.4. Diagnostic log shape is stable

The `[assistant-reply] runId=… lang=… cyr=… lat=… head="…"` log at
`handlers.messages.ts:353–355` is the only language signal today. Phase 6
acceptance will read this log entry to demonstrate the B5 fixture; the log
shape MUST remain stable through Phase 5 (no regression in `cyr=` /
`lat=` / `head=` fields) so the live-verifier can keep parsing it. Slice I
does not modify this log.

---

## 7. Summary

All five sketch areas in §2 of `commitment_kernel_reply_sanitizer.plan.md`
are verified against `dev` HEAD. Line numbers in §2 are accurate to within
±2 lines of actual call sites. The two factors driving B5
(`isReasoningTagProvider` returns false for Anthropic; the 16 existing
patterns do not match English imperative meta-prose) are confirmed. The
channel registry shape — `webchat` as `INTERNAL_MESSAGE_CHANNEL`, `max` and
`irc` in `CHAT_CHANNEL_ORDER` but not in `EXTERNAL_DELIVERY_SURFACES` — is
confirmed.

Three new findings affect Phase 2+:

1. `irc` channel needs an explicit policy decision (added to §6.1 above).
2. The Phase 2 channel-id space is the union of three sets, not just
   `CHAT_CHANNEL_ORDER` (added to §6.2).
3. `extractThinkingFromTaggedText` is an additional reusable primitive for
   the structured-policy wrap (added to §6.3).

No code changes were made. All cited paths are repository-root relative.

---

## References

- `.cursor/plans/commitment_kernel_reply_sanitizer.plan.md` (sub-plan;
  §2 audit sketch; §6 implementation notes).
- `.cursor/plans/commitment_kernel_outbound_sanitizer.plan.md` (sibling;
  the architectural pattern slice I extends).
- `.cursor/plans/commitment_kernel_streaming_leak.plan.md` (sibling;
  Bug A — Level-1 chunker).
- `.cursor/rules/commitment-kernel-invariants.mdc` — invariants 5, 6, 11, 15.
- `AGENTS.md` — audit discipline and "tests must catch real bugs".
- Files audited:
  - `src/agents/pi-embedded-subscribe.ts:385–473` (Level-1 chunker).
  - `src/agents/pi-embedded-subscribe.handlers.messages.ts:322–356`
    (handleMessageEnd, diagnostic log).
  - `src/agents/pi-embedded-utils.ts:280–323, 345–489` (thinking helpers).
  - `src/shared/text/reasoning-tags.ts:1–93` (canonical strip).
  - `src/shared/text/assistant-visible-text.ts:1–48`
    (`stripAssistantInternalScaffolding`).
  - `src/agents/pi-embedded-runner/thinking.ts:25` (`dropThinkingBlocks`).
  - `src/agents/pi-embedded-runner/run/attempt.ts:2067, 2138`
    (`reasoningTagHint` wiring).
  - `src/agents/system-prompt.ts:184, 342–353, 602–604`
    (`reasoningTagHint` rendering).
  - `src/infra/outbound/deliver.ts:47–52, 376–432, 577, 691, 770–775`
    (sanitizer call site, delivery chain).
  - `src/infra/outbound/outbound-sanitizer.ts:38–270` (sanitizer module,
    16 patterns).
  - `src/utils/provider-utils.ts:10–35` (`isReasoningTagProvider`).
  - `src/utils/message-channel.ts:19, 45, 87` (`INTERNAL_MESSAGE_CHANNEL`).
  - `src/channels/ids.ts:4–17` (`CHAT_CHANNEL_ORDER`).
