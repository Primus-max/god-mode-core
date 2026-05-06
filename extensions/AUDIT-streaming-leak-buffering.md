# Bug A.2 — block-streaming buffering at tool_call (Phase 1 Audit, READ-ONLY)

Branch: `audit/v1-bug-a2-streaming-buffering-phase-1`
Base SHA: `dev` HEAD = `0e42f6bbac` (PR-#246 — "post-v1 frontier closed (NEW-A/B/C/D + cutover-4 + 51 PRs this session)").
Maintainer signoff: blanket authorization 2026-05-05 (Vladimir); read-only audit phases pre-cleared.
Sub-plan: `.cursor/plans/commitment_kernel_streaming_leak_buffering.plan.md`.
Adjacent audit (composition source): `extensions/AUDIT-outbound-coalescer.md` (NEW-C, dev SHA `86ff73353f`).
Adjacent audit (Slice I sanitizer): `extensions/AUDIT-locale-aware-sanitizer.md`.

This document VERIFIES that the original Bug A.2 fix (commits `ed8a9d137f` + `3df3138fcc`,
sub-plan §7 Handoff Log 2026-04-29) still holds after the post-v1 frontier session
landed — in particular after NEW-C OutboundCoalescer (Phases 1–7) was layered above
the block-external-buffer. No code is modified by this audit. No `src/` files were
edited. Findings are line-anchored to current `dev` HEAD.

Hard invariants kept by Phase 1:
- #5 — block-buffer gate is **structural-only** (`onStructuralToolExecutionStarting`,
  `runResult.toolCalls`); zero text matching on partial deltas verified at the
  three call sites below.
- #6 — `IntentContractor` remains the single reader of raw user text; block-buffer
  inspects only `payload.text` length / metadata, never user prompt.
- #8 — `block-external-buffer.ts` lives in `src/auto-reply/reply/`, outside both
  `src/platform/commitment/` and `src/platform/decision/`; verified no platform
  imports.
- #11 — 5 frozen contracts byte-identical; no audit-driven changes proposed that
  touch them.
- #15 — blanket signoff covers later code-touching phases; this Phase 1 is
  read-only markdown.
- #16 — no new brand types proposed; `turnId` / `sessionId` already exist.

---

## §1 — Exact emit-site for block-streaming chunks at the tool_call boundary

