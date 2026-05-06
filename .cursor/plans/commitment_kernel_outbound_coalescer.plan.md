---
name: NEW-C — OutboundCoalescer per (turnId, channel) — runtime enforcement of Single_final_user_facing_message_per_user_turn
slice: outbound-coalescer
status: in_progress
signoff: GRANTED via blanket authorization 2026-05-05
overview: "Master §0.5.6 NEW-C. Live evidence: ONE user prompt produced TWO assistant-reply emissions at 18:26 + 18:27 + lane wait exceeded 79.5s on session:agent:dev:main (gateway log L2626 `lane wait exceeded: lane=session:agent:dev:main waitedMs=79565`). Contractual invariant Single_final_user_facing_message_per_user_turn exists in master plan prose but has NO runtime gate. Today only `block-external-buffer.ts` (Bug A.2) gates block-streaming chunks within ONE emit-site; non-block emit sites (subagent ack via direct onBlockReply, policy-denial, holding payload, fallback paths, followup-runner) bypass it. Architectural fix: introduce `OutboundCoalescer` in `src/infra/outbound/` keyed by `(turnId, channelKey)`. Every emit-site registers messages with discriminated `kind ∈ {ack, preamble, intermediate, final}`. On turn-finalize signal — primary `attestation.commitmentSatisfied=true` (slice F P5 precedent), fallback `finalizeAfterRun` seam in `agent-runner.ts:1012`, third-line watchdog (default 60s) — coalescer commits ONE final user-facing message per (turnId, channel). Default consolidation: drop intermediates, keep final body verbatim, prepend ack as first text fragment (slice H P3 ACK_SENTINEL ordering parity). Composes with slice I sanitizer (runs AFTER coalescer commit), block-buffer (runs INSIDE one emit-site), PR-G holding (treated as intermediate, dropped on commit). Frozen layer untouched."
todos:
  - id: oc-phase-1-audit
    content: "Phase 1 — Audit (read-only). Output `extensions/AUDIT-outbound-coalescer.md`. Map: (a) every assistant-reply emit-site in `src/auto-reply/reply/` + `src/agents/`, categorise as `ack`/`preamble`/`intermediate`/`final`. Starting set: `agent-runner.ts:584-628` `streamingAwareBlockReply` wrap (final); `agent-runner.ts:866-885` direct `onBlockReply` ack (ack); `agent-runner.ts:1432-1445` notice (intermediate); `agent-runner.ts:1131,1170,1205` followup fallback payloads (final); `block-external-buffer.ts::enqueueAck` (ack — already block-buffered); `subagent-aggregation.ts` PR-G holding (intermediate); PR-G `turnId:final` aggregated reply (final); `reply-delivery.ts` external branch; `dispatch-acp.ts` (audit decides internal vs user-facing); `followup-runner.ts` (final of new turn — own turnId); policy-gate denial (`run-turn-decision.ts`) (final). (b) Confirm canonical turnId source — recommendation: `runId` from `agent-runner-execution.ts` (carried via `ctx.params.runId`, same value used in `[assistant-reply]` log). (c) Confirm channel target source — existing `channel-target.ts` + `delivery-queue-storage.ts targetSerializer.serialize`. (d) Finalize signal source: primary `commitmentSatisfied===true` edge (slice E + F P5 precedent); fallback `finalizeAfterRun` finally block. (e) Emit-sites WITHOUT `(turnId, channel)` context — system-init, cron, persistent-worker, standalone notices → `coalescer:false` bypass allowlist (Phase 6). (f) Deadlock risk: watchdog `maxBufferMs=60s` defaulting commit on timeout. (g) Live-evidence cross-check: 18:26+18:27 double-emit on 2026-05-06 — find both runIds in log, confirm same userPrompt turnId, map to emit-sites."
    status: pending
  - id: oc-phase-2-types-and-seam
    content: "Phase 2 — Types + DI seam. NEW `src/infra/outbound/outbound-coalescer-types.ts`: `OutboundMessageKind = 'ack' | 'preamble' | 'intermediate' | 'final'`; `OutboundMessage = {turnId, channelKey, kind, body: ReplyPayload, ts}`; `OutboundCoalescer` interface with `register/commit/commitAll/bypass/stats`; `OutboundCoalescerDeps = {deliver, mergeStrategy: 'drop_intermediates'|'merge_into_final', maxBufferMs, logTelemetry, clockNow}`. NEW factory `createOutboundCoalescer(deps): OutboundCoalescer` in `src/infra/outbound/outbound-coalescer.ts` (impl Phase 3). Wired into `agent-runner.ts` constructor params next to `externalBlockDeferral`. NO global singleton — instance lifecycle scoped to single `runReplyAgent` invocation (slice E P3 / `createExternalBlockReplyDeferral` precedent). Brand discipline: reuse existing `ChannelTarget`/`runId`/`turnId` typing. No new brand. Tests: pure-type round-trip, brand non-assignability, `commit()` empty buffer noop telemetry, `stats()` reflects depth."
    status: pending
  - id: oc-phase-3-coalescer-impl
    content: "Phase 3 — Coalescer impl in `src/infra/outbound/outbound-coalescer.ts` (~200 LOC). Core: `Map<channelKey, Map<turnId, OutboundMessage[]>>`. Per-bucket watchdog `setTimeout(maxBufferMs)` started on first register; cleared on commit. Watchdog fire = forced commit `[outbound-coalescer] event=timeout_committed`. `register(msg)`: push to bucket, start watchdog if first; `kind=final` does NOT auto-commit (allow followup emit-sites in same turn). `commit(turnId, channelKey)`: read bucket, sort by ts, apply merge strategy (drop_intermediates: pick LAST `kind=final` body, prepend ack text — mirror `mergeExternalDeferredReplyPayloads` from `block-external-buffer.ts:25-59`; OR merge_into_final: concat text by `\\n\\n`, last entry's metadata as envelope), call `deps.deliver(committed)` ONCE, drop bucket, clear watchdog. `commitAll(turnId)`: iterate all channelKey buckets. `bypass(reason, body, deliver)`: emit directly without registering; telemetry `event=bypassed`. Cross-turn isolation: channelKey carries session-scoped target identity (no collision). Failure isolation: deliver throws → bucket cleared, watchdog cleared, warn log, coalescer continues serving other turns. Tests: 12 cases (one final → 1 deliver; ack+intermediate+final → 1 deliver with ack-prefixed final; ack+intermediate (no final) → latest intermediate with ack prefix; two finals → latest wins; empty commit noop; watchdog fires after maxBufferMs; explicit commit clears watchdog; cross-turn isolation; cross-channel isolation (commitAll delivers per channel); bypass routes around; deliver throws → no propagation; idempotent commit)."
    status: pending
  - id: oc-phase-4-wire-emit-sites
    content: "Phase 4 — Wire every Phase-1 emit-site through coalescer. Default: replace direct `deliver(payload)` with `coalescer.register({turnId, channelKey, kind, body, ts})`. Per-site: (1) `agent-runner.ts:584-628` `streamingAwareBlockReply` → `kind=final` wrapped OUTSIDE block-buffer's `wrapDeliver` so block-buffer consolidates first; (2) `agent-runner.ts:866-885` direct ack → `kind=ack`; (3) `agent-runner.ts:1432-1445` notice → `kind=intermediate`; (4) `agent-runner.ts:1131,1170,1205` followup fallbacks → `kind=final` of fallback turn; (5) PR-G holding → `kind=intermediate, holdingHint:true` (dropped on commit); (6) PR-G turnId:final → `kind=final`; (7) policy-gate denial → `kind=final`; (8) followup-runner → own turnId, register `kind=final`. ACP paths: audit decides internal-bypass vs user-facing-wire. Composition: block-buffer keeps its existing per-turn deferral + finalizeAfterRun calls inner deliver; we wrap THAT inner deliver with `(payload) => coalescer.register({kind:'final',...})`. Slice I sanitizer runs INSIDE `normalizePayloadsForChannelDelivery` BELOW coalescer — coalescer commits ONE payload, sanitizer sees it, rest unchanged. Tests (integration): 6 cases — one turn 2 emit-sites (ack+final) → ONE message ack-prefixed; one turn 3 sites (ack+intermediate+final) → ONE message intermediate dropped; two turns sequentially → exactly 2 messages; block-streaming-with-tool turn (Bug A.2 path) → block-buffer consolidates + coalescer commits ONE; ACK_SENTINEL ordering preserved through both layers; sanitizer composition — diagnostic leak still stripped at deliver layer."
    status: pending
  - id: oc-phase-5-finalize-hook
    content: "Phase 5 — Wire commit trigger via slice F P5 precedent. NEW pure-fn hook `src/agents/pi-embedded-runner/run/commit-outbound-on-satisfied.ts` (sibling of `recordTaskOnCommitmentSatisfied.ts`, `recordMemoryOnCommitmentSatisfied.ts`). Signature: `commitOutboundOnCommitmentSatisfied(coalescer, attestation: CommitmentSatisfiedAttestationLike, turnId): Promise<void>`. Reads `commitmentSatisfied` via structural type re-exported from `memory-write-on-satisfied.ts` — NO new import from frozen `src/platform/commitment/`. On `commitmentSatisfied===true` → `coalescer.commitAll(turnId)`. Failure-isolated: commitAll throws → log warn, do NOT propagate. Fallback trigger — legacy `finalizeAfterRun` seam: wrap `coalescer.commitAll(runId)` into `agent-runner.ts:1012` finally block (try/finally semantics already enforce). Idempotency: empty bucket commit = noop; both primary + fallback firing = at most ONE deliver per channel (second sees empty). Tests (5 cases): F1 turn ends with commitmentSatisfied=true → primary fires → fallback noops; F2 turn without commitmentSatisfied (policy-denied early-return) → fallback fires; F3 turn aborts mid-LLM → finalizeAfterRun finally → fallback fires; F4 turn LLM never returns (mocked timeout) → watchdog fires; F5 both primary + fallback fire → exactly ONE deliver (idempotency). Log line: `[outbound-coalescer] event=commit_signal source=<commitment_satisfied|finalize_after_run|watchdog>`."
    status: pending
  - id: oc-phase-6-bypass-allowlist
    content: "Phase 6 — Narrow bypass allowlist for emit-sites without `(turnId, channel)` context. Candidates (final list per Phase 1): system-init/boot announcements (no turnId); cron-driven persistent-worker push (Bug F future — own dispatcher); operator-side internal channels `canvas`/`stdout`/`log` (slice I `EXTERNAL_DELIVERY_SURFACES` allowlist already gates); standalone `/help`/`/status` synchronous replies. Wiring: `coalescer.bypass(reason, body, directDeliver)` with structured `reason` (NOT user-prompt-derived per #5). Telemetry: `[outbound-coalescer] event=bypassed reason=<r>`. Default policy: NEW emit-sites MUST go through coalescer unless explicitly allowlisted. Phase 7 acceptance guard: for any external-surface delivery, assert telemetry shows EITHER `event=committed` OR `event=bypassed` for corresponding turnId in same time window — catches forgotten emit-sites. Tests (3 cases): bypass call delivers immediately, NOT registered; bypass during active turn does NOT affect coalesced commit; bypass with internal target composes correctly with sanitizer."
    status: pending
  - id: oc-phase-7-acceptance-and-live-verify
    content: "Phase 7 — Acceptance + live-verify. NEW `src/auto-reply/reply/agent-runner.coalescer.test.ts` replays NEW-C live evidence: fixture `extensions/regress-fixtures/new-c-double-emit.fixture.json` reconstructs 2026-05-06 18:26+18:27 turn (one user prompt → both ack-style preamble + final reply). Assertions: A1 channel adapter receives EXACTLY ONE send for user turn; A2 send carries final body verbatim; A3 ack text prefixed onto final body; A4 telemetry contains EXACTLY ONE `[outbound-coalescer] event=committed turnId=<id> channel=<c> messages_merged>=2 final_kind=final`; A5 slice F `recordTaskOnCommitmentSatisfied` + slice E `recordMemoryOnCommitmentSatisfied` STILL fire (regression — same edge); A6 slice I sanitizer STILL strips diagnostics from committed payload; A7 16 invariants reverse-test passes. **Live-verify (REQUIRED — invariant #15 + handoff)**: operator restarts gateway, replays prompt that produced double-emit. Assertions: ONE Telegram message per user turn; ONE `[outbound-coalescer] event=committed` per turn in gateway log; lane wait drops below 30s; 24h soak: zero `event=timeout_committed` (would indicate orphaned turn); cross-channel turn → ONE commit per channel. Gates: `pnpm tsgo` green; scoped tests pass; full outbound + reply suites regression-baseline preserved."
    status: pending
