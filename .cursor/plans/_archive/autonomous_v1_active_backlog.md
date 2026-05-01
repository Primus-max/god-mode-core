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
- **status:** blocked
- **dependsOn:** —
- **userValue:** Простые реплики уходят на локальную модель, сложные — на сильный маршрут; в логах/UI согласованы режимы preflight и выбранная модель.
- **ownedFiles:** `src/platform/decision/**`, `src/agents/model-fallback.ts`, `src/auto-reply/reply/agent-runner-*.ts`, `src/agents/agent-command.ts`, связанные `*.test.ts`
- **requiredValidation:** T1 (decision + model-fallback + agent-runner utils), T2 при изменении широкого wiring, T3 если меняется путь до gateway/session boot, T5 → кейсы 1, 2, 8 из [../stage86_test_cases.md](../stage86_test_cases.md)
- **doneWhen:** Детерминированная часть зелёная; продуктовые ожидания по модели/логам подтверждены T5; fallback chain (кейс 3) — по возможности T5 или явный `blocked` с причиной (сеть/инфра).
- **executionState:** blocked_external
- **lastValidation:** 2026-04-11: route truth остаётся зелёным на live runtime/gateway bundle (`stage86-live-matrix.current.json`, `20/20`, кейсы `case01-local-greeting`, `case04-remote-saas-metrics`, `case06-explicit-hydra-translate` pass). Но честный Telegram product-path для кейсов 1/2/8 сейчас внешне заблокирован: direct `curl -4 -I https://api.telegram.org` timeout, `Test-NetConnection api.telegram.org -Port 443` даёт `TcpTestSucceeded=False`, а текущий proxy `http://72.56.28.130:3128` больше не поднимает ни `getMe`, ни `getUpdates`.
- **blockerOwner:** external-network / operator
- **resumeFrom:** Дать рабочий Telegram egress (живой proxy/VPN/другая сеть), перезапустить gateway и сразу повторить T5 Telegram product-path для кейсов 1, 2 и 8 с приложением route truth.
- **evidence:** `stage86-live-matrix.current.json` подтверждает local/remote/explicit route truth на живом gateway; gateway terminal `126503.txt` с `2026-04-11T13:17+03:00` фиксирует бесконечные `Polling stall detected` и `setMyCommands failed`; сетевые пробы 2026-04-11: direct `api.telegram.org:443` недоступен, текущий proxy `72.56.28.130:3128` недоступен.
- **2026-04-06:** Параллельные подагенты: в `model-fallback` добавлены стабильные строки `preflightMode: local_eligible|remote_required` и `model_fallback: … failed, trying …`; в UI Sessions — колонка `provider/model`; в bootstrap context — `modelRouteTier`. Автотесты: `model-fallback.test`, `sessions.test`, `bootstrap.test` зелёные. Остаётся T5 (Telegram/gateway).
- **2026-04-08:** Runtime audit: починен `~/.openclaw/openclaw.json` (`channels.telegram.streaming` был сломан типом/хвостом), clean gateway снова слушает `127.0.0.1:18789`, control UI подключается. Выявлен внешний блокер remote-path: Hydra rate/access limiter возвращает 403 даже на прямой `/v1/models`. Дополнительно отключён шумный cron `Template Request Check` (`6fc09ba2-3922-47af-812b-bdc93df69719`) и `set-heartbeats=false`, чтобы не жечь remote quota во время Stage 86 live reruns.

### S86-02 — prompt optimization visibility

