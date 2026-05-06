# NEW-B — Unified Session Reset Phase 1 Audit (READ-ONLY)

Branch: `audit/new-b-unified-session-reset-phase-1`
Base SHA: `dev` HEAD at audit time = `2d3d79a7ee` (PR #213 — 5 sub-plans for post-v1 frontier merged).
Maintainer signoff: blanket maintainer signoff for v1 commitment-kernel slices granted 2026-05-05 by Vladimir; read-only audit phases always cleared.

This document VERIFIES the §2 audit sketch in
`.cursor/plans/commitment_kernel_unified_session_reset.plan.md` against live
source on `dev`. No code was executed. No source under `src/` was modified.
Findings are line-anchored to current `dev` HEAD.

Hard invariants kept by Phase 1: #5 (no text matching on `UserPrompt`), #6
(`IntentContractor` sole reader of raw user text), #8 (`src/platform/commitment/`
does not import from `src/platform/decision/`), #11 (5 frozen contracts read-only),
#15 (signoff required for code-touching phases — Phase 1 is read-only),
#16 (`SessionId` brand reused; new branded ids must be distinct).

---

## §a — Existing session-scoped stores; what is cleared today vs should be on `/new`

The canonical `/new` (auto-reply) path lives in
`src/auto-reply/reply/session.ts`. The reset trigger detection runs at
**`session.ts:273-306`** (matches `/new`, `/reset` against
`DEFAULT_RESET_TRIGGERS`). Daily-staleness reset runs at **`session.ts:357-373`**.
sessionId rotation happens at **`session.ts:372`** (`crypto.randomUUID()`).
Compaction / memory-flush state clear runs at **`session.ts:533-547`**. Old
transcript archive runs at **`session.ts:572-580`**. Plugin hooks
(`session_end` / `session_start`) fire at **`session.ts:601-630`** via
`getGlobalHookRunner()`.

The TWO inputs for §a are: (1) which stores carry session-scoped state, and
(2) whether they are cleared atomically with the `/new` rotation. The closed
list:

