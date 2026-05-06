---
name: NEW-B — Unified Session Reset (resetTurnSession on /new)
slice: unified-session-reset
status: completed
signoff: GRANTED via blanket authorization 2026-05-05
overview: "Master §0.5.6 NEW-B. Live evidence (gateway log 2026-05-06 18:25-18:27): /new followed by «что я запомнил про X?» produces TWO assistant replies — (1) hallucinated parrot of prior user turn, (2) actual memory-recall result (correctly empty). MemoryStore is empty after /new (slice E identity-scoped survival is correct), but chat-history kv is NOT cleared atomically with sessionId rotation. Architectural fix: unified `resetTurnSession({sessionId, identityId, sessionKey, reason})` function in `src/platform/session/reset.ts` that all session-scoped stores subscribe to via `SessionResetSubscriber` interface (DI/registry-driven; sibling of slice E `MemoryStore` pattern). `/new` invokes once; chat-history kv subscriber clears the leak; identity-scoped stores (memory, task) register explicit no-op-skipped subscribers for audit completeness. Single source of truth for session boundary. Closes B1 RUNTIME-wise (handoff doc said «B1 closed architecturally» — this slice closes it runtime-wise too)."
todos:
  - id: usr-phase-1-audit
    content: "Phase 1 — Audit (read-only). Output `extensions/AUDIT-unified-session-reset.md`. Map: (a) every existing session-scoped store + what is cleared today vs. should be — starting points: `src/auto-reply/reply/session.ts:216-547` canonical reset path; chat-history kv (grep `chatHistory|chat-history`); `src/platform/session/intent-ledger.ts`; `src/platform/commitment/artifact-world-state-observer.ts` `(sessionId, turnId)` keying; `WorldStateSnapshot.sessions` slice; plugin hooks `getGlobalHookRunner()` at `session.ts:601-630`; `src/platform/decision/memory-wiring.ts` per-turn resolver; transcript file lifecycle; ACP-bound bypass `shouldUseAcpInPlaceReset`. (b) Trace model's input on FIRST turn after /new — identify EVERY data source feeding prompt context; classify each as session-scoped vs identity-scoped vs process-scoped; pinpoint the leak. (c) Document live-evidence reproduction: gateway log lines 18:25-18:27 showing doubled reply + prior user turn appearing in second-turn prompt context. (d) Enumerate closed list of `SessionResetSubscriber` candidates with line-anchored pointers — Phase 6 acceptance asserts `subscribers=N` matches this count. (e) Decide whether `ArtifactWorldStateObserver` needs `clearForSession(sessionId)` API addition (default: NO — observer's per-turn keying naturally orphans old-session records). NO source changes."
    status: completed
  - id: usr-phase-2-types
    content: "Phase 2 — Types in NEW module `src/platform/session/`. NEW file `src/platform/session/reset.ts` (decision-layer-adjacent, NOT inside `src/platform/commitment/` per invariant #8). Types: `SessionResetReason = 'reset_trigger' | 'daily_reset' | 'compaction' | 'forced_recovery' | 'plugin_request'`; `SessionResetEvent = {sessionId: SessionId, sessionKey: string, identityId?: IdentityId, previousSessionId?: SessionId, reason: SessionResetReason, occurredAt: string}`; `SessionResetSubscriber = {id: string, category: 'chat-history' | 'memory-scope' | 'task-scope' | 'observer' | 'world-state' | 'plugin' | 'misc', onReset(event: SessionResetEvent): Promise<SessionResetSubscriberOutcome>}`; `SessionResetSubscriberOutcome = {kind: 'cleared'} | {kind: 'skipped', reason: string} | {kind: 'failed', reason: string}`. NEW branded `SessionResetSubscriberId` distinct from `SessionId`/`IdentityId`/`MemoryEntryId`/`TaskId` per invariant #16. Tests: schema round-trip, brand non-assignability `@ts-expect-error` lines, exhaustiveness compile-check on closed `SessionResetReason` enum."
    status: completed
  - id: usr-phase-3-registry-and-reset-function
    content: "Phase 3 — `SessionResetSubscriberRegistry` + `resetTurnSession()` function in `src/platform/session/reset.ts`. Public API: `createSessionResetSubscriberRegistry()` returns `{register(s): () => void, list(): readonly SessionResetSubscriber[]}`. Free function `resetTurnSession({event, registry, logger}): Promise<SessionResetSummary>` iterates subscribers in insertion order (deterministic), per-subscriber try/catch (failure NEVER blocks others — defense-in-depth per invariant #15), returns `SessionResetSummary = {event, subscribers: readonly {id, category, outcome}[], clearedCount, failedCount, durationMs}`. ONE structured log line: `[session-reset] event=session_reset sessionId=<id> sessionKey=<k> reason=<r> identityId=<id|anon> subscribers=<N> cleared=<n> skipped=<s> failed=<f> durationMs=<ms>`. Tests: registry de-duplicates by id (last-wins + warn); insertion-order determinism; subscriber throws → outcome=failed + others still run; empty registry still emits log line; large registry (50 subs) bounded latency."
    status: completed
  - id: usr-phase-4-wire-subscribers
    content: "Phase 4 — Wire each Phase-1-enumerated store as subscriber. Closed list (refined by audit): (a) **chat-history kv subscriber** — `src/auto-reply/reply/session-reset-subscribers/chat-history-subscriber.ts` (NEW) — clears chat-history kv keyed on `(sessionKey, previousSessionId)`; PRIMARY fix for NEW-B leak. (b) **MemoryStore identity-scope reaffirm** — explicit no-op `kind=skipped, reason='identity-scoped — survives /new by design'`; observability + audit completeness; reaffirms slice E PR-#170 contract. (c) **TaskLedger identity-scope reaffirm** — same posture; slice F. (d) **ArtifactWorldStateObserver per-turn keying adapter** — `src/agents/pi-embedded-runner/run/session-reset-subscribers/artifact-observer-subscriber.ts` (frozen-layer adapter boundary per invariant #8). (e) **WorldStateSnapshot.sessions current-pointer adapter** — same directory. (f) **IntentLedger per-session subscriber** — co-located in `src/platform/session/`. (g) **plugin hook adapter** — fires existing `getGlobalHookRunner().run('session_end'|'session_start')` (replaces inline call at `session.ts:601-630`). Each subscriber: own test file (round-trip + reverse-test + failure-isolation). NO `vi.spyOn` on subscriber's `onReset`. Frozen-layer adapters call EXISTING APIs only — no `src/platform/commitment/` source modification. If audit forces additive API (e.g. `clearForSession`), follow cutover-2 / slice E P6 / cutover-3 P3 ADDITIVE precedent."
    status: completed
  - id: usr-phase-5-wire-into-new-handler
    content: "Phase 5 — Wire `resetTurnSession()` into `/new` and `/reset` paths. Single call site: `src/auto-reply/reply/session.ts` at existing `if (isNewSession) { ... }` block (~line 533). Replace inline plugin-hook call (lines 601-630) with single `await resetTurnSession({event, registry: globalSessionResetRegistry, logger})`. Registry is process-singleton wired at server bootstrap NEW `src/server/session-reset-bootstrap.ts` (mirrors `memory-store-bootstrap.ts`). Daily-staleness reset path (`session.ts:357-373`) routes through same call with `reason: 'daily_reset'`. ACP-bound bypass (`shouldUseAcpInPlaceReset` at `session.ts:258`) UNTOUCHED. Tests: regression — all 30+ existing reset tests in `session.test.ts` (lines 425-1509) stay green; NEW assertion every reset path emits `[session-reset] subscribers=N` log; NEW reverse-test commenting out `resetTurnSession()` call → chat-history subscriber's reverse-test catches leak. Frozen layer untouched — `session.ts` is in `src/auto-reply/reply/`."
    status: completed
  - id: usr-phase-6-acceptance-and-live-verify
    content: "Phase 6 — Acceptance + live-verify. NEW `src/platform/session/__tests__/new-b-replay.acceptance.test.ts` (5 cases): (1) **NEW-B closure** — turn 1 user prompt → chat-history kv populated; simulated /new via `resetTurnSession()` → turn 2 «что я запомнил про X?» → assert chat-history kv for NEW sessionId is empty (no parrot), memory-recall for operator's identity DOES surface prior facts (slice E B1 preserved), `[session-reset] subscribers=N` log fires with cleared>=1, model's prompt receives ONLY new prompt. (2) Reverse — omit `resetTurnSession()` call → chat-history leak observable (bug reproduction fail-first). (3) Subscriber throws → others still run (defense-in-depth). (4) Anonymous session → reset still runs cleanly, `identityId=anon` in log. (5) Identity preservation — turn 1 stores memory under operator A → /new → turn 2 memory recall for A returns prior fact (B1 RUNTIME-wise regression guard). **Live-verify (REQUIRED — invariant #15 + handoff doc)**: gateway restart → operator sends 2 prompts in real Telegram per 18:25-18:27 reproduction. live-verifier asserts: `[session-reset] event=session_reset` fires exactly once on /new, `subscribers=N` matches Phase 1 audit count, ONE assistant reply (parrot gone), surviving reply contains recall result. NEW-B CLOSED."
    status: completed
