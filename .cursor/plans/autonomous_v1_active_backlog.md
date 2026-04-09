# Autonomous v1 — active execution backlog

## Назначение

Единственный операционный ответ на вопрос **«что делать следующим прямо сейчас»** в рамках текущего Horizon 1 investor-cut queue. Активный stage сейчас — Stage 86 (`smart routing + bootstrap + Telegram proof`), а следующие Horizon 1 doc/report/context slices идут в этой же очереди после него.

Не заменяет:

- продуктовую границу: [autonomous_v1_roadmap_cb6fe0e6.plan.md](autonomous_v1_roadmap_cb6fe0e6.plan.md);
- короткий handoff: [master_v1_roadmap.md](master_v1_roadmap.md);
- долгую карту: [sovereign_ai_map_8e04210e.plan.md](sovereign_ai_map_8e04210e.plan.md).

Протокол итерации: [autonomous_v1_loop_a69b9e98.plan.md](autonomous_v1_loop_a69b9e98.plan.md).  
Короткий execution-контракт: [v1_execution_checklist.md](v1_execution_checklist.md).  
Активный stage-план (правила валидации и стопов): [stage_86_smart_routing_bootstrap.plan.md](stage_86_smart_routing_bootstrap.plan.md).  
Ручной acceptance по продукту: [../stage86_test_cases.md](../stage86_test_cases.md).

## Схема slice (поля)

Каждый slice ниже задаёт:

| Поле                 | Смысл                                             |
| -------------------- | ------------------------------------------------- |
| `id`                 | Стабильный идентификатор (префикс `S86-`)         |
| `priority`           | 1 = выше (раньше в очереди)                       |
| `status`             | `open` \| `in_progress` \| `blocked` \| `done`    |
| `dependsOn`          | Список `id`, которые должны быть `done` до старта |
| `userValue`          | Что увидит оператор / инвестор                    |
| `ownedFiles`         | Ориентир по зонам кода (не жёсткий CODEOWNERS)    |
| `requiredValidation` | Обязательные tier’ы лестницы до перевода в `done` |
| `doneWhen`           | Критерий готовности slice + что остаётся ручным   |
| `executionState`     | Текущая фаза исполнения внутри `status`           |
| `lastValidation`     | Последний зафиксированный validation truth        |
| `blockerOwner`       | Кто должен снять блокер или сделать следующий ход |
| `resumeFrom`         | Один конкретный следующий шаг                     |
| `evidence`           | Короткие артефакты, полезные следующему агенту    |

### Лестница tier’ов (кратко)

- **T1** — focused тесты затронутых модулей (`pnpm test -- <paths>`).
- **T2** — `pnpm check` и при затрагивании сборки/бандла — `pnpm build`.
- **T3** — `pnpm test:e2e:smoke` (если затронуты gateway boot / chat / runtime wiring).
- **T4** — `pnpm test:v1-gate` (recovery/session-event surfaces; **обязателен** перед объявлением v1 ready).
- **T5** — ручной протокол из `.cursor/stage86_test_cases.md` для соответствующих кейсов.

Подробности и стоп-условия: [stage_86_smart_routing_bootstrap.plan.md](stage_86_smart_routing_bootstrap.plan.md).

### Execution state vocabulary

- `queued` — slice ещё не взят в работу.
- `implementing` — идёт код/интеграция.
- `verifying` — идут deterministic проверки по slice.
- `fixing` — validation уже падал, идёт цикл `fix -> rerun`.
- `waiting_manual` — deterministic часть доведена до текущего предела, остаётся live/manual шаг.
- `blocked_external` — дальнейшее движение зависит от внешних секретов, сети или оператора.
- `blocked_scope` — требуется продуктовое решение или расширение scope.
- `completed` — slice закрыт, `doneWhen` и обязательные tier’ы выполнены.

### Правила ведения backlog

- `status: in_progress` без `executionState`, `lastValidation`, `resumeFrom` и `evidence` недопустим.
- Состояние «код написан, но validation ещё не запускали» не считается допустимой остановкой.
- Если validation упал, `executionState` переводится в `fixing`, а `resumeFrom` должен указывать повтор того же tier.
- Если остался manual/live шаг, deterministic результаты всё равно фиксируются в `lastValidation` до handoff.
- Следующий чат продолжает именно из `resumeFrom`, а не делает новый discovery.

---

## Horizon 1 — ordered backlog slices

