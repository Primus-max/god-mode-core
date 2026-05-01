---
name: Stage 0 Baseline
overview: Зафиксировать исполнимую архитектурную базу для первой волны без кодинга всего продукта сразу.
todos:
  - id: define-core-seams
    content: Определить extension seams в agent/gateway runtime.
    status: pending
  - id: write-contract-schemas
    content: Зафиксировать схемы profiles, recipes, capabilities и artifacts.
    status: pending
  - id: define-stage0-tests
    content: Определить schema и contract test suite для первой волны.
    status: pending
isProject: false
---

# Stage 0: Architecture Baseline

## Goal

Подготовить минимальную техническую основу для последующих этапов: схемы, seams и тестовые границы.

## Scope

- Описать `profile schema`, `execution recipe schema`, `capability descriptor`, `artifact descriptor`.
- Выделить точки расширения поверх [C:/Users/Tanya/source/repos/god-mode-core/src/commands/agent.ts](C:/Users/Tanya/source/repos/god-mode-core/src/commands/agent.ts) и [C:/Users/Tanya/source/repos/god-mode-core/src/agents/pi-embedded-runner/run.ts](C:/Users/Tanya/source/repos/god-mode-core/src/agents/pi-embedded-runner/run.ts).
- Решить, что остаётся в ядре, а что выносится в platform layer.

## Deliverables

- Отдельные contract docs для profiles, recipes, capabilities, artifacts.
- Карта extension seams.
- Список файлов первой волны реализации.

## Tests

- Schema validation tests.
- Contract tests для registry contracts.
- Snapshot tests для базовых descriptors.

## Done When

- Можно начинать Этап 1 без архитектурной двусмысленности.
- Понятно, какие изменения пойдут в core, а какие в extensions.