- **priority:** 2
- **status:** done
- **dependsOn:** —
- **userValue:** Видно, что промпт нормализован/сжат до модели; в логах есть измеримый след оптимизации.
- **ownedFiles:** `src/context-engine/prompt-optimize.ts`, `src/agents/pi-embedded-runner/run/attempt.ts`, `src/plugins/hooks.ts`, связанные тесты
- **requiredValidation:** T1 (prompt-optimize + attempt), T2 при затрагивании плагинных типов/сборки, T5 → кейс 5
- **doneWhen:** Логи/контракт соответствуют чеклисту кейса 5 или задокументировано целевое поле логов; тесты покрывают регрессии merge отчётов.
- **executionState:** completed
- **lastValidation:** 2026-04-09: root cause confirmed on live ingress path: `chat.send` injects `[Thu ...]` timestamp into `BodyForAgent` before `deterministicPromptOptimize`, so the Stage 86 sample no longer starts with outer blank lines by the time optimization runs. That makes the honest live contract `trimmedWhitespace: 1`, `collapsedLines: 1` instead of raw-text `7/2`. T1 pass after adding regression coverage for both contracts (`pnpm test -- src/context-engine/prompt-optimize.test.ts`).
- **blockerOwner:** —
- **resumeFrom:** Вернуться к stage-level live rerun и проверять кейс 5 по разделённому contract: raw deterministic `7/2`, live gateway `1/1`.
- **evidence:** Terminal log around `2026-04-09T09:06:14` already showed `promptOptimization = 1/1`; code path in `src/gateway/server-methods/chat.ts` stamps `BodyForAgent` via `injectTimestamp()` before the runner; regression test now locks the live stamped sample to `1/1`, while the raw deterministic sample remains covered at `7/2`.
- **2026-04-06:** Метрики в `PromptOptimizationReport`, лог `promptOptimization: {…}` в `attempt.ts`, тесты `prompt-optimize.test.ts` зелёные. Остаётся T5 grep по живому gateway log.

### S86-03 — bootstrap approve → install → resume

- **priority:** 3
- **status:** done
- **dependsOn:** —
- **userValue:** Запрос capability ведёт к approval в UI/Telegram, установке и **авто-продолжению** run без повторного пинга пользователя.
- **ownedFiles:** `src/platform/bootstrap/**`, `src/platform/recipe/runtime-adapter.ts`, `ui/src/ui/views/bootstrap.ts`, связанные тесты
- **requiredValidation:** T1 (bootstrap/catalog/registry), T2 при изменении UI bundle, T3 если меняется gateway-facing bootstrap, T5 → кейс 4
- **doneWhen:** Кейс 4 в [../stage86_test_cases.md](../stage86_test_cases.md) проходит по сценарию «approve → install → resume»; если live секреты недоступны — `blocked` с точным списком, что нужно от оператора.
- **executionState:** completed
- **lastValidation:** 2026-04-09: T1 pass (`pnpm test -- src/agents/tools/pdf-tool.test.ts`, 56/56), T2 pass (`pnpm build`). Live rerun на fresh isolated runtime `stage86-state-live11` подтвердил целевой product-path для `case4`: первичный `pdf` tool создал `pdf-renderer` bootstrap request `475c2572-2152-4be6-9ca4-d4c37478e465`, затем turn был жёстко остановлен через `openclaw.sessions_yield` (без обхода в `write/exec`), после `approve -> run` bootstrap audit зафиксировал `request.approved -> request.started -> request.available -> request.resume_enqueued`, а resumed run снова вызвал `pdf` и получил `toolResult.details.model = "pdf-renderer"` с готовым PDF файлом.
- **blockerOwner:** —
- **resumeFrom:** Перенести внимание на S86-02 и затем включить обновлённый `case4` proof в stage-level live rerun `8/8`.
- **evidence:** Live11 proof: `stage86-state-live11/agents/main/sessions/00d7bb16-0679-43be-89a8-bc32fc8e45ed.jsonl` содержит последовательность `pdf (degraded html) -> openclaw.sessions_yield -> resumed pdf -> toolResult model=pdf-renderer`; `stage86-state-live11/platform/bootstrap/requests-audit.jsonl` фиксирует `request.available` и `request.resume_enqueued`. Дополнительно был пойман и устранён live drift: без hard-stop модель могла продолжать после degraded `pdf` tool result и уходить в `write`, поэтому `pdf` tool теперь вызывает `onYield` сразу после создания bootstrap request.
- **2026-04-06:** Подагент: исправлен дедуп bootstrap-запросов (подпись без `blockedRunId`) + merge `blockedRunResume` в одну запись; тесты `service.test.ts` (approve → continuation → run → followup). Остаётся T5 (PDF/Telegram).

### S86-04 — runtime inspector visibility (route / blocked resume / lifecycle)