isProject: false
---

# NEW-C — OutboundCoalescer

## 0. Provenance

| Field | Value |
| --- | --- |
| Sub-plan of | `.cursor/plans/commitment_kernel_v1_master.plan.md` (§0.5.6 row NEW-C) |
| Inherits | 16 hard invariants from `.cursor/rules/commitment-kernel-invariants.mdc` |
| Predecessors | Slice E (`memory-write-on-satisfied.ts` — commit-on-satisfied edge subscription pattern); Slice F P5 (`task-write-on-satisfied.ts`); Slice I (`outbound-sanitizer.ts` — composes downstream); Bug A.2 (`block-external-buffer.ts` — composes inside emit-site); Slice H P3 (ACK_SENTINEL ordering); PR-G (subagent holding payload — registers as intermediate) |
| Trigger | Master §0.5.6 NEW-C: gateway log L2626 `lane wait exceeded waitedMs=79565` + screenshot 18:26→18:27 double-emit on 2026-05-06 |
| Out of scope | NEW-A, NEW-B, NEW-D; cutover-4; Bug A.2 deeper streaming-buffering refinements; PR-G holding semantics; slice I sanitizer pattern set; persistent buffer crash-recovery; per-channel-class merge strategies; cross-turn coalescing |
| Maintainer signoff | GRANTED via blanket authorization 2026-05-05 |

