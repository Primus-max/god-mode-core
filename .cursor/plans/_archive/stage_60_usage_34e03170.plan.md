---
name: stage 60 usage
overview: "Сделать `usage` session rows частью того же canonical link contract, что уже есть у sidebar, overview и inline links: обычный click сохраняет текущий быстрый JS handoff, а modified-click/open-in-new-tab ведут в тот же shareable `usage` target через настоящий `href`. Это даёт заметный v1-polish на high-traffic операторском surface без изобретения нового URL state."
todos:
  - id: define-usage-session-target
    content: Зафиксировать canonical target для usage session rows как existing usage deep link с текущими usage-фильтрами и single-session override без нового query contract.
    status: completed
  - id: wire-usage-session-links
    content: Пробросить href-builder и primary-click handoff в usage session rows, сохранив shift multi-select, copy button и current fast JS selection flow.
    status: completed
  - id: lock-usage-session-regressions
    content: Добавить focused tests, при необходимости включить новый usage test file в unit config, и коротко отметить contract в docs/testing.
    status: completed
isProject: false
---

# Stage 60 - Usage Session Link Parity

## Goal

Сделать строки сессий в `usage` реальными canonical links, чтобы оператор мог открыть конкретный usage drill-down в новой вкладке, скопировать ссылку или сделать Ctrl/Cmd-click без потери уже выбранного filter state.

## Why This Step

`usage` уже умеет жить в shareable URL, но основной session entry surface всё ещё click-only. Сейчас row рендерится как `div` с JS-only handoff в [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usage-render-overview.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usage-render-overview.ts):

```755:758:C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usage-render-overview.ts
<div
  class="session-bar-row ${isSelected ? "selected" : ""}"
  @click=${(e: MouseEvent) => onSelectSession(s.key, e.shiftKey)}
  title="${s.key}"
>
```

При этом после выбора сессии `usage` уже синхронизирует URL через shared routing layer в [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render-usage-tab.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render-usage-tab.ts):

```242:287:C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render-usage-tab.ts
onSelectSession: (key, shiftKey) => {
  // ... selection + loading logic ...
  syncUsageUrl();
},
```

И сам contract уже существует в [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts), где `usage` сериализует `usageFrom`, `usageTo`, `usageTz`, `usageSession`, `usageQ` через общий routing helper.

Это делает `usage` самым естественным следующим stage после `overview recent sessions`: high-traffic surface уже canonical по state, но ещё не canonical по link behavior.

## Scope

Включить:

- сделать usage session rows реальными anchor targets
- строить `href` через existing routing helpers из [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts)
- сохранить обычный left-click как текущий JS handoff path
- дать modified-click / middle-click / open-in-new-tab уйти в браузерный `href`
- сохранить existing semantics для shift multi-select и secondary actions внутри row

Не включать:

- новый query contract для `usage`
- сериализацию multi-select в URL
- redesign usage cards/layout
- расширение этого же stage на `channels`, `cron` или command palette

## Main Files

- [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usage-render-overview.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usage-render-overview.ts)
- [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usage.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usage.ts)
- [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usageTypes.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usageTypes.ts)
- [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render-usage-tab.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render-usage-tab.ts)
- [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts)
- [C:\Users\Tanya\source\repos\god-mode-core\ui\src\styles\usage.css](C:\Users\Tanya\source\repos\god-mode-core\ui\src\styles\usage.css)
- [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts)
- Новый focused view test рядом с usage overview rendering, плюс [C:\Users\Tanya\source\repos\god-mode-core\vitest.unit-paths.mjs](C:\Users\Tanya\source\repos\god-mode-core\vitest.unit-paths.mjs) при необходимости
- [C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md](C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md)

## Implementation

1. Зафиксировать canonical target для одной usage row.

- Использовать existing `usage` URL contract, а не новый row-specific query model.
- Canonical `href` для строки должен означать: текущие `usageFrom` / `usageTo` / `usageTz` / `usageQ` плюс именно эта session как единственный `usageSession`.
- Явно принять ограничение текущего contract: multi-select остаётся runtime-only; browser `href` репрезентирует single-session drill-down.

1. Пробросить shared href-builder и click handoff в usage rendering.

- Расширить contract между [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render-usage-tab.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render-usage-tab.ts), [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usage.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usage.ts) и [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usage-render-overview.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\usage-render-overview.ts), чтобы row получала `href` и callback по тому же шаблону, что уже используют `sessions` и `overview`.
- На обычный left-click перехватывать событие и сохранять текущий selection flow, включая shift-range selection и eager data loading.
- На modified-click не мешать браузеру открыть canonical link.
- Не сломать `.session-copy-btn`: secondary control должен продолжать делать `stopPropagation()`/локальный action и не активировать row navigation.
- При необходимости обновить стили в [C:\Users\Tanya\source\repos\god-mode-core\ui\src\styles\usage.css](C:\Users\Tanya\source\repos\god-mode-core\ui\src\styles\usage.css), чтобы anchor выглядел как текущая session card.

1. Зафиксировать focused regressions и test discovery.

- Добавить render-level regression на то, что usage session row получает canonical `href` с текущими usage filters и target `usageSession`.
- Добавить regression на primary click vs modified-click behavior.
- Добавить regression на то, что shift multi-select path остаётся JS-driven и не ломает existing selection semantics.
- Если для этого нужен новый test file, включить его в [C:\Users\Tanya\source\repos\god-mode-core\vitest.unit-paths.mjs](C:\Users\Tanya\source\repos\god-mode-core\vitest.unit-paths.mjs), как уже делали для `overview-cards.test.ts`.
- Коротко отметить в [C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md](C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md), что usage session rows должны использовать shared routing helpers и не откатываться к click-only div rows.

## Expected Outcome

После stage оператор сможет открыть конкретную usage session в новой вкладке и получить тот же drill-down, который раньше был доступен только через local click state. Это подтягивает один из самых насыщенных операторских экранов к v1-уровню browser-native navigation, не раздувая routing model и не ломая существующую rich selection semantics.