- **priority:** 4
- **status:** done
- **dependsOn:** S86-01 (желательно), S86-03 (для blocked resume)
- **userValue:** В Sessions виден контекст маршрута, bootstrap/blocking, жизненный цикл согласован с runtime truth.
- **ownedFiles:** `ui/src/ui/views/sessions.ts`, `ui/src/ui/controllers/runtime-inspector.ts`, `ui/src/ui/views/bootstrap.ts`, i18n `ui/src/i18n/locales/*.ts`
- **requiredValidation:** T1 (sessions/bootstrap UI unit tests), T2 `pnpm build` при изменении UI, T5 → кейс 6
- **doneWhen:** Кейс 6 выполнен; если в коде ещё нет поля `modelRouteTier` — slice остаётся `in_progress` пока контракт UI не совпадёт с [../stage86_test_cases.md](../stage86_test_cases.md) или чеклист не обновлён осознанно.
- **executionState:** completed
- **lastValidation:** 2026-04-10: T5 UI proof obtained on live16 control UI at `http://127.0.0.1:18789`. `Sessions` page now renders fresh Stage 86 rows directly in the operator surface: latest sessions show real `provider/model` values (`hydra/gpt-4o`, `ollama/gemma4:e4b`) plus token counts in the table, and opening the latest user-like session shows the runtime chat context block (`Profile`, `Task overlay`, `Planner reasoning`) for the live conversation. Device pairing for the control UI was auto-approved by the gateway and subsequent `webchat connected` / `chat.history` responses confirm the UI is reading live runtime state rather than stale fixtures.
- **blockerOwner:** none
- **resumeFrom:** Считать case 6 закрытым; следующий remaining stage blocker находится уже в S86-06 (Telegram live proof).
- **evidence:** Live UI `Sessions` page on `18789` lists `agent:main:thread:stage86-user-like-1775813629688` with `hydra/gpt-4o` and token counts, alongside `agent:main:thread:stage86-case1-1775812305933` with `ollama/gemma4:e4b`; opening the latest user-like session in Chat shows the runtime context card for the same live session. Gateway log also captured `device pairing auto-approved` followed by successful control UI `webchat connected` and `chat.history` responses.
- **2026-04-06:** В UI bootstrap-панели есть `modelRouteTier`; в Sessions — runtime inspector + usage stats callout (см. S86-05). Остаётся T5.

### S86-05 — usage / cost visibility

- **priority:** 5
- **status:** done
- **dependsOn:** —
- **userValue:** В UI видны input/output tokens и оценка стоимости для демо-сессий.
- **ownedFiles:** `ui/src/ui/views/usage.ts`, `ui/src/ui/controllers/usage.ts`, `ui/src/ui/app-render-usage-tab.ts`, связанные тесты; при необходимости gateway/API носители метрик
- **requiredValidation:** T1 (usage controllers/views tests), T2 при изменении сборки UI, T5 → кейс 7
- **doneWhen:** Кейс 7 проходит или зафиксирован gap + задача на следующий slice.
- **executionState:** completed
- **lastValidation:** 2026-04-10: T5 UI proof obtained on live16 control UI `Usage` page. The operator-facing surface renders live session usage with totals and per-session rows, including recent Stage 86 sessions such as `agent:main:thread:stage86-user-like-1775813629688` (`provider:hydra`, `model:gpt-4o`, `37.7K`) and `agent:main:thread:stage86-case1-1775812305933` (`provider:ollama`, `model:gemma4:e4b`, `13.4K`). Gateway log confirms real UI fetches via `sessions.usage` after control UI pairing, so the page is backed by live runtime data rather than test mocks.
- **blockerOwner:** none
- **resumeFrom:** Считать case 7 закрытым; дальнейшая работа — только финальный stage bundle и Telegram proof в S86-06.
- **evidence:** Live control UI `Usage` page shows `875.9K Tokens`, `21 sessions`, and recent Stage 86 rows with concrete provider/model/tokens values; gateway log records successful `sessions.usage` responses for the control UI websocket client right after pairing.
- **2026-04-06:** Подагент: `estimatedCostUsd` в типе строки UI, коллаут Usage stats под runtime inspector (`inputTokens` / `outputTokens` / cost), `sessions.changed` mapping; тесты sessions + controllers. Остаётся T5.

### S86-06 — Telegram E2E proof + стабильность 15-мин сессии

