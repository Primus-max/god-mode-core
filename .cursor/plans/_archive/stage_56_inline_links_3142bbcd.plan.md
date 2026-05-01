---
name: stage 56 inline links
overview: "Закрыть оставшийся routing gap после Stage 55: ручные ссылки внутри `sessions` и `cron` всё ещё собираются через `pathForTab(...)` и обходят общий canonical URL contract. Следующий шаг — перевести эти inline/open-in-new-tab href'ы на общие helper'ы, чтобы row-level navigation вела в тот же shareable scope, что и tab/sidebar navigation."
todos:
  - id: export-inline-link-helper
    content: Открыть общий helper для tab href assembly в `ui/src/ui/app-settings.ts` без дублирования query normalization.
    status: completed
  - id: migrate-sessions-inline-links
    content: Перевести session-row и runtime-linked record href'ы в `ui/src/ui/views/sessions.ts` на shared routing helper.
    status: completed
  - id: migrate-cron-inline-links
    content: Перевести cron run chat/runtime href'ы в `ui/src/ui/views/cron.ts` на shared routing helper.
    status: completed
  - id: lock-inline-link-regressions
    content: Добавить focused tests/docs для canonical inline link parity в `sessions` и `cron`.
    status: completed
isProject: false
---

# Stage 56 - Inline Link Canonical Parity

## Goal

Сделать последние row-level и action-level ссылки внутри canonical surfaces (`sessions` и `cron`) такими же contract-driven, как уже выровненные sidebar/tab/overview links. После этого open-in-new-tab и copy-link из самих таблиц/карточек перестанут зависеть от ручной сборки query-строки.

## Why This Step

После Stage 55 общий routing contract уже централизован в [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts), но в surface-компонентах ещё остались ручные URL builder'ы:

- [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.ts) всё ещё держит локальный `buildTabLink(...)` и отдельный `chatUrl` через `pathForTab(...)`.
- [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\cron.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\cron.ts) строит `chatUrl` и `sessionsUrl` для run rows вручную.
- Это создаёт второй источник правды для href'ов и оставляет точечный риск расхождения при следующих изменениях canonical query contract.

Ключевые места:

```161:173:C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.ts
function buildTabLink(
  basePath: string,
  tab: "bootstrap" | "artifacts",
  params: Record<string, string | null | undefined>,
): string {
  const url = new URL(`https://openclaw.local${pathForTab(tab, basePath)}`);
  // ... manual query assembly ...
}
```

```1133:1136:C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.ts
const canLink = row.kind !== "global";
const chatUrl = canLink
  ? `${pathForTab("chat", basePath)}?session=${encodeURIComponent(row.key)}`
  : null;
```

```1727:1736:C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\cron.ts
const chatUrl =
  typeof entry.sessionKey === "string" && entry.sessionKey.trim().length > 0
    ? `${pathForTab("chat", basePath)}?session=${encodeURIComponent(entry.sessionKey)}`
    : null;
const sessionsUrl =
  typeof entry.sessionKey === "string" && entry.sessionKey.trim().length > 0
    ? `${pathForTab("sessions", basePath)}?session=${encodeURIComponent(entry.sessionKey)}&runtimeSession=${encodeURIComponent(entry.sessionKey)}`
    : null;
```

При этом общий helper уже есть:

```582:597:C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts
function buildTabHref(host: Pick<SettingsHost, "basePath">, tab: Tab, params = {}): string { /* ... */ }
export function buildCanonicalTabHref(host: SettingsHost | AppViewState, tab: Tab): string {
  const url = new URL(`https://openclaw.local${pathForTab(tab, host.basePath)}`);
  applyTabQueryStateToUrl(host as SettingsHost, tab, url);
  return `${url.pathname}${url.search}`;
}
```

## Scope

Сфокусироваться только на inline links и helper reuse:

- перевести row/action href generation в `sessions` и `cron` на shared helper из `app-settings.ts` или небольшой exported helper рядом с ним
- сохранить текущий left-click JS navigation flow через callbacks
- для middle-click / Ctrl/Cmd+click / open in new tab выдавать тот же canonical target, что соответствует текущему routing contract
- убрать локальный URL builder-дубликат из `sessions.ts`

Не включать:

- новый routing contract для `machine` или других tabs без operator substate
- redesign `overview` cards
- новый runtime query surface beyond existing `session` / `runtimeSession` / object targets

## Main Files

- [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts)
- [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.ts)
- [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\cron.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\cron.test.ts)
- [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.test.ts)
- При необходимости: [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts), [C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md](C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md), [C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md](C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md)

## Implementation

1. Вынести или экспортировать reuse-friendly href helper из [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts).

- Либо открыть `buildTabHref(...)`, либо добавить маленький exported helper для path+query URL assembly, который используют view-level links.
- Не дублировать логику `trim`/`setQueryValue` во view-компонентах.

1. Перевести [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.ts) на shared contract.

- Убрать локальный `buildTabLink(...)`.
- Строить runtime-linked bootstrap/artifact href'ы через общий helper.
- Строить session-row `chatUrl` через тот же helper, а не через ручной `pathForTab("chat") + ?session=...`.
- Не менять существующие click-handler semantics: обычный click по-прежнему может идти через callback, а modified-click/new tab должен пользоваться canonical href.

1. Перевести [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\cron.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\cron.ts) на shared contract.

- Строить run-row `chatUrl` и `sessionsUrl` через общий helper.
- Сохранить существующую runtime intent semantics: sessions target по-прежнему открывает session/runtime inspect path для run session key.
- Не расширять scope до новой run-specific query модели, если текущий contract уже выражает нужный operator target.

1. Зафиксировать focused regressions и docs note.

- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.test.ts): добавить regression на canonical chat href для session row и при необходимости на bootstrap/artifact action href.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\cron.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\cron.test.ts): перепривязать текущие href assertions к shared helper contract, а не к ручной строковой сборке.
- Коротко отметить в [C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md](C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md), что inline/open-in-new-tab links внутри operator surfaces должны использовать общий routing helper, а не `pathForTab(...)` напрямую.

## Expected Outcome

После stage последние user-visible ссылки внутри `sessions` и `cron` перестанут быть special-case логикой. Operator сможет открывать row-level targets в новой вкладке тем же shareable способом, что и sidebar/overview links, а дальнейшие изменения URL contract будут проходить через один источник правды вместо нескольких ручных string builder'ов.
