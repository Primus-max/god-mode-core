---
name: stage-45 agents parity
overview: "Довести вкладку agents до того же deep-link/URL parity, который уже есть у skills/channels/cron/nodes/logs: выбранный агент, активная панель и файловый drill-down должны переживать refresh/popstate и быть шаримыми ссылкой. Заодно выровнять переход из chat в agents, чтобы оператор попадал в тот же контекст, а не только в ту же вкладку."
todos:
  - id: add-agents-deeplink-contract
    content: Добавить query/deep-link contract для agents (`agent`, `agentsPanel`, `agentFile`) и гидрацию/сериализацию URL state.
    status: completed
  - id: wire-agents-url-sync
    content: Сшить agents UI и chat->agents переход с canonical URL sync, включая files drill-down и reuse `skillFilter` на skills panel.
    status: completed
  - id: lock-agents-parity-regressions
    content: Добавить focused tests и docs/testing guidance для agents deep-link parity и refresh/popstate regressions.
    status: completed
isProject: false
---

# Stage 45 - Agents Deep-Link Parity

## Goal

Закрыть самый заметный оставшийся разрыв в operator correlation chain после stages 36-44: вкладка `agents` уже богата по данным и действиям, но её состояние почти полностью живёт только в памяти.

## Why This Step

- В [ui/src/ui/app-settings.ts](ui/src/ui/app-settings.ts) deep-link contract уже покрывает `bootstrapRequest`, `artifact`, `channel`, `runtime*`, `cronJob`, `skillFilter`, `logQ`, `exec*`, но не покрывает `agents`.
- В [ui/src/ui/app-render.ts](ui/src/ui/app-render.ts) `onSelectAgent`, `onSelectPanel`, `onSelectFile` и `onNavigateToAgent` меняют `state.agentsSelectedId` / `state.agentsPanel` / `state.agentFileActive`, но не синхронизируют URL так же, как это уже делается для `sessions`, `cron`, `logs`, `nodes`.
- В [ui/src/ui/views/agents.ts](ui/src/ui/views/agents.ts) у вкладки уже есть естественные drill-down surface points: выбранный агент, panel switcher и file selection. Их как раз и нужно сделать canonical/shareable.

## Scope

- Добавить минимальный query contract для `agents`: `agent=<id>`, `agentsPanel=<panel>`, `agentFile=<name>`.
- Не расширять scope до новых overview attention items, если для них нет однозначного agent-target без доменных допущений.
- Для skills внутри `agents` не вводить новый ключ: по возможности переиспользовать существующий `skillFilter`, но только когда активна панель `skills`.

## Implementation

- Расширить hydrate/persist логику в [ui/src/ui/app-settings.ts](ui/src/ui/app-settings.ts):
  - `applyDeepLinkStateFromUrl` должен читать `agent`, `agentsPanel`, `agentFile`.
  - `applyTabQueryStateToUrl` должен сбрасывать эти ключи для остальных табов и сохранять их для `agents`.
  - Для `agentsPanel === "skills"` сохранить текущий `skillFilter`, чтобы filter parity внутри agent shell не терялся после refresh/popstate.
- Подтянуть URL sync в [ui/src/ui/app-render.ts](ui/src/ui/app-render.ts):
  - после `onSelectAgent`
  - после `onSelectPanel`
  - после `onSelectFile`
  - в `onNavigateToAgent`, чтобы переход из chat открывал именно deep-linked agent context, а не только вкладку.
- Уточнить восстановление состояния на data-load path:
  - в [ui/src/ui/app-settings.ts](ui/src/ui/app-settings.ts) и при необходимости в [ui/src/ui/controllers/agents.ts](ui/src/ui/controllers/agents.ts) сохранить приоритет deep-linked `agentsSelectedId`, если агент существует в `agents.list`.
  - если deep-linked агент исчез или недоступен, мягко падать обратно на `defaultId`/первого агента, не оставляя битый URL state.
- Подумать о минимальном UI parity для files panel в [ui/src/ui/views/agents.ts](ui/src/ui/views/agents.ts):
  - восстановленный `agentFile` должен открывать тот же файл, если он есть в списке.
  - если файла больше нет, сбросить только `agentFile`, не ломая весь agent context.

## Verification

- Добавить focused regressions в [ui/src/ui/app-settings.test.ts](ui/src/ui/app-settings.test.ts):
  - hydrate `agent` / `agentsPanel` / `agentFile`
  - persist этих ключей через `syncUrlWithTab(..., true)`
  - persist `skillFilter` для `agents`+`skills`
- Добавить controller-level regression в [ui/src/ui/controllers/agents.test.ts](ui/src/ui/controllers/agents.test.ts), что deep-linked выбранный агент сохраняется после `agents.list`, если он всё ещё существует.
- При необходимости добавить render-level coverage для files selection в [ui/src/ui/views/agents.ts](ui/src/ui/views/agents.ts) или существующий смежный test file, если там уже есть шаблон на восстановление активного файла.
- Обновить operator testing guidance в [docs/help/testing.md](docs/help/testing.md) и заметки по surface parity в [docs/web/control-ui.md](docs/web/control-ui.md).

## Expected Outcome

После stage оператор сможет делиться ссылкой на конкретный `agents` context и возвращаться в него без ручного восстановления: тот же агент, та же панель, тот же файл, а для skills panel ещё и тот же фильтр. Это продолжает уже принятый canonical drill-down contract и закрывает один из последних крупных UI parity gaps перед stable v1.
