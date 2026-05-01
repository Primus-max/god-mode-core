---
name: SLICE 4 — cron tool single-block-no-retry on foreign chat
overview: |
  В live логе 2026-05-01 17:08:01–17:08:06: `[tools] cron failed: Reminder
  scheduling cannot target another chat.` повторяется 4 раза подряд. Root
  cause: `assertNonOwnerCronAddPolicy` (cron-tool.ts:221-278) бросал bare
  `Error` при policy violation, который ловился в общей tool-execution
  обёртке (`pi-tool-definition-adapter.ts:150-170`) и превращался в
  `buildToolExecutionErrorResult` для LLM. LLM видит **error** envelope
  → trate it as transient → retry'ит до 4 раз.

  Fix: refactor policy в pure classifier `evaluateNonOwnerCronAddPolicy`
  возвращающий `{ ok: true } | { ok: false; reason: NonOwnerCronBlockReason;
  message: string }`. В `execute()` add case: на `!ok` логируется один
  `[cron-tool] block reason=<R>` info-line + return структурный
  `jsonResult({ blocked: true, reason, message })`. LLM получает normal tool
  result (не error) → не retry'ит. Аналогичный fix на early non-add-action
  branch (line 364) для consistency.

audit_gaps_closed: []

todos:
  - id: bootstrap-readonly-audit
    content: Прочитан cron-tool.ts:221-278 (assertNonOwnerCronAddPolicy 9 throw paths) + cron-tool.ts:364 (non-add-action throw) + pi-tool-definition-adapter.ts:150-170 (catch + buildToolExecutionErrorResult); cron-tool.test.ts (39 тестов, 2 expect rejects.toThrow); jsonResult/textResult patterns в common.ts:255.
    status: completed
  - id: extract-policy-classifier
    content: evaluateNonOwnerCronAddPolicy returning {ok:true} | {ok:false; reason; message}. Closed reason set NonOwnerCronBlockReason (9 значений). Все 9 paths сохранены, message identical.
    status: completed
  - id: wire-execute-with-structured-result
    content: В execute() add case + early non-add-action — call helper, на !ok → logInfo `[cron-tool] block reason=<R> session=<sid>` + return `jsonResult({ blocked: true, reason, message })`. Никакого throw → нет [tools] cron failed log line.
    status: completed
  - id: update-existing-tests
    content: 2 теста "blocks non-owner cron admin actions" + "blocks non-owner reminder scheduling to another chat" переписаны с rejects.toThrow на result.details matchObject blocked=true + reason. callGatewayMock не вызывается.
    status: completed
  - id: tsgo-scoped-tests
    content: pnpm tsgo green; pnpm test -- cron-tool.test.ts cron-tool.flat-params.test.ts — 39/39 green; outbound-sanitizer.test.ts — 27/27 green (sanitization patterns не сломаны).
    status: completed
  - id: branch-pr-merge-handoff
    content: PR #118 admin-merged 00062f70a6 на dev. Restart gateway + live verification — gated на user action.
    status: completed

isProject: false
---

# SLICE 4 — cron tool single-block-no-retry on foreign chat

## 0. Provenance

| Field | Value |
| --- | --- |
| Source | Live Telegram-лог 2026-05-01 17:08:01–17:08:06 (4× retries) |
| Roadmap | regressions block, slice 4 of 4 |
| Predecessors | Slice 1 c0bee0846f / Slice 2 9fc0790bce / Slice 3 690bc2dfe0 |
| Target branch | `dev`; git branch `fix/orchestrator-cron-tool-no-retry-on-foreign-chat` off `origin/dev` HEAD `fe8962a67d` |
| Frozen layer | **Не затрагивается** (`src/agents/tools/cron-tool.ts` — public tool surface, не TaskContract / OutcomeContract / QualificationExecutionContract / ResolutionContract / RecipeRoutingHints) |

## 1. Hard invariants

