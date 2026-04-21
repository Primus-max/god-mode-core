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
**conversation state + execution evidence + progress bus**.
**Статус: IN_PROGRESS** — P1.3 ✅ (2026-04-20), **P1.4 Stage A ✅ (2026-04-20)**,
**P1.4 Stage B ✅ (2026-04-20, live `13/13` включая `13-confirmation-yes-exec` с реальным `toolCall name=exec`)**,
**P1.4 Stage C ✅ (2026-04-21, live `15/15` включая `14-progress-bus`; `[progress] gateway bridge attached`, WS `progress.frame`, Telegram adapter ready но не wired в плагин)**,
P1.2/P1.1, P1.4 C.1 (wire Telegram) + D.1 (clarify budget — живой спам-луп зафиксирован) + D.2 (ack-then-defer) pending
(см. `orchestrator_v1_1_p1.plan.md`, `orchestrator_v1_1_p1_4.plan.md`).
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


| ID       | Симптом                                                                                                                                                                                                                                                                                                                                                                                                                              | План      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| P0.1     | Каждый turn делает два `[planner] selected` (`auto-reply-runtime-plan` + `plugin-platformContext`). Лишние 300–800ms.                                                                                                                                                                                                                                                                                                                | P0 (done) |
| P0.2     | Мутации workspace проходят с `confidence ≈ 0.35` и непогашенными ambig.                                                                                                                                                                                                                                                                                                                                                              | P0 (done) |
| P0.3     | `interactionMode=clarify_first` оставляет `requestedTools=[apply_patch,...]`.                                                                                                                                                                                                                                                                                                                                                        | P0 (done) |
| P1.1     | Нет `DeliverableSpec.kind = "agent_persona"` — «сделай Trader как отдельного агента» мапится в `code_change`.                                                                                                                                                                                                                                                                                                                        | P1        |
| P1.2     | Нет `ensureCredentials()` — скаффолд стартует без проверки API hash / ключей.                                                                                                                                                                                                                                                                                                                                                        | P1        |
| ~~P1.3~~ | ~~Нет явных `kind: "code_change"` / `"repo_operation"` для git-потоков.~~ Типы/producers/classifier-bridge уже были; добавлен защитный инвариант в `normalizeTaskContract` + 3 теста.                                                                                                                                                                                                                                                | P1 (done) |
| P1.4     | Stage A ✅ (ledger v0). Stage B ✅ (evidence reconciler + hard-replan). **Stage C ✅ (Progress Bus + gateway WS broadcast + Telegram adapter unit-tested, live 15/15).** Осталось: **C.1 wire Telegram adapter в плагин**; **D.1 cross-turn clarify budget** (живой спам-луп 8× зафиксирован в логе 2026-04-21 12:42–12:46 — ledger инжектится, но classifier повторяет клариф); **D.2 ack-then-defer dispatcher** для длинных turn'ов. | P1        |
| P2.1     | `scripts/lib/ts-guard-utils.mjs::resolveRepoRoot` off-by-one → guards молчаливо зелёные.                                                                                                                                                                                                                                                                                                                                             | P2        |
| P2.2     | Startup warmup падает: `Unknown model: hydra/gpt-5.4`.                                                                                                                                                                                                                                                                                                                                                                               | P2        |
| P2.3     | UI показывает `general_reasoning / General` даже когда активный plan — contract-first.                                                                                                                                                                                                                                                                                                                                               | P2        |
| P3.x     | Нет авто-стресса (10×) routing smoke и idempotency гарантий `ensureCapability`.                                                                                                                                                                                                                                                                                                                                                      | P3        |


---

## 3. Где искать детали

```text
.cursor/plans/orchestrator_v1_1_master.plan.md   ← этот файл
.cursor/plans/orchestrator_v1_1_p0.plan.md       ← latency / safety / invariants (done)
.cursor/plans/orchestrator_v1_1_p1.plan.md       ← kinds + credentials
.cursor/plans/orchestrator_v1_1_p1_4.plan.md     ← intent ledger / evidence / progress bus / dispatcher
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