## 1. Hard invariants this slice keeps

- **#5**: Coalescer keys on structural `(turnId, channelKey)` only. Body opaque (forwarded `ReplyPayload`). `merge_into_final` strategy concatenates `text` field without inspecting content. No regex, no pattern.
- **#6**: Never reads user text.
- **#8**: Fix lives in `src/infra/outbound/` + `src/auto-reply/reply/` — outside both `commitment/` and `decision/`. No new imports either way.
- **#11**: 5 frozen contracts + 4 frozen call-sites + `src/platform/commitment/**` BYTE-IDENTICAL.
- **#15**: Blanket signoff. Subscriber failure NEVER blocks others. Reset failure is observability, never a commitment gate.
- **#16**: No new brand. `EffectFamilyId` ≠ `EffectId` preserved.

Plus: contractual invariant `Single_final_user_facing_message_per_user_turn` (master §0.5.6 + master §3 prose) — this slice provides its first runtime gate.

## 2. Audit findings (TO BE FILLED IN BY PHASE 1)

> Phase 1 produces `extensions/AUDIT-outbound-coalescer.md`. Sketches:

### 2.1. Emit-sites starting set
`agent-runner.ts` lines 584/866/1012/1131/1170/1205/1432; `subagent-aggregation.ts` PR-G holding; PR-G turnId:final; `reply-delivery.ts`; `dispatch-acp.ts` (decide internal vs user-facing); `followup-runner.ts`; policy-gate denial in `run-turn-decision.ts`.

