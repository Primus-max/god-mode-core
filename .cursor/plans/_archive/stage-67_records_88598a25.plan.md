---
name: stage-67 records
overview: Добавить canonical link parity для строк списка в `bootstrap` и `artifacts`, чтобы выбранная запись открывалась в новой вкладке и после refresh/popstate восстанавливала тот же list/detail context. Этап опирается на уже существующие query contracts `bootstrapQ` / `bootstrapRequest` и `artifactQ` / `artifact`, не расширяя routing model.
todos:
  - id: define-bootstrap-artifact-link-targets
    content: Добавить shared canonical href builders для `bootstrap` и `artifacts` на existing query contracts `bootstrapQ` / `bootstrapRequest` и `artifactQ` / `artifact`.
    status: completed
  - id: wire-bootstrap-artifact-row-links
    content: Пробросить href builders в bootstrap/artifacts views и перевести list rows на real anchors с primary-click handoff и modified-click browser navigation.
    status: completed
  - id: lock-bootstrap-artifact-link-regressions
    content: Добавить focused helper/render regressions и короткую docs note для bootstrap/artifacts list link parity.
    status: completed
isProject: false
---

# Stage 67 - Bootstrap And Artifacts List Link Parity

## Goal

Сделать `bootstrap` и `artifacts` list/detail surfaces browser-native на уровне row navigation: строки списка должны рендерить настоящий `href`, чтобы operator мог открыть конкретную запись в новой вкладке и получить тот же restored context после refresh/popstate.

## Why This Stage

- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts) уже гидратируются и сериализуются `bootstrapQ` / `bootstrapRequest` и `artifactQ` / `artifact`.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts) `onSelect` и `onFilterChange` для обоих табов уже вызывают `syncUrlWithTab(...)`, то есть URL contract живой.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\bootstrap.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\bootstrap.ts) и [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\artifacts.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\artifacts.ts) строки списка до сих пор рендерятся как click-only `button`, что выбивается из уже закрытого parity-паттерна для `cron`, `channels`, `agents`, `sessions`, `nodes`.
- В [C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md](C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md) уже зафиксировано ожидание, что list-level routing для `bootstrap` / `artifacts` должен сохранять query state и selected-record drill-down flow.

## Scope

- Перевести строки списка `bootstrap` на `<a>` с canonical `href`, сохранив existing primary-click handoff через `onSelect`.
- Перевести строки списка `artifacts` на `<a>` с canonical `href`, сохранив existing primary-click handoff через `onSelect`.
- Разрешить browser-native navigation для modified click (`Ctrl/Cmd`, middle click, `Alt`) по тому же паттерну, что уже используется в `sessions` и `nodes`.
- Не трогать `Refresh`, `Approve` / `Deny` / `Run`, lifecycle action buttons, search inputs и прочие mutation controls.

## Planned Changes

- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts) добавить небольшие shared helpers для canonical `bootstrap` и `artifacts` href targets поверх existing tab-scoped serialization, по образцу уже существующих `buildCanonical*` helpers.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts) пробросить href builders в `renderBootstrap(...)` и `renderArtifacts(...)`, чтобы view не собирали query вручную.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\bootstrap.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\bootstrap.ts) заменить `renderBootstrapListItem(...)` на anchor-based row control с `aria-current`/active parity и modified-click passthrough.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\artifacts.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\artifacts.ts) сделать тот же переход для `renderArtifactListItem(...)`.

## Validation

- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts) добавить helper-level regressions на canonical `bootstrap` и `artifacts` hrefs, проверяя сохранение list query вместе с selected record.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\bootstrap.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\bootstrap.test.ts) и [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\artifacts.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\artifacts.test.ts) покрыть `href`-рендеринг row links и поведение primary vs modified click.
- Коротко уточнить expectation в [C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md](C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md), чтобы bootstrap/artifacts list rows не откатывались обратно к button-only navigation.

## Notes

- Это симметричный этап сразу для двух list/detail surfaces с почти одинаковой структурой, поэтому combined stage даёт лучший value, чем дробить их на два мелких этапа.
- `debug`, `logs`, `sessions` list filters и `nodes` target selects остаются потенциальными кандидатами позже, но они либо слабее по operator impact, либо требуют более широкого UX scope, чем row-level parity для `bootstrap` и `artifacts`.
