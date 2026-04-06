# Autonomous v1 — active execution backlog

## Назначение

Единственный операционный ответ на вопрос **«что делать следующим прямо сейчас»** в рамках текущего v1 execution slice (Stage 86: smart routing + bootstrap + Telegram proof).

Не заменяет:

- продуктовую границу: [autonomous_v1_roadmap_cb6fe0e6.plan.md](autonomous_v1_roadmap_cb6fe0e6.plan.md);
- короткий handoff: [master_v1_roadmap.md](master_v1_roadmap.md);
- долгую карту: [sovereign_ai_map_8e04210e.plan.md](sovereign_ai_map_8e04210e.plan.md).

Протокол итерации: [autonomous_v1_loop_a69b9e98.plan.md](autonomous_v1_loop_a69b9e98.plan.md).  
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

### Лестница tier’ов (кратко)

- **T1** — focused тесты затронутых модулей (`pnpm test -- <paths>`).
- **T2** — `pnpm check` и при затрагивании сборки/бандла — `pnpm build`.
- **T3** — `pnpm test:e2e:smoke` (если затронуты gateway boot / chat / runtime wiring).
- **T4** — `pnpm test:v1-gate` (recovery/session-event surfaces; **обязателен** перед объявлением v1 ready).
- **T5** — ручной протокол из `.cursor/stage86_test_cases.md` для соответствующих кейсов.

Подробности и стоп-условия: [stage_86_smart_routing_bootstrap.plan.md](stage_86_smart_routing_bootstrap.plan.md).

---

## Stage 86 — ordered backlog slices

Обновляй столбец `status` при работе; главный агент ведёт этот файл как единственный backlog источник.

### S86-01 — routing parity + session-aware preflight

- **priority:** 1
- **status:** in_progress
- **dependsOn:** —
- **userValue:** Простые реплики уходят на локальную модель, сложные — на сильный маршрут; в логах/UI согласованы режимы preflight и выбранная модель.
- **ownedFiles:** `src/platform/decision/**`, `src/agents/model-fallback.ts`, `src/auto-reply/reply/agent-runner-*.ts`, `src/agents/agent-command.ts`, связанные `*.test.ts`
- **requiredValidation:** T1 (decision + model-fallback + agent-runner utils), T2 при изменении широкого wiring, T3 если меняется путь до gateway/session boot, T5 → кейсы 1, 2, 8 из [../stage86_test_cases.md](../stage86_test_cases.md)
- **doneWhen:** Детерминированная часть зелёная; продуктовые ожидания по модели/логам подтверждены T5; fallback chain (кейс 3) — по возможности T5 или явный `blocked` с причиной (сеть/инфра).
- **2026-04-06:** Параллельные подагенты: в `model-fallback` добавлены стабильные строки `preflightMode: local_eligible|remote_required` и `model_fallback: … failed, trying …`; в UI Sessions — колонка `provider/model`; в bootstrap context — `modelRouteTier`. Автотесты: `model-fallback.test`, `sessions.test`, `bootstrap.test` зелёные. Остаётся T5 (Telegram/gateway).

### S86-02 — prompt optimization visibility

- **priority:** 2
- **status:** in_progress
- **dependsOn:** —
- **userValue:** Видно, что промпт нормализован/сжат до модели; в логах есть измеримый след оптимизации.
- **ownedFiles:** `src/context-engine/prompt-optimize.ts`, `src/agents/pi-embedded-runner/run/attempt.ts`, `src/plugins/hooks.ts`, связанные тесты
- **requiredValidation:** T1 (prompt-optimize + attempt), T2 при затрагивании плагинных типов/сборки, T5 → кейс 5
- **doneWhen:** Логи/контракт соответствуют чеклисту кейса 5 или задокументировано целевое поле логов; тесты покрывают регрессии merge отчётов.
- **2026-04-06:** Метрики в `PromptOptimizationReport`, лог `promptOptimization: {…}` в `attempt.ts`, тесты `prompt-optimize.test.ts` зелёные. Остаётся T5 grep по живому gateway log.

### S86-03 — bootstrap approve → install → resume