### 2.2. turnId source
`runId` from `agent-runner-execution.ts` (operator-visible correlation id, same value used in `[assistant-reply]` log).

### 2.3. channel target source
Existing `channel-target.ts` + `delivery-queue-storage.ts targetSerializer.serialize`.

### 2.4. Finalize signal source
Primary `commitmentSatisfied===true` edge (slice F P5 precedent). Fallback `finalizeAfterRun` finally block. Watchdog third-line.

### 2.5. Composition
Block-buffer keeps per-turn deferral; we wrap inner deliver. Slice I sanitizer runs AFTER coalescer commit. PR-G holding → intermediate (dropped). ACP internal → bypass.

## 3. Hypothesis

Causal chain: agent runtime issues N internal emit calls per turn across separate emit-sites; each routes to its own delivery path → channel adapter → external send; NO per-turn buffer aggregates across emit-sites; external channel receives N messages. Architectural fix: insert `OutboundCoalescer` as single delivery boundary keyed by `(turnId, channel)`. All emit-sites register; ONE commit per (turn, channel) triggered by `commitmentSatisfied===true` edge with `finalizeAfterRun` + watchdog as fallbacks. Frozen layer untouched. 16 invariants preserved.

## 4. Acceptance criteria

1. One user prompt → exactly one assistant-reply send per (turnId, channel).
2. NEW-C 18:26+18:27 double-emit replay → single committed message.
3. Slice E + F write-on-satisfied hooks STILL fire (regression).
4. Slice I sanitizer composes — diagnostics still stripped.
5. 16 invariants reverse-test green; frozen layer byte-identical.
6. Telemetry per commit: `[outbound-coalescer] event=committed turnId=<id> channel=<c> messages_merged=N final_kind=final`.
7. Watchdog timeout fallback (no commit signal in maxBufferMs).
8. Live TG smoke: replay prompt → ONE message.
9. `pnpm tsgo` + scoped tests + full outbound + full reply suites green.
10. Bypass allowlist enforced; no new emit-site silently skips coalescer.

