---
name: stage-48 cron list parity
overview: "Следующий шаг к v1 — довести саму вкладку `cron` до того же canonical deep-link contract, который уже есть у конкретного `cronJob`, `sessions` list и `usage`. Берём минимально ценный operator context списка: query, enabled/status/schedule filters, сортировку и связанный run-history context, без полной сериализации editor/form state."
todos:
  - id: add-cron-list-deeplink-contract
    content: Добавить минимальный query/deep-link contract для списка cron и гидрацию/сериализацию list-level URL state.
    status: completed
  - id: wire-cron-list-url-sync
    content: Сшить jobs query/filters/sort на вкладке cron с canonical URL sync без поломки существующего `cronJob` drill-down flow.
    status: completed
  - id: lock-cron-list-parity-regressions
    content: Добавить focused tests и docs/testing guidance для cron list deep-link parity и refresh/popstate regressions.
    status: completed
isProject: false
---

# Stage 48 - Cron List Deep-Link Parity

## Goal

Сделать вкладку `cron` shareable и refresh-safe не только на уровне `cronJob=<id>`, но и на уровне самого списка/обозревателя джобов. После перехода из overview, refresh или пересылки ссылки оператор должен возвращаться в тот же filtered cron view, а не только к выбранной записи.

## Why This Step

- В [ui/src/ui/app-settings.ts](ui/src/ui/app-settings.ts) для `cron` уже сохраняется только `cronJob`, но не сериализуются list-level filters и related job-grid state.
- В [ui/src/ui/app-render.ts](ui/src/ui/app-render.ts) `cronJobsQuery`, `cronJobsEnabledFilter`, `cronJobsLastStatusFilter` и смежные list controls живут в памяти, тогда как overview attention уже умеет приводить оператора в `cron`.
- В [docs/web/control-ui.md](docs/web/control-ui.md) `Cron jobs` уже задокументирован как canonical operator surface с actionable routing; следующий логичный шаг — убрать расхождение между shareable job target и несохраняемым состоянием самой сетки.

## Scope

- Добавить минимальный query contract для списка `cron`: `cronQ`, `cronEnabled`, `cronSchedule`, `cronStatus`, `cronSort`, `cronDir`.
- Сохранить уже существующий `cronJob=<id>` как object-level deep link и совместить его с list-level state.
- Не сериализовать editor/form state, draft job edits и тяжёлые run-history детали.

## Implementation

- Расширить hydrate/persist логику в [ui/src/ui/app-settings.ts](ui/src/ui/app-settings.ts):
  - `applyDeepLinkStateFromUrl` должен читать `cronQ`, `cronEnabled`, `cronSchedule`, `cronStatus`, `cronSort`, `cronDir` вместе с уже существующим `cronJob`.
  - `applyTabQueryStateToUrl` должен очищать эти ключи вне `cron` и записывать их для `cron`.
  - Нормализовать invalid filter/sort values так, чтобы broken query не ломал текущий cron view.
- Протянуть URL sync в [ui/src/ui/app-render.ts](ui/src/ui/app-render.ts) для job-grid controls:
  - после смены jobs query
  - после смены enabled filter
  - после смены schedule-kind filter
  - после смены last-status filter
  - после смены sort direction / sort field, если они уже вынесены в state и UI callbacks
- Сохранить текущий object-level flow без изменений:
  - `cronJob` deep link должен продолжать работать как primary drill-down
  - list-level state должен жить в том же URL round-trip, не ломая переходы overview → cron → run history → sessions/chat
- Где возможно, мягко выровнять list reload path в [ui/src/ui/controllers/cron.ts](ui/src/ui/controllers/cron.ts), чтобы invalid/устаревший `cronJob` или list filter не оставляли broken state после refresh/popstate.

## Verification

- Добавить focused regressions в [ui/src/ui/app-settings.test.ts](ui/src/ui/app-settings.test.ts):
  - hydrate `cronQ` / `cronEnabled` / `cronSchedule` / `cronStatus` / `cronSort` / `cronDir` вместе с `cronJob`
  - persist этих ключей через `syncUrlWithTab(..., true)`
  - fallback для invalid filter/sort values
- Добавить focused cron regression рядом с существующими cron tests, используя [ui/src/ui/controllers/cron.test.ts](ui/src/ui/controllers/cron.test.ts) и/или [ui/src/ui/views/cron.test.ts](ui/src/ui/views/cron.test.ts):
  - подтверждение, что user-driven list filter changes теперь отражаются в canonical `cron` URL state
  - подтверждение, что existing `cronJob` drill-down не ломается при наличии list-level query state
- Обновить [docs/help/testing.md](docs/help/testing.md) и [docs/web/control-ui.md](docs/web/control-ui.md) с cron list parity note.

## Expected Outcome

После stage вкладка `cron` перестанет быть «частично parity-ready»: и сам список джобов, и object-level `cronJob` routing будут жить в одном shareable URL contract. Это ещё на один шаг приблизит проект к `v1`: после такого шага останутся в основном более мелкие parity/polish gaps вроде `debug`, `instances` и точечных overview entrypoints, а не разрыв на одной из главных операторских поверхностей.
