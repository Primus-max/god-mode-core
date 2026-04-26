---
name: "PR-1 — Types-Only Seed + Shadow Skeleton"
overview: "Заложить shape будущего commitment kernel: types в src/platform/commitment/, branded UserPrompt/RawUserTurn, IntentContractor stub (low-confidence intent), ShadowBuilder skeleton (typed unsupported), DecisionTrace.shadowCommitment opt field, ESLint правила + whitelist, обновлённый PR template, bit-identical decision-eval snapshot. Никакого изменения production routing."
todos:
  - id: types-seed
    content: Create src/platform/commitment/ directory with type files (semantic-intent, execution-commitment, world-state, expected-delta, affordance, shadow-builder, intent-contractor, raw-user-turn, ids, index).
    status: pending
  - id: branded-user-text
    content: Branded UserPrompt and RawUserTurn types in src/platform/commitment/raw-user-turn.ts.
    status: pending
  - id: stubs
    content: IntentContractor stub returns low-confidence SemanticIntent; ShadowBuilder skeleton returns typed unsupported.
    status: pending
  - id: trace-shadow-field
    content: Add optional DecisionTrace.shadowCommitment field in src/platform/decision/trace.ts.
    status: pending
  - id: eslint-no-raw-user-text-import
    content: ESLint custom rule blocking UserPrompt/RawUserTurn import outside whitelist intent-contractor.ts.
    status: pending
  - id: eslint-no-decision-imports-from-commitment
    content: ESLint rule blocking commitment/ -> decision/ imports.
    status: pending
  - id: pr-template-update
    content: Update .github/PULL_REQUEST_TEMPLATE.md with frozen-layer checkbox section.
    status: pending
  - id: decision-eval-snapshot
    content: Capture decision-eval baseline JSON and add bit-identical snapshot test.
    status: pending
  - id: human-signoff
    content: Explicit human maintainer review against master invariants 1, 5, 6, 7, 8, 14, 15, 16.
    status: pending
isProject: false
---

# PR-1 — Types-Only Seed + Shadow Skeleton (Sub-Plan)

## 0. Provenance & Inheritance

