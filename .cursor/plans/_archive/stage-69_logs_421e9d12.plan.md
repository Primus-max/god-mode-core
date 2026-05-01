---
name: stage-69 logs
overview: Расширить canonical routing в `logs`, чтобы level filters стали shareable через URL и работали как browser-native link targets вместе с уже существующим `logQ` фильтром.
todos:
  - id: define-logs-level-routing-contract
    content: Добавить URL contract и shared canonical href helper для `logs` severity filters поверх existing `logQ` deep link.
    status: completed
  - id: wire-logs-level-link-controls
    content: Пробросить logs href builder в `renderLogs(...)`, синхронизировать level toggles через `syncUrlWithTab(...)` и перевести severity chips на real anchors с primary-click handoff.
    status: completed
  - id: lock-logs-routing-regressions
    content: Добавить helper/render regressions и docs note для logs severity filter deep-link parity.
    status: completed
isProject: false
---

# Stage 69 - Logs Level Filter Link Parity

## Goal

Сделать `logs` более пригодным для расследований и шаринга: severity filters должны переживать refresh/popstate, открываться по каноническому URL и давать browser-native navigation для дискретных level chips, а не оставаться только локальным checkbox state.

## Why This Stage

- В `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts)` для таба `logs` сейчас сериализуется только `logQ`, поэтому text filter уже shareable, но level filters полностью выпадают из URL contract.
- В `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts)` `onFilterTextChange` вызывает `syncUrlWithTab(state, "logs", true)`, а `onLevelToggle` меняет только локальный `logsLevelFilters` без URL sync, что создаёт явный gap между visual investigation state и deep link.
- В `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\logs.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\logs.ts)` severity chips пока рендерятся как checkbox labels, хотя это конечный набор дискретных состояний, который естественно ложится на canonical href parity по тому же паттерну, что уже использован для `sessions`, `nodes`, `bootstrap`, `artifacts`.
- `[C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md](C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md)` уже обещает, что Logs является канонической investigation surface и что `logQ` переживает refresh/popstate; следующий логичный шаг — сделать тем же образом shareable и уровень шума/серьёзности.

## Scope

- Добавить URL contract для logs severity filters поверх существующего `logQ`, без расширения scope на `autoFollow`, `refresh`, `export` и scroll/tail state.
- Добавить shared canonical href builder для `logs`, который сохраняет текущий `logQ` и накладывает override на выбранные log levels.
- Перевести severity chips в `logs` на real anchors с primary-click handoff и modified-click browser navigation, сохранив текущее SPA-поведение на обычный клик.
- Сохранить search input как form control с existing `syncUrlWithTab(...)`; не пытаться превращать free-text filter в псевдо-ссылку.

## Planned Changes

- В `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts)` добавить hydration/serialization для нового query param уровня `logLevels` или эквивалентного compact representation, с нормализацией неизвестных значений и soft-fallback к дефолтному набору уровней.
- В том же файле добавить helper уровня `buildCanonicalLogsHref(...)`, который собирает canonical logs URL из текущего `logQ` и выбранных severity flags.
- В `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts)` заставить `onLevelToggle` вызывать `syncUrlWithTab(state, "logs", true)` и пробросить href builder в `renderLogs(...)`.
- В `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\logs.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\logs.ts)` заменить checkbox-only severity chips на anchor-based toggles с canonical `href`, active parity и `isModifiedNavigationClick(...)`, не трогая `autoFollow`, `Refresh` и `Export`.

## Validation

- В `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts)` добавить regressions на hydrate/serialize нового logs level contract, включая fallback при невалидных значениях.
- В `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\logs.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\logs.test.ts)` покрыть render-level canonical `href` для representative severity chips и primary-click vs modified-click semantics.
- Там же добавить regression, что restored URL state повторно показывает тот же filtered log set, а не только текстовый `logQ`.
- Коротко уточнить expectation в `[C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md](C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md)`: если трогаем `logs`, то shareable investigation state должен включать не только `logQ`, но и severity scope.

## Notes

- Это хороший следующий stage после `sessions`, потому что он закрывает явный, локализованный routing gap с высоким operator value и без широкого UX redesign.
- `autoFollow` стоит оставить локальным transient state: он полезен для live-tail поведения, но плохо подходит под shareable investigation URL contract.
- Если по ходу работы выяснится, что anchor-тогглы для chips слишком конфликтуют с текущим checkbox markup, допустимо сохранить визуальный chip вид и сменить только underlying control semantics, но canonical helper и URL round-trip всё равно должны остаться общими.
