# AUDIT — PR-MT concurrent broker (Phase 1, read-only)

| Field | Value |
| --- | --- |
| Sub-plan | `.cursor/plans/commitment_kernel_pr_mt_concurrent_broker.plan.md` |
| Phase | 1 — Audit (read-only) |
| Predecessor | dev SHA `60b0d6a83a` (post PR-#294 — sub-plan landing) |
| Maintainer signoff | GRANTED via blanket authorization 2026-05-05 |
| Frozen-layer integrity | `src/platform/commitment/**` UNTOUCHED. 5 frozen contracts byte-identical. `src/platform/decision/run-turn-decision.ts` UNTOUCHED (consumer-only audit). |
| Output | This file. NO source changes. |

---

## 0. Summary

Phase 1 maps the surface for the PR-MT concurrent broker slice. Goal: prove
that today's process-scope dispatch path serializes turns at two layers
(`runTurnDecision` single async stack + `FOLLOWUP_QUEUES` per-key drain) and
that **no per-`(identityId, channelKey)` mutex / semaphore primitive exists
anywhere in `src/`**. The slice will introduce a NEW `src/platform/broker/`
module that wraps `runTurnDecision` dispatch with per-`(identityId, channelKey)`
FIFO admission, round-robin fairness across keys, and structured overflow
envelopes — sitting **above** the existing dispatch entry, **below** the
inbound-channel callers.

Findings index:
- (a) `runTurnDecision` has **2 production call sites** (`input.ts:586` + `input.ts:629`) and **2 internal-hook call sites** (`plugin.ts:80` + `plugin.ts:340`). Tests aside, these are the only entry points.
- (b) Two serial-points exist: process-global `FOLLOWUP_QUEUES` Map keyed by ad-hoc string + the implicit single-async-stack of `runTurnDecision` itself. `FOLLOWUP_QUEUES` provides per-key FIFO **but** the keys are NOT identity-aware (composite of `sessionKey/sessionId`).
- (c) Identity (`IdentityId`) is resolved **once per turn** at `memory-wiring.ts:171` and threaded into `RunTurnDecisionInput.identityId` (`run-turn-decision.ts:318`). It is **available at** the `agent-runner-execution.ts` chokepoint via `params.sessionKey` (line 109 / 164) — confirmed in scope at the wiring site.
- (d) **Zero** Mutex / Semaphore / asyncLock primitives anywhere in `src/`. Confirmed via Grep — no third-party concurrency primitives imported either. Today's only locking is the implicit `draining: boolean` flag on `FollowupQueueState` (`state.ts:20`) + `inFlight` is unused (it doesn't exist yet).
- (e) Operator-impact estimate: **no current observability surface** on queue depth or dispatch wait. Recent gateway logs (`gateway-pr211.log`, 1088 lines, 2026-05-06) emit zero `queueKey` / `[reply]` / `[agent-runner]` lines. Estimate must be inferred from architecture (see §5).
- (f) Gap list with 17 concrete missing pieces for Phases 2-7.
- (g) NEW invariant: «no `runTurnDecision` invocation from production channel callers without going through `dispatchTurnViaBroker(...)`». Lint-guard test name proposed: `lint:broker:no-bypass-runTurnDecision-from-channel-callers`.
- (h) **Confirmed** wiring decision: Phase 5 wraps at `agent-runner-execution.ts` + `agent-runner.ts:queueEmbeddedPiMessage` (NOT `plugin.ts`). Rationale below.

---

## 1. (a) Dispatch entry path — `runTurnDecision` callers

`runTurnDecision` is exported from `src/platform/decision/run-turn-decision.ts:445`
(signature: `(input: RunTurnDecisionInput): Promise<RunTurnDecisionResult>`).
Production call sites with caller context:

### 1.1 PRODUCTION channel callers (in scope for v1 wiring)

**Site #1 — primary classifier dispatch:** `src/platform/decision/input.ts:586`

Caller: `buildClassifiedExecutionDecisionInput(...)` — the canonical platform
entry from inbound-channel turns. Reached via:
```
agent-runner.ts:runReplyAgent
  → agent-runner-execution.ts:runAgentTurnWithFallback (line 87)
  → resolveRoutingSnapshotForTemplateRun (agent-runner-utils.ts:278)
  → buildClassifiedExecutionDecisionInput (agent-runner-utils.ts:296)
  → runTurnDecision (input.ts:586)
```
Context fields available: `params.sessionEntry.sessionId` (line 508,
`ledgerSessionId`), `params.channelHints` (resolves `ledgerChannelId` at
line 509), `params.sessionKey` (line 473) — `sessionKey` resolves
`identityId` via `memory-wiring.ts:resolveMemoryWiringForTurn` (line 580).

