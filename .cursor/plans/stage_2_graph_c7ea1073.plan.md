---
name: Stage 2 Graph
overview: Ввести execution graph как registry recipes, а не набор жёстко зашитых веток.
todos:
  - id: define-recipe-schema
    content: Зафиксировать schema execution recipe descriptor.
    status: completed
  - id: implement-recipe-registry-design
    content: Описать registry resolution flow и adapter boundaries.
    status: completed
  - id: wire-orchestration-runtime
    content: Подключить recipe/planner к agent/runner path и зарегистрировать platform plugin(s) в bundled metadata/loader (включая carryover Stage 1 `platform-profile-foundation`, если ещё не в metadata).
    status: completed
  - id: define-stage2-regression-tests
    content: Подготовить набор regression/protocol тестов для recipe routing.
    status: completed
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
- **Orchestration wiring:** не только модули в `src/platform`, а явная связка с реальным пайплайном — от entry (`agent` / `agent-command`) через embedded runner до hooks, плюс регистрация bundled plugin так, чтобы resolver/recipe/policy реально исполнялись в рантайме (см. `src/platform/SEAMS.md`).

## Target Areas

- `src/commands/agent.ts` — точка входа CLI agent.
- `src/agents/agent-command.ts` — подготовка исполнения, куда можно пробросить planner output и контекст recipe до `runAgentAttempt`.
- `src/agents/pi-embedded-runner/run.ts` — цикл hooks → model resolve; сюда же ляжет выбор recipe и адаптер к runtime.
- `src/agents/model-fallback.ts` — сохранить согласованность fallback с выбранным recipe/model hints.
- `src/plugins/loader.ts` + `scripts/generate-bundled-plugin-metadata.mjs` → `src/plugins/bundled-plugin-metadata.generated.ts` — discovery и загрузка bundled plugins (в т.ч. `src/platform/plugin.ts` и будущий recipe/planner plugin).
- New registry/planner modules in `src/platform/` (рядом с уже существующими registry/schemas).

## Deliverables

- Recipe descriptor format.
- Registry resolver.
- Planner-to-recipe adapter.
- **Wiring deliverable:** platform plugin(s) перечислены в bundled metadata и вызываются на живом пути; planner/recipe контекст доходит до runner (через существующие hooks `before_agent_start` / `before_model_resolve` / `before_prompt_build` или расширение контракта, если понадобится — без ломания совместимости).

## Tests

- Unit tests на recipe resolution.
- Integration tests planner -> recipe -> runtime adapter.
- Regression tests, что existing fallback path не сломан.
- Protocol tests через gateway ingress.
- **Wiring tests:** минимум один тест, что bundled plugin с platform/recipe hooks реально попадает в загрузку (или что hook-цепочка на agent path получает ожидаемый контекст) — чтобы не повторить разрыв Stage 1 (код есть, registration в orchestration — нет).

## Done When

- Система выбирает recipe, а не только provider/model.
- Новый recipe можно добавить без переписывания orchestration core.
- **Проводка закрыта:** выбор recipe и Stage 1 profile/policy не только в юнитах, а в том же runtime path, что и обычный agent run (bundled plugin + agent-command/runner).