Обновляй поля `status`, `executionState`, `lastValidation`, `blockerOwner`, `resumeFrom` и `evidence` при работе; главный агент ведёт этот файл как единственный backlog источник.

### S86-01 — routing parity + session-aware preflight

- **priority:** 1
- **status:** in_progress
- **dependsOn:** —
- **userValue:** Простые реплики уходят на локальную модель, сложные — на сильный маршрут; в логах/UI согласованы режимы preflight и выбранная модель.
- **ownedFiles:** `src/platform/decision/**`, `src/agents/model-fallback.ts`, `src/auto-reply/reply/agent-runner-*.ts`, `src/agents/agent-command.ts`, связанные `*.test.ts`
- **requiredValidation:** T1 (decision + model-fallback + agent-runner utils), T2 при изменении широкого wiring, T3 если меняется путь до gateway/session boot, T5 → кейсы 1, 2, 8 из [../stage86_test_cases.md](../stage86_test_cases.md)
- **doneWhen:** Детерминированная часть зелёная; продуктовые ожидания по модели/логам подтверждены T5; fallback chain (кейс 3) — по возможности T5 или явный `blocked` с причиной (сеть/инфра).
- **executionState:** waiting_manual
- **lastValidation:** 2026-04-08: T1 re-pass (`route-preflight.test.ts`, `model-fallback.test.ts`, `ui/src/ui/views/sessions.test.ts`); clean gateway поднят без `OPENCLAW_SKIP_MODEL_ROUTE_PREFLIGHT`; local Ollama `gemma4:e4b` отвечает напрямую (`/api/generate` 200); remote Hydra `/v1/models` отвечает 403 `access_forbidden`; T5 partial only (UI/gateway truth checked, remote live cases still blocked externally).
- **blockerOwner:** operator
- **resumeFrom:** После снятия внешнего Hydra 403 повторить T5 кейсы 1, 2 и 8 на тихом рантайме; если heartbeat/session шум вернётся, сначала проверить что `cron job 6fc09ba2-3922-47af-812b-bdc93df69719` остаётся disabled и heartbeats отключены.
- **evidence:** Логи `preflightMode: local_eligible|remote_required`; строки `model_fallback: … failed, trying …`; UI показывает `provider/model`, bootstrap context содержит `modelRouteTier`; прямой probe: Ollama 200, Hydra 403 `Access temporarily forbidden due to excessive errors or requests`.
- **2026-04-06:** Параллельные подагенты: в `model-fallback` добавлены стабильные строки `preflightMode: local_eligible|remote_required` и `model_fallback: … failed, trying …`; в UI Sessions — колонка `provider/model`; в bootstrap context — `modelRouteTier`. Автотесты: `model-fallback.test`, `sessions.test`, `bootstrap.test` зелёные. Остаётся T5 (Telegram/gateway).
- **2026-04-08:** Runtime audit: починен `~/.openclaw/openclaw.json` (`channels.telegram.streaming` был сломан типом/хвостом), clean gateway снова слушает `127.0.0.1:18789`, control UI подключается. Выявлен внешний блокер remote-path: Hydra rate/access limiter возвращает 403 даже на прямой `/v1/models`. Дополнительно отключён шумный cron `Template Request Check` (`6fc09ba2-3922-47af-812b-bdc93df69719`) и `set-heartbeats=false`, чтобы не жечь remote quota во время Stage 86 live reruns.

### S86-02 — prompt optimization visibility

- **priority:** 2
- **status:** in_progress
- **dependsOn:** —
- **userValue:** Видно, что промпт нормализован/сжат до модели; в логах есть измеримый след оптимизации.
- **ownedFiles:** `src/context-engine/prompt-optimize.ts`, `src/agents/pi-embedded-runner/run/attempt.ts`, `src/plugins/hooks.ts`, связанные тесты
- **requiredValidation:** T1 (prompt-optimize + attempt), T2 при затрагивании плагинных типов/сборки, T5 → кейс 5
- **doneWhen:** Логи/контракт соответствуют чеклисту кейса 5 или задокументировано целевое поле логов; тесты покрывают регрессии merge отчётов.
- **executionState:** waiting_manual
- **lastValidation:** 2026-04-06: T1 pass (`prompt-optimize.test.ts`), T2 not required by recorded change set, T5 pending_manual.
- **blockerOwner:** operator
- **resumeFrom:** Выполнить T5 кейс 5 и подтвердить живой `promptOptimization` след в gateway log; при несовпадении лога перевести slice в `fixing`.
- **evidence:** Метрики заведены в `PromptOptimizationReport`; в `attempt.ts` есть лог `promptOptimization: {…}`; merge regressions покрыты focused tests.
- **2026-04-06:** Метрики в `PromptOptimizationReport`, лог `promptOptimization: {…}` в `attempt.ts`, тесты `prompt-optimize.test.ts` зелёные. Остаётся T5 grep по живому gateway log.

