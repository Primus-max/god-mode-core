---
name: PR-H Phase 2 — caller-layer per-session SemanticIntent cache wiring
overview: |
  Phase 1 (PR #112, merged 185cf7d3fb) добавил Stage 1.5 структурный matcher
  в `ClarificationPolicy` + `RunTurnDecisionInput.priorIntent` threading.
  API-complete но never fires в production — callers `runTurnDecision` не
  передают `priorIntent`, потому что нет per-session intent cache.

  Phase 2 — wiring: расширение существующего `intentLedger` (он уже хранит
  per-session state с TTL/maxEntries) методами `recordRecentIntent` /
  `getRecentIntent`; expose `intent` в `RunTurnDecisionResult`; чтение и
  запись в 2 callers `runTurnDecision` в `src/platform/decision/input.ts`
  (lines 541 + 578).

  plugin.ts callers (`resolveHookExecution` line 80, machine-control fallback
  line 340) — out of scope: они single-shot internal hooks без session
  lifecycle context (нет `sessionId/channelId`); `priorIntent: undefined`
  default — Stage 1.5 silently bypass.

audit_gaps_closed: []

todos:
  - id: bootstrap-readonly-audit
    content: Прочитаны Phase 1 sub-plan (clarification_history_aware), intent-ledger.ts class+singleton pattern, run-turn-decision.ts return shape, input.ts:541+578 caller flow, plugin.ts:80+340 caller context.
    status: completed
  - id: extend-intent-ledger
    content: Add recentIntents field to IntentLedgerSessionState; recordRecentIntent + getRecentIntent methods на IntentLedger class; constants RECENT_INTENT_HISTORY_WINDOW=5 + RECENT_INTENT_CONFIDENCE_FLOOR=0.5; reuse INTENT_LEDGER_TTL_MS для eviction. Sliding window сохраняет последние N records, getRecentIntent возвращает наиболее свежий non-expired (cutoff = now-ttlMs).
    status: completed
  - id: expose-intent-in-result
    content: Add readonly intent? to RunTurnDecisionResult; thread shadowOutcome.intent в return statement runTurnDecision (no breaking change to existing callers).
    status: completed
  - id: wire-input-callers
    content: input.ts callers 541+578 — pre-call read intentLedger.getRecentIntent(ledgerSessionId, ledgerChannelId), pass as priorIntent to RunTurnDecisionInput; post-flow record finalClassifiedIntent via intentLedger.recordRecentIntent. Same priorIntent reused для обоих calls (workspace re-classify в том же turn'е).
    status: completed
  - id: unit-tests
    content: 8 cases для intent-ledger recent-intent — record+read most recent; sliding window latest; cross-session isolation; cross-channel isolation; cold start; low-confidence drop; window trim; TTL eviction.
    status: completed
  - id: tsgo-scoped-tests
    content: pnpm tsgo green; pnpm test -- src/platform/session/intent-ledger.test.ts src/platform/commitment/__tests__/clarification-policy.test.ts src/platform/decision/run-turn-decision.clarification-downgrade.test.ts green.
    status: pending
  - id: branch-pr-merge-docs-handoff
    content: Ветка fix/orchestrator-clarify-session-aware-wiring от origin/dev; gh pr create vs dev; CI infra может быть offline (BlackSmith) — admin-merge after local validation; finalize Handoff Log на 3 plan-файлах.
    status: pending

isProject: false
---

# PR-H Phase 2 — caller-layer per-session SemanticIntent cache wiring

## 0. Provenance

| Field | Value |
| --- | --- |
| Parent Phase 1 | `.cursor/plans/commitment_kernel_clarification_history_aware.plan.md` (Phase 1 merged 185cf7d3fb #112) |
| Parent roadmap | `.cursor/plans/commitment_kernel_smart_orchestrator_roadmap.plan.md` — §3 row 3 (PR-H), §4 forward-compat constraints |
| Predecessors merged | PR-G `d0b3c3fc33` (#111); PR-A.2 `3df3138fcc` (direct); PR-H Phase 1 `185cf7d3fb` (#112); Bug A `7f56fbd9ab`; Bug D `caca87a634` |
| Target branch | `dev`; git branch `fix/orchestrator-clarify-session-aware-wiring` off `origin/dev` HEAD `a6ebd71998` |
| Frozen layer | **Не затрагивается.** `RunTurnDecisionResult.intent` — public surface decision module (не frozen contract). |

## 1. Hard invariants this Phase 2 MUST keep

| # | Invariant | Как соблюсти |
| --- | --- | --- |
| 5 | Нет phrase/text-rule на UserPrompt | Cache хранит структурный `SemanticIntent` объект (продукт IntentContractor), не raw text. Read+record не парсят user prompt. |
| 6 | IntentContractor — единственный reader raw text | Cache читает intent после IntentContractor классификации. Не вызывает classify самостоятельно. |
| 8 | commitment ↛ decision | intent-ledger.ts (session/) импортирует SemanticIntent из commitment/. decision/ модули используют intent-ledger через input.ts. Уже было в Phase 1. |
| 11 | Пять frozen contracts | Не трогаем. |
| 15 | Maintainer signoff | Не требуется (то же class изменение что Phase 1). |

## 2. Hypothesis

**H1:** Phase 1 gate fires только при наличии `priorIntent`. Без caller-layer записи cache всегда empty → `getRecentIntent` returns undefined → `priorIntent: undefined` → Stage 1.5 silently bypass → бот всё ещё клерифаит в continuous chat.

**H2:** `intentLedger` (`src/platform/session/intent-ledger.ts`) уже хранит per-session state (entries, workspace, identity) с TTL. Расширение его methods для intent history — наименее инвазивно: тот же composite key `${sessionId}::${channelId}`, тот же TTL, тот же expiration pattern.

**H3:** input.ts callers (541+578) уже имеют `ledgerSessionId` + `ledgerChannelId` derived из `params.sessionEntry.sessionId` + `params.channelHints`. Эти 2 callers — реальный production hot path для continuous chat (Telegram/iMessage/WhatsApp). plugin.ts callers (80+340) — internal hooks без session lifecycle, не нуждаются в Phase 2 wiring.

## 3. Design

1. **intent-ledger.ts расширение:**
   - `RECENT_INTENT_HISTORY_WINDOW = 5` (sliding-window size).
   - `RECENT_INTENT_CONFIDENCE_FLOOR = 0.5` (drop low-confidence stub intents).
   - `RecentIntentRecord = { intent: SemanticIntent; recordedAt: number }`.
   - `IntentLedgerSessionState.recentIntents?: RecentIntentRecord[]`.
   - `recordRecentIntent({ sessionId, channelId, intent, recordedAt? })`: confidence floor check, append + slice к window.
   - `getRecentIntent(sessionId, channelId): SemanticIntent | undefined`: scan from end, return latest non-expired (cutoff = now - ttlMs).

2. **RunTurnDecisionResult расширение:**
   - `readonly intent?: SemanticIntent` — exposed from `shadowOutcome.intent`.
   - Spread в return statement: `...(shadowOutcome.intent ? { intent: shadowOutcome.intent } : {})`.
   - Backward-compatible (optional field).

3. **input.ts callers (541 + 578):**
   - Pre-call (line 540 area): `const priorIntent = ledgerSessionId && ledgerChannelId ? intentLedger.getRecentIntent(...) : undefined`.
   - Pass `priorIntent` to **обоих** `runTurnDecision` calls (541 + 578).
   - Capture intent: `const { productionDecision: classified, intent: classifiedIntent } = await runTurnDecision(...)`.
   - 578 path captures `workspaceIntent`, fallback to `classifiedIntent` if undefined: `finalClassifiedIntent = workspaceIntent ?? finalClassifiedIntent`.
   - Post-flow: `if (finalClassifiedIntent && ledgerSessionId && ledgerChannelId) intentLedger.recordRecentIntent(...)`.

4. **plugin.ts callers (out of scope):**
   - `resolveHookExecution` (line 80): single-shot, no session lifecycle, default `priorIntent: undefined`.
   - Machine-control fallback (line 340): hook-context, no sessionId/channelId, default undefined.

## 4. Scope-of-fix matrix

| # | Layer | File | Изменение | Invariant |
| --- | --- | --- | --- | --- |
| 1 | Cache primitives | `src/platform/session/intent-ledger.ts` | + import `SemanticIntent`; + 2 constants; + `RecentIntentRecord` type; + `recentIntents` в session state; + 2 class methods. | #5, #6 |
| 2 | Result shape | `src/platform/decision/run-turn-decision.ts` | `RunTurnDecisionResult.intent?: SemanticIntent`; spread `shadowOutcome.intent` в return. | #11 |
| 3 | Caller wiring | `src/platform/decision/input.ts` | Pre-call read `intentLedger.getRecentIntent`; thread `priorIntent` to 2 runTurnDecision calls; post-flow record `finalClassifiedIntent`. | — |
| 4 | Unit tests | `src/platform/session/intent-ledger.test.ts` | 8 cases для recent-intent — record/read, sliding window, isolation, cold-start, low-confidence drop, window trim, TTL eviction. | — |

## 5. Acceptance

- ✅ `recordRecentIntent` + `getRecentIntent` сохраняют+возвращают intent для same `(sessionId, channelId)`.
- ✅ Cross-session isolation (different sessionId → undefined).
- ✅ Cross-channel isolation (same sessionId, different channelId → undefined).
- ✅ Cold start (no record) → undefined.
- ✅ Low-confidence (`confidence < 0.5`) silently dropped.
- ✅ Sliding window trims to `RECENT_INTENT_HISTORY_WINDOW=5`.
- ✅ TTL eviction после `INTENT_LEDGER_TTL_MS=15min`.
- ✅ `pnpm tsgo` exit 0.
- ✅ Existing 29/29 PR-H Phase 1 tests still green.

## 6. Handoff Log

| Date | Step | Branch | SHA | PR # | Notes |
| --- | --- | --- | --- | --- | --- |

## 7. References

- `.cursor/plans/commitment_kernel_clarification_history_aware.plan.md` — Phase 1 baseline.
- `.cursor/plans/commitment_kernel_smart_orchestrator_roadmap.plan.md` — parent roadmap (§3 row 3, §4 forward-compat).
- `.cursor/rules/commitment-kernel-invariants.mdc` — 16 hard invariants.
- `src/platform/session/intent-ledger.ts` — existing per-session state holder.