**Site #2 — workspace re-classification:** `src/platform/decision/input.ts:629`

Caller: same `buildClassifiedExecutionDecisionInput` — second
`runTurnDecision` call when `shouldInjectWorkspaceContext(...)` returns true
and a workspace snapshot is produced. Reuses identical session/channel
identity context as Site #1 (no fresh resolution). Context: same as #1.

### 1.2 INTERNAL plugin callers (OUT OF SCOPE for v1)

**Site #3 — plugin hook context resolver:** `src/platform/plugin.ts:80`

Caller: `resolveHookExecution(prompt, ctx)` — single-shot internal hook
invoked from plugin loaders to build a `PlatformExecutionContext` for tool
execution. Has `apiConfigRef.current` only; **no** `sessionKey`, **no**
`channelHints`, **no** `sessionEntry`. Per sub-plan §0 line 44, this caller
has no `(sessionId, channelId)` lifecycle and is deferred to v2.

**Site #4 — machine-control fallback decision:** `src/platform/plugin.ts:340`

Caller: machine-control tool gate hook. Same shape as Site #3 — no session
lifecycle context. OUT OF SCOPE v1.

### 1.3 Test call sites (irrelevant for wiring; counted for completeness)

22 test files invoke `runTurnDecision` directly:
`src/platform/task/b7-replay.acceptance.test.ts`,
`src/platform/reminder/__tests__/slice-k-reminder.acceptance.test.ts`,
`src/platform/reminder/__tests__/cron-scheduler.acceptance.test.ts`,
`src/platform/memory/b1-replay.acceptance.test.ts`,
`src/platform/decision/run-turn-decision.{task-recall,retry-policy,role-policy,cutover4,escalation-hook,cutover4-policy-gate,budget-policy,cutover2,cutover3,approval-policy,cutover1,clarification-downgrade}.test.ts`,
`src/platform/decision/run-turn-decision.test.ts`,
`src/platform/commitment/__tests__/policy-gate-full.acceptance.test.ts`,
`src/platform/commitment/__tests__/cutover4-repo-operation.acceptance.test.ts`,
`src/platform/commitment/__tests__/cutover3-artifacts.acceptance.test.ts`,
`src/platform/commitment/__tests__/cutover4-policy-gate-acceptance.test.ts`,
`src/platform/commitment/__tests__/cron-scheduler-policy-gate-acceptance.test.ts`.

Tests bypass the broker by design — they exercise `runTurnDecision`
directly, not the broker wrapper. Phase 5 acceptance must cover the
"broker-undefined byte-identical" reverse path so tests stay green
unchanged.

---

## 2. (b) Existing serial points

### 2.1 `FOLLOWUP_QUEUES` — process-global Map keyed by ad-hoc string

**File:** `src/auto-reply/reply/queue/state.ts:50`

```ts
export const FOLLOWUP_QUEUES = resolveGlobalMap<string, FollowupQueueState>(FOLLOWUP_QUEUES_KEY);
```

- **Shape:** `Map<string, FollowupQueueState>` shared via process-global
  `Symbol.for("openclaw.followupQueues")` (line 46) — survives bundle-chunk
  duplication.
- **Locking semantics:** `FollowupQueueState.draining: boolean` (line 20)
  acts as a non-reentrant "is this queue currently drained" flag. Set true
  in `beginQueueDrain(...)` (called from `drain.ts:75`) and back to false
  in the `finally` block at `drain.ts:175`. **No mutex** — just a boolean
  guard.
- **Identity-awareness:** **NONE.** Keys are constructed by callers as
  ad-hoc strings, e.g. `get-reply-run.ts:494`:
  ```ts
  const queueKey = sessionKey ?? sessionIdFinal;
  ```
  Or `commands-status.ts:116`:
  ```ts
  const queueKey = sessionKey ?? sessionEntry?.sessionId;
  ```
  Identity is **implicit** in `sessionKey` (which encodes the
  `(channel, account, chat)` tuple via `resolveGroupSessionKey`) but the
  queue map itself does NOT enforce or extract `IdentityId`.

### 2.2 `kickFollowupDrainIfIdle` — drain restart on enqueue