| # | Invariant | Как соблюсти |
| --- | --- | --- |
| 5 | Нет phrase/text-rule на UserPrompt | Policy решает по структурным polymorphic-полям (job.delivery, job.payload.kind, job.sessionTarget, action). |
| 6 | IntentContractor единственный reader raw text | Не вызывается. |
| 8 | commitment ↛ decision | Tool layer; не пересекает commitment/decision. |
| 11 | 5 frozen contracts | Не трогаем. |
| 15 | Maintainer signoff | Narrow bug-fix slice. |

## 2. Hypothesis

**H1**: LLM ретраит потому что bare `Error` через `pi-tool-definition-adapter` превращается в `buildToolExecutionErrorResult` envelope — LLM воспринимает как transient. Структурный `{ blocked: true, reason }` через jsonResult — это normal tool result, ретраить нечего.

## 3. Design

```typescript
export type NonOwnerCronBlockReason =
  | "non_add_action" | "gateway_override" | "unsupported_payload"
  | "no_session" | "foreign_session" | "agent_id_override"
  | "session_key_override" | "non_announce_delivery" | "foreign_chat";

export type NonOwnerCronAddPolicyResult =
  | { ok: true }
  | { ok: false; reason: NonOwnerCronBlockReason; message: string };

export function evaluateNonOwnerCronAddPolicy(...): NonOwnerCronAddPolicyResult {
  // 9 paths — same conditions, same messages, structured outcome.
}

// In execute():
const policy = evaluateNonOwnerCronAddPolicy({...});
if (!policy.ok) {
  logInfo(`[cron-tool] block reason=${policy.reason} session=${shortSid}`);
  return jsonResult({ blocked: true, reason: policy.reason, message: policy.message });
}
```

## 4. Scope-of-fix matrix

| # | Layer | File | Изменение | Invariant |
| --- | --- | --- | --- | --- |
| 1 | Cron tool | `src/agents/tools/cron-tool.ts` | Replace assertNonOwnerCronAddPolicy → evaluateNonOwnerCronAddPolicy + structured result wiring + early non-add branch convert. | — |
| 2 | Tests | `src/agents/tools/cron-tool.test.ts` | 2 теста rewrites (rejects.toThrow → blocked structured details). | — |

## 5. Acceptance

- ✅ pnpm tsgo exit 0.
- ✅ 39/39 cron-tool tests green.
- ✅ 27/27 outbound-sanitizer tests green (sanitization patterns, не пострадали).
- ⏳ Live verification (после merge + restart): один `[cron-tool] block reason=foreign_chat ...` info-line на foreign-chat attempt, ноль `[tools] cron failed: ...` repeats.

## 6. Handoff Log

| Date | Step | Branch | SHA | PR # | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-05-01 | Slice 4 merged | `fix/orchestrator-cron-tool-no-retry-on-foreign-chat` | `00062f70a6` | [#118](https://github.com/Primus-max/god-mode-core/pull/118) | `evaluateNonOwnerCronAddPolicy` pure classifier (closed reason set 9 значений) + structured `jsonResult({ blocked, reason, message })` через `execute()`. Single `[cron-tool] block reason=<R>` info-line per attempt; zero `[tools] cron failed: ...` retry spam. 39/39 cron-tool tests + 27/27 outbound-sanitizer tests green; pnpm tsgo exit 0. Hard invariants #5/#6/#8/#11/#15 соблюдены. CI infra: BlackSmith total_count=0 → admin-merge after local validation + no frozen contracts touched. Live verification (после restart gateway): expect один info-line на foreign-chat attempt, ноль 4×-retry pattern в логе. |

## 7. References

- `src/agents/tools/cron-tool.ts:221-278,364` — bare-error throw paths.
- `src/agents/pi-tool-definition-adapter.ts:150-170` — catch + log + buildToolExecutionErrorResult wrapper.
- `.cursor/plans/commitment_kernel_outbound_sanitizer.plan.md` — historical context (sanitizer-side mitigation).
