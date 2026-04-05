---
name: Stage 85 Cursor Execution Plan
overview: "Stage 85 не про новый product-only roadmap, а про реальную схему исполнения в Cursor: один главный агент координирует 4 dev-подагента, каждый работает по своему пакету файлов без пересечений, а главный агент потом делает общий integration pass и оставляет тестируемый инкремент."
todos:
  - id: freeze-stage-boundary
    content: Зафиксировать Stage 85 как active execution plan и определить integration-owned файлы главного агента
    status: done
  - id: run-agent-a
    content: Запустить Dev Agent A на platform contracts/profile foundation
    status: done
  - id: run-agent-b
    content: Запустить Dev Agent B на runtime planning/local decision wiring
    status: done
  - id: run-agent-c
    content: Запустить Dev Agent C на capability catalog/bootstrap readiness
    status: done
  - id: run-agent-d
    content: Запустить Dev Agent D на shallow subagent orchestration pack
    status: done
  - id: integration-pass
    content: Главный агент интегрирует shared runtime файлы, правит конфликтующие seams и сводит итоговый UX flow
    status: done
  - id: validation
    content: Прогнать scoped tests и один user-testable flow для Master Orchestrator v0
    status: in_progress
isProject: false
---

# Stage 85 - Cursor Execution Plan

## Зачем этот stage

После `Stage 84` v1 boundary закрыт, но следующий шаг нельзя снова делать как один длинный sequential stage одним агентом.

Из чата и текущего кода видно две важные вещи:

1. Нужен отдельный `execution plan` для разработки в Cursor, а не только архитектурный roadmap продукта.
2. Основа уже частично существует в `src/platform/`: там есть схемы, registry, recipe runtime adapter, bootstrap/catalog surfaces и plugin wiring. Значит Stage 85 должен не изобретать новый фундамент, а аккуратно материализовать его через несколько непересекающихся рабочих пакетов.

## Цель Stage 85

Доставить первый тестируемый инкремент `Master Orchestrator v0`, где:

- главный runtime получает устойчивый `profile + overlay + recipe + capability readiness` контекст;
- дешёвый local-model path может использоваться как control-plane слой, а не как основной reasoner;
- shallow subagent orchestration остаётся ограниченной и не превращается в deep manager tree;
- capability/bootstrap решения проходят через approved catalog;
- главный агент разработки в Cursor реально может раздать работу 4 dev-подагентам без пересечения файлов.

## Что считаем готовым результатом

Пользователь после Stage 85 должен суметь сам протестировать сценарий класса:

1. дать задачу;
2. получить определённые `profile/recipe/readiness` признаки;
3. увидеть, что runtime либо продолжает работу, либо честно требует bootstrap/approval;
4. при необходимости запустить bounded subagent flow;
5. получить понятный итоговый артефакт или closure summary.

## Главный принцип исполнения

`Подагенты` в этом плане - это dev-подагенты Cursor для разработки.

Они не равны продуктовым sub-agents OpenClaw, хотя часть Stage 85 действительно затрагивает продуктовую subagent orchestration логику.

## Ownership model

### Всегда за главным агентом

Главный агент не отдаёт подагентам shared integration surfaces:

