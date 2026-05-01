---
name: stage-70 usage parity
overview: Расширить canonical routing для `usage`, чтобы ключевые overview display controls стали shareable, refresh-safe и частично browser-native, не раздувая scope до всех локальных аналитических переключателей.
todos:
  - id: define-usage-overview-routing-contract
    content: Расширить usage URL contract и shared canonical href helper для overview display state поверх existing usage deep link.
    status: completed
  - id: wire-usage-overview-link-controls
    content: Пробросить usage href builders в overview renderer, синхронизировать display callbacks через syncUrlWithTab(...) и перевести finite toggles на real anchors с primary-click handoff.
    status: completed
  - id: lock-usage-overview-routing-regressions
    content: Добавить helper/render regressions и docs note для usage overview display deep-link parity.
    status: completed
isProject: false
---

# Stage 70 - Usage Overview Display Link Parity

## Goal

Сделать `usage` более пригодным для шаринга и повторного расследования: ключевые overview display controls должны переживать refresh/popstate и, где это естественно, рендериться как canonical links с browser-native modified-click navigation.

## Why This Stage

- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts) для `usage` сейчас сериализуются только `usageFrom`, `usageTo`, `usageTz`, `usageSession`, `usageQ`; display state (`usageChartMode`, `usageDailyChartMode`, `usageSessionsTab`, `usageSessionSort`, `usageSessionSortDir`) выпадает из URL contract.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render-usage-tab.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render-usage-tab.ts) callbacks `onChartModeChange`, `onDailyChartModeChange`, `onSessionSortChange`, `onSessionSortDirChange`, `onSessionsTabChange` меняют только локальный state и не вызывают `syncUrlWithTab(...)`.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usage-render-overview.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usage-render-overview.ts) overview toggles (`Tokens/Cost`, `Total/By type`, `All/Recent`, sort direction) рендерятся как click-only buttons, хотя это конечные дискретные состояния, которые хорошо ложатся на тот же canonical href parity pattern, что уже есть у `logs`, `sessions`, `agents`, `settings`.
- В [C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md](C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md) Usage сейчас описан как surface с "minimal investigation context" без analytics toggles; следующий сильный шаг — добавить именно самые важные overview switches, не сериализуя весь локальный UI.

## Scope

- Добавить usage-level query contract для обзорных display controls: `usageChartMode`, `usageDailyChartMode`, `usageSessionsTab`, `usageSessionSort`, `usageSessionSortDir`.
- Добавить shared canonical href helper для `usage`, который сохраняет существующий usage context и накладывает overrides на display state.
- Перевести finite overview toggles на real anchors с primary-click handoff и modified-click browser navigation.
- Оставить вне scope day/hour multi-select, column visibility, pinned header, detail chart toggles и session-log filters, чтобы stage остался локальным и сильным.

## Planned Changes

- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts) расширить `usage` query contract новыми params для overview display state, с нормализацией невалидных значений и мягким fallback к текущим дефолтам.
- В том же файле добавить helper уровня `buildCanonicalUsageHref(...)` и по возможности собрать [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts) `buildCanonicalUsageSessionHref(...)` поверх него, чтобы session rows и overview controls использовали один routing contract.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render-usage-tab.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render-usage-tab.ts) синхронизировать display callbacks через `syncUrlWithTab(state, "usage", true)` и пробросить новые href builders в `renderUsage(...)`.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usage-render-overview.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usage-render-overview.ts) заменить overview toggle buttons (`Tokens/Cost`, `Total/By type`, `All/Recent`, sort direction) на anchor-based controls с canonical `href`, active parity и `isModifiedNavigationClick(...)`. Sort key `<select>` можно оставить form control, но его state тоже должен round-trip'иться через URL.
- При необходимости обновить [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usage.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usage.ts) / `UsageProps`, чтобы новые builders были доступны overview renderer без дублирования routing logic.

## Validation

- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts) добавить regressions на hydrate/serialize usage overview display contract и fallback при невалидных query values.
- Там же добавить regression на `buildCanonicalUsageHref(...)` и убедиться, что `buildCanonicalUsageSessionHref(...)` не расходится с обновлённым shared contract.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usage-links.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usage-links.test.ts) или отдельном близком usage view suite покрыть render-level canonical `href` для representative overview toggles и primary-click vs modified-click semantics.
- Добавить render regression, что восстановленный URL state реально возвращает ту же overview presentation: режим `tokens/cost`, `total/by-type`, `all/recent` и sort direction, а не только date/session/query context.
- Обновить expectation в [C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md](C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md) и уточнить Usage note в [C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md](C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md): Usage теперь шарит не весь локальный analytics state, а конкретный canonical overview display subset.

## Notes

- Это сильнее и чище, чем тащить в `stage 70` весь `cron` filter parity: `usage` сейчас имеет заметный URL gap именно на high-visibility display controls, а не только отсутствие anchor semantics поверх уже сериализованного state.
- Стоит держать scope узким: overview display controls да, все transient/local analytics toggles нет.
- Если по ходу исследования окажется, что sort key лучше пока оставить как `<select>`, это допустимо: главное, чтобы он начал round-trip'иться через shared usage routing contract и не расходился с anchor-based toggles.
