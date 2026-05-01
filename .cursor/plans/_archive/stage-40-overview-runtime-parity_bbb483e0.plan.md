---
name: stage-40-overview-runtime-parity
overview: "Сделать следующий v1-инкремент вокруг parity между `overview` и `sessions`: overview attention и preload runtime inspector должны опираться на тот же handoff-aware выбор `runId`, что уже закреплён в Stage 39."
todos:
  - id: extract-runtime-run-selector
    content: Вынести общий truth-aware helper выбора runtime run и подключить его в sessions view.
    status: completed
  - id: align-overview-runtime-preload
    content: Сделать loadOverview и recovery attention в app-settings handoff-aware, включая runtimeRun в deep links.
    status: completed
  - id: lock-overview-parity-regressions
    content: Добавить focused tests и коротко обновить testing/control UI docs для overview/runtime parity.
    status: completed
isProject: false
---

# Stage 40 — Overview Runtime Parity

## Почему это следующий шаг

После Stage 39 `sessions` уже truth-aware: inspect path выбирает `runId` по `handoffTruthSource`, `handoffRunId`, `handoffRequestRunId` и `runClosureSummary`. Но `overview` всё ещё грузит runtime inspector с `runId: null` и строит recovery attention по более слабому session-only scope. Это создаёт риск, что оператор увидит в `overview` и в `sessions` разные runtime targets для одной и той же сессии.

Ключевые текущие места:

- [ui/src/ui/app-settings.ts](ui/src/ui/app-settings.ts): `loadOverview()` вызывает `loadRuntimeInspector(app, { sessionKey: app.sessionKey || null, runId: null })`.
- [ui/src/ui/app-settings.ts](ui/src/ui/app-settings.ts): `buildAttentionItems()` выбирает checkpoint по `sessionKey` и строит `Review` deep link без `runtimeRun`.
- [ui/src/ui/views/sessions.ts](ui/src/ui/views/sessions.ts): уже содержит truth-aware правило `resolveSessionRuntimeInspectRunId(row)`.

## Цель stage

Сделать так, чтобы `overview`, `sessions`, deep links и recovery attention опирались на одно каноническое правило выбора runtime target, без второй локальной логики и без ручного угадывания нужного run оператором.

## Scope

- Вынести truth-aware выбор inspect `runId` из [ui/src/ui/views/sessions.ts](ui/src/ui/views/sessions.ts) в общий UI helper/model-level модуль, который смогут использовать и `sessions`, и `overview`.
- Обновить [ui/src/ui/app-settings.ts](ui/src/ui/app-settings.ts), чтобы `loadOverview()` передавал в `loadRuntimeInspector()` truth-aware `runId` для текущей `sessionKey`, если соответствующая session row уже известна.
- Уточнить `buildAttentionItems()` в [ui/src/ui/app-settings.ts](ui/src/ui/app-settings.ts), чтобы recovery attention:
  - выбирал checkpoint в рамках того же truth-aware runtime scope;
  - добавлял `runtimeRun` в deep link, когда он известен;
  - не расходился с тем runtime target, который откроется из `sessions`.
- Переподключить [ui/src/ui/views/sessions.ts](ui/src/ui/views/sessions.ts) на общий helper, чтобы не держать вторую копию правила.
- Зафиксировать focused regressions и коротко обновить операторскую/testing документацию.

## Основные файлы

- [ui/src/ui/app-settings.ts](ui/src/ui/app-settings.ts)
- [ui/src/ui/views/sessions.ts](ui/src/ui/views/sessions.ts)
- [ui/src/ui/app-settings.test.ts](ui/src/ui/app-settings.test.ts)
- [ui/src/ui/views/sessions.test.ts](ui/src/ui/views/sessions.test.ts) при необходимости только на импорт/общий helper parity
- [docs/help/testing.md](docs/help/testing.md)
- Опционально: [docs/web/control-ui.md](docs/web/control-ui.md)

## Реализационные шаги

1. Вынести каноническое правило выбора runtime run

Создать маленький общий helper рядом с UI runtime/session logic и перенести туда логику приоритета:

- `recovery` -> `handoffRunId ?? handoffRequestRunId ?? closureRunId`
- `closure` -> `handoffRunId ?? closureRunId ?? handoffRequestRunId`
- fallback -> `handoffRunId ?? handoffRequestRunId ?? closureRunId`

1. Сшить overview preload с тем же правилом

В [ui/src/ui/app-settings.ts](ui/src/ui/app-settings.ts) перед вызовом `loadRuntimeInspector()` находить активную session row по `app.sessionKey`, вычислять truth-aware `runId`, и передавать его в preload. Если сессия ещё не загружена, сохранять безопасный fallback на `null`.

1. Выравнять recovery attention и deep link

В [ui/src/ui/app-settings.ts](ui/src/ui/app-settings.ts) пересмотреть `scopedCheckpoint`/`recoveryDescription` так, чтобы attention item смотрел на checkpoint текущего truth-aware run, а `buildTabHref(... "sessions" ...)` включал `runtimeRun`, если он есть. Это даст shareable/deep-link parity между overview и sessions.

1. Закрыть регрессии и docs

Добавить focused tests в [ui/src/ui/app-settings.test.ts](ui/src/ui/app-settings.test.ts):

- `loadOverview()` использует handoff-aware `runId`.
- recovery attention строит ссылку с тем же `runtimeRun` и checkpoint, что ожидает sessions/runtime inspector.
- fallback остаётся безопасным, когда session row или run недоступны.

Обновить [docs/help/testing.md](docs/help/testing.md) короткой заметкой, что при изменениях overview/runtime routing нужно держать parity между overview attention и session inspect path.

## Вне scope

- Расширение cron run history до точного `runId` correlation.
- Новые attention surfaces для `skills`, `channels`, `exec approvals`.
- Новый backend-агрегатор или incident dashboard.

## Ожидаемый результат

Оператор выбирает сессию один раз и получает одну и ту же историю/ветку recovery как из `overview`, так и из `sessions`. Deep links становятся более точными, а handoff truth перестаёт быть локальным правилом только внутри таблицы sessions.