isProject: false
---

# NEW-B — Unified Session Reset

## 0. Provenance

| Field | Value |
| --- | --- |
| Sub-plan of | `.cursor/plans/commitment_kernel_v1_master.plan.md` (§0.5.6 row NEW-B) |
| Inherits | 16 hard invariants from `.cursor/rules/commitment-kernel-invariants.mdc` |
| Predecessors | Slice D (identity), Slice E (memory — B1 closed architecturally; this slice closes it RUNTIME-wise), Slice F (TaskLedger), Cutover-3 (artifact observer per-turn keying precedent) |
| Trigger | Master §0.5.6 NEW-B: live test 2026-05-06 18:25-18:27 — /new followed by memory recall produced two assistant replies due to chat-history kv leak |
| Out of scope | NEW-A (modality routing), NEW-C (outbound coalescer), NEW-D (locale sanitizer); cross-channel reset; ACP-bound widening; daily-reset timer architecture; subagent registry (slice G); cron-fired resets (slice J); modifying frozen contracts |
| Maintainer signoff | GRANTED via blanket authorization 2026-05-05 |

## 1. Hard invariants this slice keeps

- **#5, #6**: `SessionResetEvent` carries structural fields only (sessionId, identityId, reason); subscribers consume the event and clear OWN state; never introspect text. IntentContractor remains sole reader of raw text.
- **#8**: `src/platform/session/` is decision-adjacent, NOT in `src/platform/commitment/`. Frozen-layer adapters in `src/agents/pi-embedded-runner/run/session-reset-subscribers/` per established bridge boundary.
- **#11**: 5 frozen contracts BYTE-IDENTICAL. `src/platform/commitment/` source not modified. Default per Phase 1 audit: NO frozen-layer extension required.
- **#15**: Blanket signoff covers. Live verify mandatory at Phase 6. Subscriber failure NEVER blocks others.
- **#16**: `SessionId` brand reused. NEW `SessionResetSubscriberId` brand distinct from existing brands; tested at compile + runtime.

