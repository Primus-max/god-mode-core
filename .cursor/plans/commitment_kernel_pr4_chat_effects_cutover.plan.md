---
name: ""
overview: ""
todos: []
isProject: false
---

---

name: PR-4 — Production routing flip + cutover-2 chat-effects (split на PR-4a / PR-4b)
overview: |
  Sub-plan разделён на две волны (см. master §0.5.3 и §8.5):

- **Wave A = PR-4a** (closure G1+G2+G3+G4+G5). Структура коммитов: (1) idempotency-fix (session-store guard, см. detail-spec в commitment_kernel_idempotency_fix.plan.md) → (2) production routing flip для `persistent_session.created` (kernel-derived-decision-contract + 4 call-sites + monitoredRuntime/expectedDeltaResolver wiring) → (3) [DEBUG ROUTING] cleanup в TG reply. **idempotency-fix НЕ выпускается standalone PR-ом** — он живёт внутри ветки `pr/4a/`* как первый коммит. Обоснование: фикс трогает те же layers, что routing flip; общий dry-run покрывает оба фикса (master §0.5.3). Не вводит новых effect-families, оставляет PolicyGate stub, не трогает chat-effects.
- **Wave B = PR-4b** (closure G6.a+G6.b). Cutover-2 для chat-bound effects (`answer.delivered`, `clarification_requested`, `external_effect.performed`): effect-family `communication`, affordance registry extend, WorldState deliveries slice, cutoverPolicy расширение, минимальный реальный PolicyGate (credentials + channel-disabled, **не** approvals/budgets/role-based — те идут в отдельный sub-plan, см. master §8.5.1).
Между PR-4a и PR-4b обязательна **green CI с реальной production маршрутизацией** хотя бы одного эффекта (`persistent_session.created` через kernel в TG flow). Это и есть промежуточный тестируемый шаг, без которого PR-4 как монолит был бы не review-able и не отказтываемый по частям.
Production routing change — да в обеих волнах, поэтому каждая волна за hard invariant #15 (human signoff) отдельно.

