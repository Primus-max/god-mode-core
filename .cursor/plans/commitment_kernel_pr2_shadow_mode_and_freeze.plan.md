---
name: PR-2 — IntentContractor + ShadowBuilder + Five-Layer Freeze
overview: Реальный IntentContractor (LLM call -> SemanticIntent), реальный ShadowBuilder (intent -> ExecutionCommitment | typed unsupported), unified runTurnDecision entry point, заполнение DecisionTrace.shadowCommitment на каждом turn-е, расширение decision-eval на shadow comparison + 4 quant-метрики, affordance_branching_factor telemetry, CI label-check на пять frozen layers. Production routing по-прежнему на legacy.
todos:
  - id: intent-contractor-impl
    content: Реализовать IntentContractor через LLM call со structured output, schema validation, branded result. EffectFamilyId resolved из вспомогательного registry, не direct mapping. Никакого phrase-rule fallback.
    status: completed
  - id: shadow-builder-impl
    content: Реализовать ShadowBuilder. Вход — SemanticIntent. Внутри — Affordance candidates lookup (read-only registry для cutover-1 effect family), один candidate -> kind=commitment; ноль/много -> kind=unsupported с типизированным reason.
    status: completed
  - id: run-turn-decision-entry
    content: Создать src/platform/decision/run-turn-decision.ts. Принимает RawUserTurn + decision context, возвращает { legacyDecision, shadowCommitment }. Внутри — параллельные ветки legacy classifyTaskForDecision и shadow IntentContractor + ShadowBuilder. Никакого взаимного влияния.
    status: completed
  - id: callsite-migration
    content: Перевести три callsite (src/platform/plugin.ts x2, src/platform/decision/input.ts x2) на runTurnDecision. Legacy classifyTaskForDecision остаётся API; новый wrapper вызывает её внутри. agent-command.ts оценить отдельно (если он напрямую трогает classifier).
    status: completed
  - id: trace-shadow-fill
    content: Заполнить DecisionTrace.shadowCommitment в runTurnDecision. Если shadow вернул error (LLM timeout) — записать typed reason, не throw. Production legacy путь должен оставаться идемпотентным.
    status: completed
  - id: decision-eval-shadow
    content: Расширить scripts/dev/decision-eval.ts на shadow comparison output. Side-by-side legacy outcome + shadow commitment. Считать commitment_correctness, false_positive_success (= 0 на этом этапе всегда — production legacy), state_observability_coverage (mock observer), divergence count.
    status: completed
  - id: branching-factor-telemetry
    content: На каждом ShadowBuilder.build залогировать в trace affordance_branching_factor — сколько candidate Affordances матчится для (effect_family + target). Canary для invariant
    status: completed
  - id: bit-identical-snapshot-still-green
    content: PR-1 anchor test bit-identical-snapshot.test.ts должен оставаться green. Legacy results не должны измениться.
    status: completed
  - id: lint-no-classifier-import-from-commitment
    content: Добавить scripts/check-no-classifier-imports-from-commitment.mjs (можно как extension существующего no-decision-imports, но семантически отдельный rule). Hard invariant
    status: completed
  - id: ci-frozen-layer-label-check
    content: Добавить .github/workflows/check-frozen-layer-label.yml + scripts/check-frozen-layer-label.mjs. PR трогает один из пяти frozen-layer файлов (см. master §6.2) -> требует label-trigger в PR template (telemetry-only / bug-fix / compatibility / emergency-rollback). Без label -> CI fail.
    status: completed
  - id: tests
    content: Vitest tests на IntentContractor (LLM mock), ShadowBuilder (synthetic SemanticIntent fixtures), runTurnDecision (legacy + shadow в параллели; shadow error не ломает legacy), check-frozen-layer-label.mjs (touch frozen file без label -> exit 1; с label -> exit 0).
    status: completed
  - id: human-signoff
    content: Maintainer signoff против master invariants
    status: completed
isProject: false
---

# PR-2 — IntentContractor + ShadowBuilder + Five-Layer Freeze (Sub-Plan)

## 0. Provenance & Inheritance


