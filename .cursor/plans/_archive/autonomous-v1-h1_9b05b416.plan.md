---
name: autonomous-v1-h1
overview: Проверить и выровнять planning truth для autonomous v1, затем итерационно довести весь Horizon 1 до состояния implemented + validated + реально протестировано через запущенный проект, UI и бота.
todos:
  - id: audit-sync-plans
    content: Сверить и исправить рассинхрон между loop/stage/backlog/roadmap статусами и stop conditions
    status: completed
  - id: close-stage86
    content: Закрыть Stage 86 по всем slice с автоматическими и живыми проверками
    status: completed
  - id: deliver-h1-docflows
    content: "Довести Horizon 1 вне Stage 86: compare/report/calculation/builder context"
    status: completed
  - id: full-live-regression
    content: Прогнать полный deterministic и прямой E2E/live regression на запущенном проекте
    status: completed
isProject: false
---

# Horizon 1 Audit And Delivery Plan

## Что уже подтверждено

- Из `autonomous_v1_loop_a69b9e98.plan.md` уже материализованы почти все целевые артефакты: `[ .cursor/plans/autonomous_v1_active_backlog.md ](.cursor/plans/autonomous_v1_active_backlog.md)`, `[ .cursor/plans/stage_86_smart_routing_bootstrap.plan.md ](.cursor/plans/stage_86_smart_routing_bootstrap.plan.md)`, `[ .cursor/plans/multi_agent_execution_protocol.md ](.cursor/plans/multi_agent_execution_protocol.md)`, `[ .cursor/plans/stage_plan_template.md ](.cursor/plans/stage_plan_template.md)`, ссылки в `[ .cursor/plans/master_v1_roadmap.md ](.cursor/plans/master_v1_roadmap.md)`.
- В коде уже есть существенная база для Stage 86: smart routing/preflight/fallback в `[src/agents/model-fallback.ts](src/agents/model-fallback.ts)` и `[src/platform/decision/route-preflight.ts](src/platform/decision/route-preflight.ts)`, prompt optimization в `[src/agents/pi-embedded-runner/run/attempt.ts](src/agents/pi-embedded-runner/run/attempt.ts)`, bootstrap approve-resume в `[src/platform/bootstrap/service.ts](src/platform/bootstrap/service.ts)`, runtime/usage visibility в `[ui/src/ui/views/sessions.ts](ui/src/ui/views/sessions.ts)` и `[ui/src/ui/views/bootstrap.ts](ui/src/ui/views/bootstrap.ts)`.
- Для Horizon 1 вне Stage 86 уже есть заготовки document/table/report pipeline в `[src/platform/recipe/defaults.ts](src/platform/recipe/defaults.ts)`, `[src/platform/recipe/planner.ts](src/platform/recipe/planner.ts)`, `[src/platform/document/materialize.ts](src/platform/document/materialize.ts)`, `[src/platform/materialization/render.ts](src/platform/materialization/render.ts)`, `[src/agents/tools/pdf-tool.ts](src/agents/tools/pdf-tool.ts)`, а профиль `builder` уже существует в `[src/platform/profile/defaults.ts](src/platform/profile/defaults.ts)`.

## Что сделано плохо или неполно

- Плановые статусы рассинхронизированы: `loop` и `stage_86` frontmatter всё ещё `pending`, тогда как backlog уже ведётся как реальный operational source. Это надо исправить первым, иначе автономный цикл будет опираться на противоречивую truth.
- `autonomous_v1_roadmap` шире текущего active backlog: Stage 86 оформлен как очередь, но Horizon 1 части про CSV/Excel compare, structured calculation/reporting и builder-context не превращены в operational slices.
- Есть дрейф между manual acceptance и UI-контрактом: `stage86_test_cases.md` ожидает `modelRouteTier` и planning/routing context в Sessions, а фактически ключевой route-tier сейчас читается через bootstrap/runtime surfaces. Нужно либо привести UI к чеклисту, либо осознанно обновить чеклист.
- Самая слабая часть Horizon 1 сейчас не PDF, а именно детерминированный table-compare и builder/project-designer lightweight context: в репо есть общие document flows, но нет явного завершённого user-facing compare pipeline и нет доменного prompt preset уровня SNiP/norms/formulas, как обещано roadmap.

## План исполнения

## Phase 1: Normalize planning truth

- Привести `[ .cursor/plans/autonomous_v1_loop_a69b9e98.plan.md ](.cursor/plans/autonomous_v1_loop_a69b9e98.plan.md)`, `[ .cursor/plans/stage_86_smart_routing_bootstrap.plan.md ](.cursor/plans/stage_86_smart_routing_bootstrap.plan.md)`, `[ .cursor/plans/autonomous_v1_active_backlog.md ](.cursor/plans/autonomous_v1_active_backlog.md)`, `[ .cursor/plans/autonomous_v1_roadmap_cb6fe0e6.plan.md ](.cursor/plans/autonomous_v1_roadmap_cb6fe0e6.plan.md)` к одной truth-модели статусов, validation tiers и stop conditions.
- Зафиксировать, что backlog является единственным источником следующего slice, а roadmap задаёт только продуктовую границу.
- Добавить operational slices для Horizon 1 после Stage 86 вместо narrative-only описания Slice B/C.

