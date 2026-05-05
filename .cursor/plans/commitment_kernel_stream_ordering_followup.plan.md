---
name: Slice H — Stream/Edit Ordering at tool_call Boundaries (v1 follow-up to PR-A.2)
overview: "Close B4 (`то отправляет сообщение потом удаляет, потом показывает финальное`) by tightening the post-PR-A.2 streaming pipeline at the seams where: (a) the pre-tool-call buffered preamble is finalized, (b) the structural-tool-execution notification flips the deferral mode, (c) subagent ack / holding payload emits at the parent level, and (d) the channel adapter (Telegram draft-stream) materializes a preview into a permanent message and deletes archived previews. Audit (this plan §2) is mandatory: pick the fix only after the call graph is reproduced from a failing test."
todos:
  - id: h-phase-1-audit-call-graph
    content: "Phase 1 — read PR-A.2 baseline (`commitment_kernel_streaming_leak_buffering.plan.md`) and PR-A baseline (`commitment_kernel_streaming_leak.plan.md`). Trace the live call graph from `pi-embedded-subscribe.handlers.tools.ts::handleToolExecutionStart` → `onStructuralToolExecutionStarting` → `flushBlockReplyBuffer` → `onBlockReplyFlush` → `BlockReplyPipeline.flush({force})` → external block-reply delivery → channel adapter (Telegram `draft-stream.ts::materialize` + `archivedAnswerPreviews` deletion). Document every concrete callsite for `onBlockReply`, `onBlockReplyFlush`, `onStructuralToolExecutionStarting`, `onPartialReply`, `onAssistantMessageStart`. Map subagent-ack emission (`emitDeferredAck` in `agent-runner.ts`) and PR-G `applyAggregationOverride` holding emission relative to the deferral finalize. Audit-only — output as §2 of this plan; no code changes."
    status: completed
  - id: h-phase-2-failing-test-b4-repro
    content: "Phase 2 — write a failing harness/test that reproduces B4. Drive a fake stream through `createBlockReplyPipeline` + `createExternalBlockReplyDeferral` + a mock channel-adapter that records the verbatim sequence of `(send | edit | delete)` operations. Scenario: assistant emits 2 partial deltas, model triggers `subagent_spawn` tool_call, parent emits subagent ack, then assistant final reply lands. Assert the recorded operation sequence does NOT contain `send → delete → send` for the same logical reply. If the unit-level harness can't reproduce, escalate to integration via `createStubSessionHarness` + `bot-message-dispatch.test.ts`-style fixture. The test MUST fail on `dev` HEAD before the fix lands (per AGENTS.md §253)."
    status: completed
  - id: h-phase-3-pick-and-apply-fix
    content: "Phase 3 — pick exactly one of three candidate fixes (see §3 H1/H2/H3) based on which is exercised by the Phase-2 test. Apply minimum surface change. The candidate is unknown until Phase 1 audit is done; per AGENTS.md `do not write speculative code` we commit to the choice in Handoff Log only after the failing repro pinpoints it."
    status: pending
  - id: h-phase-4-acceptance-fixture
    content: "Phase 4 — acceptance: B4 transcript replay. Build a fixture out of the 2026-05-04 19:38–19:42 turn (the «то отправляет сообщение потом удаляет, потом показывает финальное» sequence) — captured from a fresh gateway log when slice F lands or simulated from the agent-event stream we already have. Assert no spurious delete-and-resend, correct visible reply order in the channel-adapter recorder."
    status: pending
  - id: h-phase-5-stress-tests
    content: "Phase 5 — stress (per AGENTS.md §258 — non-negotiable for timing/race bugs): two cross-session concurrent turns, rapid back-to-back same-session turns (50ms apart), and a long-running tool-call interleaved with high partial-delta cadence. The deferral state must NOT leak across `(sessionId, turnId)` boundaries (already partially covered by `block-external-buffer.test.ts T5`; extend with adapter-level recording). One additional reverse test: idempotency under double-finalize (existing T4 of PR-A.2, extended to also assert no duplicate channel-adapter operation)."
    status: pending
  - id: h-phase-6-live-verify-and-handoff
    content: "Phase 6 — live verify against gateway log: B4 replay produces correct ordering. Tsgo green; scoped tests green. Handoff Log row + master §0 PR Progress Log row per protocol. Roadmap §3 row H todo flipped to merged."
    status: pending
