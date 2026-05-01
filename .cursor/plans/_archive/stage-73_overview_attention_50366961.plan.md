---
name: stage-73 overview attention
overview: "Привести `overview` attention links к тому же canonical routing pattern, что уже есть у dashboard cards и остальных operator surfaces: shared destination helpers, primary-click handoff внутри SPA и browser-native modified-click navigation."
todos:
  - id: canonicalize-overview-attention-targets
    content: Пересобрать internal overview attention href targets поверх shared canonical destination helpers в app-settings.
    status: completed
  - id: wire-overview-attention-handoff
    content: Добавить internal-link primary-click handoff в overview attention renderer и пробросить app-level navigation callbacks без потери modified-click behavior.
    status: completed
  - id: lock-overview-attention-regressions
    content: Обновить tests и docs для canonical overview attention link parity, включая internal/external click semantics.
    status: completed
isProject: false
---

# Stage 73 - Overview Attention Link Parity

## Goal

Сделать `overview` attention strip полноценным canonical entry surface: attention links должны не просто вести в нужный tab, а использовать тот же shared routing contract, что и сами destination surfaces, и при primary click оставаться внутри SPA без полного document navigation.

## Why This Stage

- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\overview-attention.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\overview-attention.ts) action links уже рендерятся как `<a href>`, но сейчас это обычная browser navigation без `preventDefault`/handoff parity, в отличие от [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\overview-cards.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\overview-cards.ts).
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts) `buildAttentionItems(...)` собирает многие internal targets через `buildTabHref(...)`, хотя для `cron`, `sessions`, `channels`, `bootstrap`, `artifacts`, `nodes`, `settings`, `logs` уже есть shared `buildCanonical*Href(...)` helpers.
- `overview attention` — это high-signal operator strip для ошибок/approval/recovery; parity здесь заметнее и полезнее, чем следующий большой URL contract с многозначными transient states.

## Scope

- Перевести `overview attention` internal links на shared canonical destination builders.
- Добавить primary-click SPA handoff для internal attention links, сохранив browser-native modified-click/new-tab behavior.
- Оставить external docs links (`external: true`) на обычной browser navigation.
- Не расширять сам URL contract новых tabs/query params: stage про parity entrypoint, а не про новый state subset.

## Planned Changes

- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts):
  - Пересобрать internal attention targets поверх существующих shared helpers (`buildCanonicalLogsHref(...)`, `buildCanonicalSessionsRuntimeHref(...)`, `buildCanonicalBootstrapHref(...)`, `buildCanonicalArtifactsHref(...)`, `buildCanonicalChannelHref(...)`, `buildCanonicalNodesExecApprovalsHref(...)`, `buildCanonicalCronJobHref(...)` и при необходимости `buildCanonicalTabHref(...)` там, где отдельного helper нет).
  - Сохранить handoff-aware runtime target для recovery attention, но больше не собирать query string ad hoc там, где уже есть canonical helper destination surface.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\types.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\types.ts) и [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\overview.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\overview.ts):
  - При необходимости расширить `AttentionItem`/`OverviewProps`, чтобы attention renderer знал, какой tab/state handoff выполнять для internal links, не дублируя parsing href в view.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\overview-attention.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\overview-attention.ts):
  - Добавить pattern уровня `isModifiedNavigationClick(...)` и primary-click `preventDefault()` только для internal targets.
  - Оставить external links без SPA interception.
  - Сохранить текущий visual shell и action labels.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts):
  - Пробросить `overview`-level navigation callback для attention items, аналогично уже существующему pattern у overview cards / recent session rows.
  - Для chat-linked/runtime-linked cases использовать тот же app-level handoff, что уже применяется при cross-surface navigation, чтобы URL и visible state не расходились.

## Validation

- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts):
  - Обновить regressions для `buildAttentionItems(...)`, чтобы internal `href` строились через canonical destination contract, а не через path-only/ad hoc assembly.
  - Проверить representative recovery/bootstrap/artifact/channel/exec-approval/cron attention targets.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\overview-attention.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\overview-attention.test.ts):
  - Добавить render-level regressions на canonical `href` для internal attention links.
  - Покрыть primary-click vs modified-click semantics для representative internal link.
  - Покрыть, что external attention link не перехватывается SPA handoff.
- Обновить notes в [C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md](C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md) и [C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md](C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md), зафиксировав, что `overview attention` теперь reuse'ит canonical destination helpers и поддерживает browser-native modified-click parity так же, как dashboard cards.

## Notes

- Это сильнее, чем следующий boolean-only polish вроде `logsAutoFollow`: attention strip — operator-critical entrypoint, где ошибка/approval/recovery чаще всего и начинается.
- Это заметно чище, чем сразу тянуть новый сложный contract вроде usage multi-select или cursor-range serialization: здесь не нужен новый query namespace, только выравнивание existing canonical destinations.
- External docs/auth hints должны остаться обычными ссылками без SPA interception, чтобы не ломать ожидаемое поведение браузера.
