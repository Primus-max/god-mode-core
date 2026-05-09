---
title: Diagnostic — 2026-05-08 — kernel slices wired but production deps not threaded
session: 2026-05-08-runtime-divergence-trace
trigger_evidence: gateway-dev-2026-05-07.log + /tmp/openclaw/openclaw-2026-05-07.log turn 78ff2b60 (Vladimir 21:20 «Удали лишних»)
isProject: false
---

# Diagnostic — kernel slices активны, но production deps не threaded

## Симптом (как видит Vladimir)

Turn-3 `78ff2b60` (intent=code, bundles=[repo_mutation], deliverable=workspace_change):

1. Bot выдал «Готово. Лишнее убрал, оставил только главного» — **враньё**
2. Через ~60 секунд: «Не могу честно подтвердить эту правку как корректную» — awakening
3. Двойное сообщение, противоречивое

Turn-1 (intent=general, bundles=session_orchestration): выдал 4 сообщения подряд, два из них — **chain-of-thought leak от Opus** («ser is asking about...», «on for agent management. Actually, I think...»).

## Diagnostic dump за turn 78ff2b60

| Гейт / Слайс | Должен был фирнуть | Реально фирнул |
|---|---|---|
| `[bundle-filter]` (Bundle-as-contract) | да | **✓ FIRED** — `removed_tools=[...] kept_tools=[apply_patch,write]` |
| `[evidence] promises/receipts/violations` | да | ⚠️ FIRED НО `receipts=1 violations=0 action=none` — фейково positive |
| `[broker] enqueued/dispatch/complete` (PR-MT) | да | **✗ DEAD CODE** |
| `[outbound-coalescer] event=committed/bypassed` (NEW-C) | да | **✗ DEAD CODE** |
| `[outbound-sanitizer] locale_filter` (NEW-D / Slice I) | да | **✗ DEAD CODE** |
| `[intent-contractor] memory.block / freshness.applied` | да | **✗ DEAD CODE** |
| `commitmentSatisfied` (Cutover-3/4 done-predicate) | да | **✗ нет упоминаний** |

Только bundle-filter активен на production path.

## Корень — единая точка расхождения

Файл: `src/auto-reply/reply/agent-runner.ts` строка `973`.

Вызов:
```ts
const runOutcome = await runAgentTurnWithFallback({
  commandBody,
  followupRun,
  sessionCtx,
  opts,
  // ... 20+ параметров
  sessionKey,
  // ...
});
// НЕТ identityId. НЕТ concurrentBroker. НЕТ memoryRuntime/taskLedger/observers.
```

Файл: `src/auto-reply/reply/agent-runner-execution.ts` строки `186-215`:
```ts
const broker = params.concurrentBroker ?? getProcessConcurrentTurnBroker();
const identityId = params.identityId;  // undefined ← caller не передаёт
// ...
const dispatchResult = await dispatchTurnViaBroker({
  broker: broker !== undefined && identityId !== undefined ? broker : undefined,  // ← broker forced to undefined
  // ...
});
```

`identityId === undefined` → conditional на 202 заставляет broker=undefined → `dispatchTurnViaBroker` идёт по bypass-пути → **никаких `[broker]` log lines**.

То же самое для других слайсов: deps wrapping есть в коде, но caller не передаёт нужные параметры → fallback к direct execution.

## Почему bot врёт «Готово, удалил»

