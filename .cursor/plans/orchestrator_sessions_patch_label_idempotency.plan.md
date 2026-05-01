---
name: SLICE 2 — sessions.patch label idempotency (extend G3 fix to patch path)
overview: |
  В live логе 2026-05-01 17:08+: `[ws] ⇄ res ✗ sessions.patch errorCode=INVALID_REQUEST
  errorMessage=label already in use: Валера` после
  `worker_terminal_complete_verbatim mode=holding parent=agent:dev:main
  child=agent:dev:subagent:b857...`. PR-4a (`a972638e48`, sub-plan
  `commitment_kernel_idempotency_fix.plan.md`) закрыл G3 на spawn-path через
  `findLivePersistentSessionByLabel` → `action=reuse_by_session`. Но когда
  spawn-уровневый guard НЕ срабатывает (origin mismatch между turn'ами,
  cleanup race и т.п.), spawn создаёт НОВЫЙ entry, далее `sessions.patch`
  пытается выставить label на новый entry, и наивный `for (entry of store)`
  loop в `applySessionsPatchToStore` (sessions-patch.ts:240-247) срывается
  с INVALID_REQUEST.

  Root cause: label-conflict guard в applySessionsPatchToStore не различает
  "real concurrent collision" vs "stale terminal sibling под тем же agentId
  scope" — все label-coincidences эквивалентно отвергаются.

  Fix (narrow): extract helper `classifyLabelConflict` (`src/sessions/session-label-conflict.ts`),
  classifying conflict into `none | same_logical_session | conflict`. Same-logical
  detection: оба ключа — subagent под одним и тем же `agentId` (через
  `parseAgentSessionKey` + `isSubagentSessionKey` из `routing/session-key.ts`).
  В `applySessionsPatchToStore` "label" branch использует helper: на
  `same_logical_session` → silently skip label set + telemetry
  `[commitment] effect=persistent_session.created action=reuse_label_on_patch`;
  на `conflict` → existing `INVALID_REQUEST` (поведение не меняется); на `none` →
  apply label (поведение не меняется).

  Out of scope: refactoring subagent-spawn.ts (PR-4a продолжает использовать
  `findLivePersistentSessionByLabel` со strict origin matching — это
  spawn-path FAST PATH); helper для patch-path использует более широкий
  agentId-based criterion, поскольку sessions.patch не имеет requesterOrigin.

audit_gaps_closed:
  - G3-extension (sessions.patch path)

todos:
  - id: bootstrap-readonly-audit
    content: Прочитан sessions-patch.ts (538 LOC), sessions-patch.test.ts (label-tests отсутствуют), subagent-persistent-session-query.ts (PR-4a helper), subagent-spawn.ts:516-547 (spawn fast path), routing/session-key.ts (parseAgentSessionKey, isSubagentSessionKey).
    status: completed
  - id: extract-helper
    content: src/sessions/session-label-conflict.ts с pure-функцией classifyLabelConflict({store, storeKey, label}) → "none" | "same_logical_session" | "conflict". Same-logical = (target subagent + conflict subagent + same agentId).
    status: pending
  - id: wire-sessions-patch
    content: В applySessionsPatchToStore "label" branch заменить inline loop на classifyLabelConflict. На same_logical_session — telemetry + skip label set; на conflict — existing error; на none — apply label.
    status: pending
  - id: unit-tests
    content: 4 теста для classifyLabelConflict (none/same/conflict/empty) + 2 теста для sessions-patch (same-logical no-error + non-subagent conflict still errors).
    status: pending
  - id: tsgo-scoped-tests
    content: pnpm tsgo green; pnpm test -- src/sessions/session-label-conflict.test.ts src/gateway/sessions-patch.test.ts green.
    status: pending
  - id: branch-pr-merge-handoff
    content: Branch fix/orchestrator-sessions-patch-label-idempotency, PR через gh, admin-merge при BlackSmith offline (после frozen-layer SUCCESS), update Handoff Log.
    status: pending

isProject: false
---

# SLICE 2 — sessions.patch label idempotency

## 0. Provenance

| Field | Value |
| --- | --- |
| Source | Live Telegram-лог 2026-05-01 17:08+ |
| Roadmap | regressions block, slice 2 of 4 |
| Predecessor | PR-4a `a972638e48` (G3 closed на spawn path) |
| Target branch | `dev`; git branch `fix/orchestrator-sessions-patch-label-idempotency` off `origin/dev` HEAD `91097b4b94` |
| Frozen layer | **Не затрагивается** (`src/gateway/sessions-patch.ts` + новый `src/sessions/session-label-conflict.ts` — public gateway surface, не TaskContract / OutcomeContract / QualificationExecutionContract / ResolutionContract / RecipeRoutingHints) |

