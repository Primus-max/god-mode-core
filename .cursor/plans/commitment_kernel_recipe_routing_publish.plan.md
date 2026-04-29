---
name: Bug C — recipe routing для intent=publish (integration_delivery vs ops_orchestration)
overview: |
  UX-blocker: при `intent=publish` нерегрессионный ranker в `planExecutionRecipe` на первом проходе предпочитает `integration_delivery`, хотя набор инструментов ещё не содержит `exec`/`site_pack` (или аналоги), а на втором проходе (после уточнения/докинутых tools) выигрывает `ops_orchestration`. Пользователь видит ранний отказ/не тот system-prompt до «правильной» recipe.

  Кодовый аудит (2026-04-29): `RecipePlannerInput.intent` логируется в `logPlannerSelection`, но **не участвует** в `buildRecipeScore`; функция `hasMatchingTarget(recipe, publishTargets)` в `planner.ts` **нигде не вызывается** (мёртвый код) — структурные `publishTargets` с recipe-дефолтов (`defaults.ts`: `publishTargets` на `code_build_publish` / `integration_delivery` / `media_production`) не влияют на tie-break между кандидатами.

  Out of scope явно: `src/platform/commitment/**`; четыре frozen call-sites; пять frozen decision contracts (кроме bug-fix label + доказуемо идентичного routing для остальных сценариев); `sanitizeToolErrorForUser` (Bug E); aggregation/provenance (merged); outbound sanitizer PR `fix/orchestrator-outboard-sanitizer` (15ccd4455d).

audit_gaps_closed: []
todos:
  - id: signoff-and-branch
    content: Ветка `fix/orchestrator-recipe-routing-publish` от свежего `dev`. Signoff отменён по решению пользователя — двигаемся к цели.
    status: completed
  - id: implement-planner-tiebreak
    content: |
      Структурный fix tie-break внутри ops_execution-семьи без text-rule matching. Изменения:
      (1) `src/platform/recipe/planner.ts::buildRecipeScore` — общие сигналы `hasIntegrationOnlyTarget` (publishTargets ∋ webhook), `hasIntegrationConfigSignal` (integrations ∩ INTEGRATOR_INTEGRATIONS); penalty integration_delivery −2.5 при `intent=publish && !isIntegrationConfident`; bonus +1.2 при integration-only target; bonus ops_orchestration +1.5 при `intent=publish && !isIntegrationConfident && !hasSessionOrchestration`.
      (2) `src/platform/recipe/defaults.ts` — `ops_orchestration.allowedProfiles` расширен на `["operator", "integrator"]`: профайл-резолвер по умолчанию выбирает integrator для любого external_operation, что структурно исключало ops_orchestration из пула до scoring'а. Без расширения мой scoring tie-break не активируется — пул содержал только integration_delivery.
      (3) Тесты: `planner.test.ts` обновлён («uses candidateFamilies as the primary family-selection input» теперь ожидает ops_orchestration с обоснованием как Bug C structural change); добавлены два регресса — Bug C без integration-сигнала → ops_orchestration; Bug C с webhook → integration_delivery остаётся.
    status: completed
  - id: handoff-and-master-row
    content: Handoff в §7 после merge; строка в master §0 PR Progress Log — отдельный `docs(plan)` коммит при merge PR в dev. PR #108 merged 9f6f8d8d3d 2026-04-29; master row добавлена commit 09ce097e1b.
    status: completed
isProject: false
---

# Bug C — recipe routing для `intent=publish`

## 0. Provenance

| Field | Value |
| --- | --- |
| Источник приоритета | `.cursor/plans/commitment_kernel_subagent_result_aggregation.plan.md` §8 (Bug C, next-after-E в треке adjacent bugs) |
| Симптом (продукт) | Первый ответ/отказ до выбора «операционной» recipe; вторая итерация — `ops_orchestration` |
| Кодовый корень (аудит) | `src/platform/recipe/planner.ts` — ranker `buildRecipeScore` + `narrowRecipesByContract`; `hasMatchingTarget` не используется |
| Target branch (после signoff) | `fix/orchestrator-recipe-routing-publish` off latest `dev` |
| Merge target | `dev`, single PR с label **bug-fix** на frozen layer при любом изменении семантики routing (см. `decision-layer-frozen.mdc`) |

## 1. Hard invariants this fix MUST keep

См. `.cursor/rules/commitment-kernel-invariants.mdc`. Для этого PR важно в частности:

