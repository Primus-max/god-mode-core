---
name: stage 7f decision
overview: "Собрать следующий этап вокруг единого decision engine: убрать расхождения между profile/recipe/runtime hooks, сделать capability-aware execution path и усилить explainability без ухода в поздний UI polish."
todos:
  - id: decision-input-unification
    content: Спроектировать единый builder входного decision context для runtime и gateway paths
    status: completed
  - id: decision-object-introduce
    content: Ввести first-class execution decision object с profile/overlay/recipe/runtime/explainability полями
    status: completed
  - id: decision-hooks-alignment
    content: Убрать расхождения между agent-command и platform hooks за счёт общего resolved context
    status: completed
  - id: decision-capability-awareness
    content: Связать planner, policy и bootstrap через capability-aware execution prerequisites
    status: completed
  - id: decision-regression-matrix
    content: Добавить decision-level explainability и regression scenarios для ключевых routing cases
    status: completed
isProject: false
---

# Stage 7F: Unified Decision Engine

## Goal

Сделать один источник правды для execution decision: specialist/profile, task overlay, recipe, policy и capability/bootstrap должны собираться в единый объект решения и одинаково использоваться в рантайме, gateway и explainability.

## Current Anchors

- Основной runtime bridge сейчас проходит через [src/platform/recipe/runtime-adapter.ts](src/platform/recipe/runtime-adapter.ts) и [src/platform/recipe/planner.ts](src/platform/recipe/planner.ts).
- Specialist resolution и overrides уже живут в [src/platform/profile/resolver.ts](src/platform/profile/resolver.ts), [src/platform/profile/session-overrides.ts](src/platform/profile/session-overrides.ts), [src/platform/profile/gateway.ts](src/platform/profile/gateway.ts).
- Platform policy и bootstrap уже существуют, но используют частично отдельные контексты: [src/platform/policy/engine.ts](src/platform/policy/engine.ts), [src/platform/bootstrap/runtime.ts](src/platform/bootstrap/runtime.ts), [src/platform/bootstrap/service.ts](src/platform/bootstrap/service.ts).
- Platform hooks всё ещё местами пересчитывают решение локально в [src/platform/plugin.ts](src/platform/plugin.ts), что создаёт риск расхождений с основным run path.

## Desired Outcome

- Один явный decision object для run-level execution.
- Один и тот же resolved context в agent-command, plugin hooks, policy checks и gateway specialist snapshot.
- Явная capability-aware стадия: recipe знает prerequisites, policy понимает bootstrap intent, explainability показывает не только итог, но и причины выбора.
- Regression harness на decision scenarios, чтобы дальше можно было безопасно развивать routing.

## Workstreams

### 1. Normalize Decision Input

Свести входные данные к одному builder слою, который собирает `prompt`, session overrides, transcript-derived context, file/artifact hints и возвращает единый `RecipePlannerInput` или его расширенный successor.

Основные файлы:

- [src/agents/agent-command.ts](src/agents/agent-command.ts)
- [src/platform/profile/gateway.ts](src/platform/profile/gateway.ts)
- [src/platform/profile/session-overrides.ts](src/platform/profile/session-overrides.ts)
- [src/gateway/session-entry.ts](src/gateway/session-entry.ts)

### 2. Introduce First-Class Execution Decision

Поверх planner/runtime-adapter ввести единый объект решения, который включает:

- resolved profile
- active overlay
- selected recipe
- runtime overrides
- structured reasoning
- capability requirements / execution prerequisites
- policy-facing summary

Основные файлы:

- [src/platform/recipe/planner.ts](src/platform/recipe/planner.ts)
- [src/platform/recipe/runtime-adapter.ts](src/platform/recipe/runtime-adapter.ts)
- [src/platform/schemas/recipe.ts](src/platform/schemas/recipe.ts)
- [src/platform/profile/contracts.ts](src/platform/profile/contracts.ts)

### 3. Remove Re-Planning Drift In Hooks

Убрать prompt-only re-resolution в platform hooks там, где уже доступен resolved execution context из основного run path. Оставить fallback только для truly standalone paths.

Основные файлы:

- [src/platform/plugin.ts](src/platform/plugin.ts)
- [src/agents/pi-embedded-runner/run.ts](src/agents/pi-embedded-runner/run.ts)
- [src/plugins/types.ts](src/plugins/types.ts)

### 4. Make Planning Capability-Aware

Связать recipe selection с capability prerequisites и bootstrap intent так, чтобы decision engine мог:

- понять, что capability уже available
- понять, что нужен bootstrap
- понять, что нужен fallback path
- отдать policy/bootstrap слой уже с согласованным context

Основные файлы:

- [src/platform/bootstrap/resolver.ts](src/platform/bootstrap/resolver.ts)
- [src/platform/bootstrap/runtime.ts](src/platform/bootstrap/runtime.ts)
- [src/platform/bootstrap/service.ts](src/platform/bootstrap/service.ts)
- [src/platform/policy/engine.ts](src/platform/policy/engine.ts)
- [src/platform/SEAMS.md](src/platform/SEAMS.md)

### 5. Expand Explainability And Regression Coverage

Добавить decision-level explainability и контрактные сценарии, которые фиксируют:

- expected profile
- expected overlay
- expected recipe
- expected policy posture
- expected bootstrap requirement or absence thereof

Основные файлы:

- [src/platform/profile/gateway.test.ts](src/platform/profile/gateway.test.ts)
- [src/platform/profile/resolver.test.ts](src/platform/profile/resolver.test.ts)
- [src/platform/recipe/planner.test.ts](src/platform/recipe/planner.test.ts)
- [src/platform/policy/engine.test.ts](src/platform/policy/engine.test.ts)
- [src/platform/recipe/runtime-adapter.test.ts](src/platform/recipe/runtime-adapter.test.ts)

## Sequencing

1. Сначала нормализовать unified decision input и execution decision object.
2. Затем переключить runtime/hooks на использование уже resolved context.
3. После этого встроить capability/bootstrap awareness в тот же decision pipeline.
4. В конце расширить explainability snapshots и scenario-based regression tests.

## Guardrails

- Не раздувать UI scope: UI только потребляет richer decision snapshot, но не становится центром этапа.
- Не смешивать platform policy с unrelated infra policies; связывать только через согласованный context.
- Не плодить второй planner path: любой новый decision API должен становиться canonical path, а не параллельной веткой.

## Validation Target

Минимальный landing bar для этапа:

- `pnpm tsgo`
- `pnpm build`
- целевые platform/profile/recipe/policy/bootstrap тесты
- финальный `pnpm test`
