---
name: stage-42-channels-correlation
overview: "Сделать `channels` частью operator correlation flow: добавить минимальный URL/query contract для выбранного канала, превратить channel-related сигналы в actionable drill-down и выровнять overview entry points с canonical channels surface."
todos:
  - id: add-channels-deeplink-contract
    content: Добавить минимальный `channel=<key>` query/deep-link contract и гидрацию состояния из URL.
    status: completed
  - id: wire-channels-operator-drilldown
    content: Сшить channels UI и overview entry points с canonical channel drill-down flow.
    status: completed
  - id: lock-channels-correlation-regressions
    content: Добавить focused tests и обновить docs/testing guidance для channels correlation flow.
    status: completed
isProject: false
---

# Stage 42 — Channels Correlation Surfaces

## Почему это следующий шаг

После Stages 36–41 уже выстроен единый operator navigation contract для `sessions`, `bootstrap`, `artifacts`, `cron`, handoff/runtime parity и `skills`. Следующий самый заметный разрыв — `channels`: вкладка уже показывает стабильные channel cards и health snapshot, но не участвует в том же deep-link/attention contract.

Якорные места:

- [ui/src/ui/app-settings.ts](ui/src/ui/app-settings.ts): `applyDeepLinkStateFromUrl()` и `applyTabQueryStateToUrl()` знают `bootstrapRequest`, `artifact`, `runtimeSession`, `runtimeRun`, `checkpoint`, `cronJob`, `skillFilter`, но не выбранный канал.
- [ui/src/ui/views/channels.ts](ui/src/ui/views/channels.ts): каналы уже рендерятся по стабильному `channelKey`, но выбранный operator context не переживает refresh/popstate.
- [ui/src/ui/controllers/channels.ts](ui/src/ui/controllers/channels.ts): overview уже грузит `channels.status`, то есть базовый snapshot для thin correlation уже есть.
- [docs/web/control-ui.md](docs/web/control-ui.md): `channels` уже заявлены как операторская surface, но без drill-down parity с остальными вкладками.

## Цель

Сделать `channels` частью того же operator correlation flow:

- overview и attention могут открыть canonical channels surface с предвыбранным проблемным каналом;
- выбранный канал переживает refresh/popstate через query state;
- overview entry points и channels UI используют один и тот же navigation contract;
- всё это остаётся thin UI orchestration поверх текущего `channels.status` и существующих channel cards, без нового backend-агрегатора.

## Scope

- Расширить query/deep-link contract в [ui/src/ui/app-settings.ts](ui/src/ui/app-settings.ts) минимальным `channel=<key>` состоянием.
- Гидрировать и сохранять выбранный канал в channels flow через [ui/src/ui/app-render.ts](ui/src/ui/app-render.ts) и [ui/src/ui/views/channels.ts](ui/src/ui/views/channels.ts).
- Добавить минимальные actionable attention / overview entry points для channel issues, если они уже выводимы из текущего `channels.status` snapshot без новых RPC.
- При необходимости ввести маленький helper для channel health/correlation, если без него начнётся дублирование эвристики.
- Зафиксировать focused regressions и коротко обновить docs/testing guidance.

## Основные файлы

- [ui/src/ui/app-settings.ts](ui/src/ui/app-settings.ts)
- [ui/src/ui/app-render.ts](ui/src/ui/app-render.ts)
- [ui/src/ui/views/channels.ts](ui/src/ui/views/channels.ts)
- [ui/src/ui/views/channels.types.ts](ui/src/ui/views/channels.types.ts)
- [ui/src/ui/controllers/channels.ts](ui/src/ui/controllers/channels.ts) при необходимости только для thin helper reuse
- [ui/src/ui/app-settings.test.ts](ui/src/ui/app-settings.test.ts)
- [ui/src/ui/views/channels.test.ts](ui/src/ui/views/channels.test.ts) при необходимости для render-level selection behavior
- [docs/help/testing.md](docs/help/testing.md)
- [docs/web/control-ui.md](docs/web/control-ui.md)

## Реализационные шаги

1. Добавить `channels` в deep-link contract

В [ui/src/ui/app-settings.ts](ui/src/ui/app-settings.ts) ввести минимальный query-state: `channel=<key>`. Этого достаточно для operator drill-down без сериализации всего channel UI.

1. Сшить channels surface с URL

В [ui/src/ui/app-render.ts](ui/src/ui/app-render.ts) и [ui/src/ui/views/channels.ts](ui/src/ui/views/channels.ts) сделать hydration/sync для выбранного канала по аналогии с `cronJob` и `skillFilter`, чтобы выбранная карточка восстанавливалась после refresh/popstate.

1. Превратить channel issues в действие

Если из уже загруженного `channels.status` snapshot можно стабильно вывести degraded/not-configured/disconnected состояние без новых backend данных, добавить в [ui/src/ui/app-settings.ts](ui/src/ui/app-settings.ts) минимальные attention items с `href` и `actionLabel`, ведущие на `channels?channel=<key>`.

1. Выровнять overview entry points

Проверить overview entry points и channel navigation: если переходы на `channels` остаются слишком общими, дать им тот же canonical переход с `channel=<key>` там, где проблемный канал уже известен.

1. Закрыть регрессии и docs

Добавить focused tests на:

- hydration/sync `channel=<key>`;
- actionable channel attention items или явное отсутствие ложных attention items, если snapshot недостаточно надёжен;
- отсутствие регрессий в существующем `session/bootstrap/artifact/runtime/cron/skills` contract.

Обновить docs, чтобы operator/testing guidance больше не отставали от нового channels drill-down flow.

## Вне scope

- Новый channels dashboard или incident center.
- Расширение backend `channels.status` только ради richer attention, если текущего snapshot уже хватает.
- Полная сериализация локального UI state каждой channel card.
- Exec approvals / nodes / logs correlation в этом же stage.

## Ожидаемый результат

Проблемы каналов перестают быть «изолированной вкладкой»: оператор может открыть нужный канал по ссылке, пережить refresh/popstate и не терять контекст. Это продолжает текущий correlation contract и приближает control UI к стабильной `v1` без расширения backend scope.
