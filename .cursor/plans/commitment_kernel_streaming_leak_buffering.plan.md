---
name: PR-A.2 — block-streaming buffering at tool_call
overview: |
  Narrow follow-up to Bug A (`7f56fbd9ab`) and PR-G (`d0b3c3fc33`), closing roadmap todo
  `pr-a2-buffering` from `commitment_kernel_smart_orchestrator_roadmap.plan.md`.
  Symptom: when a turn contains any tool call (`web_search`, `image_generate`, etc.),
  block-streaming still emits intermediate assistant text deltas into external channels,
  so the user sees preamble / progress chunks before the final consolidated answer.
  Bug A stripped raw tool-call markers, but intentionally did NOT add buffering.

  Fixed design choice (roadmap §todo pr-a2-buffering, non-negotiable):
  - if a turn contains any tool call, ALL external block-streamed text for that turn is buffered,
    including preamble before the tool call;
  - internal/control surfaces may still stream for observability;
  - PR-G holding-payload semantics remain visible and must not be duplicated or silenced;
  - PR-aggregation `mode=holding` remains the single in-turn aggregation authority and must
    compose without double-emission.

  Out of scope:
  - `src/platform/commitment/**`, frozen decision contracts, 4 frozen production call-sites;
  - phrase/text matching on user text or partial deltas;
  - changing PR-G lifecycle policy or PR-aggregation holding templates;
  - concurrent broker / global queue work (future PR-MT only).

audit_gaps_closed: []

todos:
  - id: bootstrap-and-audit
    content: |
      Mandatory reads completed: invariants, PR bootstrap rule, smart-orchestrator roadmap,
      Bug A baseline, PR-aggregation baseline, PR-G baseline, master plan required sections,
      and read-only audit of block-streaming / pipeline files.
    status: completed
  - id: codify-buffering-plan
    content: |
      Sub-plan created before production code. Fix will key buffering state per
      `(sessionId, turnId)` / per-pipeline instance, gate only on structural tool-call state
      (`runResult.toolCalls.length > 0` or explicit `hasPendingToolCalls`), and keep PR-G /
      PR-aggregation semantics intact.
    status: pending
  - id: implement-structural-buffering-gate
    content: |
      Wire a structural gate into block reply pipeline path so external block replies buffer
      for turns with tool calls, including preamble. No text inspection of deltas; only
      `runResult.toolCalls.length > 0` and/or a typed pending-tool-call flag.
    status: pending
  - id: preserve-internal-streaming
    content: |
      Ensure internal/control-channel streaming behavior stays observable while external
      delivery is buffered. No global singleton state; no cross-session leakage.
    status: pending
  - id: compose-with-prg-and-aggregation
    content: |
      Verify no duplicate emits with PR-G holding payload or PR-aggregation `mode=holding`.
      Holding signal remains visible when applicable; buffered final reply still emits once.
    status: pending
  - id: tests-and-targeted-validation
    content: |
      Add targeted tests for: tool-call turn => external single consolidated message,
      internal all chunks; no-tool-call regression unchanged; composition with holding mode.
      Run scoped tests / lint relevant to touched files.
    status: pending
  - id: commit-and-handoff
    content: |
      After implementation and validation: commit code, update this sub-plan handoff log,
      and later mark roadmap/master progress only after merge per repo protocol.
    status: pending
isProject: false
---

# PR-A.2 — block-streaming buffering at tool_call

## 0. Provenance

| Field | Value |
| --- | --- |
| Roadmap parent | `.cursor/plans/commitment_kernel_smart_orchestrator_roadmap.plan.md` todo `pr-a2-buffering`, order 2 |
| Reserved bug row | `.cursor/plans/commitment_kernel_streaming_leak.plan.md` §8, row 1 `A.2 — Block-streaming buffering при tool_call в turn'е` |
| Predecessors | Bug A merged `7f56fbd9ab`; PR-aggregation merged; self-feedback loop fix merged `970ee2b43d`; PR-G merged `d0b3c3fc33` |
| Current repo HEAD at audit | `3df3138fcc701bafb51e781e9f437019097882e4` |
| Target branch | `fix/orchestrator-streaming-buffering` off fresh `origin/dev` |
| Merge target | `dev`, single narrow PR for roadmap step 2 |
| Production surface | `src/auto-reply/reply/**` block streaming / reply pipeline only; no frozen layer edits planned |
| Out of scope | commitment layer, decision frozen contracts, global concurrency broker, history-aware clarification |

## 1. Hard invariants kept

Read from `.cursor/rules/commitment-kernel-invariants.mdc`; especially relevant here:

