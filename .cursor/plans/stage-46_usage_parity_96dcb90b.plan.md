---
name: stage-46 usage parity
overview: "Следующий шаг к v1 — довести вкладку `usage` до того же canonical deep-link contract, который уже есть у sessions/cron/skills/channels/logs/nodes/agents. Берём только минимально ценный operator context: диапазон дат, timezone, выбранную сессию и текстовый query, без полной сериализации всех локальных переключателей аналитики."
todos:
  - id: add-usage-deeplink-contract
    content: Добавить минимальный query/deep-link contract для usage (`usageFrom`, `usageTo`, `usageTz`, `usageSession`, `usageQ`) и гидрацию/сериализацию URL state.
    status: completed
  - id: wire-usage-url-sync
    content: Сшить usage filters/detail selection с canonical URL sync и восстановлением single-session detail path после refresh/popstate.
    status: completed
  - id: lock-usage-parity-regressions
    content: Добавить focused tests и docs/testing guidance для usage deep-link parity и refresh-safe operator investigation flow.
    status: completed
isProject: false
---

# Stage 46 - Usage Deep-Link Parity

## Goal

Сделать `usage` shareable и refresh-safe как investigation surface: после перехода из overview, refresh или пересылки ссылки оператор должен попадать в тот же базовый usage context, а не в дефолтное состояние вкладки.

## Why This Step

- В [ui/src/ui/app-settings.ts](ui/src/ui/app-settings.ts) canonical query contract уже покрывает `agents`, `bootstrap`, `artifact`, `channel`, `runtime*`, `cronJob`, `skillFilter`, `logQ`, `exec*`, но не покрывает `usage`.
- В [ui/src/ui/app-render-usage-tab.ts](ui/src/ui/app-render-usage-tab.ts) вся ценная usage-навигация живёт только в памяти: даты, timezone, query, выбранные sessions.
- В [ui/src/ui/views/overview-cards.ts](ui/src/ui/views/overview-cards.ts) overview уже ведёт в `usage`, но без сохраняемого контекста, тогда как остальные operator surfaces уже живут в одном drill-down mental model.

## Scope

- Добавить минимальный usage query contract: `usageFrom`, `usageTo`, `usageTz`, `usageSession`, `usageQ`.
- Не сериализовать в URL весь локальный UI-state `usage`.
- Для `usageSession` поддержать только один выбранный session key в canonical link; multi-select оставить эфемерным, чтобы не раздувать query contract.

## Implementation

- Расширить hydrate/persist логику в [ui/src/ui/app-settings.ts](ui/src/ui/app-settings.ts):
  - `applyDeepLinkStateFromUrl` должен читать `usageFrom`, `usageTo`, `usageTz`, `usageSession`, `usageQ`.
  - `applyTabQueryStateToUrl` должен очищать эти ключи вне `usage` и записывать их для `usage`.
  - Восстановленный `usageSession` должен попадать в `usageSelectedSessions` только как одиночный selection.
- Протянуть URL sync в [ui/src/ui/app-render-usage-tab.ts](ui/src/ui/app-render-usage-tab.ts):
  - после смены start/end date
  - после смены timezone
  - после apply/clear text query
  - после одиночного выбора/сброса session
- Уточнить load path через [ui/src/ui/controllers/usage.ts](ui/src/ui/controllers/usage.ts) и текущий render flow:
  - после hydration usage-tab должен переиспользовать существующий `loadUsage` path
  - если в URL задан ровно один `usageSession`, после загрузки usage summary должен восстанавливаться тот же detail path для `timeseries` и `session logs`
  - если session исчез из текущей выборки, мягко очистить только `usageSession`, не ломая весь usage context
- Легко выровнять overview -> usage contract там, где это уже естественно: [ui/src/ui/views/overview-cards.ts](ui/src/ui/views/overview-cards.ts) может остаться с переходом просто на `usage`, но после stage сам surface уже будет устойчивым к refresh/popstate и шарингу ссылок.

## Verification

- Добавить focused regressions в [ui/src/ui/app-settings.test.ts](ui/src/ui/app-settings.test.ts):
  - hydrate `usageFrom` / `usageTo` / `usageTz` / `usageSession` / `usageQ`
  - persist этих ключей через `syncUrlWithTab(..., true)`
  - корректный fallback, если `usageSession` больше невалиден
- Добавить focused usage regression рядом с существующими usage tests, используя [ui/src/ui/controllers/usage.ts](ui/src/ui/controllers/usage.ts) или существующий usage render/controller test file:
  - подтверждение, что single-session deep link восстанавливает detail load path
  - подтверждение, что apply/clear query синхронизирует canonical usage query state
- Обновить [docs/help/testing.md](docs/help/testing.md) и [docs/web/control-ui.md](docs/web/control-ui.md) с usage parity note.

## Expected Outcome

После stage `usage` перестанет быть последним крупным operator surface без shareable context: ссылка сможет сохранять диапазон, timezone, query и одну выбранную session investigation path. Это приблизит проект к `v1` ещё на один заметный шаг: после закрытия `usage` останутся уже в основном более мелкие parity/polish gaps, а не большой системный разрыв в operator navigation contract.