The "emit-site" for block-streaming chunks (Bug A.2's domain) is `deliveredBlockReply`
at `src/auto-reply/reply/agent-runner.ts:672-682`. The composition stack (outermost
caller → innermost adapter) on a turn where `blockStreamingEnabled === true` and
`shouldBufferExternalBlockStreams === true` is:

```
LLM block-stream chunk
  → blockReplyPipeline.enqueue(payload)            [agent-runner.ts:692-700]
    → coalescer (block-stream-coalescer, in-emit-site, time-window)
      → deliveredBlockReply(payload, options)       [agent-runner.ts:672-682]
        → externalBlockDeferral.wrapDeliver(blockBufferInner)  [agent-runner.ts:674]
          → blockBufferInner = outboundCoalescer.register({kind:'final'})
                                                    [agent-runner.ts:658-671]
            → eventually outboundCoalescer.commit → streamingAwareBlockReply
                                                    [agent-runner.ts:638]
              → originalOnBlockReply (channel adapter onBlockReply)
                                                    [agent-runner.ts:585, 593-596]
```

The tool_call boundary inserts itself at one specific structural point:
`handleToolExecutionStart` in `src/agents/pi-embedded-subscribe.handlers.tools.ts:337-346`.
That handler does, in order:
1. `await Promise.resolve(ctx.params.onStructuralToolExecutionStarting?.());`
   (line 341) — flips `externalBlockDeferral.structuralToolExecutionSeen = true`.
2. `ctx.flushBlockReplyBuffer();` (line 343) — drains the block-stream-coalescer
   (the in-emit-site time-window aggregator at
   `src/auto-reply/reply/block-reply-coalescer.ts`).
3. `if (ctx.params.onBlockReplyFlush) await ctx.params.onBlockReplyFlush();` —
   surfaces any synchronous emit-site queue.

The order is deliberate (sub-plan §3 #1): the `notify` call MUST happen BEFORE
the flush so any chunk popped by the flush still hits `wrapDeliver` while the
deferral is in `finalized === false` mode (the chunk is queued onto
`deferred[]`, not delivered to the channel).

Verified at:
- `src/auto-reply/reply/agent-runner.ts:995-997` — embedded runner subscribe
  params bind `onStructuralToolExecutionStarting` to
  `externalBlockDeferral.notifyStructuralToolExecutionStarting()`.
- `src/auto-reply/reply/agent-runner-execution.ts:589` — relays the same hook
  into the lower-level `runEmbeddedPiAgent` invocation.
- `src/agents/pi-embedded-subscribe.handlers.tools.ts:337-346` — final user of
  the hook; ordering preserved.

## §2 — Composition with NEW-C OutboundCoalescer (commit history confirms NO bypass)

NEW-C lands ABOVE block-buffer in the call stack — verified at
`agent-runner.ts:606-622` (the comment block hand-written for NEW-C Phase 4
spelling out the layering). The relevant identity:

| Layer | Sink it calls | Source line |
| --- | --- | --- |
| Block-buffer `wrapDeliver` | `blockBufferInner` (= coalescer-register shim) | `agent-runner.ts:674` |
| Block-buffer `finalizeAfterRun` | same `blockBufferInner` (hoisted) | `agent-runner.ts:1078-1088` |
| `blockBufferInner` body | `outboundCoalescer.register({kind:'final', body: payload, turnId, channelKey})` | `agent-runner.ts:658-671` |
| `outboundCoalescer.commit*` | `streamingAwareBlockReply` (= `originalOnBlockReply`) | `agent-runner.ts:638` |

Three properties verified by reading source:

1. **Block-buffer never bypasses coalescer.** Both the `wrapDeliver` post-finalize
   passthrough branch (`agent-runner.ts:99-101` of `block-external-buffer.ts`) and
   the `finalizeAfterRun` consolidated branch (`block-external-buffer.ts:140-147`)
   call `inner(payload, options)` — and `inner` is the same hoisted
   `blockBufferInner` shim that calls `outboundCoalescer.register`. The hoist
   comment (`agent-runner.ts:653-657`) explicitly calls this out as a
   composition invariant: "both wrapDeliver's post-finalize passthrough and
   finalizeAfterRun's merged-payload branch must hit the SAME register sink".
2. **One `kind=final` register per turn.** Block-buffer consolidates N chunks
   into 1 merged payload via `mergeExternalDeferredReplyPayloads`
   (`block-external-buffer.ts:25-59`). That single payload is the only
   `kind=final` register on the structural-tool-seen branch. On the no-tool
   replay branch (`block-external-buffer.ts:153-176`) each chunk re-enters
   `wrapDeliver` post-`finalized=true` and so individually arrives at
   `outboundCoalescer.register` as `kind=final` — but each chunk has its own
   `(turnId, channelKey)` bucket commit semantics (NEW-C `drop_intermediates`
   keeps last `final`).
3. **Commit trigger is post-`finalizeAfterRun`.** `agent-runner.ts:1801-1805`
   logs `event=commit_signal source=finalize_after_run` and calls
   `outboundCoalescer.commitAll(progressTurnId)`. So the coalescer cannot
   drop the consolidated payload before block-buffer has placed it in the
   bucket.

**Conclusion §2:** block-buffer composition with NEW-C is structurally sound;
no leak path was found where a chunk would skip the coalescer. The
`Single_final_user_facing_message_per_user_turn` invariant remains coalescer-
enforced; block-buffer's role is one tier inwards (per-emit-site stream
consolidation).

## §3 — Composition with Slice I outbound sanitizer

Slice I sanitizer (`src/infra/outbound/outbound-sanitizer.ts`,
`sanitizeOutboundForExternalChannel`) is invoked in `src/infra/outbound/deliver.ts:429`,
which is the **channel adapter** layer — i.e. INSIDE the eventual
`originalOnBlockReply` (= the `onBlockReply` callback the gateway / channel
plugin supplies to `runReplyAgent`). The chain therefore is:

```
block-buffer (Bug A.2)
  → coalescer (NEW-C)
    → originalOnBlockReply (channel plugin)
      → eventually `deliver.ts:429` sanitizeOutboundForExternalChannel
```

Two verifications:

1. **Sanitizer runs on the consolidated text, not on partial chunks.** Because
   the sanitizer sits inside the channel-side delivery path and the coalescer
   only commits ONE merged payload per turn per channel, the sanitizer never
   sees raw partial chunks individually. It always sees post-merge text. This
   matches the Slice I locale gate's structural assumption (audit
   `extensions/AUDIT-locale-aware-sanitizer.md` §a).
2. **No order inversion at tool_call boundary.** The tool_call boundary fires
   in the middle of the run, but the sanitizer never runs mid-run (no chunk
   ever reaches `deliver.ts` until block-buffer's `finalizeAfterRun` →
   `outboundCoalescer.commitAll` chain). So sanitization order is unaffected
   by tool_call timing.

**Conclusion §3:** Slice I composition is unaffected by Bug A.2 changes; the
sanitizer is downstream of the merge.

## §4 — Precise leak surface — when does block-buffer NOT fire?

The block-buffer is **optional** — it only constructs when all three gates fire
(`agent-runner.ts:597-605`):