## 2. Audit findings (TO BE FILLED IN BY PHASE 1)

> Phase 1 produces `extensions/AUDIT-unified-session-reset.md`. Sketches:

### 2.1. Existing /new path

`src/auto-reply/reply/session.ts:216-547`. Lines 273-306 match `resetTriggers` (`/new`, `/reset`); 357-373 daily-staleness; 372 sessionId rotation; 533-547 compaction/memory-flush/token clear; 572-580 transcript archive; 601-630 plugin hooks via `getGlobalHookRunner()`. NOT cleared today: chat-history kv (PRIMARY suspect for leak).

### 2.2. Stores with potentially session-scoped state

Initial pointers: chat-history kv (gateway-side `chat.ts:104` + agent-side `agent-runner-memory.ts`); MemoryStore (identity-scoped — survives by design); TaskLedger (same); `ArtifactWorldStateObserver` `(sessionId, turnId)` keying; `WorldStateSnapshot.sessions`; `IntentLedger`; plugin hooks; `memory-wiring` per-turn resolver. Phase 1 audit closes this list.

## 3. Hypothesis

Live evidence is unambiguous: memory recall correctly empty after /new; chat-history kv NOT. Architectural fix per master §0.5.6 row B is unified reset with subscriber pattern — NOT per-store hack. Slice E + F established boundary discipline (identity-scoped state survives /new BY DESIGN; session-scoped state clears). Mixing scopes is the bug. Reset event explicitly carries BOTH `sessionId` AND `identityId` so each subscriber chooses correctly. Forgotten subscriber → stale state caught by Phase 1 audit's enumerated closed list + Phase 6 acceptance log assertion `subscribers=N`.