- **priority:** 6
- **status:** blocked
- **dependsOn:** S86-01, S86-03 (минимум для сквозного демо)
- **userValue:** Полный сквозной сценарий через Telegram согласно success criteria Stage 86.
- **ownedFiles:** сквозные; уточнять по результатам S86-01…05 (каналы, gateway, session sync)
- **requiredValidation:** T1–T4 по факту затронутых областей перед объявлением готовности трека; **T5 — полный прогон** [../stage86_test_cases.md](../stage86_test_cases.md)
- **doneWhen:** Выполнены success criteria из [../stage86_test_cases.md](../stage86_test_cases.md) (**8/8 кейсов** Stage 86, gateway стабилен, bootstrap после approval автоматический); это foundation для общего live gate `10/10` из [../v1_user_acceptance_cases.md](../v1_user_acceptance_cases.md).
- **executionState:** blocked_external
- **lastValidation:** 2026-04-11: deterministic + gateway-facing evidence is strong: latest live bundle `stage86-live-matrix.current.json` is `20/20` green, including Stage 86 foundation-equivalent route/tool/recovery/UI scenarios plus investor-facing cases 9-10. Но Stage 86 exit criterion всё ещё требует честный Telegram T5 `8/8` и 15-minute stability proof, а текущая среда его не даёт: direct `api.telegram.org:443` timeout, configured proxy `72.56.28.130:3128` dead, gateway log зациклился на `Polling stall detected` / `setMyCommands failed`.
- **blockerOwner:** external-network / operator
- **resumeFrom:** Восстановить Telegram egress, затем повторить Stage 86 через реальный Telegram channel для кейсов 1-8 и снять 15-minute stability proof без polling stalls.
- **evidence:** `stage86-live-matrix.current.json` (`20/20`, `failedIds=[]`); gateway terminal `126503.txt` показывает долгую серию Telegram stalls после `2026-04-11T13:17+03:00`; прямой `Test-NetConnection api.telegram.org -Port 443` провален, текущий proxy тоже не соединяется.
- **2026-04-08:** Historical blocker before proxy mitigation: live gate был невалиден, потому что direct Telegram reachability and Hydra remote path were externally unstable (`UND_ERR_CONNECT_TIMEOUT`, `/v1/models -> 403`). Этот блокер больше не является текущим stop reason.

### H1-01 — universal file/table/report flow

- **priority:** 7
- **status:** done
- **dependsOn:** S86-06
- **userValue:** Бот принимает два CSV/Excel файла, сравнивает и нормализует строки, выдаёт ranked summary и умеет материализовать clean markdown/PDF report без хрупких ручных шагов.
- **ownedFiles:** `src/platform/recipe/**`, `src/platform/document/**`, `src/platform/materialization/**`, `src/platform/decision/input.ts`, `src/platform/decision/route-preflight.ts`, `src/agents/tools/pdf-tool.ts`, связанные `*.test.ts`
- **requiredValidation:** T1 (recipe + decision + document/materialization tests), T2 (`pnpm check`, `pnpm build`), T3 если меняется gateway/chat execution path, T5 → live investor scenarios `Сгенерируй PDF-отчет` и `Сравни эти два прайса и скажи, у кого лучше покупать`; user acceptance cases 9 (и при необходимости связанный artifact path)
- **doneWhen:** Два CSV/Excel файла дают нормализованное сравнение с рекомендацией; report flow отдаёт пригодный markdown/PDF; для табличных и report задач виден правдоподобный маршрут local/mid-tier/strong по сложности; сценарий 9 из [../v1_user_acceptance_cases.md](../v1_user_acceptance_cases.md) проходит живьём.
- **executionState:** completed
- **lastValidation:** 2026-04-11: live runtime bundle `stage86-live-matrix.current.json` закрыл document/report workflow end-to-end. `case15-single-csv-summary`, `case16-price-compare-two-files`, `case17-price-compare-followup` и `case18-markdown-report` прошли на живом gateway без дублей и recovery leaks; бот принял вложения, сохранил контекст между ходами и выдал осмысленную сводку/сравнение.
- **blockerOwner:** none
- **resumeFrom:** Slice закрыт.
- **evidence:** Артефакт `stage86-live-matrix.current.json`: `case16` и `case17` подтверждают investor scenario 9 (сравнение двух прайсов и follow-up), `case18` подтверждает clean markdown report path, `case15` закрывает single-file summary path.

### H1-02 — structured calculation flow + builder context preset

