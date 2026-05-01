---
name: stage 50 bootstrap artifacts parity
overview: Add shareable, refresh-safe list-level deep-link parity for the `bootstrap` and `artifacts` tabs so operators return to the same filtered list context as well as the same selected record.
todos:
  - id: define-bootstrap-artifact-query-contract
    content: Define and wire `bootstrapQ` and `artifactQ` hydrate/persist behavior in `ui/src/ui/app-settings.ts` without disturbing existing object deep links.
    status: completed
  - id: sync-bootstrap-artifact-filter-events
    content: Hook bootstrap/artifacts filter changes into canonical URL sync in `ui/src/ui/app-render.ts` while preserving current load/action semantics.
    status: completed
  - id: lock-bootstrap-artifact-parity-regressions
    content: Add focused tests and docs coverage for bootstrap/artifacts list query parity, tab-clearing behavior, and object-level drill-down compatibility.
    status: completed
isProject: false
---

# Stage 50 - Bootstrap/Artifacts List Query Parity

## Goal

Сделать вкладки `bootstrap` и `artifacts` shareable и refresh-safe не только на уровне `bootstrapRequest=<id>` / `artifact=<id>`, но и на уровне list filter context. После refresh, popstate или пересылки ссылки оператор должен возвращаться к тому же filtered list и к той же выбранной записи.

## Why This Step

- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts) сейчас сериализуются только object-level ключи `bootstrapRequest` и `artifact`; list filter state не гидратируется и не пишется обратно в URL.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts) оба surface уже держат `bootstrapFilterQuery` / `artifactsFilterQuery` в state и прокидывают их в `renderBootstrap()` / `renderArtifacts()`, но `onFilterChange` пока меняет только память без `syncUrlWithTab(...)`.
- В Stage 49 явно перечислено, что после `cron` остаются gaps вроде `bootstrap/artifacts list query parity`, а значит это следующий естественный stage к `v1`.

## Scope

- Добавить минимальный canonical query contract:
  - `bootstrapQ` для списка `bootstrap`
  - `artifactQ` для списка `artifacts`
- Сохранить текущие object-level deep links `bootstrapRequest` и `artifact` как primary record targets.
- Не сериализовать detail payload, action busy/loading flags, runtime side panels и прочие ephemeral UI детали.

## Implementation

- Расширить hydrate/persist логику в [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts):
  - `applyDeepLinkStateFromUrl` должен читать `bootstrapQ` и `artifactQ` рядом с `bootstrapRequest` / `artifact`.
  - `applyTabQueryStateToUrl` должен очищать эти ключи вне соответствующих вкладок и записывать их для `bootstrap` и `artifacts` вместе с object-level selection.
  - Broken/empty query values должны мягко нормализоваться к `""`, без влияния на выбранную запись.
- Протянуть URL sync в [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts):
  - после `onFilterChange` для `bootstrap`
  - после `onFilterChange` для `artifacts`
  - не трогать semantics `onSelect`, `onResolve`, `onRun`, `onTransition`, кроме сохранения совместимости с новым query contract.
- Убедиться, что current refresh/load flow остаётся прежним:
  - `refreshActiveTab()` и related loaders должны продолжать открывать выбранную запись, если она есть
  - list query parity не должна ломать overview attention links, которые уже ведут в `bootstrap` / `artifacts` по id

## Verification

- Обновить [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts):
  - hydrate `bootstrapQ` / `artifactQ` вместе с `bootstrapRequest` / `artifact`
  - persist этих ключей через `syncUrlWithTab(..., true)`
  - убедиться, что переход на другие tabs очищает их query params
- Добавить focused regressions рядом с существующими bootstrap/artifact checks:
  - [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\controllers\bootstrap.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\controllers\bootstrap.test.ts) и/или [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\bootstrap.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\bootstrap.test.ts)
  - [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\controllers\artifacts.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\controllers\artifacts.test.ts) и/или [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\artifacts.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\artifacts.test.ts)
  - проверить, что user-driven filter changes отражаются в canonical URL state и не ломают object drill-down
- Обновить [C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md](C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md) и [C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md](C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md) заметкой про bootstrap/artifacts list parity.

## Expected Outcome

После stage вкладки `bootstrap` и `artifacts` будут вести себя так же предсказуемо, как уже выровненные `sessions`, `usage` и `cron`: ссылка восстановит и list-level investigation context, и выбранную запись. Это закроет следующий явный parity gap из post-Stage-49 списка и сузит остаток `v1`-работы до `debug`, `instances` и точечных overview/settings entrypoints.
