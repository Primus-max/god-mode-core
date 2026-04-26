---
name: stage 80 e2e gate
overview: "Перевести текущий v1 validation gate из mostly-jsdom уровня в настоящий release-confidence baseline: зафиксировать минимальный deterministic E2E smoke, прогоняемый тем же repo workflow и CI, чтобы после navigation stabilization можно было честно переходить в фазу тестирования и наращивания."
todos:
  - id: define-e2e-smoke-baseline
    content: Выделить минимальный deterministic E2E smoke baseline на базе текущего vitest.e2e/harness и при необходимости добавить один недостающий release-relevant smoke case.
    status: completed
  - id: wire-e2e-into-ci
    content: Подключить cheap E2E smoke в основной CI/release workflow так, чтобы deterministic end-to-end слой стал частью реального confidence gate.
    status: completed
  - id: align-release-testing-docs
    content: Выровнять package scripts и testing docs с фактическим release gate, чётко разделив обязательный deterministic smoke и optional heavier layers.
    status: completed
isProject: false
---

# Stage 80 - Release Confidence E2E Gate

## Why This Stage

После Stage 79 Control UI уже получил хороший jsdom-level navigation gate, но релизная уверенность всё ещё слабее, чем должна быть для богатой v1: `pnpm test:e2e` существует, однако основной CI в [C:\Users\Tanya\source\repos\god-mode-coregithub\workflows\ci.yml](C:\Users\Tanya\source\repos\god-mode-core.github\workflows\ci.yml) по факту крутит `pnpm test`, `test:extensions`, `test:channels`, `test:contracts` и смежные lane’ы, а deterministic E2E smoke не выглядит частью обязательного PR gate.

При этом testing docs уже сами формулируют E2E как важный слой между unit и live в [C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md](C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md), а `package.json` уже содержит `test:e2e` и даже `test:all`. Значит следующий сильный шаг не придумывать ещё один локальный UI stage, а выровнять реальный release contract между docs, scripts и CI.

## Goal

Сделать минимальный deterministic E2E smoke обязательной и понятной частью release-confidence gate, чтобы переход от «строим фундамент» к «тестируем и наращиваем» был подтверждён реальным pipeline, а не только jsdom/unit регрессиями.

## Scope

### 1. Define A Cheap Mandatory E2E Baseline

Определить маленький, устойчивый, CI-дружелюбный E2E baseline на базе уже существующего [C:\Users\Tanya\source\repos\god-mode-core\vitest.e2e.config.ts](C:\Users\Tanya\source\repos\god-mode-core\vitest.e2e.config.ts) и текущих harness-паттернов вроде [C:\Users\Tanya\source\repos\god-mode-core\test\gateway.multi.e2e.test.ts](C:\Users\Tanya\source\repos\god-mode-core\test\gateway.multi.e2e.test.ts).

Идея stage не в том, чтобы тащить весь `test:all` в каждый PR, а в том, чтобы зафиксировать минимальный release-relevant smoke:

- gateway boot / connect path
- хотя бы один real end-to-end request/response или routing flow
- без реальных ключей, без live providers, без тяжёлых host-only зависимостей

Если существующих E2E уже достаточно, stage может ограничиться выделением и документированием минимального subset. Если нет, добавить один недостающий deterministic smoke поверх текущего e2e-harness вместо большого нового тестового фреймворка.

### 2. Make CI Match The Intended Release Story

Обновить [C:\Users\Tanya\source\repos\god-mode-coregithub\workflows\ci.yml](C:\Users\Tanya\source\repos\god-mode-core.github\workflows\ci.yml), чтобы deterministic E2E больше не оставался только локальной/ручной рекомендацией.

Возможные рамки внутри stage:

- отдельный cheap `e2e-smoke` job или lane
- запуск только на нужных событиях/изменениях, если полный always-on слишком дорог
- reuse существующего cache/setup path и без раздувания pipeline до live/VM уровня

Ключевая цель: сделать так, чтобы PR/release confidence опирался не только на `pnpm test`, а ещё и на один реальный end-to-end слой.

### 3. Align Scripts And Docs With The Actual Gate

Подтянуть [C:\Users\Tanya\source\repos\god-mode-core\package.json](C:\Users\Tanya\source\repos\god-mode-core\package.json) и [C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md](C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md), чтобы они ясно отвечали на три вопроса:

- что является обязательным cheap gate для PR и release confidence
- где заканчивается deterministic CI-safe smoke и начинаются optional/heavier layers (`live`, Docker-heavy, VM smoke)
- какие команды должен гонять maintainer перед реальным v1 push

Если окажется полезным, можно ввести явный lightweight alias вроде `test:release:smoke` или аналогичный wrapper, но только если это реально упрощает операционный путь, а не плодит ещё одну абстракцию поверх `test`, `test:e2e`, `test:live`.

## Key Evidence

- [C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md](C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md) уже описывает `Navigation validation gate`, `E2E (gateway smoke)`, и отдельно `Agent reliability evals (skills)`, то есть repo сам подсказывает, что следующий шаг должен быть про validation ladder, а не про ещё один UI micro-gap.
- [C:\Users\Tanya\source\repos\god-mode-core\package.json](C:\Users\Tanya\source\repos\god-mode-core\package.json) уже содержит `test:e2e` и `test:all`, но это сильнее выглядит как manual/full gate, чем как реально обязательная CI-проверка.
- [C:\Users\Tanya\source\repos\god-mode-coregithub\workflows\ci.yml](C:\Users\Tanya\source\repos\god-mode-core.github\workflows\ci.yml) сейчас концентрируется на `pnpm test` и связанных lane’ах, что оставляет зазор между documented test pyramid и фактическим PR gate.

## Out Of Scope

- Реальные provider/live tests как обязательная часть обычного PR gate
- VM/Parallels smoke как базовый always-on CI шаг
- Большой новый browser automation harness для всего Control UI
- Новые продуктовые UI функции вне validation/release-confidence темы

## Validation

Минимальный expected результат stage:

- deterministic E2E smoke можно запустить одной понятной командой локально и в CI
- CI реально исполняет этот cheap E2E слой хотя бы в одном релевантном lane
- docs больше не обещают слой, который не встроен в основной release story
- targeted test/update changes сами имеют focused coverage и не ломают текущие unit/e2e contracts

## Why This Is The Strong Next Step

Это stage уже переводит проект в режим «можно честно начинать growth поверх базы»:

- закрывает разрыв между документацией, локальными командами и CI
- даёт реальную автоматическую проверку поверх unit/jsdom регрессий
- делает v1 меньше похожей на набор локально пройденных stages и больше похожей на продукт с осмысленным release gate
