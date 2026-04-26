---
name: stage 52 instances parity
overview: Сделать вкладку `instances` shareable и refresh-safe на уровне минимального operator query contract, чтобы режим показа host/IP (`masked` vs `revealed`) восстанавливался после refresh/popstate и через пересланную ссылку без сериализации transient presence payload.
todos:
  - id: define-instances-query-contract
    content: Добавить `instancesReveal` hydrate-persist contract в `ui/src/ui/app-settings.ts` и central state без сериализации transient presence payload.
    status: completed
  - id: wire-instances-visibility-sync
    content: Перевести `ui/src/ui/views/instances.ts` на props-driven reveal-state и подключить toggle к canonical URL sync через `ui/src/ui/app-render.ts`.
    status: completed
  - id: lock-instances-parity-regressions
    content: Добавить focused tests и docs coverage для instances visibility parity, tab-clearing behavior и refresh-safe restoration privacy mode.
    status: completed
isProject: false
---

# Stage 52 - Instances Visibility Parity

## Goal

Сделать вкладку `instances` частью canonical operator routing: после refresh, popstate или пересылки ссылки оператор должен возвращаться не только на сам presence surface, но и в тот же режим приватности списка, то есть с тем же состоянием показа host/IP адресов.

## Why This Step

- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\instances.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\instances.ts) `hostsRevealed` сейчас живёт как module-level `let`, а значит не является ни durable state, ни частью URL contract.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts) вкладка `instances` рендерится как canonical surface, но получает только `onRefresh`, без `syncUrlWithTab(...)` на user action.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts) уже есть query contracts для `sessions`, `cron`, `usage`, `debug`, `logs`, `nodes`, `bootstrap`, `artifacts`, но нет отдельной ветки для `instances`.
- После уже закрытых `debug`- и list-parity stages это следующий маленький, изолированный, но явный gap на пути к `v1`, перед более разрозненными `overview/settings` entrypoints.

## Scope

- Добавить минимальный query contract для вкладки `instances`:
  - `instancesReveal` как boolean-флаг для режима показа host/IP
- Гидратировать этот ключ из URL и сериализовать обратно только на вкладке `instances`.
- Перенести `hostsRevealed` из module-local state в app/view state, чтобы одно и то же состояние использовалось и UI, и deep-link plumbing.
- Не сериализовать presence payload, counters, load/error status или любые transient данные списка.

## Implementation

- Расширить hydrate/persist логику в [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts):
  - `applyDeepLinkStateFromUrl` должен читать `instancesReveal` через существующую boolean-normalization логику.
  - `applyTabQueryStateToUrl` должен очищать `instancesReveal` вне `instances` и записывать его только для этой вкладки рядом с `session`.
  - Пустые/битые значения должны мягко падать обратно в safe default (`false` / masked mode).
- Поднять reveal-state в central state model:
  - добавить флаг в [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app.ts) и [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-view-state.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-view-state.ts)
  - убрать module-level `hostsRevealed` из [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\instances.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\instances.ts)
- Протянуть user action в canonical URL sync через [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts):
  - заменить implicit local toggle на props-driven `revealed` / `onToggleReveal`
  - после toggle вызывать `syncUrlWithTab(state, "instances", true)`
  - не менять semantics `onRefresh` и `loadPresence(...)`
- Сохранить текущий load flow:
  - `refreshActiveTab()` по-прежнему только перезагружает presence
  - refresh/popstate восстанавливает privacy mode, но не добавляет новых selection/detail semantics, которых у surface сейчас нет

## Verification

- Обновить [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts):
  - hydrate `instancesReveal` из URL
  - persist этого ключа через `syncUrlWithTab(..., true)`
  - очистка query param при переходе на другие tabs
  - fallback для невалидных boolean-значений
- Добавить focused view regression рядом с [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\instances.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\instances.ts):
  - restored reveal-state виден через `aria-pressed`/masked rendering
  - toggle вызывает callback без возврата к module-local state
- Обновить [C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md](C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md) и [C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md](C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md) заметкой про instances visibility parity.

## Expected Outcome

После stage вкладка `instances` станет refresh-safe и shareable хотя бы на уровне реального operator intent, который там уже есть сегодня: ссылка восстановит тот же privacy/reveal mode списка, а сам surface перестанет зависеть от module-local UI state. Это сократит `v1`-остаток до точечных `overview/settings` routing gaps.
