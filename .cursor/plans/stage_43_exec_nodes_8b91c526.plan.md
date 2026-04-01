---
name: stage 43 exec nodes
overview: "Сшить `exec approvals` и `nodes` с уже существующим operator correlation flow: attention на overview должен вести в канонический `nodes` drill-down, а выбранный approval context должен переживать refresh/popstate так же, как `cronJob`, `channel` и `skillFilter`."
todos:
  - id: add-exec-nodes-deeplink-contract
    content: Добавить минимальный query/deep-link contract для `nodes`/`exec approvals` и гидрацию состояния из URL.
    status: completed
  - id: wire-exec-attention-and-nodes-focus
    content: Сделать exec-approval сигналы overview/actionable и сфокусировать `nodes` UI на выбранном approval target/scope.
    status: completed
  - id: lock-exec-nodes-correlation-regressions
    content: Добавить focused tests и обновить docs/testing guidance для exec/nodes correlation flow.
    status: completed
isProject: false
---

# Stage 43 - Exec & Nodes Correlation Surfaces

## Why now

`Stage 42` явно оставил `exec approvals / nodes / logs correlation` вне scope, а текущий UI уже содержит почти все нужные примитивы:

- глобальная очередь `execApprovalQueue` уже живёт в `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app.ts)`
- вкладка `nodes` уже грузит `exec approvals`, devices и bindings через `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts)` и `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts)`
- canonical deep-link contract в `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts)` уже умеет `bootstrapRequest`, `artifact`, `channel`, `runtimeSession`, `runtimeRun`, `checkpoint`, `cronJob`, `skillFilter`, но пока ничего не знает про `nodes`/`exec approvals`

Это делает stage небольшим по риску и хорошо продолжающим chain `36 -> 42`: те же `attention + deep-link + persisted tab state + focused regression tests`.

## Scope

### 1. Minimal nodes deep-link contract

В `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts)` расширить URL contract для вкладки `nodes` минимальным набором состояния, достаточным для операторского drill-down.

Рекомендуемый минимум:

- `execTarget=gateway|node`
- `execNode=<nodeId>` когда выбран node-target
- `execAgent=<agentId|__defaults__>` если нужно открыть конкретный approvals scope

Задача этого шага не в полной сериализации всей вкладки `nodes`, а только в восстановлении того контекста, который нужен, чтобы оператор после клика из attention или reload попадал обратно в тот же approvals surface.

### 2. Actionable exec attention

В `buildAttentionItems(...)` внутри `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts)` добавить отдельный attention item для pending `execApprovalQueue`.

Источник сигнала:

- `host.execApprovalQueue[0]` как primary pending approval
- при наличии нескольких записей показывать count, как уже делает overlay в `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\exec-approval.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\exec-approval.ts)`

Поведение attention:

- `href` должен открывать вкладку `nodes`
- query должен предзаполнять `execTarget`/`execNode` на основе approval request
- если approval связан с конкретным agent scope и эти данные уже доступны без backend-расширения, проставлять и `execAgent`; если нет, оставить только target-level focus

### 3. Nodes focus wiring

В `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app.ts)`, `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts)` и `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\nodes.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\nodes.ts)` / `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\nodes-exec-approvals.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\nodes-exec-approvals.ts)` довести contract до живого UX:

- hydration из URL должна выставлять `execApprovalsTarget`, `execApprovalsTargetNodeId`, при необходимости `execApprovalsSelectedAgent`
- любые user-driven смены target/scope на вкладке `nodes` должны синхронизироваться обратно в URL через тот же `syncUrlWithTab(...)`
- при переключении на `nodes` refresh path должен использовать уже восстановленный target context, а не всегда падать в дефолтный gateway scope

Важно сохранить thin-orchestration подход: не вводить новый backend aggregate, если текущих полей approval request уже хватает.

## Verification

Покрыть focused regression tests в:

- `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts)` для hydration/persistence нового query-contract и actionable attention href
- существующем test-файле для `nodes` surface или рядом с ним, чтобы проверить, что preselected exec target реально отражается в render-path
- при необходимости test around URL sync в `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts)`

Обновить:

- `[C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md](C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md)`
- `[C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md](C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md)`

## Out of scope

- Полная корреляция `logs`
- Новый incident/dashboard для approvals
- Новый backend API только ради richer attention, если текущий approval payload уже даёт `nodeId`/session context
- Полная сериализация всего локального UI state вкладки `nodes`

## Expected outcome

После stage оператор сможет перейти из overview attention прямо в `nodes` с уже выбранным approvals target, а этот контекст будет стабильно сохраняться в URL и восстанавливаться после refresh/popstate, как это уже работает для `cron`, `skills` и `channels`.