isProject: false
---

# Slice H — Stream/Edit Ordering at tool_call Boundaries

## 0. Provenance

| Field | Value |
| --- | --- |
| Sub-plan of | `.cursor/plans/commitment_kernel_v1_release_roadmap.plan.md` (slice H, §3) |
| Extends | `commitment_kernel_streaming_leak_buffering.plan.md` (PR-A.2, merged) and `commitment_kernel_streaming_leak.plan.md` (PR-A, merged `7f56fbd9ab`) |
| Closes | B4 from 2026-05-04 Telegram transcript: «то отправляет сообщение потом удаляет, потом показывает финальное» |
| Inherits | 16 hard invariants from `.cursor/rules/commitment-kernel-invariants.mdc` |
| Trigger | v1 Release Roadmap §3 group 1 (parallel after slice D). Roadmap row H predecessor lists slice F (TaskLedger) — but the B4 symptom is observable today on dev HEAD without slice F, so we proceed independently and re-validate after F lands. |
| Out of scope | (a) Channel-specific UX polish for non-Telegram channels — Telegram is the reference; Slack/Discord/Web stream/edit policies are per their own adapter (slice K-style follow-up if needed). (b) The PR-A `<tool_call>` markup leak (already fixed). (c) Subagent reply framing (slice G). (d) English meta-text leak (slice I). (e) Per-turn task scheduler (slice F). |
| Maintainer signoff | REQUIRED before Phase 3 (the fix). Phases 1, 2 (audit + failing test) are read-only / additive-test and may proceed under roadmap-level signoff. |

## 1. Hard invariants this slice MUST keep

All 16 in force. Specific call-outs:

| # | Invariant | How this slice keeps it |
| --- | --- | --- |
| **#5** | No phrase-rule on `UserPrompt` / `RawUserTurn` outside `IntentContractor` whitelist. | The fix decision MUST be driven only by structural events: `onStructuralToolExecutionStarting`, `runResult.toolCalls`, `(sessionId, turnId)` keys, `executionReceipts[].name === "sessions_spawn"`. **Forbidden**: any text-content inspection on partial deltas, raw user prompt, or assistant draft text used as a routing signal. |
| **#6** | `IntentContractor` is the sole reader of raw user text. | Streaming layer remains text-blind for routing. Strip helpers (`stripUniversalToolCallMarkup` etc.) operate on assistant OUTPUT and are out of scope here. |
| **#8** | `commitment/` ↛ `decision/`. | Slice touches only `src/auto-reply/reply/**`, `src/agents/pi-embedded-subscribe*`, and possibly `extensions/telegram/src/**`. Frozen layer untouched. |
| **#11** | The 5 frozen contracts (TaskContract, OutcomeContract, QualificationExecutionContract, ResolutionContract, RecipeRoutingHints) are read-only. | Streaming pipeline does not import these; nothing to amend. |
| **#15** | Maintainer signoff per architectural change. | Phase 1 + 2 (audit + failing test) ride the roadmap signoff. Phase 3 (the fix) requires explicit signoff once the candidate (H1 / H2 / H3) is known. |
| **#16** | Branded types distinct. | No new branded type introduced. |

## 2. Audit findings (Phase 1 — verified 2026-05-04 against dev HEAD `4ce7302a78`)

All line numbers below were re-grep-verified on `origin/dev = 4ce7302a7834e3788fa4719ba0a29211fae3c7ce` from branch `audit/v1-slice-h-stream-ordering-phase-1`. The §2 sketch from the kickoff snapshot held up — the call graph, the ack bypass, and the Telegram archive-delete order all reproduce on read with no surprises. Only minor line-range tightening required (line 850 → 850–873 block; finally-loop range narrowed from 790–855 → 822–843 for the answer-lane cleanup; rotate-body 305 → 305–333; deferral wiring tightened from 589–615 → 592–613). Hypothesis ranking unchanged from the kickoff sketch and confirmed by re-read (see §2.5 at bottom).

### 2.1. Call graph — pre-tool-call flush ordering (verified)