**File:** `src/auto-reply/reply/queue/drain.ts:30`

Restarts a drain for `key` when it is currently idle (no `draining` flag,
no items being processed) using a stored callback. Cached callback set in
`scheduleFollowupDrain` (`drain.ts:81`). Identity-blind.

### 2.3 `scheduleFollowupDrain` — drain implementation

**File:** `src/auto-reply/reply/queue/drain.ts:71-184`

Implements the actual serial drain loop. Lines 82-183: an `async () => { … }`
IIFE that, while `queue.items.length > 0 || queue.droppedCount > 0`:
- waits for queue debounce (`waitForQueueDebounce`, line 86),
- in `collect` mode, batches items via `drainCollectQueueStep` (line 96),
- otherwise drains one item at a time via `drainNextQueueItem` (line 165),
- in the `finally` block (line 174), clears `draining` and recursively
  reschedules if items remain (line 179).

**Critical:** `runFollowup` (the dispatch closure) is awaited inside the
loop. **All drain work for a given key is single-threaded.** This is the
intended FIFO discipline within a key — but it also blocks any other key's
drain on the same async stack until the current `await` yields.

### 2.4 `piEmbeddedQueueRuntimePromise` — singleton runtime

**File:** `src/auto-reply/reply/agent-runner.ts:94-96`

```ts
let piEmbeddedQueueRuntimePromise: Promise<
  typeof import("../../agents/pi-embedded-queue.runtime.js")
> | null = null;
```

Dynamic-import singleton resolved by `loadPiEmbeddedQueueRuntime()`
(line 103-106). Used at `agent-runner.ts:719` to access
`queueEmbeddedPiMessage(sessionId, prompt)` — see §3 below.

### 2.5 `enqueueFollowupRun` — enqueue surface

**File:** `src/auto-reply/reply/queue/enqueue.ts:61`

Signature:
```ts
export function enqueueFollowupRun(
  key: string,
  run: FollowupRun,
  settings: QueueSettings,
  dedupeMode: QueueDedupeMode = "message-id",
): boolean
```

- Resolves queue via `getFollowupQueue(key, settings)` (line 67).
- Builds dedupe key via `buildRecentMessageIdKey(run, key)` (line 68 + 22-38).
- Pushes to `queue.items` (line 96) and calls `kickFollowupDrainIfIdle(key)`
  if not currently draining (line 105).
- **Identity-blind** — the `key` argument is opaque; identity not extracted
  for placement decisions.

### 2.6 `buildRecentMessageIdKey` — current ad-hoc dedupe key

**File:** `src/auto-reply/reply/queue/enqueue.ts:22-38`

```ts
return JSON.stringify([
  "queue",
  queueKey,
  run.originatingChannel ?? "",
  run.originatingTo ?? "",
  run.originatingAccountId ?? "",
  run.originatingThreadId == null ? "" : String(run.originatingThreadId),
  messageId,
]);
```

This is the **stable JSON-tuple serialization precedent** the sub-plan
§3 references. Phase 2's `BrokerQueueKey` will use the same shape minus
`messageId` and plus `identityId`:
```
JSON.stringify([identityId, originatingChannel, originatingTo, originatingAccountId, originatingThreadId])
```

### 2.7 Cross-channel routing helper (drain-side)

**File:** `src/auto-reply/reply/queue/drain.ts:55-69` — `resolveCrossChannelKey`

```ts
key: [channel, to, accountId || "", threadKey].join("|"),
```

Pipe-delimited string; not identity-aware. Used internally by drain to
detect cross-channel batches. Documented here as additional precedent for
the channel-tuple shape.

---

## 3. (c) Identity / channel resolution surfaces

### 3.1 `originatingChannel` + `originatingTo` + `originatingAccountId` + `originatingThreadId` tuple in `FollowupRun`

**File:** `src/auto-reply/reply/queue/types.ts:54-63`

```ts
originatingChannel?: OriginatingChannelType;
originatingTo?: string;
originatingAccountId?: string;
originatingThreadId?: string | number;
originatingChatType?: string;  // not part of broker key
```

Populated at `get-reply-run.ts:529-532`:
```ts
originatingChannel: ctx.OriginatingChannel,
originatingTo: ctx.OriginatingTo,
originatingAccountId: ctx.AccountId,
originatingThreadId: ctx.MessageThreadId,
```

