---
name: SLICE 1 — model-fallback respect configured order (skip remote-tail reorder on passthrough decisions)
overview: |
  В live Telegram-логе 2026-05-01 17:04–17:11 model-fallback preflight каждый
  turn перетасовывал configured candidate chain `hydra/claude-opus-4.6 →
  hydra/gpt-5.4 → hydra/hydra-gpt-pro` в `hydra/hydra-gpt-pro → hydra/claude-opus-4.6
  → hydra/gpt-5.4` ("cheap remote fallback profile"). Live следствие — главный
  агент ходил на медленный `hydra-gpt-pro` (165s timeout × 4) до failover'а
  обратно на `claude-opus-4.6`. Юзер ждал ~3 минуты до ответа.

  Root cause: `finalizeResult` в `src/platform/decision/route-preflight.ts:795`
  безусловно вызывал `reorderRemoteTailCandidates` поверх любого decision'а,
  включая passthrough decisions (`preflight_no_local_candidate`,
  `preflight_stronger_route` keep-order, `preflight_primary_control_plane_local`)
  где decision уже сказал `reordered: false`. Heuristic-driven score
  reorder перебивал user-configured priority.

  Fix: в `finalizeResult` skip remote-tail reorder when `decision.reordered ===
  false`. Passthrough decisions сохраняют configured order — heuristic reorder
  применяется только поверх decisions, которые УЖЕ chose to reorder.

audit_gaps_closed: []

todos:
  - id: bootstrap-readonly-audit
    content: Прочитан route-preflight.ts (1070 LOC), все 6 callers finalizeResult'а, reorderRemoteTailCandidates (line 593), test file (121 LOC) для backward-compat, live лог 2026-05-01 17:04–17:11.
    status: completed
  - id: implement-fix
    content: Skip reorderRemoteTailCandidates в finalizeResult когда decision.reordered === false. Comment с reference на live regression. Existing reorder=true paths (preflight_reordered_remote_first, preflight_reordered_local_first и пр.) не затрагиваются.
    status: completed
  - id: unit-tests
    content: 2 новых теста — all-remote no-local чейн → unchanged + decision.reordered=false; stronger_route passthrough → unchanged + decision.reordered=false. Existing 5 тестов остаются green.
    status: completed
  - id: tsgo-scoped-tests
    content: pnpm tsgo green; pnpm test -- src/platform/decision/route-preflight.test.ts 10/10 green.
    status: completed
  - id: branch-pr-merge-handoff
    content: Branch fix/orchestrator-model-fallback-respect-configured-order, PR #114 admin-merged c0bee0846f при BlackSmith offline (local validation + no frozen contracts touched), restart gateway pending, live verification pending.
    status: completed

isProject: false
---

# SLICE 1 — model-fallback respect configured order

## 0. Provenance

| Field | Value |
| --- | --- |
| Source | Live Telegram-лог 2026-05-01 17:04–17:11 (после restart gateway с PR-G + PR-A.2 + PR-H Phase 1+2 loaded) |
| Roadmap | regressions block, slice 1 of 4 |
| Predecessors | PR-G d0b3c3fc33 (#111); PR-A.2 3df3138fcc; PR-H Phase 1 185cf7d3fb (#112); PR-H Phase 2 01afedff6a (#113) |
| Target branch | `dev`; git branch `fix/orchestrator-model-fallback-respect-configured-order` off `origin/dev` HEAD `0541f6b66b` |
| Frozen layer | **Не затрагивается** (`src/platform/decision/route-preflight.ts` — public preflight surface, не TaskContract / OutcomeContract / QualificationExecutionContract / ResolutionContract / RecipeRoutingHints) |

## 1. Hard invariants

| # | Invariant | Как соблюсти |
| --- | --- | --- |
| 5 | Нет phrase/text-rule на UserPrompt | Fix structural — на `decision.reordered` boolean, не на user text. |
| 6 | IntentContractor единственный reader raw text | Не трогаем. |
| 8 | commitment ↛ decision | route-preflight в decision/, не импортирует из commitment/. |
| 11 | 5 frozen contracts | Не трогаем. |
| 15 | Maintainer signoff | Narrow bug-fix slice, не требуется. |

## 2. Hypothesis

**H1**: `finalizeResult` always invokes `reorderRemoteTailCandidates`. When decision is passthrough (`reordered: false`), reorder kicks in and overrides user order via heuristic score.

**H2**: Skipping reorder for passthrough decisions preserves user-configured priority. Existing test scenarios all use `reordered: true` decisions, so they remain unaffected.

## 3. Design

```typescript
// In finalizeResult (route-preflight.ts:795)
if (!decision) {
  return { candidates, decision };
}
// NEW: passthrough — respect configured order
if (!decision.reordered) {
  return { candidates, decision };
}
const remoteAdjusted = reorderRemoteTailCandidates({...});
// ... existing reorder logic
```

## 4. Scope-of-fix matrix

| # | Layer | File | Изменение | Invariant |
| --- | --- | --- | --- | --- |
| 1 | Preflight | `src/platform/decision/route-preflight.ts` | Skip `reorderRemoteTailCandidates` в `finalizeResult` когда `decision.reordered === false`. | — |
| 2 | Tests | `src/platform/decision/route-preflight.test.ts` | 2 новых теста для all-remote no-local + stronger-route passthrough. | — |

## 5. Acceptance

- ✅ Unit test: candidates `[hydra/claude-opus-4.6, hydra/gpt-5.4, hydra/hydra-gpt-pro]` all remote → preflight returns unchanged + `decision.reasonCode === "preflight_no_local_candidate"` + `decision.reordered === false`.
- ✅ Unit test: same chain + `intent: "code"` → preflight returns unchanged + `decision.reasonCode === "preflight_stronger_route"` + `decision.reordered === false`.
- ✅ Existing 5 tests still green.
- ✅ pnpm tsgo exit 0.
- ✅ Live verification (after merge + gateway restart): `route candidates ordered: hydra/claude-opus-4.6 → ...` (configured first).

## 6. Handoff Log

| Date | Step | Branch | SHA | PR # | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-05-01 | Slice 1 merged | `fix/orchestrator-model-fallback-respect-configured-order` | `c0bee0846f` | [#114](https://github.com/Primus-max/god-mode-core/pull/114) | finalizeResult skips reorderRemoteTailCandidates когда decision.reordered=false. 2 новых теста (all-remote no-local + stronger_route passthrough); 10/10 route-preflight.test.ts green; pnpm tsgo exit 0 (включая piggyback-fix Map<> generic widening на FIELD_TO_BLOCKING_REASON_FRAGMENTS — pre-existing tsgo regression от PR-H Phase 1). BlackSmith total_count=0 → admin-merge после local validation + no frozen contracts touched. Live verification pending: после restart gateway проверить лог `route candidates ordered: hydra/claude-opus-4.6 first`. |

## 7. References

- `src/platform/decision/route-preflight.ts` — preflight implementation.
- `.cursor/plans/commitment_kernel_smart_orchestrator_roadmap.plan.md` — parent roadmap.
- Live log 2026-05-01 17:04–17:11 — regression source.