```
LLM event stream
  └─ pi-embedded-subscribe.handlers.messages.ts (text_delta path)
        └─ emitBlockChunk (pi-embedded-subscribe.ts)        // strip + chunker
              └─ replyDirectiveAccumulator.emitBlockReply
                    └─ onBlockReply  (passed via params)
                          ├─ pipeline.enqueue → coalescer → pipeline send
                          │     └─ blockReplyHandler (reply-delivery.ts:createBlockReplyDeliveryHandler)
                          │           └─ wrapped via externalBlockDeferral.wrapDeliver  ← PR-A.2
                          │                 └─ originalOnBlockReply (channel adapter, e.g. Telegram bot-message-dispatch)
                          └─ onPartialReply (typing/preview lane only)

LLM tool execution event
  └─ pi-embedded-subscribe.handlers.tools.ts::handleToolExecutionStart            (line 337)
        ├─ AWAIT Promise.resolve(ctx.params.onStructuralToolExecutionStarting?.())  (line 341)
        │     └─ wired in agent-runner.ts:908–910 to externalBlockDeferral.notifyStructuralToolExecutionStarting()  // sets flag
        ├─ ctx.flushBlockReplyBuffer()                                              (line 343)  // chunker buffer flush
        └─ AWAIT params.onBlockReplyFlush?.()                                       (line 345)
              └─ wired in agent-runner-execution.ts:559–563 to blockReplyPipeline.flush({ force: true })  // coalescer drain → wrapped deliver → STILL DEFERRED
```

Wiring evidence (verified):
- `agent-runner.ts:592` declares `streamingAwareBlockReply` (the original `opts.onBlockReply` re-bound).
- `agent-runner.ts:596–604` constructs `externalBlockDeferral` only when `blockStreamingEnabled && shouldBufferExternalBlockStreams && streamingAwareBlockReply` is truthy.
- `agent-runner.ts:606–613` builds `wrapped = externalBlockDeferral.wrapDeliver(streamingAwareBlockReply)` and assigns it to `deliveredBlockReply`.
- `agent-runner.ts:908–910` passes the `notifyStructuralToolExecutionStarting()` thunk into `runAgentTurnWithFallback` as `onStructuralToolExecutionStarting` (only when the deferral exists; otherwise `undefined`).
- `agent-runner-execution.ts:114` types the `onStructuralToolExecutionStarting?` field; `:558` wires `onBlockReply: blockReplyHandler`; `:559–563` wires `onBlockReplyFlush` to `blockReplyPipeline.flush({ force: true })` (only when `params.blockStreamingEnabled && blockReplyPipeline` are both truthy); `:565` forwards `onStructuralToolExecutionStarting` straight through. `:477–490` carries `onPartialReply` + `onAssistantMessageStart` on the typing/preview lane (orthogonal to the block-reply flow).
- `pi-embedded-subscribe.handlers.tools.ts:337–346` is the only call site for `handleToolExecutionStart`; the await order is exactly `onStructuralToolExecutionStarting → flushBlockReplyBuffer → onBlockReplyFlush`. `Promise.resolve(...)` wrapper at 341 means a sync return is awaited normally; no microtask boundary leak observed.

Critical: `wrapDeliver` returns immediately with `deferred.push(payload)`; the inner channel adapter (Telegram bot-message-dispatch) is NOT called during pre-tool flush. It is called later from `agent-runner.ts:991–992` `externalBlockDeferral.finalizeAfterRun(streamingAwareBlockReply)` after the run finishes (immediately after `blockReplyPipeline.flush({ force: true })` at line 989).

### 2.2. Subagent ack emission relative to main reply (verified)

`agent-runner.ts:850 emitDeferredAck` (full body 850–873) — verified call sequence:

1. Line 853–854: idempotency guard (`didEmitDeferredAck`).
2. Line 855–856: resolves locale + ack text.
3. Line 857–860: emits `turnProgressEmitter.emit("ack_deferred", ...)` if available (internal lane only).
4. Line 861–865: marks deferred-job state in `markDeferredJobRunning(...)`.
5. **Line 866: `const deliver = effectiveOpts?.onBlockReply;`** — pulls the **raw** `onBlockReply` off `effectiveOpts`, NOT `deliveredBlockReply`, NOT the wrapped deferral.
6. **Line 867–872: `await deliver(applyReplyToMode({ text: ackText }))`** — fires the ack DIRECTLY at the channel adapter, bypassing both `streamingAwareBlockReply` and `externalBlockDeferral.wrapDeliver`.

