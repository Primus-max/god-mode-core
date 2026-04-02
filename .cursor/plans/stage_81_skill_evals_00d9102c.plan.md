---
name: stage 81 skill evals
overview: "После навигации и release-confidence gate следующий сильный шаг — детерминированно проверять качество skill-driven поведения агента через mock provider и реальный gateway/agent loop: use-vs-avoid, чтение `SKILL.md`, и workflow contracts."
todos:
  - id: build-skill-eval-harness
    content: Расширить существующий mock-provider/gateway test path до scenario-driven harness для deterministic skill behavior evals.
    status: completed
  - id: add-skill-reliability-scenarios
    content: "Добавить 2–4 CI-safe skill reliability scenarios: use-vs-avoid, read-before-act, required-steps/args, и при необходимости короткий multi-turn workflow contract."
    status: completed
  - id: document-skill-evals-layer
    content: Обновить testing docs, чтобы skill reliability evals были оформлены как реальный deterministic CI-safe layer, а не только как future wishlist.
    status: completed
isProject: false
---

# Stage 81 - Skills Reliability Evals

## Why This Stage

После Stage 80 проект уже получил честный deterministic E2E smoke и CI gate, но это всё ещё в основном проверка plumbing: gateway boot, connect path, chat roundtrip, shell/navigation contract. Следующий сильный шаг к богатой v1 — начать автоматически проверять, что **агент со skills ведёт себя правильно**, а не просто что инфраструктура не падает.

Это прямо подтверждается в [C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md](C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md): секция `Agent reliability evals (skills)` уже перечисляет как раз те пробелы, которые ещё не закрыты deterministic CI-safe путём:

- decisioning: выбрать нужный skill или избежать нерелевантного
- compliance: прочитать `SKILL.md` и следовать required steps/args
- workflow contracts: multi-turn tool order, session history carryover, sandbox boundaries

## Goal

Добавить маленький, deterministic, CI-safe набор skill reliability evals поверх существующего mock-provider + real gateway/agent loop, чтобы v1 опиралась не только на unit/E2E plumbing, но и на проверяемое качество skill-driven поведения.

## Key Evidence

- [C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md](C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md) уже называет `Agent reliability evals (skills)` следующим недостающим слоем и прямо рекомендует deterministic scenario runner.
- [C:\Users\Tanya\source\repos\god-mode-core\src\gateway\gateway.test.ts](C:\Users\Tanya\source\repos\god-mode-core\src\gateway\gateway.test.ts) уже использует `installOpenAiResponsesMock()` и реальный gateway/client loop, то есть harness для CI-safe agent behavior tests уже частично есть.
- [C:\Users\Tanya\source\repos\god-mode-core\src\gateway\test-helpers.openai-mock.ts](C:\Users\Tanya\source\repos\god-mode-core\src\gateway\test-helpers.openai-mock.ts) уже умеет multi-turn mock stream с tool-call фазой и follow-up после tool output, так что stage не требует нового тестового стека с нуля.
- [C:\Users\Tanya\source\repos\god-mode-core\src\agents\skills.e2e-test-helpers.ts](C:\Users\Tanya\source\repos\god-mode-core\src\agents\skills.e2e-test-helpers.ts) уже даёт удобный `writeSkill(...)` fixture path для записи `SKILL.md` в test workspace.

## Scope

### 1. Deterministic Skill Eval Harness On Top Of Existing Gateway Tests

Не строить отдельный framework с нуля, а расширить текущий mock-provider path вокруг:

- [C:\Users\Tanya\source\repos\god-mode-core\src\gateway\gateway.test.ts](C:\Users\Tanya\source\repos\god-mode-core\src\gateway\gateway.test.ts)
- [C:\Users\Tanya\source\repos\god-mode-core\src\gateway\test-helpers.openai-mock.ts](C:\Users\Tanya\source\repos\god-mode-core\src\gateway\test-helpers.openai-mock.ts)

Нужен способ scriptable/mock-driven задавать ожидаемые tool decisions и затем проверять их в реальном gateway + agent loop, но без live providers.

### 2. Add The First 2–4 Skill Reliability Scenarios

Минимальный сильный набор для stage:

- one `use-vs-avoid` scenario: среди нескольких listed skills агент использует релевантный и не трогает нерелевантный
- one `read-before-act` compliance scenario: агент сначала читает нужный `SKILL.md`, а уже потом делает следующий шаг
- one required-steps / args scenario: из skill fixture видно, что агент не пропускает обязательный action или аргумент
- optionally one multi-turn workflow contract: tool order и/или session carryover на коротком scripted path

Сценарии должны использовать реальные skill fixtures через [C:\Users\Tanya\source\repos\god-mode-core\src\agents\skills.e2e-test-helpers.ts](C:\Users\Tanya\source\repos\god-mode-core\src\agents\skills.e2e-test-helpers.ts), а не только строковые prompt assertions.

### 3. Lock The Contract In Testing Docs

Обновить [C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md](C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md), чтобы:

- описанный skill-evals слой перестал быть только wishlist
- было видно, какие сценарии уже являются deterministic CI-safe baseline
- было ясно, что live skill evals остаются optional follow-up, а не обязательной частью обычного PR gate

## Planned Changes

- В [C:\Users\Tanya\source\repos\god-mode-core\src\gateway\test-helpers.openai-mock.ts](C:\Users\Tanya\source\repos\god-mode-core\src\gateway\test-helpers.openai-mock.ts): сделать mock path более scenario-driven, чтобы можно было управлять expected tool call sequence и follow-up output без ad-hoc переписывания моков на каждый test.
- В [C:\Users\Tanya\source\repos\god-mode-core\src\gateway\gateway.test.ts](C:\Users\Tanya\source\repos\god-mode-core\src\gateway\gateway.test.ts) или новом соседнем skill-focused gateway test file: добавить 2–4 deterministic agent reliability eval scenarios.
- Использовать [C:\Users\Tanya\source\repos\god-mode-core\src\agents\skills.e2e-test-helpers.ts](C:\Users\Tanya\source\repos\god-mode-core\src\agents\skills.e2e-test-helpers.ts) для fixture `SKILL.md`, чтобы проверять не абстрактный prompt text, а реальный skill discovery/use path.
- В [C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md](C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md): обновить секцию `Agent reliability evals (skills)` из будущего намерения в уже существующий deterministic layer.

## Out Of Scope

- Live provider skill evals как обязательная часть PR gate
- Большой новый eval framework вне текущего gateway/mock stack
- UI changes, navigation work, shell polish
- Полная coverage всех skill edge cases в одном stage

## Validation

Минимальный expected результат stage:

- новый deterministic skill eval suite проходит локально без реальных ключей
- evals крутятся на существующем mock-provider + real gateway/agent loop, а не только на prompt string assertions
- docs ясно фиксируют, что теперь покрыто CI-safe skill behavior baseline
- stage не ломает текущий gateway/unit/e2e contracts

## Why This Is The Strong Next Step

Этот stage наконец переводит проект из режима «доказали, что инфраструктура и маршрутизация держатся» в режим «доказываем, что сам агент ведёт себя как продукт v1». Это сильнее любого следующего micro-stage, потому что напрямую бьёт в trust к качеству skill-driven поведения — одну из самых дорогих и заметных частей богатой версии.