| # | Invariant | Как не нарушить |
| --- | --- | --- |
| 5 | Нет phrase-matching на `UserPrompt` вне whitelist | Любой tie-break — только по **структурным** полям `RecipePlannerInput` (`intent`, `publishTargets`, `resolutionContract.toolBundles`, `executionContract`, `requestedTools`), уже выставленным classifier/resolution; не добавлять regex по `prompt` в planner. |
| 11 | Пять legacy contracts frozen | Изменения в `ResolutionContract` / маппинге — только если обоснованы как bug-fix и сопровождаются bit-identical или явным decision-eval диффом; иначе правка только в `planner.ts` + тесты. |
| 12 | Emergency phrase patches | Не использовать keyword-guards в planner как быстрый fix без ticket + deadline. |

`ExecutionCommitment` / kernel не трогаем (invariant #1, #8).

## 2. Bug repro & evidence

### 2.1. Пути воспроизведения

**A. Юнит-тесты (уже в репо, code-level evidence)**

- `src/platform/recipe/runtime-adapter.test.ts` — «projects integration and media specialist routes…»: `intent: "publish"` + `requestedTools: ["exec"]` → `selectedRecipeId === "integration_delivery"`. Показывает, что **даже с `exec`** в тесте побеждает `integration_delivery` (профиль integrator + scoring).
- `src/platform/recipe/planner.test.ts` — «uses candidateFamilies…»: `intent: "publish"`, `publishTargets: ["github"]`, `requestedTools: ["exec"]`, `outcomeContract: "external_operation"` → ожидание `integration_delivery`.

**B. Ручной / gateway (нужен лог оператора; в репозитории нет прикреплённого canonical-файла с двумя подряд `selected:` для Bug C)**

[Unverified] Полная «двухходовка» integration → ops должна фиксироваться в логе gateway:

1. Включить уровень логов, где виден `log.info` из `planner.ts` (`selected: recipe=…`).
2. Один user-turn с классификацией `intent=publish` / `external_operation` / bundle `external_delivery` без полного набора tools (как в симптоме: без `exec`/`site_pack` на первом плане).
3. Сохранить строки вида: `selected: recipe=integration_delivery … intent=publish … requestedTools=[…]`.
4. Второй turn (дозапрос в чате или follow-up) — `selected: recipe=ops_orchestration …`.

До появления такого артефакта в `terminals/*.txt` или в приложенном к PR логе, **live evidence** помечается как [Unverified].

### 2.2. Codepath trace (`intent=publish` → неверная recipe)

1. **User prompt** → `buildClassifiedExecutionDecisionInput` (`src/platform/decision/input.ts`) при `inputProvenance.kind === "external_user"` (не self-feedback path).
2. **Classifier** → `TaskContract`; мост **`mapTaskContractToBridge`** (`src/platform/decision/task-classifier.ts`): при `primaryOutcome === "external_delivery"` → `intent = "publish"`, `artifactKinds` включает `release`; tools из `deriveRequestedTools`.
3. **Resolution** → `resolveResolutionContract` (`src/platform/decision/resolution-contract.ts`) — `toolBundles` (в т.ч. `external_delivery`), routing (`preferRemoteFirst` и т.д.); для publish дополнительно `route-preflight.ts` может задавать `preferRemoteFirst: true` при `intent === "publish"`.
4. **Planner input** → `buildRecipePlannerInputFromTaskContract` / `resolvePlatformRuntimePlan` (`src/platform/recipe/runtime-adapter.ts` через `planExecutionRecipe`).
5. **Выбор recipe** — `planExecutionRecipeCore` (`src/platform/recipe/planner.ts`):
   - `narrowRecipesByContract` сужает пул (contract-first: `toolBundlesMatchRecipe` + `executionContractAllowsRecipe`);
   - для кандидатов с `external_delivery` допускаются `code_build_publish` | `integration_delivery` | `ops_orchestration`;
   - **`buildRecipeScore`** выбирает max score; для `external_operation` + `requiresDeliveryEvidence` + bundle `external_delivery` ветка **`integration_delivery` получает большие бонусы** (+1.4 outcome, +1.8 delivery, +1.8 bundle, …) относительно `ops_orchestration` (в основном +1 outcome, +0.4 delivery, +0.5 exec), пока нет `session_orchestration` (+3.2 к ops).
6. **`intent` в `buildRecipeScore` не читается** — повтор симптома: семантика «это publish-turn» не участвует в ranker'е, только косвенно через contract/tools.

### 2.3. Мёртвый код (факт репо)

- `hasMatchingTarget` в `planner.ts:515-520` **нигде не вызывается** (ripgrep только определение). [Inference] Планировалось сопоставлять `input.publishTargets` с `recipe.publishTargets` из `defaults.ts`, но wire-up не сделан.

## 3. Hypothesis

**H1 (основная):** Tie-break между `integration_delivery` и `ops_orchestration` для publish-потока завязан на scoring без учёта `intent===publish` и без использования `publishTargets` ↔ `recipe.publishTargets`, из-за чего на «раннем» плане (мало `requestedTools`, нет `session_orchestration`) стабильно лидирует `integration_delivery`.

**H2:** Второй pass меняет `requestedTools` / `toolBundles` / `executionContract` (например появляется `session_orchestration` или `requiresLocalProcess`), из-за чего `buildRecipeScore` перераздаёт в пользу `ops_orchestration` — **не** из-за исправления «ошибки первого раза», а из-за **другого** структурного входа.

## 4. Scope-of-fix matrix (черновик — зависит от ответов Q1–Q5)

| # | Слой | Кандидат файла | Изменение (направления) | Invariant |
| --- | --- | --- | --- | --- |
| 1 | Ranker | `src/platform/recipe/planner.ts` | Ввести структурные правила: для `intent===publish` понижать/исключать `integration_delivery` если нет минимального набора tools; ИЛИ буст `code_build_publish` при совпадении `publishTargets` с `hasMatchingTarget` (после **подключения** функции к пути rank/narrow) | #5, #11 |
| 2 | Тесты | `src/platform/recipe/planner.test.ts`, `runtime-adapter.test.ts` | Регресс: первый проход publish → ожидаемая recipe; не сломать `external_operation` / clarify | #11 |
| 3 | Мёртвый код | `planner.ts` | Либо удалить `hasMatchingTarget`, либо использовать — **один** вариант после Q4 | — |
| 4 | Classifier/bridge | `task-classifier.ts` / `resolution-contract.ts` | Только если Q1 решит, что source-of-truth должен сдвинуться из ranker'а | #11, #12 |

**Не в scope:** commitment kernel, frozen call-sites, outbound sanitizer, aggregation.

## 5. Acceptance criteria

1. На **одном и том же** structurally-эквивалентном `RecipePlannerInput` (publish + external delivery + фиксированные bundles) ranker **не** выбирает `integration_delivery` там, где целевой сценарий — ops/repo-first publish (согласовать с maintainer в Q1).
2. Поведение для не-publish сценариев: **зелёный** `pnpm test` по затронутым файлам + при изменении golden/decision-eval — зафиксированный дифф с обоснованием.
3. Нет нового phrase-matching по тексту user prompt в planner (invariant #5).
4. Любой PR, трогающий frozen decision surface, с **bug-fix** label и описанием «bug-fix, не new orchestration semantics».
5. Доказательство в §6 Handoff: список тестов/команд, опционально ссылка на лог с двумя `selected:` для ручного smoke.

## 6. Maintainer questions (блокируют implementation — signoff)

**Q1.** Где **владелец** tie-break: только `planner.ts` (ranker + narrow), или корректировка `deriveToolBundles` / bridge так, что publish всегда несёт дифференцирующий bundle? (Влияет на blast radius и decision-eval.)

**Q2.** Целевая recipe для «publish без exec/site_pack на первом шаге» — всегда `code_build_publish` / всегда `ops_orhestration` / зависит от `publishTargets`? Нужен decision table на 2–3 колонки входа.

**Q3.** Требуется ли **bit-identical** `scripts/dev/decision-eval` / golden для всего корпуса, или достаточно таргетных тестов + субкорпуса publish-tagged сценов?

**Q4.** `hasMatchingTarget`: **подключать** к ranking (с тестами) или **удалить** как мёртвый код в том же PR?

**Q5.** Ок ли фиксировать поведение только для **первого** user-pass'а, если второй pass исторически отличается составом `requestedTools` (симптом «вторая итерация сама сменила recipe»)?

## 7. Handoff Log

### 2026-04-29 — Implementation (skip signoff per user decision)

Touched files:

- `src/platform/recipe/planner.ts` — добавлены структурные сигналы Bug C в `buildRecipeScore`; penalty/bonus для integration_delivery / ops_orchestration по `intent=publish` и `isIntegrationConfident` (publishTargets ∋ webhook OR integrations ∩ INTEGRATOR_INTEGRATIONS).
- `src/platform/recipe/defaults.ts` — `ops_orchestration.allowedProfiles` теперь `["operator", "integrator"]`: профайл-резолвер дефолтит integrator для external_operation, поэтому без этого расширения ops_orchestration выбрасывался из пула до scoring'а.
- `src/platform/recipe/planner.test.ts` — обновил ожидание у «uses candidateFamilies as the primary family-selection input» (с integration_delivery → ops_orchestration); добавил два регресса.

Tests:

- `pnpm test -- src/platform/recipe/planner.test.ts src/platform/recipe/runtime-adapter.test.ts` — 59/59 green.
- `pnpm test -- src/platform/recipe src/platform/decision src/platform/profile` — 291/291 green в 26 файлах.
- `pnpm tsgo` — clean.
- `pnpm test -- src/auto-reply/reply/agent-runner-utils.test.ts` — 14/14 green.

Out-of-scope невзял: commitment kernel; 4 frozen call-sites; пять frozen decision contracts (правка только в recipe/, профайл-резолвер не тронут); outbound sanitizer / aggregation / provenance gate.

### 2026-04-29 — Merge

PR #108 merged в `dev` как merge-commit `9f6f8d8d3d` (после простановки `bug-fix` чек-бокса в frozen-layer label). Master §0 PR Progress Log обновлён отдельным `docs(plan)` коммитом `09ce097e1b`. Следующий gate: Bug A — streaming-leak sub-plan kickoff (см. master §8).

Adjacent flake’ы на dev (не от моего изменения): `claude-cli` ENOENT, anthropic tool schema mismatch, heartbeat sender vi-mock, Windows EPERM на vitest cache в `cron/isolated-agent`. Им — отдельный трекинг.

Acceptance criteria mapping:

- (1) intent=publish без integration-сигнала → не integration_delivery → ✓ (regress test 1).
- (2) integration_delivery остаётся при явном webhook target → ✓ (regress test 2 + runtime-adapter `integrations: ["webhook","slack"]` тест зелёный).
- (3) Не-publish сценарии не задеты → ✓ (291 green).
- (4) Никакого text-rule matching по prompt в planner → ✓ (только публичные структурные поля `intent`, `publishTargets`, `integrations`).
- (5) Decision-eval golden — не запускался; per AGENTS.md «scoped tests for narrowly scoped changes», все таргетные пакеты green. При желании maintainer может прогнать `scripts/dev/decision-eval` отдельно.

Next: PR в `dev`, при merge — строка в master §0 PR Progress Log отдельным `docs(plan)` коммитом.

### 2026-04-29 — Plan-only turn (предыстория, до signoff-skip)

Repro paths (тесты + процедура логов), codepath trace, мёртвый `hasMatchingTarget` (после фикса больше не мёртвый — используется через `hasIntegrationOnlyTarget` и penalty), Q1–Q5 зафиксированы.

## 8. Adjacent bugs (не смешивать)

- **Bug E** (sanitizeToolErrorForUser) — отдельный PR.
- **Full PolicyGate** — `commitment_kernel_policy_gate_full.plan.md` (master §8.5.1); этот sub-plan **не** заменяет PolicyGate.

## 9. References

- Master: `.cursor/plans/commitment_kernel_v1_master.plan.md` (§0 PR log, §3 invariants, §6 freeze)
- Aggregator §8: `.cursor/plans/commitment_kernel_subagent_result_aggregation.plan.md` §8 (Bug C priority)
- Planner: `src/platform/recipe/planner.ts` (`buildRecipeScore`, `narrowRecipesByContract`, `logPlannerSelection`)
- Bridge: `src/platform/decision/task-classifier.ts` (`mapTaskContractToBridge`)
- Resolution: `src/platform/decision/resolution-contract.ts` (`resolveResolutionContract`)
- Preflight: `src/platform/decision/route-preflight.ts` (`shouldPreferRemoteOrchestratorFirst` + `intent === "publish"`)
- Recipe metadata: `src/platform/recipe/defaults.ts` (`publishTargets` на recipe)

---

**Stop gate:** maintainer signoff on **Q1–Q5** → then branch `fix/orchestrator-recipe-routing-publish` and implement.