Threaded forward through `FollowupRun` into `agent-runner.runReplyAgent`
(receives `followupRun: FollowupRun`) and on into
`agent-runner-execution.ts:runAgentTurnWithFallback` via
`params.followupRun: FollowupRun` (line 89).

**Conclusion:** the four-field channel tuple is **fully in scope** at the
Phase-5 wiring site (`agent-runner-execution.ts`). No additional plumbing
required.

### 3.2 `ledgerSessionId` / `ledgerChannelId` in `input.ts`

**File:** `src/platform/decision/input.ts:508-509`

```ts
const ledgerSessionId = params.sessionEntry?.sessionId?.trim();
const ledgerChannelId = resolveIntentLedgerChannelId(params.channelHints);
```

These derive a `(sessionId, channelId)` pair used for intent-ledger
peeks and identity injection (lines 511-575). They are NOT directly the
broker queue key — but they confirm that at the `runTurnDecision` call
site the routing identity is already resolved.

`resolveIntentLedgerChannelId` derives a normalized channel-id string
from `channelHints.replyChannel | channel | messageChannel` (downstream
of `resolveOriginMessageProvider`).

### 3.3 `IdentityId` resolution — `resolveIdentityFromSessionKey`

**File:** `src/platform/identity/resolve-identity.ts` (consumer-side)

Called at:
- `src/platform/decision/memory-wiring.ts:171` — production wiring call
  inside `resolveMemoryWiringForTurn(...)`. Returns `identityId | undefined`
  (anonymous fallback).
- `src/auto-reply/reply/agent-runner-execution.ts:171` — line is
  unrelated (web-evidence prefetch flag); the actual reference to identity
  arrives via `RunTurnDecisionInput.identityId` populated by the spread of
  `memoryWiring` at `input.ts:599` (`...memoryWiring`).

**`RunTurnDecisionInput.identityId`** type definition is at
`src/platform/decision/run-turn-decision.ts:318`:
```ts
readonly identityId?: IdentityId;
```

Threaded into role-policy (`run-turn-decision.ts:1159`), retry-policy
(`:1272`), escalation-hook (`:1363`), budget-policy (`:982`, `:1053`),
and contractor (`:653`).

**Identity availability at Phase-5 wiring sites:**

- `agent-runner-execution.ts:runAgentTurnWithFallback` — has
  `params.sessionKey` (line 109) and `params.followupRun.run.config`
  (cfg). Identity can be resolved by calling
  `resolveIdentityFromSessionKey(sessionKey, runtime.identityRegistry)`
  on entry — same call already performed inside `resolveMemoryWiringForTurn`
  later in the chain. **In scope.**
- `agent-runner.ts:queueEmbeddedPiMessage` (line 719-720) — the steer
  path. Has `followupRun.run.sessionId` (line 720). Identity resolution
  needs the same lookup. **In scope.**

### 3.4 Identity flow — caller-down summary

```
inbound webhook (telegram/discord/etc)
  → ctx.OriginatingChannel/OriginatingTo/AccountId/MessageThreadId
  → followupRun (queue/types.ts:38, 4 fields populated)
  → agent-runner.runReplyAgent
  → agent-runner-execution.runAgentTurnWithFallback (followupRun in scope)
  → routingSnapshot.runtimePlan
  → buildClassifiedExecutionDecisionInput (input.ts via resolveRoutingSnapshotForTemplateRun)
    → resolveMemoryWiringForTurn (input.ts:580)
      → resolveIdentityFromSessionKey (memory-wiring.ts:171)
      → returns { memoryStore, identityId, memoryLogger, taskLedger, onAttestation }
    → runTurnDecision({ ...memoryWiring, ledgerContext, classifierInput, ... })
      ↑ identity reaches the kernel here, BEFORE production decision
```

The broker MUST insert above `runTurnDecision`. The identity is available
**before** Phase 5's `dispatchTurnViaBroker` would be invoked, since the
broker needs the queue key resolved at submit time, which is **before** the
`runTurnDecision`-caller closure runs.

---

## 4. (d) Confirm absence of per-`(identity, channel)` mutex

**Confirmed.** Grep for `Mutex` / `Semaphore` / `\bLock\b` / `asyncLock` /
`p-queue` against `src/` returns **zero matches**. The only "locking"
primitive in the path is:

- `FollowupQueueState.draining: boolean` (`state.ts:20`) — a non-reentrant
  flag, not a mutex. Same-key concurrent enqueues do NOT acquire a lock;
  they push to `queue.items` and rely on the drain loop's awaits to
  serialize execution.
