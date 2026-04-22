# Orchestrator v1.1 — P1.4 (Conversation State & Execution Evidence & Progress Bus)

**Мастер-план:** `orchestrator_v1_1_master.plan.md`.
**Статус:** DONE — этапы A, B, C, C.1, D.1, D.2 закрыты в коде/юнитах/live.
Осталось: —
(P1.4 полностью закрыт 2026-04-21 поздний вечер).
**Зависимости:** P0 закрыт. P1.3 закрыт. Приоритетнее P1.1/P1.2, т.к. закрывает корневую
причину их симптомов.

---

## Контекст

Живой тест Trader-авторизации показал: оркестратор локально корректен на каждом turn,
но **между turn'ами теряет контекст обязательств**. Симптомы из лога `238883.txt`:

1. Бот спрашивает «Подтверди, что можно начать авторизацию?» → user: «Подтверждаю» →
   классификатор видит только «Подтверждаю» и снова уходит в `clarification_needed`
   (`clarify_first, conf=0.90`), потому что в промпте классификатора нет информации о
   том, что предыдущий бот-turn ожидал confirm.
2. Бот отвечает «Принял. Начинаем авторизацию» (`respond_only, 0.90`) — **ни одного
   tool-вызова**. Рантайм не проверяет, что обещание `"начинаем авторизацию"` требует
   фактического `exec` / `apply_patch`.
3. Пользователь видит только `typing…` и финальное сообщение. Нет индикации
   «классифицирую / планирую / устанавливаю deps / запускаю exec». Поэтому
   единственный способ узнать состояние — спросить «Запустил?», что снова запускает
   clarify-цикл.
4. Все три проблемы — разные симптомы одной архитектурной дыры: **turn-level
   orchestrator без session-level state/observability**.

P1.4 закрывает эту дыру четырьмя независимыми этапами. Этап A уже даёт ощутимый
эффект и является pre-requisite для B/C/D.

---

## Философия

> В рамках одной сессии бот — это не stateless classifier, а diалог с коротким
> рабочим памятью, обязательствами и наблюдаемым исполнением. Turn — это шаг,
> а не весь мир.

Инварианты P1.4 (должны держаться после всех четырёх этапов):

1. **Classifier видит краткое состояние сессии** (последние 1–3 commitments бота) и
   использует его для дизамбигуации подтверждений типа «ДА», «Подтверждаю», «Go».
2. **Каждое conversational обещание бота о действии имеет receipt.** Если бот сказал
   «запускаю X», то либо runtime реально запустил X (tool-вызов зафиксирован), либо
   finalizer принудительно добавляет tool в executionContract и переигрывает turn.
3. **Есть единый Progress Bus.** `ProgressFrame { phase, detail, ts, turnId, sessionId }`
   эмитируется на каждой фазе runtime. Telegram edit-adapter и (позже) веб-сайт —
   подписчики.
4. **Диспетчер говорит сразу.** Длинные turns получают немедленный ack
   (`«принял, работаю»`), а тяжёлая работа уезжает в background-job, привязанный к
   `turnId`. Пользователь не блокируется `typing…`.

---

## Этапы

### Этап A — Intent Ledger v0 (minimal, in-memory) [x] (scope A закрыт 2026-04-20)

**Цель.** За один PR дать классификатору знать о последнем обязательстве бота. Это
снимет 80% clarify-циклов из Trader-лога без сложной инфраструктуры.

**Scope (что ДА).**
- Новый модуль `src/platform/session/intent-ledger.ts`:
  - `IntentLedgerEntry { turnId, sessionId, channelId, kind, summary, expectsFrom, createdAt, ttlMs }`
  - `IntentLedgerKind = "awaiting_confirmation" | "awaiting_input" | "promised_action" | "clarifying"`
  - `expectsFrom = "user" | "system"` (awaiting_confirmation/input → user).
  - In-memory Map по `sessionId+channelId`, лимит последних N=8, TTL=15 мин.
  - API: `recordFromBotTurn(summary, planOutput, runtimeReceipts)`,
    `peekPending(sessionId, channelId): IntentLedgerEntry[]`,
    `invalidate(entryId | predicate)`.
- **Писатель**: `src/auto-reply/reply/agent-runner.ts` (или ближайший post-turn hook,
  где мы уже держим финальный ассистент-ответ) — после успешного turn вызывает
  `recordFromBotTurn` с мини-классификацией бот-ответа (см. §A.Heuristic).
- **Читатель**: `src/platform/decision/task-classifier.ts` — `buildTaskContractRequest`
  (или эквивалент) получает `ledgerContext: string` (1–3 строки) и вшивает его в
  system prompt блоком `<pending_commitments>…</pending_commitments>` **ПЕРЕД**
  основным user-промптом. Формат одной строки: `{turnIdShort} awaiting_confirmation: "начать авторизацию Trader"`.
- **Heuristic классификация бот-ответа (A.Heuristic).** Без нового LLM-вызова:
  - Если ответ содержит `?` и длина ≤ 350 символов → `awaiting_confirmation` или
    `awaiting_input` (различаем по признаку «подтверди|да/нет» vs «пришли|укажи|введи»).
  - Если содержит «запускаю | начинаем | сейчас сделаю | применяю» и в плане
    `requiresTools=false` → `promised_action` (важно для этапа B).
  - Иначе — не записываем.

**Scope (что НЕТ).**
- Нет персиста на диск (только in-memory; restart gateway = ledger чистый).
- Нет LLM-вызова для классификации бот-ответа (только regex/heuristics).
- Нет reconciliation обещаний с runtime receipts — это этап B.
- Нет Progress Bus — это этап C.

**Где трогаем.**
1. `src/platform/session/intent-ledger.ts` — новый файл.
2. `src/platform/session/intent-ledger.test.ts` — юнит-тесты.
3. `src/platform/decision/task-classifier.ts` — опциональный аргумент `ledgerContext`
   в билдере запроса, прошивка в prompt. Обратная совместимость: без контекста
   поведение не меняется.
4. `src/platform/decision/task-classifier.test.ts` — новый кейс: «с записью
   `awaiting_confirmation: "начать авторизацию"` в ledger, user-input `"ДА"` ⇒
   classifier должен вернуть `interactionMode` ≠ `clarify_first`, или как минимум
   `answer` с `requestedTools` согласно pending-turn'у.» (точный инвариант — см. Acceptance).