| # | Invariant | How PR-A.2 keeps it |
| --- | --- | --- |
| 5 | No phrase / text-rule matching on `UserPrompt` or `RawUserTurn` outside whitelist | Buffering decision is structural only: `runResult.toolCalls.length > 0` and/or typed `hasPendingToolCalls` flag. NEVER inspect partial delta text, user text, or preamble wording. |
| 6 | `IntentContractor` is the only reader of raw user text | This fix operates entirely on reply pipeline / tool-call metadata, not on raw user text. |
| 8 | `commitment/` does not import from `decision/` | Scope stays in `src/auto-reply/reply/**`; no kernel / decision cross-layer changes. |
| 11 | Five legacy decision contracts frozen | No edits to `TaskContract`, `OutcomeContract`, `QualificationExecutionContract`, `ResolutionContract`, `RecipeRoutingHints`. |
| 13 | `terminalState` orthogonal to `acceptanceReason` | Buffering changes delivery timing only, not acceptance model. |

## 2. Forward-compatibility constraints (roadmap §4)

This PR MUST preserve future concurrent broker compatibility:

1. **State per `(sessionId, turnId)`** — no global singleton buffering state. Any new buffering marker lives per pipeline / per turn.
2. **No shared mutex without timeout** — buffering may queue per turn, but must not introduce module-level blocking or unbounded shared locks.
3. **Idempotent gate** — repeated evaluation with the same turn metadata returns the same buffering decision.
4. **No cross-session leakage** — one session/turn cannot affect another session’s stream behavior.
5. **Telemetry per turn** — if new telemetry is added, it must key by turn/session, not process-global counters.
6. **No global queue without concurrency limits** — buffering is local to the block reply pipeline instance, not a repo-wide stream bus.

## 3. Hypothesis

1. Current `createBlockReplyPipeline` / `block-reply-coalescer` logic knows how to coalesce chunks, but not when a turn has entered a tool-executing phase that should suppress external intermediate text.
2. Bug A removed raw tool-call markup, but sanitized text chunks still pass through immediately to external delivery when they should instead be buffered until final consolidation.
3. The correct decision point is a structural gate near `block-reply-pipeline.enqueue`, because that is where streaming chunks are already normalized for outbound delivery.
4. External buffering must include preamble before the tool call. If the model writes “сейчас посмотрю” then calls a tool, that text is still intermediate progress for external UX and must be buffered.
5. Internal/control streaming should remain available for observability. External and internal behavior diverge by delivery target, not by parsing assistant text.

## 4. Scope-of-fix matrix

| # | Layer | File | Planned change | Constraints |
| --- | --- | --- | --- | --- |
| 1 | Pipeline gate | `src/auto-reply/reply/block-reply-pipeline.ts` | Add structural buffering gate for tool-call turns at enqueue/finalize path | No text matching; no global state |
| 2 | Streaming config/types | `src/auto-reply/reply/block-streaming.ts` and adjacent typed pipeline state if needed | Carry typed signal for external buffering vs internal streaming | Per-turn only |
| 3 | Adjacent state/coalescer | `src/auto-reply/reply/block-reply-coalescer.ts` or nearby pipeline-state helpers if needed | Ensure buffered external final flush composes with current coalescing | No duplicate final emit |
| 4 | Tests | reply pipeline / streaming tests near touched modules | Tool-call buffering happy path + no-tool-call regression + holding composition | Scoped tests only |

## 5. Composition rules

### 5.1 With PR-G holding-payload

- PR-G’s holding payload is a visible external signal for pending child lifecycle.
- PR-A.2 must **not** suppress or duplicate that holding signal.
- If a turn uses `sessions_spawn`, external behavior remains:
  - holding payload may be emitted once via PR-G / aggregation semantics;
  - preamble / partial deltas stay buffered from external;
  - final consolidated reply emits once when appropriate.

### 5.2 With PR-aggregation `mode=holding`

- `mode=holding` already governs in-turn aggregation semantics.
- PR-A.2 must not add a second independent “final send” path.
- Buffering is transport/pipeline behavior for intermediate block streaming, not a replacement for aggregation policy.
- Therefore the design target is: **aggregation decides what final payload exists; buffering decides whether interim chunks reach external delivery**.

## 6. Acceptance