- `inFlight` mentioned in the sub-plan §3 is **not yet present** anywhere
  in source — it will be introduced in Phase 4 as a `Set<BrokerQueueKey>`
  on the broker singleton.
- Process-global Maps (`FOLLOWUP_QUEUES`, `RECENT_QUEUE_MESSAGE_IDS`,
  `ACTIVE_EMBEDDED_RUNS`, `EMBEDDED_RUN_WAITERS`) provide concurrent
  read/write semantics via JavaScript's single-threaded event loop, NOT
  via mutex.

**Implication for Phase 4:** the broker's per-`(identityId, channelKey)`
FIFO does NOT need an OS-level mutex either. The `inFlight: Set` flag plus
JavaScript's single-threaded event loop is sufficient — same precedent as
`draining: boolean` today. This was the architectural assumption baked
into the sub-plan §3 already; this audit confirms it holds.

---

## 5. (e) Operator-impact estimate

### 5.1 Log scrape — 7-day window

Local log files in working dir (root checkout):
`gateway-pr211.log` (1088 lines, 2026-05-06 18:18:06 — 2026-05-06 19:35:23)
+ `gateway-dev-final.log` (228 lines)
+ `gateway-pr145.log` (1477 lines)
+ ~30 prior-slice gateway-*.log files.

**Grep results:**

| Pattern | matches in `gateway-pr211.log` | matches in `gateway-pr145.log` |
| --- | --- | --- |
| `queueKey` | 0 | 0 |
| `\[reply\]` | 0 | 0 |
| `\[agent-runner\]` | 0 | 0 |
| `followup\|queue\|drain` | 7 (incidental, not telemetry) | n/a |

**Conclusion:** today's path emits **no telemetry** on queue depth, dispatch
wait, or distinct queueKey count. The slice's success metric (broker
fairness + parallelism observability) requires the broker itself to emit
the four `[broker] enqueued|dispatch|complete|rejected` lines (Phase 4
deliverable per sub-plan §7 line 157-162).

### 5.2 Concurrency ceiling estimate

Without telemetry, ceiling is inferred from architecture:

- **Today (sub-plan §1 root-cause):** turn-B from identity B blocks behind
  turn-A from identity A entirely — single async stack inside
  `runTurnDecision`'s `await` of `IntentContractor.classify` (LLM call,
  typically 1-3s) + planner + outbound delivery. Wallclock ceiling for
  turn-B = turn-A latency + own latency.
- **Observed user-reported case (sub-plan §1):** two operators in two
  Telegram chats, 1-second window. Today: ~3-6s effective serialization.
  Post-broker target: ~own latency only (parallelism observable via
  overlapping `[broker] dispatch` timestamps).
- **Process-headroom estimate:** with `maxConcurrentKeys=32` (default), the
  broker can run 32 distinct `(identityId, channelKey)` pairs in parallel.
  Realistic active-key count for current single-process gateway:
  3-5 distinct identities × 1-3 chats each = ~10-15 keys peak. 32 cap
  provides comfortable headroom.

### 5.3 Median wait time (current)

Cannot be measured directly — no telemetry. From event-loop analysis:
expected median wait for a same-process concurrent turn is approximately
the median `runTurnDecision` duration of the prior turn, which is
dominated by the LLM classifier call. From `gateway-pr211.log` line
2026-05-06T18:21:35.445 → 18:21:39.077 (`classified` log frame), the
classifier call alone is ~3.6s. So the median pre-broker wait under load
is on the order of **2-4 seconds per concurrent turn**.

Phase 7's live-verify runbook (sub-plan §8) is the canonical source of
truth — it asserts overlap (not strict serialization) of three concurrent
identity-distinct turns.

---

## 6. (f) Concrete missing pieces for Phases 2-7