## 4. Acceptance criteria

1. `SessionResetEvent` + `SessionResetSubscriber` + registry exist.
2. `SessionResetSubscriberId` brand distinct from existing (compile + runtime).
3. Subscribers run insertion-order; failure NEVER blocks others; registry de-dups by id.
4. /new and /reset invoke `resetTurnSession()` exactly once. Daily-staleness same path. ACP bypass untouched.
5. All Phase 1 stores registered as subscribers; closed-list count matches `subscribers=N`.
6. Identity-scoped stores survive /new (slice E B1, slice F B7 regression-pass).
7. Chat-history kv cleared atomically; turn 2 after /new sees no prior turn.
8. Single structured log line per reset.
9. Frozen-layer integrity — no edits to `src/platform/commitment/` (default).
10. Live-verify — 18:25-18:27 reproduction yields ONE reply, no parrot, memory preserved.

## 5. Per-phase tests

- Fail-first per phase.
- No `vi.spyOn` on function under test; spies for clock only.
- Negative case explicit per phase.
- Phase 6 acceptance uses real session-state fixtures.

## 6. Implementation notes

- New module: `src/platform/session/reset.ts`. Mirrors `src/platform/identity/`, `src/platform/memory/`, `src/platform/task/` layout.
- Bootstrap: NEW `src/server/session-reset-bootstrap.ts` registers all subscribers in deterministic order.
- Single call site: `session.ts` `if (isNewSession)` block.
- Reason enum closed; `compaction` slot typed-but-inert (slice E P5 precedent).
- Identity-scope reaffirm subscribers explicitly skip with reason — observability that memory was CONSIDERED and intentionally preserved.
- Failure isolation: per-subscriber try/catch; reset failure NEVER blocks commitment.
- Log line format stable for grep regression guards.
- Forgotten-subscriber detection: Phase 6 asserts `subscribers=N` matches audit count.
- ACP bypass preserved.

## 7. Maintainer signoff

GRANTED via blanket authorization 2026-05-05. Admin-merge via `gh pr merge --admin --squash --delete-branch`.

## 8. Deferred / out-of-scope

| Item | Why deferred |
| --- | --- |
| NEW-A modality routing | Separate sub-plan |
| NEW-C outbound coalescer | Separate sub-plan |
| NEW-D locale sanitizer | Separate sub-plan |
| Cross-channel session reset | v2 multi-tenant |
| ACP-bound widening | Out of scope |
| Daily-reset timer architecture | Path uses same `resetTurnSession()` once shipped |
| Subagent registry reset | Slice G |
| Cron-fired resets | Slice J |
| Frozen contracts modification | Frozen per #11 |
| Live-verify against Slack/Discord | Telegram-only per master §0.5.6 |

## 9. Handoff Log

(Empty — filled by handoff-writer post-phase-merge.)

## 10. References

- Master plan §0.5.6 row NEW-B
- Hard invariants `.cursor/rules/commitment-kernel-invariants.mdc`
- Slice E sub-plan `commitment_kernel_memory_layer.plan.md`
- Slice F sub-plan `commitment_kernel_task_ledger.plan.md`
- Slice D `src/platform/identity/`
- Existing /new path `src/auto-reply/reply/session.ts`
- Existing reset triggers `src/config/sessions/types.ts`
- Plugin hook surface `get-reply.reset-hooks-fallback.test.ts`
- ArtifactWorldStateObserver `src/platform/commitment/artifact-world-state-observer.ts`
- Slice E memory hook precedent `src/agents/pi-embedded-runner/run/memory-write-on-satisfied.ts`
- Memory-bootstrap precedent `src/server/memory-store-bootstrap.ts`