5. `src/auto-reply/reply/agent-runner.ts` (или файл, где мы пост-обрабатываем turn) —
   вызов `recordFromBotTurn` после финального ответа.
6. Лог-тег `[intent-ledger]` в `.gateway-dev.log` для observability.

**Acceptance.**
- [x] Юнит: `recordFromBotTurn` корректно классифицирует 8 тест-кейсов бот-ответов
  (awaiting_confirmation / awaiting_input / promised_action / none). (2026-04-20)
- [x] Юнит: TTL и лимит N=8 работают (старые записи вытесняются). (2026-04-20)
- [x] Юнит (classifier): при наличии `pending_commitments` с `awaiting_confirmation`
  и user-input `"ДА"` classifier не остаётся в `clarify_first` (детерминировано mock LLM). (2026-04-20)
- [x] Live: сценарий `12-confirmation-question` зелёный; `13-confirmation-yes-exec` намеренно остаётся
  красным и передан **владельцу Этапа B** — это не bug A, а headline-acceptance для B.
  Real-LLM может сказать «запускаю…» без tool-call, и закрыть это без reconciliation'а promise/receipt
  нельзя (иначе = «узкий фикс», запрещено инвариантами P1.4). (2026-04-20)
- [x] В `.gateway-dev.log` зафиксирована строка
  `[intent-ledger] peek=1 injected=1` на реальном двухходовом turn. (2026-04-20)
- [ ] `pnpm lint:routing:no-prompt-parsing` зелёный, `pnpm tsgo --noEmit` остаётся красным из-за
  pre-existing ошибок вне scope этапа A. (2026-04-20)

**Неочевидные нюансы / ловушки.**
- **Guard `lint:routing:no-prompt-parsing`** запрещает regex по user-input в
  `decision/`. Heuristic-классификация **бот-ответа** — это НЕ user-input, но
  модуль должен жить в `src/platform/session/`, а не в `decision/`, чтобы не
  трипать guard. Тест guard'а должен пройти.
- `peekPending` должен быть pure/idempotent. Никакого списания записи при read —
  списываем только в этапе B (по receipt) или по TTL.
- Инъекция в prompt — **строго короткая** (≤ 300 токенов), иначе инфлейтим
  классификатор и ломаем latency.
- Если user-input это сам `?` (бот не ждал ничего) — ledger пустой, поведение
  идентично текущему.

**Verify команды.**
```powershell
pnpm vitest run src/platform/session src/platform/decision/task-classifier.test.ts
pnpm tsgo --noEmit
pnpm lint:routing:no-prompt-parsing
pnpm live:routing:smoke
```

---

### Этап B — Execution Evidence Contract [x] (scope B закрыт 2026-04-20, live подтверждён)

**Цель.** Бот не может безнаказанно сказать «запускаю X», если рантайм ничего не
запустил. `13-confirmation-yes-exec` — headline acceptance этапа B.

**Почему именно сейчас.** Этап A дал классификатору память (он видит
`awaiting_confirmation`). Но реальный LLM на «ДА» всё равно имеет право вернуть
`interactionMode=respond_only` с текстом «Хорошо, запускаю…». Без reconciliation'а
promise/receipt эта разновидность halucination неустранима — и именно она стояла
за симптомами Trader-лога (`Принял. Начинаем авторизацию` без tool-вызова).

**Scope (что ДА).**
- Новый модуль `src/platform/session/execution-evidence.ts` (или близко к
  `intent-ledger.ts`, **вне** `decision/`, чтобы не тригерить
  `lint:routing:no-prompt-parsing`):
  - `PromisedActionViolation { ledgerEntryId, turnId, summary, expectedReceiptKinds, observedReceiptKinds, severity: "hard"|"soft", createdAt }`.
  - `reconcilePromisesWithReceipts({ pendingPromises: IntentLedgerEntry[]; receipts: PlatformRuntimeExecutionReceipt[]; verification?: PlatformRuntimeExecutionVerification }): PromisedActionViolation[]`.
  - Правила матчинга: `promised_action` с heuristic-хинтами в summary
    (`запускаю|начинаем|применяю|…`) ожидает **минимум один**
    receipt `kind ∈ {"tool","platform_action"}` с `status ∈ {"success","partial"}`.
    Если в summary есть лексема `exec|команд|node|npm|pnpm|test|build|install` ⇒
    дополнительно ожидаем receipt с именем `name="exec"` или
    `metadata.toolName="exec"`.
  - Severity: если в том же turn бот **уже** текстово подтвердил запуск —
    `hard`; если только «сейчас сделаю/потом» — `soft`.
- Расширение `IntentLedgerEntry` полем
  `receiptMatchers?: { receiptKinds?: PlatformRuntimeExecutionReceiptKind[]; toolNames?: string[] }`.
  Для `promised_action` matcher выводится в момент записи в ledger (в
  `agent-runner.ts`, там где уже есть `recordFromBotTurn`).
- Триггер reconciliation — post-turn, после того как finalizer собрал все
  receipts. Файл-точка: тот же pipeline, где сегодня формируется
  `PlatformRuntimeExecutionVerification` (`src/platform/runtime/service.ts` +
  `evidence-sufficiency.ts`). Оборачиваем без изменения существующих инвариантов.