| Field                     | Value                                                      |
| ------------------------- | ---------------------------------------------------------- |
| Sub-plan of               | `commitment_kernel_v1_master.plan.md` (§8.3)               |
| Inherits                  | 16 hard invariants + 6 flexible (без изменений)            |
| Production routing change | **none** (shadow mode only; legacy остаётся authoritative) |
| Estimated effort          | 1-2 недели кода + ~неделя review                           |
| Exit gate                 | Human maintainer signoff (hard invariant #15)              |


Любое ослабление invariants — revision мастер-плана, не этого sub-plan.

---

## 1. Goal of This PR

Включить **shadow mode** для commitment kernel: на каждом turn-е параллельно с legacy decision рассчитывается `shadowCommitment` (ExecutionCommitment либо typed unsupported), пишется в `DecisionTrace`, наблюдается в `decision-eval`. Production по-прежнему слушает legacy. Это даёт N>=30 turns исторических данных к моменту PR-3 cutover gate measurement.

Параллельно фиксируем freeze для legacy contracts: пять frozen layers (master §6.2) больше не могут получать новые orchestration-semantics поля без явного label-а в PR template.

---

## 2. Files To Create / Modify

### 2.1. Create


| File                                                                                                                                          | Purpose                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/platform/commitment/effect-family-registry.ts`                                                                                           | Закрытый mapping `EffectFamilyId` -> human-readable name + допустимые `OperationHint` kinds. Используется IntentContractor для schema validation и ShadowBuilder для candidate lookup. |
| `src/platform/commitment/affordance-registry.ts`                                                                                              | Read-only registry известных Affordances. PR-2 заводит **один** affordance: `persistent_session.created`. Catalog-расширение — PR-3.                                                   |
| `src/platform/commitment/shadow-builder-impl.ts`                                                                                              | Реальная реализация `ShadowBuilder` (отдельный файл рядом со skeleton-ом; skeleton остаётся для unit-тестов).                                                                          |
| `src/platform/commitment/intent-contractor-impl.ts`                                                                                           | Реальная реализация `IntentContractor` через LLM call.                                                                                                                                 |
| `src/platform/decision/run-turn-decision.ts`                                                                                                  | Unified entry point (см. §5). Параллельный запуск legacy + shadow.                                                                                                                     |
| `scripts/check-no-classifier-imports-from-commitment.mjs`                                                                                     | Hard invariant #1: commitment не импортит legacy classifier output.                                                                                                                    |
| `scripts/check-frozen-layer-label.mjs`                                                                                                        | CI label-check (см. §8).                                                                                                                                                               |
| `.github/workflows/check-frozen-layer-label.yml`                                                                                              | GitHub Action wiring.                                                                                                                                                                  |
| Test files: `intent-contractor-impl.test.ts`, `shadow-builder-impl.test.ts`, `run-turn-decision.test.ts`, `check-frozen-layer-label.test.ts`. | Vitest coverage.                                                                                                                                                                       |


### 2.2. Modify


| File                                                                      | Edit                                                                                                                                 |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `src/platform/commitment/index.ts`                                        | Re-export реальных IntentContractor/ShadowBuilder factory functions. Skeleton остаётся для PR-3 fallback на unsupported.                       |
| `src/platform/commitment/affordance.ts`                                   | Добавить поле `readonly allowedConstraintKeys: readonly string[]` к `Affordance` (§4.3 schema для `pickAllowedConstraints`).                   |
| `src/platform/plugin.ts` (line 76, 332)                                   | Заменить `classifyTaskForDecision({ prompt, ... })` на `runTurnDecision({ prompt, ... })`. Сигнатура `prompt: string` идентична — миграция точечная. `legacyDecision` остаётся authoritative. |
| `src/platform/decision/input.ts` (line 443, 478)                          | То же.                                                                                                                                                                                          |
| `src/config/types.agent-defaults.ts` + `zod-schema.agent-defaults.ts`     | Добавить опциональный `intentContractor?` блок в `agentDefaults.platform` симметрично существующему `taskClassifier?` (см. §3.2 shape).        |
| `scripts/check-no-raw-user-text-import.mjs`                               | Расширить whitelist на `src/platform/commitment/intent-contractor-impl.ts` (см. §3.5).                                                         |
| `scripts/check-no-prompt-parsing.mjs`                                     | Расширить scope на `src/platform/commitment/intent-contractor-impl.ts` (no regex / no substring matching на `RawUserTurn.text`).               |
| `scripts/dev/decision-eval.ts` + `task-contract-eval/cases/*`             | Расширить runner на shadow comparison (см. §6); добавить `expectedShadowEffect?: EffectId` к scenario type; разметить cutover-1 pool.          |
| `scripts/dev/task-contract-eval/__tests__/bit-identical-snapshot.test.ts` | Расширить sliced-фильтр: исключить поле `shadow` из сравнения (как `generatedAt`/`casesPath` в PR-1). Legacy results должны остаться green.    |
| `package.json`                                                            | Добавить `lint:commitment:no-classifier-imports` к aggregate `check`.                                                                          |


### 2.3. Не трогаем (out of scope)

- `src/platform/decision/task-classifier.ts` (frozen, см. master §6.2 — emergency-only).
- Affordance catalog beyond `persistent_session.created` (PR-3).
- `SessionWorldState` observer (PR-3).
- `commitmentSatisfied` runtime gate (PR-3).
- Любая cutover migration (PR-3+).

---

## 3. IntentContractor — Real Implementation

### 3.1. Adapter pattern (повторяет `TaskClassifierAdapter`)

Используем существующий repo-pattern `TaskClassifierAdapter` (см. `src/platform/decision/task-classifier.ts:540-573`, `:1383` PiTaskClassifierAdapter, `:1563` resolveTaskClassifierAdapter). Для shadow-слоя заводим симметричный `IntentContractorAdapter`. Production-backend — `pi-simple` через `completeSimple` из `@mariozechner/pi-ai` (тот же стек, что у task-classifier; нет новых dev-deps). DI hook — `adapterRegistry?` параметр; в decision-eval тестах подменяется на mock.

```ts
// src/platform/commitment/intent-contractor-impl.ts

export type IntentContractorAdapter = {
  classify(params: {
    prompt: string;                    // string (НЕ RawUserTurn) — бренд живёт внутри adapter, не торчит наружу
    fileNames: readonly string[];
    ledgerContext?: string;
    config: ResolvedIntentContractorConfig;
    cfg: OpenClawConfig;
    onDebugEvent?: (event: IntentContractorDebugEvent) => void;
  }): Promise<SemanticIntent>;
};

export type ResolvedIntentContractorConfig = {
  readonly enabled: boolean;
  readonly backend: string;          // default: "pi-simple"
  readonly model: string;            // default: "hydra/gpt-5-mini"
  readonly timeoutMs: number;        // default: 15_000
  readonly maxTokens: number;        // default: 400
  readonly confidenceThreshold: number; // default: 0.6
};

class PiIntentContractorAdapter implements IntentContractorAdapter { /* completeSimple + zod schema validate */ }