`emitDeferredAck` is invoked from two places (verified):
- `agent-runner.ts:883` — pre-run, when `hasExplicitAckThenDeferHint({...})` is true on the followup prompt.
- `agent-runner.ts:912` — inside the `runAgentTurnWithFallback` `onAckThenDefer` callback during a run.

Both paths reach the channel adapter without going through the deferral. So during a turn that subsequently produces a `sessions_spawn` tool_call:
1. The deferred preamble that will be replayed/consolidated later sits in `externalBlockDeferral.deferred[]`.
2. The post-tool-call holding payload from `applyAggregationOverride` (PR-G, called at `agent-runner.ts:964`, with override applied at 980–982) replaces the final payload set when `sessions_spawn` was observed.
3. The ack lands on the adapter BEFORE either of the above.

This is the structural seam most likely to produce B4: the channel adapter receives `ack_text` first (creates msg #1), then the streaming preamble's deferred replay arrives (creates msg #2 OR edits msg #1 depending on Telegram lane state — `draft-stream.ts::sendOrEditStreamMessage` 200–267 decides based on `streamMessageId`), then the final consolidated/holding payload arrives (which may trigger `forceNewMessage` + `materialize` + `archivedAnswerPreviews.deleteIfUnused` cleanup). The "send → delete → final" pattern matches the user's transcript verbatim.

### 2.3. Channel adapter buffering behaviour (Telegram reference, verified)

`extensions/telegram/src/bot-message-dispatch.ts:305–333 rotateAnswerLaneForNewAssistantMessage`:
- Line 308: gates on `answerLane.hasStreamedMessage`.
- Line 311: `const materializedId = await answerLane.stream?.materialize?.();` — calls `draft-stream.ts:394–449 materialize` which may send a new permanent message and return its id.
- Line 312: resolves `previewMessageId = materializedId ?? answerLane.stream?.messageId()`.
- Line 313–322: if `activePreviewLifecycleByLane.answer === "transient"` and we have a numeric id, pushes `{ messageId, textSnapshot, deleteIfUnused: false }` into `archivedAnswerPreviews`.
- Line 323: `answerLane.stream?.forceNewMessage()` (which `draft-stream.ts:372` clears `streamMessageId`).
- Line 324–331: resets lane state and (if rotated) flips `activePreviewLifecycleByLane.answer = "transient"` + `retainPreviewOnCleanupByLane.answer = false`.

Call sites of `rotateAnswerLaneForNewAssistantMessage` (verified):
- `bot-message-dispatch.ts:363` — fires from `onAssistantMessageStart` callback.
- `bot-message-dispatch.ts:757` — fires from a queued lane-event boundary task.

`bot-message-dispatch.ts:790–855` finally-block (verified):
- Line 791: `await draftLaneEventQueue` — drains queued lane work first (boundary rotations / materialization complete before stream cleanup).
- Line 794–826: per-lane stream stop/clear, with `hasBoundaryFinalizedActivePreview` check at 815–820 protecting the active preview from being cleared if it matches a `deleteIfUnused === false` entry.
- Line 822–826: `await stream.stop()` and conditionally `await stream.clear()`.
- **Line 835–843**: iterates `archivedAnswerPreviews`; for each entry where `deleteIfUnused !== false` (i.e. the entries pushed at `bot-message-dispatch.ts:235–238` from a different code path with `deleteIfUnused: true`), calls `bot.api.deleteMessage(chatId, archivedPreview.messageId)`.
- Line 845–853: similar cleanup for `archivedReasoningPreviewIds`.

Important refinement (verified during this audit): the entries pushed at line 313–322 from `rotateAnswerLaneForNewAssistantMessage` use `deleteIfUnused: false`, so they are NOT deleted in the finally-block at 835–843. The entries that **are** deleted are pushed at line 235 (from a different boundary path with `deleteIfUnused: true`). H3 in §3 needs to be re-read with that in mind: the delete-after-final pattern is driven by the line-235 push site, not the line-316 one. The §3 fix sketches still hold but need to scope to the `deleteIfUnused: true` push site.

Mismatch hypothesis (kept): when the deferral-wrapped pipeline emits a single consolidated payload that does NOT match the snapshot of an archived preview text byte-for-byte (and that preview was pushed with `deleteIfUnused: true`), the cleanup deletes the now-stale preview AFTER the new permanent message lands → user sees `send (preview) → send (final) → delete (preview)`, perceived as `send → delete → final`. The order recorded by the bot may differ from the order user sees, but the visual artefact is the same.

### 2.4. Existing tests — verified gap

`src/auto-reply/reply/block-external-buffer.test.ts` (6 tests, PR-A.2; line numbers 9/21/31/49/69/82):
- T1 (line 9) `mergeExternalDeferredReplyPayloads` — text join + tail metadata.
- T2 (line 21) `externalBufferFinalizeKind` — idempotent for same structural flag/count.
- T3 (line 31) defers then emits single consolidated payload after structural tool — uses `vi.fn` inner, does NOT exercise channel adapter.
- T4 (line 49) replays all deferred chunks when no structural tool — same limitation.
- T5 (line 69) two deferrals do not share deferred payloads (cross-session isolation) — `vi.fn` only.
- T6 (line 82) finalize is safe to call twice — idempotency.

`extensions/telegram/src/bot-message-dispatch.test.ts:651` `materializes boundary preview and keeps it when no matching final arrives` — covers the Telegram lane edge (asserts `deleteMessage` is NOT called for the materialized id 4321), but NOT the cross-product of `(externalBlockDeferral consolidates) × (Telegram materialize/forceNewMessage/archivedAnswerPreviews)`.

`src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.calls-onblockreplyflush-before-tool-execution-start-preserve.test.ts` (2 tests at lines 9 and 53) — covers `onBlockReplyFlush` is called before `tool_execution_start` (single subsystem, not the pipeline-deferral-channel triple).

`grep -rn "externalBlockDeferral|createExternalBlockReplyDeferral|emitDeferredAck" --include="*.test.ts"` — all references are in `block-external-buffer.test.ts`. **Zero tests** mention `externalBlockDeferral` together with any channel-adapter recorder.

**Confirmed: no existing test exercises** a turn where (a) preamble flows through the pipeline, (b) tool_call fires, (c) subagent ack is emitted via `emitDeferredAck`, (d) finalize emits the consolidated payload, (e) channel adapter records the resulting `(send | edit | delete)` ordering. This is the gap Phase 2 closes.

### 2.5. Hypothesis ranking — verified

Re-read of the call graph confirms the kickoff sketch's ranking. **Final ranking unchanged**:

1. **H2 — emitDeferredAck races finalize: medium-high probability (PRIMARY).** The bypass is structural and direct: `agent-runner.ts:866` reads `effectiveOpts?.onBlockReply` (raw) instead of `deliveredBlockReply` (wrapped), and there is no test exercising this seam together with a channel-adapter recorder. Every B4 transcript symptom (ack lands → preamble lands → archive-delete) maps cleanly to this code path.
2. **H3 — Channel adapter delete-archive racing the consolidated emit: medium probability (SECONDARY).** Refined during this audit: the delete-after-final loop at `bot-message-dispatch.ts:835–843` only fires for entries with `deleteIfUnused !== false`. The line-316 rotation path uses `deleteIfUnused: false`, so H3 reduces to the line-235 push path (different boundary, different code path). Still plausible but narrower than the kickoff text suggested.
3. **H1 — Pre-tool-call flush-ordering bug: low probability (NULL).** The await order at `pi-embedded-subscribe.handlers.tools.ts:341–345` is correct: `notifyStructuralToolExecutionStarting()` flips the flag BEFORE `flushBlockReplyBuffer()` and BEFORE `onBlockReplyFlush()`. Any inner await yields keep the flag set, so a chunk landing mid-flush stays deferred. No microtask leak found on read.

The Phase 2 failing repro test should target H2 first (record ordering with `emitDeferredAck` triggered + structural tool seen + finalize) and only fall through to H3 if H2's recorded order is consistent with no race. H1 is the null candidate — Phase 2 does NOT need to write a test for it unless H2/H3 both pass on dev HEAD (which would indicate the symptom is somewhere we haven't audited and Phase 1 needs a follow-up).

