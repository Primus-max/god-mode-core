---
name: SLICE 3 — PR-H Phase 2 wiring debug instrumentation
overview: |
  PR-H Phase 2 (`01afedff6a`, #113) wired per-session SemanticIntent cache
  через intentLedger.recordRecentIntent / getRecentIntent. В live Telegram
  session `141adc3c-98a4-4a4b-93c1-b6846a8861a9` каждый turn по-прежнему
  показывает `[intent-ledger] peek=0 injected=0` (это PendingCommitments
  log, отдельно от Stage 1.5 history) и Stage 1.5 не файрит.

  3 кандидата root cause:
  (a) ledgerSessionId/ledgerChannelId undefined в input.ts callers (Telegram
      session vs intent-ledger session mapping);
  (b) classifier confidence < RECENT_INTENT_CONFIDENCE_FLOOR=0.5 → silently
      drop в recordRecentIntent;
  (c) session-id changes per turn (no stable mapping в auto-reply layer).

  **Phase A (этот PR)**: добавить structured debug logging в `recordRecentIntent`
  / `getRecentIntent` + wiring-side log в `input.ts`. После merge + restart
  gateway пользователь видит из live логов какая из 3 гипотез верна, без
  необходимости code-инспекции.

  **Phase B (follow-up, требует live observation)**: запустить Telegram,
  собрать логи, классифицировать root cause по структурным сигналам
  (`[intent-history]` event lines).

  **Phase C (follow-up, gated на Phase B verdict)**: исправить root cause.
  Возможные сценарии:
  - candidate (b) подтверждён → понизить `RECENT_INTENT_CONFIDENCE_FLOOR`
    или поднимать confidence в IntentContractor для коротких греетингов.
  - candidate (a) подтверждён → починить session/channel id mapping в
    auto-reply / pi-embedded-runner.
  - candidate (c) подтверждён → svesti Telegram chat→sessionId mapping
    к stable per-chat sessionId (separate scope).

audit_gaps_closed: []

todos:
  - id: bootstrap-readonly-audit
    content: Прочитан intent-ledger.ts:467-513 (recordRecentIntent / getRecentIntent), input.ts:479-545 (ledgerSessionId/ledgerChannelId derivation + priorIntent wiring), intent-contractor-impl.ts (lowConfidenceIntent paths), DEFAULT_INTENT_CONTRACTOR_CONFIDENCE_THRESHOLD=0.6 vs RECENT_INTENT_CONFIDENCE_FLOOR=0.5.
    status: completed
  - id: phase-a-record-log
    content: '[intent-history] event=record session=<sid> channel=<cid> confidence=<num.NN> target.kind=<kind> operation=<kind> result=accept|reject_low_confidence + window=<N> | floor=<num>'
    status: completed
  - id: phase-a-get-log
    content: '[intent-history] event=get session=<sid> channel=<cid> records=<n> result=cold_start|hit|expired (+ target.kind/operation на hit, ttl_ms на expired)'
    status: completed
  - id: phase-a-wire-log
    content: '[intent-history] event=wire session=<sid> channel=<cid> priorIntent=0|1 (+target.kind/operation если 1) — pre-runTurnDecision marker в input.ts. End-to-end visibility: видно когда session/channel undefined (a), когда recent-intent miss (b/c).'
    status: completed
  - id: unit-tests
    content: 5 новых тестов на defaultRuntime.log spy — accept / reject_low_confidence / cold_start / hit / expired. 31/31 intent-ledger.test.ts green.
    status: completed
  - id: tsgo-scoped-tests
    content: pnpm tsgo green; pnpm test -- src/platform/session/intent-ledger.test.ts 31/31 green.
    status: completed
  - id: branch-pr-merge-handoff
    content: Branch fix/orchestrator-clarify-history-wiring-debug, PR --base dev, admin-merge при BlackSmith offline, restart gateway, collect Telegram log, проанализировать [intent-history] events.
    status: pending
  - id: phase-b-collect-evidence
    content: live Telegram conversation 2-3 turn'а, grep `[intent-history]` lines, классифицировать root cause из {a,b,c}. (Out of scope для этого PR — требует пользовательской интеракции.)
    status: pending
  - id: phase-c-fix-root-cause
    content: Реализовать fix для подтверждённого кандидата. (Gated на Phase B.)
    status: pending

isProject: false
---

# SLICE 3 — PR-H Phase 2 wiring debug instrumentation

## 0. Provenance

| Field | Value |
| --- | --- |
| Source | Live Telegram session `141adc3c-98a4-4a4b-93c1-b6846a8861a9` 2026-05-01 |
| Roadmap | regressions block, slice 3 of 4 (PR-H end-to-end follow-up) |
| Predecessors | PR-H Phase 1 `185cf7d3fb` (#112); PR-H Phase 2 `01afedff6a` (#113) |
| Target branch | `dev`; git branch `fix/orchestrator-clarify-history-wiring-debug` off `origin/dev` HEAD `7b27426b0d` |
| Frozen layer | **Не затрагивается** (`src/platform/session/intent-ledger.ts` + `src/platform/decision/input.ts` — public surface, не TaskContract / OutcomeContract / QualificationExecutionContract / ResolutionContract / RecipeRoutingHints) |

## 1. Hard invariants

| # | Invariant | Как соблюсти |
| --- | --- | --- |
| 5 | Нет phrase/text-rule на UserPrompt | Логи структурные (target.kind, operation.kind, confidence number); raw text не печатается. |
| 6 | IntentContractor единственный reader raw text | Логи читают только структурные SemanticIntent поля. |
| 8 | commitment ↛ decision | session/intent-ledger импортирует SemanticIntent из commitment/ (existing); decision/input.ts вызывает intentLedger через session/ (existing). |
| 11 | 5 frozen contracts | Не трогаем. |
| 15 | Maintainer signoff | Narrow observability slice, не требуется. |

## 2. Hypothesis

**H1 (most likely)**: candidate (b) — IntentContractor LLM возвращает confidence < 0.5 для коротких приветствий ("Привет", "Понял"); recordRecentIntent silently drops. Подтверждение: после Phase A, в live логах видно `[intent-history] event=record result=reject_low_confidence` на каждом turn.

**H2**: candidate (a) — session/channel undefined. Подтверждение: `[intent-history] event=wire session=- channel=-`.

**H3**: candidate (c) — sessionId меняется per-turn. Подтверждение: `[intent-history] event=wire session=<X1> ... event=wire session=<X2 != X1>` между двумя turn'ами.

## 3. Design

```typescript
// intent-ledger.ts recordRecentIntent
const conf = params.intent.confidence.toFixed(2);
const targetKind = params.intent.target?.kind ?? "-";
const operation = params.intent.operation?.kind ?? "-";
if (params.intent.confidence < RECENT_INTENT_CONFIDENCE_FLOOR) {
  defaultRuntime.log(`[intent-history] event=record ... result=reject_low_confidence floor=...`);
  return;
}
// ... record
defaultRuntime.log(`[intent-history] event=record ... result=accept window=<N>`);
```

```typescript
// intent-ledger.ts getRecentIntent
if (no records) defaultRuntime.log(`[intent-history] event=get ... result=cold_start records=0`);
else if (hit) defaultRuntime.log(`[intent-history] event=get ... result=hit target.kind=...`);
else defaultRuntime.log(`[intent-history] event=get ... result=expired ttl_ms=...`);
```

```typescript
// input.ts — pre-runTurnDecision marker
defaultRuntime.log(`[intent-history] event=wire session=... channel=... priorIntent=0|1`);
```

## 4. Scope-of-fix matrix

| # | Layer | File | Изменение | Invariant |
| --- | --- | --- | --- | --- |
| 1 | Cache primitives | `src/platform/session/intent-ledger.ts` | `[intent-history]` log в recordRecentIntent + getRecentIntent. | #5 (структурные поля, не raw text) |
| 2 | Wiring | `src/platform/decision/input.ts` | `[intent-history] event=wire` лог перед runTurnDecision. | #5 |
| 3 | Tests | `src/platform/session/intent-ledger.test.ts` | 5 новых cases (accept / reject_low_conf / cold_start / hit / expired). | — |

## 5. Acceptance

- ✅ Phase A: pnpm tsgo exit 0; 31/31 intent-ledger.test.ts green.
- ⏳ Phase B: live Telegram 2 turn'а покажут root cause в `[intent-history]` events (gated на user action — после restart gateway).
- ⏳ Phase C: implement fix per Phase B verdict (separate PR).

## 6. Handoff Log

| Date | Step | Branch | SHA | PR # | Notes |
| --- | --- | --- | --- | --- | --- |

## 7. References

- `.cursor/plans/commitment_kernel_clarification_history_aware_phase2.plan.md` — PR-H Phase 2 baseline.
- `src/platform/session/intent-ledger.ts:467-513` — recordRecentIntent / getRecentIntent.
- `src/platform/decision/input.ts:479-545` — wiring entry point.
- `src/platform/commitment/intent-contractor-impl.ts:359,370,420` — lowConfidenceIntent paths (candidate (b)).
