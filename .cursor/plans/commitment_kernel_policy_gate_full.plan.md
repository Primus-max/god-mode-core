---
name: PolicyGate Full — staged decomposition (Stage 1 = Bug D ambiguity over-blocking)
overview: |
  Этот sub-plan покрывает **полный PolicyGate** master §8.5.1: approvals, budgets per-user/per-channel/per-effect, role-based access, retry policies, escalation hooks, plus orthogonal **clarification policy** для downgrade-а ложных blocking-ambiguities.

  PR-4b закрыл minimum PolicyGate (G6.b): `POLICY_GATE_REASONS = ['channel_disabled','no_credentials']` с frozen reverse-test. Полный PolicyGate обязателен **до cutover-4** (`repo_operation.completed`). До тех пор gate-методы вводятся **поэтапно** — каждая стадия = отдельный PR с явным maintainer signoff (invariant #15) и явным reverse-test расширения allowlist-а.

  **Stage 1 в этом PR (Bug D — clarification policy)** — единственная стадия БЕЗ обязательного signoff (focused bug-fix slice). Текущий классификатор помечает `primaryOutcome=clarification_needed` + `ambiguities=["…publish target is not specified"]` даже когда `SemanticIntent.target.kind === 'workspace'` или `constraints.hosting === 'local'` (юзер явно сказал "локально"/"local"). Оркестратор тратит turn на ненужный clarify, юзер воспринимает агента как тупого.

  Fix: **orthogonal** `ClarificationPolicyReader` (sibling к `PolicyGateReader`) с собственным замороженным reasons-set `CLARIFICATION_POLICY_REASONS = ['ambiguity_resolved_by_intent']`. Решение принимает структурный matcher по `SemanticIntent.target` / `intent.constraints` (ни одного phrase-rule по `UserPrompt`/`RawUserTurn`, invariants #5/#6). `runTurnDecision.ts` (НЕ frozen) consult-ит новый gate после legacy classifier; при positive downgrade — модифицирует производную production decision (`primaryOutcome=answer`, `interactionMode=respond_only`, `lowConfidenceStrategy=undefined`) и пишет marker в `DecisionTrace`.

  Existing `POLICY_GATE_REASONS` (affordance gate) **не трогается** — orthogonality: clarification ≠ affordance selection. Существующий reverse-test (`policy-gate.test.ts`) остаётся frozen на 2 кодах. Новый reverse-test (`clarification-policy.test.ts`) фиксирует exact set `['ambiguity_resolved_by_intent']` для Stage 1.

  Stages 2+ (approvals, budgets, role-based, retry, escalation) — каждая отдельным PR-ом с phase-gate signoff, как master plan §8.4 / §8.5 (PR-1..PR-3 / PR-4*).

audit_gaps_closed: []  # Bug D — UX-bug, не G1..G6.c gap; Stages 2-6 будут привязаны к G6.c кусочно по PR.

todos:
  # ===== Stage 1 — Bug D narrow PR (NO signoff required, focused bug-fix slice) =====

  - id: stage1-bootstrap
    stage: 1
    signoff: not_required
    content: |
      Ветка `fix/orchestrator-policy-gate-clarification` от свежего `origin/dev`. HARD RULE: NO maintainer Q1-Q5; план существует — execute strictly per plan. Начинаем со sub-plan-а (этот файл), затем код.
    status: completed

  - id: stage1-clarification-gate-impl
    stage: 1
    signoff: not_required
    content: |
      Создать `src/platform/commitment/clarification-policy.ts`:
      (1) `CLARIFICATION_POLICY_REASONS = Object.freeze(['ambiguity_resolved_by_intent'] as const)` — closed set, frozen reverse-test enforced;
      (2) `ClarificationPolicyReason = (typeof CLARIFICATION_POLICY_REASONS)[number]`;
      (3) `ClarificationPolicyDecision = { shouldClarify: true } | { shouldClarify: false; downgradeReason: ClarificationPolicyReason }`;
      (4) `ClarificationPolicyReader.evaluate({ intent, blockingReasons }) → ClarificationPolicyDecision | Promise<ClarificationPolicyDecision>` (signature mirror `PolicyGateReader.canUseAffordance`);
      (5) `createClarificationPolicy({ cfg })` factory — Wave Stage-1 implementation: matcher проверяет `SemanticIntent.target.kind === 'workspace'` ИЛИ `intent.constraints[<curated structural keys>]` несёт local-маркер (`hosting`, `deploymentTarget`, `executionTarget` ∈ {`local`,`localhost`,`local_machine`}) AND `blockingReasons` содержит хотя бы один reason из curated structural set (`'publish target' | 'deployment target' | 'production target'` substrings — это уже classifier OUTPUT, НЕ user input). Если оба условия выполнены → `{ shouldClarify: false, downgradeReason: 'ambiguity_resolved_by_intent' }`; иначе `{ shouldClarify: true }`.
      Экспорт через `src/platform/commitment/index.ts` (новые символы рядом с `POLICY_GATE_REASONS`/`createPolicyGate`).
    status: pending

  - id: stage1-runtime-wiring
    stage: 1
    signoff: not_required
    content: |
      В `src/platform/decision/run-turn-decision.ts` (НЕ frozen):
      (1) Добавить optional injection point `clarificationPolicy?: ClarificationPolicyReader` в `RunTurnDecisionInput` (mirror existing `policyGate?` slot);
      (2) Refactor `runShadowBranch` чтобы возвращать `{ result: ShadowBuildResult; intent?: SemanticIntent }` — intent вытаскивается из IntentContractor.classify() результата (раньше discarded). Внешний API `runTurnDecision` остаётся неизменным;
      (3) После `legacyDecision` готов: если `legacyDecision.plannerInput.lowConfidenceStrategy === 'clarify'` И есть intent (с confidence ≥ threshold) И есть blocking-ambiguity reasons из `legacyDecision.plannerInput.decisionTrace?.contracts?.ambiguityProfile` (filter `blocksClarification === true`), то consult `input.clarificationPolicy ?? createClarificationPolicy({ cfg: input.cfg })`. Если `decision.shouldClarify === false` — построить downgraded `productionDecision` (`taskContract.primaryOutcome='answer'`, `interactionMode='respond_only'`, `lowConfidenceStrategy=undefined` или ровный `undefined` при отсутствии); записать marker в `DecisionTrace.clarificationPolicy = { downgradeReason }`.
      (4) Downgrade имеет приоритет над commitment-derived production decision только когда commitment kernel-derived path НЕ сработал (то есть legacy fallback path). Когда `productionDecision === kernel-derived` (cutover-eligible + commitmentSatisfied), clarification gate не вмешивается — kernel sourceOfTruth уже принял решение. Это сохраняет invariant #3.
    status: pending

  - id: stage1-trace-marker
    stage: 1
    signoff: not_required
    content: |
      В `src/platform/decision/trace.ts` (FROZEN — требует PR label `compatibility`):
      добавить optional поле `clarificationPolicy?: { readonly downgradeReason: 'ambiguity_resolved_by_intent' }` в `DecisionTrace`. Это observability-only; не вводит новой orchestration-семантики (тип downgradeReason = closed string-literal). Не задевает 5 frozen contracts (TaskContract / OutcomeContract / QualificationExecutionContract / ResolutionContract / RecipeRoutingHints).
    status: pending

  - id: stage1-tests
    stage: 1
    signoff: not_required
    content: |
      (a) `src/platform/commitment/__tests__/clarification-policy.test.ts`: reverse-test `CLARIFICATION_POLICY_REASONS === ['ambiguity_resolved_by_intent']` + `Object.isFrozen` + push-throws; positive cases: target=workspace + blocking publish-target reason → `shouldClarify=false; downgradeReason='ambiguity_resolved_by_intent'`; constraints.hosting='local' + same reason → ditto; explicit signal but без blocking reason → `shouldClarify=true`; blocking reason без explicit signal → `shouldClarify=true`; non-deployment blocking reason (например `credentials missing`) — gate НЕ срабатывает даже при local intent.
      (b) `src/platform/decision/run-turn-decision.clarification-downgrade.test.ts`: end-to-end. Legacy classifier emits clarify_first + "publish target is not specified" ambiguity; SemanticIntent имеет `target.kind='workspace'` (или constraints с hosting='local'); production decision должен иметь `primaryOutcome='answer'`, `interactionMode='respond_only'`, `decisionTrace.clarificationPolicy.downgradeReason='ambiguity_resolved_by_intent'`. Negative case: тот же legacy + intent без local signal → production decision остаётся clarify (legacy preserved).
      (c) Bit-identical regression: `pnpm vitest run src/platform/decision/task-classifier.test.ts src/platform/decision/qualification-confidence.test.ts` — frozen layer behavior unchanged.
    status: pending

  - id: stage1-tsgo-and-lint
    stage: 1
    signoff: not_required
    content: |
      `pnpm tsgo` clean; ReadLints clean на затронутых файлах; targeted `pnpm test -- src/platform/commitment src/platform/decision` green; `pnpm run lint:commitment:no-raw-user-text-import`, `lint:commitment:no-decision-imports`, `lint:commitment:no-classifier-imports` — все green; `node scripts/check-frozen-layer-label.mjs` с `BASE_REF=origin/dev` + `PR_BODY="- [x] compatibility"` → exit 0 (т.к. `trace.ts` затронут).
    status: pending

  - id: stage1-commit-and-pr
    stage: 1
    signoff: not_required
    content: |
      Коммит на русском, без Co-authored-by; `scripts/committer "<msg>" <files...>` (если доступно) или `git commit -F <file>`. PR в `dev` с label `compatibility` (т.к. trace.ts — frozen layer; per `scripts/check-frozen-layer-label.mjs` любая правка `src/platform/decision/trace.ts` требует frozen label). PR body explicitly disclaim: "approvals/budgets/role-based PolicyGate **не** в scope этого PR — Stages 2+ см. в этом sub-plan-е, требуют отдельный PR + invariant #15 signoff".
    status: pending

  - id: stage1-handoff-and-master-row
    stage: 1
    signoff: not_required
    content: |
      Post-merge: отдельный `docs(plan)` коммит (1) добавит строку в master §0 PR Progress Log (template Bug A row); (2) обновит frontmatter этого sub-plan-а — Stage 1 todos → `completed`, Stage 2+ остаются `pending` с `signoff: required`; (3) добавит датированную запись в Handoff Log §7.
    status: pending

  # ===== Stage 2 — Approvals (signoff REQUIRED, отдельный PR) =====

  - id: stage2-approvals
    stage: 2
    signoff: required
    content: |
      Расширить `POLICY_GATE_REASONS` на `'requires_approval'` (или ввести orthogonal `APPROVAL_POLICY_REASONS` set — choice TBD на момент старта Stage 2). Добавить approval lookup hook (e.g. config-driven role-policy registry или explicit per-effect approval list). Frozen reverse-test обновляется в этом же PR. Обязателен maintainer signoff (invariant #15) до merge. Обязателен до cutover-4 (`repo_operation.completed`).
    status: pending

  # ===== Stage 3 — Budgets (signoff REQUIRED, отдельный PR) =====

  - id: stage3-budgets
    stage: 3
    signoff: required
    content: |
      Budgets per-user / per-channel / per-effect. Reasons: `'budget_exceeded_user'`, `'budget_exceeded_channel'`, `'budget_exceeded_effect'` (или единый `'budget_exceeded'` с structured reason payload — TBD). Storage layer (где живут квоты + reset windows) — отдельный design step. Maintainer signoff обязателен.
    status: pending

  # ===== Stage 4 — Role-based access (signoff REQUIRED, отдельный PR) =====

  - id: stage4-role-based
    stage: 4
    signoff: required
    content: |
      Role-based access control: per-user roles, role→effect allowlist. Reason `'role_denied'`. Интеграция с identity layer (где user-id resolved → role lookup). Maintainer signoff обязателен. Обязателен до cutover-4.
    status: pending

  # ===== Stage 5 — Retry policies (signoff REQUIRED, отдельный PR) =====

  - id: stage5-retry
    stage: 5
    signoff: required
    content: |
      Per-effect retry budgets и backoff policies. Reason `'retry_limit_exceeded'`. Интеграция с MonitoredRuntime. Maintainer signoff обязателен.
    status: pending

  # ===== Stage 6 — Escalation hooks (signoff REQUIRED, отдельный PR) =====

  - id: stage6-escalation
    stage: 6
    signoff: required
    content: |
      Escalation hooks: после policy denial с определённым reason → trigger escalation channel (e.g. notify maintainer, raise approval request). Reason payload расширяется с escalation-id. Maintainer signoff обязателен.
    status: pending

isProject: false
---

# PolicyGate Full — staged decomposition (Stage 1 = Bug D)

## 0. Provenance

| Field | Value |
| --- | --- |
| Sub-plan of | `commitment_kernel_v1_master.plan.md` (§8.5.1 PolicyGate split, §16 next gate, §0.5.2 G6.c) |
| Inherits | 16 hard invariants + 6 flexible (без изменений) |
| Stage 1 trigger | Master §0 PR Progress Log: `2026-04-29 \| Bug A merged 7f56fbd9ab → next gate: Bug A.2 / Bug B / Bug D / Bug F sub-plan kickoff`. Bug D = clarification over-blocking. |
| Source | Master plan §8.5.1: "PolicyGate реализуется в два уровня — Minimum (PR-4b, merged 1e6231dd60) + **Full** (этот sub-plan, до cutover-4)". |
| Target branch (Stage 1) | `fix/orchestrator-policy-gate-clarification` off `origin/dev` (HEAD `ca8a00f6fa` на момент создания плана). |
| Merge target (Stage 1) | `dev`, single PR с label **compatibility** (touches frozen `trace.ts`). |
| Signoff (Stage 1) | **Не требуется** — narrow bug-fix slice, не вводит новой orchestration-семантики (orthogonal observability-only поле в trace). |
| Signoff (Stage 2+) | **Требуется** — каждая стадия отдельным PR-ом с invariant #15 maintainer signoff. До cutover-4 (`repo_operation.completed`) **обязательно** закрыть Stages 2-6. |

## 1. Hard invariants this sub-plan MUST keep (across all stages)

См. `.cursor/rules/commitment-kernel-invariants.mdc` (16 hard invariants — always-applied rule). Точечно для Stage 1:

| # | Invariant | Как держим |
| --- | --- | --- |
| 1 | `ExecutionCommitment` tool-free | Не трогаем `execution-commitment.ts`. |
| 2 | Affordance selected by (effect + target + preconditions + policy + budgets) | Не трогаем affordance selection — clarification gate **orthogonal** к affordance gate (не путать с `canUseAffordance`). |
| 3 | Production success requires `commitmentSatisfied(...) === true` | Stage 1 модифицирует только legacy fallback path, не kernel-derived path. Когда `productionDecision === kernel-derived`, clarification gate не вмешивается. |
| 4 | Success requires observed state-after | Stage 1 не вводит success/failure decisions — только `clarification_needed → answer` downgrade на legacy. |
| 5 | No phrase/text-rule matching на `UserPrompt`/`RawUserTurn` вне whitelist | Все matchers Stage 1 работают на (а) `SemanticIntent` структурных полях (`target.kind`, `constraints[<key>]`), (б) classifier OUTPUT-ах (`legacyDecision.plannerInput.decisionTrace.contracts.ambiguityProfile[].reason` — это classifier-emitted строки, не user prompt). НИ ОДНОГО regex по prompt/RawUserTurn. |
| 6 | `IntentContractor` — единственный reader сырого user text | Stage 1 не читает `RawUserTurn`/`UserPrompt`; consume-ит только готовый `SemanticIntent` от существующего `createIntentContractor`. |
| 7 | `ShadowBuilder` принимает только `SemanticIntent` | Не трогаем shadow-builder. |
| 8 | `commitment/` ↛ `decision/` | Новый `clarification-policy.ts` живёт в `commitment/` и НЕ импортирует из `decision/`. Связь идёт от `decision/run-turn-decision.ts` к `commitment/clarification-policy.ts` — это разрешённое направление. |
| 9 | `DonePredicate` видит только state/delta/receipts/trace | Не трогаем done-predicates. |
| 10 | `DonePredicate` живёт на `Affordance` | Не трогаем. |
| 11 | Five legacy contracts frozen (TaskContract/OutcomeContract/QualificationExecutionContract/ResolutionContract/RecipeRoutingHints) | Не вводим новые orchestration-semantic поля в эти типы. `DecisionTrace.clarificationPolicy` — observability-only marker (closed string-literal, не enum в TaskContract). |
| 12 | Emergency phrase patches → ticket + retire deadline | Не emergency. Структурный gate с frozen reasons-set. |
| 13 | `terminalState` ⊥ `acceptanceReason` | Не трогаем. |
| 14 | `ShadowBuildResult` typed, never null/throw | Не трогаем shape. Stage 1 переиспользует `ShadowBuildResult` без расширений. |
| 15 | PR-1/1.5/2/3 require human signoff regardless of CI | **Stage 1 — focused bug-fix slice, signoff не требуется** (master §0.5.5 категория). Stages 2-6 требуют signoff explicitly. |
| 16 | `EffectFamilyId` ⊥ `EffectId` | Не трогаем. |

## 2. Repro & evidence (Stage 1 — Bug D)

### 2.1. Симптом

Юзер: «Поправь код в репозитории и прогони нужные проверки **локально** перед завершением.» (из `src/platform/recipe/planner.test.ts:764` — реальный prompt в golden-set).

Текущая legacy-classifier цепочка:

1. `classifyTaskForDecision` → `taskContract.primaryOutcome = clarification_needed` (или эквивалент) с `ambiguities = ["external operation is inferred without an explicit publish target"]` или `"blocking: publish target is not specified"`.
2. `ambiguity-policy.ts::buildAmbiguityProfile` → kind=`blocking` (regex `BLOCKING_DETAIL_RE` matches `\bpublish target\b`).
3. `qualification-confidence.ts::resolveLowConfidenceStrategy` → `'clarify'`.
4. Production decision → `lowConfidenceStrategy='clarify'` → reply: «Куда опубликовать/задеплоить?»

Юзер уже сказал «локально» — IntentContractor парсит это в `SemanticIntent.target.kind = 'workspace'` (или `constraints.hosting = 'local'`, в зависимости от LLM-конкретики). Но frozen classifier pipeline эту структурную информацию не консьюмит.

### 2.2. Codepath trace (clarify over-blocking)

1. **`src/platform/decision/run-turn-decision.ts::runTurnDecision`** запускает `legacy = classifyTaskForDecision(...)` и `shadow = runShadowBranch(input)` параллельно.
2. **`runShadowBranch`** (`src/platform/decision/run-turn-decision.ts:188`) запускает `IntentContractor` → `SemanticIntent` (содержит target/constraints), затем `ShadowBuilder.build(intent)` → `ShadowBuildResult`. **Intent отбрасывается** после построения commitment-а — не доступен на верхнем уровне `runTurnDecision`.
3. **`legacyDecision.plannerInput.decisionTrace.contracts.ambiguityProfile`** содержит `[{ reason: "...publish target...", kind: "blocking", blocksClarification: true }]`.
4. **Production decision**: т.к. `effect_not_eligible` (cutover-2 включает только chat-effects + persistent_session.created, не workspace_change), gate возвращает `gate_out` → `productionDecision = legacyDecision` (с `kernelFallback=true`). Legacy clarify сохраняется.
5. **Юзер видит ненужный clarify**.

### 2.3. Что уже покрыто и почему недостаточно

| Source | Покрыто чем | Не покрывает |
| --- | --- | --- |
| Affordance allowlist gate | `createPolicyGate({cfg})` (PR-4b, `policy-gate.ts`) | Decision-level clarification downgrade — другая ось |
| Repeated-clarify suppression | `task-classifier.ts::suppressRepeatedClarification` (frozen) | Только повторные туркi той же темы; не работает на первом turn-е |
| Classifier downgrade rules | `task-classifier.ts::normalizeTaskContract` (frozen) | Не читает `SemanticIntent` (он живёт на kernel-стороне; classifier — frozen layer) |

Bug D — это прямое следствие архитектурной decoupling-и: classifier изолирован от kernel intent. Решение — НЕ модифицировать classifier (frozen), а **post-process** legacy decision на уровне `runTurnDecision` через policy-driven gate.

## 3. Hypothesis

**H1 (основная)**: Когда `SemanticIntent` несёт явный local-deployment signal (структурно: `target.kind === 'workspace'` ИЛИ `constraints[<curated key>]` ∈ {`local`, `localhost`, `local_machine`}) И legacy classifier emit-ит blocking ambiguity по publish/deployment target, downgrade clarify → answer **безопасен** и устраняет ненужный turn. Никакого riskа выполнить деструктивный effect — Stage 1 НЕ меняет execution mode (только interactionMode + primaryOutcome для answer-формирования).

**H2**: Решение через orthogonal gate (`createClarificationPolicy` ≠ `createPolicyGate`) **архитектурно чище**, чем расширение `POLICY_GATE_REASONS` третьим кодом. Аргумент: existing `canUseAffordance` operates на pair `(intent, affordance)` для affordance selection; clarification operates на `(intent, blockingReasons)` для legacy classifier post-processing. Разные оси concerns. Frozen reverse-test PR-4b (`POLICY_GATE_REASONS === ['channel_disabled','no_credentials']`) остаётся неизменным — invariant scope-creep guard работает.

**H3 (deferred)**: Stages 2-6 (approvals/budgets/role-based/retry/escalation) расширят `POLICY_GATE_REASONS` (или introducе новые orthogonal sets — TBD per stage). Каждая стадия — отдельный PR с maintainer signoff (invariant #15) — это master §8.5.1 architectural baseline.

## 4. Scope-of-fix matrix (Stage 1)

| # | Слой | Файл | Изменение | LOC оценка | Frozen? | Invariant |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Commitment policy (orthogonal gate) | `src/platform/commitment/clarification-policy.ts` | NEW: `CLARIFICATION_POLICY_REASONS`, `ClarificationPolicyReader`, `createClarificationPolicy` | ~120 | НЕТ | #5, #8 |
| 2 | Commitment public surface | `src/platform/commitment/index.ts` | export новых символов | ~10 | НЕТ | — |
| 3 | Decision wiring | `src/platform/decision/run-turn-decision.ts` | inject ClarificationPolicyReader; refactor `runShadowBranch` чтобы возвращать `intent`; downgrade на legacy fallback path | ~60 | НЕТ | #5, #6, #8 |
| 4 | Decision trace marker | `src/platform/decision/trace.ts` | optional `clarificationPolicy?: { downgradeReason }` поле | ~5 | **ДА (frozen)** | #11 (label `compatibility` mandatory; observability-only — не новая orchestration-семантика) |
| 5 | Tests — gate unit | `src/platform/commitment/__tests__/clarification-policy.test.ts` | NEW: reverse-test + 5-7 cases | ~150 | НЕТ | — |
| 6 | Tests — runtime integration | `src/platform/decision/run-turn-decision.clarification-downgrade.test.ts` | NEW: end-to-end downgrade + negative cases | ~200 | НЕТ | — |

**Итого:** ~545 LOC. Один frozen-layer файл (`trace.ts`), label `compatibility` обязателен в PR body. Out-of-scope для Stage 1 — все остальные `commitment/` файлы (`policy-gate.ts`, `affordance-registry.ts`, `monitored-runtime.ts` etc), 4 frozen production call-sites, 5 frozen decision contracts.

## 5. Acceptance criteria (Stage 1)

1. `CLARIFICATION_POLICY_REASONS` — frozen array `['ambiguity_resolved_by_intent']`. Reverse-test ассертит exact set + `Object.isFrozen` + push-throws.
2. `createClarificationPolicy({cfg})` возвращает `ClarificationPolicyReader` совместимый с инъекцией в `runTurnDecision`.
3. Positive case (target=workspace + blocking publish-target reason): `evaluate()` → `{ shouldClarify: false, downgradeReason: 'ambiguity_resolved_by_intent' }`.
4. Positive case (constraints.hosting='local' + blocking publish-target reason): то же.
5. Negative case (только intent signal, без blocking reason): `shouldClarify: true`.
6. Negative case (только blocking reason, без intent signal): `shouldClarify: true`.
7. Negative case (blocking reason — credentials/approval/permission, не deployment): `shouldClarify: true` даже при local intent (gate — strictly deployment-ambiguity scope).
8. End-to-end: при downgrade — `productionDecision.taskContract.primaryOutcome === 'answer'`, `interactionMode === 'respond_only'`, `lowConfidenceStrategy !== 'clarify'`. Trace содержит `clarificationPolicy.downgradeReason === 'ambiguity_resolved_by_intent'`.
9. End-to-end negative: legacy clarify + intent без local signal → production decision identical to legacy (downgrade off). Никакого silent change.
10. **Kernel-derived path priority**: если `productionDecision === kernel-derived` (cutover-eligible + commitmentSatisfied), clarification gate не вмешивается — kernel sourceOfTruth не перезаписывается.
11. Никакого нового phrase-matching на `UserPrompt`/`RawUserTurn` (invariant #5). Все checks работают на `SemanticIntent` (структура) и `AmbiguityProfileEntry.reason` (classifier output, не user input).
12. `pnpm tsgo` clean; targeted vitest green; `lint:commitment:no-raw-user-text-import` / `lint:commitment:no-decision-imports` / `lint:commitment:no-classifier-imports` — все green.
13. `node scripts/check-frozen-layer-label.mjs` (BASE_REF=origin/dev, PR_BODY="- [x] compatibility") → exit 0.
14. PR body содержит explicit disclaimer: "approvals/budgets/role-based PolicyGate **не** в scope этого PR — Stages 2+ см. в `commitment_kernel_policy_gate_full.plan.md`, требуют отдельный PR + invariant #15 signoff".
15. **Bit-identical regression на frozen layer**: `pnpm vitest run src/platform/decision/task-classifier.test.ts src/platform/decision/qualification-confidence.test.ts src/platform/decision/ambiguity-policy.test.ts` — все green без изменений.

## 6. Implementation notes (Stage 1)

### 6.1. Curated structural keys (intent constraints)

```ts
// src/platform/commitment/clarification-policy.ts
const LOCAL_DEPLOYMENT_KEYS = ["hosting", "deploymentTarget", "executionTarget"] as const;
const LOCAL_DEPLOYMENT_VALUES = new Set(["local", "localhost", "local_machine"]);
```

Эти ключи — closed allowlist. Расширение требует отдельного review (commit-level, не silent). НЕ regex-pattern: жёсткий equality на trimmed lowercase value.

### 6.2. Curated blocking-reason matchers (classifier output)

```ts
const DEPLOYMENT_BLOCKING_REASON_PATTERNS = [
  "publish target",
  "deployment target",
  "production target",
  "without an explicit publish target",
] as const;
```

Эти строки уже emit-ятся `qualification-confidence.ts::inferQualificationAmbiguityReasons` и подмножеством `BLOCKING_DETAIL_RE` (`ambiguity-policy.ts`). Это classifier OUTPUT — мы matche-имся на структурно стабильном тексте, не на user input. Invariant #5 не нарушен.

### 6.3. Decision shape (orthogonal к PolicyGateDecision)

```ts
export type ClarificationPolicyDecision =
  | { readonly shouldClarify: true }
  | { readonly shouldClarify: false; readonly downgradeReason: ClarificationPolicyReason };

export interface ClarificationPolicyReader {
  evaluate(params: {
    readonly intent: SemanticIntent;
    readonly blockingReasons: readonly string[];
  }): ClarificationPolicyDecision | Promise<ClarificationPolicyDecision>;
}
```

Sync/async — mirror existing `PolicyGateReader.canUseAffordance`. Stage 1 implementation полностью sync.

### 6.4. Downgrade transformation (run-turn-decision.ts)

```ts
function downgradeClarifyToAnswer(
  legacy: ClassifiedTaskResolution,
  downgradeReason: ClarificationPolicyReason,
): ClassifiedTaskResolution {
  const previousTrace = legacy.plannerInput.decisionTrace;
  const decisionTrace: DecisionTrace = {
    version: 1,
    ...previousTrace,
    clarificationPolicy: { downgradeReason },
  };
  const taskContract = legacy.plannerInput.taskContract && {
    ...legacy.plannerInput.taskContract,
    primaryOutcome: "answer",
    interactionMode: "respond_only",
  };
  const plannerInput = {
    ...legacy.plannerInput,
    ...(taskContract ? { taskContract } : {}),
    lowConfidenceStrategy: undefined,
    decisionTrace,
  };
  return { ...legacy, plannerInput };
}
```

NB. Точная shape `plannerInput` зависит от `ClassifiedTaskResolution` — в имплементации читать прямо из типа, не угадывать. Если `lowConfidenceStrategy` обязательно, использовать literal-undefined аккуратно.

### 6.5. Non-disruption на kernel-derived path

```ts
// runTurnDecision (после legacy + shadow готовы):
const isKernelDerived = isCutoverGatePassed(...);
let productionDecision = isKernelDerived
  ? deriveDecisionFromCommitment(...)
  : attachLegacyFallbackTrace(...);

// Clarification downgrade применяется ТОЛЬКО на legacy fallback path.
if (!isKernelDerived && shouldDowngrade(...)) {
  productionDecision = downgradeClarifyToAnswer(productionDecision, ...);
}
```

Это сохраняет invariant #3 (kernel-derived success — kernel sourceOfTruth, не post-processed).

## 7. Handoff Log

### 2026-04-29 — Bootstrap audit (Stage 1)

Прочитано:

- Master §0 PR Progress Log (Bug A merged `7f56fbd9ab` 2026-04-29, next gate включает Bug D), §0.5.3 G-table (G6.c остаётся open до full PolicyGate), §8.5.1 PolicyGate split (minimum vs full), §16 final direction lock.
- `commitment_kernel_pr4_chat_effects_cutover.plan.md` Wave B baseline (`createPolicyGate({cfg})`, frozen reverse-test, current `POLICY_GATE_REASONS=['channel_disabled','no_credentials']`).
- `.cursor/rules/commitment-kernel-invariants.mdc` (16 hard invariants — особенно #2, #5, #6, #11, #15).
- `commitment_kernel_streaming_leak.plan.md` (template для provenance/scope/handoff).
- Code (read-only): `src/platform/commitment/policy-gate.ts` (208 LOC, current shape), `src/platform/commitment/shadow-builder-impl.ts` (`PolicyGateReader` interface + decision shape), `src/platform/commitment/intent-contractor-impl.ts` (`SemanticIntent` shape + constraints structural keys), `src/platform/commitment/semantic-intent.ts` (TargetRef union), `src/platform/decision/ambiguity-policy.ts` (`AmbiguityProfileEntry`, `BLOCKING_DETAIL_RE`), `src/platform/decision/qualification-confidence.ts` (`inferQualificationAmbiguityReasons` emits "publish target" string), `src/platform/decision/task-classifier.ts` (frozen — `clarification_needed` flow line ~736), `src/platform/decision/run-turn-decision.ts` (`runShadowBranch` discards intent, `runTurnDecision` doesn't post-process legacy clarify), `src/platform/decision/trace.ts` (frozen `DecisionTrace` shape), `scripts/check-frozen-layer-label.mjs` (`FROZEN_LAYER_PATTERNS`).

Findings:

1. `POLICY_GATE_REASONS` (PR-4b, frozen reverse-test) — ровно 2 кода. Расширение третьим кодом сломает reverse-test и потенциально вводит scope creep в affordance-gate. → Решение: orthogonal `CLARIFICATION_POLICY_REASONS` set с собственным reverse-test.
2. `runShadowBranch` теряет `SemanticIntent` после построения commitment-а. → Stage 1 refactors internal API чтобы возвращать `{ result, intent }` без изменения внешнего API `runTurnDecision`.
3. `legacyDecision.plannerInput.decisionTrace.contracts.ambiguityProfile` уже содержит `AmbiguityProfileEntry[]` с `kind: 'blocking' | 'preference' | 'missing_optional_detail'` + `blocksClarification: boolean`. → Source-of-truth для `blockingReasons` extraction.
4. `trace.ts` находится в `FROZEN_LAYER_PATTERNS` (`scripts/check-frozen-layer-label.mjs:11`). → PR обязан содержать `- [x] compatibility` в body.
5. `ambiguity-policy.ts` НЕ в `FROZEN_LAYER_PATTERNS`, но `decision-layer-frozen.mdc` рекомендует не добавлять "новые phrase guards" — Stage 1 не меняет ambiguity-policy regex; matching на blocking reasons происходит в новом `clarification-policy.ts` файле через separate curated list (`DEPLOYMENT_BLOCKING_REASON_PATTERNS`).
6. Adjacent bugs (A.2 buffering, B, F): scope-creep предотвращён — каждый получит свой sub-plan.

Scope check (Stage 1):

- Frozen layer: затронут ОДИН файл — `trace.ts` (observability-only field). Label `compatibility` обязателен в PR body.
- 4 frozen call-sites: НЕ затронуты.
- 5 frozen decision contracts: НЕ затронуты (TaskContract/OutcomeContract/QualificationExecutionContract/ResolutionContract/RecipeRoutingHints не получают новых полей; `clarificationPolicy` живёт в `DecisionTrace`, не в TaskContract).
- `src/platform/commitment/policy-gate.ts`: НЕ модифицируется (`POLICY_GATE_REASONS` остаётся frozen на 2 кодах).

Hard invariants check (Stage 1, 16 hard):

- #5 (no phrase-rule on UserPrompt outside whitelist): matchers Stage 1 работают на (а) структурных полях `SemanticIntent`, (б) classifier-OUTPUT строках. Никакого regex по prompt/RawUserTurn.
- #6 (IntentContractor sole reader of raw user text): не трогаем; consume-им готовый `SemanticIntent`.
- #8 (commitment ↛ decision): новый `clarification-policy.ts` живёт в commitment/, импортирует только из commitment/ (semantic-intent, ids). Зависимость идёт от `decision/run-turn-decision.ts` к `commitment/clarification-policy.ts` — это разрешённое направление.
- #11 (5 frozen contracts): не вводим новых orchestration-semantic полей в frozen contracts.
- #15 (human signoff): Stage 1 — focused bug-fix slice, signoff не требуется (master §0.5.5 категория). Stages 2-6 — signoff обязателен.

Дальнейший order (Stage 1): stage1-clarification-gate-impl → stage1-runtime-wiring → stage1-trace-marker → stage1-tests → stage1-tsgo-and-lint → stage1-commit-and-pr → stage1-handoff-and-master-row.

## 8. Adjacent bugs (NOT in scope; tracked for future sub-plans)

| Order | Bug | Симптом | Приоритет | Будущий sub-plan |
| --- | --- | --- | --- | --- |
| 1 | **A.2 — Block-streaming buffering при tool_call в turn'е** | Когда `blockStreamingEnabled=on` и LLM делает tool_call посреди turn'а, intermediate assistant chunks утекают как separate messages в external. Single_final_user_facing_message_per_user_turn invariant НЕ обеспечивает буферизацию для случаев без `sessions_spawn`. | medium | `commitment_kernel_streaming_leak_buffering.plan.md` (TBD) |
| 2 | **B — TBD** | (master §0 PR log queue) | medium | TBD |
| 3 | **F — Persistent worker subsequent push** | Cron-driven daily push'ы из persistent_worker'а в внешний канал | medium | `commitment_kernel_persistent_worker_push.plan.md` (TBD) |
| 4 | **PolicyGate Stages 2-6** | approvals / budgets / role-based / retry / escalation | high (до cutover-4) | этот же sub-plan, todos `stage2-*` … `stage6-*`, каждая стадия = отдельный PR + signoff |

## 9. References

- Master: `.cursor/plans/commitment_kernel_v1_master.plan.md` (§0 PR log, §0.5.3 G-table, §3 invariants, §6 freeze, §8.5.1 PolicyGate split, §16 next gate)
- PR-4b sub-plan: `.cursor/plans/commitment_kernel_pr4_chat_effects_cutover.plan.md` (Wave B baseline — minimum PolicyGate)
- Bug A (template): `.cursor/plans/commitment_kernel_streaming_leak.plan.md` (provenance/scope-of-fix matrix/handoff log skeleton)
- Bug E (outbound sanitizer baseline): merge `15ccd4455d`
- Bug C (recipe routing publish): merge `9f6f8d8d3d`
- Hard invariants: master §3 (16 hard); rule `.cursor/rules/commitment-kernel-invariants.mdc` (always-applied)
- Decision-layer freeze: `.cursor/rules/decision-layer-frozen.mdc`
- Frozen layer pattern: `scripts/check-frozen-layer-label.mjs` (`FROZEN_LAYER_PATTERNS = ['src/platform/decision/task-classifier.ts','src/platform/decision/input.ts','src/platform/decision/trace.ts','src/platform/recipe/','src/platform/plugin.ts']`)
- Bootstrap rule: `.cursor/rules/pr-session-bootstrap.mdc`
- Scope guard rule: `.cursor/rules/commitment-kernel-scope.mdc`
- Existing PolicyGate impl: `src/platform/commitment/policy-gate.ts` (PR-4b, NOT touched in Stage 1)
- Existing PolicyGateReader interface: `src/platform/commitment/shadow-builder-impl.ts:13`
- Existing AmbiguityProfileEntry: `src/platform/decision/ambiguity-policy.ts` + emitted reasons in `src/platform/decision/qualification-confidence.ts:48`

---

**Stop gate (Stage 1):** signoff не требуется (focused bug-fix slice). Stages 2-6 — signoff invariant #15 обязателен per master plan §8.5.1. Каждая стадия — отдельный PR.
