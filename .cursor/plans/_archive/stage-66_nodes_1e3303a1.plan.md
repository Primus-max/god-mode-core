---
name: stage-66 nodes
overview: "Ввести canonical link parity для `nodes` exec approvals: перевести scope-переключатели на реальные ссылки с `href`, сохранив текущий JS handoff для primary click и browser-native поведение для modified click. Это опирается на уже существующий URL contract `execTarget` / `execNode` / `execAgent` и закрывает заметный разрыв в operator workflow."
todos:
  - id: define-nodes-exec-link-targets
    content: Добавить shared canonical href builder для `nodes` exec approvals на существующем query contract `execTarget` / `execNode` / `execAgent`.
    status: completed
  - id: wire-nodes-exec-scope-links
    content: Пробросить href builders в `nodes` view и перевести exec approvals scope controls на real anchors с primary-click handoff и modified-click browser navigation.
    status: completed
  - id: lock-nodes-exec-link-regressions
    content: Добавить focused helper/render regressions и короткую docs note для exec approvals link parity.
    status: completed
isProject: false
---

# Stage 66 - Nodes Exec Approvals Link Parity

## Goal

Сделать `nodes` exec approvals refresh-safe и shareable на уровне scope/navigation controls, не вводя новые query-параметры. Основной фокус — существующие click-only scope buttons в exec approvals, которые уже синхронизируются через URL, но не имеют реального `href` для новой вкладки, middle-click и browser history parity.

## Why This Stage

- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts) уже есть гидратация и сериализация `execTarget`, `execNode`, `execAgent`.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts) текущие обработчики `onExecApprovalsTargetChange` и `onExecApprovalsSelectAgent` уже вызывают `syncUrlWithTab(state, "nodes", true)`.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts) уже проверено, что deep links для `nodes` сохраняют `execTarget=node&execNode=node-1&execAgent=main`, а attention item уже строит canonical `href` в `nodes`.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\nodes-exec-approvals.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\nodes-exec-approvals.ts) scope controls до сих пор рендерятся как `button`, что выбивается из уже реализованного parity-паттерна в `sessions`, `agents`, `settings`, `channels`, `cron`.

## Scope

- Перевести `Defaults` и agent scope pills в exec approvals на `<a>` с canonical `href`.
- Сохранить текущее поведение для обычного left-click: `preventDefault()` и вызов существующих callbacks.
- Разрешить browser-native navigation для modified click (`Ctrl/Cmd`, middle click, `Alt`) по тому же паттерну, что уже используется в `sessions`.
- Не расширять scope на policy form controls, save/load actions и не переделывать `select` для target/node в отдельный навигационный UX на этом этапе.

## Planned Changes

- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts) добавить узкий shared helper наподобие `buildCanonicalSessionsRuntimeHref`, который собирает canonical `nodes` href поверх текущего state с override для `execTarget`, `execNode`, `execAgent`.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts) пробросить в `renderNodes(...)` href-builder(ы) для exec approvals scope navigation, чтобы view не собирал URL вручную и сохранял текущий `basePath`/tab context.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\nodes-exec-approvals.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\nodes-exec-approvals.ts) заменить scope buttons внутри `renderExecApprovalsTabs` на anchors, добавить `aria-current`/active parity и reuse helper для modified-navigation click semantics.
- При необходимости слегка расширить `NodesProps` в [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\nodes.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\nodes.ts), чтобы безопасно протащить новые href-builders в exec approvals panel.

## Validation

- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts) добавить focused regression на новый canonical helper для `nodes`, включая кейсы `gateway` и `node` target с agent/default scope.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\nodes.devices.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\nodes.devices.test.ts) покрыть `href`-рендеринг scope links и поведение primary vs modified click, по образцу runtime link parity tests в `sessions`.
- Коротко зафиксировать parity expectation в [C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md](C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md), чтобы дальнейшие UI changes не вернули click-only scope navigation.

## Notes

- `select` для target/node оставляем как есть: там URL contract уже работает, но замена на anchor-based UX заметно расширит scope и лучше смотрится отдельным этапом, если понадобится позже.
- Этап остаётся узким и продолжает текущую серию canonical routing work без новых query keys и без изменения server/controller semantics.
