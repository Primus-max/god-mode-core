---
name: Autonomous V1 Release Lockdown
overview: "Финальный жёсткий план на закрытие investor-facing v1 без остановки на промежуточных патчах: довести бота до состояния strong demo/release candidate, прогнать полный automated + live Telegram/UI regression, затем выполнить beta-first release workflow и остановиться только после полного прохождения всех пунктов."
todos:
  - id: fix-user-facing-artifacts
    content: Закрыть реальные user-facing поломки delivery/artifacts, чтобы PDF, файлы и отчёты действительно отправлялись в каналы как вложения
    status: in_progress
  - id: close-universal-v1-behavior
    content: Довести universal v1 behavior для compare, calculation, report, bootstrap-resume и tool orchestration до сильного demo-уровня
    status: pending
  - id: harden-autonomy-and-install
    content: Довести самостоятельное capability install-resume, отказоустойчивость и устранить деградации когда бот отвечает текстом вместо действия
    status: pending
  - id: run-full-validation-ladder
    content: Пройти весь validation ladder без пропусков включая focused tests, check, build, full test, smoke, v1-gate и живой Telegram/UI прогон
    status: pending
  - id: prepare-release-candidate
    content: Подготовить changelog-backed release candidate и выполнить release validation для beta-first выпуска
    status: pending
  - id: cut-release
    content: Выполнить релизный проход по policy после зелёных validation gates и завершить этап только после успешного release proof
    status: pending
isProject: false
---

# Autonomous V1 Release Lockdown

## Goal

Закрыть текущий этап `v1` до состояния, в котором бот:

- уверенно обрабатывает реальные пользовательские сценарии без ручных костылей;
- действительно использует инструменты и артефакты, а не обещает действие текстом;
- сам проходит capability/bootstrap/install/resume путь там, где это ожидается продуктом;
- проходит полный automated и live regression;
- готов к релизному проходу по `beta-first` policy без известных blocker-дефектов.

## Non-Negotiable Execution Rule

Этот план выполняется как непрерывный цикл `implement -> verify -> continue`.

- Нельзя останавливаться после частичного фикса.
- Нельзя объявлять прогресс как завершение этапа.
- Нельзя завершать работу на состоянии "основное сделали, осталось добить мелочи".
- Единственное допустимое финальное сообщение по этому плану: все пункты выполнены и протестированы.

## Product Standard For V1

К моменту завершения плана investor-facing `v1` должен уметь:

- понимать простые и сложные пользовательские запросы без хрупкой деградации в неверный recipe;
- читать и сравнивать CSV/XLSX, выдавая внятный summary/recommendation;
- выполнять calculation/report сценарии с assumptions, units и структурированным результатом;
- генерировать markdown/PDF report и реально доставлять его в канал как attachment, а не как текст с именем файла;
- устанавливать недостающую capability, продолжать run и не терять пользовательский контекст;
- использовать сильные модели там, где локальная маршрутизация уже недостаточна;
- проходить Telegram/UI demo-сценарии без ручного "подталкивания" со стороны оператора.

## Scope To Close Before Release

### 1. Real user-facing defects first

- убрать дублирующиеся/ложные сообщения в Telegram и других delivery surfaces;
- гарантировать доставку generated artifacts как реальных вложений;
- убрать случаи, когда tool/workflow отработал, а пользователь получил только текстовую заглушку;
- убрать утечки старого session context в новые `sessionId` и новые delivery runs.

### 2. Universal v1 capability behavior

- закрыть compare/report/calculation/builder-context как единый user-facing слой, а не как набор несвязанных seam fixes;
- усилить orchestration так, чтобы бот сначала пытался использовать существующие сильные модели и инструменты, а не уходил в бессмысленную деградацию;
- проверить, что prompt/routing/recipe/policy/runtime surfaces согласованы между собой на реальных запросах.

### 3. Strong autonomy bar

- capability bootstrap должен вести к реальному resume, а не к тупиковой переписке;
- модель не должна отвечать "не могу", если в текущем стеке есть доступный tool/route/install path;
- attachment, report, compare и calculation пути должны работать end-to-end без ручного восстановления состояния.

## Execution Phases

## Phase 1: User-facing blockers

- закрыть PDF/file/report delivery;
- закрыть duplicate delivery / stale session reuse / wrong recipe routing;
- на каждый блокер: reproduce -> fix -> focused tests -> live re-run в Telegram.

## Phase 2: Strong v1 behavior

- добить compare/report/calculation/builder-context на реальных investor сценариях;
- вычистить случаи ложного local-first, неверного bootstrap_required и текстовых заглушек вместо action/result;
- использовать подагентов по зонам: routing/policy, artifacts/delivery, live verification.

## Phase 3: Full validation ladder

Обязателен полный проход:

- focused tests по затронутым зонам;
- `pnpm check`;
- `pnpm build`;
- `pnpm test`;
- `pnpm test:e2e:smoke`;
- `pnpm test:v1-gate`;
- live Telegram regression;
- UI/runtime inspector verification;
- повторный live pass после каждого найденного реального расхождения.

Нельзя переходить к release phase, пока любой обязательный gate красный или live scenario даёт неполный user-facing результат.

## Phase 4: Release candidate and release

- собрать changelog-backed release notes только после зелёных validation gates;
- выполнить publish-time validation:
  - `node --import tsx scripts/release-check.ts`
  - `pnpm release:check`
  - `pnpm test:install:smoke`
- релизный канал вести по policy `beta-first`;
- stable release возможен только после полного подтверждения release candidate и отсутствия blocker-регрессий.

## Hard Stop Conditions

Остановиться можно только если:

- нужен внешний секрет/credential/action, которого реально нет в доступной среде;
- release blocked политикой или инфраструктурой вне репозитория;
- обнаружен конфликт требований, который меняет сам продуктовый scope.

Все остальные случаи означают продолжение цикла до полного закрытия.

## Definition Of Done

Этап считается завершённым только если одновременно верно всё ниже:

- все пункты frontmatter `todos` имеют `completed`;
- user-facing artifact delivery реально работает в Telegram;
- compare/calculation/report сценарии проходят живой прогон;
- automated ladder целиком зелёный;
- release validation зелёный;
- выполнен release step по policy;
- остающихся blocker-дефектов для investor-facing `v1` нет.

## Final Response Contract

До достижения `Definition Of Done` не выдавать финальное сообщение вида "почти готово" или "основное сделано".

Финальное сообщение допустимо только в форме:

- все пункты выполнил и протестировал.
