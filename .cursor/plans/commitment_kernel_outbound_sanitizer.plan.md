---
name: Outbound sanitizer — invariant-level boundary against raw internal diagnostics in external channels (commitment kernel side-plan, Bug E)
overview: |
  Архитектурный фикс: ввести явный invariant и единственный outbound-боундари, который гарантирует, что никакие raw internal diagnostics (`[tools] X failed: ...`, `[task-classifier] ...`, `[planner] ...`, `[provenance-guard] ...`, `[subagent-aggregation] ...`, `[DEBUG ...]`, stack traces, raw tool-error JSON-envelopes, kernel rejection codes) не попадают в external channel (telegram, signal, whatsapp, slack, discord, sms, voice). Если LLM их echo'нул в assistant prose — sanitizer перехватывает их на последней delivery-стадии и заменяет на neutral generic copy либо вырезает полностью + emit telemetry.

  Симптом подтверждён в реальных runtime evidence (gateway log `C:\tmp\openclaw\openclaw-2026-04-28.log` + session transcript `~/.openclaw/agents/main/sessions/ed2b1839-*.jsonl`):
  - `[tools] cron failed: Reminder scheduling cannot target another session.` (lines 470/471)
  - `[tools] cron failed: Reminder scheduling cannot target another chat.` (lines 481/482)
  - `[tools] web_search failed: DuckDuckGo returned a bot-detection challenge.` (lines 491/492, 642/643, 653–658)
  - В session transcript найдены raw tool-error JSON-envelopes:
    `{"status":"error","tool":"web_search","error":"DuckDuckGo returned a bot-detection challenge."}` — попадают в LLM context как `toolResult.error` field (line 7 `3abbfc7a-*.jsonl`, line 9/18/19/21 `ed92cfe6-*.jsonl`, line 19 `ed2b1839-*.jsonl`).
  - LLM с этим контекстом может echo'нуть текст в user-facing reply.

  Корневая причина leak'а: `src/agents/tool-error-sanitizer.ts:165-175` `sanitizeToolErrorForUser` — если ни один pattern из `CHANNEL_POLICY_PATTERNS` / `APPROVAL_PATTERNS` / `INPUT_INVALID_PATTERNS` / `TRANSIENT_PATTERNS` / `EXECUTION_CONTRACT_UNSATISFIED_PATTERNS` не сработал, функция возвращает `normalized` (raw error text) verbatim. Это permissive-by-default policy. После этого raw-text идёт в LLM как `toolResult.error`, и LLM echo'ит его в assistant text при формулировке user reply.

  Архитектурный фикс — defense-in-depth, два уровня:

  **Level 1 (этот PR, primary boundary):** ввести outbound-side sanitizer в `src/infra/outbound/outbound-sanitizer.ts`, вызвать из `normalizePayloadsForChannelDelivery` (`src/infra/outbound/deliver.ts:370-400`) ПОСЛЕ `sanitizeForPlainText` для ВСЕХ external channels (не только plain-text — discord/slack/telegram/whatsapp/signal/sms/voice/imessage/googlechat). Перехватывает leak независимо от его источника (LLM echo, прямая ошибка, debug-метки).

  **Level 2 (НЕ в scope этого PR — future):** переключить `sanitizeToolErrorForUser` fallback с permissive-pass на default-deny. Это режет leak на TOOL→LLM boundary, но риск регресса recovery-flows (LLM нужен текст ошибки чтобы рекомендовать пользователю action). Делается отдельным PR с осторожным A/B-rollout.

  ЖЁСТКО (do NOT violate):
  - НЕ трогать `src/platform/commitment/**` (PR-4b frozen).
  - НЕ трогать 4 frozen call-sites: `src/platform/plugin.ts:80`, `:340`, `src/platform/decision/input.ts:444`, `:481`.
  - НЕ откатывать provenance gate (`src/platform/decision/input.ts:362-431, 449-470`) и aggregation policy (`src/auto-reply/reply/aggregation-policy.ts`, `src/auto-reply/reply/subagent-aggregation.ts`).
  - НЕ нарушать 16 hard invariants (`/.cursor/rules/commitment-kernel-invariants.mdc`). В частности invariant #5 (no phrase / text-rule matching на UserPrompt outside whitelist) — sanitizer работает на OUTPUT (payload.text от LLM), а не на UserPrompt/RawUserTurn; работает по structural boundary (delivery layer), pattern-list curated на known internal-diagnostic markers, не на user-prompt текст.
  - НЕ ширить scope в Bug A/C/D/F (streaming-leak / recipe routing / ambiguity / persistent_worker push).
  - НЕ менять `sanitizeToolErrorForUser` (Level 2) в этом PR.
  - НЕ ширить sanitizer-список patterns на guess-based prose-detection. Только curated, доказанные leak-маркеры. Расширения — только при наличии evidence в логах.

  Фикс выпускается single-PR'ом ПОСЛЕ human signoff. Ожидаемый scope ~280–400 LOC поверх 3–5 файлов; превышает порог «ship without plan» (<300 LOC / <5 files), поэтому стандартная последовательность plan + signoff first.