export function resolveIntentContractorAdapter(
  backend: string,
  registry: Readonly<Record<string, IntentContractorAdapter>> = {},
): IntentContractorAdapter | undefined {
  if (registry[backend]) return registry[backend];
  if (backend === "pi-simple") return new PiIntentContractorAdapter();
  return undefined;
}
```

### 3.2. Config wiring

Расширяем `agentDefaults.platform` (см. `src/config/types.agent-defaults.ts:189-199` `taskClassifier?` shape) симметричным блоком `intentContractor?`:

```ts
intentContractor?: {
  enabled?: boolean;          // default: true в shadow mode
  backend?: string;           // default: "pi-simple"
  model?: string;             // default: "hydra/gpt-5-mini"
  timeoutMs?: number;         // default: 15_000 (короче чем classifier 20_000 — shadow не блокирует production)
  maxTokens?: number;         // default: 400
  confidenceThreshold?: number; // default: 0.6 — порог в ShadowBuilder §4.1
};
```

Defaults — константы рядом с adapter-ом (`DEFAULT_INTENT_CONTRACTOR_BACKEND = "pi-simple"`, `DEFAULT_INTENT_CONTRACTOR_MODEL = "hydra/gpt-5-mini"`, `DEFAULT_INTENT_CONTRACTOR_TIMEOUT_MS = 15_000`, `DEFAULT_INTENT_CONTRACTOR_MAX_TOKENS = 400`, `DEFAULT_INTENT_CONTRACTOR_CONFIDENCE_THRESHOLD = 0.6`). Зеркало constants в `task-classifier.ts:46-49`.

### 3.3. Classify flow

Adapter принимает `prompt: string`. **Первой строкой** внутри `PiIntentContractorAdapter.classify` происходит брендирование: `const rawTurn = makeRawUserTurn(prompt)` (smart constructor из `commitment/raw-user-turn.ts`). Дальше весь impl оперирует `rawTurn`. Бренд `RawUserTurn` существует только внутри файла `intent-contractor-impl.ts` — наружу не торчит.

1. `const rawTurn = makeRawUserTurn(params.prompt)` — единственная точка брендирования в системе.
2. Build structured-output prompt (system + user) с inline JSON schema из `effect-family-registry.ts` (whitelisted `EffectFamilyId`s + `OperationHint.kind` enum). Body использует `rawTurn.text`.
3. `completeSimple({ model, messages, jsonSchema, timeoutMs, maxTokens })` -> `TextContent`.
4. `zod`-validate JSON против shape `{ desiredEffectFamily: enum, target: TargetRef, operation?, constraints: object, uncertainty: string[], confidence: number }`.
5. **Branded conversion**: `desiredEffectFamily as EffectFamilyId` только если value есть в registry. Иначе → `desiredEffectFamily: 'unknown' as EffectFamilyId`, `uncertainty: [...prev, 'family_not_in_registry']`, `confidence: 0`.
6. **На LLM error / timeout / schema fail** → low-confidence intent: `{ desiredEffectFamily: 'unknown' as EffectFamilyId, target: { kind: 'unspecified' }, constraints: {}, uncertainty: ['llm_error'|'llm_timeout'|'schema_validation_failed'], confidence: 0 }`. Никогда не throw — production legacy ветка не должна получать exception из shadow слоя (см. §5.2).

### 3.4. EffectFamilyId seed list (PR-2)

`effect-family-registry.ts` объявляет ровно два значения для PR-2:

- `'persistent_session'` — единственная cutover-1 family. Допустимые `OperationHint.kind`: `'create' | 'observe' | 'cancel'`.
- `'unknown'` — sentinel для всех остальных turn-ов. Допустимые operation kinds: `[]` (любой OOD intent попадает сюда и в ShadowBuilder сразу даёт `unsupported.no_matching_affordance`).

Расширение списка — отдельный coordinated PR в paper trail (master §3 invariant #16: registry — единственный source of truth).

### 3.5. Hard invariants на этом слое

- **#5/#6**: `src/platform/commitment/intent-contractor-impl.ts` — единственный новый разрешённый importer `RawUserTurn`. Whitelist в `scripts/check-no-raw-user-text-import.mjs` обновляется до ровно трёх файлов:
  - `src/platform/commitment/raw-user-turn.ts` (definition site, PR-1)
  - `src/platform/commitment/intent-contractor.ts` (skeleton, PR-1)
  - `src/platform/commitment/intent-contractor-impl.ts` (real impl, PR-2)
  - **Decision/ слой (включая `run-turn-decision.ts`) в whitelist НЕ добавляется**. См. §5.1 — runTurnDecision принимает `prompt: string`, бренд не пересекает границу commitment/.
- **#16**: `desiredEffectFamily: EffectFamilyId`, не `EffectId`. Прямой carry-over в commitment запрещён на типах.

> Note: invariant #7 («signature принимает только `SemanticIntent`») относится к `ShadowBuilder.build`, не к `IntentContractor.classify`. На входе IntentContractor стоит `prompt: string` — это сознательный выбор, чтобы избежать каскада whitelist-расширений в decision/plugin/input layers. Бренд `RawUserTurn` остаётся internal hardening внутри intent-contractor-impl.ts.

### 3.6. No phrase-rules / no regex

Любой regex / substring / phrase-table внутри `intent-contractor-impl.ts` — architectural fail. Классификация — только через LLM (или, опционально, через hindsight replay в test fixtures). Enforced ревью + расширение `scripts/check-no-prompt-parsing.mjs` на новый файл.

---

## 4. ShadowBuilder — Real Implementation

### 4.1. Contract

```ts
export function createShadowBuilder(deps: {
  readonly affordances: AffordanceRegistry;
  readonly policy: PolicyGateReader;
  readonly logger: Logger;
  readonly confidenceThreshold: number; // взят из cfg.platform.intentContractor.confidenceThreshold ?? 0.6
}): ShadowBuilder;
```

`build(intent: SemanticIntent): Promise<ShadowBuildResult>`:

1. **Low-confidence guard**: `intent.confidence < deps.confidenceThreshold` (config-default 0.6, см. §3.2) -> `{ kind: 'unsupported', reason: 'low_confidence_intent' }`.
2. **Candidate lookup**: `affordances.findByFamily(intent.desiredEffectFamily, intent.target, intent.operation)` -> `readonly Affordance[]`.
3. **Branching factor telemetry**: log `affordance_branching_factor: candidates.length` в trace (см. §7).
4. **Resolution**:
  - 0 candidates -> `{ kind: 'unsupported', reason: 'no_matching_affordance' }`.
  - 1 candidate -> attempt commitment build (см. §4.2). На policy reject -> `policy_blocked`. На budget exceed -> `budget_exceeded`.
  - > 1 candidates -> в PR-2 это автоматически `{ kind: 'unsupported', reason: 'no_matching_affordance' }` с `uncertainty: ['multiple_candidates']`. Для cutover-1 граф намеренно spec-narrow (`persistent_session.created` — единственный affordance в PR-2). Если в shadow появляется >1 — это сигнал к расширению invariant #16 enforcement, не routing decision.

### 4.2. Commitment build (single candidate path)

Один candidate `Affordance`:

```ts
const commitment: ExecutionCommitment = {
  id: newCommitmentId(),
  effect: candidate.effect,
  target: resolveCommitmentTarget(candidate, intent),
  constraints: pickAllowedConstraints(intent.constraints, candidate),
  budgets: candidate.defaultBudgets,
  requiredEvidence: candidate.requiredEvidence,
  terminalPolicy: candidate.terminalPolicy ?? 'fail_open_with_audit',
};
```

### 4.3. `pickAllowedConstraints` — concrete schema

Расширяем `Affordance` (модификация `src/platform/commitment/affordance.ts`, добавлено в §2.2):

```ts
export type Affordance = {
  // ... existing fields ...
  readonly allowedConstraintKeys: readonly string[]; // PR-2: closed list per-affordance
};
```

`persistent_session.created` PR-2 entry — `allowedConstraintKeys: ['displayName', 'description', 'parentSessionKey']` (узкий whitelist; PR-3 расширяется по факту реальных turn-ов).

Импл (~10 строк):

```ts
function pickAllowedConstraints(
  intentConstraints: ReadonlyRecord<string, unknown>,
  affordance: Affordance,
): ReadonlyRecord<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of affordance.allowedConstraintKeys) {
    if (key in intentConstraints) out[key] = intentConstraints[key];
  }
  return Object.freeze(out);
}
```

Лишние ключи из intent -> ignored (не leak в commitment). Структурная защита: даже если IntentContractor LLM начнёт галлюцинировать новые поля constraints, они не доходят до commitment.

### 4.4. Hard invariants на этом слое

- **#1**: `commitment.effect: EffectId`, никакой backref на tool/recipe/route.
- **#7**: signature `build(intent: SemanticIntent)` — TS compile error если кто-то попытается передать `RawUserTurn` или `string`.
- **#10**: `donePredicate` лежит на `Affordance`, не копируется в commitment.
- **#14**: `ShadowBuildResult` — discriminated union; никакого null/throw для routing.
- **#16**: family -> effect только через registry candidate, не direct cast.

---

## 5. `runTurnDecision` Unified Entry Point

### 5.1. Contract

```ts
// src/platform/decision/run-turn-decision.ts
// Decision/ слой работает только с string-prompt. RawUserTurn НЕ импортируется.

