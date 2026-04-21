# Orchestrator v1.1 — P1.4 (Conversation State & Execution Evidence & Progress Bus)

**Мастер-план:** `orchestrator_v1_1_master.plan.md`.
**Статус:** IN_PROGRESS — этапы A, B, C закрыты (scope+live подтверждён), D pending (2026-04-21).
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

### Этап D — Ack-then-defer dispatcher [ ]

**Цель.** Длинные turn'ы (≥ 3 сек) получают немедленный ack и уезжают в bg-job.

**Ключевые моменты.**
- Новая capability `ack_then_defer` на уровне planner. Включается когда
  `plan.estimatedDurationMs > THRESHOLD` (например, `ensureCapability` +
  `exec` на Telegram auth).
- Bg-job state: `FOLLOWUP_QUEUES` расширяется новым `mode=deferred_job`, статусы
  `queued|running|done|failed`. Пользовательские сообщения, прилетающие во время
  job'а, идут в steer/interrupt по правилам queue-policy, а не в новый turn.
- Финальный ответ bg-job'а приходит отдельным сообщением через Progress Bus
  `phase=done` + deliverable.

**Зависимости.** Этап C (без Progress Bus нечем сигналить о завершении).

---

## Порядок выполнения

1. **A первым** — минимум, даёт 80% эффекта, unblock'ает B.
2. **B** — reconciliation promises/receipts.
3. **C** — Progress Bus с Telegram-адаптером.
4. **D** — dispatcher. Требует C.

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
