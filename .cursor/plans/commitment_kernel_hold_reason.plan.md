---
name: PR-H - dedicated orchestrator hold reason
status: draft
created: 2026-04-29
owner: OpenCode
parent:
  - .cursor/plans/commitment_kernel_smart_orchestrator_roadmap.plan.md
  - .cursor/plans/commitment_kernel_v1_master.plan.md
---

# PR-H - dedicated orchestrator hold reason

## 1. Provenance

- Parent roadmap item: `pr-h-session-aware-clarify` in `.cursor/plans/commitment_kernel_smart_orchestrator_roadmap.plan.md`.
- Current pain after PR-A.2: streaming behavior is now contained, but orchestrator wait/hold semantics are still overloaded onto existing reason paths such as `needs_tool_result`.
- Goal of this slice: make orchestrator hold state explicit in decision semantics so later session-aware clarification logic can branch on a stable reason instead of piggybacking on tool-result waiting.

## 2. Hard invariants

- Do not touch frozen commitment-layer surfaces or decision contracts listed in the master plan freeze.
- No phrase-rule or text-rule matching on `UserPrompt` / `RawUserTurn`.
- No global singleton state, shared mutex without timeout, or cross-session leakage.
- Keep behavior per `(sessionId, turnId)` and preserve idempotent decision evaluation.
- Do not add new reasons to `CLARIFICATION_POLICY_REASONS` unless the implementation point for PR-H explicitly requires it and the change stays inside the non-frozen surface.

## 3. Hypothesis

- The current orchestrator hold path is semantically distinct from plain `needs_tool_result`.
- Introducing an explicit hold reason at the orchestration/auto-reply layer will make downstream gating, observability, and later clarification policies easier to reason about.
- This should be a narrow semantics fix, not a broad refactor.

## 4. Scope of fix

| Area | In scope | Out of scope |
| --- | --- | --- |
| Hold semantics | Introduce explicit reason or state marker for orchestrator-hold path | Rewriting broader clarification policy |
| Auto-reply pipeline | Wire the reason through existing decision / reply flow where needed | Refactoring unrelated streaming or aggregation behavior |
| Tests | Add/adjust focused tests around hold reason behavior | Broad suite changes outside touched surfaces |
| Plans | Update roadmap/master/sub-plan status when work is complete | Premature merge metadata before actual merge |

## 5. Acceptance

1. A turn that enters orchestrator hold no longer aliases its state to plain `needs_tool_result` when the hold is semantically different.
2. Existing tool-wait behavior that is genuinely `needs_tool_result` remains unchanged.
3. PR-A.2 buffering and PR-G holding-payload behavior continue to work with the new hold reason semantics.
4. Decision evaluation remains idempotent for the same input.
5. Scoped validation passes: targeted tests for touched auto-reply/orchestrator files and `pnpm tsgo`.

## 6. Handoff log

- 2026-04-29: Sub-plan created after PR-A.2 verification. Next step is code audit to find the narrowest non-frozen seam for introducing explicit orchestrator-hold semantics.

## 7. References

- `.cursor/plans/commitment_kernel_smart_orchestrator_roadmap.plan.md`
- `.cursor/plans/commitment_kernel_v1_master.plan.md`
- `.cursor/plans/commitment_kernel_streaming_leak_buffering.plan.md`
- `src/auto-reply/reply/**`
