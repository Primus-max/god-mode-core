---
name: stage 82 recovery gate
overview: Следующий сильный шаг после Stage 81 — перевести runtime recovery / delivery truth из mostly-manual smoke runbook в маленький deterministic confidence layer, чтобы v1 опиралась не только на gateway smoke и skill evals, но и на проверяемую closure/recovery truth story.
todos:
  - id: audit-recovery-contract
    content: Зафиксировать минимальный recovery/delivery confidence contract поверх существующих runtime ledgers, closure truth и gateway flows.
    status: completed
  - id: build-recovery-eval-harness
    content: Собрать тонкий deterministic harness на базе текущих gateway/runtime test seams вместо нового отдельного smoke framework.
    status: completed
  - id: add-recovery-parity-scenarios
    content: "Добавить небольшой набор CI-safe recovery/delivery parity scenarios: success, non-clean outcome, и короткий restart/continuation contract."
    status: completed
  - id: align-recovery-docs-and-gate
    content: Обновить testing guidance так, чтобы manual local recovery smoke и новый deterministic layer были чётко разведены и складывались в одну release story.
    status: completed
isProject: false
---

# Stage 82 - Runtime Recovery Confidence Gate

## Why This Stage

После `Navigation validation gate`, `Release confidence E2E gate` и `Skills reliability evals` следующий самый дорогой для доверия gap уже не в routing и не в skill decisioning, а в том, можно ли **доказуемо доверять delivery / closure / recovery truth** как части v1 release story.

Сейчас в `[docs/help/testing.md](C:/Users/Tanya/source/repos/god-mode-core/docs/help/testing.md)` уже есть большой раздел `Local runtime recovery smoke`, но он остаётся в основном manual runbook: оператору предлагается вручную прогонять `sessions.send`, `platform.runtime.actions.list`, `platform.runtime.closures.list`, `platform.runtime.checkpoints.list` и затем самому сверять parity между action truth, closure truth и recovery checkpoints. Это хороший maintainer flow, но ещё не настоящий automated confidence layer.

Исторически репозиторий уже делал похожий шаг раньше: `[stage_24_delivery_parity_b2ffa2ea.plan.md](C:/Users/Tanya/source/repos/god-mode-core/.cursor/plans/stage_24_delivery_parity_b2ffa2ea.plan.md)` выровнял canonical delivery evidence, а `[stage_25_smoke_a64a116e.plan.md](C:/Users/Tanya/source/repos/god-mode-core/.cursor/plans/stage_25_smoke_a64a116e.plan.md)` оформил local recovery smoke как операторский workflow. Следующий сильный этап теперь не заново проектировать delivery truth, а превратить её в небольшой deterministic regression layer, который можно прогонять без live providers и без ручной корреляции по логам.

## Goal

Добавить маленький deterministic, CI-safe набор recovery/delivery confidence evals поверх существующих runtime ledgers, gateway flows и inspection seams, чтобы v1 опиралась на автоматически проверяемую parity между:

- `messaging_delivery` action truth
- `runClosureSummary` / runtime closure truth
- recovery / continuation checkpoints
- session-facing handoff summary fields

## Key Evidence

- `[docs/help/testing.md](C:/Users/Tanya/source/repos/god-mode-core/docs/help/testing.md)`:
  - `For a deterministic pre-release baseline before a v1 push, prefer: pnpm build / pnpm check / pnpm test / pnpm test:e2e:smoke`.
  - Ниже есть отдельный manual раздел `Local runtime recovery smoke`, что показывает: release ladder уже дошла до уровня, где следующий gap именно recovery truth, но он пока не автоматизирован.
- `[docs/help/testing.md](C:/Users/Tanya/source/repos/god-mode-core/docs/help/testing.md)`: targeted references для этой темы уже названы прямо в runbook: `[src/infra/outbound/delivery-queue.recovery.test.ts](C:/Users/Tanya/source/repos/god-mode-core/src/infra/outbound/delivery-queue.recovery.test.ts)`, `[src/auto-reply/dispatch.delivery-closure.test.ts](C:/Users/Tanya/source/repos/god-mode-core/src/auto-reply/dispatch.delivery-closure.test.ts)`, `[src/auto-reply/reply/route-reply.test.ts](C:/Users/Tanya/source/repos/god-mode-core/src/auto-reply/reply/route-reply.test.ts)`, `[src/platform/runtime/service.test.ts](C:/Users/Tanya/source/repos/god-mode-core/src/platform/runtime/service.test.ts)`.
- `[test/gateway.multi.e2e.test.ts](C:/Users/Tanya/source/repos/god-mode-core/test/gateway.multi.e2e.test.ts)` и текущие gateway/e2e seams уже дают real gateway lifecycle patterns, так что stage может строиться как thin harness сверху, а не как новый heavy framework.
- `[docs/help/testing.md](C:/Users/Tanya/source/repos/god-mode-core/docs/help/testing.md)` уже фиксирует operator-facing acceptance criteria для recovery smoke, значит репозиторий сам подсказывает следующую automation target.

