---
name: "PR-3 — SessionWorldState Observer + Cutover-1 + Quant Gate"
overview: "Финальный PR Commitment Kernel v1. SessionWorldState observer читает subagent-registry-state в WorldStateSnapshot.sessions.followupRegistry; реальный donePredicate для persistent_session.created заменяет PR-2 placeholder; decision-eval считает все 6 quant-gate метрик; после прохождения gate (N>=30 turns shadow, все пороги passing) — cutover-1: persistent_session.created идёт через commitment kernel в production, остальное остаётся на legacy. Никакого изменения routing для других effect-families."
todos:
  - id: session-world-state-observer
    content: Реализовать src/platform/commitment/session-world-state-observer.ts. Read-only adapter над subagent-registry-state; маппит SubagentRunRecord -> SessionRecord (childSessionKey -> sessionId, requesterSessionKey -> parentSessionKey, agentId через resolveAgentIdFromSessionKey). Возвращает SessionWorldState из getSubagentRunsSnapshotForRead. Никакого raw user text, никакого TaskContract — pure value bridge.
    status: completed
  - id: persistent-session-done-predicate
    content: Реализовать persistentSessionCreatedPredicate(stateBefore, stateAfter, expectedDelta, receipts, trace) -> SatisfactionResult. Сравнивает followupRegistry до и после; satisfied=true если для каждого SessionRecordRef в expectedDelta.sessions.followupRegistry.added в stateAfter присутствует matching SessionRecord (sessionId+agentId). Ноль raw user text / classifier output. Заменить pendingSessionObserverPredicate в affordance-registry.ts.
    status: completed
  - id: cutover-policy
    content: Создать src/platform/commitment/cutover-policy.ts. Read-only список cutover-1-eligible (effect+effectFamily) — единственная запись (persistent_session.created, persistent_session). Один источник правды для runTurnDecision и для тестов. Hard invariant #11 — расширение только через PR с явным labeled-trigger.
    status: completed
  - id: monitored-runtime-skeleton
    content: src/platform/commitment/monitored-runtime.ts skeleton. Принимает ExecutionCommitment + Affordance + observer; возвращает RuntimeAttestation (terminalState orthogonal acceptanceReason — invariant #13). На cutover-1 attestation runtime-attested (invariant #4 — cutover-1 = runtime-attested). Не меняет actual execution (subagent-spawn/acp-spawn остаётся authoritative); это monitoring wrapper.
    status: completed
  - id: production-cutover-gate
    content: Расширить runTurnDecision производственным cutover gate. Если shadow.kind=commitment И cutoverPolicy.includes(commitment.effect) И monitoredRuntime.run() вернул RuntimeAttestation с commitmentSatisfied=true — production result = commitment kernel terminal. Иначе — legacy decision (current behavior). Все 4 случая (gate-out, gate-in-success, gate-in-fail, gate-in-uncertain) попадают в DecisionTrace с typed reason. Никакой silent fall-through.
    status: completed
  - id: decision-eval-six-metrics
    content: Расширить scripts/dev/decision-eval.ts на все 6 quant-gate метрик. N persistent-session turns, state_observability_coverage, commitment_correctness, satisfaction_correctness (новая — predicted satisfaction vs hindsight observed), false_positive_success (==0 baseline), divergence trace explained, labeling window honored (hindsight labels только на turns где commitment не влиял на production routing). Pool excludes answer.delivered.
    status: completed
  - id: hindsight-labeling-tooling
    content: Минимальная hybrid labeling tooling (master §7.2) — один JSON-файл scripts/dev/task-contract-eval/cutover1-labels.json со схемой { sessionId persistent-session-only, expected_satisfied bool, label_source auto | hindsight | human }. Вспомогательный TS-loader; ESLint-style guard на отсутствие labels для turns в pool.
    status: completed
  - id: tests
    content: Vitest tests на observer (snapshot fixture; маппинг runs -> followupRegistry deterministic), predicate (5 кейсов добавлено accepted, missing matching record, partial match, empty added, hostile receipts), cutover policy (только persistent_session.created — eligible), runTurnDecision (gate-out / gate-in-success / gate-in-fail / gate-in-uncertain — каждое ветка в DecisionTrace с typed reason; legacy bit-identical при gate-out), decision-eval six-metrics (synthetic pool из 30 turns, все 6 thresholds passing).
    status: completed
  - id: quant-gate-measurement
    content: Phase A — измерение на shadow data. Run pnpm eval:decision на synthetic + replayed pool >=30 persistent-session turns. Фиксировать report scripts/dev/task-contract-eval/cutover1-gate-report.json (date, n_turns, six_metrics_values, divergence_count, labeling_source_breakdown). Без cutover (production по-прежнему legacy). Exit criteria — все 6 метрик passing.
    status: completed
  - id: cutover-1-flip
    content: Phase B — после passing gate report и явного human signoff. Включить cutover-1 для persistent_session.created в runTurnDecision (production уходит через kernel). Обратная совместимость через feature flag config.commitment.cutoverEnabled (default false на initial commit; true в отдельном followup commit после signoff). Никакого rollout без явного approval — invariant #15.
    status: completed
  - id: human-signoff
    content: Maintainer signoff против master invariants #2 (affordance selection), #3 (commitmentSatisfied required), #4 (state-after observed), #9 (predicate purity), #10 (predicate on Affordance), #12 (emergency-patch deadline для любых hot-fix), #13 (terminal+acceptance orthogonal), #15 (human signoff). Двойной gate — Phase A (gate report green) и Phase B (production cutover-flip).
    status: completed
isProject: false
---

# PR-3 — SessionWorldState Observer + Cutover-1 + Quant Gate (Sub-Plan)

## 0. Provenance & Inheritance

| Field                     | Value                                                                          |
| ------------------------- | ------------------------------------------------------------------------------ |
| Sub-plan of               | `commitment_kernel_v1_master.plan.md` (§5.4 + §5.5 + §5.6 + §7 + §8.4)         |
| Inherits                  | 16 hard invariants + 6 flexible (без изменений)                                |
| Production routing change | **только** `persistent_session.created` (Phase B; gated на quant + signoff)    |
| Estimated effort          | 2-3 недели кода + ~неделя shadow measurement + signoff                         |
| Exit gate                 | Phase A gate green + Phase B human signoff (hard invariant #15) — двойной gate |

Sub-plan не имеет права ослаблять или переопределять hard / flexible invariants. Любое изменение invariants — revision мастер-плана.

---

## 1. Goal of This PR

Закрыть Commitment Kernel v1: построить **observer** для `SessionWorldState`, реальный `donePredicate` для `persistent_session.created`, измерить все 6 quant-gate метрик master §7 на N>=30 persistent-session turns, и — после passing gate + human signoff — перевести production routing для **одного** effect-а (`persistent_session.created`) на commitment kernel.

После PR-3:
- production маршрутизирует `persistent_session.created` через kernel; остальное — legacy;
- system-level success для cutover-1 effect определяется `commitmentSatisfied(...)===true`, не фактом срабатывания tool-а (invariant #3);
- N>=30 turns в pool с непрерывным measurement на 6 метриках;
- v1 готов к user acceptance testing на cutover-1 поверхности.

Cutover-2+ (artifacts, workspace, deliveries, repo, external_effects) — отдельные sub-plans, не PR-3.

---

## 2. Files To Create / Modify

### 2.1. Create

| File                                                                             | Purpose                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/platform/commitment/session-world-state-observer.ts`                        | Read-only adapter над `subagent-registry-state` -> `SessionWorldState`. Маппит `SubagentRunRecord` -> `SessionRecord`. Pure value bridge (никакой raw text, никакого TaskContract).                                 |
| `src/platform/commitment/done-predicate-persistent-session.ts`                   | Реальный `donePredicate` для `persistent_session.created`. Сравнивает `followupRegistry` до/после, проверяет `expectedDelta.sessions.followupRegistry.added`. Без доступа к raw text / TaskContract (invariant #9). |
| `src/platform/commitment/cutover-policy.ts`                                      | Один источник правды о cutover-1 eligibility. На PR-3 — только `(persistent_session.created, persistent_session)`. Расширение через labeled PR (master §6.2).                                                       |
| `src/platform/commitment/monitored-runtime.ts`                                   | Skeleton runtime wrapper: ExecutionCommitment + Affordance + observer -> `RuntimeAttestation`. Cutover-1 = runtime-attested (invariant #4). НЕ дублирует execution; обёртка над существующим subagent-spawn flow.   |
| `src/platform/commitment/__tests__/session-world-state-observer.test.ts`         | Snapshot маппинга runs -> followupRegistry.                                                                                                                                                                         |
| `src/platform/commitment/__tests__/done-predicate-persistent-session.test.ts`    | 5+ кейсов predicate (added accepted, missing matching, partial, empty, hostile receipts).                                                                                                                           |
| `src/platform/commitment/__tests__/cutover-policy.test.ts`                       | Eligibility — только `persistent_session.created`.                                                                                                                                                                  |
| `src/platform/commitment/__tests__/monitored-runtime.test.ts`                    | RuntimeAttestation invariants (#4, #13).                                                                                                                                                                            |
| `src/platform/decision/__tests__/run-turn-decision.cutover.test.ts`              | 4 cutover ветки (gate-out, gate-in-success, gate-in-fail, gate-in-uncertain) -> DecisionTrace с typed reason; bit-identical legacy при gate-out.                                                                    |
| `scripts/dev/task-contract-eval/cutover1-labels.json`                            | Hybrid labeling fixture (master §7.2) — { sessionId, expected_satisfied, label_source }.                                                                                                                            |
| `scripts/dev/task-contract-eval/cutover1-gate-report.json` (генерируется)        | Phase A gate report. Не входит в PR-3 коммит как baseline; артефакт measurement.                                                                                                                                    |
| `test/scripts/decision-eval-six-metrics.test.ts`                                 | Synthetic pool из 30 turns; все 6 quant-gate метрик passing на synthetic данных (regression-guard, не replacement реального gate).                                                                                  |

### 2.2. Modify

| File                                                                                                              | Change                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/platform/commitment/affordance-registry.ts`                                                                  | Заменить `pendingSessionObserverPredicate` на реальный `persistentSessionCreatedPredicate` из `done-predicate-persistent-session.ts`. Никаких новых affordances в PR-3 (catalog-расширение — cutover-2+).                                                            |
| `src/platform/decision/run-turn-decision.ts`                                                                      | Добавить production cutover gate. Если shadow.kind=`commitment` И `cutoverPolicy.includes(commitment.effect)` И `monitoredRuntime.run(...)` вернул `RuntimeAttestation { satisfied: true }` — production result = commitment kernel terminal. Иначе — legacy. Все 4 ветки в DecisionTrace с typed reason. |
| `src/platform/commitment/index.ts`                                                                                | Re-export observer / predicate / cutover-policy / monitored-runtime.                                                                                                                                                                                                |
| `scripts/dev/decision-eval.ts`                                                                                    | Расширить на все 6 quant-gate метрик master §7. Pool excludes `answer.delivered`. Hindsight labels только на non-cutover-affecting turns.                                                                                                                           |
| `src/config/types.agent-defaults.ts` + `src/config/zod-schema.agent-defaults.ts` + `*.test.ts`                    | Feature flag `commitment.cutoverEnabled?: boolean` (default `false`). Включает Phase B cutover; на initial PR-3 коммит остаётся `false`.                                                                                                                            |
| `package.json`                                                                                                    | Новый script `eval:decision:six-metrics` (запускает decision-eval с расширенным reporter).                                                                                                                                                                          |
| `.cursor/plans/commitment_kernel_v1_master.plan.md` + `.cursor/plans/commitment_kernel_pr3_observer_and_cutover.plan.md` | На финальном `docs(plan): mark PR-3 completed`: status pr3 -> completed; PR Progress Log + строка; Next gate -> "v1 user acceptance testing on cutover-1 surface".                                                                                                  |

### 2.3. NOT touched (out of scope)

- Любой файл в `src/platform/decision/**` кроме `run-turn-decision.ts` (frozen — invariant #11).
- `src/platform/decision/task-classifier.ts` / `task-classifier.test.ts` (frozen).
- Любой Affordance кроме `persistent_session.created` (PR-3 не расширяет catalog).
- Любой effect family кроме `persistent_session` (PR-3 — single-effect cutover).
- `WorldStateSnapshot` slices кроме `sessions` (artifacts/workspace/deliveries — cutover-2+).
- Independent observer infrastructure (cutover-2+ migration с runtime-attested на observer-based).
- ESLint config (LOCKED — только `scripts/check-*.mjs` стиль).

---

## 3. Two Phases (gated)

PR-3 — **двухфазный**. Phase A заходит как обычный PR в `dev`. Phase B — отдельный followup commit (или второй PR) после passing gate + human signoff. Без двойного gate — invariant #15 нарушен.

### 3.1. Phase A — Observer + Predicate + 6-metric measurement

Scope:
- Observer + predicate + cutover-policy + monitored-runtime skeleton.
- `runTurnDecision` cutover gate реализован, но `cutoverEnabled = false` (config default).
- Decision-eval считает все 6 метрик на shadow pool.
- Labeling tooling собирает `cutover1-labels.json`.
- Tests green.

Production routing change: **none**. Production по-прежнему на legacy. Cutover gate в коде есть, но disabled через config.

Exit Phase A:
- `pnpm eval:decision:six-metrics` на pool >=30 persistent-session turns показывает все 6 метрик passing (master §7).
- `cutover1-gate-report.json` сгенерирован, проверен maintainer-ом.
- Bit-identical legacy: остальные 20 cases в decision-eval не изменились (anchor сохраняется).
- Human signoff против Phase A invariants (#2, #3-будет, #4, #9, #10, #13, #15).

### 3.2. Phase B — Cutover-1 flip

Scope (отдельный followup commit или PR, **после** Phase A merge):
- Включить `commitment.cutoverEnabled = true` в дефолтном конфиге (или через feature toggle, чтобы можно было быстро откатить).
- `runTurnDecision` начинает использовать commitment kernel для `persistent_session.created` в production.
- `docs(plan): mark PR-3 completed (Phase B)` коммит — флипает todos status pr3 -> completed.

Production routing change: **только `persistent_session.created`** идёт через kernel. Все остальные effect-families остаются на legacy.

Exit Phase B:
- 24-72 часа shadow-vs-production observation после flip — нет regressions (production behavior на cutover-1 effect совпадает с pre-flip legacy в N>=N_post_flip turns).
- `false_positive_success == 0` сохраняется (invariant #3 не нарушается).
- Human signoff (двойной gate — invariant #15 второй раз).

Откат Phase B: единственный config-toggle (`cutoverEnabled = false`) возвращает на legacy без code revert. Hard invariant #12 — emergency rollback с tracking ticket + retire deadline.

---

## 4. Hard Invariants Enforcement (PR-3)

| #   | Invariant                                                            | PR-3 enforcement                                                                                                                                  |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| #2  | Affordance selected by (effect+target+preconditions+policy+budgets)  | `AffordanceRegistry.findByFamily(...)` уже PR-2; cutover gate использует ровно один affordance — `persistent_session.created`.                    |
| #3  | Production success requires `commitmentSatisfied(...)===true`        | Cutover-1 flow в `runTurnDecision`: production result = commitment terminal **только** при `RuntimeAttestation.satisfied=true`.                    |
| #4  | Success requires at least one observed state-after fact              | Observer читает `getSubagentRunsSnapshotForRead()` после execution — runtime-attested. Predicate проверяет state-after, не receipts.              |
| #9  | DonePredicate has no access to raw text / TaskContract / classifier  | Signature: `(stateBefore, stateAfter, expectedDelta, receipts, trace) -> SatisfactionResult`. Никакого `RawUserTurn` import — lint guard PR-1/2 поймает. |
| #10 | DonePredicate lives on Affordance                                    | Predicate присвоен `PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY.donePredicate`. `ExecutionCommitment` shape по-прежнему без `donePredicate`.         |
| #12 | Emergency phrase / routing patches require ticket + retire deadline  | Любой Phase B rollback через `cutoverEnabled=false` оформляется отдельным labeled PR с emergency-rollback label (master §6.2).                    |
| #13 | `terminalState` orthogonal to `acceptanceReason`                     | `RuntimeAttestation` имеет separate fields `terminalState` (kernel runtime) и `acceptanceReason` (predicate evidence). Tests covering orthogonal. |
| #15 | Human signoff required regardless of green CI                        | Двойной gate — Phase A (gate report green) и Phase B (production flip).                                                                           |

Остальные invariants (#1, #5, #6, #7, #8, #11, #14, #16) уже enforced на типах/lint от PR-1/PR-2 — PR-3 их не ослабляет.

---

## 5. SessionWorldState Observer Contract

```ts
// src/platform/commitment/session-world-state-observer.ts

import type { SessionWorldState, SessionRecord } from "./world-state.js";
import type { AgentId, ISO8601, SessionId, SessionKey } from "./ids.js";

export interface SessionWorldStateObserver {
  /**
   * Reads a deterministic snapshot of the persistent-session followup registry.
   *
   * @returns Read-only `SessionWorldState` derived from runtime-attested storage.
   */
  observe(): SessionWorldState;
}

/**
 * Maps subagent registry runs into pure SessionRecord values.
 *
 * Boundary rule: this adapter NEVER reads raw user text, TaskContract output, or
 * classifier results. It only consumes runtime-attested registry state.
 *
 * @param runsSnapshot - Read-only snapshot from `getSubagentRunsSnapshotForRead`.
 * @returns Frozen `SessionWorldState` with deterministic ordering by `createdAt`.
 */
export function buildSessionWorldStateFromRuns(
  runsSnapshot: ReadonlyMap<string, SubagentRunRecord>,
): SessionWorldState;
```

Invariants encoded:
- `SessionRecord.sessionId` = `SubagentRunRecord.childSessionKey` branded as `SessionId`.
- `SessionRecord.agentId` = `resolveAgentIdFromSessionKey(childSessionKey)` branded as `AgentId`.
- `SessionRecord.parentSessionKey` = `requesterSessionKey ?? null` branded as `SessionKey | null`.
- Status: `endedAt ? "closed" : "active"`. Paused — пока вне scope (cutover-2+ может расширить).
- Ordering: stable sort by `createdAt`.

Observer не пишет ничего в registry — pure read.

---

## 6. DonePredicate Contract

```ts
// src/platform/commitment/done-predicate-persistent-session.ts

import type { DonePredicate, SatisfactionResult } from "./affordance.js";

export const persistentSessionCreatedPredicate: DonePredicate = (ctx) => {
  const expectedAdded = ctx.expectedDelta.sessions?.followupRegistry?.added ?? [];
  if (expectedAdded.length === 0) {
    return { satisfied: false, missing: ["expected_delta_empty"] };
  }

  const afterIndex = new Map(
    (ctx.stateAfter.sessions?.followupRegistry ?? []).map(
      (record) => [record.sessionId, record],
    ),
  );

  const missing: string[] = [];
  const evidence: EvidenceFact[] = [];
  for (const ref of expectedAdded) {
    const matched = afterIndex.get(ref.sessionId);
    if (!matched) {
      missing.push(`session_record_missing:${ref.sessionId}`);
      continue;
    }
    if (matched.agentId !== ref.agentId) {
      missing.push(`session_record_agent_mismatch:${ref.sessionId}`);
      continue;
    }
    evidence.push({
      kind: "session_record.created",
      sessionId: ref.sessionId,
      agentId: ref.agentId,
      observedAt: matched.createdAt,
    });
  }

  return missing.length === 0
    ? { satisfied: true, evidence }
    : { satisfied: false, missing };
};
```

Predicate видит **только** state / delta / receipts / trace — нет import-а `RawUserTurn`, `UserPrompt`, `TaskContract`, `task-classifier`. PR-1/PR-2 lint guards (`no-raw-user-text-import`, `no-decision-imports-from-commitment`, `no-classifier-imports-from-commitment`) поймают любое нарушение на CI.

`receipts` и `trace` в PR-3 не используются (cutover-1 — runtime-attested через state-after); они зарезервированы для cutover-2+ (independent observer + receipts для external effects).

---

## 7. Cutover Policy & Production Gate

### 7.1. Cutover policy

```ts
// src/platform/commitment/cutover-policy.ts

import type { EffectId, EffectFamilyId } from "./ids.js";

export type CutoverEntry = {
  readonly effect: EffectId;
  readonly effectFamily: EffectFamilyId;
};

const CUTOVER_1: readonly CutoverEntry[] = Object.freeze([
  Object.freeze({
    effect: "persistent_session.created" as EffectId,
    effectFamily: "persistent_session" as EffectFamilyId,
  }),
]);

export interface CutoverPolicy {
  isEligible(effect: EffectId): boolean;
  list(): readonly CutoverEntry[];
}

export const defaultCutoverPolicy: CutoverPolicy = { /* impl */ };
```

PR-3 caput. Cutover-2+ добавляет новые entries отдельным labeled PR.

### 7.2. Production gate в `runTurnDecision`

```text
1. legacy = classifyTaskForDecision(...)            // legacy ветка по-прежнему всегда runs
2. shadow = await IntentContractor + ShadowBuilder
3. if cutoverEnabled && shadow.kind === 'commitment' && cutoverPolicy.isEligible(shadow.value.effect):
     attestation = await monitoredRuntime.run(shadow.value, ...)
     if attestation.satisfied: production = kernel terminal
     else:                      production = legacy + decisionTrace.cutoverGate = 'gate_in_fail'
   else:
     production = legacy + decisionTrace.cutoverGate = 'gate_out' | 'gate_in_uncertain'
4. trace.shadowCommitment = shadow                  // не меняется относительно PR-2
5. trace.cutoverGate = 'gate_out' | 'gate_in_success' | 'gate_in_fail' | 'gate_in_uncertain'
```

Все 4 ветки записываются в `DecisionTrace.cutoverGate` с typed reason — никакого silent fall-through (invariant #14 расширен на cutover gate).

При `cutoverEnabled=false` (Phase A initial commit) шаг 3 пропускается; гейт всегда `gate_out`. Bit-identical legacy сохраняется.

---

## 8. Decision-Eval — 6 Quant-Gate Metrics

### 8.1. Pool definition

```text
pool = decision-eval cases где expectedShadowEffect === 'persistent_session.created'
     + replayed real persistent-session turns (если доступны)
N_target >= 30
```

`answer.delivered` исключён по построению (master §7.1). Остальные intent-ы остаются для bit-identical baseline и не идут в pool.

### 8.2. Метрики

| Metric                          | Formula                                                                                          | Threshold |
| ------------------------------- | ------------------------------------------------------------------------------------------------ | --------- |
| `state_observability_coverage`  | turns где observer вернул non-empty `SessionWorldState` / N                                      | >= 0.90   |
| `commitment_correctness`        | turns где predicted `ExecutionCommitment.effect` совпадает с label-ом / N                         | >= 0.95   |
| `satisfaction_correctness`      | turns где `commitmentSatisfied(...)` совпадает с hindsight label-ом / N                          | >= 0.95   |
| `false_positive_success`        | turns где `commitmentSatisfied=true` AND hindsight `expected_satisfied=false`                    | == 0      |
| `divergence_explained`          | turns где legacy != shadow AND `divergenceReason` set                                            | == 100%   |
| `labeling_window_honored`       | hindsight labels только на turns с `cutoverGate ∈ {gate_out, gate_in_uncertain}` (production не affected) | == 100%   |

### 8.3. Output shape (`cutover1-gate-report.json`)

```json
{
  "generatedAt": "ISO8601",
  "n_turns": 32,
  "metrics": {
    "state_observability_coverage": 0.94,
    "commitment_correctness": 0.97,
    "satisfaction_correctness": 0.96,
    "false_positive_success": 0,
    "divergence_explained": 1.0,
    "labeling_window_honored": 1.0
  },
  "thresholds_passed": true,
  "label_source_breakdown": { "auto": 24, "hindsight": 6, "human": 2 },
  "divergence_count": 1
}
```

`thresholds_passed = true` — обязательное условие Phase B unlock. `false` блокирует cutover до root-cause analysis + revision.

---

## 9. Hybrid Labeling Strategy (master §7.2)

```text
1. auto-label: legacy outcome unambiguous (например, persistent_session created И followupRegistry имеет new record) -> auto.
2. hindsight: state-after determinative (запись появилась через 30s после turn) -> hindsight.
3. human: остаток (small fraction) -> один JSON-файл cutover1-labels.json.
```

Labeling rule (invariant #15 + master §7): hindsight labels только на turns где commitment не влиял на production routing (т.е. Phase A или `cutoverGate ∈ {gate_out, gate_in_uncertain}` в Phase B). После Phase B flip turn с `gate_in_success`/`gate_in_fail` уже не подлежит hindsight label-ингу — kernel сам производство.

---

## 10. Step-by-Step Implementation Order

1. **session-world-state-observer.ts** + tests (foundation; rest зависит).
2. **done-predicate-persistent-session.ts** + tests; replace `pendingSessionObserverPredicate` в `affordance-registry.ts`.
3. **cutover-policy.ts** + tests.
4. **monitored-runtime.ts** skeleton + tests (RuntimeAttestation invariants #4, #13).
5. **runTurnDecision** — cutover gate с `cutoverEnabled=false` default; tests на 4 ветки + bit-identical при `cutoverEnabled=false`.
6. **decision-eval** — 6 метрик + `cutover1-gate-report.json` generator + synthetic six-metrics regression test (30 turns synthetic, все thresholds passing).
7. **hybrid labeling fixture** — `cutover1-labels.json` schema + loader + lint guard.
8. **Phase A signoff** + maintainer flips first set of todos в sub-plan.
9. **Phase B** — отдельный followup commit: `cutoverEnabled=true` + 24-72h observation + final docs(plan) commit (флипает status pr3 -> completed + master Progress Log).

Каждый шаг — отдельный atomic commit. Группировка как в PR-2 (см. PR-2 sub-plan §10).

---

## 11. Exit Criteria

### Phase A
- `pnpm tsgo` green.
- `pnpm vitest run` (targeted): observer + predicate + cutover-policy + monitored-runtime + cutover gate + six-metrics — все green.
- `pnpm eval:decision:six-metrics` на pool N>=30: все 6 thresholds passing.
- Bit-identical legacy на 20 не-cutover cases.
- `pnpm lint:commitment:no-raw-user-text-import`, `lint:commitment:no-decision-imports`, `lint:commitment:no-classifier-imports` — все green.
- `cutover1-gate-report.json` сгенерирован, maintainer reviewed.
- Human signoff Phase A.

### Phase B
- `commitment.cutoverEnabled = true` мерджится отдельным commit.
- 24-72h post-flip observation: `false_positive_success` остаётся `0`, regression-free.
- Human signoff Phase B.
- `docs(plan): mark PR-3 completed` commit:
  - `pr3-cutover-and-observer` todo -> `completed`.
  - master `Next gate` -> "v1 user acceptance testing on cutover-1 surface".
  - new row в master Progress Log с финальным SHA.

---

## 12. After PR-3 (cutover-2+, не PR-3)

| Cutover    | Effect family                                  | Observer                               | New affordances                          |
| ---------- | ---------------------------------------------- | -------------------------------------- | ---------------------------------------- |
| cutover-2  | `artifact.created`                             | `ArtifactWorldStateObserver` (independent) | per-document affordances                 |
| cutover-3  | `repo_operation.completed`                     | `RepoStateObserver`                    | git-mediated affordances                 |
| cutover-4  | `external_effect.performed` (Telegram, Discord) | per-channel observers                  | channel-side effect affordances          |
| cutover-N  | ...                                            | F2 (WorldStateSnapshot growing slices) | ...                                      |

Каждый cutover — отдельный sub-plan, наследует master invariants. PR-3 закрывает только cutover-1.

---

## 13. Open Questions (non-blocking)

1. `monitored-runtime.run()` асинхронность — в Phase A synchronous wrapper над уже завершённым subagent-spawn. В cutover-2+ может стать promise-based с polling. Не блокирует PR-3.
2. `cutover1-labels.json` человеческое заполнение — нужен ли minimal CLI tool? Для PR-3 — manual JSON edit OK. CLI — после.
3. Phase B rollback policy (config toggle vs code revert) — выбран config toggle с emergency-rollback label. Tracking ticket + retire deadline по invariant #12.

Эти вопросы фиксируются в backlog, не блокируют merge.