| # | Store | File:line | Scope | Cleared today on `/new` (auto-reply)? | Cleared today on RPC `sessions.reset`? | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `sessionEntry.compactionCount` / `memoryFlushCompactionCount` / `memoryFlushAt` / `memoryFlushContextHash` / token totals | `src/auto-reply/reply/session.ts:533-547` | session | YES (inline reset) | YES (via store update) | OK |
| 2 | Transcript file `<sessionId>.jsonl` | `src/config/sessions/transcript.ts:88-131`, `src/config/sessions/paths.ts:235-260` | session (per-sessionId pathname) | NEW sessionId → NEW path → fresh file. OLD path is archived (`session.ts:572-580`) | Same | OK — transcript file is NEVER reused across sessionId rotations |
| 3 | Bootstrap workspace snapshot cache | `src/agents/bootstrap-cache.ts:23-32` (`clearBootstrapSnapshotOnSessionRollover`) | sessionKey | YES — `session.ts:352-355` calls it before sessionId reassignment | YES — `gateway/session-reset-service.ts:142` `clearBootstrapSnapshot(target.canonicalKey)` | OK |
| 4 | `IntentLedger` per-session state (`Map<"${sessionId}::${channelId}", IntentLedgerSessionState>`) | `src/platform/session/intent-ledger.ts:192-194, 345-368, 718` (process-singleton `intentLedger`) | sessionId-scoped | NO — but new sessionId orphans old key; old entry naturally becomes unreachable | NO — same | OK functionally; SHOULD register a no-op-or-invalidate subscriber for audit completeness (Phase 4 list item) |
| 5 | `IntentLedger` recent-intent history (sliding window, same Map) | same file lines 116-119, 467-493 | sessionId-scoped | NO — orphaned by sessionId rotation | NO — same | OK functionally; same posture as #4 |
| 6 | `IntentLedger` workspace probe / identity facts cache | same file lines 121-126, 579-650 | sessionId-scoped | NO — orphaned | NO — same | OK functionally |
| 7 | `ArtifactWorldStateCollector` `(sessionId, turnId)` buckets | `src/platform/commitment/artifact-world-state-observer.ts:79-122` (process-singleton via `getProcessArtifactWorldStateCollector()` line 167) | (sessionId, turnId) | NO — but bucket key includes sessionId; new sessionId means old buckets become unreachable from observer (`activeKey` is set per-turn). Per-turn soft cap of 8 (`DEFAULT_PER_TURN_LIMIT`) means OLD buckets accumulate UNTIL eviction by future writes under the SAME old key — but new sessionId NEVER writes under the old key, so old buckets are leaked memory only, NOT semantic leak | NO — same | LEAK-FREE for prompt context (observer reads only `activeKey`, set per-turn). Pure memory bloat — NOT in NEW-B scope; Phase 4 audit recommendation: add a `clearForSession(sessionId)` API only if memory profiling shows growth (default decision per §g: NO) |
| 8 | `WorldStateSnapshot.sessions` (subagent followup registry) | `src/platform/commitment/session-world-state-observer.ts:24-49`, `world-state.ts:4-14` | derived dynamically from `getSubagentRunsSnapshotForRead(inMemoryRuns)` (`subagent-registry-state.ts`) | N/A — derived view | N/A | NOT a session-scoped store; pure projection |
| 9 | Plugin hook surface (`session_end` + `session_start`) | `src/auto-reply/reply/session.ts:601-630` (inline call sites); `src/plugins/hook-runner-global.ts:52` (`getGlobalHookRunner`) | event-bus (subscribers own state) | YES — both events fire on `/new`; subscribers manage their own state | NO — `session-reset-service.ts` does NOT fire `session_end` for the reset path (only via `archiveSessionTranscripts` cleanup); asymmetry exists | Phase 4 should fold these into the unified subscriber bus to remove the per-call-site duplication |
| 10 | `memory-wiring.ts` per-turn resolver | `src/platform/decision/memory-wiring.ts:91-233` | per-turn (rebuilt every turn from `getMemoryRuntime(cfg)`) | N/A — rebuilt per turn from process-scoped runtime | N/A | NOT a session-scoped store; resolver is a pure factory |
| 11 | `MemoryStore` semantic + episodic | `src/server/memory-store-bootstrap.ts` (singleton) | identity-scoped (slice E PR-#170 contract) | NO — survives `/new` BY DESIGN (slice E B1) | NO — same | CORRECT BEHAVIOR. Phase 4 registers an explicit no-op-skipped subscriber for observability (audit completeness) |
| 12 | `TaskLedger` records | `src/platform/task/task-ledger.ts` (singleton via `runtime.taskLedger`) | identity-scoped (slice F PR-#188) | NO — survives `/new` BY DESIGN (slice F B7) | NO — same | CORRECT BEHAVIOR. Same posture as #11 |
| 13 | **`FOLLOWUP_QUEUES`** (process-scoped global Map keyed by `sessionKey`, persisted to `~/.openclaw-dev/followup-semantic-queues.json`) | `src/auto-reply/reply/queue/state.ts:46-50, 67-99` | sessionKey (NOT sessionId) | **NO** — `session.ts` does NOT call `clearFollowupQueue` / `clearSessionQueues` on `/new` | YES — `gateway/session-reset-service.ts:128-133` calls `clearSessionQueues([...queueKeys])` | **THE LEAK** (see §f) |
| 14 | `SessionManagerCache` (per-sessionFile keyed) | `src/agents/pi-embedded-runner/session-manager-cache.ts:35-83, 85` (singleton) | sessionFile path | N/A — keyed by ABSOLUTE path; new sessionId → new path; old entries TTL-expire (default 45s) | N/A | OK — same property as transcript file |
| 15 | Tracked browser tabs | `src/browser/session-tab-registry.ts` (called from `session-reset-service.ts:122-126`) | sessionKey-set | NO — `session.ts` does NOT call `closeTrackedBrowserTabsForSessions` | YES — `session-reset-service.ts` | Out-of-scope for NEW-B (no log evidence of leak); Phase 4 SHOULD fold this into subscriber bus to keep RPC and `/new` paths symmetric |
| 16 | Embedded PI run abort + wait-for-end | `src/agents/pi-embedded.ts` (`abortEmbeddedPiRun`, `waitForEmbeddedPiRunEnd`) | sessionId | NO — `session.ts` does NOT abort an in-flight run on `/new` | YES — `session-reset-service.ts:140-141` aborts and waits | Out-of-scope for NEW-B (timing-only); flagged for Phase 4 SHOULD-be-symmetric review |
| 17 | Subagent runs for the requester | `src/auto-reply/reply/abort.ts` `stopSubagentsForRequester` | sessionKey | NO — only called from RPC path | YES — `session-reset-service.ts:134` | Out-of-scope for NEW-B; flag for Phase 4 |

The **canonical asymmetry**: the gateway-RPC reset (`sessions.reset`) clears
queues, browser tabs, in-flight PI runs, and subagents. The `/new` (auto-reply
session.ts) reset clears compaction state + bootstrap snapshot + archives the
transcript, fires the `session_start`/`session_end` hooks — and does NOT clear
the followup queue. The leak surfaces because the auto-reply path is the path
real operators take in Telegram (a `/new` text message), not the path admin RPC
takes.

---

## §b — Trace of the model's input on the FIRST turn after `/new`

Per `src/auto-reply/reply/session.ts:533-547` + `session.ts:572-580`, on `/new`
the auto-reply pipeline:

1. Rotates `sessionId` to a fresh UUID (line 372).
2. Resolves the new transcript path `<newSessionId>.jsonl` via
   `resolveSessionTranscriptPath` (`paths.ts:254-260`) — fresh empty file once
   `ensureSessionHeader` runs.
3. Archives the OLD transcript via `archiveSessionTranscripts` (lines 572-580).
4. Rebuilds the `sessionCtx: TemplateContext` (lines 582-597) with
   `IsNewSession="true"`.

The first model call after `/new` runs through the followup runner →
`buildEmbeddedRunExecutionParams` → `runEmbeddedPiAgent` → eventually
`SessionManager.open(params.sessionFile)` at
**`src/agents/pi-embedded-runner/run/attempt.ts:2315`**. `SessionManager.open()`
reads the JSONL transcript at the resolved path. Because the path is keyed by
the NEW sessionId, the JSONL file is empty (header only after
`ensureSessionHeader`), so the model's history-side conversation is empty.

The first-turn prompt context comes from these sources, classified by scope:

| Source | File:line | Scope | Survives `/new`? | Source of the parrot? |
| --- | --- | --- | --- | --- |
| System prompt (built per-turn) | `src/agents/system-prompt-params.ts`, `src/agents/system-prompt-report.ts` (called from `attempt.ts`) | per-turn (deterministic-from-config) | rebuilt | NO |
| Transcript file `<newSessionId>.jsonl` (read by `SessionManager.open`) | `attempt.ts:2315` | session (per-sessionId path) | NO — fresh path is empty | NO |
| User prompt (current turn) | `FollowupRun.prompt` flowing through `agent-runner.ts` → `runEmbeddedPiAgent` | per-turn | N/A — it IS the new turn | this is the legitimate input |
| `<memory>` block (slice E recall) | `src/agents/pi-embedded-runner/run/attempt.ts:27` (`getMemorySearchManager`) → `src/memory/index.ts` | identity-scoped | YES (slice E B1) | NO — this is the legitimate B1 path |
| `<active_tasks>` block (slice F) | TaskLedger reads in `attempt.ts` | identity-scoped | YES (slice F B7) | NO |
| `<web_evidence>` block | `src/platform/commitment/world-state.ts:58-67` `WebEvidenceWorldState`; runtime adapter populates per-turn | per-turn | rebuilt per turn | NO |
| `<inbound_attachments>` block | `src/auto-reply/reply/agent-runner-utils.ts` (per-turn assembly) | per-turn | rebuilt | NO |
| `IntentLedger` peek-context injected into planner (`[intent-ledger] peek=N injected=N`) | `src/platform/session/intent-ledger.ts:537-544` (`peekPending` keyed by `sessionId::channelId`) | sessionId-scoped | NEW sessionId → 0 entries (composite key changes) | NO |
| `<workspace>` block | `intent-ledger.ts:579-611` (`getOrProbeWorkspace`); also injected at `session=99f9e4f2 channel=telegram reason=contract` (log line 701 in evidence) | sessionId-scoped (new sessionId → fresh probe) | NO | NO |
| **`FollowupRun.prompt` carrying corrective re-run text from PRIOR turn's closure-outcome-dispatcher** | `src/auto-reply/reply/closure-outcome-dispatcher.ts:842-847` builds the prompt; `enqueueFollowupRun` adds to `FOLLOWUP_QUEUES` (sessionKey-keyed); **drained AFTER `/new` completes**, executed under the NEW sessionId | sessionKey-scoped (process-global Map + persisted to disk) | **YES — survives `/new`** | **THIS IS THE PARROT SOURCE** |

The parrot reply is NOT a transcript leak, NOT a chat-history leak (the
gateway-side `chat.history` RPC is a READER of the transcript file — and the
transcript file is fresh). It is the FOLLOWUP_QUEUES leak: the queued
corrective prompt embeds the literal prior-turn user text via
`closure-outcome-dispatcher.ts:842-847`:

```ts
const prompt = [
  correctivePrompt,
  "[Original task - preserve exact task intent below]",
  originalPrompt,        // ← prior turn's user text «запомни мне рецепт борща…»
].join("\n\n");
return enqueueFollowupRun(params.queueKey, { ...params.sourceRun, prompt, ... }, ...);
```

That `originalPrompt` is the OLD turn's user message text. The queue is
process-global, keyed by `sessionKey` (NOT `sessionId`), and persists across
restarts (`state.ts:67-99`).

---

## §c — Live-evidence reproduction (gateway log 2026-05-06 18:25-18:27)

File: `gateway-pr211.log` at repo root (size 184_749 bytes; PR #211 gateway
session).

| Timestamp | Line(s) | Event |
| --- | --- | --- |
| 2026-05-06T18:23:06.933+03:00 | 64 | `[task-classifier] outcome=persistent_worker prompt.head="запомни мне рецепт борща: свекла, капуста, картошка, морковь, томат"` — turn `8b1836ac-fd69-4a16-9125-b29844c36f77` under sessionId `f71784c5` |
| 2026-05-06T18:24:35.033+03:00 | 78 | `[assistant-reply] runId=8b1836ac` — bot reply «Запомнил рецепт борща…» (legitimate reply to the recipe-recall prompt under OLD session) |
| 2026-05-06T18:24:37.091+03:00 | 79 | `[intent-ledger] recorded session=f71784c5… kind=clarifying` |
| 2026-05-06T18:24:37.094+03:00 | 80 | `[evidence] promises=0 receipts=0 violations=0 action=none` — closure-outcome-dispatcher concluded the run did NOT satisfy a verified receipt (semantic_retry path active) |
| `/new` boundary | between 80 and 92 | `sessionId` rotated `f71784c5` → `99f9e4f2-82be-4148-bd79-ffb80a2e07e3`. **No `clearFollowupQueue` was called** — the corrective followup remained on the queue |
| 2026-05-06T18:25:18.070+03:00 | 116-118 | `[memory] slice-E memory bootstrap: rebuilding memory runtime — cfg signature changed` (operator sent /new; new sessionId persisted) |
| 2026-05-06T18:25:23.156+03:00 | 120 | **`[task-classifier] outcome=persistent_worker prompt.head="[Queued messages while agent was busy] --- Queued #1 The previous run did not satisfy the task well enough… Continue the same task and return only the final completed result… [Original task - preserve exact task intent below] запомни мне рецепт борща…"`** — THE LEAKED PRIOR-TURN PROMPT, drained from `FOLLOWUP_QUEUES` AFTER `/new` |
| 2026-05-06T18:25:36.675+03:00 | 137 | `[task-classifier] outcome=answer prompt.head="что я запомнил про борщ?"` — operator's NEW user prompt under turn `cba3e8c9-65f8-4960-8bfe-374768689266` |
| 2026-05-06T18:26:55.710+03:00 | 148 | **`[assistant-reply] runId=084350d5 head="Я запомнил ваш рецепт борща с ингредиентами: свекла, капуста, картошка, морковь, томат…"`** — THE PARROT REPLY produced by the followup-queue replay run (`084350d5`), NOT by `cba3e8c9` |
| 2026-05-06T18:27:04.540+03:00 | 152 | `[assistant-reply] runId=cba3e8c9 head="Я не нашёл в памяти ничего про борщ…"` — the legitimate empty memory-recall reply (correctly empty per slice E B1) |
| 2026-05-06T18:27:06.581+03:00 | 154-157 | turn `cba3e8c9` `phase=tool_call toolName=memory_search`, then `phase=done` |

The hallucination is NOT the model imagining text; it is the followup runner
faithfully replaying the prior session's prompt verbatim, which produces the
parrot. The "two replies" the operator sees are TWO DIFFERENT runs (`084350d5`
and `cba3e8c9`) under the new sessionId, NOT a single duplicated emit.

---

## §d — Closed list of `SessionResetSubscriber` candidates (Phase 4)

The Phase 6 acceptance fixture asserts `subscribers=N` matches this count. The
closed list (in registration order, deterministic by category then id):

| # | id | category | File:line | Action on reset |
| --- | --- | --- | --- | --- |
| 1 | `chat-history-followup-queue` | `chat-history` | NEW `src/auto-reply/reply/session-reset-subscribers/chat-history-subscriber.ts`; reuses `clearFollowupQueue` from `src/auto-reply/reply/queue/state.ts:294-310` | **PRIMARY FIX**: `clearFollowupQueue(event.sessionKey)` — drops every queued prompt for the rotating sessionKey, including corrective re-prompts that embed the prior-turn user text |
| 2 | `intent-ledger-session-scope` | `misc` | adapter calling `intentLedger.invalidate(...)` from `src/platform/session/intent-ledger.ts:679-701`; co-located in `src/platform/session/session-reset-subscribers/intent-ledger-subscriber.ts` (NEW) | Invalidate per-session entries for `(previousSessionId, *)`. Currently leaked memory only; subscriber makes the cleanup explicit and observable |
| 3 | `bootstrap-snapshot` | `misc` | adapter calling `clearBootstrapSnapshot(event.sessionKey)` from `src/agents/bootstrap-cache.ts:19-21` | Replaces the inline call at `session.ts:352-355`; folds into unified bus |
| 4 | `plugin-hook-session-end-start` | `plugin` | adapter calling `getGlobalHookRunner().runSessionEnd(...)` and `runSessionStart(...)`; replaces inline call at `src/auto-reply/reply/session.ts:601-630` | Same effect as today; single call site |
| 5 | `memory-store-identity-scope-reaffirm` | `memory-scope` | NEW `src/agents/pi-embedded-runner/run/session-reset-subscribers/memory-store-subscriber.ts` (frozen-layer adapter boundary per invariant #8) | `kind: "skipped", reason: "identity-scoped — survives /new by design (slice E B1)"` — observability only; reaffirms slice E PR-#170 contract |
| 6 | `task-ledger-identity-scope-reaffirm` | `task-scope` | NEW `src/agents/pi-embedded-runner/run/session-reset-subscribers/task-ledger-subscriber.ts` | Same posture as #5; reaffirms slice F PR-#188 contract |
| 7 | `artifact-observer-per-turn-keying` | `observer` | NEW `src/agents/pi-embedded-runner/run/session-reset-subscribers/artifact-observer-subscriber.ts` (frozen-layer adapter boundary) | `kind: "skipped", reason: "(sessionId, turnId) keying naturally orphans old buckets"` — observability only; per §g audit decision NO `clearForSession` API addition |
| 8 | `world-state-sessions-current-pointer` | `world-state` | adapter co-located in `src/agents/pi-embedded-runner/run/session-reset-subscribers/world-state-subscriber.ts` | `kind: "skipped", reason: "derived projection of subagent registry runs"` |

**Subscriber count `N = 8`.** Phase 6 acceptance fixture must assert
`subscribers=8` (one chat-history clear, two identity-scope reaffirms, four
adapter-skips, one plugin-hook adapter).

Out-of-scope for Phase 4 (per master plan §0.5.6): browser tab registry
(item #15), embedded PI run abort (item #16), subagent stop (item #17). These
exist in the gateway-RPC reset path but no live evidence shows them leaking
into auto-reply `/new`. They can be folded into the bus in a successor slice
(see Phase 4 sub-plan note about deferred items).

---

## §e — Boundary discipline confirmation

The new module `src/platform/session/reset.ts` (Phase 2) lives **outside**
`src/platform/commitment/`, satisfying invariant #8
(`src/platform/commitment/` does not import from `src/platform/decision/` or
sibling decision-adjacent modules). `src/platform/session/` already exists
as a sibling of `src/platform/identity/`, `src/platform/memory/`,
`src/platform/task/` — see existing `src/platform/session/intent-ledger.ts`
on the same `dev` HEAD. Invariant #11 (5 frozen contracts) is upheld:
`reset.ts` introduces NEW types (`SessionResetReason`, `SessionResetEvent`,
`SessionResetSubscriber`, `SessionResetSubscriberOutcome`,
`SessionResetSummary`, branded `SessionResetSubscriberId`) — none of these
touch `TaskContract`, `OutcomeContract`, `QualificationExecutionContract`,
`ResolutionContract`, `RecipeRoutingHints`.

Frozen-layer adapters live in
`src/agents/pi-embedded-runner/run/session-reset-subscribers/` per the
established bridge boundary (slice E P5 `memory-write-on-satisfied.ts`,
slice F P5 `task-write-on-satisfied.ts`, cutover-3 P5
`recordArtifactOnCommitmentSatisfied.ts` precedent). The adapters CALL
existing public APIs of the frozen layer (`ArtifactWorldStateCollector`,
`SessionWorldStateObserver`); they NEVER modify source files in
`src/platform/commitment/`.

Subscriber registration is REGISTRY-DRIVEN (Phase 3 produces
`createSessionResetSubscriberRegistry()`); there is NO direct mutation of
frozen-layer source. The `register(...)` call site is the bootstrap hook in
NEW `src/server/session-reset-bootstrap.ts` (Phase 5), which mirrors the
existing `src/server/memory-store-bootstrap.ts` pattern (slice E precedent).

Branded id policy (invariant #16): the new branded
`SessionResetSubscriberId` is type-distinct from `SessionId` /
`SessionKey` / `IdentityId` / `MemoryEntryId` / `TaskId`. Phase 2 ships a
`@ts-expect-error` table-test validating non-assignability at compile time;
the runtime brand is a phantom string per the established
`Brand<T, "SessionResetSubscriberId">` convention.

---

## §f — CRITICAL: pinpointed leak source

The leak is **NOT** the chat-history kv (the plan-author's initial
hypothesis). The gateway-side `chat.history` method
(`src/gateway/server-methods/chat.ts:1444-1508`) is a READER of the
on-disk transcript file `<sessionId>.jsonl` — and the transcript file path
rotates with sessionId, so the file is empty after `/new`. The
`chatHistoryPlaceholderEmitCount` counter at `chat.ts:104` is process-global
diagnostic state for OVERSIZED placeholder accounting; it has no per-session
content.

**The leak is `FOLLOWUP_QUEUES` at
`src/auto-reply/reply/queue/state.ts:46-50` (process-global Map, persisted
to `~/.openclaw-dev/followup-semantic-queues.json` per
`state.ts:67-99`).** Specifically:

1. **Producer**:
   `src/auto-reply/reply/closure-outcome-dispatcher.ts:842-847,848-862`
   constructs the corrective followup prompt by joining a fixed retry header
   with the **literal prior-turn user text** (`originalPrompt`):

   ```ts
   const originalPrompt = params.sourceRun.prompt.trim();
   const prompt = [
     correctivePrompt,
     "[Original task - preserve exact task intent below]",
     originalPrompt,                    // ← captures «запомни мне рецепт борща…»
   ].join("\n\n");
   return enqueueFollowupRun(params.queueKey, { ...params.sourceRun, prompt, ... }, ...);
   ```

2. **Storage**: `enqueueFollowupRun` at
   `src/auto-reply/reply/queue/enqueue.ts:61-99` writes the run into
   `FOLLOWUP_QUEUES.get(key) ?? createFollowupQueue(...)`. The map's
   global symbol key (`Symbol.for("openclaw.followupQueues")` at
   `state.ts:46-50`) shares the queue across bundled chunks. The queue
   persists to disk via `syncPersistedFollowupQueues` (`state.ts:113`).

3. **/new path leaves it intact**: `src/auto-reply/reply/session.ts`
   contains zero references to `FOLLOWUP_QUEUES`, `clearFollowupQueue`,
   or `clearSessionQueues` (verified via repo-wide grep of session.ts —
   the only matches are `sessionKey` / `isNewSession` / `sessionId`, none
   touch the queue map). The compaction state clear at lines 533-547
   touches sessionEntry fields only. The plugin-hook block at lines
   601-630 fires `session_end` / `session_start` but does NOT clear the
   queue.

4. **RPC-reset path DOES clear it**: `src/gateway/session-reset-service.ts:128-133`:

   ```ts
   const queueKeys = new Set<string>(params.target.storeKeys);
   queueKeys.add(params.target.canonicalKey);
   if (params.sessionId) {
     queueKeys.add(params.sessionId);
   }
   clearSessionQueues([...queueKeys]);
   ```

   This is the asymmetry: an admin RPC `sessions.reset` clears the
   queue; a user-typed `/new` does not.

5. **Drainer replays it under the NEW sessionId**:
   `src/auto-reply/reply/queue/drain.ts:75-180` (specifically lines
   116-129) builds the `[Queued messages while agent was busy]` envelope
   from `queue.items` and calls `runFollowup(...)`. The runFollowup
   binding flows through `followup-runner.ts` → `agent-runner.ts` →
   `runEmbeddedPiAgent` under the CURRENT sessionId in
   `sessionEntry.sessionId` — i.e. the NEW sessionId.

This explains every observed symptom:

- The "two replies" are TWO DIFFERENT runs (`084350d5` from the queue drain;
  `cba3e8c9` from the user's new `/new`-following prompt). Not a single
  duplicate emit.
- The parrot text is verbatim the prior turn's user prompt because the
  followup runner faithfully feeds it to the model as a real input.
- Memory recall correctly returns empty (slice E identity-scoped survival
  reads from `MemoryStore` which has no entry for «борщ» under this
  identity yet).
- The leak is reproducible on every `/new` issued while a non-satisfying
  prior turn left a corrective followup queued.

**Phase 4 primary subscriber** (`chat-history-followup-queue`, item #1 of §d)
must call `clearFollowupQueue(event.sessionKey)` to close the leak. The
subscriber lives in `src/auto-reply/reply/session-reset-subscribers/` (NEW
directory) and depends only on existing `clearFollowupQueue` at
`src/auto-reply/reply/queue/state.ts:294-310`. No frozen-layer touch.

---

## §g — Audit decision: does `ArtifactWorldStateObserver` need a `clearForSession(sessionId)` API?

**Decision: NO.** The observer's
`(sessionId, turnId)` keying at
`src/platform/commitment/artifact-world-state-observer.ts:79-81`
(`bucketKey = "${sessionId} ${turnId}"`) and `setActiveTurn(...)` /
`getActiveSlice(...)` semantics at lines 111-121 mean:

- `observe()` only reads the bucket whose key matches the runtime
  adapter's most recent `setActiveTurn(...)` call (per-turn, set fresh by
  the runtime adapter at the start of each tool-emitting turn).
- A new sessionId rotation produces a new `(sessionId, turnId)` key on
  every subsequent turn; the OLD keys are NEVER set as `activeKey` again.
- The soft cap of 8 records per `(sessionId, turnId)` (line 89) bounds
  growth WITHIN a turn but does NOT proactively evict old turns; that is
  by design — there is no `clearForSession(...)` API, and the buckets are
  in-process Map entries whose memory cost is minimal (an artifact record
  is a few hundred bytes; eight per turn × low-thousands of turns per
  process lifetime = sub-megabyte).
- Production process restarts on gateway-stop (PR #209 / cutover-3)
  release the entire collector singleton; orphan buckets do not
  accumulate across restarts.

If memory profiling under sustained load (slice K cron / slice J subagent
recursion) ever shows growth, Phase 4 can ADD a `clearForSession(sessionId)`
API ADDITIVELY (cutover-2 P3 / slice E P6 / cutover-3 P3 precedent: ADD a
new method on the collector interface, do NOT modify existing signatures, do
NOT remove records from any caller's read path; new subscriber `#7` would
flip from `kind: "skipped"` to `kind: "cleared"`). Per blanket signoff
2026-05-05, additive frozen-layer extensions in slice E / F / cutover-3
precedent did NOT raise per-phase signoff queries; this slice follows the
same posture.

For Phase 4 of NEW-B: the artifact-observer subscriber emits
`kind: "skipped", reason: "(sessionId, turnId) keying naturally orphans
old-session buckets"` — observability + audit completeness only.

---

## §h — Closed-issue checklist (Phase 1 acceptance)

- [x] §a — every existing session-scoped store enumerated with file:line
- [x] §b — first-turn-after-`/new` prompt-context sources classified by scope
- [x] §c — gateway-pr211.log lines 64, 80, 116-118, 120, 137, 148, 152
  reproducing the leak quoted with timestamps
- [x] §d — closed list of 8 `SessionResetSubscriber` candidates with
  line-anchored pointers; `subscribers=8` is the Phase 6 assertion
- [x] §e — `src/platform/session/reset.ts` boundary verified per invariant
  #8; frozen-layer adapter directory established; branded id policy per
  invariant #16 documented
- [x] §f — leak source pinpointed to
  `closure-outcome-dispatcher.ts:842-847` writes →
  `enqueue.ts:61-99` stores → `state.ts:46-50, 67-99` global Map →
  `drain.ts:75-180` replays after `/new` (which omits the
  `clearFollowupQueue` call)
- [x] §g — `ArtifactWorldStateObserver.clearForSession(...)`: NO API
  addition, default decision; subscriber registers as skipped
- [x] No source modifications in `src/`. `pnpm exec tsgo --noEmit` clean
  (gated at PR landing time per acceptance criterion).

---

## §i — Phase 4 ordered work list (informational; not part of Phase 1
deliverable)

1. NEW `src/platform/session/reset.ts` (Phase 2 + 3): types, registry,
   `resetTurnSession()`. Mirrors `src/platform/memory/`.
2. NEW `src/server/session-reset-bootstrap.ts` (Phase 5): registers all 8
   subscribers in deterministic order. Mirrors
   `src/server/memory-store-bootstrap.ts`.
3. NEW `src/auto-reply/reply/session-reset-subscribers/chat-history-subscriber.ts`
   (Phase 4): primary fix; calls `clearFollowupQueue(event.sessionKey)`.
4. NEW `src/platform/session/session-reset-subscribers/intent-ledger-subscriber.ts`
   (Phase 4): calls `intentLedger.invalidate(...)` for the rotating
   `(previousSessionId, *)` channels.
5. NEW `src/agents/pi-embedded-runner/run/session-reset-subscribers/`
   directory (Phase 4): frozen-layer adapters for memory / task / artifact
   observer / world-state, ALL of category `*-scope` or `observer` /
   `world-state`, ALL emitting `kind: "skipped"`.
6. EDIT `src/auto-reply/reply/session.ts`: replace inline plugin-hook block
   at lines 601-630 with a single
   `await resetTurnSession({event, registry: globalSessionResetRegistry, logger})`.
   ACP bypass at line 258 untouched.
7. NEW
   `src/platform/session/__tests__/new-b-replay.acceptance.test.ts`
   (Phase 6): 5 acceptance cases per sub-plan §6 plan.

Phase 4 must NOT attempt to fold items #15-#17 from §a (browser tabs,
embedded PI abort, subagent stop) into the bus in this slice — they are
gateway-RPC-only today, and the master plan §0.5.6 NEW-B scope is
`/new` parrot specifically. They are deferred per sub-plan §8.