## 5. Per-phase tests

- Fail-first per phase.
- No `vi.spyOn` on function under test.
- Negative case explicit per phase.
- Phase 7 acceptance fixture mode integration.

## 6. Implementation notes

- New module path: `src/infra/outbound/outbound-coalescer.ts`. Co-located with sanitizer.
- Wiring site: every emit-site identified in Phase 1.
- Three-line defense: primary commit-on-satisfied → fallback finalizeAfterRun → watchdog.
- Default merge strategy: drop_intermediates + ack-prefix (mirrors slice H P3).
- Cross-turn isolation via channelKey carrying session-scoped target identity.
- Failure isolation per-bucket; no propagation.
- Slice I sanitizer composition: runs AFTER commit, sees ONE payload.
- Block-buffer composition: runs INSIDE one emit-site, coalescer wraps the SET.
- PR-G holding: `kind=intermediate, holdingHint:true` (dropped on commit by default).
- ACP path audit decides internal-bypass vs user-facing-wire.
- Bypass allowlist narrow + structured `reason` (per #5).

## 7. Maintainer signoff

GRANTED via blanket authorization 2026-05-05. Admin-merge.

## 8. Deferred / out-of-scope

| Item | Why deferred |
| --- | --- |
| Persistent coalescer buffer (crash recovery) | TBD |
| Per-channel-class merge strategies | TBD |
| Cross-turn debounce coalescing | Likely conflicts with slice K reminder |
| Coalescer-aware retry without re-running LLM | TBD |
| NEW-A/B/D | Separate sub-plans |
| Bug A.2 deeper streaming refinements | Separate sub-plan |
| Bug F (persistent worker push) | TBD |
| cutover-4 | Separate sub-plan |

## 9. Handoff Log

(Empty — filled by handoff-writer post-phase-merge.)

## 10. References

- Master plan §0.5.6 row NEW-C
- Hard invariants `.cursor/rules/commitment-kernel-invariants.mdc`
- Slice E memory hook precedent: `src/agents/pi-embedded-runner/run/memory-write-on-satisfied.ts`
- Slice F P5 task hook precedent: `src/agents/pi-embedded-runner/run/task-write-on-satisfied.ts`
- Slice I sanitizer: `src/infra/outbound/outbound-sanitizer.ts`
- Bug A.2 block-buffer: `src/auto-reply/reply/block-external-buffer.ts`
- Slice H P3 ACK_SENTINEL: `src/auto-reply/reply/block-external-buffer.ts:25-59`
- PR-G holding: `commitment_kernel_subagent_await.plan.md`
- Frozen layer (NOT touched): `src/platform/commitment/**`
- 4 frozen call-sites (NOT touched): `src/platform/plugin.ts:80,340`; `src/platform/decision/input.ts:444,481`
- Outbound emit seam audit start points: `src/auto-reply/reply/agent-runner.ts` ~584/866/1012/1131/1170/1205/1432; `subagent-aggregation.ts`; `reply-delivery.ts`; `pi-embedded-subscribe.handlers.messages.ts:354`
- Bug evidence: `C:\tmp\openclaw\openclaw-2026-05-06.log` lines L2392 / L2626 + Telegram screenshot 18:26→18:27