### Phase 2 (Types + schemas)
- [ ] `BrokerQueueKey` brand type — `string & { readonly [BrokerQueueKeyBrand]: true }`. Format: `${identityId}::${JSON-tuple-channelKey}`.
- [ ] `BrokerEntry` type — `{ turnId, queueKey, enqueuedAtMs, runTurn: () => Promise<void> }`.
- [ ] `BrokerCapacityConfig` type with optional fields and Zod-derived defaults: `maxQueueDepthPerKey=8`, `maxConcurrentKeys=32`, `queueWaitTimeoutMs=120_000`, `fairnessMode='round_robin'`.
- [ ] `BrokerCapacityConfigSchema.strict()` — Zod schema rejecting unknown keys + negative/zero positive integers + unknown fairnessMode.
- [ ] `BrokerOverflowReason` closed reason set — `'queue_depth_exceeded' | 'wait_timeout' | 'broker_shutdown'`.
- [ ] `BrokerRejectedTurnEnvelope` — `{ kind:'broker_overflow', reason, queueKey, retryAfterMs? }`.
- [ ] Brand-discipline test: assigning raw string to `BrokerQueueKey` MUST fail typecheck.

### Phase 3 (Pure helper)
- [ ] `decideQueuePlacement(params): BrokerPlacement` with `BrokerPlacement = {kind:'admit', queueDepth} | {kind:'reject', reason}`.
- [ ] Round-robin policy via `state.lastServedKey` + `state.keyOrder`.
- [ ] Clock injection — `nowMs: number` parameter (no `Date.now()` inside helper).
- [ ] Input non-mutation invariant — Object.freeze test.

### Phase 4 (Broker implementation)
- [ ] `src/platform/broker/concurrent-turn-broker.ts` — process-scoped singleton via `resolveGlobalSingleton(Symbol.for("openclaw.concurrentTurnBroker"))` (mirrors `pi-embedded-runner/runs.ts:30` precedent).
- [ ] Per-key FIFO `Map<BrokerQueueKey, BrokerEntry[]>`.
- [ ] `keyOrder: BrokerQueueKey[]` round-robin cursor + `lastServedKey`.
- [ ] `inFlight: Set<BrokerQueueKey>` bounded by `maxConcurrentKeys`.
- [ ] Public surface: `submit(entry): Promise<BrokerSubmitResult>`, `getQueueDepth(queueKey)`, `getActiveKeys()`, `shutdown(): Promise<void>`.
- [ ] Telemetry — `[broker] enqueued|dispatch|complete|rejected|shutdown` lines.

### Phase 5 (Wiring)
- [ ] `dispatchTurnViaBroker(entry, broker)` helper — resolves `BrokerQueueKey` from `(identityId, originatingChannel, originatingTo, originatingAccountId, originatingThreadId)` via stable JSON-tuple serialization.
- [ ] Wire at `src/auto-reply/reply/agent-runner-execution.ts:runAgentTurnWithFallback` (NEW await-broker.submit before invoking the existing chain).
- [ ] Wire at `src/auto-reply/reply/agent-runner.ts:719` `queueEmbeddedPiMessage` steer path — currently bypasses the broker entirely; needs identical wrapper.
- [ ] Identity resolution at the wiring site — `resolveIdentityFromSessionKey(sessionKey, runtime.identityRegistry)` — already callable, see §3.3.
- [ ] Plugin.ts callers (`plugin.ts:80` + `:340`) — explicit byte-identical bypass (no broker submit).

### Phase 6 (Backpressure + reverse-defense)
- [ ] Channel-side overflow translation — inbound-channel reply path receives `BrokerRejectedTurnEnvelope` and surfaces user-facing reply with retry hint.
- [ ] Shutdown semantics — `broker.shutdown()` drains in-flight, rejects new submits with `broker_shutdown`.
- [ ] Capacity-0 reverse — `maxQueueDepthPerKey=0` rejects all immediately.

### Phase 7 (Acceptance + runbook)
- [ ] `src/platform/broker/__tests__/concurrent-turn-broker.acceptance.test.ts` — 6 cases (3-identity parallel timing, same-key FIFO, round-robin fairness, overflow envelope, broker-disabled regression, shutdown drained log).
- [ ] `extensions/RUNBOOK-pr-mt-concurrent-broker.md` — live-verifier runbook.
- [ ] Master plan §0 PR Progress Log row + §16 PR-MT row — slice CLOSED.

---

## 7. (g) NEW structural invariant — broker bypass guard

### 7.1 Formulation

> **Invariant (Phase 5+):** No `runTurnDecision(...)` invocation from a
> production channel caller (`src/auto-reply/reply/**`) MAY occur outside
> `dispatchTurnViaBroker(...)`. The two `plugin.ts` internal callers are
> the only sanctioned exceptions and MUST carry an explicit
> `// broker-bypass: plugin internal hook — see PR-MT Phase 5 audit §1.2`
> comment.

### 7.2 Lint-guard test

