---
name: stage-72-cron-edit
overview: "Выбрать следующий сильный, но узкий routing шаг после `usage`-этапов: довести `cron` до refresh-safe/shareable edit context, чтобы ссылка восстанавливала не только runs/list investigation state, но и конкретный job edit mode."
todos:
  - id: define-cron-edit-routing-contract
    content: Расширить cron URL contract и shared canonical helper для edit target поверх существующего cron list/runs context.
    status: completed
  - id: wire-cron-edit-link-controls
    content: Пробросить cron edit href builders в renderer, синхронизировать edit/cancel callbacks через syncUrlWithTab(...) и перевести representative controls на real anchors.
    status: completed
  - id: lock-cron-edit-regressions
    content: Добавить helper/render regressions и docs note для cron edit-mode deep-link parity.
    status: completed
isProject: false
---

# Stage 72 - Cron Edit Mode Link Parity

## Goal

Сделать `cron` пригоднее для шаринга и повторного расследования на уровне edit workflow: canonical URL должен восстанавливать не только list/runs context, но и то, какой job сейчас загружен в form как edit target.

## Why This Stage

- В `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts)` `cron` уже сериализует сильный list/runs contract (`cronQ`, `cronEnabled`, `cronSchedule`, `cronStatus`, `cronSort`, `cronDir`, `cronRunsScope`, `cronRunsQ`, `cronRunsSort`, `cronRunsStatus`, `cronRunsDelivery`, `cronJob`), но `cronEditingJobId` вообще не участвует в URL.
- В `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\controllers\cron.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\controllers\cron.ts)` `startCronEdit(...)` и `cancelCronEdit(...)` меняют только локальный state.
- В `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\cron.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\cron.ts)` row overlay уже использует canonical `href` для runs drill-down, но `Edit` action остаётся JS-only и не имеет native modified-click / new-tab parity.
- Это заметно чище и сильнее, чем тащить сейчас combinatorial filters (`usage` log filters, cursor ranges, column subsets): здесь маленький finite contract с высоким operator value.

## Scope

- Добавить `cron` query contract для edit target, не ломая существующее значение `cronJob`, которое уже занято под runs scope.
- Добавить shared canonical helper для cron edit-mode href, который сохраняет текущий cron investigation context и накладывает edit override.
- Перевести representative edit-mode controls на real anchors с primary-click handoff и browser-native modified-click navigation.
- Оставить вне scope сериализацию всего form draft, validation errors и dirty state.

## Planned Changes

- В `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts)`:
- Расширить `SettingsHost` / deep-link hydration / serialization новым `cron` edit param (например, отдельный `cronEdit`, чтобы не конфликтовать с `cronJob`).
- Добавить fallback для stale/invalid edit target: если job отсутствует после reload, сбрасывать только edit mode, не роняя list/runs context.
- Добавить helper уровня `buildCanonicalCronEditHref(...)`; при необходимости собрать `buildCanonicalCronJobHref(...)` и новый helper поверх общего cron builder, чтобы не дублировать contract.
- В `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\controllers\cron.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\controllers\cron.ts)` и `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts)`:
- Синхронизировать `startCronEdit(...)` / `cancelCronEdit(...)` через `syncUrlWithTab(state, "cron", true)` в том месте, где уже есть app-level routing context.
- Пробросить новый edit href builder в `renderCron(...)` рядом с уже существующим `buildJobHref`.
- В `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\cron.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\cron.ts)`:
- Перевести `Edit` action на anchor-based control с canonical `href`, active parity и `isModifiedNavigationClick(...)` handoff, сохранив текущее JS поведение для primary click.
- Дать `Cancel edit` canonical target обратно в create/default mode, чтобы refresh/popstate/new-tab корректно восстанавливали и выход из edit state.
- При необходимости добавить `buildEditHref` / `buildCancelEditHref` в `CronProps`, не размазывая routing logic по view.

## Validation

- В `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts)`:
- Добавить regressions на hydrate/serialize нового cron edit query contract.
- Проверить, что invalid/stale edit target мягко сбрасывается без потери existing cron filters / runs state.
- Добавить regression на canonical helper, чтобы edit href сохранял текущий cron context так же последовательно, как уже делает `buildCanonicalCronJobHref(...)`.
- В `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\cron.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\cron.test.ts)`:
- Покрыть render-level canonical `href` для `Edit` и `Cancel edit`.
- Проверить primary-click vs modified-click semantics для representative edit control.
- Добавить regression, что restored URL state реально возвращает form в тот же edit target, а не только в тот же runs scope.
- Обновить `[C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md](C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md)` и `[C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md](C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md)`:
- Зафиксировать, что cron shareable context теперь включает и form edit target subset, а form payload/errors по-прежнему остаются локальными.

## Notes

- Хороший параметр должен быть отдельным от `cronJob`, чтобы runs scope и edit mode могли сосуществовать и не путать intent.
- Если по ходу чтения выяснится, что `new/default` mode тоже нужен как явный canonical target, можно кодировать его через отсутствие `cronEdit`, а не через специальный sentinel.
- Этот stage оставляет весь mutable form draft вне URL, поэтому риск stale-state и oversized links остаётся низким.
