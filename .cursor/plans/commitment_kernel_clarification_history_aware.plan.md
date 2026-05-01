---
name: PR-H — session-history-aware clarify (Stage 1.5 ClarificationPolicy)
overview: |
  Узкий фикс поверх Stage 1 (Bug D, merged): расширение `ClarificationPolicy`
  gate для downgrade legacy classifier `clarification_needed` outcomes когда
  предыдущий успешный `SemanticIntent` для той же сессии структурно заполняет
  поле, которое текущий intent оставил пустым, и classifier blocking reason
  принадлежит curated reason-class для этого поля.

  Симптом из Telegram-лога 2026-04-29 13:52: turn 2 «ДОведи до конца!» →
  classifier `clarification_needed·clarify_first·conf=0.47` → бот переспросил
  «что именно довести», игнорируя 3 предыдущих turn'а контекста. Bug D matches
  только deployment-target ambiguity, в этом случае ambiguity не deployment
  → gate skip → бот спросил clarify.

  Gate решения — **только structural inheritance** между двумя `SemanticIntent`
  снимками (current + prior), curated reason-class fragments на classifier
  OUTPUT, контрадикция через нестыковку кode явно установленных полей.
  Запрещено сопоставление текста ledger entries / message bodies / user
  prompt strings (invariants #5, #6).

  Phase 1 (этот PR): API + matcher + threading через `RunTurnDecisionInput.priorIntent`.
  Phase 2 (follow-up): wiring per-session intent cache на caller layer (auto-reply
  / pi-embedded-runner) — sub-plan создаётся отдельно после merge PR-H.

audit_gaps_closed: []

todos:
  - id: bootstrap-readonly-audit
    content: Прочитаны roadmap §pr-h-session-aware-clarify (FIXED design spec), commitment_kernel_policy_gate_full.plan.md (Stage 1 baseline), clarification-policy.ts + tests, trace.ts ClarificationPolicyDowngradeMarker, run-turn-decision.ts maybeDowngradeClarification + RunTurnDecisionInput, semantic-intent.ts (TargetRef union + OperationHint), index.ts exports.
    status: completed
  - id: implement-policy-extension
    content: Расширить CLARIFICATION_POLICY_REASONS (+'ambiguity_resolved_by_session_history'), добавить INHERITABLE_INTENT_FIELDS frozen tuple ['target.kind','operation'], extend ClarificationPolicyDecision (+inheritedFields), extend ClarificationPolicyEvaluateInput (+priorIntent), implement evaluateStage1_5 + collectInheritableFields + hasMatchingBlockingReasonForField + curated reason-fragment classes (TARGET_CLASS, OPERATION_CLASS).
    status: completed
  - id: extend-trace-marker
    content: Extend ClarificationPolicyDowngradeMarker.downgradeReason union with 'ambiguity_resolved_by_session_history', add optional inheritedFields с closed-string union element type. Frozen layer touched → frozen-layer PR-body checkbox обязателен.
    status: completed
  - id: thread-prior-intent-through-run-turn-decision
    content: Add RunTurnDecisionInput.priorIntent (optional SemanticIntent), pass через gate.evaluate, build marker с inheritedFields when present, no caller-layer changes (Phase 2 follow-up).
    status: completed
  - id: export-new-symbols
    content: Export INHERITABLE_INTENT_FIELDS + InheritableIntentField from src/platform/commitment/index.ts.
    status: completed
  - id: unit-tests
    content: Reverse-test для расширенного CLARIFICATION_POLICY_REASONS (length 2, exact tuple, frozen, push throws). Reverse-test для INHERITABLE_INTENT_FIELDS (frozen, exact tuple). 9 Stage 1.5 cases в clarification-policy.test.ts (positive target.kind, positive operation, multi-field, contradiction target, contradiction operation, cold-start, reason-mismatch, Stage 1 precedence, partial-match subset).
    status: completed
  - id: tsgo-scoped-tests
    content: pnpm tsgo green; pnpm test -- src/platform/commitment/__tests__/clarification-policy.test.ts src/platform/decision/run-turn-decision.clarification-downgrade.test.ts green.
    status: completed
  - id: branch-pr-merge-docs-handoff
    content: Ветка fix/orchestrator-clarify-session-aware от origin/dev; gh pr create vs dev с frozen-layer checkbox (telemetry-only); admin-merged 185cf7d3fb (CI infra note — BlackSmith runners offline, frozen-layer check на GitHub-hosted прошёл SUCCESS, остальные 6 queued 38+ min); finalize Handoff Log + master §0 row.
    status: completed
  - id: phase2-caller-layer-wiring
    content: FUTURE follow-up sub-plan — per-session SemanticIntent cache wiring в 4 callers runTurnDecision (input.ts:541, input.ts:578, plugin.ts:80, plugin.ts:340). Forward-compat constraints (roadmap §4 — sessionId keying, sliding-window N=5, TTL, max-size, idempotent reads, no cross-session leakage, no module-level singleton). Без Phase 2 Stage 1.5 gate API-complete но never fires в production.
    status: pending

isProject: false
---

# PR-H — session-history-aware clarify (Stage 1.5 ClarificationPolicy)

## 0. Provenance

| Field | Value |
| --- | --- |
| Parent roadmap | `.cursor/plans/commitment_kernel_smart_orchestrator_roadmap.plan.md` — todo `pr-h-session-aware-clarify`, §3 row 3, §1.5 FIXED design spec |
| Baseline Stage 1 | `.cursor/plans/commitment_kernel_policy_gate_full.plan.md` — Bug D Stage 1 merged (`caca87a634`) |
| Predecessors merged | PR-G [#111](https://github.com/Primus-max/god-mode-core/pull/111) `d0b3c3fc33`; Bug A `7f56fbd9ab`; Bug D `caca87a634`; PR-A.2 `3df3138fcc` (direct-commit) |
| Target branch | `dev`; git branch `fix/orchestrator-clarify-session-aware` off `origin/dev` HEAD `01c9a30311` |
| Frozen layer | **Затрагивается** (`src/platform/decision/trace.ts` — `ClarificationPolicyDowngradeMarker.downgradeReason` union extension) → PR-body `compatibility` checkbox обязателен (`scripts/check-frozen-layer-label.mjs`) |

## 1. Hard invariants this fix MUST keep

Ссылка: `.cursor/rules/commitment-kernel-invariants.mdc` (все 16). Для PR-H критично:

| # | Invariant | Как соблюсти |
| --- | --- | --- |
| 5 | Нет phrase/text-rule на `UserPrompt` / `RawUserTurn` вне whitelist | Stage 1.5 matcher работает **только** на `SemanticIntent` структурных полях (`target.kind`, `operation`) и classifier OUTPUT (`blockingReasons`). НЕ читает ledger entries text, message bodies, user prompt. |
| 6 | `IntentContractor` — единственный reader сырого user text | Phase 1 не добавляет cache; Phase 2 (follow-up) cache читает уже распарсенные `SemanticIntent` от IntentContractor, не raw text. |
| 8 | `commitment/` ↛ `decision/` | `clarification-policy.ts` (commitment) не импортирует из `decision/`. `run-turn-decision.ts` (decision) импортирует из commitment, как и до этого. |
| 11 | Пять frozen decision contracts остаются неизменными | `ClarificationPolicyDowngradeMarker` в `trace.ts` — observability marker, **не** TaskContract / OutcomeContract / QualificationExecutionContract / ResolutionContract / RecipeRoutingHints. Расширение `downgradeReason` union — closed-string, frozen via `Object.freeze` reverse-test. |
| 15 | Maintainer signoff для архитектурных сдвигов | PR-H — расширение существующего `CLARIFICATION_POLICY_REASONS` set ещё одним closed-string значением, signoff не требуется (тот же класс изменения, что Bug D Stage 1). |

## 2. Hypothesis

**H1:** Vladimir's Stage 1 (Bug D, merged) handles deployment-target ambiguity via `DEPLOYMENT_BLOCKING_REASON_FRAGMENTS` + `hasExplicitLocalSignal`. Other classes of "ambiguous classifier output" (target unspecified, operation/action ambiguous, intent unclear) don't match Stage 1 fragments → bot asks clarify even when prior turn's intent already resolved the ambiguity structurally.

**H2:** Per-turn `SemanticIntent` is already produced by `IntentContractor`; the only missing piece is a way to feed previous turn's intent back to `ClarificationPolicy.evaluate`. Adding `priorIntent?: SemanticIntent` to the input (and threading from `RunTurnDecisionInput.priorIntent`) is sufficient at the API layer — caller-side per-session caching is a separate concern (Phase 2 follow-up).

**H3:** Structural inheritance (target.kind unspecified→workspace; operation undefined→create) combined with curated reason-class fragments is enough to fire correctly without false positives, given the contradiction guard is implicit (current intent set explicitly to a different value → field not inheritable).

## 3. Design (FIXED, не на усмотрение чата)

1. **API extension (clarification-policy.ts):**
   - `CLARIFICATION_POLICY_REASONS = Object.freeze(["ambiguity_resolved_by_intent", "ambiguity_resolved_by_session_history"] as const)`.
   - `INHERITABLE_INTENT_FIELDS = Object.freeze(["target.kind", "operation"] as const)`.
   - `ClarificationPolicyDecision` (false branch) gains optional `inheritedFields: readonly InheritableIntentField[]`.
   - `ClarificationPolicyEvaluateInput` gains optional `priorIntent: SemanticIntent`.

2. **Curated reason-fragment classes (clarification-policy.ts):**
   - `TARGET_CLASS_BLOCKING_REASON_FRAGMENTS = ["target", "destination", "scope"]`.
   - `OPERATION_CLASS_BLOCKING_REASON_FRAGMENTS = ["action", "operation", "verb", "intent", "what to do", "next step", "command"]`.
   - `FIELD_TO_BLOCKING_REASON_FRAGMENTS: Map<InheritableIntentField, readonly string[]>` linking each inheritable field to its class.
   - Matched against `AmbiguityProfileEntry.reason` strings (classifier OUTPUT) — invariant #5 holds.

3. **Algorithm (`evaluate`):**
   - Stage 1 (existing) runs first. If it downgrades, return immediately.
   - Stage 1.5: if `priorIntent` undefined, bypass.
   - `collectInheritableFields(intent, priorIntent)` returns subset of `INHERITABLE_INTENT_FIELDS` where:
     - `target.kind`: `priorIntent.target.kind !== "unspecified"` AND `intent.target.kind === "unspecified"`.
     - `operation`: `priorIntent.operation !== undefined` AND `intent.operation === undefined`.
   - Contradiction guard implicit: if current intent has the field set explicitly (to anything different), field is NOT inheritable (current is set, not empty).
   - Filter inheritable fields to those whose curated reason class includes ≥1 of `blockingReasons`.
   - If non-empty → downgrade with `inheritedFields=Object.freeze(matched)`.

4. **Trace marker extension (trace.ts):**
   - `ClarificationPolicyDowngradeMarker.downgradeReason: "ambiguity_resolved_by_intent" | "ambiguity_resolved_by_session_history"`.
   - Optional `inheritedFields?: readonly ("target.kind" | "operation")[]` — closed-string union element type mirrors `INHERITABLE_INTENT_FIELDS`.
   - **Frozen layer touched** → PR-body `compatibility` checkbox required.

5. **RunTurnDecisionInput threading (run-turn-decision.ts):**
   - Add `priorIntent?: SemanticIntent` to `RunTurnDecisionInput`.
   - In `maybeDowngradeClarification`, pass `priorIntent: input.priorIntent` to `gate.evaluate`.
   - Build marker with `inheritedFields` when present (omitted otherwise to keep Stage 1 marker shape backward-compatible).

6. **Phase 2 (FUTURE, separate sub-plan after PR-H merge):**
   - Per-session `SemanticIntent` cache at appropriate caller layer (auto-reply / pi-embedded-runner).
   - Cache keyed by sessionId, sliding-window size N=5, TTL, max-size limit.
   - Wire cache into all 4 callers of `runTurnDecision` (input.ts:541, input.ts:578, plugin.ts:80, plugin.ts:340).
   - **Forward-compat constraints** (roadmap §4): no module-level singleton state; per-session keying; idempotent reads; no cross-session leakage.

## 4. Scope-of-fix matrix

| # | Layer | File | Изменение | Invariant |
| --- | --- | --- | --- | --- |
| 1 | Reason set | `src/platform/commitment/clarification-policy.ts` | Extend `CLARIFICATION_POLICY_REASONS` (+1 reason); add `INHERITABLE_INTENT_FIELDS` frozen tuple; extend `ClarificationPolicyDecision` (+`inheritedFields`); extend `ClarificationPolicyEvaluateInput` (+`priorIntent`). | #5, #6, #15 |
| 2 | Matcher | `src/platform/commitment/clarification-policy.ts` | Add `evaluateStage1_5` + `collectInheritableFields` + `hasMatchingBlockingReasonForField` + curated reason-fragment classes. | #5, #6 |
| 3 | Trace marker | `src/platform/decision/trace.ts` | Extend `ClarificationPolicyDowngradeMarker.downgradeReason` union; add optional `inheritedFields`. **Frozen layer.** | #11 |
| 4 | Input threading | `src/platform/decision/run-turn-decision.ts` | Add `RunTurnDecisionInput.priorIntent`; pass to `gate.evaluate`; build marker with inheritedFields when present. | #8 |
| 5 | Public exports | `src/platform/commitment/index.ts` | Export `INHERITABLE_INTENT_FIELDS` + `InheritableIntentField`. | — |
| 6 | Unit tests | `src/platform/commitment/__tests__/clarification-policy.test.ts` | Update reverse-test (length 2 tuple); add `INHERITABLE_INTENT_FIELDS` reverse-test; 9 Stage 1.5 cases. | — |

## 5. Acceptance

Per roadmap §pr-h-session-aware-clarify acceptance:

- ✅ **Positive (target.kind)**: turn1 priorIntent with `target.kind="workspace"`; turn2 intent with `target.kind="unspecified"` + blocking reason class "target" → fires with `inheritedFields=["target.kind"]`.
- ✅ **Positive (operation)**: prior with `operation={kind:"create"}`, current with `operation=undefined` + blocking reason class "action/operation/intent" → fires with `inheritedFields=["operation"]`.
- ✅ **Positive (multi-field)**: both fields inheritable, both reason classes match → fires with both fields.
- ✅ **Negative (contradiction target)**: turn2 intent explicitly `target.kind="external_channel"` → does NOT fire.
- ✅ **Negative (contradiction operation)**: turn2 intent explicitly `operation={kind:"observe"}` → does NOT fire.
- ✅ **Negative (cold-start)**: no `priorIntent` → does NOT fire.
- ✅ **Negative (reason mismatch)**: inheritable but blocking reason in unrelated class → does NOT fire.
- ✅ **Stage 1 precedence**: deployment-target ambiguity + workspace target + priorIntent both present → fires Stage 1 marker (`ambiguity_resolved_by_intent`), NOT Stage 1.5.
- ✅ **Subset matching**: only one reason class matches → `inheritedFields` contains only that field, not all inheritable.
- ✅ **Reverse-tests**: `CLARIFICATION_POLICY_REASONS` length 2 + frozen + push throws; `INHERITABLE_INTENT_FIELDS` length 2 + frozen + push throws.
- ✅ **Type-check**: `pnpm tsgo` exit 0.
- ✅ **Existing Stage 1 tests**: 8 Stage 1 tests still green; existing `run-turn-decision.clarification-downgrade.test.ts` still green.

## 6. Handoff Log

| Date | Step | Branch | SHA | PR # | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-05-01 | PR-H Phase 1 (API + matcher + threading) merged | `fix/orchestrator-clarify-session-aware` | `185cf7d3fb` | [#112](https://github.com/Primus-max/god-mode-core/pull/112) | Phase 1 closes roadmap step 3 на API/matcher/test layer. Local validation: `pnpm tsgo` exit 0; 29/29 tests в `clarification-policy.test.ts` + `run-turn-decision.clarification-downgrade.test.ts`. CI infra note: BlackSmith `blacksmith-16vcpu-ubuntu-2404` runners offline (`/repos/.../actions/runners` total_count=0); 6 checks (`preflight`, `docs-scope`, `label`, `no-tabs`, `actionlint`, `label-issues`) queued 38+ min не стартовали; frozen-layer check (на GitHub-hosted) прошёл SUCCESS; admin-merged after local validation. **Phase 2 (FUTURE)**: caller-layer per-session intent cache wiring — отдельный sub-plan, без него Stage 1.5 API-complete но never fires production. |

## 7. References

- `.cursor/rules/pr-session-bootstrap.mdc` — bootstrap protocol для PR-чатов.
- `.cursor/rules/commitment-kernel-invariants.mdc` — 16 hard invariants.
- `.cursor/plans/commitment_kernel_v1_master.plan.md` — master plan.
- `.cursor/plans/commitment_kernel_smart_orchestrator_roadmap.plan.md` — parent roadmap (§3 row 3, §pr-h-session-aware-clarify FIXED spec).
- `.cursor/plans/commitment_kernel_policy_gate_full.plan.md` — Stage 1 baseline (Bug D merged).
- `scripts/check-frozen-layer-label.mjs` — frozen-layer PR-body checkbox enforcement.