### S86-03 — bootstrap approve → install → resume

- **priority:** 3
- **status:** in_progress
- **dependsOn:** —
- **userValue:** Запрос capability ведёт к approval в UI/Telegram, установке и **авто-продолжению** run без повторного пинга пользователя.
- **ownedFiles:** `src/platform/bootstrap/**`, `src/platform/recipe/runtime-adapter.ts`, `ui/src/ui/views/bootstrap.ts`, связанные тесты
- **requiredValidation:** T1 (bootstrap/catalog/registry), T2 при изменении UI bundle, T3 если меняется gateway-facing bootstrap, T5 → кейс 4
- **doneWhen:** Кейс 4 в [../stage86_test_cases.md](../stage86_test_cases.md) проходит по сценарию «approve → install → resume»; если live секреты недоступны — `blocked` с точным списком, что нужно от оператора.
- **executionState:** waiting_manual
- **lastValidation:** 2026-04-06: T1 pass (`service.test.ts` approve -> continuation -> run -> followup), T2/T3 not yet re-run for live path, T5 pending_manual.
- **blockerOwner:** operator
- **resumeFrom:** Выполнить T5 кейс 4 на живом bootstrap-сценарии `approve -> install -> resume`; если секреты/инфра мешают, перевести в `blocked_external` с точным перечнем.
- **evidence:** Дедуп bootstrap-запросов исправлен; `blockedRunResume` merge'ится в одну запись; automated continuation path подтверждён focused test.
- **2026-04-06:** Подагент: исправлен дедуп bootstrap-запросов (подпись без `blockedRunId`) + merge `blockedRunResume` в одну запись; тесты `service.test.ts` (approve → continuation → run → followup). Остаётся T5 (PDF/Telegram).

### S86-04 — runtime inspector visibility (route / blocked resume / lifecycle)

- **priority:** 4
- **status:** in_progress
- **dependsOn:** S86-01 (желательно), S86-03 (для blocked resume)
- **userValue:** В Sessions виден контекст маршрута, bootstrap/blocking, жизненный цикл согласован с runtime truth.
- **ownedFiles:** `ui/src/ui/views/sessions.ts`, `ui/src/ui/controllers/runtime-inspector.ts`, `ui/src/ui/views/bootstrap.ts`, i18n `ui/src/i18n/locales/*.ts`
- **requiredValidation:** T1 (sessions/bootstrap UI unit tests), T2 `pnpm build` при изменении UI, T5 → кейс 6
- **doneWhen:** Кейс 6 выполнен; если в коде ещё нет поля `modelRouteTier` — slice остаётся `in_progress` пока контракт UI не совпадёт с [../stage86_test_cases.md](../stage86_test_cases.md) или чеклист не обновлён осознанно.
- **executionState:** waiting_manual
- **lastValidation:** 2026-04-08: T1 re-pass (`ui/src/ui/views/sessions.test.ts`), control UI reachable at `127.0.0.1:18789`, session chooser/model selector/Sessions surface грузятся; T5 pending_manual on stable quiet runtime.
- **blockerOwner:** operator
- **resumeFrom:** Выполнить T5 кейс 6 в UI и подтвердить route/bootstrap/lifecycle visibility; перед stage closure повторно убедиться, что T2 build/check зелёные для актуального UI состояния.
- **evidence:** В UI bootstrap-панели есть `modelRouteTier`; в Sessions появился runtime inspector и usage callout, контракт runtime truth не расходится по recorded notes.
- **2026-04-06:** В UI bootstrap-панели есть `modelRouteTier`; в Sessions — runtime inspector + usage stats callout (см. S86-05). Остаётся T5.

### S86-05 — usage / cost visibility