export type RunTurnDecisionInput = {
  readonly prompt: string;             // string, не RawUserTurn — см. §3.5 note
  readonly cfg: OpenClawConfig;
  readonly ledgerContext?: string;
  readonly fileNames?: readonly string[];
  readonly classifierAdapterRegistry?: Readonly<Record<string, TaskClassifierAdapter>>;
  readonly intentContractorAdapterRegistry?: Readonly<Record<string, IntentContractorAdapter>>;
};

export type RunTurnDecisionResult = {
  readonly legacyDecision: ClassifiedTaskResolution; // existing type from task-classifier.ts
  readonly shadowCommitment: ShadowBuildResult;
  readonly traceId: TraceId;
};

export async function runTurnDecision(
  input: RunTurnDecisionInput,
): Promise<RunTurnDecisionResult>;
```

### 5.2. Internal flow + timing contract

Production-критичный путь — legacy. Shadow:

- запускается строго параллельно (`Promise.allSettled`),
- bounded внутренним таймаутом `intentContractor.timeoutMs` (default 15_000) — короче, чем classifier (20_000), чтобы p99 latency runTurnDecision определялся legacy веткой.
- На своём timeout / runtime error → typed `unsupported` (`shadow_timeout` / `shadow_runtime_error`), никогда не throw.

```
[input.prompt: string]
     |
     |---> legacy = classifyTaskForDecision({ prompt, ... })                  // primary, awaited
     |---> shadow = (async () => {
     |              const intent  = await intentContractor.classify({ prompt, ... });  // adapter брендирует внутри себя
     |              const result  = await shadowBuilder.build(intent);
     |              return { kind: 'commitment'|'unsupported', ... };
     |            })().catch(err => ({ kind: 'unsupported', reason: 'shadow_runtime_error' }));
     |
     |---> Promise.allSettled([legacy, shadow])
     |       -> legacy rejected   -> rethrow (production behavior preserved; bit-identical snapshot не должен задеть)
     |       -> shadow rejected   -> уже поглощено .catch выше (defensive double-guard)
     |
     |---> writeTrace({ legacyDecision, shadowCommitment })   // single sync write,
     |                                                         // shadow не блокирует legacy,
     |                                                         // но trace consumer видит обе ветки атомарно
     |
     v