## 3. Hypothesis (3 candidates — pick one in Phase 3)

Per AGENTS.md "do not write speculative code", we list candidates and commit to one only after Phase 2 reproduces the symptom and the harness's recording disambiguates which seam fails.

### H1. Pre-tool-call flush-ordering bug (low probability)

`handleToolExecutionStart` sequences `notifyStructuralToolExecutionStarting()` → `flushBlockReplyBuffer()` → `onBlockReplyFlush` (await). If any inner await yields control, a partial chunk could enter `wrapDeliver` AFTER the flag flip but BEFORE finalize — still deferred, no UX leak. The current ordering looks correct on read; H1 is the null candidate.

### H2. emitDeferredAck races finalize (medium-high probability)

`emitDeferredAck` in `agent-runner.ts:850` calls `effectiveOpts?.onBlockReply` DIRECTLY, bypassing both `streamingAwareBlockReply` and `externalBlockDeferral.wrapDeliver`. This means:
- Ack lands in the channel adapter BEFORE the pipeline's preamble (which is still deferred in `externalBlockDeferral.deferred[]`).
- When `finalizeAfterRun` later replays/consolidates, the adapter sees text that may overlap or reset its lane state (Telegram `streamMessageId`).

**Fix sketch (if H2 confirmed)**: route ack emission through a sibling of the deferral that ALSO participates in the per-turn ordering. Either:
- Push ack as the first `deferred[]` entry with a sentinel marker (`isDeferredAck: true`) and let `mergeExternalDeferredReplyPayloads` either prepend it or emit it as a separate first message before the merge.
- OR: emit ack inline through the deferral wrap (same wrapped deliver) so it queues like any other block payload but flushes immediately on `notifyStructuralToolExecutionStarting()` (define a 4th finalize-kind: `ack-then-consolidate`).

