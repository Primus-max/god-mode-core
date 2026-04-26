# Orchestrator v1.1 — P2 (guards / warmup / UI labels)

**Мастер-план:** `orchestrator_v1_1_master.plan.md`.
**Статус:** PENDING (2026-04-20).
**Зависимости:** нет. Можно идти параллельно P1.

---

## Контекст

Три мелких, но раздражающих бага качества. Ни один не блокирует оркестратор, но
каждый либо врёт метрикам, либо сбивает с толку оператора.

---

## Задачи

### P2.1 — `resolveRepoRoot` off-by-one [ ]

**Симптом.** Известен из Track D `routing_v1_followup_handoff.plan.md`. Guard
`scripts/lib/ts-guard-utils.mjs::resolveRepoRoot` ищет `package.json` вверх по
файловой системе, но при запуске из подпапки `.openclaw/` может уйти «выше корня» и
вернуть путь за пределами репозитория. Эффект — `lint:routing:no-prompt-parsing` и
другие guards молча становятся зелёными (обходят нужные файлы).

**Где трогаем.**
- `scripts/lib/ts-guard-utils.mjs::resolveRepoRoot`.
- Добавить sanity-assert: `path.includes('.openclaw')` ⇒ throw «resolved outside repo».
- Вернуть упавший guard через CI job: прогнать `pnpm lint:routing:no-prompt-parsing` из
  tmp-dir и из `.openclaw/workspace-dev/trader` — должен дать одинаковый результат.

**Acceptance.**
- Юнит-тест `ts-guard-utils.test.mjs`: `resolveRepoRoot('.openclaw/workspace-dev/trader')`
  возвращает корень репы `god-mode-core`, не выше.
- Ручная проверка: `cd .openclaw/workspace-dev/trader && node <path>/scripts/lint-routing.mjs`
  — то же поведение, что из корня.

---

### P2.2 — warmup resolver misalignment [ ]

**Симптом.** В `.gateway-dev.err.log`:

```text
startup model warmup failed for hydra/gpt-5.4: Error: Unknown model: hydra/gpt-5.4
```

При этом рабочий resolver знает `hydra/gpt-5.4` и обслуживает запросы без проблем.
Значит warmup-путь использует **другой** registry / resolver (вероятно, legacy
`modelRegistry` вместо нового `resolveModelByAlias`).

**Где трогаем.**
- Найти вызов `warmupModel(...)` или `startupWarmup(...)` — грепнуть
  `"warmup"` + `"hydra"` в `src/`.
- Выровнять: warmup должен вызывать тот же `resolveModel()`, что рантайм.
- Если legacy registry умышленно минимальный — добавить fallback «если alias неизвестен,
  пропустить warmup с warn, не error».

**Acceptance.**
- Рестарт `pnpm gateway:dev` → в `.gateway-dev.err.log` НЕТ строки `startup model
  warmup failed`. Вместо неё — `[warmup] ok hydra/gpt-5.4`.
- Юнит-тест `model-warmup.test.ts`: unknown alias ⇒ warn (не error), known alias ⇒ ok.

**Неочевидные нюансы.**
- Warmup может стоять во времени ДО полной загрузки конфига. Убедиться, что resolver
  доступен в момент warmup (lazy init уже произошёл).

---

### P2.3 — UI label drift [ ]

**Симптом.** В UI (чат/tail сессии) пользователь видит:

```text
recipe: general_reasoning
family: General
```

…даже когда реальный plan — `contract_first` с конкретным recipe. Это вводит в
заблуждение: кажется, что оркестратор «ничего не понял», хотя он работает правильно.

**Причина (гипотеза).** UI читает `plan.recipe` / `plan.family` **до** резолвции
contract-first: либо берёт fallback ключ из raw planner output, либо не обновляет
state после `resolveRoutingSnapshotForTemplateRun`.

**Где трогаем.**
- Найти источник меток в UI — грепнуть `"general_reasoning"` в UI папках (ищи в
  `src/ui/`, `src/renderer/` если есть; посмотри `src/agents/agent-command.ts` —
  он модифицирован и мог быть источником).
- Использовать `routingOutcome` + `plan.selectedRecipeId` из финального
  `platformExecutionContext`.

**Acceptance.**
- Прогон Trader-подобного сценария — в UI отображается актуальный
  `recipe` и `family` (напр. `contract_first / ArtifactAuthoring`).
- Юнит-тест снапшота UI-формата.

**Неочевидные нюансы.**
- Если метки показывают _initial_ plan до fallback — это дизайн-вопрос. Решить с
  владельцем UI: показывать финальный plan или весь путь (стрелочка
  `initial → final`). В рамках P2 — показываем финальный.

---

## Порядок выполнения

Каждая задача независима, можно параллелить.

Рекомендация: P2.1 первой (samый простой), P2.2 второй (важнее для метрик), P2.3
последней (косметика, но высокий signal для пользователя).

---

## Verify checklist

- [ ] `pnpm tsgo --noEmit` — 0.
- [ ] `pnpm vitest run scripts src/platform/model src/ui` (или где находятся
      новые тесты).
- [ ] `pnpm lint:routing:no-prompt-parsing` — зелёный из любого каталога.
- [ ] `.gateway-dev.err.log` пустой после рестарта (кроме ожидаемых).
- [ ] UI показывает правильные labels на Trader-кейсе.
- [ ] Обновить master §0 P2 → `DONE`.

---

## Что НЕ входит в P2

- Большой рефакторинг UI — только фикс label drift.
- Замена legacy `modelRegistry` на новый — только выравнивание warmup путей.
- Переделка guard runner infra — только baseline-assert на `resolveRepoRoot`.

---

## History

- 2026-04-20 — саб-план создан, задачи декомпозированы. Исполнитель не назначен.
