---
name: ""
overview: ""
todos: []
isProject: false
---

# Orchestrator v1.1 — master plan

**Назначение:** паспорт умного оркестратора после v1. Даёт новому чату понять «где мы
сейчас стоим твёрдо», «что шатается» и «кто куда идёт». Для исполнения используйте саб-планы;
этот документ — карта.

**Этот файл — главная точка входа для всех P0/P1/P2/P3 работ. Любой, кто что-то делает,
обязан отметить это здесь и в соответствующем саб-плане (см. §6 «Дисциплина отметок»).**

---

## 0. TL;DR

- Роутинг v1 закрыт (8/8 live E2E в `pnpm live:routing:smoke`, см.
`.cursor/plans/routing_v1_followup_handoff.plan.md`).
- v1.1 — это **стабилизация оркестратора**: latency, safety, consistency на каждом user turn.
Никакой новой функциональности; только затяжка гаек.
- P0 (критично, в `dev`): double-planning, low-conf workspace mutations, clarify-инвариант.
**Статус: COMPLETED** (см. `orchestrator_v1_1_p0.plan.md`).
- P1 (важно): `kind=agent_persona` / `code-change` / `repo-operation`, credentials preflight,
**conversation state + execution evidence + progress bus**, **workspace & identity self-awareness**.
**Статус: IN_PROGRESS** — P1.2 ✅ (2026-04-22), P1.3 ✅ (2026-04-20), **P1.4 полностью ✅**
(A/B/C/C.1/D.1/D.2; 2026-04-21 поздний вечер, live
`16-ack-then-defer`: `ackMs=1947`, `doneMs=24724`),
**P1.5 полностью ✅** (A/B/C; 2026-04-22, live `17-workspace-aware-exec` PASS
с `workspace-inject reason=contract` + `exec workdir=…\god-mode-core`,
`18-identity-aware-recall` PASS с `tool_call=web_search`, полный
`pnpm live:routing:smoke` 19/19 PASS).
Активный следующий фокус P1: **P1.1 agent_persona** (см.
`orchestrator_v1_1_p1.plan.md`); параллельно — UX-ветки P1.7-A/B/C, вынесенные
из P1.6 в `orchestrator_v1_1_p1_6_post_smoke_followups.plan.md` §«Что НЕ
входит в P1.6».
- **P1.6 (post-smoke follow-ups, 2026-04-22):** **частично закрыт** — P1.6.1
 и P1.6.2 в `dev`, **P1.6.3 отозван по архитектуре** (реализация в коде осталась,
 пользователь будет жить с ней до P1.7-D, см. ниже):
  - **P1.6.1 ✅** (2026-04-22) — `requiredEnv` переехал с capability на
  `deliverable.constraints.provider` (`bybit` / `openai` / `telegram_userbot`
  + алиасы `telegram` / `tg` / `tg_userbot`). Capability `needs_repo_execution`
  больше не несёт env-список; запросы ключей возникают только при явном
  provider-сигнале от классификатора.
  - **P1.6.2 ✅** (2026-04-22) — evidence-predicate ослаблен в
  `runtime/evidence-sufficiency.ts` + `runtime/service.ts`: `repo_operation`
  + exec-only считается выполненным по успешному `exec`-receipt'у
  (`exitCode=0` + `stdout` / `url` / `pid`). `apply_patch` опционален,
  `server-status-note.txt` больше не появляется.
  - **P1.6.3 ⚠️ отозван** (2026-04-22, после второго ручного смоука) —
  реализация (`intent-fingerprint` + 60s preflight в runner'е) **сделана сбоку
  от существующих примитивов** (`IntentLedger`, `evidence-sufficiency`,
  `FollowupQueue`) и нарушает принцип «inventory before invent» (§4 п.6).
  Симптом в живом тесте: «подними сервер» через 60s+ снова поднимает новый
  vite-процесс, потому что окно — это не «состояние мира». Корректное
  направление вынесено в **P1.7-D**: расширить `evidence-sufficiency` явным
  аргументом `priorEvidence` и сделать ledger первым probe'ом — без новых
  enum'ов, без time-window, без per-kind исключений. До выполнения P1.7-D
  preflight оставлен, но помечен как технический долг.
- **P1.7-D ✅** (2026-04-22) — технический долг P1.6.3 закрыт:
  идемпотентность перенесена в state-driven путь через
  `runtime/evidence-sufficiency.ts` + `priorEvidence`, ledger стал первым
  probe'ом на родном TTL=15m, runner-preflight и его 60s окно сняты.
- **P1.7-E ✅** (2026-04-22) — reminder routing-fix в classifier landed: один guidance-параграф в `task-classifier.ts` + чтение `deliverable.constraints.tool` → `requestedTools` в `mapTaskContractToBridge` (без новых outcome/kind/strategy/env). Built-in cron-tool (`src/agents/tools/cron-tool.ts`, name="cron") используется как есть; reminder-guard, FollowupQueue, cron API/schemas — не тронуты. Live `21-reminder-via-cron` PASS. Активный следующий фокус P1: **P1.1 `agent_persona`** (P1.7-D и P1.7-E закрыты). В backlog'е P1.7 остаются:
  -A (`inReplyTo` channel-agnostic), -B (coalescing same-intent в `lane`
  через fingerprint), -C (warm restart oversized session).
- P2 (качество): `resolveRepoRoot` bug, warmup resolver, UI label drift.
**Статус: PENDING** (см. `orchestrator_v1_1_p2.plan.md`).
- P3 (hardening): стресс live smoke, `ensureCapability` idempotency, variant prompts.
**Статус: PENDING** (см. `orchestrator_v1_1_p3.plan.md`).

---

## 1. Философия

> Оркестратор — это *классификатор → планнер → рантайм*. Всё, что делается вне этой оси,
> должно быть не мешающим. Любой «второй раз подумать» на каждом turn — это регрессия.

Три инварианта, которые оркестратор держит **на каждом turn**:

1. **Один classify, один planner на user turn.** Никакие плагины/хуки не имеют права
  реклассифицировать промпт или заново планировать, если контекст уже есть.
2. **Не мутируем workspace «на авось».** `conf < 0.5` ∧ `needs_workspace_mutation` ∧
  `ambiguities ≠ ∅` ⇒ `lowConfidenceStrategy = "clarify"`, никаких apply_patch.
3. **Clarify — это respond_only.** Если turn идёт в клариф — `requestedTools = []`,
  `executionContract.requiresTools = false`, никакого deliverable. Противоречий в plan быть не должно.

---

## 2. Карта: что твёрдо / что шатается

### Твёрдо (не трогать без причины)

- Classifier `pi-simple / hydra/gpt-5-mini` — единственный источник истины об интенте.
Выдаёт валидный `TaskContract` (`src/platform/decision/task-classifier.ts`).
- Contract-first planner — `planExecutionRecipe` (`src/platform/recipe/planner.ts`). Уважает
`lowConfidenceStrategy`, `outcomeContract`, `executionContract`, `requestedTools`.
- Runtime tools — `exec`, `apply_patch`, producers регистрируются через
`ProducerRegistry` (`src/platform/produce/registry.ts`).
- `ensureCapability` — автоматический dynamic install для npm-backed tools.
- 8/8 live E2E routing smoke. Guardrail `lint:routing:no-prompt-parsing` зелёный.

### Шатается (адресовано в P0/P1/P2/P3)


| ID       | Симптом                                                                                                                                                                                                                                                                                                                        | План      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| P0.1     | Каждый turn делает два `[planner] selected` (`auto-reply-runtime-plan` + `plugin-platformContext`). Лишние 300–800ms.                                                                                                                                                                                                          | P0 (done) |
| P0.2     | Мутации workspace проходят с `confidence ≈ 0.35` и непогашенными ambig.                                                                                                                                                                                                                                                        | P0 (done) |
| P0.3     | `interactionMode=clarify_first` оставляет `requestedTools=[apply_patch,...]`.                                                                                                                                                                                                                                                  | P0 (done) |
| P1.1     | Нет `DeliverableSpec.kind = "agent_persona"` — «сделай Trader как отдельного агента» мапится в `code_change`.                                                                                                                                                                                                                  | P1        |
| ~~P1.2~~ | ~~Нет `ensureCredentials()` — скаффолд стартует без проверки API hash / ключей.~~ Закрыт 2026-04-22: preflight по `Trusted_Capability_Catalog.requiredEnv` (source-of-truth), fail-closed rewrite `TaskContract -> clarification_needed` с `missing_credentials:*`, `requestedTools=[]`, `requiresTools=false`; live сценарий `19-credentials-preflight` добавлен. | P1 (done) |
| ~~P1.3~~ | ~~Нет явных `kind: "code_change"` / `"repo_operation"` для git-потоков.~~ Типы/producers/classifier-bridge уже были; добавлен защитный инвариант в `normalizeTaskContract` + 3 теста.                                                                                                                                          | P1 (done) |
| P1.4     | **DONE.** Stage A ✅ (ledger v0). Stage B ✅ (evidence reconciler + hard-replan). Stage C ✅ (Progress Bus + gateway WS broadcast, live 15/15). C.1 ✅ (Telegram plugin wiring + cleanup, SDK-safe import). D.1 ✅ live 1/1 `15-clarify-budget` `count=2 injected=1`. **D.2 ✅ live 1/1 `16-ack-then-defer` with `ackMs=1947`, `doneMs=24724` (2026-04-21 21:49–21:50 MSK).** | P1 (done) |
| ~~P1.5~~ | ~~Оркестратор не знает свою среду…~~ Закрыт 2026-04-22: `WorkspaceProbe` + `IdentityFacts` + conditional injection (`<workspace>`/`<identity>` в classifier prompt только при code_change/repo_operation/exec/apply_patch tools), invalidate snapshot на успешном `apply_patch`-receipt'е. Live 17/18 PASS, полный smoke 19/19. | P1.5 (done) |
| ~~P1.6.1~~ | ~~`requiredEnv` сидит на capability `needs_repo_execution`…~~ Закрыт 2026-04-22: env-список снят с capability и переехал на `deliverable.constraints.provider` (`bybit` / `openai` / `telegram_userbot` + алиасы `telegram` / `tg` / `tg_userbot`); credentials clarification возникает только при явном provider-сигнале. Никаких новых enum'ов. | P1.6 (done) |
| ~~P1.6.2~~ | ~~Recipe для `repo_operation/exec` неявно требует `apply_patch`…~~ Закрыт 2026-04-22: ослаблен evidence-predicate в `runtime/evidence-sufficiency.ts` + `runtime/service.ts`; для exec-only `repo_operation` достаточно `exec`-receipt'а (`exitCode=0` + `stdout`/`url`/`pid`), `apply_patch` опционален, `server-status-note.txt` не пишется. | P1.6 (done) |
| P1.6.3 ⚠️    | **Отозван по архитектуре 2026-04-22.** Реализация (`intent-fingerprint` + 60s preflight в `agent-runner-execution.ts`) подменяет существующие `IntentLedger.recordFromBotTurn` + `reconcilePromisesWithReceipts` + `evidence-sufficiency`, добавляет арбитрарное окно и per-kind исключения. Симптом: повторный «подними сервер» через >60s снова спавнит процесс. Корректный путь — **P1.7-D**. Текущая реализация остаётся в `dev` как технический долг. | P1.7-D |
| ~~P1.7-D~~   | ~~Idempotency = «спросить мир, нужно ли действие». Расширить `src/platform/runtime/evidence-sufficiency.ts` явным аргументом `priorEvidence`; первый probe — ledger (TTL 15 мин уже есть; никакого 60s окна). После P1.7-D снять `lookupRecentReceipt` preflight из `agent-runner-execution.ts`, оставить `intent-fingerprint` как сквозной идентификатор интента (для логов / P1.7-B / ledger entry). Без новых kind/outcome/strategy.~~ Закрыт 2026-04-22: `PriorEvidenceProbe` добавлен локально в `evidence-sufficiency`, ledger probe живёт на родном TTL `IntentLedger`, runner-preflight и чтение `OPENCLAW_INTENT_IDEMPOTENCY_WINDOW_MS` сняты; технический долг P1.6.3 закрыт без новых env/enum. | P1.7 (done) |
| P1.7-A       | Channel-agnostic `inReplyTo` в `progress.frame` (Telegram `reply_to_message_id`, Max thread, UI thread).                                                                                                                                                                                                                       | P1.7  |
| P1.7-B       | Coalescing same-intent сообщений в окне одного `lane` по `intent-fingerprint` (а не во времени). Решает «5 одновременных «подними сервер» в одной очереди» — не дедуп по часам, а сериализация по ключу.                                                                                                                       | P1.7  |
| P1.7-C       | Warm restart oversized session: при `Oversized direct session` инжектировать компактный summary вместо холодного старта.                                                                                                                                                                                                       | P1.7  |
| P1.7-E ✅    | DONE 2026-04-22. Reminder ≠ `external_delivery`. **Routing fix в classifier**: «напомни …» → `tool_execution` + `requestedTools=["cron"]` (имя tool строго `cron`). Reminder-guard, FollowupQueue, cron API/schemas — не тронуты; built-in cron-stack используется как есть. § 4 п.6 «Inventory before invent». | P1.7  |
| P2.1     | `scripts/lib/ts-guard-utils.mjs::resolveRepoRoot` off-by-one → guards молчаливо зелёные.                                                                                                                                                                                                                                       | P2        |
| P2.2     | Startup warmup падает: `Unknown model: hydra/gpt-5.4`.                                                                                                                                                                                                                                                                         | P2        |
| P2.3     | UI показывает `general_reasoning / General` даже когда активный plan — contract-first.                                                                                                                                                                                                                                         | P2        |
| P3.x     | Нет авто-стресса (10×) routing smoke и idempotency гарантий `ensureCapability`.                                                                                                                                                                                                                                                | P3        |


---

## 3. Где искать детали

```text
.cursor/plans/orchestrator_v1_1_master.plan.md   ← этот файл
.cursor/plans/orchestrator_v1_1_p0.plan.md       ← latency / safety / invariants (done)
.cursor/plans/orchestrator_v1_1_p1.plan.md       ← kinds + credentials
.cursor/plans/orchestrator_v1_1_p1_4.plan.md     ← intent ledger / evidence / progress bus / dispatcher
.cursor/plans/orchestrator_v1_1_p1_5.plan.md     ← workspace probe + identity facts + conditional injection
.cursor/plans/orchestrator_v1_1_p1_6_post_smoke_followups.plan.md ← provider-scoped requiredEnv + exec-evidence relax + intent-fingerprint (P1.6.3 отозван — см. P1.7-D)
.cursor/plans/orchestrator_v1_1_p1_7.plan.md     ← rearchitect idempotency (D), reminder-as-scheduled (E), reply-thread (A), coalescing (B), warm restart (C)
.cursor/plans/orchestrator_v1_1_p2.plan.md       ← guards / warmup / UI labels
.cursor/plans/orchestrator_v1_1_p3.plan.md       ← hardening / stress

.cursor/plans/routing_v1_followup_handoff.plan.md  ← предыдущий hand-off (v1 → v1.1)
```

---

## 4. Ground rules (перенесено из v1 handoff, применимо и к v1.1)

1. **Zero parsing** пользовательского ввода в `src/platform/decision/`**, `recipe/`**,
  `runtime/**`, `agents/tools/**`. Любой regex по `prompt` — баг. Guard `pnpm lint:routing:no-prompt-parsing`.
2. **No manual npm install** для capabilities — только через `ensureCapability` + `Trusted_Capability_Catalog`.
3. **Deliverable-first.** Новые producers регистрируются по `kind`, не по format.
4. **CI остаётся зелёным.** `pnpm check` + `pnpm tsgo --noEmit` + `pnpm live:routing:smoke`.
5. **Не трогай `runtime-adapter.test.ts` pre-existing 10 failures** — это legacy, закреплено в
  P2/P3 отдельно. Не замешивайте фиксы в свой PR без явного разрешения.
6. **Inventory before invent.** Перед созданием нового модуля / контракта / окна
  / исключения — обязательно перечислить существующие примитивы, которые могли
  бы решить задачу, и явно объяснить, почему они не подходят. Стоп-список
  «новое сбоку»: дополнительный TTL/окно поверх `IntentLedger` (TTL уже 15 мин);
  свой preflight в runner'е поверх `evidence-sufficiency`; свой scheduler
  поверх `FollowupQueue`; свой pub/sub поверх `ProgressBus`; per-kind
  исключения вместо общего state-предиката. Если нарушаем — записываем как
  технический долг в master plan и открываем follow-up на rearchitect.

---

## 5. Как проверять оркестратор

```powershell
# 1. Один terminal: gateway
pnpm gateway:dev

# 2. Другой terminal: статика
$env:NODE_OPTIONS = "--max-old-space-size=8192"
pnpm tsgo --noEmit
pnpm lint:routing:no-prompt-parsing

# 3. Юнит-тесты ядра
pnpm vitest run src/platform/decision src/platform/recipe

# 4. Live routing
pnpm live:routing:smoke

# 5. Наблюдение за turn-latency
# В логе `.gateway-dev.log` на каждый user turn должно быть РОВНО ОДНО:
#    [planner] selected ... caller=auto-reply-runtime-plan
# Появление `caller=plugin-platformContext` — регрессия P0.1.
```

---

## 6. Дисциплина отметок (обязательно)

Любой агент или человек, коснувшийся оркестратора, обязан:

1. Отметить свои изменения в соответствующем саб-плане (P0/P1/P2/P3) в разделе «History».
2. Если изменение закрывает подпункт — проставить `[x]` и дату в формате `YYYY-MM-DD`.
3. Если меняется статус саб-плана (PENDING → IN_PROGRESS → DONE) — обновить таблицу в §0
  этого мастер-плана.
4. Если вводится новый шатающийся кусок — добавить строку в §2 и либо открыть саб-план, либо
  добавить подпункт в существующий.
5. НИКОГДА не удалять записи в History: только приписывать снизу.

---

## 7. Промпт для нового чата

> Прочитай `.cursor/plans/orchestrator_v1_1_master.plan.md`, пойми §§0–2. Затем открой
> саб-план следующей в очереди задачи (P1, если P0 уже завершён) и выполни его end-to-end,
> включая юнит-тесты и `pnpm live:routing:smoke`. При изменениях веди History в саб-плане и
> обнови статус в §0 мастер-плана. Соблюдай ground rules §4 и дисциплину §6.

---

## 8. History

- 2026-04-20 — мастер-план создан. P0 закрыт (см. P0 саб-план). P1/P2/P3 открыты, ожидают
исполнителей.
- 2026-04-20 — P1.3 закрыт. Реальное состояние: типы `repo_operation`,
producers, classifier few-shots и bridge-логика уже были в коде; добавлен
защитный инвариант в `normalizeTaskContract` (удаление
`needs_workspace_mutation` при `deliverable.kind=repo_operation`) и 3 теста
в `task-classifier.test.ts`. P1 переходит в IN_PROGRESS; следующий — P1.2.
- 2026-04-20 — разбор живого Trader-сценария (лог `238883.txt`) выявил системную
дыру: classifier turn-isolated, runtime не проверяет обещания бота, нет единого
progress-канала. Открыт P1.4 с 4 этапами (A: intent ledger v0 → B: execution
evidence → C: progress bus → D: ack-then-defer dispatcher). P1.4.A поднят в
наивысший приоритет: закрывает корень симптомов P1.1/P1.2 и блокирует
адекватное E2E тестирование. См. `orchestrator_v1_1_p1_4.plan.md`.
- 2026-04-20 — **P1.4 Stage A закрыт** (scope A). Сделано: `src/platform/session/intent-ledger.ts`
(+ unit, 8 heuristic-кейсов, TTL=15m, N=8, pure `peekPending`), опциональный
`ledgerContext` в `task-classifier.ts` (инъекция `<pending_commitments>`, ≤ 300 tok,
baseline без контекста не меняется), peek+log в `decision/input.ts`
(`[intent-ledger] peek=<N> injected=<0|1>`), writer `recordFromBotTurn` в
`auto-reply/reply/agent-runner.ts`, live-сценарии `12-confirmation-question` /
`13-confirmation-yes-exec`. Verify: `pnpm vitest` (session + task-classifier) ✅,
`pnpm lint:routing:no-prompt-parsing` ✅. `pnpm tsgo --noEmit` остаётся красным
из-за pre-existing. `**13-confirmation-yes-exec` намеренно передан владельцу Stage B** —
real-LLM может сказать «запускаю…» без tool-call, закрыть это heuristic'ами в
классификаторе = «узкий фикс», запрещено инвариантами P1.4. Stage B открыт
(reconciler promise ↔ receipt, hard-replan с budget=1) — см.
`orchestrator_v1_1_p1_4.plan.md` §Этап B.
- 2026-04-20 — **P1.4 Stage B закрыт на уровне scope B** (unit + integration hook +
guard-rails). Добавлено: `src/platform/session/execution-evidence.ts`
(`PromisedActionViolation` + `reconcilePromisesWithReceipts`, 15 unit-тестов),
расширен `intent-ledger.ts` (`IntentLedgerReceiptMatchers`, поле
`receiptMatchers`, `violated_promise` kind, `recordViolatedPromise`,
heuristic `inferPromisedActionMatchers` для exec/apply_patch/write),
hook в `src/auto-reply/reply/agent-runner.ts` после `recordFromBotTurn`:
лог `[evidence] promises=<n> receipts=<m> violations=<v> action=<none|soft|hard-replan>`,
`hard` → один replan через `enqueueFollowupRun` с `reasonCode="evidence_hard_replan"`
и corrective prompt; budget: повторный replan в том же подturn'е отказывается
(`[evidence] replan-budget-exhausted`) и promise уходит в ledger как
`violated_promise` (для следующего turn через существующий механизм
`<pending_commitments>` Stage A). Verify: session tests 26/26 ✅,
task-classifier 33/33 ✅, agent-runner-helpers ✅,
`pnpm lint:routing:no-prompt-parsing` ✅, `pnpm tsgo --noEmit` без новых ошибок
(3 pre-existing красных в `src/platform/runtime/service.test.ts` про
structured-media / closure-recovery / no-evidence-cap воспроизводятся и без
Stage B изменений, относятся к другому scope'у).
- 2026-04-20 — **P1.4 Stage B live-подтверждён**: разблокировано экспортом
`OPENCLAW_GATEWAY_TOKEN` из `.env` (не `OPENCLAW_GATEWAY_AUTH_TOKEN`) в
powershell-сессию; `pnpm live:routing:smoke` = **13/13 passed**, в том числе
`13-confirmation-yes-exec done in 16s pass=true ... tool_call: exec`
(артефакт `13-confirmation-yes-exec.json`: финальный assistant turn —
`toolCall name=exec command="node --version"` → tool-result `v22.19.0`).
В гейтвей-логе по сессии `300f14fd-…` видны `[intent-ledger] peek=1 injected=1`
(inject pending_commitments при «ДА») и `[intent-ledger] recorded channel=webchat`.
Дополнительно сделано: `[evidence]` лог в `agent-runner.ts` переведён в
безусловный режим (`else { evidenceLog.info(...) }`) для стабильной
наблюдаемости stage-B пути в логах всех turn'ов.
- 2026-04-21 — **P1.4 Stage C закрыт и подтверждён live**. Сделано: новый
`src/platform/progress/progress-bus.ts` (ProgressBus + ProgressFrame +
`createTurnProgressEmitter` с AsyncLocalStorage-контекстом,
rate-limit 20 frames/turn, kill-switch `OPENCLAW_PROGRESS_BUS_DISABLED=1`;
15 unit-тестов), SDK re-export `src/plugin-sdk/progress.ts` +
`package.json` exports + `scripts/lib/plugin-sdk-entrypoints.json`,
эмитеры в `decision/input.ts` (`classifying`), `recipe/planner.ts`
(`planning` + `preflight` с detail=bundles/family), `auto-reply/agent-runner.ts`
(`streaming` при первом block-reply, `tool_call` per receipt с toolName,
`evidence` при action≠none, `done`/`error` в finalizer),
`src/gateway/progress-bridge.ts` + wiring в `server.impl.ts` +
cleanup через `progressBridgeUnsub` в `server-close.ts`,
`progress.frame` добавлен в `GATEWAY_EVENTS`, broadcast через
`broadcastToConnIds` с `dropIfSlow:true` и min-gap 100ms per session.
Telegram: `extensions/telegram/src/progress-adapter.ts` +
`createTelegramProgressAdapter` (edit single status-message, send→edit
fallback, kill-switch `OPENCLAW_PROGRESS_TELEGRAM=0`, 7 unit-тестов);
адаптер готов к явному wire-up в telegram-плагин.
В `scripts/live-routing-smoke.mjs` добавлены сценарии
`14a-progress-bus-question` / `14-progress-bus`, парсинг
`[progress] turn=… seq=… phase=…(toolName=…)` из обоих лог-файлов
(`.gateway-dev.log` + прямой `C:\tmp\openclaw\openclaw-YYYY-MM-DD.log`) —
чтобы обойти буферизацию PowerShell `*>` редиректа. Verify: `pnpm vitest run src/platform/progress src/platform/session src/platform/decision/task-classifier.test.ts extensions/telegram/src/progress-adapter.test.ts` → 81/81 ✅,
`pnpm lint:routing:no-prompt-parsing` ✅,
`pnpm tsgo --noEmit` новых ошибок нет (pre-existing в planner.test/
runtime-adapter/service/ui — out of scope),
`pnpm live:routing:smoke` → **15/15 passed**,
сценарий `14-progress-bus` дал
`phases=[classifying,planning,preflight,tool_call,done] frames=5 toolName=exec`; в gateway startup присутствует
`[progress] gateway bridge attached`.
- 2026-04-21 — **P1.4 C.1 + D.1 внедрены в кодовую базу**. C.1: telegram progress adapter
wired в `createTelegramBot` (session-context resolver + stop cleanup), добавлен
wire-smoke `extensions/telegram/src/bot.progress-wire.test.ts`. D.1: bounded clarify budget
в ledger (`clarifyTopicKey`, `peekClarifyCount`, env-window), classifier injection
`<clarify_budget_exceeded>`, лог `[clarify-budget] topic=... count=... injected=...`,
запись `ambigs` из classifier telemetry, live smoke scenario `15-clarify-budget`.
Verify: targeted vitest по изменённым файлам ✅, `lint:routing:no-prompt-parsing` ✅.
`tsgo --noEmit` остаётся красным по pre-existing test-типам вне scope.
Live rerun 2026-04-21: `gateway token mismatch` + upstream `HTTP 403` → fail-closed,
smoke 4/16, поэтому live acceptance требует повторного прогона в валидном окружении.
- 2026-04-21 (вечер) — **P1.4 C.1 + D.1 live ПОДТВЕРЖДЕНЫ**. Пять дополнительных
фиксов, раскрытых при прогоне на свежем gateway:
  1. `src/plugin-sdk/gateway-runtime.ts` re-exports `loadCombinedSessionStoreForGateway`;
    `extensions/telegram/src/bot.ts` переведён с относительного `../../../src/gateway/session-utils.js`
     на `openclaw/plugin-sdk/gateway-runtime` — устраняет
     `TypeError: Cannot redefine property: isSenderAllowed` (двойная загрузка модуля в плагине).
  2. `src/platform/decision/input.ts::resolveIntentLedgerChannelId` нормализует
    channel-id через `normalizeAnyChannelId(...)?.trim().toLowerCase()`; раньше
     writer писал `webchat`, а reader peek-ал `web` → budget никогда не взводился.
  3. `src/platform/session/intent-ledger.ts`: `GENERIC_CLARIFY_TOPIC_KEY="*generic*"`
    как fallback для clarifying без ambigs; `YES_NO_RE` / `INPUT_HINT_RE`
     переписаны с `\p{L}` word-boundaries (убран false-positive «задачу»→«да»);
     `ambigs.length>0` форсит `kind="clarifying"`, синхронизируя ledger
     с явным сигналом классификатора.
  4. `src/auto-reply/reply/agent-runner.ts` диагностика: `[intent-ledger] recorded …
    kind=… topicKey=…`.
  5. `scripts/live-routing-smoke.mjs`: сценарий 15 переписан на 4-turn chain
    (`Продолжим / Делай / Ну сделай уже / Давай просто`), добавлен env-filter
     `SMOKE_ONLY` (CSV scenario ids) для таргетированных прогонов.
  Live verify (19:13 MSK, PID 12380): `SMOKE_ONLY=15-clarify-budget pnpm live:routing:smoke`
  → **1/1 passed**, `[clarify-budget] topic=*generic count=2 injected=1`.
  Targeted vitest 67/67 (`intent-ledger`, `input`, `task-classifier`,
  `bot.progress-wire`, `agent-runner-usage-line`), lint зелёный.
- 2026-04-21 (поздний вечер) — **P1.4 полностью закрыт: D.2 Ack-then-defer dispatcher
  внедрён и live-подтверждён**. Добавлены planner/runtime heuristics
  `estimatedDurationMs` + `ackThenDefer`, queue mode `deferred_job`,
  `ack_deferred` phase в Progress Bus, единый ack/bg-job lifecycle в
  `agent-runner`, ранний UX-ack для явного `capability_install`, сценарий
  `16-ack-then-defer` в `scripts/live-routing-smoke.mjs` с timing-проверкой по
  `progress.frame` / structured gateway log. Verify:
  targeted vitest `33/33` (D.2 новые тесты), доп. targeted vitest `47/47` +
  queue `14/14`, `pnpm lint:routing:no-prompt-parsing` ✅, live
  `SMOKE_ONLY=16-ack-then-defer pnpm live:routing:smoke` → **1/1 passed**
  с `ackMs=1947`, `doneMs=24724`. Широкий `pnpm vitest run src/platform/recipe src/auto-reply src/platform/session`
  остаётся красным по pre-existing baseline вне scope D.2; следующий активный
  пункт P1 — `P1.2 ensureCredentials()`.
- 2026-04-21 (после ручного смоука) — зафиксированы **deferred live-UX gaps**
  P1.4 D.2 (ack-overscope: «принял, работаю» на любом code-change) и
  P1.4 C.1 (Telegram status edits не видны в живом чате, хотя
  `progress.frame` эмитится gateway'ем). См. секцию **«Known live-UX gaps
  (deferred)»** в `orchestrator_v1_1_p1_4.plan.md`. Эти пункты НЕ
  блокируют P1.2 и далее; не считаются регрессией P1.4 acceptance.
  Параллельно ручной тест выявил **новый класс архитектурных дыр уровня
  P1.5 (orchestrator self-knowledge)**: бот не знает свой workspace
  (запустил `npm run` в `C:\Users\Tanya\.openclaw\workspace-dev`, упал ENOENT),
  asks-before-attempts на read-only ops (спросил про `/media` вместо
  попытки list), и галлюцинирует там, где знает источник
  («четверостишье Пушкина на англ» → выдал свой стих «в духе Пушкина»).
  Открыт под-план **`orchestrator_v1_1_p1_5.plan.md`** —
  workspace context + identity honesty (без жёстких рамок и без prompt-parsing).
- 2026-04-21 — **P1.5 план создан**. Три этапа: A (`WorkspaceProbe` + `IdentityFacts`
  + расширение in-memory `SessionContext` без новых external deps, ~150
  токенов на затронутый turn), B (conditional injection блоков
  `<workspace>` / `<identity>` в classifier prompt — только при
  `code_change` / `repo_operation` / tools∈{exec,apply_patch,...}), C (live
  smoke `17-workspace-aware-exec` + `18-identity-aware-recall` +
  invalidate snapshot после `apply_patch`). Инварианты: только факты, не
  правила; `lint:routing:no-prompt-parsing` остаётся guard'ом; storage
  in-memory, future-trained-model меняет только проекцию JSON→prompt.
  P1.5 не блокирует P1.2 — идут независимо.
- 2026-04-22 — **P1.5 закрыт полностью (A+B+C)**. Stage A: `WorkspaceProbe` /
  `IdentityFacts` + расширение `IntentLedger` (workspace?/identity? + TTL,
  `getOrProbeWorkspace` / `invalidateWorkspace` / `getOrBuildIdentity`).
  Stage B: проекции `projectWorkspaceForPrompt` / `projectIdentityForPrompt`
  (≤200/≤50 токенов), `shouldInjectWorkspaceContext` (8 веток), порядок
  блоков `<workspace>` → `<identity>` → `<pending_commitments>` → clarify-budget,
  always-on identity / conditional workspace, hard-replan reuse при
  необходимости. Stage C: `workspace-invalidation.ts` + hook в
  `agent-runner.ts` (apply_patch-success → `setImmediate(invalidate)`),
  live `17-workspace-aware-exec` PASS (`workspace-inject reason=contract`
  + `exec workdir=…\god-mode-core`), `18-identity-aware-recall` PASS
  (`tool_call=web_search`), полный `pnpm live:routing:smoke` 19/19 PASS.
  `pnpm vitest run src/platform/session/workspace-invalidation.test.ts` 8/8 ✅,
  `pnpm lint:routing:no-prompt-parsing` ✅. Подробности —
  `orchestrator_v1_1_p1_5.plan.md` History 2026-04-22.
- 2026-04-22 — **P1.2 закрыт**. Добавлен credentials preflight для scaffold-turn:
  источник env-требований только `Trusted_Capability_Catalog.requiredEnv`,
  fail-closed rewrite `TaskContract` в `clarification_needed` при missing env
  (`missing_credentials:*`), planner/runtime соблюдают clarify=`respond_only`
  (`requestedTools=[]`, `requiresTools=false`). Добавлены unit-кейсы в
  `src/platform/recipe/planner.test.ts` и live smoke `19-credentials-preflight`
  в `scripts/live-routing-smoke.mjs`. Активный следующий фокус P1: **P1.1 agent_persona**.
- 2026-04-22 (вечер) — ручной Telegram-смоук на свежем `gateway:dev:channels`
  выявил **три независимых регрессии**, не покрытые P1.2/P1.4/P1.5:
  (а) `needs_repo_execution.requiredEnv` форсит запросы ключей на любых
  exec-задачах (стих, картинка, dev-server); (б) recipe `repo_operation/exec`
  пишет `server-status-note.txt` вместо реального запуска процесса (жёсткий
  evidence-предикат внутри recipe); (в) полное отсутствие идемпотентности —
  «подними сервер» ×3 = три vite-процесса. Открыт sub-план
  `orchestrator_v1_1_p1_6_post_smoke_followups.plan.md` с тремя независимыми
  follow-up'ами (P1.6.1 / P1.6.2 / P1.6.3). **Жёсткий принцип:** не вводим
  новые `outcome` / `deliverable.kind` / `strategy`; решение через сужение
  существующих контрактов и через `deliverable.constraints` (свободный JSON,
  не enum). Channel-agnostic, без Telegram-специфики в `platform/`. Активный
  следующий фокус P1 переключён с `P1.1 agent_persona` на P1.6 (три прицельных
  промпта параллельно/последовательно по выбору исполнителя). UX-пункты
  `reply_to_message_id`, coalescing same-intent сообщений, тёплый restart
  oversized session — отложены в P1.7-A/B/C (явно вне P1.6).
- 2026-04-22 — **P1.6.2 закрыт.** Внутри runtime verification/finalizer
  ослаблен только predicate удовлетворённости exec-only `repo_operation`:
  успешный `exec` receipt (`exitCode=0` + `stdout`/`url`/`pid`) теперь
  считается достаточным evidence для local-process closure; `apply_patch` и
  `platform_action` больше не обязательны для этого пути. Vocabulary не
  расширялся: новых `outcome` / `deliverable.kind` / `strategy` не добавлено.
  Verify: `pnpm vitest run src/platform/recipe src/platform/runtime` →
  139/139 ✅, `pnpm lint:routing:no-prompt-parsing` ✅, live
  `SMOKE_ONLY=17-workspace-aware-exec,17b-start-dev-server pnpm live:routing:smoke`
  → 2/2 PASS, включая проверку отсутствия
  `C:\Users\Tanya\.openclaw\workspace-dev\server-status-note.txt` при
  exec-only запуске dev-server. P1.6 остаётся `IN_PROGRESS` до P1.6.1/P1.6.3.
- 2026-04-22 — **P1.6.3 закрыт.** Добавлен channel-agnostic
  `intent-fingerprint` и idempotency preflight до embedded/runtime запуска:
  `src/platform/session/intent-fingerprint.ts` вычисляет deterministic
  fingerprint чистой функцией от `deliverable + requiredCapabilities`
  (`repo_operation/exec`: `target_repo + command_signature`;
  `code_change/apply_patch`: `path + content_hash`; `image`: normalized prompt
  + size; fallback: `kind + stable JSON(constraints)`). Runtime intent снова
  несёт `deliverable` (`execution-intent-from-plan.ts`), `intent-ledger.ts`
  расширен read-API (`lookupRecentReceipt`) и хранит fingerprint + успешные
  receipts в том же entry без отдельной структуры. В
  `agent-runner-execution.ts` добавлен preflight short-circuit: если в окне
  `OPENCLAW_INTENT_IDEMPOTENCY_WINDOW_MS` (default 60000, `0` = kill-switch)
  найден свежий successful receipt того же fingerprint'а, второй turn отвечает
  `Уже сделано: <url/PID/path>` и не доходит до `exec`. Добавлен live smoke
  `20-intent-idempotency`. Verify: targeted session/runtime/reply regressions ✅,
  `pnpm lint:routing:no-prompt-parsing` ✅. Широкий
  `pnpm vitest run src/platform/session src/auto-reply/reply` остаётся красным
  по множеству pre-existing `reply/**` failures вне scope; это не новый класс
  ошибок P1.6.3.
- 2026-04-22 (поздний вечер, второй ручной Telegram-смоук) — **P1.6.3
  отозван по архитектуре**. Симптомы: (а) «подними kitty-banana» → корректно
  ответил «уже поднят: 5174» (P1.6.3 окно сработало), но через >60s следующий
  «подними сервер» снова стартовал vite на 5175 — окно не есть «состояние
  мира»; (б) «напомни завтра в 12:00 в чат» классифицирован как
  `external_delivery/receipt` и отказан как «нет интеграции», хотя пользователь
  прямо сказал «в чат», и у нас есть `FollowupQueue` (per-session очередь с
  `defer`); (в) бот по-прежнему просил `BYBIT/OPENAI/TELEGRAM` ключи на
  reminder — provider-сигнал в classifier выставился ложно. Корневой диагноз:
  P1.6.3 preflight + 60s окно + `intent-fingerprint`-only `lookupRecentReceipt`
  реализованы **сбоку** от существующих примитивов (`IntentLedger.recordFromBotTurn`
  уже хранит `successfulReceipts` + `fingerprint`; `reconcilePromisesWithReceipts`
  уже отвечает «обещано/выполнено»; `evidence-sufficiency.evaluate` уже
  отвечает «достаточно ли evidence»). Решение — не «убирать ledger probe
  из runner'а в одиночку», а **расширить evidence-sufficiency явным
  `priorEvidence`** (первый probe — ledger, без 60s окна), сделать
  `intent-fingerprint` сквозным идентификатором интента (логи / coalescing /
  ledger-entry), а runner-preflight снять как избыточный. Это **P1.7-D**;
  reminder = routing fix к **существующему** `cron-tool` (OpenClaw уже
  имеет полный cron-stack: `src/cron/service*.ts`, agent-tool с
  REMINDER_CONTEXT_*, gateway/CLI/protocol, `agent-runner-reminder-guard.ts`)
  — **P1.7-E**. Открыт `orchestrator_v1_1_p1_7.plan.md` и
  введён ground rule §4 п.6 «Inventory before invent» с конкретным стоп-списком
  «новое сбоку». Активный фокус P1 переключён с `P1.1 agent_persona` на
  P1.7-D → P1.7-E. Реализация P1.6.3 в коде остаётся в `dev` как явно
  помеченный технический долг до выполнения P1.7-D.
- 2026-04-22 (ночь) — **P1.7-D закрыт; технический долг P1.6.3 снят.**
  Реализация идемпотентности перенесена в существующий state-предикат:
  `src/platform/runtime/evidence-sufficiency.ts` получил локальный
  `PriorEvidenceProbe` и считает sufficiency по объединённому списку
  `receipts + priorEvidence[*].receipts`, без time-window логики.
  `src/platform/runtime/prior-evidence/ledger-probe.ts` стал первым и
  единственным probe'ом итерации: читает `IntentLedger.lookupRecentReceipt`
  **без своего windowMs**, то есть живёт на родном TTL ledger'а (15m).
  `src/platform/runtime/service.ts` пробрасывает `priorEvidence` в
  verification/acceptance; shared reply-сборка «Уже сделано: …» вынесена в
  `src/platform/runtime/prior-evidence/already-done-reply.ts`. В
  `src/auto-reply/reply/agent-runner-execution.ts` удалён весь
  `lookupRecentReceipt` preflight и прекращено чтение
  `OPENCLAW_INTENT_IDEMPOTENCY_WINDOW_MS`; ранний short-circuit теперь
  происходит в `src/agents/pi-embedded-runner/run.ts`, но решение принимает
  runtime predicate (`sufficiencyReason="prior_evidence"`). `computeIntentFingerprint`
  и `lookupRecentReceipt` сохранены для ledger записи / логов / будущего
  P1.7-B. Verify: targeted новые тесты по `evidence-sufficiency`,
  `service`, `agent-runner.misc.runreplyagent` ✅; guard
  `pnpm lint:routing:no-prompt-parsing` ✅. Широкий targeted vitest по
  `src/platform/runtime + src/platform/session + src/auto-reply/reply`
  снова утыкается в 1 pre-existing failure
  `claude-cli routing > uses claude-cli runner for claude-cli provider`,
  вне scope P1.7-D. Live `20-intent-idempotency` в текущем окружении не
  подтвердился: scenario SKIP из-за `gateway token mismatch` и
  `OPENCLAW_WORKSPACE_ROOTS=<unset>`, значит финальный live acceptance
  требует повторного прогона в валидной gateway-конфигурации.
- 2026-04-22 — **P1.6.1 закрыт, P1.6 полностью DONE.** `requiredEnv` снят с
  capability `needs_repo_execution` (`src/platform/bootstrap/defaults.ts`) и
  переехал на `deliverable.constraints.provider` через новый модуль
  `src/platform/recipe/credentials-preflight.ts` (provider→envKeys таблица:
  `bybit`, `openai`, `telegram_userbot`; алиасы `telegram` / `tg` /
  `tg_userbot`). `planner.ts::planExecutionRecipe` и
  `task-classifier.ts::applyCredentialsPreflight` объединяют capability- и
  deliverable-источники через `Set` и поднимают
  `clarification_needed: missing_credentials:*` только при наличии явного
  provider-сигнала. В classifier-prompt добавлен один guidance-параграф:
  «provider ставится только когда deliverable реально завязан на API; стих,
  картинка, `pnpm dev`, generic test-run — без provider'а». Vocabulary не
  расширялся. Verify: targeted `pnpm vitest run src/platform/recipe
  src/platform/runtime src/platform/session src/platform/decision/task-classifier.test.ts
  src/platform/bootstrap` → 297/297 ✅,
  `pnpm lint:routing:no-prompt-parsing` ✅. `agent-runner.misc.runreplyagent.test.ts`
  показывает 1 pre-existing failure в `claude-cli routing > uses claude-cli runner
  for claude-cli provider` (lifecycle phases пусты), воспроизводится на baseline
  без P1.6 изменений и относится к отдельной зоне (CLI-runner lifecycle
  emitter), вне scope P1.6. Активный следующий фокус P1: **P1.1 agent_persona**;
  параллельно — P1.7-A/B/C (channel-agnostic `inReplyTo`, coalescing
  same-intent, тёплый restart oversized session) — вынесены в §«Что НЕ
  входит в P1.6» суб-плана.
