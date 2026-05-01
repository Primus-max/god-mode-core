---
name: orchestrator next steps
overview: "Самодостаточные планы для следующих чатов после фикса `persistent_worker/session_orchestration`: eval harness, композиционный контракт, sanitization/hard-stop, и наблюдаемость decision layer."
todos:
  - id: decision-eval-harness
    content: Build offline decision-eval over classifier/planner/runtime plan with real scenario fixtures.
    status: pending
  - id: composition-contract
    content: Introduce optional composition fields for deliverable, executionMode, target, schedule, and evidence.
    status: pending
  - id: sanitize-hard-stops
    content: Unify tool/policy error sanitization and enforce contract_unsatisfiable as non-success.
    status: completed
  - id: observability-trace
    content: Add compact decisionTrace for logs, debug, and failed eval cases.
    status: completed
  - id: clarify-policy-rework
    content: Classify ambiguities by blocking versus preference and suppress repeated clarify loops.
    status: completed
isProject: false
---

# Orchestrator Next-Step Plans



## Важно Про Eval-Набор

50-100 реальных запросов из логов — это не костыль, если они используются как **измерительный набор**, а не как правила маршрутизации. Нельзя делать `if prompt contains Валера`. Нужно прогонять запросы через classifier → planner → runtime plan и сравнивать структурный контракт с ожидаемым.

---

## План 1: Decision Eval Harness

### Цель

Сделать измеримый `decision-eval`, который проверяет мышление оркестратора без выполнения инструментов. Он должен ловить ошибки типа unnecessary clarify, wrong tool bundle, wrong execution mode, wrong target, internal leak risk.

### Что Изучить

- `src/platform/decision/task-classifier.ts`
- `src/platform/decision/input.ts`
- `src/platform/decision/resolution-contract.ts`
- `src/platform/recipe/planner.ts`
- `src/platform/recipe/runtime-adapter.ts`
- `scripts/dev/task-contract-eval.ts`
- `scripts/live-routing-smoke.mjs`

### Что Сделать

1. Найти существующие eval/smoke механизмы (`scripts/dev/task-contract-eval.ts`, `scripts/dev/task-classifier-live-smoke.ts`, `scripts/live-routing-smoke.mjs`) и выбрать самый лёгкий путь расширения.
2. Создать fixture-файл с реальными сценариями, например `scripts/dev/decision-eval/cases.jsonl` или рядом с существующим eval.
3. Формат кейса должен хранить:
  - `id`
  - `messages` или `prompt`
  - `channelHints` при необходимости
  - `expected.primaryOutcome` или новый композиционный аналог
  - `expected.executionMode`
  - `expected.toolBundles`
  - `expected.requestedTools`
  - `expected.shouldClarify`
  - `expected.errorTags`, например `unnecessary_clarify`, `wrong_tool_bundle`
4. Eval должен запускать только decision pipeline: classifier → planner input → resolution contract → runtime plan. Нельзя вызывать реальные tools.
5. Вывод должен быть машинно-читаемым и человекочитаемым: pass/fail, diff ожидаемого и фактического, summary по категориям ошибок.
6. Добавить минимум 20 стартовых кейсов: persistent subagent, daily report, reminder, PDF/docx/xlsx, repo tests, browser audit, external publish, ambiguous request, repeated clarify.

### Критерии Готовности

- Команда запускается локально и не требует gateway/Telegram.
- Fail показывает точное поле, где decision layer ошибся.
- Eval не содержит prompt-specific if-else логики.

---

## План 2: Композиционный Task Contract

### Цель

Уйти от одной большой enum-рамки, где `external_delivery`, `document_package`, `workspace_change` вынуждены описывать всё. Ввести композиционный контракт: что нужно, как исполнять, где/куда направлять, какие evidence нужны.

### Что Изучить

- `src/platform/decision/task-classifier.ts`
- `src/platform/decision/capability-catalog.ts`
- `src/platform/decision/tool-registry.ts`
- `src/platform/decision/resolution-contract.ts`
- `src/platform/decision/qualification-contract.ts`
- `src/platform/decision/execution-contract.ts`
- `src/platform/decision/outcome-contract.ts`

### Предлагаемая Модель

Не удалять старый контракт сразу. Добавить v2-поля рядом:

- `deliverable`: что пользователь хочет получить (`answer`, `document`, `data`, `report`, `code_change`, `worker`, etc.)
- `executionMode`: как исполнять (`respond`, `clarify`, `tool_run`, `artifact_authoring`, `persistent_worker`, `scheduled_worker`, `repo_mutation`)
- `target`: куда относится результат/исполнение (`current_chat`, `persistent_session`, `external_provider`, `workspace`, `local_runtime`)
- `schedule`: none/once/daily/weekly/cron-like, если явно есть периодичность
- `evidence`: что доказывает выполнение (`tool_receipt`, `artifact`, `spawn_receipt`, `delivery_receipt`, `test_report`)

### Что Сделать

1. Добавить v2-поля как optional в классификатор и нормализатор, не ломая старые тесты.
2. В prompt классификатора объяснить, что `primaryOutcome` legacy, а v2-поля должны описывать композицию.
3. В bridge mapping сначала использовать v2-поля, если они есть, иначе fallback на старую enum-логику.
4. Persistent worker должен маппиться так:
  - `deliverable.kind=worker` или аналог
  - `executionMode=persistent_worker`
  - `target=persistent_session`
  - `requestedTools=[sessions_spawn]`
  - `toolBundles=[session_orchestration]`