Path:
1. `agent-runner.ts:973` → `runAgentTurnWithFallback` (без kernel deps)
2. → `runAgentTurnBody` → `attempt.ts` → LLM call (Opus 4.6)
3. LLM сгенерил text «Готово. Лишнее убрал». Outbound coalescer не wrap'нут вокруг этого пути → текст уходит в Telegram.
4. Bot **никогда не вызвал** `apply_patch` или `write` tool — bundle позволял, но LLM сгенерил answer, не tool_call.
5. `[evidence] receipts=1` — наверное registered receipt от system-event типа "intent classified", не реальный repo mutation receipt.
6. `commitmentSatisfied` done-predicate Cutover-4 (`repoOperationCompletedPredicate`) НЕ был evaluated потому что `monitoredRuntime` / `expectedDeltaResolver` не threaded в этот path.
7. Через 60s следующий turn (тот же session, может быть retry от worker'а) classifier пересчитал → conf=0.6 «не подтверждаю».

## Почему chain-of-thought от Opus leaks

Path:
1. Тот же путь — LLM выдаёт streaming chunks
2. `block-external-buffer` ловит structural tool calls, но **CoT-prefix preambles** ("ser is asking", "on for agent management") идут как regular text chunks
3. `OutboundCoalescer` (NEW-C) должен был wrap это в один final message и выкинуть intermediate, но coalescer wrapping не активен на этом emit-site
4. Telegram chunker режет преамбулы где попало → user видит обрывки

## Почему modality routing не сработал

Подтверждено отдельно: `~/.openclaw/agents/main/agent/models.json` объявляет ВСЕ модели `"input": ["text"]`. NEW-A modality filter получает `required=image,text` + 4 candidates все text-only → fail-open → `dropped=0`. Это НЕ bug в фильтре — это registry врёт.

## Минимальный fix-set (НЕ ещё один слайс)

### Fix 1 — thread identityId (1 файл, ~5 строк)

`src/auto-reply/reply/agent-runner.ts:973` — резолвить identityId из sessionKey и передать.

Helper уже существует: `resolveIdentityFromSessionKey(sessionKey, registry)` (использован в `memory-wiring.ts:171`). Просто скопировать пользование.

После этого:
- ✓ `[broker]` log lines появятся
- ✓ Same-`(identity, channel)` FIFO заработает
- ✓ Cross-identity isolation real

### Fix 2 — thread runtime (memoryRuntime, taskLedger, observers) (1 файл, ~10 строк)

Тот же `agent-runner.ts:973` — передать deps через `runAgentTurnWithFallback`. Source: уже резолвлено в `buildClassifiedExecutionDecisionInput` через `runTurnDecision`. Просто прокинуть в caller.

После этого:
- ✓ `commitmentSatisfied` done-predicate активируется
- ✓ Bot не сможет вернуть «Готово» без tool_call evidence
- ✓ Cutover-4 repo affordance заработает — bot либо реально вызовет `apply_patch`, либо вернёт `cannot_complete`

### Fix 3 — wire OutboundCoalescer вокруг attempt streaming (1 файл, ~20 строк)

`src/agents/pi-embedded-runner/run/attempt.ts` — в emit-site streaming chunks обернуть в coalescer registration. Today coalescer wired только на `agent-runner-execution` финальные replies, но **streaming intermediate chunks** идут мимо.

После этого:
- ✓ CoT leak от Opus подавится (intermediate flushes консолидируются в final)
- ✓ Double-message исчезнет

### Fix 4 — registry правка (1 файл, 7 моделей × 1 строка)

`~/.openclaw/agents/main/agent/models.json` — добавить `"image"` в `input` для:
- gpt-5.4 (line 316)
- gpt-4o (163)
- gpt-5-mini (197)
- gemini-2.5-pro (299)
- claude-sonnet-4.6 (265)
- claude-opus-4.6 (350)
- grok-4 (333)

После этого:
- ✓ NEW-A modality filter получит реальный survivors set
- ✓ Image attachments дойдут до vision-capable моделей

## Scope summary

4 концентрированных fix'а на 4 файлах, ~40 LOC. Не ещё один слайс, не 7 фаз.

После этого все слайсы которые я "закрывал" эту сессию (Freshness / Bug F / Bundle-as-contract / PR-MT / NEW-A/B/C/D / Slice K / Cron / Slice H) РЕАЛЬНО активируются на production turns. Без этих fix'ов 5/6 живут как dead code.

## Что НЕ делать

- НЕ revert закрытых слайсов
- НЕ trogать openclaw.json
- НЕ переписывать legacy classifier целиком
- НЕ "ещё один слайс" с фазами

## Honest acknowledgement

Этот разрыв был не виден в acceptance-фикстурах потому что фикстуры вызывают `runTurnDecision` напрямую (см. `b7-replay.acceptance.test.ts`, `slice-k-reminder.acceptance.test.ts` etc.). Production path к `runAgentTurnWithFallback` идёт через другую ветку и я не покрыл integration end-to-end. Это ошибка покрытия, не архитектуры. Сами слайсы корректны.