**Test name:** `lint:broker:no-bypass-runTurnDecision-from-channel-callers`

**Scope:** scan `src/auto-reply/**` and `src/agents/pi-embedded-runner/**`
for any direct call to `runTurnDecision(`. Every match outside an
explicitly comment-tagged exception block must be a route through
`dispatchTurnViaBroker`. Implementation hint: ts-morph traversal mirrors
the existing `lint:routing:no-prompt-parsing` precedent (sub-plan §3).
Suggested location: `src/platform/broker/__tests__/lint-broker-bypass-guard.test.ts`.

**Allowed exceptions today (Phase 5):** none — channel callers reach
`runTurnDecision` only transitively through `input.ts:586` + `:629`,
which are themselves wrapped by the broker at the
`buildClassifiedExecutionDecisionInput` ingress. Direct `runTurnDecision(`
call inside `src/auto-reply/**` would be a regression.

**Allowed exceptions explicitly:** `src/platform/plugin.ts:80` + `:340`
(out-of-scope for v1).

---

## 8. (h) Phase 5 wiring decision — confirmed

The sub-plan §3 line 111 + §4 Phase 5 propose wiring at
`agent-runner-execution.ts` + `queueEmbeddedPiMessage`. **This audit
confirms** that recommendation. Rationale:

### 8.1 Why NOT wire at `runTurnDecision` itself

- `runTurnDecision` has 22 test call sites (§1.3). Wrapping at the kernel
  level would force every test to thread broker state, breaking the
  byte-identical regression discipline (sub-plan §7 reverse leg).
- The kernel layer (`src/platform/decision/`) is a NEAR-frozen surface
  per invariant #11. Wiring there would expand kernel coupling.

### 8.2 Why NOT wire at `input.ts:586` / `:629`

- `buildClassifiedExecutionDecisionInput` is also called from
  `agent-runner-utils.ts:resolveRoutingSnapshotForTemplateRun` for
  routing-snapshot resolution, which itself is called outside the actual
  turn dispatch (e.g. for snapshot peek paths). Wrapping here would over-broker.
- The `runTurnDecision` calls inside `input.ts` are intra-turn (line 586
  is the primary, line 629 is the workspace re-classification on the same
  turn). Wrapping the outer per-turn call site is sufficient.

### 8.3 Why YES at `agent-runner-execution.ts` + `queueEmbeddedPiMessage`

- **Single chokepoint:** every inbound-channel turn flows through
  `agent-runner.runReplyAgent` → either `runAgentTurnWithFallback`
  (cold-start / new turn) or `queueEmbeddedPiMessage` (steer / mid-stream
  injection). All other paths are tests or internal hooks.
- **Identity in scope:** `params.sessionKey` (line 109) +
  `params.followupRun.run.config` (cfg) — `resolveIdentityFromSessionKey`
  is callable here without re-resolving session state.
- **Channel tuple in scope:** `params.followupRun.{originatingChannel,
  originatingTo, originatingAccountId, originatingThreadId}` — all four
  fields populated upstream in `get-reply-run.ts:529-532`.
- **No frozen-layer touch:** the wrapper lives in `src/platform/broker/`
  + a thin call-site wiring inside `src/auto-reply/reply/`. Frozen
  contracts (5) untouched.
- **Same-channel FIFO preserved:** wrapping at this site, with queueKey
  derived from `(identityId, channelTuple)`, preserves same-`(identity,
  channel)` ordering — turn-2 enqueues behind turn-1 in the same key's
  FIFO list, just as today's `FOLLOWUP_QUEUES` does.

### 8.4 Plugin callers — explicit deferral

`plugin.ts:80` + `:340` lack `(sessionId, channelId)` lifecycle context
(no `sessionKey`, no `channelHints`, no `sessionEntry`). They are
single-shot internal hooks with no concurrent-turn pressure. Wrapping
them in v1 would require synthesizing a fake identity/channel pair,
which violates invariant #2 (structural id, not text-derived). Deferred
to v2 per sub-plan §10.

---

## 9. Frozen-layer integrity check

Per invariant #11 and sub-plan §2:
- `src/platform/commitment/**` — UNTOUCHED in audit. Verified via Grep
  scope — no findings reference any file under `commitment/`.
- 5 frozen contracts (`TaskContract`, `OutcomeContract`,
  `QualificationExecutionContract`, `ResolutionContract`,
  `RecipeRoutingHints`) — BYTE-IDENTICAL. Audit references them only
  for context; no schema extension proposed.