- **priority:** 5
- **status:** in_progress
- **dependsOn:** —
- **userValue:** В UI видны input/output tokens и оценка стоимости для демо-сессий.
- **ownedFiles:** `ui/src/ui/views/usage.ts`, `ui/src/ui/controllers/usage.ts`, `ui/src/ui/app-render-usage-tab.ts`, связанные тесты; при необходимости gateway/API носители метрик
- **requiredValidation:** T1 (usage controllers/views tests), T2 при изменении сборки UI, T5 → кейс 7
- **doneWhen:** Кейс 7 проходит или зафиксирован gap + задача на следующий slice.
- **executionState:** waiting_manual
- **lastValidation:** 2026-04-06: T1 pass (usage controllers/views + sessions mapping tests), T2 should be re-confirmed with final UI bundle, T5 pending_manual.
- **blockerOwner:** operator
- **resumeFrom:** Выполнить T5 кейс 7 и подтвердить в UI `inputTokens`, `outputTokens` и cost; если данные не доходят до UI, вернуть slice в `fixing`.
- **evidence:** `estimatedCostUsd` проведён до UI-строки; usage stats видны под runtime inspector; `sessions.changed` mapping добавлен.
- **2026-04-06:** Подагент: `estimatedCostUsd` в типе строки UI, коллаут Usage stats под runtime inspector (`inputTokens` / `outputTokens` / cost), `sessions.changed` mapping; тесты sessions + controllers. Остаётся T5.

### S86-06 — Telegram E2E proof + стабильность 15-мин сессии

- **priority:** 6
- **status:** open
- **dependsOn:** S86-01, S86-03 (минимум для сквозного демо)
- **userValue:** Полный сквозной сценарий через Telegram согласно success criteria Stage 86.
- **ownedFiles:** сквозные; уточнять по результатам S86-01…05 (каналы, gateway, session sync)
- **requiredValidation:** T1–T4 по факту затронутых областей перед объявлением готовности трека; **T5 — полный прогон** [../stage86_test_cases.md](../stage86_test_cases.md)
- **doneWhen:** Выполнены success criteria из [../stage86_test_cases.md](../stage86_test_cases.md) (**8/8 кейсов** Stage 86, gateway стабилен, bootstrap после approval автоматический); это foundation для общего live gate `10/10` из [../v1_user_acceptance_cases.md](../v1_user_acceptance_cases.md).
- **executionState:** queued
- **lastValidation:** 2026-04-08: deterministic preconditions partially revalidated (gateway up, control UI reachable, focused T1 reruns green), but full Stage 86 live proof still blocked by external Hydra 403 on remote cases and by residual stale heartbeat session state.
- **blockerOwner:** main-agent
- **resumeFrom:** После закрытия S86-01 и S86-03 собрать точный touched scope, прогнать нужные T1–T4 и затем полный T5-прогон Stage 86.
- **evidence:** Сквозная Telegram proof ещё не зафиксирована; этот slice агрегирует результаты S86-01…05 в финальный stage-level proof.
- **2026-04-08:** Live gate пока невалиден: local provider path подтверждён прямым Ollama probe, но Hydra remote path externally blocked (`/v1/models` -> 403), поэтому кейсы 2/3/8 и полный 8/8 Stage 86 пока нельзя честно закрыть.

### H1-01 — universal file/table/report flow

- **priority:** 7
- **status:** open
- **dependsOn:** S86-06
- **userValue:** Бот принимает два CSV/Excel файла, сравнивает и нормализует строки, выдаёт ranked summary и умеет материализовать clean markdown/PDF report без хрупких ручных шагов.
- **ownedFiles:** `src/platform/recipe/**`, `src/platform/document/**`, `src/platform/materialization/**`, `src/platform/decision/input.ts`, `src/platform/decision/route-preflight.ts`, `src/agents/tools/pdf-tool.ts`, связанные `*.test.ts`
- **requiredValidation:** T1 (recipe + decision + document/materialization tests), T2 (`pnpm check`, `pnpm build`), T3 если меняется gateway/chat execution path, T5 → live investor scenarios `Сгенерируй PDF-отчет` и `Сравни эти два прайса и скажи, у кого лучше покупать`; user acceptance cases 9 (и при необходимости связанный artifact path)
- **doneWhen:** Два CSV/Excel файла дают нормализованное сравнение с рекомендацией; report flow отдаёт пригодный markdown/PDF; для табличных и report задач виден правдоподобный маршрут local/mid-tier/strong по сложности; сценарий 9 из [../v1_user_acceptance_cases.md](../v1_user_acceptance_cases.md) проходит живьём.
- **executionState:** queued
- **lastValidation:** Не начато.
- **blockerOwner:** main-agent
- **resumeFrom:** После Stage 86 взять этот slice как следующий основной workstream и начать с contract audit по recipe/document/materialization seams.
- **evidence:** Horizon 1 scope определён, но implementation/validation evidence ещё нет.