### H3. Channel adapter delete-archive racing the consolidated emit (medium probability)

`bot-message-dispatch.ts` archives a preview `messageId` on `forceNewMessage` rotation AND then deletes it in the `finally` block AFTER the consolidated final has already landed. The deletion is async and visible to the user as a "message disappeared after final" event — exactly matching B4's "потом удаляет, потом показывает финальное" if the user perceived order is reordered by Telegram client-side rendering.

**Fix sketch (if H3 confirmed)**: invert the cleanup order — delete archived previews BEFORE emitting the consolidated final payload, OR set `deleteIfUnused: false` whenever `externalBlockDeferral.structuralToolExecutionSeen === true` AND the consolidated final's text supersedes the archived preview's `textSnapshot`. The latter requires plumbing a structural flag from the agent-runner into the bot-message-dispatch options — a small but real cross-layer addition.

### Decision protocol

- Phase 2 test records the operation sequence at the channel-adapter mock.
- If the recorded order is `[ack_send, preamble_send, final_send]` → H2.
- If the recorded order is `[preamble_send, final_send, archived_delete]` → H3.
- If the recorded order is `[partial_send, finalize_consolidate, final_send]` with the partial leaking past the deferral flag → H1 (also indicates a regression in PR-A.2 itself).

## 4. Acceptance criteria