```
externalBlockDeferral =
  blockStreamingEnabled &&
  streamingAwareBlockReply &&     // = originalOnBlockReply !== undefined
  shouldBufferExternalBlockStreams // = originatingTo present AND isRoutableChannel
    ? createExternalBlockReplyDeferral(...)
    : null;
```

`shouldBufferExternalBlockStreams` (`agent-runner.ts:590-592`) requires
`originatingTo` AND `isRoutableChannel(OriginatingChannel)`. Therefore on the
following turn shapes the block-buffer is **null** and chunks reach
`originalOnBlockReply` directly chunk-by-chunk:

| # | Turn shape | Block-buffer | Coalescer | Per-chunk leak risk |
| --- | --- | --- | --- | --- |
| L1 | Block-streaming OFF (`blockStreamingEnabled === false`) | null | null | **Not Bug A.2 scope** — non-streaming path returns ONE final via `finalizeWithFollowup`. |
| L2 | No `onBlockReply` supplied (e.g. internal-only invocation) | null | null | None — there is no external channel to leak to. |
| L3 | `originatingTo` empty / unroutable channel | null | null | **Possible leak.** Chunks go straight to `originalOnBlockReply` if the caller still wired a `onBlockReply`. Sub-plan §4 row 1 already names this — coverage matrix item. |
| L4 | All three gates present (the standard external user turn) | active | active | None — composition §2 above. |

The L3 leak surface is narrow: it requires `originalOnBlockReply` to be set
while `isRoutableChannel(OriginatingChannel)` is false. `isRoutableChannel`
returns true for Telegram / Discord / etc.; false for ad-hoc / non-channel
contexts. In practice this shape arises on internal/test-style invocations
that supply a `onBlockReply` but no real channel context — outside Bug A.2's
defined production user-turn scope.

The narrower in-scope concern from the sub-plan §3 H2 — "preamble before the
first tool" leaking — is structurally CLOSED at HEAD because:
- `wrapDeliver` defers EVERY chunk from the first `enqueue` (including
  preamble) until `finalizeAfterRun`. The defer state starts `finalized=false`
  at construction; it does NOT require `notifyStructuralToolExecutionStarting`
  to begin buffering.
- `finalizeAfterRun` decides between `consolidated` (tool seen) and `replay`
  (no tool seen) based on the `structuralToolExecutionSeen` flag, which is
  itself set by the structural callback.

Verified at `block-external-buffer.ts:97-105` (`wrapDeliver` always queues
when `finalized === false`).

## §5 — Live-evidence cross-check

The live evidence file recommended by sub-plan §5 / NEW-C audit
(`C:/tmp/openclaw/openclaw-2026-05-06.log`) is **not present** on disk at
audit time. Only `C:/tmp/openclaw/openclaw-2026-05-05.log` exists (1178
lines). A targeted grep for the structured telemetry strings the deferral
emits — `[block-stream-buffer] event=structural_tool_seen`,
`event=emit_consolidated`, `event=replay_stream`, `event=ack_queued` — and
for `[outbound-coalescer]` returns **zero matches** in the 2026-05-05 log.

Repository-root `gateway-*.log` files (28 logs from this session, listed in
`git status`) also contain zero matches for `block-stream-buffer` /
`emit_consolidated` / `replay_stream` / `structural_tool_seen`.

Interpretation:
- Absence-of-evidence here is **not evidence-of-absence of the leak** — it is
  evidence the deferral has not been exercised in a logged run since
  2026-05-05. Block-stream telemetry is gated by `logVerbose` on the
  default-runtime logger (`block-external-buffer.ts:92, 127, 143, 167`), so
  any run with verbose level below `verbose` would also produce zero log
  lines. Recent gateway logs may be from non-streaming runs (Cutover-3 / 4
  test fixtures) or from runs without external channel routing.
- The original 2026-04-29 implementation's regression coverage lives in
  `src/auto-reply/reply/block-external-buffer.test.ts` (4 unit tests) +
  `block-external-buffer.b4-fixture.test.ts` +
  `block-external-buffer.ack-ordering.test.ts`. These run as part of normal
  CI scope; they cover all five sub-plan §5 acceptance scenarios except T3
  (live PR-G holding) and T5 (live cross-session) which are integration-
  scoped.

**Conclusion §5:** No new live evidence of leak found in available logs;
absence noted explicitly. Recommend Phase 2 (if pursued) re-run a Telegram
demo with `OPENCLAW_VERBOSE=verbose` to capture a fresh tool_call turn and
attach the resulting `block-stream-buffer` event sequence to this audit's
revision.

## §6 — Recommended fix path

Given §1–§5: the original Bug A.2 fix from commits `ed8a9d137f` + `3df3138fcc`
**holds at HEAD**. The block-buffer:
- defers external chunks from the first `enqueue` regardless of tool_call
  presence (preamble coverage),