- `src/platform/decision/run-turn-decision.ts` — UNTOUCHED. Audit reads
  the file (lines 50-100, 300-340, 586, 629) for caller-context only.
  Phase 5 wraps the **callers** of `runTurnDecision`, not the function
  itself.
- `IntentContractor` ordering semantics — UNTOUCHED. Broker is oblivious
  to turn content; queueKey is derived from routing metadata only.

---

## 10. References

- Sub-plan: `.cursor/plans/commitment_kernel_pr_mt_concurrent_broker.plan.md`
- Hard invariants: `.cursor/rules/commitment-kernel-invariants.mdc`
- Master plan: `.cursor/plans/commitment_kernel_v1_master.plan.md` §0 PR Progress Log line 70
- Precedent — process-scoped singletons:
  - `src/platform/commitment/delivery-receipt-registry.ts:1-35`
  - `src/agents/pi-embedded-runner/runs.ts:30-39` (`resolveGlobalSingleton`)
  - `src/auto-reply/reply/queue/state.ts:46-50` (`resolveGlobalMap`)
- Precedent — JSON-tuple stable serialization:
  - `src/auto-reply/reply/queue/enqueue.ts:22-38` (`buildRecentMessageIdKey`)
- Precedent — clock-injectable pure policy:
  - `src/platform/commitment/budget-policy.ts` (`evaluateBudgetPolicy`, `now: () => number`)
- IntentContractor freshness sub-plan (sister, recently CLOSED) — shape reference for Phase 4 broker-impl test ergonomics.

---

## Appendix A — Verified file:line references

| Reference | File | Line(s) |
| --- | --- | --- |
| `runTurnDecision` definition | `src/platform/decision/run-turn-decision.ts` | 445 |
| `RunTurnDecisionInput.identityId` | `src/platform/decision/run-turn-decision.ts` | 318 |
| `runTurnDecision` site #1 (production) | `src/platform/decision/input.ts` | 586 |
| `runTurnDecision` site #2 (workspace re-class) | `src/platform/decision/input.ts` | 629 |
| `runTurnDecision` site #3 (plugin hook) | `src/platform/plugin.ts` | 80 |
| `runTurnDecision` site #4 (machine-control) | `src/platform/plugin.ts` | 340 |
| `FOLLOWUP_QUEUES` Map | `src/auto-reply/reply/queue/state.ts` | 50 |
| `FollowupQueueState.draining` | `src/auto-reply/reply/queue/state.ts` | 20 |
| `kickFollowupDrainIfIdle` | `src/auto-reply/reply/queue/drain.ts` | 30 |
| `scheduleFollowupDrain` | `src/auto-reply/reply/queue/drain.ts` | 71 |
| `piEmbeddedQueueRuntimePromise` | `src/auto-reply/reply/agent-runner.ts` | 94-96 |
| `queueEmbeddedPiMessage` call site | `src/auto-reply/reply/agent-runner.ts` | 719-720 |
| `enqueueFollowupRun` | `src/auto-reply/reply/queue/enqueue.ts` | 61 |
| `buildRecentMessageIdKey` | `src/auto-reply/reply/queue/enqueue.ts` | 22-38 |
| `FollowupRun` channel tuple fields | `src/auto-reply/reply/queue/types.ts` | 54-63 |
| `FollowupRun` originating tuple population | `src/auto-reply/reply/get-reply-run.ts` | 529-532 |
| `ledgerSessionId` / `ledgerChannelId` | `src/platform/decision/input.ts` | 508-509 |
| `resolveMemoryWiringForTurn` call | `src/platform/decision/input.ts` | 580 |
| `resolveIdentityFromSessionKey` (memory wiring) | `src/platform/decision/memory-wiring.ts` | 171 |
| `runAgentTurnWithFallback` (Phase 5 wiring site) | `src/auto-reply/reply/agent-runner-execution.ts` | 87 |
| `agent-runner-execution` `params.sessionKey` | `src/auto-reply/reply/agent-runner-execution.ts` | 109 |
| `queueEmbeddedPiMessage` definition | `src/agents/pi-embedded-runner/runs.ts` | 41 |
| `delivery-receipt-registry` precedent | `src/platform/commitment/delivery-receipt-registry.ts` | 1-35 |

---

*End of audit. NO source changes. 5 frozen contracts byte-identical.
Ready for Phase 2 (types + schemas).*
