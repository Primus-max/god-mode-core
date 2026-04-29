---
name: Bug A — streaming-leak в external channel (universal tool-call XML/JSON markers)
overview: |
  UX-инвариант final-reply-only нарушается, когда модель эмиттит сырые tool-call XML/JSON разметки прямо в assistant-text (а не как структурный tool_call), и эти артефакты попадают в block-streaming pipeline → external messaging surface (TG/Discord/WhatsApp/Slack/Signal/SMS/voice/iMessage/Google Chat). Сейчас структурные strip'еры закрывают только узкие случаи: `<minimax:tool_call>` / `<invoke>` (Minimax), `[Tool Call: …]` / `[Tool Result for ID …]` / `[Historical context: …]` (Gemini downgrade), `<|...|>` (GLM-5 / DeepSeek special tokens). Универсальные шаблоны `<tool_call>...</tool_call>`, `<tool_use>...</tool_use>`, `<function_call>...</function_call>`, partial JSON fragments вида `{"name":"X","arguments":{...}}` не покрыты ни в block-streaming chunker'е (`pi-embedded-subscribe.ts::emitBlockChunk`), ни в outbound-санитайзере (Bug E `src/infra/outbound/outbound-sanitizer.ts`).

  Defense-in-depth Level 2 (boundary sanitizer) + Level 1 (streaming chunker strip): обе точки получают зеркальный набор шаблонов, чтобы leak ловился и до отправки в pipeline (минимизирует UX-noise при включённом block streaming), и на boundary outbound-доставки (final-reply path / pipeline-bypass).

  Out of scope явно: `src/platform/commitment/**`; четыре frozen call-sites (`src/platform/plugin.ts:80,340`, `src/platform/decision/input.ts:444,481`); пять frozen decision contracts (правка только в `src/agents/pi-embedded-utils.ts`, `src/agents/pi-embedded-subscribe.ts` и `src/infra/outbound/outbound-sanitizer.ts`); `sanitizeToolErrorForUser` (Bug E уже merged 15ccd4455d); aggregation gate (PR-aggregation merged 6ca30ac6d3 — single_final_user_facing_message_per_user_turn invariant); recipe routing (Bug C merged 9f6f8d8d3d); ambiguity policy (Bug D); persistent worker push (Bug F).

  ЗАПРЕТ: phrase / text-rule matching по `UserPrompt` / `RawUserTurn` вне whitelist `src/platform/commitment/intent-contractor.ts` (invariant #5); чтение raw user text вне `IntentContractor` (invariant #6). Все patterns в этом PR работают на **OUTPUT** (assistant-emitted text → outbound delivery), не на user-prompt.

audit_gaps_closed: []

todos:
  - id: signoff-and-branch
    content: Ветка `fix/orchestrator-streaming-leak` от свежего `origin/dev`. Signoff отменён по решению пользователя — двигаемся к цели, строго по плану.
    status: pending
  - id: implement-sanitizer-extend
    content: |
      Расширить `src/infra/outbound/outbound-sanitizer.ts` curated `OUTBOUND_LEAK_PATTERNS` универсальными tool-call markers:
      (1) `<tool_call>...</tool_call>` (multiline, non-greedy) — kind=replace `(внутренний tool-call; обработан)`;
      (2) `<tool_use>...</tool_use>` (Anthropic-style raw markup) — kind=replace `(внутренний tool-call; обработан)`;
      (3) `<function_call>...</function_call>` (OpenAI legacy) — kind=replace `(внутренний tool-call; обработан)`;
      (4) Partial / orphan tool-call open tags `<tool_call ...>` без закрытия (streaming-cut artifact) — kind=strip;
      (5) Partial / orphan tool-call close tags `</tool_call>` / `</tool_use>` / `</function_call>` без открытия — kind=strip;
      (6) Standalone JSON tool-call envelope `{"name":"X","arguments":{...}}` (без `status`/`error` — отличается от tool-error-envelope, который уже покрыт `tool_error_envelope` pattern Bug E) — kind=replace `(внутренний tool-call; обработан)`.
      Применяется только к external-каналам через существующий `EXTERNAL_DELIVERY_SURFACES` allowlist (без изменения allowlist). Telemetry: те же `[outbound-sanitizer] event=stripped patterns=[…]` строки.
    status: pending
  - id: implement-streaming-defense
    content: |
      В `src/agents/pi-embedded-utils.ts` добавить `stripUniversalToolCallMarkup(text)` — strip'ит универсальные `<tool_call>...</tool_call>`, `<tool_use>...</tool_use>`, `<function_call>...</function_call>` блоки (multiline non-greedy) + orphan open/close теги. Применить в `extractAssistantText` рядом со `stripMinimaxToolCallXml` / `stripModelSpecialTokens` / `stripDowngradedToolCallText` (final path) и в `pi-embedded-subscribe.ts::emitBlockChunk` (streaming path) — единая точка очистки. Никакого text-rule matching на UserPrompt — работает только на assistant-emitted text.
    status: pending
  - id: tests
    content: |
      (a) `src/infra/outbound/outbound-sanitizer.test.ts` — 6 новых кейсов на универсальные tool-call markers (по одному на каждый pattern + один комбинированный с уже существующими паттернами Bug E).
      (b) `src/infra/outbound/deliver.outbound-sanitizer.test.ts` — 1 интеграционный кейс через реальный `deliverOutboundPayloads`: assistant-text c `<tool_call>` уходит в TG санитизированным.
      (c) `src/agents/pi-embedded-utils.test.ts` — 4-5 кейсов на `stripUniversalToolCallMarkup` (полный блок, orphan open, orphan close, multiline JSON arguments, no-op when absent).
      (d) Регресс: `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.streams-soft-chunks-paragraph-preference.test.ts` (или ближайший аналог) — verify, что `<tool_call>` в `text_delta` не утекает в `onBlockReply`.
    status: pending
  - id: tsgo-and-targeted-tests
    content: |
      `pnpm tsgo` clean; ReadLints clean; targeted `pnpm test -- src/infra/outbound src/agents/pi-embedded-utils.test.ts` green. Полный `pnpm test` per AGENTS.md «scoped tests for narrowly scoped changes» — НЕ запускается по умолчанию; если оператор просит — отдельный шаг.
    status: pending
  - id: commit-and-pr
    content: |
      Коммит на русском, без Co-authored-by, scope только к изменённым файлам. PR в dev с label `bug-fix` если касается frozen layer (см. `scripts/check-frozen-layer-label.mjs`). В этом PR frozen layer НЕ затронут (правка `src/agents/**` и `src/infra/outbound/**` — НЕ frozen), но label-check утвердим в момент создания PR.
    status: pending
  - id: handoff-and-master-row
    content: После merge — отдельный `docs(plan)` коммит со строкой в master §0 PR Progress Log по шаблону Bug C; обновить frontmatter этого sub-plan'а (todos → completed) + добавить датированную запись в Handoff §7.
    status: pending

isProject: false
---

# Bug A — streaming-leak в external channel (universal tool-call XML/JSON markers)

## 0. Provenance

| Field | Value |
| --- | --- |
| Источник приоритета | `.cursor/plans/commitment_kernel_subagent_result_aggregation.plan.md` §8 (Bug A, after Bug C). Master §0 PR Progress Log row `2026-04-29 \| Bug C merged 9f6f8d8d3d` → next gate: Bug A streaming-leak sub-plan kickoff. |
| Симптом (продукт) | Tool-call XML / JSON артефакты от модели появляются в финальном сообщении в TG/Discord/WhatsApp/Slack/Signal/SMS/voice/iMessage/Google Chat вместо invisible internal control plane. |
| Кодовый корень (аудит) | `src/agents/pi-embedded-utils.ts` (`stripMinimaxToolCallXml` покрывает только Minimax, `stripDowngradedToolCallText` только Gemini downgrade); `src/infra/outbound/outbound-sanitizer.ts` (Bug E patterns не включают universal tool-call markers). |
| Target branch | `fix/orchestrator-streaming-leak` off latest `origin/dev` (HEAD `088952b37b`). |
| Merge target | `dev`, single PR с label **bug-fix** при касании frozen layer (в этом PR frozen layer не затронут; label-check утвердим при PR creation). |

## 1. Hard invariants this fix MUST keep

См. `.cursor/rules/commitment-kernel-invariants.mdc`. Для этого PR:

| # | Invariant | Как не нарушить |
| --- | --- | --- |
| 5 | Нет phrase-matching на `UserPrompt` / `RawUserTurn` вне whitelist | Все patterns применяются на **OUTPUT** (assistant-emitted text при стриминге / outbound delivery payload). Никаких regex по `prompt` / `RawUserTurn` / `commandBody`. Это зеркало архитектурного решения Bug E. |
| 6 | `IntentContractor` — единственный reader сырого user text | Streaming-leak strip и outbound sanitizer НЕ читают user text; усиливают invariant (внутренние tool-call артефакты не доходят до user channel). |
| 8 | `commitment/` ↛ `decision/` import direction | Не трогаем `src/platform/commitment/**` и `src/platform/decision/**`. Правка только в `src/agents/**` и `src/infra/outbound/**`. |
| 11 | Пять legacy decision contracts frozen | `TaskContract` / `OutcomeContract` / `QualificationExecutionContract` / `ResolutionContract` / `RecipeRoutingHints` не тронуты. |
| 12 | Emergency phrase patches | Не emergency. Структурное расширение curated pattern list под evidence известных моделей (Minimax/Gemini уже покрыты узкими strip'ерами; этот PR делает обобщение). |
| 13 | `terminalState` ⊥ `acceptanceReason` | Не трогается. |

`ExecutionCommitment` / `Affordance` / `MonitoredRuntime` не трогаем.

## 2. Bug repro & evidence

### 2.1. Пути воспроизведения

**A. Юнит-тесты (code-level, после реализации)**

- `src/infra/outbound/outbound-sanitizer.test.ts`: `<tool_call>{"name":"web_search","arguments":{"q":"x"}}</tool_call>` в payload.text → strip'ается (kind=replace). Тестируется по принципу Bug E — patterns curated, тест перебирает кейсы.
- `src/agents/pi-embedded-utils.test.ts`: `stripUniversalToolCallMarkup`('Pre <tool_call>{...}</tool_call> Post') === 'Pre  Post' (collapse). Аналогично для `<tool_use>`, `<function_call>`, partial open/close.

**B. Ручной / gateway**

[Unverified] Точный сценарий live-leak'а зависит от модели. На моделях, которые иногда эмиттят сырые tool-call markers в text content (наблюдаемые в practice: некоторые DeepSeek варианты, ранние Qwen, custom OpenRouter route'ы):

1. Включить уровень логов, где видны `[outbound-sanitizer] event=stripped` строки.
2. Один user-turn с задачей, требующей tool-call (например web_search).
3. Если модель выдала markers — увидим в логе `patterns=[universal_tool_call,...]` и в TG чистый текст.

### 2.2. Codepath trace (`<tool_call>` → external channel)

1. **LLM stream** → `pi-agent-core` event `text_delta` или `text_end` с content, содержащим `<tool_call>{...}</tool_call>` как часть assistant-text.
2. **`pi-embedded-subscribe.handlers.messages.ts::handleMessageUpdate`** копит chunks в `state.deltaBuffer` / `blockChunker`.
3. **`pi-embedded-subscribe.ts::emitBlockChunk`** (line 491-547) применяет `stripBlockTags` (think/final) + `stripDowngradedToolCallText` (Gemini-only). Сейчас `<tool_call>` пройдёт без strip'а → попадёт в `replyDirectiveAccumulator` → `emitBlockReply` → callback `onBlockReply` → `block-reply-pipeline.enqueue` → `coalescer` → внешний `onBlockReply` callback → `deliverOutboundPayloads`.
4. **`deliverOutboundPayloads` → `normalizePayloadsForChannelDelivery`** (Bug E) применяет `sanitizeOutboundForExternalChannel`. Сейчас `<tool_call>` НЕ матчится curated patterns Bug E → leak'ает в external send.
5. На final path: `extractAssistantText` (`pi-embedded-utils.ts:236`) применяет `stripDowngradedToolCallText(stripModelSpecialTokens(stripMinimaxToolCallXml(text)))` — universal не покрыт.

### 2.3. Что уже покрыто и почему недостаточно

| Source | Покрыто чем | Коммит | Не покрывает |
| --- | --- | --- | --- |
| `<minimax:tool_call>` / `<invoke>` | `stripMinimaxToolCallXml` | (старый) | universal `<tool_call>` |
| Gemini `[Tool Call: …]` / `[Tool Result for ID …]` / `[Historical context:]` | `stripDowngradedToolCallText` | (старый) | XML формы |
| `<\|...\|>` model special tokens | `stripModelSpecialTokens` | (старый) | XML tool-call markers |
| `[tools] X failed:`, `[task-classifier]`, `[planner]`, `[provenance-guard]`, `[subagent-aggregation]`, `[intent-ledger]`, `[DEBUG]`, JSON tool-error envelope, Node stack traces | Bug E `outbound-sanitizer.ts` | 15ccd4455d | universal tool-call XML / JSON envelope (без `status:"error"`) |

## 3. Hypothesis

**H1 (основная):** Универсальные tool-call markers (`<tool_call>`, `<tool_use>`, `<function_call>`) и orphan partial fragments попадают в assistant-text от моделей, которые отображают tool-calling как inline-XML вместо structured tool calls. Текущий strip-стек узко покрывает только Minimax + Gemini downgrade + special tokens. Требуется (1) расширение curated patterns в outbound sanitizer (boundary), (2) зеркальный strip в streaming chunker (defense-in-depth, минимизирует UX-noise при включённом block streaming).

**H2:** Tool-call JSON envelope без `status` / `error` поля (т.е. сам call, не error-result) не отличим от Bug E `tool_error_envelope` pattern → нужна отдельная строка patterns для positive call-shape (`{"name":"...","arguments":{...}}`), distinct от error-shape.

**H3 (не в scope этого PR):** При включённом block-streaming (`blockStreamingEnabled === "on"`) intermediate assistant chunks с tool-progress text утекают как separate messages в external channel, нарушая `single_final_user_facing_message_per_user_turn` invariant. Это **отдельный** архитектурный фикс (буферизация при наличии toolCall в turn'е) — выносится в follow-up sub-plan, см. §8.

## 4. Scope-of-fix matrix

| # | Слой | Файл | Изменение | LOC оценка | Invariant |
| --- | --- | --- | --- | --- | --- |
| 1 | Outbound sanitizer (boundary) | `src/infra/outbound/outbound-sanitizer.ts` | 6 новых curated patterns в `OUTBOUND_LEAK_PATTERNS` (см. todo `implement-sanitizer-extend`); `TOOL_CALL_REPLACEMENT = "(внутренний tool-call; обработан)"` const | ~50 | #5, #11 |
| 2 | Streaming chunker (defense-in-depth) | `src/agents/pi-embedded-utils.ts` | Новая `stripUniversalToolCallMarkup(text): string` функция (multiline non-greedy XML strip + orphan open/close); подключена в `extractAssistantText` рядом с `stripMinimaxToolCallXml`; экспортируется для использования в `pi-embedded-subscribe.ts` | ~40 | #5 |
| 3 | Streaming emit point | `src/agents/pi-embedded-subscribe.ts` | В `emitBlockChunk` вызов `stripUniversalToolCallMarkup` рядом со `stripDowngradedToolCallText` | ~3 | #5 |
| 4 | Тесты sanitizer | `src/infra/outbound/outbound-sanitizer.test.ts` | 6 кейсов на новые patterns + 1 комбинированный | ~80 | — |
| 5 | Тесты sanitizer integration | `src/infra/outbound/deliver.outbound-sanitizer.test.ts` | 1 интеграционный: `<tool_call>` в payload.text → strip через `deliverOutboundPayloads` для TG | ~30 | — |
| 6 | Тесты streaming util | `src/agents/pi-embedded-utils.test.ts` | 5 кейсов на `stripUniversalToolCallMarkup` | ~70 | — |

**Итого:** ~270–330 LOC. Frozen layer не затронут. Кодовый surface ограничен `src/agents/{pi-embedded-utils.ts,pi-embedded-subscribe.ts}` + `src/infra/outbound/outbound-sanitizer.ts` + соответствующие тесты.

## 5. Acceptance criteria

1. На `<tool_call>{"name":"X","arguments":{...}}</tool_call>` в payload.text внешнего канала (telegram / signal / whatsapp / slack / discord / sms / voice / imessage / googlechat): outbound-sanitizer заменяет на neutral marker `(внутренний tool-call; обработан)`, telemetry `[outbound-sanitizer] event=stripped patterns=[universal_tool_call_*]` пишется.
2. На orphan open `<tool_call name="X">` без закрытия (streaming-cut): strip полностью.
3. На orphan close `</tool_call>` без открытия: strip полностью.
4. Аналогично для `<tool_use>` и `<function_call>`.
5. JSON tool-call envelope `{"name":"X","arguments":{...}}` без `status`/`error` — replace neutral marker; не конфликтует с Bug E `tool_error_envelope` (он матчит только envelope с `status:"error"`).
6. `extractAssistantText` (final path) — universal markers стрип'аются на ровне с Minimax / Gemini-downgrade / special tokens; снапшоты тестов отражают.
7. Streaming chunker (`emitBlockChunk`) — universal markers не утекают в `onBlockReply` callback при включённом `blockStreamingEnabled`.
8. Не-tool-call контент (markdown, code blocks с упоминанием `tool_call` в тексте) **не** ломается — patterns целят на структурную форму, не на keyword.
9. `pnpm tsgo` clean; targeted tests green.
10. Никакого нового phrase-matching по `UserPrompt` / `RawUserTurn` (invariant #5); `IntentContractor` не трогается (invariant #6).

## 6. Implementation notes (decision-table for patterns)

### Outbound sanitizer patterns (6 новых)

| ID | Шаблон (regex sketch) | Replacement | Multiline | Notes |
| --- | --- | --- | --- | --- |
| `universal_tool_call_xml` | `<tool_call\b[^>]*>[\s\S]*?</tool_call>` | replace `(внутренний tool-call; обработан)` | yes | Anthropic-like + general |
| `universal_tool_use_xml` | `<tool_use\b[^>]*>[\s\S]*?</tool_use>` | replace `(внутренний tool-call; обработан)` | yes | Anthropic structured leakage |
| `universal_function_call_xml` | `<function_call\b[^>]*>[\s\S]*?</function_call>` | replace `(внутренний tool-call; обработан)` | yes | OpenAI legacy |
| `universal_tool_call_orphan_open` | `<tool_call\b[^>]*>` (если не за ним идёт `</tool_call>` на разумной дистанции) | strip | no | streaming-cut tail |
| `universal_tool_call_orphan_close` | `</(?:tool_call|tool_use|function_call)>` (если не было соответствующего open) | strip | no | streaming-cut head |
| `universal_tool_call_json_envelope` | `\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[^{}]*\}\s*\}` (без `"status"` / `"error"`) | replace `(внутренний tool-call; обработан)` | no | distinct от Bug E `tool_error_envelope` |

Реализация orphan-detection: для outbound применяем patterns последовательно — сначала full-block (#1-3), затем orphan strip (#4-5) на остатке. Это упрощает regex без stateful parsing.

### Streaming util `stripUniversalToolCallMarkup`

```ts
export function stripUniversalToolCallMarkup(text: string): string {
  if (!text) return text;
  if (!/<\/?(?:tool_call|tool_use|function_call)\b/i.test(text)) return text;
  let cleaned = text
    .replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<tool_use\b[^>]*>[\s\S]*?<\/tool_use>/gi, "")
    .replace(/<function_call\b[^>]*>[\s\S]*?<\/function_call>/gi, "");
  cleaned = cleaned.replace(/<\/?(?:tool_call|tool_use|function_call)\b[^>]*>/gi, "");
  return cleaned.replace(/  +/g, " ").trim();
}
```

Подключение в `extractAssistantText` (one-line изменение):

```ts
sanitizeText: (text) =>
  stripThinkingTagsFromText(
    stripDowngradedToolCallText(
      stripModelSpecialTokens(
        stripMinimaxToolCallXml(stripUniversalToolCallMarkup(text)),
      ),
    ),
  ).trim(),
```

В `emitBlockChunk`:

```ts
const chunk = stripUniversalToolCallMarkup(
  stripDowngradedToolCallText(stripBlockTags(text, state.blockState)),
).trimEnd();
```

## 7. Handoff Log

### 2026-04-29 — Bootstrap audit

Прочитано:

- Master plan §0 / §0.5 / §3 (16 hard invariants) / §6 freeze / §8 PR sequence + §0 PR Progress Log row `2026-04-29 Bug C merged 9f6f8d8d3d → next gate: Bug A streaming-leak sub-plan kickoff`.
- `.cursor/rules/pr-session-bootstrap.mdc` (bootstrap protocol, 4 строки + skip Q1-Q5 без триггера).
- `.cursor/rules/commitment-kernel-invariants.mdc` (16 hard invariants).
- Sub-plan `commitment_kernel_subagent_result_aggregation.plan.md` §8 (Bug A priority, текст «Tool-progress / intermediate assistant chunks утекают в TG как отдельные сообщения вместо буферизации в один final reply»).
- Sub-plan `commitment_kernel_recipe_routing_publish.plan.md` (Bug C, template для structure handoff/scope-of-fix matrix).
- Bug E коммит `15ccd4455d` (outbound sanitizer baseline) — patterns: 7 line-markers + tool_error_envelope + 2 stack-trace shapes; `EXTERNAL_DELIVERY_SURFACES` allowlist.
- Code: `src/infra/outbound/outbound-sanitizer.ts` (208 LOC), `src/infra/outbound/deliver.ts` (line 397-420 — sanitizer integration), `src/agents/pi-embedded-utils.ts` (`stripMinimaxToolCallXml`, `stripModelSpecialTokens`, `stripDowngradedToolCallText`, `extractAssistantText`), `src/agents/pi-embedded-subscribe.ts` (line 491-547 emitBlockChunk), `src/agents/pi-embedded-subscribe.handlers.messages.ts` (text_delta path), `src/auto-reply/reply/block-streaming.ts`, `src/auto-reply/reply/block-reply-pipeline.ts` (coalescer), `src/auto-reply/reply/agent-runner-execution.ts`, `src/auto-reply/reply/reply-delivery.ts` (createBlockReplyDeliveryHandler).

Findings:

1. Bug E sanitizer покрывает только curated diagnostic markers и tool-error envelope — НЕ универсальные tool-call XML / JSON. → расширяем patterns.
2. Streaming chunker применяет `stripDowngradedToolCallText` (только Gemini downgrade `[Tool Call: ...]`) — НЕ универсальные XML markers. → добавляем `stripUniversalToolCallMarkup`.
3. `stripMinimaxToolCallXml` покрывает `<minimax:tool_call>` / `<invoke>` — узко-привязано к одной модели; универсальная форма не покрыта.
4. `stripModelSpecialTokens` ловит `<|...|>` через `<[|｜][^|｜]*[|｜]>` regex — это сработает на `<|tool_call_begin|>` тип токенов, НЕ на `<tool_call>...</tool_call>` XML.
5. Single_final_user_facing_message_per_user_turn invariant (PR-aggregation merged 6ca30ac6d3) частично смягчает Bug A через holding-message gate, но НЕ блокирует block-streaming pipeline для intermediate chunks (когда нет sessions_spawn в turn'е). Полный фикс buffering при наличии любого tool_call в turn'е — отдельный future sub-plan (см. §8).

Scope check:

- Frozen layer: НЕ затронут (правка в `src/agents/**`, `src/infra/outbound/**` — это application layer).
- 4 frozen call-sites: НЕ затронуты.
- 5 frozen decision contracts: НЕ затронуты.
- Adjacent bugs (B/D/F): scope-creep предотвращён — каждый получит свой sub-plan.

Hard invariants check (16):

- #5 (no phrase-rule matching на UserPrompt outside whitelist): patterns работают на assistant-OUTPUT, не на user-input. Зеркально архитектурному решению Bug E.
- #6 (IntentContractor sole reader of raw user text): не трогаем; усиливаем (tool-call артефакты не доходят до user channel).
- #11 (5 frozen decision contracts): не тронуты.
- #15 (human signoff): по решению пользователя skip — двигаемся к цели без maintainer Q1-Q5.

Дальнейший order: implement-sanitizer-extend → implement-streaming-defense → tests → tsgo-and-targeted-tests → commit-and-pr → handoff-and-master-row.

## 8. Adjacent bugs (NOT in scope; tracked for future sub-plans)

| Order | Bug | Симптом | Приоритет | Будущий sub-plan |
| --- | --- | --- | --- | --- |
| 1 | **A.2 — Block-streaming buffering при tool_call в turn'е** | Когда `blockStreamingEnabled=on` и LLM делает tool_call посреди turn'а, intermediate assistant chunks (до tool execution) утекают как separate messages в external. Single_final_user_facing_message_per_user_turn invariant НЕ обеспечивает буферизацию для случаев без `sessions_spawn`. | medium | `commitment_kernel_streaming_leak_buffering.plan.md` (TBD) — буферизация в `block-reply-pipeline.ts` при наличии любого toolCall в `runResult.toolCalls`. |
| 2 | **D — Ambiguity over-blocking** | Classifier помечает `hosting unspecified` как `blocking` даже когда юзер явно сказал «локально». | medium | часть `commitment_kernel_policy_gate_full.plan.md` (Master §8.5.1). |
| 3 | **F — Persistent worker subsequent push** | Cron-driven daily push'ы из persistent_worker'а в внешний канал. | medium | `commitment_kernel_persistent_worker_push.plan.md` (TBD). |

## 9. References

- Master: `.cursor/plans/commitment_kernel_v1_master.plan.md` (§0 PR log, §3 invariants, §6 freeze, §8 PR sequence)
- Aggregator §8: `.cursor/plans/commitment_kernel_subagent_result_aggregation.plan.md` §8 (Bug A priority)
- Bug E (outbound sanitizer): `.cursor/plans/commitment_kernel_outbound_sanitizer.plan.md`; merge `15ccd4455d`
- Bug C (recipe routing publish, sub-plan template): `.cursor/plans/commitment_kernel_recipe_routing_publish.plan.md`; merge `9f6f8d8d3d`
- Aggregation invariant: `src/auto-reply/reply/aggregation-policy.ts`, `src/auto-reply/reply/subagent-aggregation.ts`
- Streaming pipeline: `src/auto-reply/reply/block-streaming.ts`, `src/auto-reply/reply/block-reply-pipeline.ts`, `src/auto-reply/reply/block-reply-coalescer.ts`
- Subscribe path: `src/agents/pi-embedded-subscribe.ts` (emitBlockChunk line 491-547), `src/agents/pi-embedded-subscribe.handlers.messages.ts` (text_delta path)
- Strip stack: `src/agents/pi-embedded-utils.ts` (`stripMinimaxToolCallXml`, `stripModelSpecialTokens`, `stripDowngradedToolCallText`, `extractAssistantText`)
- Outbound sanitizer: `src/infra/outbound/outbound-sanitizer.ts`, `src/infra/outbound/deliver.ts:397-420`
- Frozen layer: `src/platform/commitment/**` (NOT touched), `src/platform/decision/**` (NOT touched), 4 frozen call-sites (`src/platform/plugin.ts:80,340`, `src/platform/decision/input.ts:444,481`)

---

**Stop gate:** signoff отменён по решению пользователя — двигаемся к цели по плану. После реализации + targeted tests + tsgo — single PR в `dev` с label-check на frozen-layer (label `bug-fix` если applicable; в этом PR frozen layer НЕ затронут).
