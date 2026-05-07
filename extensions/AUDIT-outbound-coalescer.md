# NEW-C — OutboundCoalescer per (turnId, channel) Phase 1 Audit (READ-ONLY)

Branch: `audit/new-c-outbound-coalescer-phase-1`
Base SHA: `dev` HEAD at audit time = `86ff73353f` (PR-#225 — slice-unified-session-reset NEW-B SLICE COMPLETE).
Maintainer signoff: blanket authorization 2026-05-05 (Vladimir); read-only audit phases always cleared.

This document VERIFIES the §2 audit sketch in
`.cursor/plans/commitment_kernel_outbound_coalescer.plan.md` against live source on
`dev`. No code was executed. No source under `src/` was modified. Findings are
line-anchored to current `dev` HEAD.

Hard invariants kept by Phase 1: #5 (no text matching on `UserPrompt`), #6
(`IntentContractor` sole reader of raw user text), #8 (`src/platform/commitment/`
does not import from `src/platform/decision/`), #11 (5 frozen contracts read-only),
#15 (blanket signoff covers code-touching phases later; Phase 1 is read-only),
#16 (no new brand introduced — coalescer keys on existing structural identifiers).

Plus contractual invariant `Single_final_user_facing_message_per_user_turn`
(master §0.5.6 + master §3 prose) — this slice will provide its first runtime
gate; Phase 1 maps the surface that gate must enclose.

Live evidence file: `C:/tmp/openclaw/openclaw-2026-05-06.log` (lines around L2392
and L2626; timestamps 18:26:55, 18:26:56 lane-wait warn, 18:27:04, 18:27:06
intent-ledger receipt).

---

## §a — Outbound emit-sites for assistant-replies (categorised)

Every emit-site below was verified to currently call `onBlockReply` (= caller-supplied
`GetReplyOptions['onBlockReply']`) directly OR to feed payloads into the
`finalizeWithFollowup` return value, which the gateway-side dispatcher then ships
to the channel adapter. Categorisation: `ack` / `preamble` / `intermediate` /
`final`.

