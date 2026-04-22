# Orchestrator v1.1 — P1.7 (post-P1.6 architectural follow-ups, 2026-04-22)

**Мастер-план:** `orchestrator_v1_1_master.plan.md` (см. §0/§2/§4 п.6/§8).
**Статус:** IN_PROGRESS.
**Триггер:** второй ручной Telegram-смоук 2026-04-22 поздний вечер показал,
что P1.6.3 (idempotency через 60s preflight в runner'е) — **архитектурно
неверный мазок сбоку от существующих примитивов**. Заодно зафиксированы три
deferred-UX пункта (A/B/C) и новый E (reminder ≠ external_delivery).

---

## Главный инвариант P1.7 — Inventory before invent

Любая задача из P1.7 начинается с **явного перечисления существующих
примитивов**, которые могли бы её решить, и обоснования: либо «расширяем
этот примитив» (предпочтительно), либо «добавляем новое, потому что
существующее НЕ способно дать <X> по причине <Y>».

Стоп-список «новое сбоку» (повтор §4 п.6 master plan):

- свой TTL/окно поверх `IntentLedger` (там уже 15 мин);
- свой preflight в runner'е поверх `evidence-sufficiency`;
- свой scheduler поверх `FollowupQueue`;
- свой pub/sub поверх `ProgressBus`;
- per-kind исключения вместо общего state-предиката.

---

## P1.7-D — Idempotency через `priorEvidence` в `evidence-sufficiency` [PRIORITY 1]

### Симптом (живой лог 2026-04-22 21:07–21:23)

- 21:21 «подними сервер kitty-banana» → 21:23 «уже поднят: 5174» ✅
  (preflight P1.6.3 сработал, окно ≤60s).
- 21:23 (через >60s после первого подъёма) — сразу следом «Сервер поднят:
  5175» ❌ — вне окна, поэтому preflight промахнулся, и runner запустил
  новый процесс. Окно ≠ состояние мира.

### Корневой диагноз

P1.6.3 кладёт ленту проверки **перед** runner'ом, не **внутрь**
`evidence-sufficiency.evaluate`. Поэтому:

1. Дублируется TTL: `IntentLedger` уже хранит receipts 15 мин, а P1.6.3
   ввёл свой `OPENCLAW_INTENT_IDEMPOTENCY_WINDOW_MS=60000`.
2. Дублируется концепт «обещано/выполнено»:
   `reconcilePromisesWithReceipts` уже отвечает на этот вопрос для
   текущего turn'а — но не умеет смотреть «а есть ли уже в мире живое
   доказательство, что действие выполнять не надо».
3. `evidence-sufficiency.evaluate` смотрит только на receipts текущего
   run'а — у неё нет аргумента `priorEvidence`.

### Inventory (что уже есть)

| Примитив                                           | Что умеет                                                        | Чего НЕ хватает для P1.7-D                          |
| -------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------- |
| `src/platform/session/intent-ledger.ts`            | TTL=15m, `successfulReceipts`, `fingerprint`, `lookupRecentReceipt` | ничего — это и есть **первый probe**                |
| `src/platform/session/intent-fingerprint.ts`       | deterministic fingerprint от `deliverable + capabilities`        | ничего — это сквозной идентификатор                 |
| `src/platform/runtime/evidence-sufficiency.ts`     | `evaluate(receipts, contract)` для текущего run'а                | новый аргумент `priorEvidence?: PriorEvidenceProbe[]` |
| `src/platform/session/execution-evidence.ts`       | `reconcilePromisesWithReceipts(promises, receipts)`              | повторно используется как есть                      |
| `src/auto-reply/reply/agent-runner-execution.ts`   | runner-preflight (P1.6.3)                                        | **снимается** — заменяется evidence-driven путём    |

### Что делаем (минимум)

1. [x] Расширить сигнатуру `evidence-sufficiency.evaluate(...)` опциональным
   `priorEvidence`; в коде оставлен минимальный локальный контракт
   `PriorEvidenceProbe = { kind: "ledger"; receipts: PlatformRuntimeExecutionReceipt[] }`.
2. [x] Реализовать **только один** probe в этой итерации:
   `buildLedgerPriorEvidence(...)` читает `IntentLedger.lookupRecentReceipt(...)`
   **без своего windowMs**, то есть живёт на родном TTL ledger'а (15m).
3. [x] В `runtime/service.ts` пробросить `priorEvidence` в
   `verifyExecutionContract(...)` и `evaluateAcceptance(...)`, чтобы
   sufficiency считался по единому effective receipt list.
4. [x] Runtime-driven short-circuit: ранний путь перенесён в
   `src/agents/pi-embedded-runner/run.ts`, где решение принимает
   `isCompletionEvidenceSufficient(... priorEvidence ...)`; при
   `sufficiencyReason="prior_evidence"` reply-tube получает
   `Уже сделано: <url|PID|path>`.
5. [x] Снять preflight `lookupRecentReceipt` из
   `src/auto-reply/reply/agent-runner-execution.ts`; env
   `OPENCLAW_INTENT_IDEMPOTENCY_WINDOW_MS` больше не читается на execution path.
   `computeIntentFingerprint(...)` и `lookupRecentReceipt(...)` сохранены для
   ledger probe / P1.7-B / логов.
6. [x] Никакой новой «свежести» поверх ledger TTL не введено.

### Acceptance

- Unit:
  - `evidence-sufficiency.test.ts` — кейс «нет receipts текущего run'а,
    но `priorEvidence` от ledger probe'а возвращает успешный
    exec-receipt того же fingerprint'а → `satisfied=true`».
  - `evidence-sufficiency.test.ts` — кейс «без `priorEvidence` поведение
    идентично текущему baseline'у».
  - `agent-runner-execution.test.ts` — preflight short-circuit удалён;
    «уже сделано» теперь приходит из runtime, не из runner'а.
- Live:
  - `20-intent-idempotency` остаётся PASS (просто решение лежит в
    другом слое).
  - Новый ручной чек: «подними сервер X» → ждём 5 минут → «подними
    сервер X» → отвечает «уже поднят: <url>», без нового
    `progress.frame phase=tool_call toolName=exec`. До 15 мин включительно.
- Vocabulary: ни одного нового `outcome` / `deliverable.kind` /
  `strategy`. Никакого нового env. `priorEvidence` — внутренний контракт
  одного модуля.

### Файлы (ожидаемо)

- `src/platform/runtime/evidence-sufficiency.ts` — новый параметр
  `priorEvidence`.
- `src/platform/runtime/service.ts` — пробрасывает probe'ы в `evaluate`.
- `src/platform/runtime/prior-evidence/ledger-probe.ts` (новый, тонкий
  адаптер: ledger → `Receipt[]`).
- `src/auto-reply/reply/agent-runner-execution.ts` — удаление
  preflight-ветки.
- Тесты по затронутым файлам + live ручной чек на >60s окне.

---

## P1.7-E — Reminder = существующий cron-tool (routing fix, без новой инфраструктуры) [PRIORITY 2]

### Симптом (живой лог 2026-04-22 21:09–21:23)

- 21:09 «Напомни завтра в 12:00 поесть» → классификатор:
  `external_delivery·tool_execution·0.36 · deliverable=external_delivery/receipt`,
  бот отвечает «нет интеграции для будущей отправки».
- 21:21 «Сюда, прямо в чате напиши пожалуйста, напомни» → бот всё равно
  пишет «нет планировщика».

### Корневой диагноз — это **чистый routing-баг**, не дыра в инфраструктуре

OpenClaw уже **полностью встроен в cron**:

- `src/cron/service*.ts` — cron-демон со store, рестартами, heartbeat,
  таймерами, persistent state.
- `src/agents/tools/cron-tool.ts` — agent-tool с actions
  `status / list / add / update / remove / run / runs / wake` и явными
  `REMINDER_CONTEXT_*` константами; уже умеет one-shot reminder через
  `cron add` с расписанием на конкретное время.
- `src/cli/cron-cli.ts`, `src/gateway/server-methods/cron.ts`,
  `src/gateway/protocol/schema/cron.ts` — CLI + gateway-методы +
  protocol-схемы.
- `src/auto-reply/reply/agent-runner-reminder-guard.ts` — **уже
  существующий** guard конкретно для reminder-сценариев.

То есть «нет планировщика» — это **галлюцинация модели**, а
`external_delivery·tool_execution` — **ошибка classifier'а**: он не
направил к `cron-tool`. Никакой `FollowupQueue + runAt + persistent
storage` городить НЕ нужно — это было бы прямым нарушением §4 п.6
«Inventory before invent».

### Inventory (что есть и что используем)

| Примитив                                          | Что умеет                                                                       | Что нужно сделать                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/cron/service*.ts`                            | persistent cron + таймеры + рестарт-catchup                                     | ничего — используем как есть                                                      |
| `src/agents/tools/cron-tool.ts`                   | agent-tool `add/list/remove/run/...`, REMINDER_CONTEXT_* константы              | ничего — это и есть scheduler для reminder'ов                                     |
| `src/auto-reply/reply/agent-runner-reminder-guard.ts` | defensive guard: дописывает note, когда модель пообещала reminder без cron-job | **не трогаем** — после фикса classifier'а cron-job создастся и guard не сработает |
| `src/agents/pi-tools.policy.ts`, `system-prompt.ts` | tool `cron` (имя строго `cron`, не `cron-tool`) уже в allow-листе и в prompt'е | ничего — доступен из коробки                                                      |
| classifier `pi-simple/hydra/gpt-5-mini`           | `respond_only` / `tool_execution` / `clarify_first`                             | **routing fix**: «напомни …» → `tool_execution` + `requestedTools=["cron"]`, **не** `external_delivery` |

### Что делаем (минимум)

1. **Не трогаем** `FollowupQueue`, не вводим `runAt`, не пишем persistent
   storage, не вводим новый outcome/kind/strategy. Cron уже всё это
   делает.
2. В classifier-prompt (`src/platform/decision/task-classifier.ts`)
   добавить **один** guidance-параграф:
   «Напоминания (`напомни …`, `reminder …`, явная дата/время в будущем
   и просьба что-то сообщить позже) — это `tool_execution` с
   `requestedTools=["cron"]`, **не** `external_delivery`.
   `external_delivery` — только для интеграций с внешним провайдером
   (Bybit/OpenAI/telegram_userbot и т.п.), не для отложенного сообщения
   в текущий канал».
3. Tool `cron` уже в `pi-tools.policy.ts` и `system-prompt.ts` — ничего
   расширять не нужно.
4. **Reminder-guard НЕ трогаем.** Это defensive fallback на случай, когда
   модель пообещала reminder, но не вызвала cron. После фикса classifier'а
   cron-job будет создаваться → обещание становится «backed» → guard
   вообще не срабатывает. Расширять его RU-regex'ами — плодить пластырь,
   который не нужен после корневого фикса (по духу §4 п.1 «zero parsing»).
5. Unit-кейс в `task-classifier.test.ts` на «напомни завтра
   в чат пообедать» → ожидаем `tool_execution` + `requestedTools=["cron"]`.
6. Live сценарий `21-reminder-via-cron` в `scripts/live-routing-smoke.mjs`:
   user → «напомни через 30 секунд тестовое сообщение» → бот сам
   вызывает `cron action=add` → через 30s приходит сообщение в
   тот же канал.

### Acceptance

- Unit: `task-classifier.test.ts` — reminder-кейс уходит в
  `tool_execution` + `requestedTools=["cron"]`, не в `external_delivery`.
  Никакого нового vocabulary.
- Live: `21-reminder-via-cron` PASS (один real cron-job, одно сообщение
  в чат через окно, без галлюцинации «нет планировщика»).
- Код: нулевой объём новой инфраструктуры. Только classifier-prompt +
  один unit-кейс + один live-сценарий. Reminder-guard не трогается.

### Файлы (ожидаемо)

- `src/platform/decision/task-classifier.ts` — guidance в prompt.
- `src/platform/decision/task-classifier.test.ts` — reminder-кейс.
- `scripts/live-routing-smoke.mjs` — `21-reminder-via-cron`.

### Координация с P1.7-D

P1.7-D сейчас в работе у другого агента (правит
`src/platform/runtime/evidence-sufficiency.ts` + `service.ts` +
`auto-reply/reply/agent-runner-execution.ts` + новый
`src/platform/runtime/prior-evidence/`). **Пересечений с P1.7-E нет**:
P1.7-E трогает только `src/platform/decision/task-classifier.ts`,
`src/auto-reply/reply/agent-runner-reminder-guard.ts`, тесты рядом,
`scripts/live-routing-smoke.mjs`. Можно делать параллельно.

---

## P1.7-A — Channel-agnostic `inReplyTo` в progress-event [PRIORITY 3]

**Inventory.** `ProgressBus` уже эмитит `progress.frame` per turn;
Telegram-плагин получает frames через bridge. Нужен только **новый
опциональный ключ** `inReplyTo` в frame'е (mapped to `reply_to_message_id`
в TG, в Max — thread reply, в UI — anchor). Без новых enum'ов / kind'ов.
Без channel-specific логики в `platform/`.

**Что делаем.** Прокинуть `incomingMessageId` через runner → emitter →
frame; адаптеры читают и применяют согласно своим API.

---

## P1.7-B — Coalescing same-intent в одном `lane` по `intent-fingerprint`

**Inventory.** `intent-fingerprint` уже есть (P1.6.3). `FollowupQueue`
поддерживает `dedupe`. Новое: при enqueue с уже бегущим job'ом того же
fingerprint'а — не enqueue, ack «уже выполняю». Это **сериализация по
ключу**, не дедуп по часам.

**Что делаем.** Расширить `dedupe`-policy по `intentFingerprint`. Снять
проблему «5 одновременных «подними сервер»» в одной очереди без всяких
окон.

---

## P1.7-C — Warm restart oversized session

**Inventory.** Существующий cold-start path при `Oversized direct
session`. Нужен warm path: компактный summary (через уже имеющийся
`task-classifier` + один сервисный turn) вместо пустого нового context'а.

---

## Verify (общий чек после каждого подэтапа)

```powershell
pnpm vitest run src/platform/runtime src/platform/session src/auto-reply/reply
pnpm lint:routing:no-prompt-parsing
pnpm live:routing:smoke
```

---

## History

- 2026-04-22 (поздний вечер) — план создан после второго ручного
  Telegram-смоука. Триггер: P1.6.3 преfлайт перестаёт защищать на >60s,
  reminder уходит в `external_delivery`, ledger пишет, но
  evidence-sufficiency его не читает. Решение — `priorEvidence` в
  `evidence-sufficiency` (P1.7-D) и scheduled reuse `FollowupQueue`
  (P1.7-E). Inventory принципиально предшествует реализации (§4 п.6
  master plan).
- 2026-04-22 (поздний вечер, правка по фидбеку) — **P1.7-E переписан**
  после явного указания пользователя: OpenClaw уже имеет полноценный
  встроенный cron (`src/cron/service*.ts`, `src/agents/tools/cron-tool.ts`
  с REMINDER_CONTEXT_*, gateway-методы, CLI, protocol-схемы,
  `agent-runner-reminder-guard.ts`). Никакого расширения `FollowupQueue`
  и persistent storage. Reminder = **routing fix в classifier**: «напомни
  …» → `tool_execution` + `requestedTools=["cron-tool"]`. Это прямое
  применение §4 п.6 «Inventory before invent» — было нарушением
  предлагать новый scheduler при наличии полного cron-stack'а.
- 2026-04-22 — **P1.7-D реализован в коде**. Сделано: локальный
  `PriorEvidenceProbe` в `src/platform/runtime/evidence-sufficiency.ts`,
  объединение current receipts + `priorEvidence[*].receipts` в единый
  effective list без time-window логики, `sufficiencyReason` с явным
  `prior_evidence`; новый тонкий адаптер
  `src/platform/runtime/prior-evidence/ledger-probe.ts` (ledger TTL=15m,
  без нового env/TTL), shared util
  `src/platform/runtime/prior-evidence/already-done-reply.ts`.
  `src/platform/runtime/service.ts` теперь принимает/proxy'т
  `priorEvidence` в verification/acceptance, а ранний short-circuit
  перенесён из runner-preflight в `src/agents/pi-embedded-runner/run.ts`,
  где решение принимает runtime predicate. В
  `src/auto-reply/reply/agent-runner-execution.ts` удалён preflight
  `lookupRecentReceipt` и чтение
  `OPENCLAW_INTENT_IDEMPOTENCY_WINDOW_MS`. Тесты: новые targeted кейсы в
  `evidence-sufficiency.test.ts`, `service.test.ts`,
  `agent-runner.misc.runreplyagent.test.ts` зелёные; общий targeted
  `pnpm vitest run src/platform/runtime/evidence-sufficiency.test.ts
  src/platform/runtime/service.test.ts src/auto-reply/reply/agent-runner.misc.runreplyagent.test.ts
  src/platform/session/intent-ledger.test.ts` упирается в 1 pre-existing
  failure `claude-cli routing > uses claude-cli runner for claude-cli provider`
  вне scope P1.7-D. `pnpm lint:routing:no-prompt-parsing` ✅. Live
  `SMOKE_ONLY=20-intent-idempotency pnpm live:routing:smoke` в текущем
  окружении не подтвердился: scenario SKIP из-за `gateway token mismatch`
  и `OPENCLAW_WORKSPACE_ROOTS=<unset>`, то есть acceptance live требует
  повторного прогона в валидно сконфигурированном gateway.
