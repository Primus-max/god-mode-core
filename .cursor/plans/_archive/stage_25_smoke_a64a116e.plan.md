---
name: stage 25 smoke
overview: Следующий крупный этап после Stage 24 — локальный end-to-end smoke для проверки, что delivery truth, closure truth и operator/runtime surfaces совпадают уже не только в targeted тестах, но и в полном runtime-сценарии с реальным gateway lifecycle.
todos:
  - id: define-smoke-contract
    content: Зафиксировать acceptance criteria и smoke-сценарии для delivery/recovery parity
    status: completed
  - id: wire-local-smoke-flow
    content: Определить и при необходимости автоматизировать один воспроизводимый local smoke workflow
    status: completed
  - id: close-inspection-gaps
    content: Добавить только минимально необходимые inspection/runtime seams для уверенной сверки truth
    status: completed
  - id: document-deploy-handoff
    content: Обновить repo guidance и подготовить handoff к ограниченному внутреннему прогону
    status: completed
isProject: false
---

# Stage 25: Local End-to-End Recovery Smoke

## Goal

Проверить на локальном runtime, что после Stage 24 `messaging_delivery`, `runClosureSummary`, followup/recovery поведение и operator inspection surfaces остаются согласованными в реальном сценарии send -> confirm/fail -> restart/recovery -> inspect.

## Why This Next

В `[.cursor/plans/stage_24_delivery_parity_b2ffa2ea.plan.md](.cursor/plans/stage_24_delivery_parity_b2ffa2ea.plan.md)` Stage 24 прямо обозначен как последний большой backend reliability этап перед локальным smoke и первым ограниченным внутренним deploy. Теперь нужно доказать не только unit/test parity, но и runtime parity на полном пути.

## Likely Scope

- Зафиксировать smoke acceptance criteria вокруг `staged`, `attempted`, `confirmed`, `failed`, `partial`, `recovered`, `closed`.
- Собрать один воспроизводимый local smoke workflow на базе существующих gateway/runtime/CLI surfaces.
- При необходимости добавить минимальные inspection seams, если текущих runtime/operator surfaces недостаточно для уверенной сверки delivery и closure truth.
- Задокументировать handoff к ограниченному внутреннему прогону.

## Primary Files To Leverage

- `[.cursor/plans/stage_24_delivery_parity_b2ffa2ea.plan.md](.cursor/plans/stage_24_delivery_parity_b2ffa2ea.plan.md)`
- `[docs/help/testing.md](docs/help/testing.md)`
- `[src/infra/outbound/deliver.ts](src/infra/outbound/deliver.ts)`
- `[src/auto-reply/dispatch.ts](src/auto-reply/dispatch.ts)`
- `[src/auto-reply/reply/followup-runner.ts](src/auto-reply/reply/followup-runner.ts)`
- `[src/auto-reply/reply/agent-runner-helpers.ts](src/auto-reply/reply/agent-runner-helpers.ts)`
- `[src/platform/runtime/service.ts](src/platform/runtime/service.ts)`
- `[src/platform/runtime/gateway.ts](src/platform/runtime/gateway.ts)`
- `[test/gateway.multi.e2e.test.ts](test/gateway.multi.e2e.test.ts)`

## Plan

### 1. Define The Smoke Contract

Собрать явный checklist для smoke: какие события считаются успехом, что именно сравниваем между delivery action truth и closure truth, какие сценарии обязательны.

Базовый набор сценариев:

- успешная доставка и корректное `closed/delivered`
- частичная или retryable доставка
- failure path с понятным `failed`/`partial` outcome
- restart/recovery path, где итоговая closure truth после восстановления не расходится с durable delivery evidence

### 2. Build One Reproducible Local Smoke Flow

Определить один основной workflow вместо набора разрозненных ручных шагов. Опора:

- `pnpm build`
- `pnpm check`
- `pnpm test`
- при необходимости `pnpm test:e2e`
- локальный gateway/CLI smoke через существующие surfaces из `[docs/help/testing.md](docs/help/testing.md)` и CLI-доков

Если текущих команд достаточно, оформить runbook. Если нет, добавить тонкий harness/script поверх существующих surfaces, а не новый параллельный runtime path.

### 3. Close Inspection Gaps Minimally

Во время подготовки smoke проверить, хватает ли текущих inspection surfaces, чтобы без ручной догадки увидеть:

- какой `messaging_delivery` action соответствует конкретному closure outcome
- где видно `partial` vs `failed` vs `recovered`
- как сравнить pre-restart и post-restart truth

Если видимость неполная, внести минимальные изменения в `[src/platform/runtime/service.ts](src/platform/runtime/service.ts)`, `[src/platform/runtime/gateway.ts](src/platform/runtime/gateway.ts)` или соседние inspection surfaces, не создавая новый store или отдельную truth-модель.

### 4. Lock The Smoke Into Repo Guidance

Завершить этап обновлением developer-facing инструкции: где запускать smoke, в каком порядке, какие артефакты/логи смотреть, и какой минимальный бар нужен перед limited internal deploy.

## Validation Target

- `pnpm build`
- `pnpm check`
- `pnpm test`
- `pnpm test:e2e` при затрагивании gateway/runtime orchestration
- один локально воспроизведённый recovery smoke сценарий с documented evidence

## Exit Criteria

- Есть один воспроизводимый local smoke workflow для delivery/recovery parity.
- По smoke видно, что delivery action truth и closure truth совпадают в success и recovery/failure сценариях.
- Нужные inspection surfaces позволяют это доказать без ручной корреляции по косвенным признакам.
- Есть короткий handoff к следующему этапу: limited internal deploy/manual run.