| Field | Value |
| --- | --- |
| Sub-plan of | `commitment_kernel_v1_master.plan.md` (§5 + §8.1 + §9) |
| Inherits | 16 hard invariants + 6 flexible (без изменений) |
| Production routing change | **none** (enforced bit-identical decision-eval snapshot) |
| Estimated effort | 2-3 дня кода + ~1 день review |
| Exit gate | Human maintainer signoff (hard invariants #15) |

Любое изменение invariants — **revision мастер-плана, не этого sub-plan**. Sub-plan не имеет права ослаблять или переопределять hard / flexible invariants.

---

## 1. Goal of This PR

Заложить shape будущего commitment kernel так, чтобы:

1. Все будущие импортёры **уже видят** правильные типы.
2. Все будущие нарушители **уже падают** на типах + lint.
3. Production behavior — **bit-identical** до и после PR-1 (проверяемо decision-eval snapshot).

Это семя архитектуры. Сам кернел (LLM-вызовы, observer, predicate-runtime) приходит в PR-2 и PR-3.

---

## 2. Files To Create / Modify

### 2.1. Create — `src/platform/commitment/`

```
src/platform/commitment/
  ids.ts                        # branded ids: CommitmentId, AffordanceId, EffectId, EffectFamilyId, ...
  raw-user-turn.ts              # branded UserPrompt, RawUserTurn (whitelist surface)
  semantic-intent.ts            # SemanticIntent + OperationHint
  execution-commitment.ts       # ExecutionCommitment (tool-free; NO donePredicate)
  world-state.ts                # WorldStateSnapshot + SessionWorldState
  expected-delta.ts             # ExpectedDelta + SessionExpectedDelta
  affordance.ts                 # Affordance + DonePredicate + SatisfactionResult
  shadow-builder.ts             # ShadowBuildResult (discriminated union) + ShadowBuilder interface + skeleton
  intent-contractor.ts          # IntentContractor interface + stub  (single whitelisted reader of RawUserTurn)
  index.ts                      # public re-exports
  __tests__/
    types.test.ts               # compile-time tests via expectError / negative cases
```

### 2.2. Modify

| File | Change |
| --- | --- |
| `src/platform/decision/trace.ts` | Add optional `shadowCommitment?: ShadowBuildResult` field. Никаких других изменений. |
| `.github/PULL_REQUEST_TEMPLATE.md` | Add "Frozen layer touch" section (см. §6 этого sub-plan). |
| Root ESLint config (`.eslintrc.js` / `eslint.config.mjs` — что используется в репо) | Register two custom rules. |

### 2.3. Create — `eslint-rules/`

```
eslint-rules/
  no-raw-user-text-import.js          # invariant #5 + #6
  no-decision-imports-from-commitment.js   # invariant #8 (или через no-restricted-imports)
  __tests__/
    no-raw-user-text-import.test.ts
    no-decision-imports-from-commitment.test.ts
```

> **Implementation note**. Если в репо уже есть `eslint-plugin-*` локальный пакет, custom rules регистрируются туда. Если нет — `eslint-plugin-internal` создаётся как минимальный workspace package с двумя rules. Имплементационная деталь PR-1, не архитектурная.

### 2.4. Create — `scripts/dev/decision-eval-baseline/`

```
scripts/dev/decision-eval-baseline/
  baseline.json                 # snapshot всех existing scenarios (минимум 21+)
  README.md                     # как обновлять baseline (manual step при намеренном изменении legacy)
```

И тест:

```
scripts/dev/task-contract-eval/__tests__/bit-identical-snapshot.test.ts
```

---

## 3. Type Definitions (full sketch)

> Все типы — final shape для PR-1. Следующие PR могут **расширять**, не переопределять.

### 3.1. `ids.ts` — branded ids

```ts
declare const CommitmentIdBrand: unique symbol;
export type CommitmentId = string & { readonly [CommitmentIdBrand]: true };

declare const AffordanceIdBrand: unique symbol;
export type AffordanceId = string & { readonly [AffordanceIdBrand]: true };

declare const EffectFamilyIdBrand: unique symbol;
export type EffectFamilyId = string & { readonly [EffectFamilyIdBrand]: true };

declare const EffectIdBrand: unique symbol;
export type EffectId = string & { readonly [EffectIdBrand]: true };

declare const PreconditionIdBrand: unique symbol;
export type PreconditionId = string & { readonly [PreconditionIdBrand]: true };

declare const ChannelIdBrand: unique symbol;
export type ChannelId = string & { readonly [ChannelIdBrand]: true };

declare const SessionIdBrand: unique symbol;
export type SessionId = string & { readonly [SessionIdBrand]: true };

export type ISO8601 = string & { readonly __iso8601: true };
export type ReadonlyRecord<K extends string, V> = { readonly [P in K]: V };
```

> Hard invariant #16 enforced здесь: `EffectFamilyId` и `EffectId` — два **distinct** branded types. Implicit conversion невозможна. Попытка вернуть `EffectId` там, где ожидается `EffectFamilyId`, падает на компиляции.

### 3.2. `raw-user-turn.ts` — whitelist surface

```ts
declare const UserPromptBrand: unique symbol;
export type UserPrompt = string & { readonly [UserPromptBrand]: true };

declare const RawUserTextBrand: unique symbol;
type RawUserText = string & { readonly [RawUserTextBrand]: true };

export type RawUserTurn = {
  readonly text: RawUserText;
  readonly channel: ChannelId;
  readonly receivedAt: ISO8601;
  readonly attachments: readonly AttachmentRef[];
};

export type AttachmentRef = {
  readonly kind: 'file' | 'image' | 'audio' | 'other';
  readonly url: string;
  readonly mimeType: string;
};
```

> **Только этот файл и `intent-contractor.ts` могут импортировать `UserPrompt` / `RawUserTurn`**. Это enforcement точка ESLint правила `no-raw-user-text-import` (см. §5.1).

### 3.3. `semantic-intent.ts`

```ts
export type SemanticIntent = {
  readonly desiredEffectFamily: EffectFamilyId;
  readonly target: TargetRef;
  readonly operation?: OperationHint;
  readonly constraints: ReadonlyRecord<string, unknown>;
  readonly uncertainty: readonly string[];
  readonly confidence: number;
};

export type OperationHint =
  | { readonly kind: 'create' }
  | { readonly kind: 'update'; readonly updateOf?: TargetRef }
  | { readonly kind: 'cancel'; readonly cancelOf?: TargetRef }
  | { readonly kind: 'observe' }
  | { readonly kind: 'custom'; readonly verb: string };

export type TargetRef =
  | { readonly kind: 'session'; readonly sessionId?: SessionId }
  | { readonly kind: 'artifact'; readonly artifactId?: string }
  | { readonly kind: 'workspace' }
  | { readonly kind: 'external_channel'; readonly channelId?: ChannelId }
  | { readonly kind: 'unspecified' };
```

### 3.4. `execution-commitment.ts`

```ts
export type ExecutionCommitment = {
  readonly id: CommitmentId;
  readonly effect: EffectId;
  readonly target: CommitmentTarget;
  readonly constraints: ReadonlyRecord<string, unknown>;
  readonly budgets: CommitmentBudgets;
  readonly requiredEvidence: readonly EvidenceRequirement[];
  readonly terminalPolicy: TerminalPolicy;
};

export type CommitmentTarget = TargetRef;

export type CommitmentBudgets = {
  readonly maxLatencyMs: number;
  readonly maxRetries: number;
  readonly maxCostUsd?: number;
};

export type EvidenceRequirement = {
  readonly kind: string;
  readonly mandatory: boolean;
};

export type TerminalPolicy = {
  readonly onTimeout: 'rejected' | 'unsupported';
  readonly onPolicyDenial: 'rejected';
  readonly onUnsatisfiedSuccess: 'rejected';
};
```

> **NB**. Никаких полей `tool`, `recipe`, `route`, `donePredicate` в `ExecutionCommitment`. Это hard invariants #1 и #10. ESLint и review должны это удерживать.

### 3.5. `world-state.ts`

```ts
export type WorldStateSnapshot = {
  readonly sessions?: SessionWorldState;
  readonly artifacts?: ArtifactWorldState;
  readonly workspace?: WorkspaceWorldState;
  readonly deliveries?: DeliveryWorldState;
};

export type SessionWorldState = {
  readonly followupRegistry: readonly SessionRecord[];
};

export type SessionRecord = {
  readonly sessionId: SessionId;
  readonly agentId: string;
  readonly parentSessionKey: string | null;
  readonly status: 'active' | 'paused' | 'closed';
  readonly createdAt: ISO8601;
};

export type ArtifactWorldState = Record<string, never>;
export type WorkspaceWorldState = Record<string, never>;
export type DeliveryWorldState = Record<string, never>;
```

> Stubbed slices (`ArtifactWorldState`, `WorkspaceWorldState`, `DeliveryWorldState`) — пустые типы для PR-1. Реальные shape добавляются в cutover-2 / 3 / 4 как named slice через TS-extension. Hard invariant: никакого `extensions: Record<string, unknown>` (master §5.4 NB).

### 3.6. `expected-delta.ts`

```ts
export type ExpectedDelta = {
  readonly sessions?: SessionExpectedDelta;
  readonly artifacts?: ArtifactExpectedDelta;
  readonly workspace?: WorkspaceExpectedDelta;
  readonly deliveries?: DeliveryExpectedDelta;
};

export type SessionExpectedDelta = {
  readonly followupRegistry?: {
    readonly added?: readonly SessionRecordRef[];
    readonly removed?: readonly { readonly sessionId: SessionId }[];
  };
};

export type SessionRecordRef = {
  readonly sessionId: SessionId;
  readonly agentId: string;
};

export type ArtifactExpectedDelta = Record<string, never>;
export type WorkspaceExpectedDelta = Record<string, never>;
export type DeliveryExpectedDelta = Record<string, never>;
```

### 3.7. `affordance.ts`

```ts
export type Affordance = {
  readonly id: AffordanceId;
  readonly effect: EffectId;
  readonly target: TargetMatcher;
  readonly requiredPreconditions: readonly PreconditionId[];
  readonly requiredEvidence: readonly EvidenceRequirement[];
  readonly riskTier: RiskTier;
  readonly defaultBudgets: CommitmentBudgets;
  readonly observerHandle: ObserverHandle;
  readonly donePredicate: DonePredicate;
};

export type TargetMatcher = (target: CommitmentTarget) => boolean;

export type RiskTier = 'low' | 'medium' | 'high';

export type ObserverHandle = {
  readonly id: string;
};

export type DonePredicate = (ctx: DonePredicateCtx) => SatisfactionResult;

export type DonePredicateCtx = {
  readonly stateBefore: WorldStateSnapshot;
  readonly stateAfter: WorldStateSnapshot;
  readonly expectedDelta: ExpectedDelta;
  readonly receipts: ReceiptsBundle;
  readonly trace: ShadowTrace;
};

export type ReceiptsBundle = {
  readonly entries: readonly ReceiptEntry[];
};

export type ReceiptEntry = {
  readonly kind: string;
  readonly payload: ReadonlyRecord<string, unknown>;
};

export type ShadowTrace = {
  readonly steps: readonly { readonly at: ISO8601; readonly note: string }[];
};

export type SatisfactionResult =
  | { readonly satisfied: true; readonly evidence: readonly EvidenceFact[] }
  | { readonly satisfied: false; readonly missing: readonly string[] };

export type EvidenceFact = {
  readonly kind: string;
  readonly value: unknown;
};
```

> **DonePredicate видит ТОЛЬКО** `stateBefore`, `stateAfter`, `expectedDelta`, `receipts`, `trace`. Никакого `RawUserTurn`, `UserPrompt`, `TaskContract`, `SemanticIntent`. Hard invariant #9.

### 3.8. `shadow-builder.ts`

```ts
export type ShadowBuildResult =
  | { readonly kind: 'commitment'; readonly value: ExecutionCommitment }
  | { readonly kind: 'unsupported'; readonly reason: ShadowUnsupportedReason };

export type ShadowUnsupportedReason =
  | 'pr1_stub'
  | 'low_confidence_intent'
  | 'no_matching_affordance'
  | 'policy_blocked'
  | 'budget_exceeded';

export interface ShadowBuilder {
  build(intent: SemanticIntent): Promise<ShadowBuildResult>;
}

export const shadowBuilderSkeleton: ShadowBuilder = {
  async build(_intent: SemanticIntent): Promise<ShadowBuildResult> {
    return { kind: 'unsupported', reason: 'pr1_stub' };
  },
};
```

> Hard invariant #7 enforced на signature: `build(intent: SemanticIntent)` — не `RawUserTurn`, не `string`. Hard invariant #14: discriminated union, никаких `null` / `throw`.

### 3.9. `intent-contractor.ts` (whitelist surface)

```ts
import type { RawUserTurn } from './raw-user-turn';
import type { SemanticIntent } from './semantic-intent';
import type { EffectFamilyId } from './ids';

export interface IntentContractor {
  classify(turn: RawUserTurn): Promise<SemanticIntent>;
}

export const intentContractorStub: IntentContractor = {
  async classify(_turn: RawUserTurn): Promise<SemanticIntent> {
    return {
      desiredEffectFamily: 'unknown' as EffectFamilyId,
      target: { kind: 'unspecified' },
      constraints: {},
      uncertainty: ['pr1_stub'],
      confidence: 0,
    };
  },
};
```

> **Это единственный** файл вне `raw-user-turn.ts`, которому ESLint разрешает импортировать `UserPrompt` / `RawUserTurn`. Hard invariant #6.
>
> **Stub не возвращает `unsupported`** — это ShadowBuilder-shape. У IntentContractor нет `unsupported`. Непонятый intent — это `low-confidence intent` с `confidence: 0`. Это намеренное разделение.

### 3.10. `index.ts`

```ts
export type * from './ids';
export type * from './raw-user-turn';
export type * from './semantic-intent';
export type * from './execution-commitment';
export type * from './world-state';
export type * from './expected-delta';
export type * from './affordance';
export type * from './shadow-builder';
export { intentContractorStub } from './intent-contractor';
export { shadowBuilderSkeleton } from './shadow-builder';
export type { IntentContractor } from './intent-contractor';
export type { ShadowBuilder } from './shadow-builder';
```

> Внимание. `index.ts` re-export-ит **типы**, не **значения**, для `RawUserTurn` / `UserPrompt` — но даже так, импорт через `index` не может обойти ESLint правило, потому что rule инспектирует **символ имени** при импорте, не путь.

---

## 4. Modify `src/platform/decision/trace.ts`

Single change: добавить опциональное поле.

```ts
import type { ShadowBuildResult } from '../commitment/shadow-builder';

export type DecisionTrace = {
  // ... existing fields kept verbatim ...
  readonly shadowCommitment?: ShadowBuildResult;
};
```

> **Не заполняется** в PR-1. Просто доступно в типе. Заполнение приходит в PR-2 (`runTurnDecision`).
>
> Это **единственное** изменение в `decision/` слое во всём PR-1.

---

## 5. ESLint Rules

### 5.1. `no-raw-user-text-import` (Hard invariants #5, #6)

**Specification**:

> Импорт символов `UserPrompt` или `RawUserTurn` (или re-exports под этими именами) разрешён **только** в файлах:
> - `src/platform/commitment/raw-user-turn.ts` (определение)
> - `src/platform/commitment/intent-contractor.ts` (единственный whitelist consumer)
>
> Любой другой файл в репо, импортирующий эти символы, — error.

**Test cases**:

| File path | Imports | Expected |
| --- | --- | --- |
| `src/platform/commitment/intent-contractor.ts` | `RawUserTurn` | PASS |
| `src/platform/commitment/raw-user-turn.ts` | (defines) | PASS |
| `src/platform/commitment/semantic-intent.ts` | `RawUserTurn` | FAIL |
| `src/platform/decision/task-classifier.ts` | `UserPrompt` | FAIL |
| `src/agents/agent-command.ts` | `RawUserTurn` | FAIL |
| `src/platform/commitment/intent-contractor.ts` | `SemanticIntent` | PASS (никакого `RawUserTurn`) |

**Implementation hint** (выбор PR-1 reviewer):
- AST-based: ESLint custom rule, инспектирует `ImportDeclaration` с `specifiers` `UserPrompt` / `RawUserTurn`, проверяет `context.getFilename()` против whitelist regexp.
- Альтернатива: `no-restricted-imports` с `paths` массивом — проще, но не контролирует именованные импорты с переименованием через `import { RawUserTurn as RUT } from ...`. AST-based надёжнее.

### 5.2. `no-decision-imports-from-commitment` (Hard invariant #8)

**Specification**:

> Файл в `src/platform/commitment/**` не может импортировать из `src/platform/decision/**`.

**Test cases**:

| File path | Imports | Expected |
| --- | --- | --- |
| `src/platform/commitment/semantic-intent.ts` | `./ids` | PASS |
| `src/platform/commitment/anywhere.ts` | `../decision/contracts` | FAIL |
| `src/platform/decision/trace.ts` | `../commitment/shadow-builder` | PASS (decision -> commitment, не наоборот) |

**Implementation hint**: достаточно `no-restricted-imports` config:

```js
{
  files: ['src/platform/commitment/**/*.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: ['**/platform/decision/**', '../decision/**', '../../platform/decision/**']
    }]
  }
}
```

---

## 6. PR Template Update

Add to `.github/PULL_REQUEST_TEMPLATE.md` (или создать если нет):

```markdown
## Frozen layer touch (master plan §6.2)

Если этот PR изменяет хотя бы один файл в `src/platform/decision/`
(TaskContract, OutcomeContract, QualificationExecutionContract,
ResolutionContract, RecipeRoutingHints), отметьте ровно один тип:

- [ ] telemetry-only          — логи / трейс / метрика, никакого изменения routing
- [ ] bug-fix                 — фикс конкретного бага, не меняющий routing
- [ ] compatibility           — shim-поле, обязательно укажите source-of-truth (всегда `ExecutionCommitment.<...>`)
- [ ] emergency-rollback      — revert; tracking ticket: #_______, retire deadline: ____
- [ ] none of the above       — PR не трогает frozen layer

Source of truth (если compatibility): __________________________
```

> CI label-check job — **skeleton** в PR-1 (создаётся файл workflow, но проверка `if: false`). Реальный enforcement активируется в PR-2.

---

## 7. Decision-Eval Bit-Identical Snapshot

### 7.1. Capture baseline

1. Запустить `pnpm dev:task-contract-eval` (или эквивалент в репо) **до** любых изменений PR-1.
2. Сохранить вывод в `scripts/dev/decision-eval-baseline/baseline.json`.
3. Закоммитить baseline в PR-1 как первый коммит, **до** type seed.

### 7.2. Test

```ts
// scripts/dev/task-contract-eval/__tests__/bit-identical-snapshot.test.ts
import { runDecisionEval } from '../runner';
import baseline from '../../decision-eval-baseline/baseline.json';

describe('PR-1 bit-identical decision-eval snapshot', () => {
  it('produces output identical to baseline.json', async () => {
    const current = await runDecisionEval();
    expect(current).toEqual(baseline);
  });
});
```

> Если результат отличается — PR-1 **по определению** trogает legacy routing, что нарушает scope. Любой diff требует:
> 1. Объяснить почему (telemetry-only? bug-fix?).
> 2. Получить явный signoff на refresh baseline.
> 3. Refresh baseline отдельным коммитом с описанием.

---

## 8. Exit Criteria — Checklist

- [ ] **TypeScript build green**: `tsc --noEmit` без ошибок на всех новых файлах + изменённый `trace.ts`.
- [ ] **ESLint правила работают**: positive и negative test cases в `eslint-rules/__tests__/` проходят.
- [ ] **Bit-identical decision-eval snapshot**: тест из §7.2 green.
- [ ] **`shadowCommitment` field добавлен**: `DecisionTrace` имеет опциональное поле, ничего не заполняет.
- [ ] **IntentContractor stub корректен**: возвращает `SemanticIntent` с `confidence: 0`, не `unsupported`.
- [ ] **ShadowBuilder skeleton корректен**: возвращает `{ kind: 'unsupported', reason: 'pr1_stub' }` для любого intent.
- [ ] **PR template обновлён**: секция "Frozen layer touch" присутствует.
- [ ] **Никаких изменений в legacy paths**: `git diff` на `src/platform/decision/**` показывает только `trace.ts` с одной добавленной строкой.
- [ ] **Никаких изменений в `src/agents/**` / `src/platform/plugin.ts` / `src/platform/recipe/**`**.
- [ ] **Human signoff** против master invariants #1, #5, #6, #7, #8, #14, #15, #16.

---

## 9. Out of Scope (что НЕ делаем в PR-1)

| Item | Where it lands |
| --- | --- |
| Реальный `IntentContractor` (LLM call, schema validation) | PR-2 |
| Реальный `ShadowBuilder` (logic для построения commitment из intent) | PR-2 |
| `runTurnDecision` unified entry point | PR-2 |
| Заполнение `DecisionTrace.shadowCommitment` на каждом turn | PR-2 |
| `decision-eval` shadow comparison расширение | PR-2 |
| `affordance_branching_factor` shadow telemetry | PR-2 |
| CI label-check enforcement активный | PR-2 |
| Affordance catalog | PR-3 |
| `SessionWorldState` observer (real reader of `followupRegistry`) | PR-3 |
| `commitmentSatisfied` runtime gate | PR-3 |
| `SpawnSubagentResult` extension (`agentId`, `parentSessionKey`) | PR-1.5 |
| Quant gate measurement | PR-3 |

---

## 10. Implementation Order (recommended)

```text
Day 1 (morning):
  1. Capture decision-eval baseline.json (§7.1).
  2. Commit baseline as standalone first commit.

Day 1 (afternoon) - Day 2:
  3. Create src/platform/commitment/ directory with all type files (§3).
  4. Create index.ts re-exports.
  5. Run tsc --noEmit; fix any compile errors.

Day 2 (evening) - Day 3:
  6. Modify src/platform/decision/trace.ts (single optional field).
  7. Run bit-identical snapshot test (§7.2). Must pass first try.
  8. Create eslint-rules/no-raw-user-text-import.js + tests.
  9. Create eslint-rules/no-decision-imports-from-commitment.js (or no-restricted-imports config).
  10. Update PR template (§6).
  11. Push branch, request human review against §8 checklist.

Day 3 - Day 4 (review buffer):
  12. Address review comments (must not change scope).
  13. Final signoff.
```

---

## 11. References

- Master plan: `.cursor/plans/commitment_kernel_v1_master.plan.md` §5, §8.1, §9, §6.2
- Discussion artefact: `.cursor/plans/commitment_kernel_design_dialog.plan.md`
- Affected legacy file: `src/platform/decision/trace.ts` (single optional field added)
- Touch-down points (PR-2 onwards): `src/platform/plugin.ts`, `src/agents/agent-command.ts` — НЕ меняются в PR-1
- Decision-eval runner: `scripts/dev/task-contract-eval.ts` (or current equivalent)

---

## 12. Risk Log

| Risk | Mitigation in PR-1 |
| --- | --- |
| ESLint custom rule имеет bug, не ловит whitelist violation | Negative test cases в `eslint-rules/__tests__/` обязательны для каждого test case в §5.1 / §5.2 |
| Type cycle (`affordance.ts` -> `world-state.ts` -> ...) | Все типы — `export type` only; нет runtime imports между type files; circular type imports allowed by TS |
| Decision-eval baseline drift из-за non-determinism (timing, IDs) | Eval runner должен быть deterministic; если есть randomness — seed её или mock-нуть. PR-1 tester обязан это проверить ДО capture baseline |
| `index.ts` через `export type *` ломает tree-shaking или pretty-printing | Minor. `export type` намеренно — runtime unused; если конкретный bundler жалуется, делаем explicit `export type { ... } from '...'` per file |
| Команда обходит lint правило через комментарий `eslint-disable` | Code review responsibility. В PR-2 добавить CI grep на `eslint-disable.*no-raw-user-text-import` без явного PR ticket |