- **priority:** 3
- **status:** in_progress
- **dependsOn:** —
- **userValue:** Запрос capability ведёт к approval в UI/Telegram, установке и **авто-продолжению** run без повторного пинга пользователя.
- **ownedFiles:** `src/platform/bootstrap/**`, `src/platform/recipe/runtime-adapter.ts`, `ui/src/ui/views/bootstrap.ts`, связанные тесты
- **requiredValidation:** T1 (bootstrap/catalog/registry), T2 при изменении UI bundle, T3 если меняется gateway-facing bootstrap, T5 → кейс 4
- **doneWhen:** Кейс 4 в [../stage86_test_cases.md](../stage86_test_cases.md) проходит по сценарию «approve → install → resume»; если live секреты недоступны — `blocked` с точным списком, что нужно от оператора.
- **2026-04-06:** Подагент: исправлен дедуп bootstrap-запросов (подпись без `blockedRunId`) + merge `blockedRunResume` в одну запись; тесты `service.test.ts` (approve → continuation → run → followup). Остаётся T5 (PDF/Telegram).

### S86-04 — runtime inspector visibility (route / blocked resume / lifecycle)

- **priority:** 4
- **status:** in_progress
- **dependsOn:** S86-01 (желательно), S86-03 (для blocked resume)
- **userValue:** В Sessions виден контекст маршрута, bootstrap/blocking, жизненный цикл согласован с runtime truth.
- **ownedFiles:** `ui/src/ui/views/sessions.ts`, `ui/src/ui/controllers/runtime-inspector.ts`, `ui/src/ui/views/bootstrap.ts`, i18n `ui/src/i18n/locales/*.ts`
- **requiredValidation:** T1 (sessions/bootstrap UI unit tests), T2 `pnpm build` при изменении UI, T5 → кейс 6
- **doneWhen:** Кейс 6 выполнен; если в коде ещё нет поля `modelRouteTier` — slice остаётся `in_progress` пока контракт UI не совпадёт с [../stage86_test_cases.md](../stage86_test_cases.md) или чеклист не обновлён осознанно.
- **2026-04-06:** В UI bootstrap-панели есть `modelRouteTier`; в Sessions — runtime inspector + usage stats callout (см. S86-05). Остаётся T5.

### S86-05 — usage / cost visibility

- **priority:** 5
- **status:** in_progress
- **dependsOn:** —
- **userValue:** В UI видны input/output tokens и оценка стоимости для демо-сессий.
- **ownedFiles:** `ui/src/ui/views/usage.ts`, `ui/src/ui/controllers/usage.ts`, `ui/src/ui/app-render-usage-tab.ts`, связанные тесты; при необходимости gateway/API носители метрик
- **requiredValidation:** T1 (usage controllers/views tests), T2 при изменении сборки UI, T5 → кейс 7
- **doneWhen:** Кейс 7 проходит или зафиксирован gap + задача на следующий slice.
- **2026-04-06:** Подагент: `estimatedCostUsd` в типе строки UI, коллаут Usage stats под runtime inspector (`inputTokens` / `outputTokens` / cost), `sessions.changed` mapping; тесты sessions + controllers. Остаётся T5.

### S86-06 — Telegram E2E proof + стабильность 15-мин сессии

- **priority:** 6
- **status:** open
- **dependsOn:** S86-01, S86-03 (минимум для сквозного демо)
- **userValue:** Полный сквозной сценарий через Telegram согласно success criteria Stage 86.
- **ownedFiles:** сквозные; уточнять по результатам S86-01…05 (каналы, gateway, session sync)
- **requiredValidation:** T1–T4 по факту затронутых областей перед объявлением готовности трека; **T5 — полный прогон** [../stage86_test_cases.md](../stage86_test_cases.md)
- **doneWhen:** Выполнены success criteria из [../stage86_test_cases.md](../stage86_test_cases.md) (6+/8 кейсов, gateway стабилен, bootstrap после approval автоматический).

---

## Условие «v1 ready for user test» (stop / handoff)

Считать трек **готовым к финальному ручному прогону пользователем**, только если одновременно:

1. Все slice’ы Stage 86 в этом файле в статусе `done` **или** оставшиеся `open` перенесены в отдельный явный follow-up с согласования пользователя.
2. Обязательные автоматические tier’ы для затронутого scope зелёные (минимум для релизной границы: **T4** перед тегом v1).
3. Протокол T5 по [../stage86_test_cases.md](../stage86_test_cases.md) выполнен оператором или зафиксированы блокеры (секреты, сеть, внешние сервисы).
4. В чат/отчёт добавлен краткий handoff: что проверено автоматически и что пользователь должен нажать/прочитать вручную.

Если выполнение невозможно без расширения scope, секретов или противоречивого продукта — **остановиться**, статус `blocked`, описать блокер в этом файле (секция ниже).

## Блокеры (append-only журнал)

| Дата | Slice | Блокер | Нужно от кого |
| ---- | ----- | ------ | ------------- |
| —    | —     | —      | —             |