- **priority:** 8
- **status:** done
- **dependsOn:** H1-01
- **userValue:** Builder/project-designer сценарии используют лёгкий доменный контекст, а расчётные задачи дают структурированный ответ с assumptions, units, formulas и report output.
- **ownedFiles:** `src/platform/profile/**`, `src/platform/recipe/**`, `src/platform/decision/input.ts`, `src/platform/decision/route-preflight.ts`, `src/agents/system-prompt.ts`, `src/agents/pi-embedded-runner/**`, связанные `*.test.ts`
- **requiredValidation:** T1 (profile + recipe + runner tests), T2 (`pnpm check`, `pnpm build`), T3 если меняется gateway/chat execution path, T5 → live investor scenario `Посчитай вентиляцию по этим размерам и сделай сводку`; user acceptance case 10
- **doneWhen:** Builder context добавляет нормы/единицы/типовые формулы без отдельной capability; вентиляционный demo-flow выдаёт структурированный расчёт с assumptions и units; latency и bootstrap поведение не деградируют; сценарий 10 из [../v1_user_acceptance_cases.md](../v1_user_acceptance_cases.md) проходит живьём.
- **executionState:** completed
- **lastValidation:** 2026-04-11: live runtime bundle `stage86-live-matrix.current.json` закрыл structured calculation flow. `case19-ventilation-summary` проходит с assumptions/formula/structured summary на живом runtime; language continuity regression отдельно снята и подтверждена финальным `20/20` rerun. Report-capable flow дополнительно подтверждён markdown/PDF материализацией в соседних live cases.
- **blockerOwner:** none
- **resumeFrom:** Slice закрыт.
- **evidence:** `stage86-live-matrix.current.json` содержит `case19-ventilation-summary: ok=true`; prior failing rerun (`19/20`, language drift) был исправлен и заменён финальным зелёным bundle `20/20`.

### H1-03 — investor demo proof + final Horizon 1 handoff

- **priority:** 9
- **status:** blocked
- **dependsOn:** H1-02
- **userValue:** Весь investor-facing Horizon 1 можно показать сквозным live-сценарием через UI и бота без устных оговорок про недостающие куски.
- **ownedFiles:** сквозные; обновлять по факту touched areas и итогового handoff
- **requiredValidation:** T1–T4 для затронутых областей; **T5 — полный live regression** по [../v1_user_acceptance_cases.md](../v1_user_acceptance_cases.md) и [../stage86_test_cases.md](../stage86_test_cases.md)
- **doneWhen:** Проходят **10/10** сценариев из [../v1_user_acceptance_cases.md](../v1_user_acceptance_cases.md), включая success criteria Stage 86; backlog по Horizon 1 пуст; готов короткий user-testable handoff.
- **executionState:** blocked_external
- **lastValidation:** 2026-04-11: gateway-facing финальный regression matrix собран и зелёный (`stage86-live-matrix.current.json`, `20/20`, investor-facing scenarios 9-10 внутри bundle pass). Формально `v1 ready` всё ещё нельзя заявить, потому что rule в этом backlog требует не только live runtime, но и рабочий bot/user channel; Telegram на текущем хосте внешне недоступен и потому полный user-testable handoff через реальный бот не завершён.
- **blockerOwner:** external-network / operator
- **resumeFrom:** После восстановления Telegram egress повторить Stage 86 user-channel proof, затем собрать финальный `v1 ready` handoff без оговорок.
- **evidence:** `stage86-live-matrix.current.json` already covers gateway/runtime acceptance breadth; unresolved gap only in real Telegram ingress/egress on this host.

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
| 2026-04-10 | S86-06 | Direct egress to `api.telegram.org` from this host timed out; временно снято через `channels.telegram.proxy=http://72.56.28.130:3128`, поэтому дальнейший stop reason уже не сеть, а незавершённый Telegram T5 `8/8` + 15m gate | external-network / operator |
| 2026-04-11 | S86-06 / H1-03 | Telegram again blocked externally: direct `api.telegram.org:443` fails (`TcpTestSucceeded=False`), current proxy `72.56.28.130:3128` no longer connects, gateway log loops on `Polling stall detected` / `setMyCommands failed`; gateway-only live matrix is green (`20/20`) but real bot channel cannot be certified | external-network / operator |