5. Не добавлять частных кейсов вроде `valera`. Имя агента должно быть параметром/constraint, не типом задачи.
6. Добавить tests на русские и английские формулировки.

### Критерии Готовности

- Старые сценарии продолжают проходить через legacy fallback.
- Новые сценарии persistent/scheduled worker не проходят через `external_delivery`.
- Контракт читается как независимые признаки, а не как один огромный enum.

---

## План 3: Tool Error Sanitization And Hard Stops

### Цель

Убрать утечки внутренних policy/tool строк в пользовательский ответ и не позволять `contract_unsatisfiable` выглядеть как успешное выполнение.

### Что Изучить

- `src/agents/pi-tool-definition-adapter.ts`
- `src/agents/pi-embedded-subscribe.tools.ts`
- `src/agents/pi-embedded-subscribe.handlers.tools.ts`
- `src/agents/pi-embedded-helpers/errors.ts`
- `src/gateway/tools-invoke-http.ts`
- `src/platform/runtime/execution-intent-from-plan.ts`
- `src/agents/pi-embedded-runner/run.ts`
- `src/auto-reply/reply/agent-runner.ts`

### Что Сделать

1. Создать единый sanitizer для tool/policy error reasons.
2. Raw error можно логировать, но в receipt/user-facing поле должна попадать безопасная категория:
  - `tool_not_allowed_in_channel`
  - `approval_required`
  - `tool_input_invalid`
  - `tool_temporarily_unavailable`
  - `execution_contract_unsatisfied`
3. Заменить user-facing raw строки вроде `Only reminder scheduling is allowed from this chat.` на безопасное сообщение.
4. Проверить `buildToolExecutionReceipt`: reasons не должны напрямую брать raw `error/message/reason` без sanitization.
5. Проверить failure path до первого ответа: `Agent failed before reply` не должен показывать raw internal/provider/tool text.
6. Найти потребителей `routingOutcome`. Если `contract_unsatisfiable`, агент не должен финализировать как success.

### Критерии Готовности

- Тесты подтверждают, что raw policy denial не попадает в receipt/reply.
- Логи сохраняют debug detail.
- `contract_unsatisfiable` становится blocked/failed outcome, не обычным результатом.

---

## План 4: Orchestrator Observability

### Цель

Сделать decision layer понятным: по каждому turn видеть, почему оркестратор выбрал clarify/tool/recipe/target, и где именно произошёл срыв.

### Что Изучить

- `src/platform/decision/input.ts`
- `src/platform/decision/task-classifier.ts`
- `src/platform/decision/resolution-contract.ts`
- `src/platform/recipe/planner.ts`
- `src/platform/recipe/runtime-adapter.ts`
- `src/auto-reply/reply/agent-runner.ts`
- текущий debug footer в ответах

### Что Сделать

1. Ввести компактный `decisionTrace` объект для debug/log/test:
  - classifier raw contract
  - normalized contract
  - v2/composition fields, если есть
  - clarify reason/budget state
  - requested tools
  - tool bundles
  - selected recipe
  - routing outcome
  - policy/readiness status
2. Не показывать весь trace пользователю по умолчанию. Debug footer должен быть коротким.
3. Eval harness должен сохранять trace для failed cases.
4. Добавить error tags на уровне decision trace, например:
  - `unnecessary_clarify`
  - `wrong_execution_mode`
  - `missing_required_tool`
  - `bundle_recipe_mismatch`
  - `policy_denial_leak_risk`

### Критерии Готовности

- По одному failed eval case можно понять, какой слой ошибся.
- Debug не засоряет обычный пользовательский ответ.
- Trace пригоден для будущего обучения/тонкой настройки модели.

---

## План 5: Clarify Policy Rework

### Цель

Сделать уточнения полезными и редкими. Сейчас система иногда спрашивает, когда действие уже достаточно ясно.

### Что Изучить

- `src/platform/decision/task-classifier.ts`
- `src/platform/decision/input.ts`
- `src/platform/session/intent-ledger.ts`
- тесты вокруг clarify budget

### Что Сделать

1. Разделить типы ambiguity:
  - blocking ambiguity: нельзя безопасно действовать
  - preference ambiguity: можно выбрать разумный default
  - missing optional detail: не спрашивать
2. Clarify должен срабатывать только на blocking ambiguity.
3. Если пользователь уже ответил на предыдущий clarify, нельзя задавать тот же вопрос другой формулировкой.
4. Для persistent worker: отсутствие полного ТЗ не всегда blocker. Если пользователь сказал “создай сабагента Валера”, минимально допустимый default — создать persistent session с вопросом/задачей внутри, а не спрашивать внешний чат три раза.
5. Добавить tests на repeated clarify и “clear enough to act”.

### Критерии Готовности

- Однозначные запросы не уходят в `clarify_first` только из-за низкой confidence.
- Повторные уточнения по одной теме подавляются.
- Clarify становится объяснимым через `decisionTrace`.

## Рекомендуемый Порядок

1. Закончить текущий фикс `persistent_worker/session_orchestration`.
2. Сделать `Decision Eval Harness`.
3. Сделать `Tool Error Sanitization And Hard Stops`.
4. Начать `Композиционный Task Contract`.
5. Добавить `Orchestrator Observability` параллельно с v2-контрактом.
6. Отдельно добить `Clarify Policy Rework`, уже опираясь на eval failures.