audit_gaps_closed:
  - E1 (raw tool errors echo'нуты в external channel через LLM прозрачный pass-through)
  - E2 (нет invariant'а «no internal diagnostics in external delivery payload»)
  - E3 (нет single boundary; HTML-sanitizer в delivery layer и tool-error-sanitizer на tool-side не координированы)
  - E4 (telemetry: нет `[outbound-sanitizer]` события для случаев перехвата)
todos:
  - id: bootstrap-and-confirm-bug
    content: |
      Bootstrap audit done (см. §6). Evidence collected: gateway log `C:\tmp\openclaw\openclaw-2026-04-28.log` (lines 470/471, 481/482, 491/492, 642/643, 653–658) + session transcripts `ed2b1839-*.jsonl:19`, `3abbfc7a-*.jsonl:7`, `ed92cfe6-*.jsonl:9/18/19/21`. Hard invariants checklist passed (§1).
    status: completed
  - id: trace-leak-codepath
    content: |
      Codepath traced (см. §3). Tool throws → `src/agents/pi-tool-definition-adapter.ts:165` `logError` + line 167 `buildToolExecutionErrorResult` → `src/agents/tool-error-sanitizer.ts:174` permissive fallback returns raw `normalized` text → LLM `toolResult.error` field → LLM echo в assistant text → `src/infra/outbound/deliver.ts:370` `normalizePayloadsForChannelDelivery` (HTML strip только для plain-text channels, нет raw-leak check) → `deliverOutboundPayloads` → external channel.
    status: completed
  - id: define-invariant
    content: |
      Invariant `no_raw_internal_diagnostics_in_external_channel` зафиксирован в JSDoc заголовке `src/infra/outbound/outbound-sanitizer.ts`. Гейт работает по `EXTERNAL_DELIVERY_SURFACES` + 10 curated regex (output-side, invariant #5 preserved). Закрывает audit gap E2.
    status: completed
  - id: implement-sanitizer-module
    content: |
      Создан `src/infra/outbound/outbound-sanitizer.ts` (~165 LOC):
      — 10 patterns: `tool_error_marker`, `tool_error_envelope`, `task_classifier_marker`, `planner_marker`, `provenance_guard_marker`, `subagent_aggregation_marker`, `intent_ledger_marker` (signoff Q3 +10), `debug_marker`, `node_stack_trace`, `node_error_path`.
      — `EXTERNAL_DELIVERY_SURFACES` = 9 каналов (signoff Q5): telegram, signal, whatsapp, slack, discord, sms, voice, imessage, googlechat. `isExternalDeliverySurface(channel)` — type-narrowed allowlist.
      — `sanitizeOutboundForExternalChannel(text)` → `{ text, stripped }`: per-pattern replace/strip, collapse blank lines, trim trailing whitespace.
      — `formatOutboundSanitizerLog(...)` → telemetry line `[outbound-sanitizer] event=stripped channel=<id> patterns=[<ids>*N,...] session=<key> bytes_before=<n> bytes_after=<n>`.
      — Constants: `EMPTY_AFTER_SANITIZATION_FALLBACK_TEXT = "Запрос не удалось выполнить."` (Q2), `TOOL_ERROR_ENVELOPE_REPLACEMENT = "(внутренняя ошибка инструмента; обработана)"` (Q1).
    status: completed
  - id: integrate-with-deliver
    content: |
      `src/infra/outbound/deliver.ts::normalizePayloadsForChannelDelivery` принимает дополнительный `sessionKey?: string`; вызов из `deliverOutboundPayloads` пробрасывает `sessionKeyForInternalHooks`. После `sanitizeForPlainText` (HTML strip) применяется `sanitizeOutboundForExternalChannel` для каждого `isExternalDeliverySurface(channel)` payload. На non-empty `stripped` событий — `log.warn(formatOutboundSanitizerLog(...))`. Empty result → `EMPTY_AFTER_SANITIZATION_FALLBACK_TEXT`. Internal channels (canvas/webchat/stdout/log) bypass — diagnostics не режутся. Frozen call-sites не тронуты.
    status: completed
  - id: tests-sanitizer-pure
    content: |
      `src/infra/outbound/outbound-sanitizer.test.ts` — 17 кейсов (5 групп):
      (1) `EXTERNAL_DELIVERY_SURFACES`: 9 разрешённых каналов + 6 запрещённых internal/unknown.
      (2) Pattern coverage: ровно 10 signoff-approved patternIds.
      (3) `sanitizeOutboundForExternalChannel`: clean text → unchanged + stripped=[]; tool-error marker line strip; raw JSON envelope replace; classifier/planner/provenance/aggregation/ledger/debug markers strip; Node stack trace strip; ESM file:// path strip; leak-only text → "" + events; collapse 3+ blank lines; multi-match counting; legitimate `[Bug]` сохраняется; line-anchored regex не матчит mid-sentence.
      (4) `formatOutboundSanitizerLog`: canonical line; opt-out `session=` part.
      (5) Fallback constants — точные тексты по signoff.
      Result: 17/17 green.
    status: completed
  - id: tests-deliver-integration
    content: |
      `src/infra/outbound/deliver.outbound-sanitizer.test.ts` — 6 кейсов:
      (a) telegram strip `[tools] cron failed: ...` + telemetry event с session+pattern;
      (b) whatsapp HTML strip + JSON envelope replace (последовательность HTML → diagnostics);
      (c) signal: leak-only payload → fallback "Запрос не удалось выполнить.";
      (d) slack: clean text → unchanged + 0 sanitizer telemetry events;
      (e) telegram: multi-pattern (classifier+planner) → both stripped, оба patternIds в одной telemetry-строке;
      (f) telegram: replyToId/threadId metadata сохраняются при sanitize (regression).
      Result: 6/6 green.
    status: completed
  - id: tsgo-and-targeted-tests
    content: |
      `pnpm tsgo` — green. ReadLints — clean. Targeted: `pnpm test -- src/infra/outbound/outbound-sanitizer.test.ts` (17/17), `pnpm test -- src/infra/outbound/deliver.outbound-sanitizer.test.ts` (6/6). Full outbound suite: `pnpm test -- src/infra/outbound/` — 448 passed / 2 skipped / 0 failed (44 файла), pre-existing baseline сохранена. Цвет: green.
    status: completed
  - id: live-smoke-evidence
    content: |
      После merge оператор перезапускает gateway, провоцирует leak (например, web_search query, который попадает на DuckDuckGo bot-detection; либо cron-action с cross-session targetSession). Ожидаемое поведение в TG:
      — НИ ОДНОГО `[tools] X failed: ...` в reply'е;
      — НИ ОДНОГО raw JSON envelope `{"status":"error","tool":"X",...}` в reply'е;
      — НИ ОДНОГО stack trace / debug-метки.
      В gateway log:
      — ОДНО `[outbound-sanitizer] event=stripped channel=telegram patterns=[tool_error_marker] session=<id>` per leak-event.
    status: pending
  - id: human-signoff
    content: |
      Production routing-adjacent change поверх delivery layer (`src/infra/outbound/**`). Invariant #15 — нужен явный maintainer signoff ДО merge. Все 16 invariant'ов соблюдены: §1 фиксирует места проверки. Frozen call-sites не тронуты, frozen layers не тронуты, scope-creep не произошёл (всё уложилось в §4 matrix).
    status: pending
  - id: final-docs-commit
    content: |
      Final commit `docs(plan): mark outbound-sanitizer completed`. Append PR row в master §0 PR Progress Log (вне таблицы PR-1..4, отдельной строкой как side-plan); mark §0.5 audit gaps E1-E4 как `closed by <merge-SHA>`; append handoff-log entry в §6 этого плана. В master §0 в строке «Cutover-2 reality» обновить `Next gate` (Bug C/A/D/F остаются в очереди).
    status: pending
isProject: false
---

# Outbound sanitizer — single boundary against raw internal diagnostics in external channels

## 0. Provenance

| Field | Value |
| --- | --- |
| Bug report ts | 2026-04-28 (продолжение Bug E из `commitment_kernel_subagent_result_aggregation.plan.md` §8) |
| Repo / branch | `god-mode-core` / `dev` (~PR aggregation merged 2026-04-28, commit `6ca30ac6d3`, pending push) |
| Detected via | gateway log `C:\tmp\openclaw\openclaw-2026-04-28.log` + session transcripts `~/.openclaw/agents/main/sessions/*.jsonl` |
| Final merge target | `dev`, single PR `fix(orchestrator): outbound sanitizer for raw internal diagnostics in external channels` |
| Production routing change | YES (на пути external delivery payload-text проходит через sanitizer; внутренние/log surfaces unchanged) |
| Out-of-scope | `src/platform/commitment/**`; 4 frozen call-sites; `sanitizeToolErrorForUser` change (Level 2 — future PR); recipe routing (Bug C); streaming-leak chunker (Bug A); ambiguity policy (Bug D); persistent_worker push (Bug F); changes to existing `sanitizeForPlainText` HTML logic |
| Sub-plan of | `commitment_kernel_v1_master.plan.md`; depends on `commitment_kernel_self_feedback_loop_fix.plan.md` (provenance gate) и `commitment_kernel_subagent_result_aggregation.plan.md` (aggregation policy + verbatim forward) — оба merged. Bug priority order: **E (this) > C > A > D > F** (см. side-plan `subagent_result_aggregation` §8) |

## 1. Hard invariants this fix MUST keep

Перечень из `.cursor/rules/commitment-kernel-invariants.mdc`:

1. `ExecutionCommitment` tool-free — фикс не трогает kernel.
2. `Affordance` selector unchanged.
3. Production success requires `commitmentSatisfied(...) === true` — не влияет: sanitizer работает на финальном payload-text после кернеловской верификации.
4. State-after fact requirement unchanged.
5. **No phrase / text-rule matching на UserPrompt outside whitelist** — sanitizer работает на OUTPUT (payload.text эмитится LLM/системой), не на `UserPrompt`/`RawUserTurn`. Pattern-list curated на known internal-diagnostic markers (`[tools]`, `[task-classifier]`, `[planner]`, `[provenance-guard]`, `[subagent-aggregation]`, `[DEBUG ...]`, raw JSON tool-error envelopes, stack traces). Структурный boundary (delivery layer + external channel enum). Invariant соблюдён.
6. `IntentContractor` is the only reader of raw user text — фикс НЕ читает user text; fallback не использует prompt-content; усиливает invariant в spirit-форме (не даёт LLM-эху user text загрязнить delivery diagnostics).
7. `ShadowBuilder` unchanged.
8. `commitment` ↛ `decision` import direction — фикс правит только в `src/infra/outbound/**`. Никаких обратных импортов.
9. `DonePredicate` text-blind — не трогается.
10. `DonePredicate` lives on Affordance — не трогается.
11. Five legacy decision contracts frozen — не меняем `TaskContract`/`OutcomeContract`/`QualificationExecutionContract`/`ResolutionContract`/`RecipeRoutingHints`.
12. Emergency phrase / routing patches with retire deadline — фикс не emergency, structural; ticket не нужен.
13. `terminalState` / `acceptanceReason` orthogonality — оба populated на parent-final reply; sanitizer работает после.
14. `ShadowBuildResult` typed union — не трогается.
15. PR human signoff — этот PR требует human signoff §0.6.
16. `EffectFamilyId` ≠ `EffectId` — не трогается.

## 2. Bug repro & evidence

### 2.1. Repro pathways

1. **cron cross-session leak**: `agents.defaults.model=hydra/gpt-5.4`, `gateway.mode=local`. Из TG отправить промпт, провоцирующий cron-tool с targetSession ≠ текущая (например «поставь напоминание для другой сессии»). Tool throws `Reminder scheduling cannot target another session.` → попадает в LLM context → LLM echo'ит в reply.
2. **web_search bot-detection leak**: TG-промпт «найди в интернете X». LLM зовёт web_search → DuckDuckGo возвращает bot-detection. Tool throws `DuckDuckGo returned a bot-detection challenge.` → LLM context → LLM echo'ит.
3. **debug-метки утечка**: любой `[debug ...]` блок (например исторический `[DEBUG ROUTING]` до PR-4a, либо новые kernel-trace dumps), который LLM zaplenится и echo'нул в reply.

### 2.2. Evidence (timestamped)

#### 2.2.1. Gateway log `C:\tmp\openclaw\openclaw-2026-04-28.log`

| Lines | Текст | Что подтверждает |
| --- | --- | --- |
| 470–471 | `[tools] cron failed: Reminder scheduling cannot target another session.` | Raw error в logs (logLevelId=5 ERROR). Cron-tool throws; sanitizer permissive fallback (см. §3) пропускает в LLM context. |
| 481–482 | `[tools] cron failed: Reminder scheduling cannot target another chat.` | То же, другой error path в `cron-tool.ts:276`. |
| 491–492, 642–643, 653–658 | `[tools] web_search failed: DuckDuckGo returned a bot-detection challenge.` | Web_search bot-detection leak. |
| 348–351, 670–671 | `[tools] read failed: ENOENT: no such file or directory, access '...\.md'` | Filesystem ENOENT тоже permissive pass-through. |

#### 2.2.2. Session transcript leakage (LLM context contamination)

| Файл / line | Контекст |
| --- | --- |
| `~/.openclaw/agents/main/sessions/ed2b1839-efd1-4566-8045-04f4ac45ea18.jsonl:19` | `toolResult` / `toolName=web_search` / `error="DuckDuckGo returned a bot-detection challenge."` |
| `~/.openclaw/agents/main/sessions/3abbfc7a-166d-4991-8aaa-40b92a9c8c17.jsonl:7` | то же |
| `~/.openclaw/agents/main/sessions/ed92cfe6-f44e-4cd5-aed2-8403aef399d1.jsonl:9, :18, :19, :21` | то же (4 повтора в одной сессии) |

Раз LLM имеет это в context — ничто структурно не запрещает ему echo'ить такой текст в assistant prose. Сейчас защита держится только на «надеемся, что LLM не упомянет» — это не invariant, это удача.

#### 2.2.3. Где именно permissive fallback (root cause)

`src/agents/tool-error-sanitizer.ts:165-175`:

```ts
export function sanitizeToolErrorForUser(text: string): string | undefined {
  const normalized = normalizeFirstLine(text);
  if (!normalized) {
    return undefined;
  }
  const classified = classifyToolPolicyError(normalized);
  if (classified) {
    return classified.userMessage;
  }
  return normalized;  // <-- LEAK: returns raw error text если pattern не совпал
}
```

`CHANNEL_POLICY_PATTERNS` ловит только `/only reminder scheduling is allowed from this chat/iu` + ещё 4 фразы. Variants `Reminder scheduling cannot target another session/chat`, `DuckDuckGo returned a bot-detection challenge.`, ENOENT-пути — НЕ в списке.

### 2.3. Где сейчас НЕТ нужного контракта

| Контракт | Где должен быть | Текущее состояние |
| --- | --- | --- |
| Invariant `no_raw_internal_diagnostics_in_external_channel` | `src/infra/outbound/outbound-sanitizer.ts` | НЕ существует |
| Curated leak-pattern registry | то же | НЕ существует. Существует `tool-error-sanitizer.ts` но он работает permissively на TOOL-side (Level 2), не на DELIVERY-side |
| Single delivery-side boundary | `src/infra/outbound/deliver.ts::normalizePayloadsForChannelDelivery` | Только HTML-strip (`sanitizeForPlainText`) для plain-text channels. Нет diagnostics-strip. |
| Telemetry `[outbound-sanitizer]` event | `src/infra/outbound/outbound-sanitizer.ts` | НЕ существует |

## 3. Hypothesis

Causal chain leak'а:

1. Tool throws Error с raw текстом (`cron-tool.ts:255`/`:276`/`:228`, `web_search.ts` etc).
2. `src/agents/pi-tool-definition-adapter.ts:150-170` ловит Error, log'ает через `logError` (`[tools] X failed: <message>`), вызывает `buildToolExecutionErrorResult({ toolName, message })`.
3. `buildToolExecutionErrorResult` (`src/agents/pi-tool-definition-adapter.ts:83-93`) вызывает `sanitizeToolErrorForUser(params.message)` → если pattern не совпал, возвращается raw text. Получается JSON envelope `{ status: "error", tool: <name>, error: <raw> }`.
4. Этот envelope попадает в LLM context как `toolResult.content[0].text` + `details.error`.
5. LLM формулирует user reply, может echo'нуть error verbatim либо в JSON-форме, либо в prose («Не удалось: DuckDuckGo returned a bot-detection challenge.»).
6. Reply payload → `normalizePayloadsForChannelDelivery` (`src/infra/outbound/deliver.ts:370-400`) → HTML strip (`sanitizeForPlainText`) для plain-text channels → `deliverOutboundPayloads` → external channel.

**Между шагами 5 и 6 нет diagnostics-strip.** Это структурный gap, не bug. Текущая архитектура полагается на (a) permissive sanitizer (catches some), (b) prompt engineering («не упоминай tool errors дословно»), (c) удачу. Это не invariant, это эвристика.

**Defense-in-depth:** добавляем outbound-side sanitizer как **последний** gate. Он перехватывает leak независимо от его источника (LLM echo, прямая ошибка, debug-метки от kernel/decision/aggregation/provenance путей). Pattern-list curated на known internal-diagnostic markers, расширяется только под evidence.

## 4. Scope-of-fix matrix

| # | Layer | Файл | Изменение | LOC оценка | Invariant |
| - | ----- | ---- | --------- | ---------- | --------- |
| 1 | Sanitizer module | `src/infra/outbound/outbound-sanitizer.ts` (новый) | Curated `OUTBOUND_LEAK_PATTERNS` + `EXTERNAL_DELIVERY_SURFACES` enum + `sanitizeOutboundForExternalChannel(text, channel)` + `formatOutboundSanitizerLog(...)` telemetry helper. | ~150 | #5, #6 |
| 2 | Delivery integration | `src/infra/outbound/deliver.ts:370-400` (`normalizePayloadsForChannelDelivery`) | После `sanitizeForPlainText` вызвать `sanitizeOutboundForExternalChannel` для всех `EXTERNAL_DELIVERY_SURFACES`. На strip — log telemetry. Empty-после-strip → canonical fallback `"Запрос не удалось выполнить (детали в логах оператора)."` | ~30–50 | — |
| 3 | Tests — sanitizer pure | `src/infra/outbound/outbound-sanitizer.test.ts` (новый) | 12 кейсов (см. todo `tests-sanitizer-pure`) | ~120 | — |
| 4 | Tests — deliver integration | `src/infra/outbound/deliver.outbound-sanitizer.test.ts` (новый) ИЛИ дополнение к существующему `deliver.test.ts` | 6 кейсов (см. todo `tests-deliver-integration`) | ~80 | — |
| 5 | Telemetry & docs | `src/infra/outbound/outbound-sanitizer.ts` log lines + краткий блок в `docs/development/outbound.md` (если есть) | event `[outbound-sanitizer] event=stripped channel=<id> patterns=[<ids>] session=<key> bytes_before=<n> bytes_after=<n>` | ~20 | — |

**Patterns на старте (curated, расширяются только под evidence)**:

| patternId | regex | замена / strip | основание |
| --- | --- | --- | --- |
| `tool_error_marker` | `/^\s*\[tools\]\s+\S+\s+failed:.*$/gmu` | strip line | gateway log lines 470/481/491/348 |
| `tool_error_envelope` | `/\{\s*"status"\s*:\s*"error"\s*,\s*"tool"\s*:\s*"[^"]+"\s*,\s*"error"\s*:\s*"[^"]+"\s*\}/gu` | replace на `"(внутренняя ошибка инструмента; обработана)"` | session transcripts ed2b1839/3abbfc7a/ed92cfe6 |
| `task_classifier_marker` | `/^\s*\[task-classifier\][^\n]*$/gmu` | strip line | предполагаемый leak (kernel-trace dumps попадают в logs, могут быть echo'нуты) |
| `planner_marker` | `/^\s*\[planner\][^\n]*$/gmu` | strip line | то же |
| `provenance_guard_marker` | `/^\s*\[provenance-guard\][^\n]*$/gmu` | strip line | новый sanitizer (PR self-feedback-loop), не должен быть в external |
| `subagent_aggregation_marker` | `/^\s*\[subagent-aggregation\][^\n]*$/gmu` | strip line | новый sanitizer (PR aggregation), не должен быть в external |
| `debug_marker` | `/^\s*\[DEBUG[^\]]*\][^\n]*$/gmu` | strip line | исторический `[DEBUG ROUTING]` (PR-4a closed via G5), но новые debug-метки могут появиться; защита-by-default |
| `node_stack_trace` | `/^\s*at\s+\S+\s+\(.+:\d+:\d+\)\s*$/gmu` | strip line | Node stack trace lines — никогда не должны быть в external |
| `node_error_path` | `/at\s+(?:async\s+)?\S+\s+\(file:\/\/\/[^)]+\)/gu` | strip match | то же |

**Итого**: ~200–270 LOC кода + 200 LOC тестов = ~400–470 LOC, 4 файла. Превышает порог «<300 LOC, <5 files» → требует plan + signoff.

## 5. Acceptance criteria mapping

| Criterion | Закрывается через |
| --- | --- |
| 1. Никакие `[tools] X failed: ...`, `[task-classifier] ...`, `[planner] ...`, `[provenance-guard] ...`, `[subagent-aggregation] ...`, `[DEBUG ...]` markers не доходят до external channel. | §4 #1 + #2 + tests §4 #3, #4. |
| 2. Raw tool-error JSON envelope (`{"status":"error","tool":"X","error":"..."}`) в LLM-output не пропускается в external. | §4 #1 (`tool_error_envelope` pattern) + tests. |
| 3. Stack traces / `at file:///...:line:col` patterns не пропускаются. | §4 #1 (`node_stack_trace`/`node_error_path`) + tests. |
| 4. Internal channels (canvas/stdout/log) НЕ затрагиваются — diagnostics там нужны для отладки. | §4 #1 (`EXTERNAL_DELIVERY_SURFACES` whitelist) + tests `(c)`. |
| 5. HTML-sanitizer (`sanitizeForPlainText`) продолжает работать для plain-text channels — оба применяются последовательно. | tests §4 #4 `(e)`. |
| 6. Telemetry event `[outbound-sanitizer] event=stripped` emitted на каждый strip. | §4 #5 + tests `(d)`. |
| 7. Live TG smoke (todo `live-smoke-evidence`): провокация cron cross-session или web_search bot-detection → пользователь видит neutral copy («Запрос не удалось выполнить…») либо отсутствие raw-маркеров. | §4 #5 + manual smoke. |
| 8. `pnpm tsgo` + scoped tests green. | todo `tsgo-and-targeted-tests`. |

## 6. Handoff Log

### 2026-04-28 — Bootstrap audit

Что прочитано:

- Master plan §0 / §0.5 / §3 (16 hard invariants) / §8 / §13.4.
- `.cursor/rules/commitment-kernel-invariants.mdc`.
- Predecessor `commitment_kernel_self_feedback_loop_fix.plan.md` (provenance gate intact).
- Predecessor `commitment_kernel_subagent_result_aggregation.plan.md` (§8 — Bug E priority).
- Predecessor `commitment_kernel_pr4_chat_effects_cutover.plan.md` Wave A/B.
- Code:
  - `src/agents/tool-error-sanitizer.ts` (179 LOC) — full read; root cause line 174.
  - `src/agents/pi-tool-definition-adapter.ts` (217 LOC) — buildToolExecutionErrorResult line 83-93; tool-execute wrapper line 119-175.
  - `src/agents/pi-embedded-helpers/errors.ts` (945 LOC) — sanitizeUserFacingText line 644.
  - `src/auto-reply/reply/agent-runner-execution.ts` line 700-746 — pre-reply error fallback (использует userFacingToolPolicyOrTransientMessage).
  - `src/agents/tools/cron-tool.ts:225-280` — error throw sites.
  - `src/infra/outbound/deliver.ts` (full read first 80 lines + line 370-400 sanitization) — boundary point identified.
  - `src/infra/outbound/sanitize-text.ts` (64 LOC) — full read; HTML-only.
- Evidence:
  - Gateway log `C:\tmp\openclaw\openclaw-2026-04-28.log:348-351,470-471,481-482,491-492,642-643,653-658,670-671`.
  - Session transcripts `ed2b1839-*.jsonl:19`, `3abbfc7a-*.jsonl:7`, `ed92cfe6-*.jsonl:9,18,19,21` (raw tool-error JSON envelope в LLM context).

Подтверждено:

1. **Permissive fallback в `sanitizeToolErrorForUser`** — root cause TOOL→LLM leak (line 174 returns raw `normalized`).
2. **Нет outbound-side sanitizer** в `deliver.ts` — только HTML strip для plain-text channels.
3. **Internal-diagnostic markers** (`[tools]`, `[task-classifier]`, `[planner]`, `[provenance-guard]`, `[subagent-aggregation]`, `[DEBUG ...]`, raw JSON tool-error envelopes, stack traces) не имеют структурного gate'а на пути в external channel.
4. **Existing `sanitize-text.ts`** работает только на HTML-tags, не на diagnostics. Это правильное место для PARALLEL pass — НЕ совмещать с HTML logic, отдельный модуль.
5. **Preconditions для start coding**: gateway up (PID 27436, port 18789, `listening on ws://`), aggregation PR `6ca30ac6d3` committed locally на ветке `fix/orchestrator-subagent-aggregation`, не запушен.

Что НЕ сделано (по инструкции «stop and write plan»):

- Никаких правок кода, тестов, конфигов, `node_modules`. Никаких git stash/branch/worktree операций.
- Не запускал `pnpm tsgo` / `pnpm test` (нет смысла без правок).

Blockers / open questions для maintainer'а (Q1..Q5 self-check trigger fired — превышение `<300 LOC / <5 files` порог требует plan):

1. **Sanitization mode для tool-error envelope** — strip полностью либо replace на neutral marker «(внутренняя ошибка обработана)»? Рекомендую второе: даёт пользователю signal «что-то не получилось», не оставляет visual gap.
2. **Empty-after-sanitization fallback** — какой текст? Рекомендую «Запрос не удалось выполнить (детали в логах оператора).» или эквивалент — не raw, но и не silent omission.
3. **Pattern set на старте** — 9 patterns в §4 матрице. Расширять под evidence в follow-up PRs. Maintainer может добавить/убрать перед signoff.
4. **`sanitizeToolErrorForUser` Level 2 fix** — этот PR его НЕ делает. Хочется ли вообще убрать permissive fallback (LLM-context risk)? Future PR с A/B-rollout.
5. **Internal channels определение** — `canvas`/`stdout`/`log`. Что ещё? Maintainer решает финальный whitelist/blacklist.

Next recommended TODO id: `define-invariant` (ждёт signoff) → `implement-sanitizer-module` → `integrate-with-deliver` → tests → tsgo → live-smoke → human-signoff → final-docs-commit.

### 2026-04-29 — Implementation pass (Q1..Q5 signoff applied)

Maintainer signoff Q1..Q5 от 2026-04-28 применён без отклонений:

- **Q1**: `tool_error_envelope` → replace на `"(внутренняя ошибка инструмента; обработана)"` (`TOOL_ERROR_ENVELOPE_REPLACEMENT`); все line-markers → strip.
- **Q2**: empty-after-sanitization fallback = `"Запрос не удалось выполнить."` (без «оператора», нейтрально).
- **Q3**: 10 patterns шипнуты (9 базовых + `intent_ledger_marker`).
- **Q4**: Level 2 (`sanitizeToolErrorForUser` default-deny) НЕ в этом PR. Defense-in-depth: Level 1 (delivery boundary) гасит leak независимо от источника. Level 2 — future PR с A/B-rollout.
- **Q5**: `EXTERNAL_DELIVERY_SURFACES = {telegram, signal, whatsapp, slack, discord, sms, voice, imessage, googlechat}` как allowlist, остальные channels (включая built-in `irc`/`line` и любые plugin-каналы) → bypass. Внимание maintainer'а: `irc`/`line` — built-in external channels из `CHANNEL_IDS`; они НЕ в Q5 списке и пока bypass. Если требуется покрытие — отдельный follow-up PR с расширением allowlist + регрессионными тестами.

Реализация (4 файла, +569 / -1 LOC):

1. `src/infra/outbound/outbound-sanitizer.ts` (новый, +169 LOC) — 10 patterns + allowlist + sanitize fn + telemetry helper + fallback константы.
2. `src/infra/outbound/deliver.ts` (+34/-7 LOC) — импорты + integration в `normalizePayloadsForChannelDelivery` (после HTML strip) + проброс `sessionKeyForInternalHooks` в новый 4-й arg.
3. `src/infra/outbound/outbound-sanitizer.test.ts` (новый, +207 LOC) — 17 кейсов / 5 групп.
4. `src/infra/outbound/deliver.outbound-sanitizer.test.ts` (новый, +160 LOC) — 6 интеграционных кейсов на реальном `deliverOutboundPayloads`.

Гейты:

- `pnpm tsgo` → exit 0.
- `ReadLints` на 4 файла → clean.
- `pnpm test -- src/infra/outbound/outbound-sanitizer.test.ts --run` → 17/17 passed.
- `pnpm test -- src/infra/outbound/deliver.outbound-sanitizer.test.ts --run` → 6/6 passed.
- `pnpm test -- src/infra/outbound/ --run` → 448 passed / 2 skipped / 0 failed (44 файла).

Pending до merge:

- `live-smoke-evidence` — за оператором (TG провокация cron cross-session или web_search bot-detection; ожидаем neutral copy + ровно одно `[outbound-sanitizer]` событие в gateway log).
- `human-signoff` — invariant #15 (PR-level human signoff).
- `final-docs-commit` — обновление master §0 PR Progress Log с merge-SHA и пометкой E1-E4 closed.

Что НЕ сделано (по плану + signoff Q4):

- `sanitizeToolErrorForUser` остался permissive — Level 2 future PR.
- Bug A/C/D/F не тронуты (priority order from §8 unchanged).

## 7. References

- Master plan: `.cursor/plans/commitment_kernel_v1_master.plan.md`
- Hard invariants: `.cursor/rules/commitment-kernel-invariants.mdc`
- PR session bootstrap: `.cursor/rules/pr-session-bootstrap.mdc`
- Predecessor (depended on indirectly): `.cursor/plans/commitment_kernel_self_feedback_loop_fix.plan.md` (provenance gate)
- Predecessor (Bug E source): `.cursor/plans/commitment_kernel_subagent_result_aggregation.plan.md` (§8 priority order)
- Predecessor: `.cursor/plans/commitment_kernel_pr4_chat_effects_cutover.plan.md` Wave A/B
- Frozen call-sites (not touched): `src/platform/plugin.ts:80`, `:340`; `src/platform/decision/input.ts:444`, `:481`
- Frozen layer (not touched): `src/platform/commitment/**`
- Existing tool-side sanitizer (NOT touched in this PR): `src/agents/tool-error-sanitizer.ts`
- Existing HTML sanitizer (parallel boundary): `src/infra/outbound/sanitize-text.ts`
- Delivery boundary (where this PR plugs in): `src/infra/outbound/deliver.ts:370-400` `normalizePayloadsForChannelDelivery`
- Bug evidence: `C:\tmp\openclaw\openclaw-2026-04-28.log` + `~/.openclaw/agents/main/sessions/{ed2b1839,3abbfc7a,ed92cfe6}-*.jsonl`

## 8. Adjacent bugs (NOT in scope; tracked for future sub-plans)

Порядок строго по приоритету (сверху вниз — order-of-execution для следующих PR'ов после этого):

| Order | Bug | Симптом | Приоритет | Будущий sub-plan |
| ----- | --- | ------- | --------- | ----------------- |
| 1 | **C — Recipe routing для `intent=publish`** | Planner для `intent=publish` выбирает `integration_delivery` без `exec`/`site_pack`; на второй итерации правильный `ops_orchestration`. Ранний refusal до правильной recipe. | high (UX-blocker) | `commitment_kernel_recipe_routing_publish.plan.md` (TBD) |
| 2 | **A — Streaming-leak в external channel** | Tool-progress / intermediate assistant chunks утекают в TG как отдельные сообщения вместо буферизации в один final reply. | medium | `commitment_kernel_streaming_leak_fix.plan.md` (TBD) — частично смягчён aggregation-PR'ом, не полностью |
| 3 | **D — Ambiguity over-blocking** | Classifier помечает `hosting unspecified` как `blocking` даже когда юзер явно сказал «локально». | medium | часть `commitment_kernel_policy_gate_full.plan.md` (Master §8.5.1) |
| 4 | **F — Persistent worker subsequent push** | Cron-driven daily push'ы из persistent_worker'а в внешний канал. | medium | `commitment_kernel_persistent_worker_push.plan.md` (TBD) |
| 5 | **(Level 2)** | Tighten `sanitizeToolErrorForUser` permissive fallback (default-deny + structured generic copy). Trade-off: LLM recovery context risk. | low (defense-in-depth уже даёт Level 1) | future tightening PR; не блокирует ничего |

При работе по этому sub-plan'у НЕ ширить scope на A/C/D/F или Level 2. Если в ходе реализации обнаружится коррелированный баг — фиксировать в Handoff §6 и пинать maintainer'а перед расширением.
