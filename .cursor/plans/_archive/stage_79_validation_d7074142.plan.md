---
name: stage 79 validation
overview: "Перевести Control UI из серии локальных parity-этапов в release-minded стадию: закрыть последний заметный shell gap в command palette и зафиксировать браузерный regression gate для canonical navigation, refresh/popstate и operator handoff flows."
todos:
  - id: palette-anchor-contract
    content: Сделать navigation items в command palette реальными canonical anchor targets с SPA handoff для primary click и browser fallthrough для modified click.
    status: completed
  - id: lock-browser-regressions
    content: Добавить/усилить focused regressions для shell-to-surface canonical routing, refresh/popstate и destination contract parity на representative routes.
    status: completed
  - id: document-release-gate
    content: Оформить testing/docs как понятный Navigation Validation Gate для v1, включая expected jsdom fallthrough warning и обязательные shell/operator journeys.
    status: completed
isProject: false
---

# Stage 79 - Navigation Validation Gate

## Why This Stage

После Stage 78 основная canonical-routing архитектура уже собрана: URL-синхронизация и deep-link hydration централизованы в [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts), а shell-level affordances уже частично выровнены через [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts).

Следующий сильный шаг к богатой v1: перестать дробить навигацию на бесконечные микро-stage и перейти к release-oriented gate. Для этого имеет смысл закрыть последний заметный shell gap и затем закрепить регрессии как единый browser/history contract.

## Goal

Сделать command palette полноценной canonical navigation surface и зафиксировать минимальный v1 validation gate для high-signal operator flows: primary click SPA handoff, modified-click browser fallthrough, refresh/popstate persistence, и одинаковый destination contract между shell, sidebar и target surfaces.

## Scope

### 1. Command Palette As Real Navigation Surface

Обновить [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\command-palette.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\command-palette.ts), чтобы navigation items перестали быть только `div @click` и стали реальными anchor targets с canonical `href` для tab destinations.

Нужно сохранить текущую keyboard-first механику и selection semantics, но выровнять поведение с sidebar:

- primary click: JS handoff через существующий callback
- modified click: не перехватывать, позволить браузеру открыть canonical URL
- palette rows для slash/skills оставить на текущей action-модели, если они не имеют естественного shareable destination

Для генерации destination contract опереться на уже существующие shared helpers в [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts), а wiring держать в [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts).

### 2. Browser Regression Matrix For High-Signal Routes

Усилить regression coverage вокруг уже собранного routing contract, не расползаясь по всем поверхностям сразу. В первую очередь зафиксировать shell-to-surface flows:

- command palette -> canonical tab destination
- breadcrumb/sidebar equivalence по destination contract
- refresh/popstate для representative surfaces, где уже есть richest query state: `usage`, `sessions`, `cron`

Главная цель здесь: доказать, что shell entrypoints и целевые поверхности используют один и тот же URL contract, а не просто «визуально переходят в нужный tab».

Опорные места для тестов и existing patterns:

- [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\command-palette.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\command-palette.test.ts)
- [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\components\dashboard-header.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\components\dashboard-header.test.ts)
- [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts)
- [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render-usage-tab.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render-usage-tab.test.ts)
- [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.test.ts)
- [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\cron.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\cron.test.ts)

### 3. Promote The Existing Testing Notes Into A Release Gate

Подтянуть [C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md](C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md) и [C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md](C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md) от «набор заметок по parity» к понятному v1 gate:

- какие shell/operator journeys считаются обязательными для проверки перед релизом
- что уже гарантируется unit coverage
- где ожидаем jsdom browser-fallthrough warning и не считаем его регрессией
- какие surfaces считаются canonical/shareable entrypoints для пользователя

## Out Of Scope

- Новые product-фичи вне navigation/stability темы
- Полная сериализация эфемерного UI state вроде palette query, drawer open state, chat draft, live feed buffers
- Большой новый e2e harness поверх всего UI, если текущие focused tests уже закрывают нужный routing contract

## Validation

Минимальный expected gate для этого stage:

- focused vitest по `command-palette`, `dashboard-header`, `app-settings`, и representative surface tests
- lints только по реально затронутым UI-файлам
- короткий sanity прогон docs/test-command списка, чтобы stage завершался не «ещё одной ссылкой», а явным переходом в стабилизацию

## Why This Is The Strong Next Step

Это stage уже ближе к release candidate мышлению:

- добивает последний заметный shell gap
- превращает набор разрозненных parity-fixes в единый validation contract
- даёт точку, после которой можно честно говорить: дальше уже не бесконечно строим фундамент, а тестируем, жмём хвосты и начинаем наращивать поверх стабильной базы