| # | Site (file:line) | Today's path | Kind | Notes |
|---|---|---|---|---|
| 1 | `src/auto-reply/reply/agent-runner.ts:592-595` | `streamingAwareBlockReply = (payload, options) => originalOnBlockReply(payload, options)` | wrapper (final stream) | Fast-path identity wrapper of caller's `onBlockReply`. Final body of ONE block-streaming run. |
| 2 | `src/auto-reply/reply/agent-runner.ts:596-615` | `externalBlockDeferral.wrapDeliver(streamingAwareBlockReply)` | wrapper (final stream) | When `shouldBufferExternalBlockStreams === true`, EVERY chunk goes to `externalBlockDeferral.deferred[]`. Block-buffer (Bug A.2 / `block-external-buffer.ts`) consolidates these into ONE merged payload at finalize time. NEW-C wraps the inner `streamingAwareBlockReply` so the merged payload becomes ONE `kind=final` `register` call. |
| 3 | `src/auto-reply/reply/agent-runner.ts:866-885` (`emitDeferredAck` body, lines 877-892) | branch 1: `externalBlockDeferral.enqueueAck(...)` (slice H Phase 3 — already block-buffered with ACK_SENTINEL); branch 2: `effectiveOpts?.onBlockReply(applyReplyToMode({ text: ackText }))` (no-deferral fallback) | `ack` | When deferral is active, ack already participates in the block-buffer pipeline (Bug A.2 / Slice H P3). When deferral is null (internal channel turn or unroutable), ack lands at adapter directly — this branch is what currently bypasses the future coalescer. |
| 4 | `src/auto-reply/reply/agent-runner.ts:1432-1452` (compaction notice, block-streaming branch) | `void Promise.race([opts.onBlockReply(noticePayload), …])` fire-and-forget | `intermediate` | Sent BEFORE final tail when block-streaming is active. Today races against `blockReplyTimeoutMs` and is fire-and-forget; not aggregated with the final body. |
| 5 | `src/auto-reply/reply/agent-runner.ts:1452-1466` (compaction notice, non-streaming branch) | pushed into `verboseNotices[]` and prepended to `finalPayloads` at line 1467-1469 | `intermediate` | Aggregated into the same `finalizeWithFollowup` return value as the final body, so already coalesces in the non-streaming path. |
| 6 | `src/auto-reply/reply/agent-runner.ts:1131` | `return finalizeWithFollowup(fallbackPayload, queueKey, runFollowupTurn)` (after empty `payloadArray`) | `final` (acceptance fallback) | First fallback path: `payloadArray.length === 0` and we have a synthesised `buildAcceptanceFallbackPayload(...)`. |
| 7 | `src/auto-reply/reply/agent-runner.ts:1133` | `return finalizeWithFollowup(undefined, queueKey, runFollowupTurn)` | `final` (none) | Second fallback path: empty `payloadArray`, no synthesisable fallback → no user-facing message scheduled. NEW-C: bucket commit on this path is a no-op by virtue of empty bucket. |
| 8 | `src/auto-reply/reply/agent-runner.ts:1170` | `return finalizeWithFollowup(undefined, ...)` (post-buildReplyPayloads, all-already-delivered) | n/a | All payloads already shipped via streaming pipeline; coalescer's existing `kind=final` `register` calls fire from the block-buffer wrap (#2). |
| 9 | `src/auto-reply/reply/agent-runner.ts:1205` | `return finalizeWithFollowup(fallbackPayload, ...)` (post-empty replyPayloads, fallback synthesised) | `final` (acceptance fallback) | Mirror of #6 for the post-`buildReplyPayloads` path. |
| 10 | `src/auto-reply/reply/agent-runner.ts:1207` | `return finalizeWithFollowup(undefined, ...)` | `final` (none) | Mirror of #7. |
| 11 | `src/auto-reply/reply/agent-runner.ts:1664-1672` | `return finalizeWithFollowup(finalPayloads.length === 0 ? undefined : finalPayloads.length === 1 ? finalPayloads[0] : finalPayloads, ...)` | `final` (success path) | Primary normal-completion path — single payload OR array. NEW-C: this is the `kind=final` register site for non-block-streaming turns. |
| 12 | `src/auto-reply/reply/agent-runner.ts:938` | `return finalizeWithFollowup(runOutcome.payload, queueKey, runFollowupTurn)` (early-return after `runAgentTurnWithFallback`) | `final` (early-return) | Triggered when the run plan signalled an early-return synthetic payload. NEW-C: `kind=final`. |
| 13 | `src/auto-reply/reply/agent-runner.ts:1264` | `return finalizeWithFollowup(undefined, ...)` (extra branch around heartbeat strip) | n/a | No payload to coalesce. |
| 14 | `src/auto-reply/reply/agent-runner.ts:1661` | `return finalizeWithFollowup(undefined, ...)` (when `queuedSemanticRetry === true`) | n/a | Semantic retry queued; the retry will produce its own coalescer turn. |
| 15 | `src/auto-reply/reply/agent-runner.ts:1676` | `finalizeWithFollowup(undefined, queueKey, runFollowupTurn)` (catch branch) | n/a | Error escape; no user-facing payload (the caller ships its own error reply, see #19/#21). |
| 16 | `src/auto-reply/reply/subagent-aggregation.ts:226-234` (`evaluateAggregationOverride` `holding` arm) | returns `{ kind: 'holding', payloads: [{ text: HOLDING_MESSAGE_TEXT }] }` — the caller (PR-G hook upstream of agent-runner) may substitute the run's `payloadArray` with these holding payloads | `intermediate` (`holdingHint:true`) | PR-G holding payload — synthesised when an in-turn pending continuation child is detected. NEW-C: `kind=intermediate, holdingHint:true`; default merge strategy `drop_intermediates` drops it on final commit. |
| 17 | `src/auto-reply/reply/subagent-aggregation.ts:498-505` (`evaluatePendingChildOverride`, cross-turn) | returns `{ kind: 'holding', payloads: [{ text: PENDING_CHILD_HOLDING_MESSAGE_TEXT }] }` | `intermediate` (`holdingHint:true`) | Cross-turn holding payload (sub-plan §6). Same coalescer treatment as #16. |
| 18 | `src/auto-reply/reply/subagent-aggregation.ts` PR-G `turnId:final` aggregated reply | NOT YET LANDED on `dev` per `applyAggregationOverride` (sub-plan §4 Option A — Phase 1 only emits `holding`). | `final` (future) | Sub-plan §4 `await` mode is reserved; the `final` bucket stays empty for PR-G turns today. NEW-C does not require this site to exist before Phase 4 wiring. |
| 19 | `src/auto-reply/reply/reply-delivery.ts:61-140` `createBlockReplyDeliveryHandler` | `params.onBlockReply(blockPayload)` (lines 130 + 136) — fed by the `BlockReplyPipeline` enqueue at line 125, OR direct send for media-only fallbacks | `final` (block stream tail) | Internal seam between the block-reply pipeline and the channel adapter. NEW-C wraps this `params.onBlockReply` call from the agent-runner side (sites #1/#2) so coalescer runs ABOVE the pipeline; pipeline still handles per-chunk coalescing inside ONE emit-site. |
| 20 | `src/auto-reply/reply/dispatch-acp.ts:330-335`, `:355-358`, `:379-382` | `delivery.deliver('final', payload)` via `createAcpDispatchDeliveryCoordinator` | mixed: TTS `final`, identity-resolved notice `final` (intermediate-classified), error `final` | ACP dispatch path. The first two call sites are user-facing; the error branch IS user-facing. Recommendation: route through coalescer with `kind=final` for error and TTS-final, `kind=intermediate` for the "Session ids resolved" notice. The internal control-plane sub-events go through `projector.onEvent` → projector's own `deliver` and DO NOT need the coalescer (internal log surface, gated by `EXTERNAL_DELIVERY_SURFACES` allowlist in slice I sanitizer). |
| 21 | `src/auto-reply/reply/followup-runner.ts:151-205` (`sendFollowupPayloads`) | per-payload loop: either `routeReply({ payload, channel, to, ... })` (originating route) OR `opts.onBlockReply(payload)` (fallback) | `final` (own turnId) | Followup runner owns its OWN `runId = crypto.randomUUID()` (line 216); each followup is a NEW coalescer turn. NEW-C wires `register({ turnId: runId, kind: 'final', ... })` per payload, then commit at the existing finalize seam (after-loop). |
| 22 | `src/auto-reply/reply/followup-runner.ts:269-285` (`sendCompactionNotice`) | calls `sendFollowupPayloads([{ text, replyToCurrent: true, isCompactionNotice: true }], queued)` | `intermediate` | Compaction notice for the followup turn. Same coalescer treatment as #4. |
| 23 | `src/platform/decision/run-turn-decision.ts:1320-1390` (denial reply hook surface) | denial reason is FORWARDED via decision trace + escalation hook; the actual user-facing denial text is rendered downstream by `agent-runner` (see `acceptanceOutcome` propagation into `buildAcceptanceFallbackPayload` at sites #6/#9) | `final` (denial) | The frozen `run-turn-decision.ts` does NOT itself emit a user-facing reply — it returns a typed denial in the trace. The denial text reaches the user through #6/#9 fallback paths via `acceptanceOutcome.kind`. NEW-C therefore needs NO new emit-site for policy denial; it inherits coalescer coverage from sites #6/#9/#11. **This avoids touching the frozen layer (invariant #11).** |

### Out-of-scope emit channels (not user-facing, not in coalescer surface)

- `dispatch-acp.ts` `projector.onEvent` internal control-plane events → routed
  through `createAcpReplyProjector(...)` to the same `delivery.deliver` seam, but
  for `tool` / `thought` / `progress` kinds that are filtered upstream by slice I
  sanitizer's `EXTERNAL_DELIVERY_SURFACES` allowlist. These remain bypass.
- `intent-ledger.recordFromBotTurn` (`agent-runner.ts:1518-1535`) — observation
  log, not user-visible.
- `evidenceLog.info(...)` — internal log line, not user-facing.
- `turnProgressEmitter.emit('streaming' | 'tool_call' | 'evidence' | ...)` —
  progress topic for operator UI; structurally separate channel; outside coalescer
  surface.

### Already-coalesced surface (composes INSIDE one emit-site)

The Bug A.2 / `createExternalBlockReplyDeferral` (file `block-external-buffer.ts`)
already enforces ONE consolidated payload PER `streamingAwareBlockReply` invocation
across the deferred-buffer chunks (see `mergeExternalDeferredReplyPayloads` at
`block-external-buffer.ts:25-59`, `enqueueAck` at lines 119-129, and
`finalizeAfterRun` at lines 131-177). NEW-C composes ABOVE this layer:
block-buffer's `inner` deliver becomes the coalescer `register` callback so the
ALREADY-MERGED payload arrives as exactly one `kind=final` register call per
emit-site #1/#2.

---

## §b — Canonical turnId source per emit-site

Recommendation in sub-plan §1 confirmed: `runId` from the agent-runner-execution
path is the canonical correlation id.

Concretely:

- `src/agents/pi-embedded-subscribe.handlers.messages.ts:343-355` — the
  `[assistant-reply] runId=…` operator log line is keyed by `ctx.params.runId`.
  This is the same value the gateway log (`L2620`-style) uses to correlate the
  18:26:55 / 18:27:04 emissions in the live evidence (see §g).
- `src/auto-reply/reply/agent-runner.ts:570-574` — `progressTurnId` is computed
  from `opts?.runId` else `generateSecureUuid()` and is forwarded to
  `createTurnProgressEmitter`. This is the SAME id as the per-run `runId` (the
  effective opts override at lines 571-574 ensures it).
- `src/auto-reply/reply/agent-runner.ts:1518-1521` — `turnId: runId` inside
  `intentLedger.recordFromBotTurn(...)`. The `runId` referenced here is the closure
  captured from the `runReplyAgent` invocation (= effective `progressTurnId`).
- `src/auto-reply/reply/followup-runner.ts:216` — `const runId = crypto.randomUUID();`
  scoped to ONE followup turn. Each followup is its OWN coalescer key —
  cross-turn isolation is automatic.
- `src/auto-reply/reply/agent-runner.ts:861-863` — `markDeferredJobRunning({
  turnId: ackRunId, ackMessage })` uses the same `runId` resolved above.

Verdict: **`runId` is the single source of truth**. Coalescer key uses
`runId` cast/aliased as `turnId` (no new brand — invariant #16).

There is exactly ONE corner case to call out for Phase 4 wiring: when the
gateway-side dispatcher invokes `runReplyAgent` it MAY not pass `opts.runId` —
the runner then synthesises one via `generateSecureUuid()`. The synthesised id
is still propagated to the `[assistant-reply]` log AND to the
`turnProgressEmitter`, so the coalescer key remains operator-visible. No
mitigation needed beyond reading the post-resolution `progressTurnId`.

---

## §c — Channel target source per emit-site

Sub-plan §1 reference to `delivery-queue-storage.ts targetSerializer.serialize`
DOES NOT MATCH live source — there is no `targetSerializer` export in
`src/infra/outbound/delivery-queue-storage.ts` on `dev`. The actual reusable
channel-key idiom on `dev` is the `${channelKey}:${accountKey}:${target}`
composition at `src/infra/outbound/target-resolver.ts:106-116` (used by the
directory cache key).

Other relevant seams:

- `src/auto-reply/reply/agent-runner.ts:585-591` — `originatingToForBuffer`
  resolves the per-turn originating-target via `resolveOriginMessageTo({ originatingTo,
  to })` and `isRoutableChannel(sessionCtx.OriginatingChannel)` — this is the
  pair the existing block-buffer keys on (`shouldBufferExternalBlockStreams`).
- `src/auto-reply/reply/followup-runner.ts:142-145` — followup runner resolves
  the routable origin via `loadRouteReplyRuntime()` →
  `isRoutableChannel(originatingChannel) && originatingTo`.

**Recommendation refined**: NEW-C's `channelKey` should be a structural string
composed at the wiring layer (`agent-runner.ts` Phase 4) as
`${channel}:${accountId ?? 'default'}:${target ?? 'default'}` — opaque to the
coalescer (invariant #5: structural-only). The phrase
"existing `channel-target.ts`" in sub-plan §1 (b)/(c) is also slightly off —
`src/infra/outbound/channel-target.ts` only encapsulates the `applyTargetToParams`
helper for tool args; it does NOT expose a serializer. The actual recommended
helper is `target-resolver.ts:106` (read-only directory cache key).

This is a Phase 1 finding only — no source change is required to confirm it; the
adjustment lands in Phase 2 type definitions (sub-plan oc-phase-2-types-and-seam
todo: `OutboundCoalescerDeps.channelKey: string`).

---

## §d — Finalize signal source

Three-line defense confirmed from `dev` source:

1. **Primary trigger — `commitmentSatisfied === true` edge.** Slice E Phase 5
   precedent at `src/agents/pi-embedded-runner/run/memory-write-on-satisfied.ts:167-246`
   defines the structural `CommitmentSatisfiedAttestationLike` type (lines 59-63)
   and switches on `attestation.commitmentSatisfied !== true` (line 172). Slice F
   Phase 5 sibling at `src/agents/pi-embedded-runner/run/task-write-on-satisfied.ts:1-80`
   re-exports the same structural type (line 53). NEW-C Phase 5 hook
   `commit-outbound-on-satisfied.ts` MUST live in the same directory, MUST
   re-export the same structural type — NO new runtime import from
   `src/platform/commitment/` (invariant #8).

2. **Secondary trigger — `finalizeAfterRun` finally seam.** Live at
   `src/auto-reply/reply/agent-runner.ts:1011-1013`:

   ```ts
   if (externalBlockDeferral && streamingAwareBlockReply) {
     await externalBlockDeferral.finalizeAfterRun(streamingAwareBlockReply);
   }
   ```

   This call site is INSIDE the success branch (after `payloadArray =
   aggregationOverride.payloads`), NOT inside an explicit try/finally — but the
   surrounding `runReplyAgent` body has a top-level catch at line 1673 that calls
   `finalizeWithFollowup(undefined, queueKey, runFollowupTurn)`. Phase 5 wiring
   should add `await coalescer.commitAll(progressTurnId)` to BOTH the post-success
   path (around line 1012) AND the catch path (around line 1676) so the fallback
   fires whether or not the LLM completed. The current `externalBlockDeferral`
   ONLY fires on the success path — that gap is what Phase 5's third-line
   watchdog covers.

3. **Tertiary trigger — watchdog timer.** Default `maxBufferMs = 60s` per
   sub-plan §3 `oc-phase-3-coalescer-impl`. This is the ONLY defence against
   "LLM never returns + parent function leaked" (e.g. orphan throw outside the
   `runReplyAgent` scope). Telemetry: `[outbound-coalescer] event=timeout_committed`.

Idempotency: per sub-plan §3 the bucket is dropped after `commit()` so a repeat
commit (e.g. primary + fallback both fire) is a no-op. Empty-bucket commit logs
nothing → primary-then-fallback chain produces EXACTLY ONE `event=committed`.

**Composition**: a `commitmentSatisfied === true` attestation arrives from the
pi-embedded runner BEFORE `runReplyAgent` returns (the runtime emits the
attestation; the runner converts it to a typed `acceptanceOutcome` before
`buildAcceptanceFallbackPayload` runs). Phase 5 hook fires AT the attestation
edge (slice E/F precedent), so the primary commit happens BEFORE the
finally-seam fallback would, and BEFORE `finalizeWithFollowup` is called. Order
in the success path is therefore:

```
LLM emit → externalBlockDeferral.deferred[] (Bug A.2 buffer)
    → attestation.commitmentSatisfied=true edge → Phase 5 hook
        → coalescer.commitAll(turnId) → ONE deliver per channelKey
            → finalizeWithFollowup(payload, ...)
```

The fallback `finalizeAfterRun` at line 1012 + watchdog ONLY matter when the
attestation edge does not fire (LLM crash, abort signal, policy hard-deny before
attestation, timeout outside runner scope).

---

## §e — Emit-sites WITHOUT (turnId, channel) context — bypass allowlist

These sites either lack a `turnId` OR have no `channelKey` (no user-bound origin)
OR are flagged internal by slice I sanitizer's existing `EXTERNAL_DELIVERY_SURFACES`
gate. They are candidates for `coalescer.bypass(reason, body, directDeliver)`
(Phase 6).

| # | Site | Reason for bypass |
|---|---|---|
| E1 | gateway boot announcements | No `runId` (boot event, no inbound user turn). Bypass reason `system_init_announcement`. |
| E2 | persistent-worker push (Bug F) | **LIT (Bug F slice CLOSED)** — sanctioned cron-fire dispatch through `runPersistentWorkerSubsequentPush` adapter; persistent-worker pushes now flow through `OutboundCoalescer.register({turnId, channelKey, kind:'final'})` like every per-turn user-facing path. Bypass slot `cron_persistent_worker` REMOVED at slice `persistent-worker-push` Phase 6 (`BYPASS_REASONS` tuple narrowed 7→6). |
| E3 | `dispatch-acp.ts:367` `acp-dispatch:` info log lines | Internal log, not user-facing. Already gated by slice I sanitizer's `EXTERNAL_DELIVERY_SURFACES` allowlist; coalescer never sees them. |
| E4 | operator-side internal channels: `canvas`, `stdout`, `log` | Slice I sanitizer's `EXTERNAL_DELIVERY_SURFACES` allowlist already filters — these channels deliver via projector / `defaultRuntime.log`, not via `onBlockReply`. Bypass reason `internal_surface_passthrough`. |
| E5 | standalone `/help` / `/status` synchronous replies | Synchronous one-shot reply; no aggregation possible. Bypass reason `synchronous_command_reply`. |
| E6 | `dispatch-acp.ts` `projector.onEvent` tool/thought/progress sub-events | Internal control-plane events, gated upstream by slice I. Bypass reason `acp_internal_event`. |

Bypass policy (Phase 6 todo `oc-phase-6-bypass-allowlist`): structured `reason:
SystemInitReason | PersistentWorkerReason | InternalSurfaceReason | …` (closed
union, NOT user-prompt-derived per invariant #5). New emit-sites must default to
coalescer wiring; allowlist additions require explicit reason + audit row.
Phase 7 acceptance includes a guard: every external-surface delivery emits
EITHER `event=committed` OR `event=bypassed` for a given `runId` in the same
time window; absence of either signals a forgotten emit-site.

---

## §f — Deadlock risk audit

**Risk:** Coalescer `register({ turnId, channelKey, kind: 'final', body })`
buffers the payload and waits for a commit signal. If the signal NEVER fires
(LLM crash, hard-abort outside the success branch, attestation never produced),
buffered messages are lost — user sees nothing for the turn.

**Mitigations layered in three lines:**

1. **Primary commit edge:** `commitmentSatisfied===true` edge (slice E/F P5
   precedent). Fires on every successful turn before `finalizeWithFollowup`.
2. **Finally seam:** Phase 5 wiring adds `await coalescer.commitAll(progressTurnId)`
   at the same site as `externalBlockDeferral.finalizeAfterRun` (line 1012) AND
   inside the `runReplyAgent` catch branch around line 1676 — covers crash /
   non-attestation early-return / acceptance-fallback / no-payload paths.
   Idempotency (sub-plan §3) makes double-fire safe.
3. **Watchdog:** `setTimeout(maxBufferMs)` started on first `register` per
   bucket; cleared on commit. Fire = forced commit with telemetry
   `[outbound-coalescer] event=timeout_committed`. Default 60s — well above the
   observed lane wait of 79.5s would trigger; recommend Phase 3 default 60s but
   make it configurable via `OutboundCoalescerDeps.maxBufferMs` for live-tune.

   Note: the live evidence lane wait of `79565ms` exceeds a 60s watchdog by
   ~20s. That is intentional: the watchdog must fire BEFORE the operator
   notices a stuck turn. A 60s cap means the fallback emit happens ~20s
   before the operator gives up.

**Failure isolation per bucket:** if `deps.deliver(committed)` throws inside
`commit()`, the bucket is still cleared and the watchdog cancelled (sub-plan §3
`oc-phase-3-coalescer-impl` test "deliver throws → no propagation"). One
channel's transport failure never blocks another channel for the same turn,
nor a later turn for the same channel.

**Cross-turn isolation:** keyed on `(turnId, channelKey)`. New `runId`
guarantees a new bucket. No risk of stale-bucket reuse.

**Cross-channel isolation:** `commitAll(turnId)` iterates all `channelKey`
buckets sequentially; one channel's `deliver` throw never aborts the others
(sub-plan §3 test "cross-channel isolation").

**Out-of-scope risks (deferred per sub-plan §8):**

- Process crash mid-bucket → buffered messages permanently lost. Persistent
  buffer is explicitly out-of-scope for v1.
- Coalescer-aware retry (re-deliver without re-LLM) — out-of-scope.

---

## §g — Live-evidence cross-check (2026-05-06 18:26 + 18:27 double-emit)

Source: `C:/tmp/openclaw/openclaw-2026-05-06.log`.

### Reproduction trace

| Wall clock (Europe/Moscow) | Log line | turnId / runId |
|---|---|---|
| 18:26:55.711 | `[assistant-reply] runId=084350d5 lang=ru cyr=139 lat=0 head="Я запомнил ваш рецепт борща с ингредиентами: свекла, капуста, картошка, морковь, томат. Если хотите, могу также помочь с"` | `084350d5-…` |
| 18:26:56.265 | `[diagnostic] lane wait exceeded: lane=session:agent:dev:main waitedMs=79565 queueAhead=0` | (lane: session:agent:dev:main) |
| 18:27:04.541 | `[assistant-reply] runId=cba3e8c9 lang=ru cyr=162 lat=0 head="Я не нашёл в памяти ничего про борщ. Если хочешь, могу прямо сейчас запомнить твои предпочтения по борщу — например: со "` | `cba3e8c9-65f8-4960-8bfe-374768689266` |
| 18:27:06.577 | `[intent-ledger] recorded session=99f9e4f2-82be-4148-bd79-ffb80a2e07e3 channel=telegram kind=receipt topicKey=-` | (session: `99f9e4f2-…`, channel: telegram) |
| 18:27:06.580 | `[progress] turn=cba3e8c9-65f8-4960-8bfe-374768689266 seq=4 phase=tool_call toolName=memory_search detail=memory_search` | confirms `cba3e8c9` is a TURN id (not a sub-id) |
| 18:27:06.594 | `[progress] turn=cba3e8c9-65f8-4960-8bfe-374768689266 seq=6 phase=done` | turn finalized |

### Per-runId reconstruction

- **runId `084350d5`** (18:26:55) — final assistant reply about borscht
  *with* ingredients ("Я запомнил ваш рецепт борща с ингредиентами…"). Matches
  emit-site #11 in §a (`agent-runner.ts:1664-1672` — primary normal-completion
  path, single `finalPayload`). Probable lifecycle:
  `streamingAwareBlockReply` (#1) → block-buffer wrap (#2) →
  `externalBlockDeferral.finalizeAfterRun` (#1011-1013) →
  `finalizeWithFollowup(payload, …)` (#1664).

- **runId `cba3e8c9`** (18:27:04) — *different* user-facing reply: "Я не нашёл
  в памяти ничего про борщ" (denying knowledge of borscht). This is a SEPARATE
  turn (session `99f9e4f2-…`, channel telegram, full UUID
  `cba3e8c9-65f8-4960-8bfe-374768689266`).

### NEW-B vs NEW-C interpretation

NEW-B Phase 1 audit (`extensions/AUDIT-unified-session-reset.md` already in
`dev`) refuted the chat-history hypothesis and established that the 18:26 +
18:27 double-emit is TWO DIFFERENT runs from queue drain (followup queue
ordering). NEW-B Phase 5 (PR-#224) closed the queue leak. **NEW-C is
orthogonal.**

NEW-C closes a **different layer**: even with the queue leak fixed, NOTHING in
the runtime today gates the `Single_final_user_facing_message_per_user_turn`
invariant within ONE `runReplyAgent` invocation. If a future bug or a
not-yet-covered emit-site path (e.g. PR-G holding + final, OR streaming-aware
block tail + acceptance fallback racing on the same runId) emits twice for the
same `(runId, channel)`, only NEW-C catches it.

The live evidence specifically does NOT show two emit-sites colliding on the
SAME `runId` — both emits used DIFFERENT runIds. So the live evidence is the
**motivation** (operator saw two messages within ~10s for the same user
prompt; gate is missing) NOT the **reproduction** of an in-runId collision.
The Phase 7 acceptance fixture
(`extensions/regress-fixtures/new-c-double-emit.fixture.json` per sub-plan
§7) reconstructs an in-runId collision synthetically (ack + intermediate +
final on the same runId) — which is the LIKELY-EXISTING-BUT-UNDETECTED bug
class NEW-C defends against.

### Mapping to coalescer surface

For each runId observed, the coalescer would have fired EXACTLY ONE
`event=committed` (one `register` of `kind=final` from emit-site #1/#2 → one
`commitAll` from the slice-E/F-style hook → one `deliver` to telegram channel
adapter). With both runIds independently committed, the operator-visible
double-emit would have been UNCHANGED *for this specific evidence* (NEW-B's
queue fix was the right closure). The coalescer's value is in the
NOT-YET-OBSERVED case where both emit-sites share a runId — the fixture in
Phase 7.

---

## §h — Composition with existing layers (summary, no new findings)

(Cross-reference only — already documented in sub-plan §6 "Implementation
notes". Reproduced here for the audit deliverable's self-containedness.)

| Layer | Position relative to coalescer | Composition |
|---|---|---|
| Bug A.2 `externalBlockDeferral` (`block-external-buffer.ts`) | INSIDE one emit-site (#1/#2) | Block-buffer's `inner` deliver becomes coalescer's `register` callback. ALREADY-MERGED payload arrives as ONE `kind=final` register. |
| Slice H Phase 3 `ACK_SENTINEL` (`block-external-buffer.ts:22-23`, `enqueueAck` lines 119-129) | INSIDE one emit-site (#3 branch 1) | Ack already block-buffered with sentinel; reaches coalescer as part of the merged payload. Branch 2 of #3 (no-deferral fallback) is what NEW-C newly covers via `kind=ack` register + `drop_intermediates` ack-prefix merge. |
| Slice I outbound sanitizer (`outbound-sanitizer.ts`) | AFTER coalescer commit | Sanitizer runs INSIDE `normalizePayloadsForChannelDelivery` BELOW coalescer. Coalescer commits ONE payload, sanitizer sees it, strips diagnostics; rest unchanged. |
| Slice E memory-write-on-satisfied | At commitmentSatisfied edge | Sibling of NEW-C Phase 5 hook. Same edge subscription; failure-isolated per invariant #15. |
| Slice F P5 task-write-on-satisfied | At commitmentSatisfied edge | Sibling of NEW-C Phase 5 hook. Same edge subscription; failure-isolated per invariant #15. |
| PR-G holding (`subagent-aggregation.ts`) | Site #16/#17 | `kind=intermediate, holdingHint:true`; default merge strategy `drop_intermediates` drops it on final commit. |
| Frozen layer (`src/platform/commitment/`) | NOT touched | NEW-C lives in `src/infra/outbound/` + `src/auto-reply/reply/` + `src/agents/pi-embedded-runner/run/`. Phase 5 hook reads `commitmentSatisfied` via the structural `CommitmentSatisfiedAttestationLike` re-exported from slice E hook — no new runtime import from frozen layer. |
| Frozen 5 contracts (`TaskContract`, `OutcomeContract`, …) | NOT touched | Coalescer keys on opaque `(runId, channelKey, kind, body)`; never reads contract fields. |
| 4 frozen call-sites (`platform/plugin.ts:80,340`, `platform/decision/input.ts:444,481`) | NOT touched | None of these are emit-sites. |

---

## §i — Phase-1 audit confirmations (sub-plan §1 todo line items)

Per `oc-phase-1-audit` todo content (sub-plan front-matter lines 7-10), the audit
must confirm the following six points:

1. (a) Emit-sites mapped + categorised → §a above (23 enumerated rows).
2. (b) Canonical `turnId` source (`runId`) → §b above (5 line-anchored
   confirmations).
3. (c) Channel target source → §c above; **discrepancy logged**: sub-plan
   reference to `targetSerializer` does not match `dev` source; recommended
   substitution is structural `${channel}:${accountId}:${target}` composed at
   the wiring layer (Phase 4).
4. (d) Finalize signal source (3-line defense) → §d above (slice E precedent,
   `finalizeAfterRun` seam at `:1012`, watchdog `maxBufferMs=60s`).
5. (e) Bypass allowlist candidates → §e above (6 enumerated rows).
6. (f) Deadlock risk → §f above (mitigations layered, isolation guarantees,
   out-of-scope risks listed).
7. (g) Live-evidence cross-check → §g above; both runIds reconstructed,
   per-runId emit-site mapped, NEW-C-vs-NEW-B distinction explained.

All seven sections (a-g) are filled with line-anchored evidence. Phase 1 audit
deliverable is COMPLETE.

---

## §j — Forward references for Phase 2+

- Phase 2 `oc-phase-2-types-and-seam`: emit-site list in §a feeds the
  `OutboundMessageKind` union test (`'ack' | 'preamble' | 'intermediate' |
  'final'`). The 23 rows give 4 used kinds + 0 unused — no kind is
  speculative.
- Phase 3 `oc-phase-3-coalescer-impl`: `mergeExternalDeferredReplyPayloads`
  pattern at `block-external-buffer.ts:25-59` is the source-of-truth for the
  default `drop_intermediates` ack-prefix merge strategy. Reuse the same
  ordering invariant (ack first, intermediates dropped, last final body wins).
- Phase 4 `oc-phase-4-wire-emit-sites`: each row in §a maps directly to a
  wiring change. Total wiring touches: 12 `agent-runner.ts` rows + 2
  `subagent-aggregation.ts` rows + 1 `reply-delivery.ts` row + 3
  `dispatch-acp.ts` rows + 2 `followup-runner.ts` rows = 20 register sites.
  ZERO touches in `run-turn-decision.ts` (frozen-layer-adjacent; denial flows
  via existing acceptance-fallback path #6/#9/#11).
- Phase 5 `oc-phase-5-finalize-hook`: `commit-outbound-on-satisfied.ts` pure-fn
  hook reuses the `CommitmentSatisfiedAttestationLike` re-export from
  `memory-write-on-satisfied.ts:59-63`. Wire site mirrors the
  `recordTaskOnCommitmentSatisfied` call site (TBD by Phase 5 — locate via
  Grep on `recordTaskOnCommitmentSatisfied` reference).
- Phase 6 `oc-phase-6-bypass-allowlist`: 6 reasons in §e form the structured
  `BypassReason` union.
- Phase 7 `oc-phase-7-acceptance-and-live-verify`: fixture replays in-runId
  collision; live-verify replays the 2026-05-06 18:26+18:27 prompt and asserts
  ONE telegram message per user turn (= per `runId`). The live evidence does
  NOT today show in-runId collision; the fixture is synthetic for the
  acceptance assertion.

---

## §k — Phase 1 deliverable acceptance

- File present: `extensions/AUDIT-outbound-coalescer.md` (this file).
- Seven sections (§a-§g) plus §h composition + §i confirmations + §j forward
  refs filled with concrete evidence.
- Each emit-site catalogued by category + line ref (23 rows in §a).
- Live-evidence reproduction documented with both runIds (`084350d5`,
  `cba3e8c9-65f8-4960-8bfe-374768689266`).
- Frozen layer: untouched (zero edits under `src/platform/commitment/**`).
- `pnpm exec tsgo --noEmit` clean (verified post-deliverable; see PR test
  plan).

End of NEW-C Phase 1 audit.
