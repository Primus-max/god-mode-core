---
name: stage-71 usage-detail-parity
overview: "Расширить canonical routing для `usage` ещё на один слой глубже: сделать shareable и refresh-safe ключевые session-detail time-series controls, не уводя stage в тяжёлые multi-select и transient detail state."
todos:
  - id: define-usage-detail-routing-contract
    content: Расширить usage URL contract и shared canonical href helper для session-detail time-series display state поверх existing usage deep link.
    status: completed
  - id: wire-usage-detail-link-controls
    content: Пробросить usage detail href builders в renderer, синхронизировать detail callbacks через syncUrlWithTab(...) и перевести finite time-series toggles на real anchors с primary-click handoff.
    status: completed
  - id: lock-usage-detail-routing-regressions
    content: Добавить helper/render regressions и docs note для usage session-detail deep-link parity.
    status: completed
isProject: false
---

# Stage 71 - Usage Session Detail Link Parity

## Goal

Сделать `usage` пригоднее для шаринга именно на уровне single-session investigation path: time-series display controls внутри detail panel должны переживать refresh/popstate и, где это естественно, рендериться как canonical links с browser-native modified-click navigation.

## Why This Stage

- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render-usage-tab.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render-usage-tab.ts) detail callbacks для `usageTimeSeriesMode` и `usageTimeSeriesBreakdownMode` меняют только локальный state и не вызывают `syncUrlWithTab(...)`, хотя `usageSession` уже восстанавливает тот же session investigation path после reload.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usage-render-details.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usage-render-details.ts) time-series toggles (`per-turn` / `cumulative`, `total` / `by-type`) всё ещё рендерятся как click-only buttons.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts) usage contract уже покрывает overview state (`usageChart`, `usageDaily`, `usageSessions`, `usageSort`, `usageSortDir`), но detail chart state пока полностью выпадает из URL.
- В [C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md](C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md) Usage уже обещает восстановление session investigation path; следующий логичный шаг — не только открыть тот же session, но и вернуть тот же chart reading mode.

## Scope

- Добавить usage detail query contract для `usageTimeSeriesMode` и `usageTimeSeriesBreakdownMode`.
- Добавить shared canonical href builder overrides для usage detail time-series controls поверх уже существующего `buildCanonicalUsageHref(...)`.
- Перевести finite time-series toggles на real anchors с primary-click handoff и modified-click browser navigation.
- Оставить вне scope cursor/range selection, `Reset` selection button, log filters, context expansion, expanded logs state и другие transient detail controls.

## Planned Changes

- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts) расширить `usage` query contract новыми params для detail time-series state, с нормализацией невалидных значений и fallback к текущим дефолтам.
- В том же файле расширить `buildCanonicalUsageHref(...)`, чтобы он умел собирать canonical usage URL не только для overview, но и для session-detail display overrides.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render-usage-tab.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render-usage-tab.ts) синхронизировать detail callbacks через `syncUrlWithTab(state, "usage", true)` и пробросить href builders в detail renderer.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usage-render-details.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usage-render-details.ts) заменить buttons для `per-turn` / `cumulative` и `total` / `by-type` на anchor-based controls с canonical `href`, active parity и `isModifiedNavigationClick(...)`.
- При необходимости обновить [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usage.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usage.ts) / [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usageTypes.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usageTypes.ts), чтобы detail builders и props не дублировали routing logic.

## Validation

- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts) добавить regressions на hydrate/serialize usage detail chart contract и fallback при невалидных query values.
- Там же добавить regression, что `buildCanonicalUsageHref(...)` корректно собирает session-detail time-series overrides поверх уже существующего usage/session context.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usage-render-details.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usage-render-details.test.ts) или соседнем usage detail suite покрыть render-level canonical `href` для representative detail toggles и primary-click vs modified-click semantics.
- Добавить render regression, что restored URL state реально возвращает ту же detail presentation для single-session usage path: `per-turn` / `cumulative` и `total` / `by-type`, а не только открывает тот же session.
- Обновить expectation в [C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md](C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md) и уточнить Usage note в [C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md](C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md): restored usage investigation path теперь включает не только overview subset, но и canonical detail chart mode subset.

## Notes

- Это более сильный и чистый следующий шаг, чем сразу тащить в URL cursor range, multi-select log filters или новый surface вроде `cron`: здесь маленький finite contract с высоким operator value.
- `Reset` selection button и cursor range стоит оставить локальными на этом этапе: они полезны, но заметно усложняют canonicalization и stale-state fallback.
- Если по ходу работы выяснится, что breakdown toggle нужно скрывать из URL в cumulative mode, это допустимо и даже желательно: canonical contract должен сериализовать только реально активный detail mode subset.