[RunTurnDecisionResult { legacyDecision, shadowCommitment, traceId }]
```

**Timing decision** (закрывает open question «shadowCommitment write timing»):

- `runTurnDecision` await-ит обе ветки через `allSettled`. Это безопасно, т.к. shadow timeout (15s) ≤ legacy timeout (20s) — shadow всегда завершается раньше или одновременно.
- НЕТ fire-and-forget. Возврат сразу после legacy с последующей post-hook записью отвергнут: в decision-eval тесты (synchronous assertion на `trace.shadowCommitment`) теряли бы детерминизм.
- Production callers (`plugin.ts`, `input.ts`) используют только `legacyDecision`. Никакого read из `shadowCommitment` в production-code в PR-2 — это enforced ревью + comment в `runTurnDecision` exports.

### 5.3. Hard invariants на этом entry point

- **#5/#6**: `run-turn-decision.ts` НЕ импортит `RawUserTurn`. Передаёт `prompt: string` в IntentContractorAdapter, который брендирует внутри себя. Whitelist в `check-no-raw-user-text-import.mjs` остаётся 3 файла из §3.5.
- **#8/#11**: `run-turn-decision.ts` живёт в `src/platform/decision/`, импортит типы из `commitment/` (`SemanticIntent`, `ShadowBuildResult`, `IntentContractorAdapter`, `ShadowBuilder` factory) — allowed direction. Это единственное место в decision/, кроме `trace.ts`, где импорт из commitment/ разрешён.
- **#14**: shadow runtime error не сваливается в null — typed `unsupported` с reason `shadow_runtime_error` либо `shadow_timeout`.
- **Production preservation**: legacy ветка остаётся primary; bit-identical snapshot test должен остаться green.

---

## 6. `decision-eval` Shadow Comparison

### 6.1. Output расширение

Текущий runner пишет array `results: ScenarioResult[]`. PR-2 добавляет в каждый `ScenarioResult` поле:

```ts
shadow?: {
  readonly intent: SemanticIntent;
  readonly result: ShadowBuildResult;
  readonly branchingFactor: number;
  readonly divergence?: {
    readonly reason: 'shadow_unsupported_legacy_routed'
                    | 'shadow_committed_legacy_no_op'
                    | 'effect_mismatch'
                    | 'target_mismatch';
    readonly note: string;
  };
};
```

`bit-identical-snapshot.test.ts` сравнивает только `results[i].{...legacy fields}` — поле `shadow` исключается из сравнения (расширяем sliced-фильтр в snapshot test, как в PR-1 §7.3 fixed `generatedAt`/`casesPath`).

### 6.2. 4 метрики из master §8.3 exit criteria + scenario labeling

Расширяем тип scenario в decision-eval (`scripts/dev/task-contract-eval/cases/*.ts` или where-defined) одним опциональным полем:

```ts
export type DecisionEvalCase = {
  // ... existing fields ...
  /** PR-2: ground-truth shadow effect для cutover-1 pool. Undefined = scenario не размечен и не учитывается в commitment_correctness. */
  readonly expectedShadowEffect?: EffectId;
};
```

PR-2 размечает только cutover-1 pool (turns с явным «создай sub-agent» / «open persistent session»; ~5-10 cases) → `expectedShadowEffect: 'persistent_session.created' as EffectId`. Остальные ~N-10 turns остаются `undefined` и **исключаются из знаменателя** `commitment_correctness` (только OOD canary через divergence counter). Hand-labeling — отдельный коммит `chore(decision-eval): seed cutover-1 expectedShadowEffect labels` в день 7-8 implementation order, ревьювится maintainer-ом отдельно.


| Метрика                        | Расчёт в PR-2                                                                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commitment_correctness`       | Только над scenarios с `expectedShadowEffect !== undefined`: numerator = `shadow.result.kind === 'commitment' && shadow.result.value.effect === expectedShadowEffect`. denominator = labeled scenarios count. NaN если denominator=0. |
| `state_observability_coverage` | На mock observer (PR-2 не имеет реального): 100% если shadow завершился без runtime-error, иначе считается gap. PR-3 заменит mock на реальный observer.                                                                               |
| `false_positive_success`       | На этом этапе всегда `0` — production legacy, никакой commitmentSatisfied gate. Метрика начнёт работать в PR-3.                                                                                                                       |
| `divergence count`             | Counter с типизированными `reason` (см. shape выше). Не пороговая метрика, а dashboard.                                                                                                                                               |