1. **Test 1 — tool-call buffering integration**: LLM emits 10 partial deltas (including preamble) with a tool call between them. External channel receives exactly **1 consolidated final message**; internal/control channel receives all 10 partials.
2. **Test 2 — regression without tool call**: turn without any tool call preserves existing external per-block streaming behavior (preamble + final continue to stream as before).
3. **Test 3 — composition with PR-G**: turn contains `sessions_spawn` and a tool call. External receives PR-G holding payload and then a single consolidated final after subagent terminal; no double-final and no partial leak.
4. **Test 4 — idempotency**: re-evaluating the buffering gate with the same typed input produces the same decision.
5. **Test 5 — no cross-session leakage**: two concurrent turns on different sessions do not share buffer state.
6. **No phrase matching**: implementation proof shows buffering decision relies only on structural tool-call metadata / typed flags.
7. **Scoped validation**: `pnpm tsgo` plus targeted tests in `src/auto-reply/reply/**` are green; unrelated wider-suite failures, if any, are reported explicitly instead of broadening scope silently.

## 7. Read-only audit summary

Mandatory reads completed before code changes:

- `.cursor/rules/commitment-kernel-invariants.mdc`
- `.cursor/rules/pr-session-bootstrap.mdc`
- `.cursor/plans/commitment_kernel_smart_orchestrator_roadmap.plan.md`
- `.cursor/plans/commitment_kernel_streaming_leak.plan.md`
- `.cursor/plans/commitment_kernel_subagent_result_aggregation.plan.md`
- `.cursor/plans/commitment_kernel_subagent_await.plan.md`
- `.cursor/plans/commitment_kernel_v1_master.plan.md`
- `src/auto-reply/reply/block-reply-pipeline.ts`
- `src/auto-reply/reply/block-streaming.ts`
- `src/auto-reply/reply/block-reply-coalescer.ts`

Key audit findings:

1. `block-reply-pipeline.ts` already has localized buffering/coalescing primitives (`buffer`, `coalescer`, per-pipeline sent/pending sets), making it the right place for per-turn external buffering without global state.
2. Existing buffering is payload-shape-based (`createAudioAsVoiceBuffer`), not tool-call-state-based.
3. `block-streaming.ts` currently resolves chunking/coalescing config only; there is no typed notion yet of “external stream should buffer because this turn has tool calls”.
4. PR-A.2 should reuse per-pipeline state rather than invent any module-level registry.
5. Any solution that tries to infer tool-call presence from chunk text would violate invariant #5 and is forbidden.

## 8. Handoff log

- 2026-04-29: Verification status updated after audit. Acceptance 1-5 are verified locally. Scoped checks passed via `pnpm test -- src/auto-reply/reply/block-external-buffer.test.ts` and `pnpm tsgo`.
- 2026-04-29: Branch topology follow-up required. `fix/orchestrator-streaming-buffering`, `dev`, and `origin/dev` currently resolve to the same SHA `3df3138fcc`, so the PR branch must be re-separated before opening or merging a PR.

### 2026-04-29 — bootstrap audit and sub-plan creation

- Created this sub-plan before production edits, per roadmap requirement.
- Confirmed predecessor state: PR-G merged at `d0b3c3fc33`; Bug A merged at `7f56fbd9ab`; roadmap todo `pr-a2-buffering` is next pending item.
- Read-only audited block streaming / reply pipeline files.
- Fixed design constraints captured explicitly: preamble before tool call is buffered for external, exactly one consolidated external reply for tool-call turns, internal/control streaming remains observable, state stays per turn / pipeline with no module-level singleton.
- Acceptance rewritten as mandatory integration tests: 10-delta tool-call case, no-tool-call regression, PR-G composition, idempotent gate, no cross-session leakage.
- Hard prohibitions confirmed in scope: no `src/platform/commitment/**`, no 4 frozen production call-sites, no 5 frozen decision contracts, no phrase-rule on partial deltas, no global singleton / shared mutex, no clarification-policy changes.
- No production code changed yet.
- Next recommended todo: `implement-structural-buffering-gate`.

## 9. References

- `.cursor/rules/commitment-kernel-invariants.mdc`
- `.cursor/rules/pr-session-bootstrap.mdc`
- `.cursor/plans/commitment_kernel_smart_orchestrator_roadmap.plan.md`
- `.cursor/plans/commitment_kernel_streaming_leak.plan.md`
- `.cursor/plans/commitment_kernel_subagent_result_aggregation.plan.md`
- `.cursor/plans/commitment_kernel_subagent_await.plan.md`
- `.cursor/plans/commitment_kernel_v1_master.plan.md`
- `src/auto-reply/reply/block-reply-pipeline.ts`
- `src/auto-reply/reply/block-streaming.ts`
- `src/auto-reply/reply/block-reply-coalescer.ts`