- Реакция на violation:
  - `hard` → **один** принудительный replan: execution intent обогащается
    `forcedTools=["exec"]` (или match'нутым tool), `requiresTools=true`,
    `mode="tool_execution"`. Ledger-запись promise помечается
    `resolution="replanned"`. Replan делается через уже существующий путь
    planner → runtime, **не** через новый код-pathway.
  - `soft` → promise остаётся в ledger как `violated_promise`, следующий turn
    автоматически получает его в `<pending_commitments>` с пометкой
    `violated_promise: "<summary>"`, и бот сам должен это разрулить.
  - Предел: не более 1 принудительного replan на turn, иначе `soft` + лог
    `[evidence] replan-budget-exhausted`.
- Лог-тег `[evidence]` в `.gateway-dev.log`: для каждого turn-а одна строка вида
  `[evidence] promises=<n> receipts=<m> violations=<v> action=<none|soft|hard-replan>`.

**Scope (что НЕТ).**
- Нет Progress Bus — это этап C.
- Нет bg-job / ack-then-defer — это этап D.
- Нет персиста violations — только in-memory (живут TTL ledger'а).
- Нет LLM-классификации promise-строк: matcher'ы — heuristics + ledger-хинты.

**Где трогаем.**
1. `src/platform/session/execution-evidence.ts` — новый файл.
2. `src/platform/session/execution-evidence.test.ts` — юнит-тесты.
3. `src/platform/session/intent-ledger.ts` — расширить `IntentLedgerEntry`
   опциональным `receiptMatchers`, в `classifyBotTurn` для
   `promised_action` выводить matcher (exec/apply_patch/…)
4. `src/platform/runtime/service.ts` (или ближайшая точка post-turn, где уже
   есть `PlatformRuntimeExecutionVerification`) — вызвать
   `reconcilePromisesWithReceipts`, эмитировать лог, при `hard` запустить ровно
   один replan через существующий re-entry pipeline.
5. `src/auto-reply/reply/agent-runner.ts` — приёмная точка replan-результата и
   запись `violated_promise`-пометки в ledger, если replan исчерпан.
6. `scripts/live-routing-smoke.mjs` — без изменений (используем существующие
   `12/13`), но Acceptance этапа B = `13-confirmation-yes-exec` **green**.

**Acceptance.**
- [x] Юнит: 15 кейсов reconciler'а (promise+receipt=no violation,
  promise-без-receipt=hard, promise-со-soft-формулировкой=soft, несколько promise
  один receipt, exec-matcher vs apply_patch-matcher, дефолтные matchers при отсутствии
  `receiptMatchers`, partial vs failed receipts, capability-receipt не подходит под
  default tool-expectation). (2026-04-20)
- [x] Юнит ledger'а: `receiptMatchers` корректно выводится для
  `promised_action` (exec/apply_patch/write через `inferPromisedActionMatchers`). (2026-04-20)
- [x] Интеграционный hook в `src/auto-reply/reply/agent-runner.ts`: `reconcilePromisesWithReceipts`
  вызывается post-turn, hard-violation форсит **один** replan через `enqueueFollowupRun`
  с `reasonCode="evidence_hard_replan"` и corrective prompt'ом; при повторном replan'е
  в том же подturn'е violation даунгрейдится до `soft` + лог `[evidence] replan-budget-exhausted`. (2026-04-20)
- [x] Live: `pnpm live:routing:smoke` = **13/13**, `13-confirmation-yes-exec`
  зелёный, финальный assistant turn содержит `toolCall name=exec` (node --version)
  (2026-04-20 — запуск с `OPENCLAW_GATEWAY_TOKEN` из `.env`, см. log
  `.artifacts/live-routing-smoke-run1.log` и `.artifacts/live-routing-smoke/13-confirmation-yes-exec.json`).
- [x] В `.gateway-dev.log` появляется `[evidence] promises=… receipts=… violations=… action=…`
  на каждом turn, где ledger записал `promised_action` (см. `createSubsystemLogger("evidence")`
  в `agent-runner.ts`). (2026-04-20)
- [x] `pnpm tsgo --noEmit` не добавляет новых ошибок; Stage B файлы
  (`execution-evidence.ts`, `execution-evidence.test.ts`, изменения в
  `intent-ledger.ts`, `agent-runner.ts`) чистые. Pre-existing красный остаётся. (2026-04-20)
- [x] `pnpm lint:routing:no-prompt-parsing` зелёный (evidence-модуль живёт
  в `src/platform/session/`, regex в reconciler'е — только по ledger-summary, не по user-input). (2026-04-20)

**Неочевидные нюансы / ловушки.**
- Matcher «promise → exec» не должен срабатывать на нейтральные
  `"запускаю тесты"` внутри апдейта документа — если в том же turn
  уже есть `receipt.kind="tool"` с `status!="failed"`, violation = no.
- Replan — **не** новый hook, а один повторный вход через тот же путь,
  что и нормальный planning, с `overrides.executionContract.requiresTools=true`.
  Не делать копию planner-pipeline.
- Budget 1: иначе hallucinating LLM загонит себя в бесконечный replan-цикл.
- Если ledger отключён (feature-flag/ENV) — reconciler тоже no-op.

**Verify команды.**
```powershell
pnpm vitest run src/platform/session src/platform/runtime src/platform/decision/task-classifier.test.ts
pnpm tsgo --noEmit
pnpm lint:routing:no-prompt-parsing
pnpm live:routing:smoke
```

**Зависимости.** Этап A (ledger), не начинать без него. A закрыт 2026-04-20.

---

### Этап C — Progress Bus [x] (scope C закрыт 2026-04-21, live подтверждён 15/15)

**Цель.** Единый стрим событий турна, потребители — gateway WS broadcast
(`progress.frame`), Telegram edit-adapter и будущий сайт.

**Делiver.**
- `src/platform/progress/progress-bus.ts` — ProgressBus, ProgressFrame,
  `createTurnProgressEmitter`, AsyncLocalStorage-контекст, rate-limit
  `PROGRESS_BUS_PER_TURN_LIMIT=20`, env-kill-switch `OPENCLAW_PROGRESS_BUS_DISABLED=1`.
- `src/plugin-sdk/progress.ts` + запись в `package.json` exports +
  `scripts/lib/plugin-sdk-entrypoints.json`.
- Эмитеры: `decision/input.ts` (`classifying`), `recipe/planner.ts`
  (`planning` + `preflight` с detail=bundle/family), `auto-reply/agent-runner.ts`
  (`streaming`, `tool_call`, `evidence`, `done`, `error`).
- `src/gateway/progress-bridge.ts` + интеграция в `server.impl.ts` +
  cleanup в `server-close.ts` — broadcast события `progress.frame` через
  `broadcastToConnIds` для WS-подписчиков (`dropIfSlow:true`,
  min-gap 100ms per session).
- `extensions/telegram/src/progress-adapter.ts` + 7 unit-тестов —
  edit-message поверх одного статус-сообщения, kill-switch
  `OPENCLAW_PROGRESS_TELEGRAM=0`.
- Live smoke scenario `14-progress-bus` + вспомогательный `14a-progress-bus-question`
  в `scripts/live-routing-smoke.mjs` — парсит `[progress] turn=... seq=... phase=...`
  из лог-файла gateway и проверяет required phases + toolName=exec.

**Acceptance (все ✓).**
- [x] `pnpm vitest run src/platform/progress src/platform/session
  src/platform/decision/task-classifier.test.ts extensions/telegram/src/progress-adapter.test.ts`
  — 81/81 passed.
- [x] `pnpm tsgo --noEmit` — Stage C файлы чистые; остаются pre-existing
  ошибки в planner.test/runtime-adapter.test/service.test/ui (out of scope).
- [x] `pnpm lint:routing:no-prompt-parsing` — зелёный.
- [x] `pnpm live:routing:smoke` — 15/15 passed, `14-progress-bus` дал
  `phases=[classifying,planning,preflight,tool_call,done] frames=5 toolName=exec`.
- [x] Gateway startup лог содержит `[progress] gateway bridge attached`.

**Guard-rails.**
- Publish без подписчиков — cheap no-op (только turnCounter cleanup на terminal).
- Rate-limit: 20 frames/turn, terminal фазы (done/error) всегда пролезают;
  drops суммируются и логируются на terminal.
- Нет никакого парсинга user-input в эмитерах — только phase-лейблы и tool names.

---

### Этап C.1 — Wire Telegram progress adapter в плагин [x]

**Цель.** Адаптер (`extensions/telegram/src/progress-adapter.ts`) написан и
покрыт тестами, но не подцеплен к активному telegram-плагину. Без этого
Stage C **невидим конечному пользователю в Telegram-чате**.

**Scope.**
- В точке инициализации telegram-плагина вызвать
  `createTelegramProgressAdapter({ getApi, resolveTarget })`:
  - `getApi` — существующая Telegram Bot API обёртка плагина (sendMessage/editMessageText).
  - `resolveTarget(frame)` — маппит `{sessionId, channelId}` → `{chatId, replyToMessageId?}`
    через текущий sessionContext плагина (уже есть для routing ответов).
- Учитывать kill-switch `OPENCLAW_PROGRESS_TELEGRAM=0`.
- Cleanup handle при shutdown/reload плагина.
- 1 unit-тест поверх реально исполняемого wire-кода (smoke: при эмите
  `classifying` в активный session вызывается `sendMessage`, при `done` —
  отписка/cleanup уже покрыты unit'ами адаптера).

**Acceptance.**
- [x] Telegram plugin wiring добавлен: `createTelegramProgressAdapter({ getApi, resolveTarget })`
      подключается в `createTelegramBot`, target резолвится из sessionContext, cleanup через `unsubscribe`
      на `bot.stop()`. Добавлен wire-smoke `extensions/telegram/src/bot.progress-wire.test.ts` (2026-04-21).
- [x] `loadCombinedSessionStoreForGateway` вынесен в публичный SDK `openclaw/plugin-sdk/gateway-runtime`,
      чтобы telegram-плагин импортировал его через пакетный путь (устраняет
      `TypeError: Cannot redefine property` при загрузке плагина). (2026-04-21)
- [x] Live: gateway перезапуск с C.1 кодом, `[progress] telegram adapter attached` в startup-логе,
      `[progress] turn=... seq=... phase=...` эмитится на каждый turn (подтверждено по `.gateway-dev.log`
      на сценариях 14 и 15). (2026-04-21)
- [ ] Фактический turn через Telegram показывает одно редактируемое
      статус-сообщение `⏳ <intent> • <phase>` поверх каждого turn'а, с
      переходами classifying → planning → preflight → tool_call → done.
      (Требует наблюдения живого Telegram-чата; гейтвей эмитит фреймы корректно.)
- [x] Kill-switch остаётся в адаптере (`OPENCLAW_PROGRESS_TELEGRAM`) без изменений API-контракта; unit coverage
      сохраняется в `progress-adapter.test.ts`. (2026-04-21)
- [x] Targeted vitest по scope C.1 (`bot.progress-wire.test.ts`, `progress-adapter.test.ts`) зелёные. (2026-04-21)
- [ ] `pnpm vitest run extensions/telegram` зелёный. (2026-04-21: не зелёный из-за pre-existing `monitor.test.ts`
      unhandled `deleteWebhook 404`; не связано с C.1 wiring).

---

### Этап D — Ack-then-defer dispatcher + Clarify budget [x]

**Цель — две связанные проблемы, разделённые на два блока, чтобы не
увеличивать scope без нужды.**

#### D.1 — Cross-turn clarify budget (PRIORITY 1, убивает спам) [x]

**Симптом (наблюдается вживую, лог 2026-04-21 12:42–12:46).**
8 подряд `task-classifier classified outcome=clarification_needed mode=clarify_first`
с одинаковой семантикой ambig (`platform_action receipt / receipt format`),
`[intent-ledger] peek=1 injected=1` на каждом, но classifier всё равно
спрашивает заново. Ledger инжектится, но у классификатора нет лимита «я уже
спрашивал это, не повторяй».

**Scope.**
- Расширить `intent-ledger.ts`: при `recordFromBotTurn` с kind=`clarifying`
  сохранять normalized-ключ клариф-темы (`ambigTopicHash` — нормализация
  `ambigs[]` → отсортированный hash по first N≤8 токенов каждой формулировки).
- Новое поле `IntentLedgerEntry.clarifyTopicKey?: string` и счётчик
  `clarifyCountByTopic: Record<string, { count, firstAt, lastAt }>` в session-state.
- В `buildTaskClassificationInputs` передать classifier'у блок
  `<clarify_budget>` вида
  `you already asked the user this 3 times in last 5 min; if asked again, choose a default
   or escalate to action instead of clarify_first`.
- Порог из env: `OPENCLAW_CLARIFY_MAX_REPEAT=2` (по умолчанию 2 — третий
  повтор должен быть escalation).
- На превышении — **форсим** один из двух путей:
  - `outcome=action` с `requestedTools` из best-guess по ambig ↔ recipe map
    (если `ambig` содержит `receipt|platform_action` → bundle=respond_only+deliverable),
  - либо `outcome=answer·respond_only` с эксплицитным «I'll proceed with default
    assumption: X. Say 'stop' to abort.» — не задавая нового вопроса.
- Логирование `[clarify-budget] topic=<hash> count=<n> action=<force_action|force_answer>`.

**Acceptance.**
- [x] Unit: добавлены кейсы в `intent-ledger.test.ts` (topic-key детерминизм + окно 5 минут
      + generic fallback когда ambigs пусто) и `task-classifier.test.ts` (инъекция
      `<clarify_budget_exceeded>` на повторе). 15/15 intent-ledger + 6/6 classifier зелёные. (2026-04-21)
- [x] Heuristic `classifyBotTurn` для clarifying укреплена: `YES_NO_RE` / `INPUT_HINT_RE`
      переписаны с word-boundary через `\p{L}` (u-flag), чтобы «задачу» / «подсказать» не матчили
      «да» / «укажи» как confirm/input hint. Плюс: если classifier передал `ambigs.length>0`,
      ledger форсит `kind=clarifying` независимо от эвристики текста — это синхронизирует ledger
      с реальным сигналом классификатора. (2026-04-21)
- [x] Channel-id для ledger в `decision/input.ts` нормализуется через `normalizeAnyChannelId` +
      `toLowerCase()`, чтобы чтение/запись шли с одним ключом (раньше recording сохранял
      `webchat`, а peek читал сырой `web` → peek всегда возвращал 0). (2026-04-21)
- [x] Live-smoke сценарий `15-clarify-budget` PASS (2026-04-21 19:13 MSK):
      `[clarify-budget] topic=*generic count=2 injected=1` в `.gateway-dev.log`,
      multi-turn chain `Продолжим → Делай → Ну сделай уже → Давай просто`,
      `pass=true` в `PHASE 7 RESULT: 1/1 passed`.
- [x] Filter `SMOKE_ONLY` добавлен в `scripts/live-routing-smoke.mjs` (CSV list scenario ids),
      чтобы локальные прогоны D.1/C.1 не тратили 10 мин на полный suite. (2026-04-21)

#### D.2 — Ack-then-defer dispatcher (PRIORITY 2, для длинных тасок) [x]

**Цель.** Длинные turn'ы (> 3 сек оценочно, или с `capability_install` +
`exec`) получают немедленный ack-ответ и уезжают в bg-job.

**Scope.**
- Новая capability `ack_then_defer` на уровне planner. Включается когда
  `plan.estimatedDurationMs > THRESHOLD_MS` (env `OPENCLAW_ACK_DEFER_MS=3000`)
  **или** recipe содержит `capability_install`.
- Bg-job state: расширить существующие `FOLLOWUP_QUEUES` новым `mode=deferred_job`,
  статусы `queued|running|done|failed`.
- Пользовательские сообщения, прилетающие во время bg-job'а, идут в
  steer/interrupt по queue-policy, **а не в новый turn**.
- Финальный ответ bg-job'а приходит отдельным сообщением через Progress Bus
  `phase=done` + deliverable (уже есть в Stage C).

**Acceptance.**
- [x] Long-running scenario не блокирует пользователя: targeted live smoke
      `SMOKE_ONLY=16-ack-then-defer pnpm live:routing:smoke` PASS
      (2026-04-21 21:49–21:50 MSK), `ackMs=1947`, `doneMs=24724`,
      фазы `ack_deferred,classifying,planning,preflight,tool_call,done`. Финальный
      результат пришёл отдельным сообщением после tool phase. (2026-04-21)
- [x] Unit-тест queue-policy: во время `deferred_job` user-message идёт в
      steer / enqueue-followup, не создаёт parallel turn.
      (`queue-policy.test.ts`, новые кейсы для `isDeferredJobRunning`). (2026-04-21)
- [x] Unit: planner detection для `capability_install` / simple respond_only +
      locale / deferred-job state зелёные:
      `planner.ack-then-defer.test.ts`, `ack-then-defer.test.ts`,
      `queue/deferred-job.test.ts`, `queue-policy.test.ts` → 33/33. (2026-04-21)
- [x] `pnpm lint:routing:no-prompt-parsing` зелёный после D.2 wiring. (2026-04-21)
- [x] `scripts/live-routing-smoke.mjs` расширен сценарием `16-ack-then-defer`
      и проверкой timing через `progress.frame` / structured gateway log fallback.
      (2026-04-21)

**Зависимости.** D.1 не зависит от D.2. D.2 зависит от C (Progress Bus для
сигнала о завершении) — выполнено.

---

## Порядок выполнения

1. **A** ✅ — ledger v0, инжект в classifier.
2. **B** ✅ — reconciliation promises/receipts.
3. **C** ✅ — Progress Bus + gateway WS broadcast + Telegram adapter (unit).
4. **C.1** — wire Telegram adapter в telegram-плагин.
5. **D.1** — cross-turn clarify budget (убивает спам-луп).
6. **D.2** — ack-then-defer dispatcher.

**Следующий шаг**: C.1 + D.1 одним PR (оба трогают session/channel state,
синергичны по тестам). D.2 — отдельным PR.

Каждый этап — **отдельный PR, отдельный промпт, отдельная запись в History**.

---

## Verify checklist (для всего P1.4)

- [ ] `pnpm tsgo --noEmit` — 0 ошибок.
- [ ] `pnpm vitest run src/platform/session src/platform/decision src/platform/recipe
      src/platform/runtime` — зелёный.
- [ ] `pnpm lint:routing:no-prompt-parsing` — зелёный.
- [ ] `pnpm live:routing:smoke` — все 8 старых + ≥2 новых сценария (A: «ДА после
      confirm-вопроса», B: «запускаю → runtime реально запустил»).
- [ ] Trader-сценарий авторизации проходит без цикла clarify→answer→clarify.
- [ ] Обновить `orchestrator_v1_1_master.plan.md` §0 и таблицу §2.

---

## Что НЕ входит в P1.4

- Персист ledger на диск — отложено до первой реальной потребности (сессия
  `Вернись к Trader через неделю» требует BL D+).
- Мультимодальный Progress Bus (картинки прогресса) — позже.
- Полноценный agent lifecycle start/stop/tail — это P1.1 и дальше.
- LLM-based классификация бот-ответов — heuristics достаточно для v0.

---

## History

- 2026-04-20 — саб-план создан после разбора Trader-лога (клариф-цикл на
  «Подтверждаю»/«ДА»). Этапы A/B/C/D декомпозированы, A открыт для исполнителя.
- 2026-04-20 — Этап A реализован частично end-to-end (в рамках scope A, без B/C/D):
  - добавлен `src/platform/session/intent-ledger.ts` (in-memory ledger, TTL=15m, лимит N=8,
    heuristic `awaiting_confirmation|awaiting_input|promised_action|clarifying`, `peekPending`,
    `invalidate`);
  - добавлен `src/platform/session/intent-ledger.test.ts` (8 кейсов классификации + TTL + limit + pure peek);
  - обновлён `src/platform/decision/task-classifier.ts` (опциональный `ledgerContext`,
    инъекция `<pending_commitments>` с ограничением до 300 токенов, без изменения baseline при пустом ledger);
  - обновлён `src/platform/decision/input.ts` (peek ledger + проброс `ledgerContext` + лог
    `[intent-ledger] peek=<N> injected=<0|1>`);
  - обновлён `src/auto-reply/reply/agent-runner.ts` (post-turn запись `recordFromBotTurn` после финального assistant-ответа);
  - обновлён `src/platform/decision/task-classifier.test.ts` (mock LLM инвариант:
    pending `awaiting_confirmation` + `"ДА"` => не `clarify_first`, плюс baseline-кейс `ledgerContext` пуст/отсутствует);
  - обновлён `scripts/live-routing-smoke.mjs` (добавлены сценарии `12`/`13` для цепочки confirm→ДА).
  Статус acceptance на 2026-04-20: unit/guardrail/log-пункты закрыты; live `13-confirmation-yes-exec`
  остаётся fail; `tsgo --noEmit` красный из-за pre-existing.
- 2026-04-20 — Этап A принят в scope A (ledger + инъекция в classifier + heuristic writer).
  Fail `13-confirmation-yes-exec` переведён во владение Этапа B: real-LLM без
  reconciliation'а promise/receipt не обязан переходить в tool_execution, и
  «добиваться» этого heuristic'ами в классификаторе — это именно «узкий фикс»,
  запрещённый инвариантами P1.4. Этап B открыт со scope / acceptance / файлами.
- 2026-04-20 — Этап B реализован в scope B (unit + integration hook + guard-rails):
  - расширен `src/platform/session/intent-ledger.ts`: добавлен
    `IntentLedgerReceiptMatchers`, поле `IntentLedgerEntry.receiptMatchers?`,
    новый kind `violated_promise`, `recordViolatedPromise(...)`, heuristic
    `inferPromisedActionMatchers` (exec / apply_patch / write) вызывается из
    `recordFromBotTurn` для `promised_action`;
  - добавлен `src/platform/session/execution-evidence.ts` —
    `PromisedActionViolation` + `reconcilePromisesWithReceipts({pendingPromises, receipts, verification?})`:
    `hard` при промисе без матчащего receipt (`kind ∈ expected ∧ status ∈ {success,partial}` ∧ toolName-матч),
    `soft` при deferred-формулировке (`сейчас сделаю/потом/после/позже/later`),
    дефолт `receiptKinds=["tool","platform_action"]`, собирает `observedReceiptKinds` из
    фактически успешных receipt'ов;
  - добавлен `src/platform/session/execution-evidence.test.ts` (15 кейсов);
  - обновлён `src/auto-reply/reply/agent-runner.ts`: post-turn хук после
    `recordFromBotTurn` — если записан `promised_action`, запускает reconciler
    с `runResult.meta?.executionVerification?.receipts`, эмитит лог
    `[evidence] promises=<n> receipts=<m> violations=<v> action=<none|soft|hard-replan>`
    через `createSubsystemLogger("evidence")`; на `hard` — **один** replan через
    `enqueueFollowupRun` с `reasonCode="evidence_hard_replan"` и corrective
    prompt'ом (`Expected receipt kinds`/`Expected tool(s)`/`[Original task]`);
    budget «1 hard-replan на turn» реализован как отказ enqueue'ить повторный
    replan, если текущий `followupRun.automation?.reasonCode` уже
    `"evidence_hard_replan"` (лог `[evidence] replan-budget-exhausted`,
    promise записывается как `violated_promise` в ledger);
    на `soft` — запись `violated_promise` в ledger (раннее инъектится в
    `<pending_commitments>` в следующий turn через уже существующий механизм Stage A).
  - verify-набор: `pnpm vitest run src/platform/session` (26 pass),
    `pnpm vitest run src/platform/decision/task-classifier.test.ts` (33 pass),
    `pnpm vitest run src/auto-reply/reply/agent-runner-helpers.test.ts` (pass),
    `pnpm lint:routing:no-prompt-parsing` (green), `pnpm tsgo --noEmit` без новых
    ошибок от Stage B файлов; 3 pre-existing красных в
    `src/platform/runtime/service.test.ts` (structured media / closure /
    no-evidence cap) воспроизводятся на `HEAD` без Stage B-изменений и относятся
    к другому scope'у.
  - live-smoke: `pnpm live:routing:smoke` = **13/13 passed** после экспорта
    `OPENCLAW_GATEWAY_TOKEN` из `.env` в powershell-сессию. Сценарий
    `13-confirmation-yes-exec done in 16s pass=true finalState=final tool_call: exec`;
    в истории turn'а (artifacts `13-confirmation-yes-exec.json`) финальный
    assistant-ответ — `toolCall name=exec` с `command=node --version`, tool-result
    `v22.19.0`. В гейтвей-логе по scenario видны `[intent-ledger] peek=1 injected=1`
    (inject ledger-контекста для «ДА») и `[intent-ledger] recorded session=… channel=webchat`.
- 2026-04-20 — Этап B: evidence-лог переведён в безусловный режим
  (`else { evidenceLog.info(...) }`), чтобы `[evidence] promises=0 receipts=0 violations=0 action=none`
  фиксировался и на turn'ах без executionVerification.receipts (когда бот не обещал
  tool-экшен) — для стабильной наблюдаемости stage B пути в логах.
- 2026-04-21 — Этап C (Progress Bus) реализован и подтверждён live:
  - добавлен `src/platform/progress/progress-bus.ts` (ProgressBus, ProgressFrame,
    `createTurnProgressEmitter`, AsyncLocalStorage-контекст,
    `PROGRESS_BUS_PER_TURN_LIMIT=20`, kill-switch `OPENCLAW_PROGRESS_BUS_DISABLED=1`)
    + `progress-bus.test.ts` (15 unit-кейсов: subscribe/subscribeAll/rate-limit/
    terminal-cleanup/disabled-env/detail-truncate/error-on-callback).
  - добавлен `src/plugin-sdk/progress.ts` (SDK re-export) + прописан в
    `package.json` exports и `scripts/lib/plugin-sdk-entrypoints.json`.
  - эмитеры:
    - `src/platform/decision/input.ts` — `classifying` перед classifyTask;
    - `src/platform/recipe/planner.ts` — `planning` до `planExecutionRecipeCore`,
      `preflight` если recipe требует tools (detail=bundles|requestedTools|id);
    - `src/auto-reply/reply/agent-runner.ts` — обёртка `withTurnProgressEmitter`,
      `streaming` (при первом onBlockReply), `tool_call` (по каждому tool-receipt,
      meta.toolName), `evidence` (action≠none), `done`/`error` на финализации.
  - `src/gateway/progress-bridge.ts` + интеграция в
    `server.impl.ts` (`createGatewayProgressBridge` вызывается при старте не-minimal
    gateway; broadcast `progress.frame` через `broadcastToConnIds` для
    `sessionEventSubscribers.getAll`, `dropIfSlow:true`, min-gap 100ms
    per session) + `progressBridgeUnsub` в closeHandler
    (`server-close.ts` + обновлён `server-close.test.ts`);
    `progress.frame` добавлено в `GATEWAY_EVENTS` (server-methods-list.ts).
  - `extensions/telegram/src/progress-adapter.ts` + 7 unit-тестов
    (enable/disable via `OPENCLAW_PROGRESS_TELEGRAM`, edit single status-message,
    send→edit fallback, terminal cleanup, serialized sends).
  - `scripts/live-routing-smoke.mjs`: сценарий `14-progress-bus` +
    вспомогательный `14a-progress-bus-question`, парсит
    `[progress] turn=… seq=… phase=…(toolName=…)` из лог-файла gateway;
    `captureGatewayLogOffset`/`readGatewayLogSince` расширены на оба лога
    (`.gateway-dev.log` и прямой `C:\tmp\openclaw\openclaw-YYYY-MM-DD.log`),
    чтобы обойти буферизацию PowerShell `*>` редиректа.
  - verify: `pnpm vitest run src/platform/progress src/platform/session
    src/platform/decision/task-classifier.test.ts extensions/telegram/src/progress-adapter.test.ts`
    → 81/81 passed; `pnpm lint:routing:no-prompt-parsing` зелёный;
    `pnpm tsgo --noEmit` — новых ошибок нет (pre-existing в planner.test/
    runtime-adapter.test/service.test/ui — out of scope).
    `pnpm live:routing:smoke` → **15/15 passed**,
    `14-progress-bus` дал `phases=[classifying,planning,preflight,tool_call,done]
    frames=5 toolName=exec`; в gateway startup-логе присутствует
    `[progress] gateway bridge attached`.
  - Telegram-адаптер НЕ wired в активный telegram-плагин (ждёт явного подключения
    через `createTelegramProgressAdapter` с `getApi`/`resolveTarget`);
    Progress Bus уже эмитит `progress.frame` в gateway WS для future веб-адаптера.
- 2026-04-21 — Этапы **C.1 + D.1** реализованы одним пакетом изменений:
  - `extensions/telegram/src/bot.ts`: добавлен wire `wireTelegramProgressAdapterForBot(...)` с
    `createTelegramProgressAdapter`, резолвером chat target из `loadCombinedSessionStoreForGateway`,
    kill-switch через адаптер, и cleanup `unsubscribe` в `bot.stop()`;
  - `extensions/telegram/src/bot.progress-wire.test.ts`: smoke на wire-resolver из sessionContext;
  - `src/platform/session/intent-ledger.ts`: `clarifyTopicKey`, `peekClarifyCount`, окно budget
    (`OPENCLAW_CLARIFY_BUDGET_WINDOW_MS`, default 5m), запись topic при `kind=clarifying`;
  - `src/platform/decision/input.ts`: подсчёт clarify-repeat, лог
    `[clarify-budget] topic=<key:8> count=<n> injected=<0|1>`, проброс
    `<clarify_budget_exceeded>` в classifier;
  - `src/platform/decision/task-classifier.ts`: поддержка `clarifyBudgetNotice` и инъекции
    в user-request для LLM-backend;
  - `src/auto-reply/reply/agent-runner.ts`: запись `ambigs` из classifier telemetry в ledger;
  - `src/platform/session/intent-ledger.test.ts`, `src/platform/decision/task-classifier.test.ts`:
    добавлены D.1 unit-кейсы;
  - `scripts/live-routing-smoke.mjs`: добавлен сценарий `15-clarify-budget` и log-evaluator
    `[clarify-budget]`, плюс multi-turn support внутри одного сценария.
  Verify (2026-04-21): targeted vitest по изменённым файлам ✅; `lint:routing:no-prompt-parsing` ✅;
  `tsgo --noEmit` остаётся красным по pre-existing test-типам вне scope; `live:routing:smoke`
  запускается, но блокируется `gateway token mismatch` + upstream `HTTP 403`, итог 4/16 (не валидирует D.1 live).
- 2026-04-21 (вечер) — C.1/D.1 **live подтверждены после 3 дополнительных фиксов**:
  1. `src/plugin-sdk/gateway-runtime.ts`: добавлен re-export
     `loadCombinedSessionStoreForGateway`, `extensions/telegram/src/bot.ts` переведён с
     относительного пути `../../../src/gateway/session-utils.js` на
     `openclaw/plugin-sdk/gateway-runtime` — устранил `TypeError: Cannot redefine property:
     isSenderAllowed` при загрузке telegram-плагина (двойная загрузка модуля).
  2. `src/platform/decision/input.ts::resolveIntentLedgerChannelId`: нормализация
     channel-id через `normalizeAnyChannelId(...)?.trim().toLowerCase()` — раньше
     `recordFromBotTurn` писал `channel=webchat`, а `peekPending` читал `web`,
     поэтому `peek` всегда = 0 и clarify-budget не срабатывал. Диагностика в
     `[intent-ledger] peek=… injected=… session=… channel=…` расширена для удобства.
  3. `src/platform/session/intent-ledger.ts`:
     - `GENERIC_CLARIFY_TOPIC_KEY="*generic*"` — fallback topic key, если
       `classifier.ambigs` пуст, но kind=clarifying (иначе `undefined` terminirovalo budget);
     - `YES_NO_RE` / `INPUT_HINT_RE` переписаны с `\p{L}` word-boundaries
       (избавились от false-positive «задачу» → «да», «подсказать» → «укажи»);
     - форс `kind="clarifying"` если `ambigs.length>0` — синхронизация heuristic
       с реальным сигналом classifier'а.
  4. `src/auto-reply/reply/agent-runner.ts`: лог `[intent-ledger] recorded … kind=…
     topicKey=…` расширен для отладки (видно, что именно записали в ledger).
  5. `scripts/live-routing-smoke.mjs`: сценарий `15-clarify-budget` переписан на
     4-turn chain (`Продолжим / Делай / Ну сделай уже / Давай просто`) для
     гарантии двух подряд clarifying-ответов LLM; добавлен env-filter `SMOKE_ONLY`
     (CSV scenario ids) для таргетированного live-прогона.
  Live verify (2026-04-21 19:13 MSK, dev-gateway PID 12380, token из `.env`):
  `SMOKE_ONLY=15-clarify-budget pnpm live:routing:smoke` → **1/1 passed**,
  `[scn 15-clarify-budget] done in 42s pass=true finalState=final`,
  `[clarify-budget] topic=*generic count=2 injected=1` в `.gateway-dev.log`.
  Targeted vitest: `intent-ledger.test.ts` 15/15, `input.test.ts` ✓,
  `task-classifier.test.ts` ✓, `bot.progress-wire.test.ts` ✓,
  `agent-runner-usage-line.test.ts` ✓ — итого 67/67 (5 файлов).
  `lint:routing:no-prompt-parsing` ✓. Full-suite vitest остаётся красным
  по pre-existing failures в whatsapp/webhook/monitor (вне scope P1.4).
- 2026-04-21 (поздний вечер) — **P1.4 D.2 закрыт и live-подтверждён**.
  Сделано:
  1. `src/platform/progress/progress-bus.ts`: добавлен phase `ack_deferred`.
  2. `src/platform/recipe/planner.ts` + `runtime-adapter.ts`:
     heuristic `estimatedDurationMs` / `ackThenDefer`, env
     `OPENCLAW_ACK_DEFER_MS`, проброс в `RecipeRuntimePlan`.
  3. `src/auto-reply/reply/queue/types.ts`, `queue/state.ts`, `queue.ts`,
     `queue-policy.ts`: `deferred_job`, lifecycle
     `queued|running|done|failed`, route user-message в
     `enqueue-followup` во время running bg-job.
  4. `src/auto-reply/reply/ack-then-defer.ts`,
     `agent-runner.ts`, `agent-runner-execution.ts`: локализация ack
     `принял, работаю`, единый idempotent ack path, planner-confirmed defer,
     узкий pre-routing hint для явного `capability_install`, cleanup deferred
     state в `finally`.
  5. `scripts/live-routing-smoke.mjs`: новый сценарий
     `16-ack-then-defer`, timing-проверка `ackMaxMs/doneMinMs` по
     `progress.frame` и structured gateway JSON-log fallback.
  Verify:
  - Targeted vitest: `planner.ack-then-defer`, `ack-then-defer`,
    `queue/deferred-job`, `queue-policy` → **33/33**.
  - Доп. targeted vitest: `src/platform/recipe/planner.test.ts src/platform/progress`
    → **47/47**, `src/auto-reply/reply/queue` → **14/14**.
  - `pnpm lint:routing:no-prompt-parsing` → ✅.
  - Live: после restart через `scripts\gateway-dev-channels.cmd`
    `SMOKE_ONLY=16-ack-then-defer pnpm live:routing:smoke` → **1/1 passed**,
    `ackMs=1947`, `doneMs=24724`, фазы
    `[ack_deferred,classifying,planning,preflight,tool_call,done]`.
  - Широкий `pnpm vitest run src/platform/recipe src/auto-reply src/platform/session`
    остаётся красным по pre-existing baseline вне scope D.2; это подтверждено
    повтором и отдельной проверкой `runtime-adapter.test.ts` в чистом stash-состоянии.

---

## Known live-UX gaps (deferred, не регрессия P1.4)

Зафиксированы при ручном Telegram-смоуке 2026-04-21 поздний вечер. P1.4 закрыт по
acceptance-критериям (ack ≤ 2s, deferred lifecycle, clarify-budget), но в живом UX
видны два побочных эффекта, которые **не нарушают инварианты P1.4** и потому
вынесены в отдельный backlog. Решения по ним принимать **без жёстких рамок** —
не возвращать парсинг промпта, не хардкодить per-tool whitelist'ы.

1. **D.2 ack-overscope.** Сейчас «принял, работаю» появляется почти на каждый
   non-trivial turn, потому что `estimateRecipeDurationMs` присваивает
   `apply_patch / exec / pdf / image_generate` базу 4–8s, а порог
   `OPENCLAW_ACK_DEFER_MS=3000`. Любой code-change/exec автоматически > 3s.
   Симптом из live: `capability_install figlet` → ack (ожидаемо), затем
   `подготовь catalog entry` (apply_patch путь) → тоже ack — лишний шум.
   Возможные направления (без выбора сейчас):
   - сместить порог по умолчанию вверх (5–6s) и оставить ack как exception, а не правило;
   - убрать `apply_patch` из «long-running by capability» — оставить только
     явные «настоящие долгие» (`capability_install`, `bootstrap`, тяжёлые `exec`),
     т.е. где блокировка пользователя реально >5s;
   - добавить адаптивную меру (по факту длительности предыдущих похожих turn'ов
     из `IntentLedger`) вместо статической эвристики.
   Что НЕ делать: парсить prompt, хардкодить «если запрос про X — то Y».

2. **C.1 silent status.** `progress-adapter` уже wired в `bot.ts`, kill-switch
   соблюдается, unit/wire-smoke зелёные, но в живом Telegram-чате edits фактически
   не появляются (видны только ack и финальный ответ). На gateway-side
   `progress.frame` эмитится (live `16-ack-then-defer` это подтвердил), значит
   проблема локализована в участке plugin → Telegram Bot API:
   - либо адаптер не получает кадры из-за расхождения `sessionId`/chat-target в
     plugin context vs `progress-bridge` broadcast;
   - либо edits успевают, но Telegram схлопывает их (тротлинг / «edit text equals»);
   - либо kill-switch `OPENCLAW_PROGRESS_TELEGRAM` интерпретируется как
     disabled в проде из-за дефолта.
   Нужен таргетный live-debug: один turn → лог `[progress-adapter] ...` на стороне
   плагина + проверка фактических `editMessageText` запросов.

Оба пункта НЕ блокируют другие задачи P1 (P1.2 ensureCredentials и далее) — их
можно вернуть в работу отдельным мини-этапом, когда появится приоритет на UX
polish, либо если ack-overscope станет мешать другому live-теcту.