### 6.3. Что НЕ считаем в PR-2

- `satisfaction_correctness` — нет observer (PR-3).
- `false_positive_success` real measurement — production не на shadow (PR-3 cutover gate).
- Six-metric quant gate as a whole — gate measurement в PR-3.

---

## 7. `affordance_branching_factor` Telemetry

Defended invariant #16 от деградации в lookup-таблицу. Каждый `ShadowBuilder.build` логирует:

```ts
trace.shadow.branchingFactor = candidates.length;
```

Анализ в `decision-eval`:

- avg branching factor across pool >= 1 (если 0 — affordance registry не покрывает intent space, расширять caller-side, не downgrade-ить guard).
- avg < 1.5 на старте OK (cutover-1 узкий по effect family).
- если в будущем avg >5 на pool — сигнал к расширению invariant #16 на discriminator (target subkind, riskTier, etc), не к removal.

Threshold-warnings в PR-2 — log only, не gate.

---

## 8. Five-Layer Freeze CI Label-Check

### 8.1. Файл `scripts/check-frozen-layer-label.mjs`

- Читает `git diff --name-only ${BASE_REF}...HEAD`.
- Сверяет с пятью путями (master §6.2).
- Если есть touch — парсит PR body (через `gh pr view --json body` либо env var в Actions) на наличие чек-марка одной из пяти labels:
  - `telemetry-only`
  - `bug-fix`
  - `compatibility`
  - `emergency-rollback`
  - `none of the above` (этот вариант — explicit refusal, тоже считается labeled, но тогда требует separate review).
