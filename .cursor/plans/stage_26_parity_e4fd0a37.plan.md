---
name: stage 26 parity
overview: "Подготовить следующий этап после Stage 25: закрепить parity для continuation/compaction и сделать операторский handoff предсказуемым, когда direct-session run порождает followup/retry с новым runtime runId."
todos:
  - id: define-canonical-correlation
    content: Зафиксировать canonical correlation rule между sessions.send idempotency, runtime runId и final handoff IDs
    status: completed
  - id: wire-continuation-surfaces
    content: Привести continuation/compaction/retry projections к одной operator-visible truth model
    status: completed
  - id: add-continuation-regressions
    content: Добавить deterministic tests на финальный runId и handoff parity после continuation
    status: completed
  - id: rerun-continuation-smoke
    content: Провести один local continuation or compaction smoke и зафиксировать handoff evidence
    status: completed
  - id: document-stage26-handoff
    content: Обновить runbook и CLI guidance для continuation-aware handoff
    status: completed
isProject: false
---

# Stage 26: Continuation And Handoff Parity

## Goal

Сделать так, чтобы после `sessions.send` в direct/channel-scoped сессиях оператор мог без ручной догадки проследить путь от исходного запроса до финальной closure truth, даже если во время выполнения происходят `compaction`, `semantic_retry`, followup drain или другой continuation path с новым `runId`.

## Why This Next

Stage 25 уже доказал parity для `messaging_delivery` и `runClosure` на прямом delivery path. Следующий реальный runtime gap лежит рядом: при continuation/retry итоговый runtime `runId` может отличаться от исходного `idempotencyKey`, а operator handoff сейчас требует ручной корреляции между `[src/gateway/server-methods/sessions.ts](src/gateway/server-methods/sessions.ts)`, `[src/gateway/server-methods/chat.ts](src/gateway/server-methods/chat.ts)` и runtime ledger в `[src/platform/runtime/service.ts](src/platform/runtime/service.ts)`.

## Likely Scope

- Зафиксировать, какой идентификатор считается canonical для operator handoff: исходный request/idempotency, текущий runtime run, либо явная цепочка между ними.
- Проверить continuation/compaction/retry paths в `[src/auto-reply/reply/followup-runner.ts](src/auto-reply/reply/followup-runner.ts)`, `[src/auto-reply/reply/agent-runner-execution.ts](src/auto-reply/reply/agent-runner-execution.ts)` и closure/recovery logic в `[src/auto-reply/reply/closure-outcome-dispatcher.ts](src/auto-reply/reply/closure-outcome-dispatcher.ts)`.
- Улучшить operator-visible surfaces так, чтобы `sessions.list`, `platform.runtime.closures.*`, `platform.runtime.actions.*`, recovery checkpoints и handoff IDs были согласованы после continuation.
- Добавить deterministic regressions и один живой local smoke на compaction or retry path.

## Primary Files To Leverage

- `[src/gateway/server-methods/sessions.ts](src/gateway/server-methods/sessions.ts)`
- `[src/gateway/server-methods/chat.ts](src/gateway/server-methods/chat.ts)`
- `[src/gateway/session-utils.ts](src/gateway/session-utils.ts)`
- `[src/gateway/session-lifecycle-state.ts](src/gateway/session-lifecycle-state.ts)`
- `[src/platform/runtime/service.ts](src/platform/runtime/service.ts)`
- `[src/platform/runtime/gateway.ts](src/platform/runtime/gateway.ts)`
- `[src/auto-reply/reply/followup-runner.ts](src/auto-reply/reply/followup-runner.ts)`
- `[src/auto-reply/reply/agent-runner-helpers.ts](src/auto-reply/reply/agent-runner-helpers.ts)`
- `[src/auto-reply/reply/closure-outcome-dispatcher.ts](src/auto-reply/reply/closure-outcome-dispatcher.ts)`
- `[docs/help/testing.md](docs/help/testing.md)`
- `[docs/cli/gateway.md](docs/cli/gateway.md)`

## Plan

### 1. Define Canonical Correlation Rules

Уточнить и закрепить один truth-model для Stage 26:

- как `sessions.send` request/idempotency соотносится с embedded `runId`
- когда continuation/followup обязан создавать новый runtime `runId`
- что именно оператор должен использовать для handoff: один canonical `runId`, либо цепочку `requestId -> runId -> actionId`

При необходимости добавить тонкое correlation поле или summary projection, а не новый store.

### 2. Wire Continuation Truth Across Surfaces

Проверить, где continuation path теряет или скрывает связь между исходным запросом и финальным runtime outcome:

- followup queue drain и semantic retry
- compaction notices и compaction-completed path
- closure recovery checkpoints и resumed runs
- session-level `runClosureSummary` vs full runtime closure history

Если связь теряется, минимально расширить runtime/session projection так, чтобы operator surface показывала актуальный финальный run и его связь с исходным запросом.

### 3. Lock In Deterministic Regressions

Добавить focused tests на два класса поведения:

- continuation path, где финальный verified closure создаётся уже не на исходном `idempotencyKey`, а на resumed/retry `runId`
- session/operator inspection path, где по session row и runtime RPC можно без догадки найти правильные `runId` / `actionId` после compaction or retry

Приоритетные опорные тесты:

- `[src/auto-reply/reply/followup-runner.test.ts](src/auto-reply/reply/followup-runner.test.ts)`
- `[src/auto-reply/reply/agent-runner-helpers.test.ts](src/auto-reply/reply/agent-runner-helpers.test.ts)`
- `[src/platform/runtime/service.test.ts](src/platform/runtime/service.test.ts)`
- `[src/platform/runtime/gateway.test.ts](src/platform/runtime/gateway.test.ts)`
- `[src/gateway/session-closure-parity.test.ts](src/gateway/session-closure-parity.test.ts)`
- `[src/gateway/session-recovery-state.test.ts](src/gateway/session-recovery-state.test.ts)`

### 4. Reproduce One Local Continuation Smoke

Повторить local smoke уже не на simple delivery, а на path с `compaction` или `semantic_retry`, и зафиксировать:

- исходный request/idempotency id
- финальный verified runtime `runId`
- хотя бы один `actionId`
- closure/action inspection output, достаточный для handoff

Этот smoke должен доказывать, что continuation не ломает parity и не вынуждает оператора вручную угадывать правильный финальный run.

### 5. Update Runbook And Handoff Guidance

Дополнить `[docs/help/testing.md](docs/help/testing.md)` и при необходимости `[docs/cli/gateway.md](docs/cli/gateway.md)` короткими правилами:

- как искать актуальный финальный `runId` после continuation
- как отличать request id от final runtime run
- какие `platform.runtime.*` вызовы обязательны для handoff после compaction/retry

## Validation Target

- `pnpm build`
- `pnpm test -- <targeted files>` для новых continuation/handoff regressions
- `pnpm test` если затронуты shared runtime/gateway surfaces
- один локально воспроизведённый continuation or compaction smoke с documented handoff IDs

## Exit Criteria

- Для continuation/retry path есть machine-checkable parity между closure truth, action truth и session/operator surfaces.
- Оператор может без ручной корреляции понять, какой `runId` является финальным для handoff.
- Документация фиксирует, какие IDs и какие `platform.runtime.*` inspection calls нужны после continuation.
- Есть один recorded local smoke с continuation/compaction evidence.