1. **No spurious delete-and-resend**: the recorded channel-adapter operation sequence for a turn with a `sessions_spawn` tool_call followed by an assistant final reply does NOT contain a `delete(messageId)` call AFTER the user-visible final reply has been sent (i.e. archived-preview cleanup completes before the final emit, or the archive is suppressed when the final and the preview text match).
2. **Subagent ack ordering**: `emitDeferredAck` either lands BEFORE the streaming preamble (visible as a brief acknowledgement that's then superseded by the final consolidated reply) OR is suppressed when the same turn's finalize will emit a consolidated payload that already contains acknowledgement text. Either policy is acceptable; the requirement is a single recorded ordering, not a race.
3. **B4 transcript replay**: a fixture derived from the 2026-05-04 19:38–19:42 turn produces an ordering that maps to user-visible "single final reply, no flicker, no delete-after-send".
4. **No regression to PR-A.2 acceptance criteria T1–T5** (`block-external-buffer.test.ts`).
5. **Stress test passes**: 50ms-spaced back-to-back turns on the same session, two cross-session concurrent turns, and a 5s tool-call with high partial cadence — all produce correct per-turn ordering with no cross-turn buffer leak.
6. **Frozen layer untouched.** 16 invariants reverse-tested.

## 5. Per-phase tests (must catch real bugs — AGENTS.md §253)

Each phase's tests must:
- **Fail-first**: the Phase-2 repro test must fail on `dev` HEAD before any fix is written. If the test passes on dev HEAD, the test is wrong — restructure until it fails for the documented B4 reason.
- **No `vi.spyOn` on the function under test**. The deferral, the pipeline, `handleToolExecutionStart`, and the channel-adapter recorder are real instances; only the LLM event stream is stubbed (via `createStubSessionHarness`).
- **Negative coverage**: for every "ordering is correct when X" test, add at least one "ordering is rejected/repaired when Y" boundary test (e.g. ack arrives twice — second is suppressed; tool_call without sessions_spawn — no holding override).
- **Stress is mandatory** for this slice (timing/race bug class; AGENTS.md §258).

### Required test files

| File | Purpose |
| --- | --- |
| `src/auto-reply/reply/block-external-buffer.ack-ordering.test.ts` (new) | Phase-2 repro: deferral + ack + finalize sequence. Records inner deliveries with a real recorder, NOT a `vi.fn` stub. |
| `src/auto-reply/reply/block-external-buffer.test.ts` (extend) | Add T6 stress: 50 deferrals across 2 sessions, then concurrent finalize — no cross-session leak; deterministic per-session ordering. |
| `src/auto-reply/reply/block-external-buffer.b4-fixture.test.ts` (new) | Phase-4 acceptance: fixture-driven B4 replay against a recording channel-adapter mock. |
| `extensions/telegram/src/bot-message-dispatch.b4-ordering.test.ts` (new) | Phase-3/4 integration if H3 is the chosen fix: real `bot-message-dispatch` flow + mock `bot.api` recorder, asserts no `deleteMessage` after final `sendMessage`. |

## 6. Implementation notes

- **Forbidden**: any change to `src/platform/commitment/**`, `src/platform/decision/**`, the 4 frozen call-sites, or the 5 frozen contracts.
- **Surface caps**: H2 fix ≈ 30–60 LOC in `agent-runner.ts` + ~20 LOC in `block-external-buffer.ts` (new `enqueueAck` API) + tests. H3 fix ≈ 15–30 LOC in `bot-message-dispatch.ts` + tests. H1 (regression) — small.
- **Telemetry**: extend the existing `[block-stream-buffer]` line family. Add `event=ack_queued`, `event=ack_emitted_inline`, `event=archive_suppressed`, `event=archive_deleted_pre_final` as applicable to the chosen fix. One line per decision; `turnId` + `sessionId` always present.
- **Idempotency**: the chosen fix must keep T4 (double-finalize is a no-op). If H2's "ack as first deferred entry" path is picked, the ack key must be tracked so a second `emitDeferredAck` call (e.g. retry path) does not insert a duplicate.
- **Forward compat**: per PR-A.2 §4.1, no global mutex without timeout; no module-level singleton; per-`(sessionId, turnId)` state only.

## 7. Handoff Log

### 2026-05-05 — Sub-plan kickoff

- Sub-plan written based on roadmap slice H scope.
- Audit (this plan §2) anchored on dev HEAD `849f214094` (post-roadmap commit).
- Phase 1 (audit) starts immediately; Phases 2–6 gated on Phase 1 outputs and per-phase signoff per invariant #15.
- Branch: `feat/v1-slice-h-stream-edit-ordering` (from latest `origin/dev`).
- Predecessor merged: PR-A.2 baseline. Predecessor in roadmap order: slice D (channel-agnostic persistence) — non-blocking for streaming-layer fix (no shared file).

### 2026-05-04 — Phase 1 audit completed (verified call graph)

- Branch: `audit/v1-slice-h-stream-ordering-phase-1` (from `origin/dev = 4ce7302a7834e3788fa4719ba0a29211fae3c7ce`).
- Re-grep-verified every line citation in §2 + §9. All numbers match dev HEAD on read; only minor range tightening (rotate-body 305 → 305–333; finally-loop narrowed to 822–843; deferral wiring 589–615 → 592–613).
- Read-only audit, zero source/test mutations. Only `.cursor/plans/commitment_kernel_stream_ordering_followup.plan.md` §2 (verified content) and §7 (this entry) changed; frontmatter `h-phase-1-audit-call-graph` flipped to `completed`.
- Call graph matches the kickoff sketch — no surprises. The `Promise.resolve(...)` wrapper at `pi-embedded-subscribe.handlers.tools.ts:341` confirms a clean await of the structural notification before `flushBlockReplyBuffer`.
- Refinement: `archivedAnswerPreviews` finally-loop at `bot-message-dispatch.ts:835–843` only deletes entries with `deleteIfUnused !== false`. The rotate-body push at line 313–322 sets `deleteIfUnused: false`, so it is exempt; the entries that DO get deleted are pushed at line 235 (different boundary path with `deleteIfUnused: true`). H3 in §3 needs to be scoped to that path when Phase 3 picks fixes.
- Hypothesis ranking confirmed unchanged: H2 medium-high (primary), H3 medium (secondary, narrower than kickoff text suggested), H1 low (null candidate). Phase 2 should target H2 first.
- No new findings affect Phase 2 test design beyond the H3-scope refinement above. Phase 2 can proceed against the §5 test plan as written.

## 8. Adjacent / deferred

| Item | Why deferred |
| --- | --- |
| Slack / Discord / Web channel-adapter ordering audit | v1.1 — Telegram is reference per roadmap D6. Once H is closed for Telegram, slice K-style follow-up audits each adapter's `(send | edit | delete)` policy. |
| Reasoning lane ordering (separate `reasoning` draft-stream lane) | Out of scope — B4 transcript symptom is on the answer lane. If reasoning lane shows similar flicker, follow-up sub-plan. |
| Subagent reply framing (B6) | Slice G — separate sub-plan. |
| English meta-text leak (B5) | Slice I — separate sub-plan. |
| `PR-MT` cross-user concurrent broker | v2 deferred per roadmap §8. |

## 9. References

- Roadmap: `.cursor/plans/commitment_kernel_v1_release_roadmap.plan.md` slice H row in §3; B4 evidence row in §2.
- Predecessor PR-A.2: `.cursor/plans/commitment_kernel_streaming_leak_buffering.plan.md` (§3 design, §5 acceptance T1–T5).
- Predecessor PR-A: `.cursor/plans/commitment_kernel_streaming_leak.plan.md` (§7 handoff, §8 adjacent — A.2 row).
- PR-G holding: `.cursor/plans/commitment_kernel_subagent_await.plan.md`.
- Aggregation: `.cursor/plans/commitment_kernel_subagent_result_aggregation.plan.md`; `src/auto-reply/reply/aggregation-policy.ts`; `src/auto-reply/reply/subagent-aggregation.ts`.
- Hard invariants: `.cursor/rules/commitment-kernel-invariants.mdc`.
- AGENTS.md §253 "Tests must catch real bugs"; §258 "Stress + edge cases" (timing/race mandatory).

### Code references (audited 2026-05-05)

- Deferral state: `src/auto-reply/reply/block-external-buffer.ts` (`createExternalBlockReplyDeferral`, `mergeExternalDeferredReplyPayloads`, `externalBufferFinalizeKind`).
- Pipeline: `src/auto-reply/reply/block-reply-pipeline.ts` (`createBlockReplyPipeline.enqueue/flush`); coalescer: `src/auto-reply/reply/block-reply-coalescer.ts`.
- Delivery handler: `src/auto-reply/reply/reply-delivery.ts:61` (`createBlockReplyDeliveryHandler`).
- Wiring point: `src/auto-reply/reply/agent-runner.ts:589–615` (deferral construction + `wrapDeliver`); `:850–873` (`emitDeferredAck`); `:908–910` (`onStructuralToolExecutionStarting` callback wiring); `:988–996` (final flush + `finalizeAfterRun`).
- Execution opts surface: `src/auto-reply/reply/agent-runner-execution.ts:114` (`onStructuralToolExecutionStarting?` field); `:558–565` (`onBlockReply` + `onBlockReplyFlush` wiring); `:477–490` (`onPartialReply` + `onAssistantMessageStart`).
- Tool-start hook: `src/agents/pi-embedded-subscribe.handlers.tools.ts:337–346` (`handleToolExecutionStart` await order: `onStructuralToolExecutionStarting` → `flushBlockReplyBuffer` → `onBlockReplyFlush`).
- Telegram channel adapter: `extensions/telegram/src/draft-stream.ts:202–267` (sendOrEdit), `:362–386` (`deleteMessage`, `forceNewMessage`), `:394–439` (`materialize`); `extensions/telegram/src/bot-message-dispatch.ts:305–332` (`rotateAnswerLaneForNewAssistantMessage`), `:790–855` (finally-block: stream cleanup + `archivedAnswerPreviews` deletion).
- Existing PR-A.2 unit tests: `src/auto-reply/reply/block-external-buffer.test.ts` (5 tests).