audit_gaps_closed:
  wave_a:
    - G1 (production routing not switched)
    - G2 (runtime / expected-delta never passed in production)
    - G3 (idempotency guard unreachable in TG flow) — closed by commit 1 (idempotency-fix)
    - G4 (idempotency tests do not prove fix) — closed by commit 1 (test rewrite)
    - G5 ([DEBUG ROUTING] still in user-facing reply)
  wave_b:
    - G6.a (effect-family registry not extended → branching factor stuck at 1.0)
    - G6.b (PolicyGate stubbed → invariant #2 not enforced)
  deferred:
    - G6.c (full PolicyGate: approvals/budgets/role-based) → отдельный sub-plan `commitment_kernel_policy_gate_full.plan.md` после cutover-2
todos:

# ===== Wave A (PR-4a) — closure G1 + G2 + G3 + G4 + G5 (single PR, three commits) =====

- id: preflight-audit-sync
wave: a
content: Перед кодом синхронизировать план с текущим рабочим деревом. Подтвердить, что PR-4a стартует с legacy==production в runTurnDecision, cutover-1 policy содержит только persistent_session.created, DEBUG ROUTING остаётся user-facing, а текущий runs-based idempotency WIP заменяется session-store lookup. PR-4a НЕ трогает chat-effects, effect-family registry и PolicyGate stub.
status: pending
- id: idempotency-fix-persistent-session
wave: a
content: "**Commit 1 PR-4a (жёстко, не standalone PR).** Починить idempotency для persistent_session.created (см. detail-spec в commitment_kernel_idempotency_fix.plan.md, closure G3+G4). Идёт ПЕРВЫМ коммитом PR-4a, до routing flip — иначе routing flip даст `label already in use` на втором же live `Валера`. См. master §0.5.3 (правило idempotency-fix внутри PR-4a)."
status: pending
- id: kernel-derived-decision-contract
wave: a
content: Зафиксировать контракт deriveDecisionFromCommitment до flipping call-sites. Как ExecutionCommitment превращается в ClassifiedTaskResolution/productionDecision, какие поля остаются legacy-derived, какие становятся kernel source-of-truth, как пишутся terminalState/acceptanceReason/kernelFallback. Без этого PR-4a рискует остаться trace-only.
status: pending
- id: tg-entrypoint-kernel-first
wave: a
content: |
[Audit 2026-04-27, closes G1+G2] В runTurnDecision и в **четырёх production call-sites** одновременно изменить два аспекта routing-а (только для уже зарегистрированного `persistent_session.created` — chat-effects вводятся в Wave B):
  1. runTurnDecision: реализовать deriveDecisionFromCommitment согласно kernel-derived-decision-contract. При shadowCommitment.kind === "commitment" + effect ∈ cutoverPolicy (только persistent_session.created на этой волне) + monitoredRuntime + expectedDelta + commitmentSatisfied=true → productionDecision = kernel-derived; иначе legacy с kernelFallback=true.
  2. Все 4 call-sites должны (a) деструктурировать productionDecision вместо legacyDecision, (b) передавать monitoredRuntime + expectedDeltaResolver в input. Точки:
    - src/platform/plugin.ts:76 (route helper)
    - src/platform/plugin.ts:332 (runtime-plan resolver)
    - src/platform/decision/input.ts:440 (initial classifier call)
    - src/platform/decision/input.ts:475 (workspace-inject reclassify)
  3. Без выполнения обоих пунктов одновременно kernel остаётся shadow-only (G1+G2 не закрыты). PR-4a не считается green до contract-теста, который проверяет, что productionDecision !== legacyDecision на cutover-eligible turn-ах persistent_session.created с successful runtime attestation.
  status: pending
- id: debug-routing-cleanup
wave: a
content: "[Audit 2026-04-27, closes G5] Убрать (или скрыть за dev-flag cfg.runtime?.debugRouting) блок [DEBUG ROUTING] из user-facing reply (src/agents/command/delivery.ts:44-83). Сейчас он выливается в каждый TG ответ и нарушает invariant #5. Trace-данные оставляем в decision-trace.ts / nested log, не в reply. Snapshot-test одного TG-ответа должен ассертить отсутствие подстроки `[DEBUG ROUTING]` в payload."
status: pending
- id: legacy-fallback-explicit
wave: a
content: Когда kernel вернул unsupported, runTurnDecision должен явным флагом помечать decision как kernel_fallback=true, чтобы это было видно в logs/traces. Это не функциональное изменение — это observability для UAT.
status: pending
- id: tests-wave-a
wave: a
content: Vitest на (1) runTurnDecision routes в kernel при cutover-on (persistent_session.created) + runtime attested → productionDecision !== legacyDecision; (2) runTurnDecision routes в legacy при cutover-off / runtime unavailable; (3) все 4 call-sites действительно консьюмят productionDecision и передают monitoredRuntime+expectedDeltaResolver (callsite tests на plugin.ts:76, plugin.ts:332, input.ts:440, input.ts:475); (4) DEBUG ROUTING absent from reply без флага; (5) bit-identical snapshot для эффектов вне cutover-pool. Plus переписанный subagent-spawn.idempotency.test.ts (см. idempotency-test-strengthen, идёт вместе с G3+G4).
status: pending
- id: idempotency-test-strengthen
wave: a
content: "[Audit 2026-04-27, closes G4] Переписать src/agents/subagent-spawn.idempotency.test.ts: убрать vi.spyOn(subagentRegistry, 'findActiveSubagentByLabel'). Новые тесты должны (a) реально вызывать findLivePersistentSessionByLabel путь, (b) симулировать TG-сценарий reuse после endedAt, (c) negative cases. Идёт вместе с idempotency-fix sub-plan-ом."
status: pending
- id: lint-and-freeze-wave-a
wave: a
content: PR-4a соответствует freeze: изменения в input.ts / plugin.ts под label `compatibility` (не telemetry-only). Все lint:commitment:* green. Никаких новых effect-families в registry — это Wave B.
status: pending
- id: human-signoff-wave-a
wave: a
content: "Human signoff PR-4a против master invariants §3 (#2, #3, #4, #14, #15). 6 quant-gate metrics на persistent_session.created pool now runtime-attested in real TG flow (≥30 turns на dev-машине под TG, ≥1 час dry-run). Без signoff — merge запрещён."
status: pending

# ===== Wave B (PR-4b) — closure G6.a + G6.b =====

- id: preflight-wave-b-baseline
wave: b
content: PR-4b стартует только когда PR-4a merged и зелёный CI с реальной production маршрутизацией persistent_session.created подтверждён (≥1 час dry-run в Wave A exit). Подтвердить, что productionDecision !== legacyDecision уже работает на persistent_session.created и не сломался.
status: pending
- id: affordance-registry-extend
wave: b
content: Добавить в defaultAffordanceRegistry chat-bound записи без phrase matching. (1) answer.delivered — текстовый ответ; donePredicate проверяет typed delivery receipt. (2) clarification_requested — typed clarification outcome + delivered receipt. (3) external_effect.performed — external channel send receipt, если не дублирует answer.delivered. Перед реализацией развести effect boundaries.
status: pending
- id: world-state-delivery-slice
wave: b
content: Добавить в WorldStateSnapshot слайс `deliveries` как сериализуемый read-only receipt store (например Record<DeliveryContextKey, readonly DeliveryReceipt[]>). Observer читает existing delivery telemetry / receipt log. Это закрывает invariant F2 и даёт donePredicate для answer.delivered наблюдаемое state-after.
status: pending
- id: effect-family-extend
wave: b
content: "[Audit 2026-04-27, closes G6.a] Расширить EFFECT_FAMILY_REGISTRY новым семейством `communication` с allowedOperationKinds=['create','observe']. До Wave B в registry только `persistent_session` и `unknown`, поэтому branching factor = 1 by construction. Это первый момент, когда в одном семействе появится >1 affordance — соответствие invariant #16 в этой точке проверяется явно."
status: pending
- id: cutover-policy-flip
wave: b
content: Расширить cutoverPolicy через явный effect allow-list в config. После PR-4b policy умеет включать chat-effects, но production default должен быть подтверждён human signoff; не включать "всё" неявно через отсутствие флага. Никакой text-route logic — только effect_id matching.
status: pending
- id: policy-gate-real
wave: b
content: "[Audit 2026-04-27, closes G6.b — minimum scope only] Заменить allowAllPolicyGate в runShadowBranch на минимальный реальный PolicyGate с контрактом `evaluate(commitment, affordance, ctx) → { ok: true } | { ok: false; reason }` и reasons {'no_credentials','channel_disabled'}. Только для chat-effects. **НЕ реализовывать**: approvals, budgets per-user/per-channel, role-based access, retry policies, escalation hooks — это `commitment_kernel_policy_gate_full.plan.md` (см. master §8.5.1). Если scope попадает на approvals/budgets → stop, surface user-у."
status: pending
- id: decision-eval-cutover2
wave: b
content: Расширить scripts/dev/decision-eval.ts pool на answer.delivered + clarification_requested + external_effect.performed (~30+ turns каждого). Считать master §7 metrics без подмены. Дополнительные PR-4 метрики kernel_path_share/observation_latency — supplementary, не вместо master gate.
status: pending
- id: tests-wave-b
wave: b
content: Vitest на (1) расширенный affordance registry (4 эффекта, donePredicate каждому), (2) effect-family registry contract (`communication` family present, allowedOperationKinds verified), (3) deliveries slice observer (Observer.read() видит receipts после mock send), (4) cutoverPolicy explicit allow-list, (5) PolicyGate real-mode contract (denies external_effect.performed без credentials; allows answer.delivered с valid context), (6) runTurnDecision routes в kernel для chat-effects при cutover-on. Plus contract test bit-identical-snapshot для эффектов вне cutover-pool.
status: pending
- id: lint-and-freeze-wave-b
wave: b
content: PR-4b соответствует freeze: расширение affordance registry / effect-family registry / cutover-policy под label `compatibility`. Все lint:commitment:* green.
status: pending
- id: human-signoff-wave-b
wave: b
content: "Human signoff PR-4b против master invariants §3 (#2, #3, #4, #9, #14, #15) и §7 (6 quant-gate metrics на cutover-2 pool ≥30 turns каждого эффекта). Подтвердить, что approvals/budgets/role-based PolicyGate не попали в scope (они = future sub-plan). Без signoff — merge запрещён."
status: pending
isProject: false

---

# PR-4 — Production routing flip + cutover-2 chat-effects (Sub-Plan, two waves)

## 0. Provenance & Inheritance


| Field                     | Value                                                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Sub-plan of               | `commitment_kernel_v1_master.plan.md` (§0.5 audit findings, §8.4, §8.5, §8.5.1)                                                           |
| Inherits                  | 16 hard invariants + 6 flexible (без изменений)                                                                                           |
| Wave structure            | **Wave A = PR-4a** (G1+G2+G5) → mandatory green CI + ≥1ч dry-run → **Wave B = PR-4b** (G6.a+G6.b)                                         |
| Production routing change | **YES** в обеих волнах. PR-4a — flip для `persistent_session.created`. PR-4b — расширение на chat-effects.                                |
| Estimated effort          | PR-4a: ~1 неделя кода + 1-2 дня UAT. PR-4b: 2 недели кода + неделя UAT.                                                                   |
| Exit gate (per wave)      | Human maintainer signoff (hard invariant #15) **отдельно** для PR-4a и PR-4b + 6 quant-metrics passing на соответствующем pool ≥ 30 turns |


Любое ослабление invariants — revision мастер-плана, не этого sub-plan. Перенос work item-а из Wave B в Wave A или наоборот — отдельный edit master §0.5.3 + §8.5, не молчаливый сдвиг.

### 0.1. Wave separation discipline


| Что делает Wave A (PR-4a)                                                 | Что делает Wave B (PR-4b)                                                                                                | Что НЕ делает ни одна из волн                                                                                                            |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Flip routing для `persistent_session.created` через kernel                | Расширяет cutover-pool на chat-bound subset (`answer.delivered`, `clarification_requested`, `external_effect.performed`) | Approvals, budgets, role-based access, retry policies, escalation hooks (= `commitment_kernel_policy_gate_full.plan.md`, post-cutover-2) |
| Передаёт `monitoredRuntime` + `expectedDeltaResolver` во все 4 call-sites | Добавляет `communication` effect-family + extends affordance registry                                                    | Удаление `task-classifier.ts` (он остаётся legacy fallback до cutover-3+)                                                                |
| Удаляет `[DEBUG ROUTING]` из user-facing reply                            | Заменяет `allowAllPolicyGate` минимальным реальным PolicyGate (credentials + channel-disabled только)                    | `artifact.created`, `repo_operation.completed` (= cutover-3 / cutover-4)                                                                 |
| Включает idempotency-fix как **commit 1** (G3+G4) — не standalone PR      | Наследует уже работающий `productionDecision` путь от Wave A                                                             | Independent observer (= post cutover-4 sub-plan)                                                                                         |


**Жёсткое правило**: PR-4a НЕ вводит новых effect-families и НЕ трогает PolicyGate stub — он остаётся `allowAllPolicyGate` ещё одну итерацию. PR-4b НЕ flip-ает routing — он наследует уже работающий productionDecision путь от PR-4a.

---

## 1. Why PR-4 (что меняется визуально для пользователя)

### 1.1. После merge PR-4a (Wave A)

1. Повторное "Валера, ..." не создаёт дубли persistent сабагентов и не падает на `label already in use`. Spawn идёт через kernel-path с idempotency по живой сессии в session store. *(Closes G3+G4 через commit 1 PR-4a — idempotency-fix.)*
2. Из ответов пропадает блок "[DEBUG ROUTING]" — он либо удалён, либо за dev-flag. Trace-данные остаются в логах, не в чате. *(Closes G5.)*
3. Для `persistent_session.created` `productionDecision !== legacyDecision` на cutover-eligible turn-ах с successful runtime attestation (видно в trace как `decision=kernel`, не `legacy_fallback`). *(Closes G1+G2.)*
4. Legacy classifier-first остаётся как fallback для всего остального (включая `answer.delivered` и прочие chat-effects — они flip-нутся только в PR-4b).

Если пункт (1), (2) или (3) не выполнен — PR-4a не green.

### 1.2. После merge PR-4b (Wave B)

1. Простые ответы ("Спасибо", "Окей", clarification questions) идут через kernel `answer.delivered` / `clarification_requested`, без `task-classifier` round-trip-а. Это видно в логе: `[commitment] answer.delivered effect=...`, не `[task-classifier] classified=...`. *(Cutover-2 production routing.)*
2. `affordance_branching_factor` метрика становится осмысленной (>1.0) на cutover-2 pool — first time когда в одном effect-family >1 affordance. *(Closes G6.a.)*
3. PolicyGate реально отказывает send без credentials или с disabled channel. Stub `allowAllPolicyGate` отключён для chat-effects. *(Closes G6.b minimum.)*
4. Approvals / budgets / role-based PolicyGate **отсутствуют** — это отдельный sub-plan; их попадание в PR-4b = stop.

Если пункт (5), (6) или (7) не выполнен — PR-4b не green. Если случайно реализован пункт "approvals/budgets" — это scope creep, requires master plan revision.

---

## 2. Scope

### 2.1.A. In-scope effects для PR-4a (Wave A)

- `persistent_session.created` (cutover-1 surface) — **production routing flip с legacy на kernel**. До PR-4a это shadow-only (см. master §0.5).

PR-4a НЕ добавляет новых эффектов в cutover policy.

### 2.1.B. In-scope effects для PR-4b (Wave B)

- `answer.delivered` — текстовый ответ пользователю в текущий DeliveryContext
- `clarification_requested` — текстовый запрос уточнения
- `external_effect.performed` — отправка сообщения через TG/Discord/Matrix (один observable receipt)

Все три — chat-bound, новые в cutover policy, требуют новой effect-family `communication`.

### 2.2. Out of scope для PR-4 (обе волны)

- `artifact.created` (документы, отчёты, PDF, ZIP) — это cutover-3 sub-plan
- `repo_operation.completed` — cutover-4
- Independent observer (миграция с runtime-attested на observer-based) — отдельный план после cutover-4
- Удаление `task-classifier.ts` физически — он остаётся как legacy fallback ещё минимум на cutover-3 + cutover-4
- Полный PolicyGate (approvals, budgets, role-based, retry policies, escalation) — `commitment_kernel_policy_gate_full.plan.md` после cutover-2; см. master §8.5.1

### 2.3. Preflight audit baseline для PR-4a (must be true before coding)

Текущий baseline после PR-3 / перед PR-4a:

- `runTurnDecision.productionDecision` фактически равен legacy decision с добавленным trace. PR-4a должен изменить это осознанно, через `kernel-derived-decision-contract`.
- `defaultCutoverPolicy` включает только `persistent_session.created` (это правильно для PR-4a).
- `defaultAffordanceRegistry` содержит только `persistent_session.created` (это правильно для PR-4a; chat-effects добавляются в PR-4b).
- Production call-sites `runTurnDecision` не передают `monitoredRuntime` / `expectedDeltaResolver` по умолчанию.
- User-facing delivery path всё ещё добавляет `[DEBUG ROUTING]` в payload.
- Незакоммиченный idempotency WIP ищет active run и должен быть заменён на session-store lookup.
- `allowAllPolicyGate` остаётся как есть (PR-4a его не трогает).

### 2.4. Preflight baseline для PR-4b (must be true after PR-4a merged)

- PR-4a merged, ≥1 час dry-run в TG прошёл без `label already in use` и без `[DEBUG ROUTING]` в payload.
- `productionDecision !== legacyDecision` уже работает на `persistent_session.created` cutover-eligible turn-ах (PR-4a contract test зелёный).
- 4 production call-sites уже передают `monitoredRuntime` + `expectedDeltaResolver`. Wave B наследует это, не дублирует.
- `WorldStateSnapshot.deliveries` всё ещё placeholder — это дело Wave B.
- `EFFECT_FAMILY_REGISTRY` содержит только `persistent_session` + `unknown` — Wave B добавляет `communication`.

---

## 3. Hard invariants checklist (что enforce-ится в каждой волне)

### 3.A. PR-4a (Wave A) — должны быть green после merge:

- #1 — Commitment tool-free (registry shape unchanged)
- #2 — Affordance selected by effect + preconditions only (PolicyGate всё ещё stub в PR-4a; #2 на policy/budgets enforce-ится в PR-4b)
- #3 — Production success requires `commitmentSatisfied(...) === true` (для persistent_session.created)
- #4 — Success requires observed state-after fact для persistent_session.created
- #5 / #6 — Никакого phrase-rule в новом коде
- #8 — `commitment/` не импортирует из `decision/`
- #11 — Five legacy contracts заморожены (frozen-label-check продолжает работать)
- #14 — Success невозможен без observed state-after
- #15 — Human signoff на PR-4a отдельно

### 3.B. PR-4b (Wave B) — добавляются к 3.A после merge:

- #2 — теперь enforce-ится **полностью**: Affordance selected by effect + target + preconditions + **policy** + budgets (минимальный PolicyGate с credentials + channel-disabled)
- #4 — расширяется на 3 chat-effects (deliveries slice observer)
- #9 — DonePredicate для всех 4 эффектов (1 от Wave A + 3 от Wave B)
- #10 — DonePredicate на Affordance, не на Commitment (новые 3 affordance)
- #14 — расширяется на cutover-2 pool
- #15 — Human signoff на PR-4b отдельно (включая explicit confirmation, что approvals/budgets не попали в scope)
- #16 — `EffectFamilyId` distinct from `EffectId`; `communication` family распознаётся

---

## 4. Implementation outline (по todos)

Каждая подсекция явно помечена `[Wave A]` или `[Wave B]`. Подсекция Wave B попадает в код только в PR-4b, не раньше.

### 4.1. [Wave A, COMMIT 1] Idempotency fix (todo `idempotency-fix-persistent-session`)

**Жёстко: это первый коммит PR-4a, не standalone PR.** См. master §0.5.3 (правило idempotency-fix внутри PR-4a). Должен быть merged в ветку `pr/4a/`* ДО commit 2 (routing flip), иначе routing flip даст `label already in use` на втором же live `Валера`.

Текущая реализация:

```16:48:src/agents/subagent-registry-queries.ts
export function findActiveSubagentByLabelFromRuns(
  runs: Map<string, SubagentRunRecord>,
  label: string,
  origin: DeliveryContext | undefined,
): SubagentRunRecord | undefined {
  ...
  for (const entry of runs.values()) {
    ...
    if (typeof entry.endedAt === "number") {
      continue;
    }
    ...
  }
}
```

Проблема: `endedAt` ставится после каждого завершённого turn-а, поэтому в реальном TG flow registry не содержит "active" run-ов между сообщениями. Нужно искать **live persistent session** в session store (gateway-side), а не "active run".

Шаги:

1. Добавить `findLivePersistentSessionByLabel(store, label, origin)` в `src/gateway/session-store-queries.ts` (новый файл) или расширить существующий query helper. Критерий: `entry.label === label && entry.spawnMode === 'session' && session not deleted && origin совпадает по deliveryContextKey`.
2. Заменить вызов `findActiveSubagentByLabel` в `spawnSubagentDirect` на новую функцию.
3. Тест E2E: spawn(label="Валера") → finish turn → второй spawn(label="Валера") → должен вернуть тот же `childSessionKey` без второго `subagent_spawning` hook fire.

Detail-spec для этого коммита — `commitment_kernel_idempotency_fix.plan.md` (он живёт как separate document для удобства чтения, но финальный мерж = commit 1 ветки PR-4a; standalone PR не открывается).

Important: не использовать текущий runs-based WIP как финальный фикс. Он остаётся зависимым от `endedAt` и не доказывает reuse живой persistent session после завершённого turn-а.

### 4.1.1. [Wave A] Kernel-derived decision contract (todo `kernel-derived-decision-contract`)

Перед `tg-entrypoint-kernel-first` нужно зафиксировать минимальный контракт:

```ts
type KernelDecisionDerivation = {
  readonly productionDecision: ClassifiedTaskResolution;
  readonly sourceOfTruth: "kernel" | "legacy_fallback";
  readonly terminalState: RuntimeAttestation["terminalState"];
  readonly acceptanceReason: RuntimeAttestation["acceptanceReason"];
  readonly kernelFallback: boolean;
  readonly fallbackReason?: string;
};
```

Rules:

1. `sourceOfTruth: "kernel"` разрешён только при `shadowCommitment.kind === "commitment"`, effect in cutover policy, runtime available, expected delta available, and `commitmentSatisfied === true`.
2. `gate_in_fail` не может возвращать success-like production decision.
3. `legacy_fallback` должен быть явным в trace for unsupported / out-of-policy / runtime unavailable.
4. Поля legacy, которые остаются compatibility shim, должны быть помечены source-of-truth comment или trace field, чтобы не размывать freeze master §6.

### 4.2. [Wave B] Affordance registry extension (todo `affordance-registry-extend`)

В `src/platform/commitment/affordance-registry.ts`:

```ts
export const ANSWER_DELIVERED_AFFORDANCE_ENTRY: AffordanceEntry = {
  effectId: brandedEffectId('answer.delivered'),
  effectFamilyId: brandedEffectFamilyId('communication'),
  donePredicate: createAnswerDeliveredPredicate(),
  policy: { budgetMs: 30_000, retries: 0 },
  preconditions: { requiresLLMResponse: true },
};
```

Аналогично для `clarification_requested` и `external_effect.performed`, но сначала развести boundaries:

- `answer.delivered` = final answer text sent to user in the active delivery context.
- `clarification_requested` = typed clarification decision plus sent clarification payload.
- `external_effect.performed` = non-chat external side effect receipt, or channel-send umbrella only if `answer.delivered` is modelled as its subtype. Не заводить два effects на один и тот же receipt без composite/parent relation.

### 4.3. [Wave B] WorldState `deliveries` slice (todo `world-state-delivery-slice`)

В `src/platform/commitment/world-state.ts` добавить сериализуемый shape:

```ts
export type DeliveryReceipt = {
  readonly deliveryContextKey: string;
  readonly messageId: string;
  readonly sentAt: number;
  readonly effect: EffectId;
  readonly kind: 'answer' | 'clarification' | 'external_effect';
  readonly text?: string;
};

export type WorldStateSnapshot = {
  ...
  readonly deliveries?: Readonly<Record<string, readonly DeliveryReceipt[]>>;
};
```

Observer (`SessionWorldStateObserver` → новый `WorldStateObserver`, не обязательно rename в первом коммите) читает receipts из existing delivery telemetry log / outbound action records. Query/predicate code не парсит user text.

### 4.4. [Wave B] CutoverPolicy расширение (todo `cutover-policy-flip`)

NB. PR-4a НЕ трогает cutoverPolicy — на Wave A в нём остаётся только `persistent_session.created` (как сейчас). Расширение allow-list-а на chat-effects происходит только в PR-4b.

В `src/platform/commitment/cutover-policy.ts`:

```ts
export type CutoverPolicyConfig = {
  readonly enabledEffects: readonly EffectId[];
};

export const DEFAULT_CUTOVER_EFFECTS = Object.freeze([
  'persistent_session.created',
] satisfies EffectId[]);
```

Феча-флаг через `cfg.commitment?.cutover?.enabledEffects` для override-а в dev/staging/prod. Если config отсутствует, поведение должно быть явно протестировано и подтверждено maintainer-ом; не полагаться на `undefined !== false` для нового PR-4 production routing.

### 4.5. [Wave A] TG entry-point kernel-first (todo `tg-entrypoint-kernel-first`) — closes G1+G2

**Audit 2026-04-27**: После PR-3 `runTurnDecision` возвращает `productionDecision === legacyDecision`, а call-sites игнорируют `productionDecision`. Без одновременной правки и функции, и всех её caller-ов kernel остаётся shadow-only. Поэтому todo разбивается на две связанные правки.

**На Wave A scope ограничен `persistent_session.created`**: cutover-policy всё ещё содержит только этот эффект, поэтому kernel-derived decision активируется только для него. Расширение на chat-effects — Wave B (через cutover-policy-flip).

#### 4.5.1. `runTurnDecision` itself

В `src/platform/decision/run-turn-decision.ts`:

```ts
export async function runTurnDecision(input): Promise<TurnDecisionResult> {
  const [legacyDecision, shadowCommitmentResult] = await Promise.all([
    runLegacyDecision(input),
    runShadowCommitment(input),
  ]);

  const productionDecision =
    shadowCommitmentResult.kind === 'commitment' &&
    cutoverPolicy.isEligible(shadowCommitmentResult.commitment.effect) &&
    runtimeAttestation?.commitmentSatisfied === true
      ? deriveDecisionFromCommitment({
          commitment: shadowCommitmentResult.commitment,
          runtimeAttestation,
          legacyDecision,
        })
      : legacyDecision;

  return {
    legacyDecision,
    shadowCommitmentResult,
    productionDecision,
    kernelFallback: productionDecision === legacyDecision,
  };
}
```

#### 4.5.2. Call-sites (must be updated together with 4.5.1)

Сейчас четыре production call-site деструктурируют только `legacyDecision` и не передают `monitoredRuntime` / `expectedDeltaResolver`. До PR-4 их трогать нельзя (это перекидывает kernel в production). В PR-4 — нужно обновить **все четыре одновременно**, иначе kernel-path активируется частично и invariant #4 (observed state-after on success) перестаёт быть гарантией.


| File                             | Line (current)                      | Что делать                                                                                                                                    |
| -------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/platform/plugin.ts`         | 76 (`route helper`)                 | Передавать `{ prompt, cfg, agentDir, monitoredRuntime, expectedDeltaResolver }`; деструктурировать `productionDecision`, не `legacyDecision`. |
| `src/platform/plugin.ts`         | 332 (`runtime-plan resolver`)       | Аналогично: передавать `monitoredRuntime` + `expectedDeltaResolver`; читать `productionDecision`.                                             |
| `src/platform/decision/input.ts` | 440 (`initial classifier call`)     | Передавать `monitoredRuntime` + `expectedDeltaResolver`; читать `productionDecision`.                                                         |
| `src/platform/decision/input.ts` | 475 (`workspace-inject reclassify`) | Аналогично: `monitoredRuntime` + `expectedDeltaResolver` + `productionDecision`.                                                              |


Дополнительно:

1. `runtimeAttestation` в `runTurnDecision` берётся из `monitoredRuntime.attest(commitment, expectedDelta)`. Без обоих параметров cutoverGate возвращает `gate_in_uncertain (monitored_runtime_unavailable)` (см. §0.5.1 master). PR-4 должен передавать оба.
2. Где `MonitoredRuntime` ещё не сконфигурирован для конкретного call-site (например, синхронный clarification path), todo legacy-fallback-explicit обязан пометить такой turn как `kernelFallback=true` с `fallbackReason="runtime_unavailable"` — это легитимный legacy путь для cutover-2 окна.
3. Contract test (`run-turn-decision.cutover2.test.ts`): на cutover-eligible turn с successful runtime attestation **обязан** ассертить `productionDecision !== legacyDecision`. Без этого теста G1 closure не доказан.

Никаких других точек роутинга вне этого списка не трогаем — все entry-point-ы уже идут через `runTurnDecision`.

### 4.9. [Wave B] Effect-family registry extension (todo `effect-family-extend`) — closes G6.a

В `src/platform/commitment/effect-family-registry.ts`:

```ts
export const COMMUNICATION_EFFECT_FAMILY: EffectFamily = {
  id: brandedEffectFamilyId('communication'),
  allowedOperationKinds: ['create', 'observe'] as const,
  description: 'Chat-bound deliveries: answer.delivered, clarification_requested, external_effect.performed',
};

export const EFFECT_FAMILY_REGISTRY = Object.freeze({
  persistent_session: PERSISTENT_SESSION_EFFECT_FAMILY,
  communication: COMMUNICATION_EFFECT_FAMILY,
  unknown: UNKNOWN_EFFECT_FAMILY,
});
```

NB. До PR-4 `affordance_branching_factor` canary метрика (master §13.4) тривиально равна 1.0 потому что в registry одно семейство с одним affordance. Cutover-2 — первая точка, где в одном семействе будет три affordance (`answer.delivered`, `clarification_requested`, `external_effect.performed`) и canary начинает измерять что-то реальное. Это явный signal для observer dashboards.

### 4.10. [Wave B] Policy gate — minimum scope only (todo `policy-gate-real`) — closes G6.b

В `src/platform/decision/run-turn-decision.ts` сейчас:

```ts
const policyGate = allowAllPolicyGate;
```

Заменить на минимальный реальный policy gate. **Жёстко минимальный** — approvals/budgets/role-based **не реализуются здесь**, они идут в `commitment_kernel_policy_gate_full.plan.md` (см. master §8.5.1).

```ts
type PolicyGateDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'no_credentials' | 'channel_disabled' };

interface PolicyGate {
  evaluate(args: {
    commitment: ExecutionCommitment;
    affordance: AffordanceEntry;
    deliveryContextKey: string;
    cfg: AppConfig;
  }): PolicyGateDecision;
}
```

Минимальная реализация для cutover-2 (только два reason-кода):

- `external_effect.performed` → проверить наличие credentials для target channel (TG bot token / Discord token / Matrix creds) в `cfg`. Без credentials → `{ ok: false, reason: 'no_credentials' }`.
- `answer.delivered` / `clarification_requested` → проверить, что `deliveryContextKey` соответствует разрешённому каналу (не disabled в config). Если канал disabled → `{ ok: false, reason: 'channel_disabled' }`.

**Запрещено в PR-4b**: добавлять reason `'budget_exceeded'`, `'requires_approval'`, `'role_denied'`, `'retry_limit'` или любые другие. Это сразу делает scope = full PolicyGate, что = stop, surface user-у. Если в процессе работы выяснится, что без approvals не получается выполнить какой-то из todos Wave B — это материал для master plan revision, а не silent extension scope.

PR review-er отдельно проверяет, что в `policy-gate.ts` экспортируется ровно два reason-кода. Любое расширение → reject PR-4b.

### 4.11. [Wave A] Idempotency tests strengthen (todo `idempotency-test-strengthen`) — closes G4

Текущий `src/agents/subagent-spawn.idempotency.test.ts` мокает `findActiveSubagentByLabel` через `vi.spyOn(subagentRegistry, 'findActiveSubagentByLabel')` и поэтому проверяет только early-return ветку в `spawnSubagentDirect`, не сам guard. После idempotency-fix эту переписку обязательно довести до конца:

1. Удалить `vi.spyOn(subagentRegistry, 'findActiveSubagentByLabel')`.
2. Использовать реальный gateway session-store (in-memory implementation в `test/helpers/`) и реальную `findLivePersistentSessionByLabel` (после её реализации в idempotency-fix sub-plan-е).
3. Покрыть сценарии:
  - **Reuse after closed run**: spawn → завершить turn (`endedAt` set on run record) → второй spawn с тем же label/origin → должен вернуть тот же `childSessionKey` и не fire-ать второй `subagent_spawning` hook.
  - **Different origin**: spawn в TG channel A → второй spawn с тем же label, но в TG channel B → должен создать новую сессию.
  - **Oneshot mode**: oneshot subagent не reuse-ится (нет live persistent session by definition).
  - **Empty / missing label**: idempotency не применяется, каждый spawn создаёт новую сессию.
  - **Deleted session**: persistent session помечена deleted/expired → второй spawn создаёт новую.

Без этой переписки G3 closure (по факту) проверяется только manual TG smoke test-ом, что недостаточно для invariant #15 (human signoff требует CI-доказательства).

### 4.6. [Wave A] DEBUG ROUTING cleanup (todo `debug-routing-cleanup`)

Найти источник блока `[DEBUG ROUTING]` (по grep `DEBUG ROUTING` в `src/`) и:

- Если он генерируется в reply pipeline (`reply/format-*.ts`) — удалить из user-bearing output, оставить только в `decision-trace.ts` (внутренний log).
- Если за dev-flag нужен — `cfg.runtime?.debugRouting === true` для UI/dev, иначе строка не появляется в reply text.

Tests: snapshot-test одного TG-ответа; ассерт на отсутствие подстроки `[DEBUG ROUTING]`.

### 4.7. [Wave A] Legacy fallback explicit (todo `legacy-fallback-explicit`)

В trace добавить флаг:

```ts
export type DecisionTrace = {
  ...
  readonly kernelFallback: boolean;
  readonly fallbackReason?: ShadowUnsupportedReason;
};
```

`true` когда productionDecision === legacyDecision из-за unsupported / out-of-pool.

### 4.8. [Wave B] Decision-eval cutover-2 pool (todo `decision-eval-cutover2`)

`scripts/dev/decision-eval.ts --cutover2-pool` запускает eval на ≥30 turn-ов каждого эффекта из cutover-2 pool. Output: master §7 metrics remain the gate. `kernel_path_share` и `observation_latency` можно считать как supplementary telemetry, но они не заменяют `satisfaction_correctness`, `false_positive_success == 0` и divergence coverage.

NB. Wave A использует существующий `--cutover1-pool` для validation на `persistent_session.created` после flip-а; новый pool появляется только в Wave B.

---

## 5. Test plan


| Wave | Test                                             | Path                                                                                      | Pass criteria                                                                                                                                                                                                                     | Closes gap     |
| ---- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| A    | Idempotency E2E (real session-store path)        | `src/agents/subagent-spawn.idempotency.test.ts` (rewritten — no vi.spyOn on guard)        | 2 подряд spawn(label="X") после endedAt-run → 1 session, single spawning hook fire; см. §4.11 пять сценариев                                                                                                                      | G3+G4          |
| A    | runTurnDecision routes correctly (cutover-1)     | `src/platform/decision/run-turn-decision.cutover1.test.ts`                                | kernel когда in-pool (только persistent_session.created) + runtime attested → `productionDecision !== legacyDecision`; legacy когда unsupported / runtime unavailable                                                             | G1+G2          |
| A    | Production call-sites consume productionDecision | `src/platform/plugin.callsites.test.ts` + `src/platform/decision/input.callsites.test.ts` | 4 call-site (plugin.ts:76, plugin.ts:332, input.ts:440, input.ts:475) передают monitoredRuntime+expectedDeltaResolver и читают productionDecision                                                                                 | G1+G2          |
| A    | DEBUG ROUTING absent from reply                  | `src/agents/command/delivery.no-debug-routing.test.ts`                                    | reply не содержит `[DEBUG ROUTING]` без флага; ассерт на двух independent delivery contexts                                                                                                                                       | G5             |
| A    | Bit-identical snapshot для эффектов вне pool     | `test/scripts/decision-eval-bit-identical.test.ts` (existing)                             | legacy results не изменились на эффекты вне cutover-1                                                                                                                                                                             | —              |
| A    | 6 quant-metrics на cutover-1 pool (real)         | `pnpm eval:decision:six-metrics --pool=cutover1`                                          | Все 6 thresholds passed на runtime-attested live data, не synthetic; **N≥30, label_source coverage ≥80% auto**                                                                                                                    | —              |
| A    | Real-traffic dry-run                             | manual TG ≥1 час на dev-машине                                                            | Ноль `label already in use`, ноль `[DEBUG ROUTING]` в payload, в trace видно `decision=kernel` для persistent_session.created                                                                                                     | G1+G2+G3+G4+G5 |
| B    | Affordance registry contract (extended)          | `src/platform/commitment/affordance-registry.test.ts`                                     | 4 эффекта зарегистрированы, donePredicate есть у каждого                                                                                                                                                                          | —              |
| B    | Effect-family registry contract                  | `src/platform/commitment/effect-family-registry.test.ts`                                  | `communication` family present, allowedOperationKinds=['create','observe']                                                                                                                                                        | G6.a           |
| B    | Deliveries slice observer                        | `src/platform/commitment/world-state-observer.deliveries.test.ts`                         | Observer.read() видит receipts после mock send                                                                                                                                                                                    | —              |
| B    | CutoverPolicy gate                               | `src/platform/commitment/cutover-policy.test.ts`                                          | explicit allow-list включает/исключает effects без text routing; persistent_session.created остаётся in-pool                                                                                                                      | —              |
| B    | PolicyGate real-mode contract                    | `src/platform/commitment/policy-gate.test.ts`                                             | denies external_effect.performed без credentials → reason='no_credentials'; denies disabled channel → reason='channel_disabled'; allows valid context. **Явный reverse-test**: registry экспортирует **только** эти 2 reason-кода | G6.b           |
| B    | runTurnDecision routes correctly (cutover-2)     | `src/platform/decision/run-turn-decision.cutover2.test.ts`                                | kernel когда in-pool + runtime attested для chat-effects; legacy когда unsupported                                                                                                                                                | —              |
| B    | 6 quant-metrics на cutover-2 pool                | `pnpm eval:decision:six-metrics --pool=cutover2`                                          | Все 6 thresholds passed; report committed; **N≥30 на каждом из 3 chat-effects, label_source coverage ≥80% auto**                                                                                                                  | —              |
| B    | Real-traffic dry-run cutover-2                   | manual TG ≥1 час на dev-машине                                                            | Простые ответы идут через kernel, видно `[commitment] answer.delivered`, не `[task-classifier] classified=...`; `affordance_branching_factor > 1.0` в telemetry                                                                   | G6.a           |


### 5.1. Что не считается доказательством (anti-checklist)

1. Тесты, мокающие `findActiveSubagentByLabel` / `findLivePersistentSessionByLabel` через `vi.spyOn(...)` — **не доказывают** G3/G4 closure. Они проверяют только early-return ветку spawn-а.
2. Snapshot-test одного reply-payload без `[DEBUG ROUTING]` достаточно для G5 closure только если он ассертит **отсутствие** подстроки и проходит на двух independent contexts (TG + Discord или dummy channel).
3. `productionDecision !== legacyDecision` сам по себе не доказывает G1 — он должен ассертиться **только** на cutover-eligible turn-ах с successful runtime attestation. На любом legacy fallback turn-е равенство — корректное поведение.
4. Synthetic 6-quant-gate report без real-traffic dry-run (хотя бы 1 dev-машина под TG ≥1 час) не закрывает invariant #15 ни для PR-4a, ни для PR-4b.
5. **Wave-specific anti-pattern**: PR-4a, который добавляет `communication` effect-family или новые affordance — это scope creep (это Wave B). PR-4b, который меняет `cutoverPolicy` для `persistent_session.created` или трогает 4 production call-sites — это retrospective scope creep (Wave A уже это сделал, не дублировать). Любое такое изменение = reject PR.
6. **PolicyGate scope creep anti-pattern**: PolicyGate с reason-кодами помимо `'no_credentials'` и `'channel_disabled'` в PR-4b = reject. Approvals/budgets/role-based — `commitment_kernel_policy_gate_full.plan.md`, не здесь.

---

## 6. CI / Lint

Применяется к обеим волнам (PR-4a и PR-4b отдельно):

- `pnpm tsgo` — green
- `pnpm vitest run` — green
- `pnpm run lint:commitment:no-raw-user-text-import` — green
- `pnpm run lint:commitment:no-decision-imports` — green
- `pnpm run lint:commitment:no-classifier-imports` — green
- `pnpm run lint:commitment:check-frozen-layer-label` — green (обе волны трогают `decision/input.ts` и/или `commitment/`, поэтому label `compatibility` обязателен в PR body)

Wave-specific:

- **PR-4a**: `pnpm eval:decision:six-metrics --pool=cutover1` — все 6 passed на runtime-attested live data (не synthetic).
- **PR-4b**: `pnpm eval:decision:six-metrics --pool=cutover2` — все 6 passed на 3 chat-effects pool.

---

## 7. Exit criteria

### 7.A. Exit criteria для PR-4a (Wave A)

1. Все frontmatter todos с `wave: a` помечены `completed`.
2. CI / Lint §6 (общие + cutover1 quant gate) — green.
3. **Production routing flip доказан**: contract test `productionDecision !== legacyDecision` зелёный на cutover-eligible `persistent_session.created` turn-ах с successful runtime attestation. На legacy fallback turn-ах равенство — корректно.
4. **Все 4 production call-sites обновлены одновременно** (plugin.ts:76, plugin.ts:332, input.ts:440, input.ts:475) — частичное обновление = reject PR-4a.
5. **6 quant-gate метрик passing на cutover-1 pool**, ≥30 turns, **runtime-attested на live data** (не synthetic). `false_positive_success == 0`.
6. **Real-traffic dry-run ≥1 час** на dev-машине под TG: ноль `label already in use`, ноль `[DEBUG ROUTING]` в payload, в trace видно `decision=kernel` для persistent_session.created.

   Dry-run checklist (заполнять в PR-4a body перед signoff):

   **Pre-run setup**:
   - [ ] Дев-машина под TG, бот запущен с PR-4a HEAD (3 functional commits + non-functional test/lint commit).
   - [ ] `cfg.commitment?.cutoverEnabled` отсутствует или `true` (Phase B default — см. cutover1 test "treats missing cutoverEnabled flag as enabled").
   - [ ] Trace logging включён достаточно, чтобы видеть `decisionTrace.kernelDerived.sourceOfTruth` и `decisionTrace.cutoverGate.kind` в run output / logs.
   - [ ] Старт-таймстамп зафиксирован.

   **Сценарии (минимум по 1 turn каждый, общая длительность ≥1 час)**:
   - [ ] **Spawn нового persistent subagent**: `Создай Валеру` (или аналогичный label). Trace ожидаемо:
     - `cutoverGate.kind === "gate_in_success"`
     - `kernelDerived.sourceOfTruth === "kernel"`
     - `kernelDerived.effect === "persistent_session.created"`
     - `kernelFallback === false`
   - [ ] **Idempotent reuse того же label** (повторный prompt в том же чате): turn возвращает тот же `childSessionKey`, **никаких** `label already in use` в логах, `subagent_spawning` hook **не fire-ится** второй раз (можно проверить через hook-runner audit log).
   - [ ] **Reuse после endedAt**: завершить run subagent-а (явный exit / timeout), затем повторить prompt с тем же label → reuse работает (G3 regression в live режиме).
   - [ ] **Cross-chat protection**: spawn того же label из другого TG чата → создаётся новая сессия, не reuse.
   - [ ] **Out-of-pool effect** (любой не-`persistent_session.created` turn, например answer-only): trace показывает `kernelFallback === true` и `fallbackReason === "shadow_unsupported"` (или эквивалент); production effect = legacy decision; bit-identical с pre-PR-4a поведением.

   **Reply-payload assertions** (визуально по сообщениям бота в TG):
   - [ ] **Ноль** вхождений подстроки `[DEBUG ROUTING]` в любом из reply payloads за всё время dry-run-а (G5).

   **Logs assertions** (greppable):
   - [ ] **Ноль** строк `label already in use` в run logs (G3+G4).
   - [ ] Для каждого `persistent_session.created` turn-а в trace видно `decision=kernel` (а не `decision=legacy_fallback`), кроме явно ожидаемых fallback-кейсов (например, runtime недоступен).

   **Sign-off material** (запостить в PR body):
   - [ ] Длительность фактического dry-run-а в часах (`>=1`).
   - [ ] Количество совершённых turn-ов и breakdown по сценариям выше.
   - [ ] Краткий вывод: «PR-4a dry-run пройден, G1-G5 подтверждены на live-traffic».

7. Human signoff (#15) внесён в PR-4a body.
8. **Audit gap closure**: master plan §0.5.3 обновлён одной строкой `closed by PR-4a <merge-SHA>` для **G1, G2, G3, G4, G5** одновременно (G3+G4 закрыты commit 1 — idempotency-fix; G1+G2 закрыты commit 2 — routing flip; G5 закрыт commit 3 — DEBUG cleanup). Standalone idempotency-fix PR не открывается.
9. **Commit-структура верна**: `git log` ветки `pr/4a/`* показывает ровно 3 functional commit-а в порядке (1) idempotency-fix, (2) routing flip, (3) DEBUG cleanup. Если порядок нарушен — на втором же live turn-е сломается с `label already in use`.
10. **Никакого scope creep**: PR-4a не содержит изменений в `affordance-registry.ts` (новые эффекты), `effect-family-registry.ts` (новые семейства), `policy-gate.ts` (замена stub-а), `cutover-policy.ts` (расширение allow-list-а). Эти файлы — Wave B.

### 7.B. Exit criteria для PR-4b (Wave B)

1. Все frontmatter todos с `wave: b` помечены `completed`.
2. PR-4a уже merged и его exit criteria (§7.A) confirmed (≥1 час dry-run прошёл).
3. CI / Lint §6 (общие + cutover2 quant gate) — green.
4. **PolicyGate scope discipline**: реализованы **только** reason-коды `'no_credentials'` и `'channel_disabled'`. Reverse-test проверяет, что в `policy-gate.ts` экспортируется ровно этот set, не больше.
5. `affordance_branching_factor > 1.0` в telemetry на cutover-2 pool (доказательство, что в одном effect-family >1 affordance).
6. **6 quant-gate метрик passing на cutover-2 pool**, ≥30 turns на каждом из 3 chat-effects, label_source coverage ≥80% auto. `false_positive_success == 0`.
7. **Real-traffic dry-run ≥1 час** на dev-машине под TG: простые ответы идут через kernel (видно `[commitment] answer.delivered` в trace), `[task-classifier] classified=...` появляется только для эффектов вне cutover-2 pool.
8. Human signoff (#15) внесён в PR-4b body, **с явным confirmation** в PR description, что approvals/budgets/role-based PolicyGate **не попали** в scope (= future sub-plan).
9. **Audit gap closure**: master plan §0.5.3 обновлён строками `closed by PR-4b <merge-SHA>` для G6.a и G6.b. G6.c (full PolicyGate) остаётся open до отдельного sub-plan-а.
10. **Никакого scope creep**: PR-4b не трогает 4 production call-sites (это Wave A scope, уже сделано) и не меняет `cutoverPolicy` для `persistent_session.created` (он остаётся in-pool, но не модифицируется).

## 7.1. Handoff Log

### 2026-04-27 — Audit before PR-4 implementation

Completed TODO ids: none.

Touched files during audit: none by this audit step. Existing working tree already contains plan edits and runs-based idempotency WIP.

Tests/lints run: none.

Confirmed baseline:

- PR-4 features are not implemented in code yet.
- `productionDecision` is still legacy-derived.
- `DeliveryWorldState` is a placeholder.
- DEBUG ROUTING remains user-facing in delivery path.
- Current idempotency WIP must be replaced, not completed as-is.

Blockers:

- Need session-store query for idempotency before claiming user-visible cutover.
- Need `kernel-derived-decision-contract` before flipping TG entrypoint.
- Need effect boundary decision for `answer.delivered` vs `external_effect.performed`.

Next recommended TODO id: `preflight-audit-sync`, then `idempotency-fix-persistent-session`, then `kernel-derived-decision-contract`.

### 2026-04-27 — Two-wave split applied

Completed TODO ids: none in code; this is a **plan-only handoff** marking the structural split into PR-4a / PR-4b.

Touched files during planning step:

- `.cursor/plans/commitment_kernel_v1_master.plan.md` (§0 status row, §0.5.3 scope-of-fix matrix, §0.5.4 cutover ready definitions, §0.5.5 self-check budget, §8.5 wave column + PolicyGate split note + §8.5.1, §14 sub-plan boundaries, §16 next gate).
- `.cursor/plans/commitment_kernel_pr4_chat_effects_cutover.plan.md` (frontmatter overview / audit_gaps_closed / todos repartitioned by wave; body §0/§1/§2/§3/§4 helpers + Wave-A/Wave-B markers; §5 test plan with Wave column; §7 split into §7.A + §7.B).
- `.cursor/plans/commitment_kernel_idempotency_fix.plan.md` (предыдущая итерация уже закрыла G3+G4 anti-pattern; повторно не трогался).
- `.cursor/rules/pr-session-bootstrap.mdc` (предстоит обновить mapping PR-4 → PR-4a / PR-4b — следующий шаг).

Tests/lints run: none (plan-only).

Что закрыто этой итерацией: ничего из G1..G6 как такового, но структурно разнесены closure points: G1+G2+G3+G4+G5 → PR-4a (3 commits); G6.a+G6.b → PR-4b; G6.c → отдельный future sub-plan `commitment_kernel_policy_gate_full.plan.md`.

Blockers:

- Никаких code changes этой итерацией не сделано; PR-4a начинается с `preflight-audit-sync` + commit 1 (idempotency-fix).

Next recommended action для следующего чата: открыть PR-4a с первым коммитом = idempotency-fix (G3+G4), затем routing flip (G1+G2), затем DEBUG cleanup (G5). PR-4b начинать только после PR-4a merged + ≥1 час dry-run в TG. Standalone idempotency-fix PR не открывается.

### 2026-04-27 — idempotency-fix fork closed + bootstrap budget tightened

Completed TODO ids: none in code; **plan-only handoff** фиксирует два структурных решения после ревью первого PR-4a chat-а (см. transcript `c556218d-35da-4481-839a-6b8ee3284c7b`).

Touched files during planning step:

- `.cursor/plans/commitment_kernel_v1_master.plan.md`:
  - frontmatter `idempotency-fix-persistent-session` / `pr4a-cutover1-routing-flip` content переписаны под жёсткое правило «idempotency-fix = commit 1 PR-4a, не standalone PR».
  - §0 Provenance & Status: `PR sequence`, `Cutover-1 reality`, `Next gate` обновлены.
  - §0 Active Work Handoff Protocol: пункты 1-2 переписаны под default 4-line bootstrap output; Q1..Q5 переведены в trigger-conditional. `Active handoff source of truth` table сжат до одного PR-4a row + PR-4b + future PolicyGate.
  - §0.5.2 owners для G3+G4: «PR-4a (Wave A), FIRST COMMIT».
  - §0.5.3 scope-of-fix matrix: добавлено явное правило «idempotency-fix внутри PR-4a (final, no fork)».
  - §0.5.5 полностью переписан: default bootstrap output = 4 строки; Q1..Q5 печатаются ТОЛЬКО при триггере (preconditions fail / sub-plan vs master conflict / scope creep / прямая просьба).
- `.cursor/plans/commitment_kernel_idempotency_fix.plan.md`:
  - frontmatter `name` + `overview` переписаны как detail-spec для commit 1 PR-4a (не standalone PR).
  - §0 Provenance table: добавлен `Final merge target` row + `Branch` row; `Exit gate` указан как часть PR-4a §7.A.
  - §5 Exit criteria переписаны как локальные критерии для commit 1, audit gap closure delegates в PR-4a single SHA row.
  - §7 References: standalone PR явно исключён.
- `.cursor/plans/commitment_kernel_pr4_chat_effects_cutover.plan.md`:
  - frontmatter overview: убрано «параллельно или первым коммитом» — теперь жёстко commit-структура (1) idempotency-fix → (2) routing flip → (3) DEBUG cleanup.
  - frontmatter `audit_gaps_closed.wave_a` дополнен G3+G4.
  - frontmatter todo `idempotency-fix-persistent-session` переписан как commit 1.
  - §0.1 wave-separation table: «Идёт вместе с idempotency-fix» → «Включает idempotency-fix как commit 1».
  - §1.1 first-bullet ссылается на commit 1 PR-4a.
  - §4.1 заголовок `[Wave A, COMMIT 1]` + явное правило порядка коммитов.
  - §7.A exit criteria: единый G-row `closed by PR-4a <SHA>` для G1+G2+G3+G4+G5; новый пункт 9 «commit-структура верна».
- `.cursor/rules/pr-session-bootstrap.mdc`:
  - At chat start пункт 1: «Working on idempotency-fix» теперь явно именуется alias для commit 1 PR-4a.
  - At chat start пункт 3: Q1..Q5 переведены в trigger-conditional.
  - At chat start пункт 5: переписан в «default bootstrap output = exactly 4 строки», без re-list файлов; trigger-conditional расширение до Q1..Q5.
  - Crossing chats: секции «Working on PR-N», «Working on idempotency-fix», «Working on PR-4a», «Working on PR-4b» переписаны под 4-line output, no fork, и trigger-only Q1..Q5.

Tests/lints run: none (plan-only).

Что закрыто этой итерацией: structurally — две разнавивы (idempotency fork + bootstrap-output bloat), которые мешали следующему чату стартовать без ceremony. Никаких G1..G6 этой итерацией не закрыто (это не code change).

Blockers:

- Никаких code changes; PR-4a по-прежнему открывается как `preflight-audit-sync` → commit 1 (idempotency-fix) → commit 2 (routing flip) → commit 3 (DEBUG cleanup).

Next recommended action: открыть PR-4a chat с минимальным bootstrap output (4 строки) и сразу начать с `preflight-audit-sync`, затем перейти к commit 1.

### 2026-04-28 — PR-4a stabilization (tests + lint + freeze)

Completed TODO ids: `tests-wave-a`, `idempotency-test-strengthen`, `lint-and-freeze-wave-a`. Все три — **non-functional** (test/lint/plan), не сдвигают closure G-rows и могут amend-иться только до dry-run-а.

Branch: `pr/4a/cutover1-routing-flip` (3 functional commits уже на ветке: a972638e48 idempotency-fix, 85516cf3ce routing flip, 0114e1923e DEBUG cleanup). Эта итерация добавляет 1 non-functional commit поверх.

Touched files (test/plan only — никаких production source изменений):

- `src/platform/decision/run-turn-decision.cutover1.test.ts` (new) — переименован из `src/platform/decision/__tests__/run-turn-decision.cutover.test.ts` (deleted), путь приведён к §5 row "runTurnDecision routes correctly (cutover-1)". `__tests__/` директория удалена. Содержимое идентично, relative imports перепрописаны (`../commitment/...` → `../commitment/...`, `../../../config/...` → `../../config/...`, `../run-turn-decision.js` → `./run-turn-decision.js`).
- `src/agents/command/delivery.no-debug-routing.test.ts` (new) — dedicated G5 closure artefact: ассертит отсутствие `[DEBUG ROUTING]` на двух independent delivery contexts (Telegram + Discord) per anti-checklist §5.1.2.
- `src/agents/command/delivery.test.ts` — удалён дубликат теста `does not include routing debug block in telegram reply payload` (теперь живёт в dedicated файле выше); оставлен короткий referer-comment.
- `src/agents/subagent-spawn.idempotency.test.ts` — три усиления G3+G4 proof:
  1. `runSubagentSpawning` стал `vi.fn()` с reset-ом в `setHookRunner` — позволяет ассертить, что reuse-path **не вызывает** spawning hook (§4.11 row 1).
  2. Reuse-кейсы (G3 regression with `endedAt`, fresh entry, latest-by-updatedAt) теперь явно ассертят `expect(runSubagentSpawningMock).not.toHaveBeenCalled()`.
  3. Добавлен явный §4.11 row 5 тест `[§4.11 deleted session] creates a new session when the previous persistent entry was removed from the store`: store сначала содержит entry → reuse работает; затем `pinStore({})` симулирует удаление entry (run-mode `sessions.delete` или operator-driven cleanup) → второй spawn НЕ reuse-ит, идёт normal spawn path с `callGatewaySpy.toHaveBeenCalled()`.
- `.cursor/plans/commitment_kernel_pr4_chat_effects_cutover.plan.md` (этот файл) — handoff log entry + dry-run чек-лист в §7.A пункт 6.

Tests/lints run (все green):

- `pnpm tsgo` — green (exit 0, без output).
- `pnpm vitest run` для затронутых файлов:
  - `src/agents/subagent-spawn.idempotency.test.ts` + `src/agents/command/delivery.no-debug-routing.test.ts` + `src/agents/command/delivery.test.ts` + `src/platform/decision/run-turn-decision.cutover1.test.ts`: 25 tests / 4 files passed.
  - `test/scripts/decision-eval-bit-identical.test.ts` + `src/platform/plugin.callsites.test.ts` + `src/platform/decision/input.callsites.test.ts`: 5 tests / 3 files passed.
- `pnpm run lint:commitment:no-raw-user-text-import` — green.
- `pnpm run lint:commitment:no-decision-imports` — green.
- `pnpm run lint:commitment:no-classifier-imports` — green.
- `node scripts/check-frozen-layer-label.mjs` (frozen-layer label CI gate из §6) локально проверен с `BASE_REF=origin/dev`:
  - `PR_BODY="- [x] compatibility"` → exit 0 (label валиден).
  - `PR_BODY=""` → exit 1 со списком frozen-touched файлов (`src/platform/decision/input.ts`, `src/platform/decision/trace.ts`, `src/platform/plugin.ts`). **PR-4a body обязан содержать `- [x] compatibility`** при открытии PR.

Что закрыто этой итерацией: ничего из G-rows (G1..G5 уже closed функциональными commits 1+2+3); это **proof-strengthening** и **freeze compliance** для PR-4a §7.A пункты 3 (production routing flip доказан contract тестом), 4 (4 call-sites), и закрытие anti-checklist §5.1.1 (idempotency без `vi.spyOn` на guard) + §5.1.2 (DEBUG ROUTING absence на двух контекстах).

Blockers (для merge PR-4a):

- ≥1 час dry-run в TG на dev-машине (manual, §7.A пункт 6) — чек-лист ниже в §7.A.
- Human signoff invariant #15 (§7.A пункт 7).
- Final commit `docs(plan): mark PR-4a completed` (флипнуть `pr4a-cutover1-routing-flip` + `idempotency-fix-persistent-session` в master frontmatter, добавить строку в §0 PR Progress Log, обновить §0.5.3 G1-G5 closed by PR-4a `<merge-SHA>`).

Next recommended action: запустить ≥1 час dry-run в TG, заполнить чек-лист (§7.A пункт 6); затем human signoff + final docs commit + merge PR-4a в `dev` → blocker-cleanup перед стартом PR-4b.

---

## 8. Out-of-scope / следующие планы

- `commitment_kernel_policy_gate_full.plan.md` — полный PolicyGate (approvals, budgets per-user/per-channel, role-based access, retry policies, escalation hooks). Создаётся **после cutover-2**, обязателен **до cutover-4** (`repo_operation.completed`). См. master §8.5.1.
- `commitment_kernel_cutover3_artifacts.plan.md` — cutover-3 (artifacts, pdf, zip)
- `commitment_kernel_cutover4_repo_and_external.plan.md` — cutover-4 (repo + external) — зависит от full PolicyGate
- `commitment_kernel_independent_observer.plan.md` — миграция с runtime-attested на independent observer (cutover-2+ согласно master §8.5 / §13)

---

## 9. References

- Master plan: `commitment_kernel_v1_master.plan.md` (§0.5 audit findings, §5, §6, §7, §8.4, §8.5, §8.5.1, §13, §14, §16)
- Idempotency mini-plan: `commitment_kernel_idempotency_fix.plan.md` (G3+G4)
- PR-2 sub-plan: `commitment_kernel_pr2_shadow_mode_and_freeze.plan.md`
- PR-3 sub-plan: `commitment_kernel_pr3_observer_and_cutover.plan.md` (если есть на диске)
- Hard invariants: master §3
- Quant gate: master §7
- Bootstrap rule: `.cursor/rules/pr-session-bootstrap.mdc`
- Scope guard rule: `.cursor/rules/commitment-kernel-scope.mdc`
