---
name: stage-49 cron runs parity
overview: "Следующий шаг к v1 — довести вкладку `cron` до полного operator round-trip: после Stage 48 список джобов уже shareable, но run-history explorer всё ещё живёт только в памяти. План закрывает этот последний крупный gap внутри canonical Cron surface."
todos:
  - id: add-cron-runs-deeplink-contract
    content: Добавить canonical query/deep-link contract для run-history части вкладки `cron` с гидрацией/сериализацией runs state.
    status: completed
  - id: wire-cron-runs-url-sync
    content: Сшить run-history scope/query/status/delivery/sort с canonical URL sync без поломки existing `cronJob` drill-down и jobs list context.
    status: completed
  - id: lock-cron-runs-parity-regressions
    content: Добавить focused tests и docs/testing guidance для cron runs deep-link parity и refresh/popstate fallback.
    status: completed
isProject: false
---

# Stage 49 - Cron Runs Deep-Link Parity

## Goal

Сделать run-history часть вкладки `cron` shareable и refresh-safe: после перехода из overview, выбора job history, refresh или пересылки ссылки оператор должен возвращаться не только к тому же `cronJob`, но и к тому же runs explorer context.

## Why This Step

- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts) после Stage 48 сериализуются `cronQ`, `cronEnabled`, `cronSchedule`, `cronStatus`, `cronSort`, `cronDir`, `cronJob`, но не сериализуются `cronRunsScope`, `cronRunsQuery`, `cronRunsSortDir`, `cronRunsStatuses`, `cronRunsDeliveryStatuses`.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts) `onRunsFiltersChange` уже вызывает `syncUrlWithTab(state, "cron", true)`, но в URL сейчас просто нечего сохранять кроме `cronJob`.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\cron.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\cron.ts) runs explorer уже имеет полноценный investigation state: scope, query, sort, multi-select filters по status/delivery. Это естественное продолжение Stage 48, а не новый широкий surface.

## Scope

- Добавить минимальный canonical query contract для run explorer: `cronRunsScope`, `cronRunsQ`, `cronRunsSort`, `cronRunsStatus`, `cronRunsDelivery`.
- Сохранить существующий `cronJob=<id>` как primary object-level target для job-specific history.
- Не сериализовать тяжёлые детали run payload/log body, editor/form state и ephemeral UI детали.

## Implementation

- Расширить hydrate/persist логику в [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts):
  - `applyDeepLinkStateFromUrl` должен читать run-history query state вместе с уже существующими `cron*` ключами.
  - `applyTabQueryStateToUrl` должен очищать эти ключи вне `cron` и записывать их для `cron` рядом с list-level state и `cronJob`.
  - Нормализовать invalid values так, чтобы битый URL не оставлял broken runs view.
  - Продумать мягкий fallback для `cronRunsScope=job` без валидного `cronJob`: либо опускаться в `all`, либо очищать только scope/job часть, не ломая остальной cron context.
- Сохранить текущий data-load flow в [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts) и [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\controllers\cron.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\controllers\cron.ts):
  - `onLoadRuns` по job должен продолжать открывать ту же job history ветку, но теперь ещё и сохранять runs query context.
  - `onRunsFiltersChange` должен остаться single source of truth для reload + URL sync, только уже с реальным query contract.
  - Если refreshed state больше не совместим с `job` scope, выравнивать только broken run-history часть, не роняя jobs list filters.
- Не менять semantics overview/chat/sessions переходов: цепочка `overview -> cron -> run history -> chat/sessions` должна остаться совместимой с уже существующим `cronJob` routing.

## Verification

- Добавить focused regressions в [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts):
  - hydrate `cronRunsScope` / `cronRunsQ` / `cronRunsSort` / `cronRunsStatus` / `cronRunsDelivery` вместе с jobs-level `cron*` и `cronJob`
  - persist этих ключей через `syncUrlWithTab(..., true)`
  - fallback для invalid run filter/sort/scope values
- Добавить focused regression рядом с существующими cron tests в [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\controllers\cron.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\controllers\cron.test.ts) и/или уже включённых в suite cron UI tests:
  - подтверждение, что run filter changes теперь отражаются в canonical `cron` URL state
  - подтверждение, что `cronJob` drill-down не ломается при наличии runs query state
  - подтверждение, что broken `job` scope мягко откатывается без потери jobs list context
- Обновить [C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md](C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md) и [C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md](C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md) с note про cron runs parity.

## Expected Outcome

После stage вкладка `cron` станет почти полностью parity-ready как canonical operator surface: ссылка сможет восстановить и jobs list context, и конкретную job history ветку, и сам runs investigation state. Это ещё на шаг приблизит проект к `v1`, после чего останутся уже более мелкие или более широкие gaps вроде `bootstrap/artifacts` list query parity, `debug`, `instances` и точечных settings/overview entrypoints.