## 1. Hard invariants

| # | Invariant | Как соблюсти |
| --- | --- | --- |
| 5 | Нет phrase/text-rule на UserPrompt | Helper решает по структурным session-key полям + `entry.label.trim()`. |
| 6 | IntentContractor единственный reader raw text | Не вызывается. |
| 8 | commitment ↛ decision | sessions/ → routing/, без обращения в decision/. |
| 11 | 5 frozen contracts | Не трогаем. |
| 15 | Maintainer signoff | Narrow bug-fix slice, не требуется. |

## 2. Hypothesis

**H1**: PR-4a fast path фейлит когда `requesterOrigin` нового turn'а не равен origin'у предыдущего spawn'а (например, при смене thread'а Telegram). Spawn proceeds, sessions.patch label fails.

**H2**: Same agentId scope — необходимое и достаточное условие для считать label-collision "same logical session" в sessions.patch path. Origin-strict criterion на этом уровне невозможен (sessions.patch не получает requesterOrigin).

## 3. Design

```typescript
// src/sessions/session-label-conflict.ts (NEW)
export type LabelConflictResolution =
  | { kind: "none" }
  | { kind: "same_logical_session"; conflictKey: string }
  | { kind: "conflict"; conflictKey: string };

export function classifyLabelConflict(params: {
  store: Readonly<Record<string, SessionEntry>>;
  storeKey: string;
  label: string;
}): LabelConflictResolution {
  const trimmedLabel = params.label.trim();
  if (!trimmedLabel) return { kind: "none" };
  const targetAgentId = parseAgentSessionKey(params.storeKey)?.agentId.toLowerCase();
  const targetIsSubagent = isSubagentSessionKey(params.storeKey);
  for (const [key, entry] of Object.entries(params.store)) {
    if (key === params.storeKey || !entry) continue;
    if (entry.label?.trim() !== trimmedLabel) continue;
    if (targetIsSubagent && isSubagentSessionKey(key)) {
      const conflictAgentId = parseAgentSessionKey(key)?.agentId.toLowerCase();
      if (targetAgentId && conflictAgentId === targetAgentId) {
        return { kind: "same_logical_session", conflictKey: key };
      }
    }
    return { kind: "conflict", conflictKey: key };
  }
  return { kind: "none" };
}
```

```typescript
// sessions-patch.ts "label" branch
const resolution = classifyLabelConflict({ store, storeKey, label: parsed.label });
if (resolution.kind === "same_logical_session") {
  console.info("[commitment]", {
    effect: "persistent_session.created",
    action: "reuse_label_on_patch",
    label: parsed.label,
    storeKey,
    conflictKey: resolution.conflictKey,
  });
  // skip next.label = parsed.label (don't propagate the colliding label)
} else if (resolution.kind === "conflict") {
  return invalid(`label already in use: ${parsed.label}`);
} else {
  next.label = parsed.label;
}
```

## 4. Scope-of-fix matrix

| # | Layer | File | Изменение | Invariant |
| --- | --- | --- | --- | --- |
| 1 | Sessions helper | `src/sessions/session-label-conflict.ts` (NEW) | Pure classifier. | — |
| 2 | Gateway | `src/gateway/sessions-patch.ts` | Replace inline label-conflict loop with helper. | — |
| 3 | Tests | `src/sessions/session-label-conflict.test.ts` (NEW) | 4 cases. | — |
| 4 | Tests | `src/gateway/sessions-patch.test.ts` | 2 cases (same-logical / non-subagent conflict). | — |

## 5. Acceptance

- ✅ Unit test: same agentId subagent collision → `kind: "same_logical_session"`.
- ✅ Unit test: different agentId collision → `kind: "conflict"`.
- ✅ Unit test: main session collision → `kind: "conflict"`.
- ✅ sessions-patch: same-logical → ok=true, label не выставлен, telemetry log.
- ✅ sessions-patch: cross-agent conflict → existing error preserved.
- ✅ pnpm tsgo exit 0.
- ✅ Live verification (после merge + restart): no `INVALID_REQUEST: label already in use` спам.

## 6. Handoff Log

| Date | Step | Branch | SHA | PR # | Notes |
| --- | --- | --- | --- | --- | --- |

## 7. References

- `src/agents/subagent-persistent-session-query.ts` — PR-4a spawn-path helper.
- `.cursor/plans/commitment_kernel_idempotency_fix.plan.md` — original PR-4a sub-plan.
- Live log 2026-05-01 17:08+ — regression source.