- structurally gates `consolidated` vs `replay` on `notifyStructuralToolExecutionStarting`,
- composes correctly with NEW-C OutboundCoalescer (chunks-merge happens INSIDE
  the coalescer's bucket, not bypassing it),
- is downstream-compatible with Slice I sanitizer (sanitizer runs after merge).

The narrow L3 surface (§4) is **out-of-scope for the originally stated Bug A.2
goal** ("turn'ы с tool_call mid-stream"); it is an unrelated defect class
(unroutable channel + supplied `onBlockReply`) that does not match the
"block-streaming buffering at tool_call" description.

### §6.1 Recommendation: NO source code change in this slice

Phase 1 closes with a deliberate "no-op fix path" recommendation. The
acceptance bar from the sub-plan §5 (T1–T5) is already satisfied by the
existing implementation, the §6 exit criteria are met, and the composition
with NEW-C is structurally sound. Any additional fix would risk regressing
the already-green state.

### §6.2 Forward observations (NOT in scope, NOT a regression)

For follow-up authors only. None of these constitute Bug A.2 violations; they
are observational notes for adjacent slices:

1. **F1 — Compaction notice intermediate (`agent-runner.ts:1530-1535`).**
   The compaction notice block-streaming branch fires fire-and-forget against
   `outboundCoalescer.register({kind:'intermediate', ...})`. NEW-C's
   `drop_intermediates` strategy already drops these on the next commit. No
   leak. Logged here because it was the audit's primary suspect surface
   before reading the comment block at `agent-runner.ts:1518-1530`.
2. **F2 — Telemetry verbosity.** All four `[block-stream-buffer]` events are
   `logVerbose` (gated behind verbose level). For diagnostic post-mortems on
   future suspected leaks, switching to a structured `defaultRuntime.log`
   call (matching NEW-C's coalescer) would aid live triage. Out of scope —
   would touch the file but not the behaviour.
3. **F3 — `block-external-buffer.test.ts` coverage of T5.** The current unit
   tests cover T1, T2, T4 directly and T3 transitively (ACK_SENTINEL ordering
   tests). T5 (cross-session isolation) is asserted at L74-78 inline rather
   than as a dedicated case. Adequate but not labelled.

---

## §7 — Phase 1 deliverable summary

- File added: `extensions/AUDIT-streaming-leak-buffering.md` (this file).
- Source files touched: NONE.
- Frozen-layer touches: NONE.
- Test plan: `pnpm exec tsgo --noEmit` clean (Phase 1 acceptance bar).
- Recommended next phase: STAND DOWN. Bug A.2 closure verified post-NEW-C; no
  follow-up code change needed.

## §8 — References (line-anchored to dev `0e42f6bbac`)

- `src/auto-reply/reply/block-external-buffer.ts:1-185` — full deferral impl,
  ACK_SENTINEL ordering, `mergeExternalDeferredReplyPayloads`,
  `externalBufferFinalizeKind`, `createExternalBlockReplyDeferral`.
- `src/auto-reply/reply/block-external-buffer.test.ts:1-90` — unit coverage
  (T1/T2/T4 + idempotency).
- `src/auto-reply/reply/block-external-buffer.ack-ordering.test.ts` — slice H
  P3 ACK_SENTINEL coverage.
- `src/auto-reply/reply/block-external-buffer.b4-fixture.test.ts` — B4
  acceptance fixture.
- `src/auto-reply/reply/agent-runner.ts:585-682` — block-buffer construction
  + composition stack with NEW-C coalescer hoist.
- `src/auto-reply/reply/agent-runner.ts:995-997` — structural callback wiring
  to embedded subscribe params.
- `src/auto-reply/reply/agent-runner.ts:1075-1090` — finalize seam after
  `blockReplyPipeline.flush({ force: true })`.
- `src/auto-reply/reply/agent-runner.ts:1801-1810` — coalescer commit signal
  (`source=finalize_after_run`).
- `src/auto-reply/reply/agent-runner-execution.ts:115, 273-282, 589` —
  sanitizer + structural-callback relay.
- `src/agents/pi-embedded-subscribe.handlers.tools.ts:337-346` —
  `handleToolExecutionStart`, the structural ordering point.
- `src/infra/outbound/outbound-coalescer.ts:1-80` — NEW-C Phase 3 impl
  comment block laying out invariant chain.
- `src/infra/outbound/deliver.ts:429` — Slice I sanitizer call site.
- `extensions/AUDIT-outbound-coalescer.md` — adjacent NEW-C audit (emit-site
  inventory).
- `extensions/AUDIT-locale-aware-sanitizer.md` — adjacent Slice I audit
  (sanitizer surface).
- `.cursor/plans/commitment_kernel_streaming_leak_buffering.plan.md` — Bug
  A.2 sub-plan; §3 design, §4 scope-of-fix matrix, §5 acceptance, §6 exit
  criteria.