- `.cursor/plans/master_v1_roadmap.md`
- `.cursor/plans/stage_85_cursor_execution_4d2f9c10.plan.md`
- `src/platform/plugin.ts`
- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/agent-command.ts`
- cross-surface integration tests, где одновременно встречаются `platform` и `agents`
- финальный свод docs, если в одном документе описываются сразу несколько пакетов Stage 85

Это нужно, чтобы не устроить одновременную запись в самые конфликтные seam-файлы.

## Dev Agent A - Contracts and Profile Pack

### Owned files

- `src/platform/decision/**`
- `src/platform/profile/**`
- `src/platform/schemas/profile.ts`
- `src/platform/schemas/recipe.ts`
- `src/platform/schemas/index.ts`
- unit tests рядом с этими файлами

### Forbidden files

- `src/platform/plugin.ts`
- `src/agents/**`
- `src/platform/bootstrap/**`
- `src/platform/catalog/**`
- `src/platform/runtime/**`
- `docs/tools/subagents.md`
- `docs/concepts/multi-agent.md`

### Expected output

- устойчивые контракты для `intent`, `profile`, `task overlay`, planner input/output;
- чистый deterministic resolver path без скрытых полномочий;
- fixture-friendly test coverage для profile/overlay/decision layer;
- явный список экспортов, который смогут безопасно использовать Agent B и главный агент.

### Exact prompt

```md
You are Dev Agent A working inside the OpenClaw repo.

Goal: harden the platform contracts and profile foundation for Stage 85 so that other agents can build on stable inputs/outputs.

Work only in:
- src/platform/decision/**
- src/platform/profile/**
- src/platform/schemas/profile.ts
- src/platform/schemas/recipe.ts
- src/platform/schemas/index.ts
- tests colocated with those files

Do not edit:
- src/platform/plugin.ts
- any file under src/agents/**
- any file under src/platform/bootstrap/**
- any file under src/platform/catalog/**
- any file under src/platform/runtime/**
- docs/tools/subagents.md
- docs/concepts/multi-agent.md

Requirements:
- keep everything deterministic
- no hidden permissions through profile selection
- prefer small pure helpers over broad refactors
- add or update focused tests only where they materially protect the contracts

Return format:
- changed files
- contract decisions made
- tests run
- risks or open seams for the main agent
```

## Dev Agent B - Runtime Planning and Local Decision Pack

### Owned files

- `src/platform/recipe/**`
- `src/platform/decision/input.ts`
- `src/platform/runtime/**`
- `src/agents/pi-embedded-runner/model.ts`
- `src/agents/pi-embedded-runner/run/params.ts`
- targeted tests for those files

### Forbidden files

- `src/platform/plugin.ts`
- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/agent-command.ts`
- `src/platform/profile/**`
- `src/platform/bootstrap/**`
- `src/agents/subagent*.ts`

### Expected output

- stable runtime plan assembly from planner output into embedded-runner-friendly fields;
- local model path used for cheap control-plane decisions where that seam already exists;
- no duplication of profile logic inside the runner;
- explicit notes for the main agent about any required glue in `run.ts`.

### Exact prompt

```md
You are Dev Agent B working inside the OpenClaw repo.

Goal: materialize runtime planning and local decision wiring for Stage 85 without touching shared integration seams.

Work only in:
- src/platform/recipe/**
- src/platform/decision/input.ts
- src/platform/runtime/**
- src/agents/pi-embedded-runner/model.ts
- src/agents/pi-embedded-runner/run/params.ts
- tests colocated with those files

Do not edit:
- src/platform/plugin.ts
- src/agents/pi-embedded-runner/run.ts
- src/agents/agent-command.ts
- src/platform/profile/**
- src/platform/bootstrap/**
- any src/agents/subagent*.ts file

Requirements:
- keep the local model as control-plane support, not the primary reasoning path
- reuse existing platform execution context instead of re-parsing prompt text downstream
- do not add deep orchestration logic
- prefer focused tests over broad suite churn

Return format:
- changed files
- runtime/planning decisions made
- tests run
- exact integration notes for src/platform/plugin.ts or src/agents/pi-embedded-runner/run.ts
```

## Dev Agent C - Capability Catalog and Bootstrap Pack

### Owned files

- `src/platform/bootstrap/**`
- `src/platform/catalog/**`
- `src/platform/registry/**`
- `src/platform/schemas/capability.ts`
- `src/platform/schemas/artifact.ts`
- targeted tests for those files

### Forbidden files

- `src/platform/plugin.ts`
- `src/agents/**`
- `src/platform/profile/**`
- `src/platform/recipe/**`
- `docs/tools/subagents.md`

### Expected output

- approved capability catalog path instead of arbitrary installs;
- readiness/bootstrap summaries that are machine-readable and user-explainable;
- registry behavior clear enough for the main agent to expose in final flow;
- tests around catalog resolution and bootstrap request handling.

### Exact prompt

```md
You are Dev Agent C working inside the OpenClaw repo.

Goal: harden the capability catalog and bootstrap readiness path for Stage 85 so execution can stay approved, auditable, and explainable.

Work only in:
- src/platform/bootstrap/**
- src/platform/catalog/**
- src/platform/registry/**
- src/platform/schemas/capability.ts
- src/platform/schemas/artifact.ts
- tests colocated with those files

Do not edit:
- src/platform/plugin.ts
- any file under src/agents/**
- src/platform/profile/**
- src/platform/recipe/**
- docs/tools/subagents.md

Requirements:
- approved catalog only; no "install anything" behavior
- preserve deterministic readiness/status reporting
- keep contracts easy for gateway/runtime surfaces to consume
- add focused tests where catalog/bootstrap behavior could regress

Return format:
- changed files
- catalog/bootstrap decisions made
- tests run
- unresolved integration notes for the main agent
```

## Dev Agent D - Shallow Subagent Orchestration Pack

### Owned files

- `src/agents/subagent-spawn.ts`
- `src/agents/subagent-depth.ts`
- `src/agents/subagent-control.ts`
- `src/agents/subagent-announce.ts`
- `src/agents/subagent-registry*.ts`
- `src/agents/tools/subagents-tool.ts`
- `docs/tools/subagents.md`
- `docs/concepts/multi-agent.md`
- targeted tests for the above files

### Forbidden files

- `src/platform/**`
- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/pi-embedded-runner/model.ts`
- `src/agents/agent-command.ts`

### Expected output

- shallow orchestration policy aligned with repo guardrails;
- explicit worker/orchestrator boundaries for depth 1 and depth 2;
- no drift toward heavy manager-of-managers architecture;
- updated docs that describe bounded orchestration and operator-facing limits.

### Exact prompt

```md
You are Dev Agent D working inside the OpenClaw repo.

Goal: tighten the shallow subagent orchestration pack for Stage 85 while preserving the repo rule against heavy nested manager architectures.

Work only in:
- src/agents/subagent-spawn.ts
- src/agents/subagent-depth.ts
- src/agents/subagent-control.ts
- src/agents/subagent-announce.ts
- src/agents/subagent-registry*.ts
- src/agents/tools/subagents-tool.ts
- docs/tools/subagents.md
- docs/concepts/multi-agent.md
- tests colocated with those files

Do not edit:
- any file under src/platform/**
- src/agents/pi-embedded-runner/run.ts
- src/agents/pi-embedded-runner/model.ts
- src/agents/agent-command.ts

Requirements:
- support shallow orchestration only
- preserve bounded depth, child limits, and clear announce behavior
- do not introduce a default deep planner tree
- update docs only for the behavior you actually changed

Return format:
- changed files
- orchestration decisions made
- tests run
- final guardrails the main agent must preserve during integration
```

## Порядок запуска

### Wave 0 - делает главный агент

1. Подтверждает active stage и фиксирует этот plan.
2. Резервирует shared files за собой.
3. Проверяет, что у каждого подагента непересекающийся `Owned files` список.

### Wave 1 - сначала Agent A

Agent A идёт первым, потому что остальные пакеты опираются на profile/decision contracts и не должны сами придумывать shape данных.

### Wave 2 - затем параллельно Agents B, C, D

Когда Agent A вернул стабильные контракты, главный агент запускает сразу три параллельных ветки:

- Agent B - runtime planning/local decision pack
- Agent C - capability/bootstrap pack
- Agent D - shallow orchestration pack

### Wave 3 - integration pass главного агента

Только после возврата всех трёх результатов главный агент трогает:

- `src/platform/plugin.ts`
- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/agent-command.ts`
- общие integration tests
- при необходимости один итоговый doc section, где нужно свести больше одного workstream

## Как главный агент сводит результат

Главный агент обязан принимать результат подагента только в одном формате:

- `Changed files`
- `What is done`
- `Tests run`
- `Known risks`
- `Integration notes`

После каждого возврата главный агент:

1. сверяет, не затронуты ли forbidden files;
2. проверяет, не сломан ли ownership boundary;
3. только потом переносит пакет в общую интеграцию.

Если подагент залез в shared file, пакет не мержится автоматически и возвращается на переработку.

## Что главный агент не должен делегировать

- финальный выбор integration shape в `src/platform/plugin.ts`
- glue-код внутри `src/agents/pi-embedded-runner/run.ts`
- изменения в `src/agents/agent-command.ts`
- финальную user-test story
- общий validation pass

## Validation ladder

Минимальный обязательный порядок проверки после integration pass:

1. scoped unit tests для каждого workstream-пакета;
2. scoped integration tests вокруг `src/platform/plugin.ts` и runtime wiring;
3. один ручной self-test сценарий `Master Orchestrator v0` с локальной моделью;
4. только после этого решение, нужен ли более широкий `pnpm test`.

## Чего Stage 85 специально не делает

- не строит deep agent hierarchy;
- не превращает local model в основной reasoning engine;
- не вводит произвольную установку capability из интернета;
- не отдаёт shared runtime seams нескольким подагентам одновременно;
- не смешивает dev-подагентов Cursor с продуктовой терминологией sub-agents без явного пояснения.

## Выход Stage 85

Результатом этого stage должен стать не просто новый markdown-файл, а рабочий режим разработки:

- главный агент знает, кого и в каком порядке запускать;
- каждый dev-подагент получает точный prompt и файловые границы;
- интеграция остаётся централизованной;
- после завершения есть тестируемый инкремент, который пользователь может прогнать сам.