- На отсутствие label — `process.exit(1)` с сообщением, какой файл/какой label требуется.

### 8.2. GitHub Action

```yaml
# .github/workflows/check-frozen-layer-label.yml
name: Check frozen layer label
on:
  pull_request:
    paths:
      - 'src/platform/decision/task-classifier.ts'
      - 'src/platform/decision/input.ts'
      - 'src/platform/decision/trace.ts'
      - 'src/platform/recipe/**'
      - 'src/platform/plugin.ts'
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - run: node scripts/check-frozen-layer-label.mjs
        env:
          PR_BODY: ${{ github.event.pull_request.body }}
          BASE_REF: ${{ github.event.pull_request.base.sha }}
```

### 8.3. Emergency clause (master invariant #12)

`emergency-rollback` label требует наличия в PR body upstream-tracking ticket (URL match) + retire deadline (`Retire-By: YYYY-MM-DD`). Без обоих — label не считается valid. Это enforced в check-script.

---

## 9. Exit Criteria — Checklist

- `runTurnDecision` живёт и используется во всех трёх callsite-ах.
- `DecisionTrace.shadowCommitment` заполняется на каждом turn-е (verified through Vitest test, не только через decision-eval).
- `decision-eval` runner выводит shadow comparison; 4 метрики считаются.
- PR-1 anchor `bit-identical-snapshot.test.ts` остаётся green (legacy `results` не изменились).
- `affordance_branching_factor` логируется в shadow trace.
- Two new lint check scripts работают (`no-classifier-imports`, `frozen-layer-label`).
- CI workflow `check-frozen-layer-label.yml` зелёный на текущем dev.
- Hard invariants #1, #5, #6, #7, #8, #11, #14 enforced на типах + lint.
- Hard invariant #16: `affordance-registry.ts` не имеет direct family->effect mapping; effect берётся из affordance candidate.
- Human signoff (#15).
- **Progress marker commit**: master frontmatter `pr2-shadow-mode-and-freeze` -> `completed`; §0 PR Progress Log + строка с merge SHA.

---

## 10. Implementation Order

1. **Day 1**: capture текущий decision-eval baseline (sanity — должен совпасть с PR-1 baseline; если нет — investigate перед началом).
2. **Day 1-2**: `effect-family-registry.ts`, `affordance-registry.ts` с одним affordance `persistent_session.created` + tests.
3. **Day 2-3**: `intent-contractor-impl.ts` + LLM mock + tests; whitelist update в `scripts/check-no-raw-user-text-import.mjs`.
4. **Day 3-4**: `shadow-builder-impl.ts` + tests на synthetic SemanticIntent fixtures (cutover-1 effect family + один OOD case на каждый unsupported reason).
5. **Day 4-5**: `run-turn-decision.ts` + tests (legacy passes-through + shadow runs in parallel + shadow runtime-error не ломает legacy).
6. **Day 5-6**: callsite migration (3 файла) + verify bit-identical snapshot осталась green.
7. **Day 6**: `decision-eval` runner расширение; metric calculation.
8. **Day 7**: `branching-factor-telemetry` integration в trace.
9. **Day 7-8**: `check-no-classifier-imports.mjs` + tests; добавить в `package.json` aggregate.
10. **Day 8-9**: `check-frozen-layer-label.mjs` + GitHub workflow + tests.
11. **Day 9-10**: end-to-end validation — manually run pnpm eval:decision, проверить shadow output, divergence reasons выглядят разумно.
12. **Day 10**: PR description + maintainer signoff request.
13. **Day 10**: progress marker commit (master + sub-plan flip + §0 row).

---

## 11. Risk Log


| Risk                                                                                | Mitigation                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shadow LLM call slows turn latency                                                  | runTurnDecision запускает legacy + shadow параллельно через `Promise.allSettled`. Production-side ждёт только legacy; shadow завершается асинхронно и пишется в trace через post-hook. См. §5.2. |
| ShadowBuilder галлюцинирует commitment с invalid effect                             | `affordance-registry.ts` — closed registry. ShadowBuilder может только select из существующих entries. Нет path для emit invalid effect.                                                         |
| IntentContractor LLM возвращает garbage JSON                                        | Schema-validate -> reject -> low-confidence intent. Никакого throw в production.                                                                                                                 |
| Bit-identical snapshot drift из-за runTurnDecision wrapper                          | Wrapper не трогает legacy code path; результат legacy идентичен по структуре до и после. Snapshot test должен остаться green. Если drift появляется — investigate перед merge.                   |
| PR-2 CI label-check ломает текущие PRs от других контрибьюторов                     | Workflow триггерится только на touch пяти конкретных файлов. На любой другой PR не влияет.                                                                                                       |
| Affordance registry с одним entry даёт avg branching factor близко к 0 (нет матчей) | Ожидаемо: cutover-1 узкий по семантике. Это log-only метрика в PR-2; gate начинается с PR-3 и только на pool persistent_session.created.                                                         |


---

## 12. После PR-2

Sub-plan для PR-3 (`commitment_kernel_pr3_observer_and_cutover.plan.md`) пишется master-plan чатом после merge PR-2 в dev. PR-3 наследует:

- Affordance `persistent_session.created` + `donePredicate` (PR-2 завёл entry, PR-3 даёт реальный predicate).
- `runTurnDecision` (writes shadow) -> в PR-3 добавляется production-side `commitmentSatisfied` gate для cutover-1 effect.
- `state_observability_coverage` real measurement через `SessionWorldState` observer.
- Все 6 метрик quant gate, N>=30 turns, cutover-1 enabling decision.

---

## 13. Notes for the PR-2 Chat

`pr-session-bootstrap.mdc` "Final step of every PR chat" применяется. На начало PR-2 чата:

1. Read this sub-plan in full.
2. Read master plan §3 (invariants), §5 (types), §6 (freeze layers), §8.3 (PR-2 contract), §9 (lint matrix).
3. Read PR-1 sub-plan §5 (lint check scripts) и PR-1.5 sub-plan §2 (branded ids semantics).
4. Confirm scope с maintainer перед первым кодовым коммитом.
5. На завершение PR-2 — flip todos + master frontmatter + append §0 row.
