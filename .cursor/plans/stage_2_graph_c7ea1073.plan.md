---
name: Stage 2 Graph
overview: Ввести execution graph как registry recipes, а не набор жёстко зашитых веток.
todos:
  - id: define-recipe-schema
    content: Зафиксировать schema execution recipe descriptor.
    status: pending
  - id: implement-recipe-registry-design
    content: Описать registry resolution flow и adapter boundaries.
    status: pending
  - id: define-stage2-regression-tests
    content: Подготовить набор regression/protocol тестов для recipe routing.
    status: pending
isProject: false
---

# Stage 2: Execution Graph Foundation

## Goal

Перевести routing с уровня выбора модели на уровень выбора execution recipe.

## Scope

- Ввести `recipe registry`.
- Зафиксировать planner output schema.
- Подключить первые recipes: `general_reasoning`, `doc_ingest`, `code_build_publish`.
- Оставить совместимость с текущим agent path.

## Target Areas

- [C:/Users/Tanya/source/repos/god-mode-core/src/commands/agent.ts](C:/Users/Tanya/source/repos/god-mode-core/src/commands/agent.ts)
- [C:/Users/Tanya/source/repos/god-mode-core/src/agents/model-fallback.ts](C:/Users/Tanya/source/repos/god-mode-core/src/agents/model-fallback.ts)
- new registry/planner modules in platform layer

## Deliverables

- Recipe descriptor format.
- Registry resolver.
- Planner-to-recipe adapter.

## Tests

- Unit tests на recipe resolution.
- Integration tests planner -> recipe -> runtime adapter.
- Regression tests, что existing fallback path не сломан.
- Protocol tests через gateway ingress.

## Done When

- Система выбирает recipe, а не только provider/model.
- Новый recipe можно добавить без переписывания orchestration core.