## Phase 2: Close Stage 86 completely

- Идти по S86-01…S86-06 из `[ .cursor/plans/autonomous_v1_active_backlog.md ](.cursor/plans/autonomous_v1_active_backlog.md)` итерациями `explore -> implement -> verify -> continue` с подагентами по непересекающимся file packs.
- Сначала добить рассинхроны между acceptance и кодом по routing visibility, bootstrap resume, Sessions/runtime inspector и usage/cost surfaces.
- Затем прогнать живой Stage 86 protocol из `[ .cursor/stage86_test_cases.md ](.cursor/stage86_test_cases.md)`: запуск проекта, gateway/UI, реальные сообщения боту, проверка логов, проверка resume/fallback/usage/runtime inspector, Telegram E2E и 15-минутная стабильность.

## Phase 3: Deliver the rest of Horizon 1

- На базе существующих seams в `[src/platform/document/materialize.ts](src/platform/document/materialize.ts)`, `[src/platform/materialization/render.ts](src/platform/materialization/render.ts)`, `[src/platform/recipe/planner.ts](src/platform/recipe/planner.ts)`, `[src/platform/profile/defaults.ts](src/platform/profile/defaults.ts)` довести до user-facing состояния:
- сравнение двух CSV/Excel с нормализованным ranked summary;
- structured calculation/report flow с assumptions/units;
- clean markdown/PDF report output для demo-сценариев;
- lightweight builder/project-designer context preset без тяжёлой инфраструктуры.
- Для этой части сразу добавить deterministic regressions рядом с touched seams, чтобы live smoke не был единственным доказательством.

## Phase 4: Full validation and real usage test

- Обязательный automated ladder по мере изменений: focused tests, затем `pnpm check`, `pnpm build`, `pnpm test`, `pnpm test:e2e:smoke`, и `pnpm test:v1-gate` перед финальным объявлением готовности.
- После зелёных automated gates поднять реальный проект и провести прямой прогон: самому отправить боту сообщения по всем investor-v1 сценариям из roadmap и Stage 86, проверить ответы, маршрутизацию, resume, файлы/артефакты, UI inspector, usage, Telegram.
- Если живой прогон находит расхождение, цикл возвращается в implement/fix/verify до полного прохождения.

## Правила выполнения

- Подагенты использовать в каждой крупной итерации: exploration, isolated implementation, verification. Главный агент держит shared seams, итоговую интеграцию и backlog updates.
- Не останавливать цикл после маленького зелёного патча, пока не закрыт текущий open slice с обязательными automated и live proof.
- Остановиться только если понадобится внешний ручной шаг вне уже доступной среды, обнаружится конфликт между roadmap и acceptance, или обязательный validation tier не удастся сделать зелёным без несогласованного расширения scope.

## Ключевые файлы первого прохода

- Планирование: `[ .cursor/plans/autonomous_v1_loop_a69b9e98.plan.md ](.cursor/plans/autonomous_v1_loop_a69b9e98.plan.md)`, `[ .cursor/plans/autonomous_v1_roadmap_cb6fe0e6.plan.md ](.cursor/plans/autonomous_v1_roadmap_cb6fe0e6.plan.md)`, `[ .cursor/plans/autonomous_v1_active_backlog.md ](.cursor/plans/autonomous_v1_active_backlog.md)`, `[ .cursor/plans/stage_86_smart_routing_bootstrap.plan.md ](.cursor/plans/stage_86_smart_routing_bootstrap.plan.md)`, `[ .cursor/stage86_test_cases.md ](.cursor/stage86_test_cases.md)`.
- Routing/bootstrap/UI: `[src/agents/model-fallback.ts](src/agents/model-fallback.ts)`, `[src/platform/decision/route-preflight.ts](src/platform/decision/route-preflight.ts)`, `[src/platform/bootstrap/service.ts](src/platform/bootstrap/service.ts)`, `[ui/src/ui/views/bootstrap.ts](ui/src/ui/views/bootstrap.ts)`, `[ui/src/ui/views/sessions.ts](ui/src/ui/views/sessions.ts)`.
- Horizon 1 doc/report/context: `[src/platform/recipe/defaults.ts](src/platform/recipe/defaults.ts)`, `[src/platform/recipe/planner.ts](src/platform/recipe/planner.ts)`, `[src/platform/document/materialize.ts](src/platform/document/materialize.ts)`, `[src/platform/materialization/render.ts](src/platform/materialization/render.ts)`, `[src/platform/profile/defaults.ts](src/platform/profile/defaults.ts)`, `[src/agents/tools/pdf-tool.ts](src/agents/tools/pdf-tool.ts)`.