### H1-02 — structured calculation flow + builder context preset

- **priority:** 8
- **status:** open
- **dependsOn:** H1-01
- **userValue:** Builder/project-designer сценарии используют лёгкий доменный контекст, а расчётные задачи дают структурированный ответ с assumptions, units, formulas и report output.
- **ownedFiles:** `src/platform/profile/**`, `src/platform/recipe/**`, `src/platform/decision/input.ts`, `src/platform/decision/route-preflight.ts`, `src/agents/system-prompt.ts`, `src/agents/pi-embedded-runner/**`, связанные `*.test.ts`
- **requiredValidation:** T1 (profile + recipe + runner tests), T2 (`pnpm check`, `pnpm build`), T3 если меняется gateway/chat execution path, T5 → live investor scenario `Посчитай вентиляцию по этим размерам и сделай сводку`; user acceptance case 10
- **doneWhen:** Builder context добавляет нормы/единицы/типовые формулы без отдельной capability; вентиляционный demo-flow выдаёт структурированный расчёт с assumptions и units; latency и bootstrap поведение не деградируют; сценарий 10 из [../v1_user_acceptance_cases.md](../v1_user_acceptance_cases.md) проходит живьём.
- **executionState:** queued
- **lastValidation:** Не начато.
- **blockerOwner:** main-agent
- **resumeFrom:** Стартовать только после H1-01; первый шаг — зафиксировать builder-context seam и structured-calculation contract.
- **evidence:** Slice зависит от H1-01 и пока не должен начинаться параллельно.

### H1-03 — investor demo proof + final Horizon 1 handoff

- **priority:** 9
- **status:** open
- **dependsOn:** H1-02
- **userValue:** Весь investor-facing Horizon 1 можно показать сквозным live-сценарием через UI и бота без устных оговорок про недостающие куски.
- **ownedFiles:** сквозные; обновлять по факту touched areas и итогового handoff
- **requiredValidation:** T1–T4 для затронутых областей; **T5 — полный live regression** по [../v1_user_acceptance_cases.md](../v1_user_acceptance_cases.md) и [../stage86_test_cases.md](../stage86_test_cases.md)
- **doneWhen:** Проходят **10/10** сценариев из [../v1_user_acceptance_cases.md](../v1_user_acceptance_cases.md), включая success criteria Stage 86; backlog по Horizon 1 пуст; готов короткий user-testable handoff.
- **executionState:** queued
- **lastValidation:** Не начато.
- **blockerOwner:** main-agent
- **resumeFrom:** Запускать только после закрытия H1-02; собрать финальный regression matrix и user-testable handoff.
- **evidence:** Это финальный aggregation slice, а не место для раннего discovery.

---

## Условие «v1 ready for user test» (stop / handoff)

Считать Horizon 1 **готовым**, только если одновременно:

1. Все slice’ы текущего Horizon 1 в этом файле в статусе `done` **или** оставшиеся `open` перенесены в отдельный явный follow-up с согласования пользователя.
2. Обязательные автоматические tier’ы для затронутого scope зелёные (минимум для релизной границы: **T4** перед тегом v1).
3. Пройдено **10/10** живых сценариев из [../v1_user_acceptance_cases.md](../v1_user_acceptance_cases.md), включая Stage 86 foundation из [../stage86_test_cases.md](../stage86_test_cases.md).
4. Во время live-прогона бот реально отвечает, устанавливает, продолжает, создаёт артефакты и не падает на основных пользовательских путях.
5. В чат/отчёт добавлен краткий handoff: что проверено автоматически и какие 10 сценариев пройдены руками.

Если выполнение невозможно без расширения scope, секретов или противоречивого продукта — **остановиться**, статус `blocked`, описать блокер в этом файле (секция ниже).

`blocked` допустим только если одновременно заполнены:

- `executionState: blocked_external|blocked_scope`
- `blockerOwner`
- `resumeFrom`
- строка в журнале блокеров ниже

## Блокеры (append-only журнал)

| Дата | Slice | Блокер | Нужно от кого |
| ---- | ----- | ------ | ------------- |
| —    | —     | —      | —             |