## Scope

### 1. Define A Minimal Recovery Confidence Contract

Сначала зафиксировать, какой именно automated baseline нужен для v1, не раздувая этап до full live recovery lab.

Минимум для stage:

- успешная доставка не расходится между runtime action truth и closure truth
- `partial`/`failed` delivery не маскируется как clean delivered closure
- continuation / restart path повторно использует durable truth вместо двойного "confirmed"
- session-facing handoff summary и runtime ledgers можно сверить по стабильному request anchor, а не по косвенной ручной корреляции

Основные опорные файлы:

- `[docs/help/testing.md](C:/Users/Tanya/source/repos/god-mode-core/docs/help/testing.md)`
- `[src/platform/runtime/service.ts](C:/Users/Tanya/source/repos/god-mode-core/src/platform/runtime/service.ts)`
- `[src/platform/runtime/gateway.ts](C:/Users/Tanya/source/repos/god-mode-core/src/platform/runtime/gateway.ts)`
- `[src/gateway/session-broadcast-snapshot.ts](C:/Users/Tanya/source/repos/god-mode-core/src/gateway/session-broadcast-snapshot.ts)`
- `[src/gateway/session-event-hub.ts](C:/Users/Tanya/source/repos/god-mode-core/src/gateway/session-event-hub.ts)`

### 2. Build A Thin Deterministic Harness

Не делать новый browser/manual smoke stack. Вместо этого расширить существующие deterministic seams так, чтобы можно было прогонять короткие scripted recovery scenarios через реальные runtime/gateway paths.

Предпочтительный путь:

- reuse targeted runtime tests как источники truth assertions
- reuse gateway/e2e harness patterns для request anchor, session lifecycle и inspection RPC
- при необходимости добавить один соседний focused test file для recovery-confidence scenarios, а не расползаться по множеству ad-hoc tests

Вероятные зоны реализации:

- `[test/gateway.multi.e2e.test.ts](C:/Users/Tanya/source/repos/god-mode-core/test/gateway.multi.e2e.test.ts)`
- `[src/platform/runtime/service.test.ts](C:/Users/Tanya/source/repos/god-mode-core/src/platform/runtime/service.test.ts)`
- `[src/infra/outbound/delivery-queue.recovery.test.ts](C:/Users/Tanya/source/repos/god-mode-core/src/infra/outbound/delivery-queue.recovery.test.ts)`
- `[src/auto-reply/dispatch.delivery-closure.test.ts](C:/Users/Tanya/source/repos/god-mode-core/src/auto-reply/dispatch.delivery-closure.test.ts)`

### 3. Add The First 2-3 Recovery Parity Scenarios

Сильный минимальный набор для stage:

- one `success parity` scenario: request anchor, delivery action, closure summary и handoff fields согласованы
- one `non-clean outcome` scenario: `partial` или `failed` path остаётся нечистым и не превращается в delivered closure truth
- one short `continuation/recovery contract` scenario: resume/restart path не создаёт вторую подтверждённую delivery truth и сохраняет inspectable checkpoint chain

Если для restart path нужен слишком heavy orchestration, допустимо сначала зафиксировать continuation contract на коротком deterministic path, лишь бы stage реально закрывал reuse durable truth вместо повторной отправки.

### 4. Align Docs With The New Gate

Обновить `[docs/help/testing.md](C:/Users/Tanya/source/repos/god-mode-core/docs/help/testing.md)`, чтобы стало ясно:

- что теперь покрывает новый deterministic recovery-confidence layer
- где заканчивается CI-safe parity suite и начинается manual local runtime recovery smoke
- какой lightweight command/test lane нужно запускать при изменениях в delivery truth, closure truth, recovery или operator-facing runtime inspection

## Out Of Scope

- Live provider / real channel delivery как обязательная часть обычного PR gate
- Полный VM, Docker или Parallels recovery smoke в always-on CI
- Новый большой operator dashboard или UI redesign
- Перепроектирование canonical delivery truth, уже сделанное в прежних delivery/recovery stages

## Validation

Минимальный expected результат stage:

- новый deterministic recovery-confidence suite проходит локально без реальных ключей и live providers
- suite проверяет parity между runtime actions, closure truth и recovery state, а не только отдельные unit helpers
- docs ясно разделяют automated deterministic layer и manual local recovery smoke
- targeted runtime/gateway contracts остаются зелёными

## Why This Is The Strong Next Step

Этот stage делает следующий честный переход к v1 quality:

- закрывает gap между already-documented recovery runbook и реальным automated confidence
- усиливает trust не только к тому, что агент отвечает, но и к тому, что delivery/recovery truth остаётся правильной после сбоев и продолжений
- делает release story менее похожей на набор ручных operator smoke шагов и более похожей на продукт с проверяемой durable execution truth
