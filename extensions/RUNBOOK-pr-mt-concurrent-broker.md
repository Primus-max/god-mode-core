# RUNBOOK — PR-MT concurrent broker live-verify

| Field | Value |
| --- | --- |
| Sub-plan | `.cursor/plans/commitment_kernel_pr_mt_concurrent_broker.plan.md` |
| Phase | 7 — Acceptance + live-verify runbook + sub-plan flip + master plan entry |
| Slice | `pr-mt-concurrent-broker` |
| Maintainer signoff | GRANTED via blanket authorization 2026-05-05 |
| Operator | Vladimir (Telegram chat `6533456892`) |

This runbook is the operator script for the live-verify gate sub-plan
§1 todo `pr-mt-phase-7-acceptance` and §8 require to close the PR-MT
slice. It is NOT a test the agent runs. Vladimir runs it on the dev
gateway and records the captured `[broker] *` log lines as evidence.
The structural assertion is on the per-`(identityId, channelKey)` FIFO
+ cross-key concurrency log surface emitted by the broker
(`src/platform/broker/concurrent-turn-broker.ts:113-271`); the
operator-side observable is that turns from different operator
identities (or the same operator across two Telegram accounts) reply
with overlapping wallclock — not strict serial.

The agent has shipped (Phases 1–6):

- Phase 1 audit (`extensions/AUDIT-pr-mt-concurrent-broker.md`).
- Phase 2 types (`src/platform/broker/broker-types.ts` —
  `BrokerQueueKey` brand + `BrokerEntry` + `BrokerCapacityConfig` +
  Zod schema + closed `BROKER_OVERFLOW_REASONS`).
- Phase 3 pure helpers (`src/platform/broker/decide-queue-placement.ts`
  — `decideQueuePlacement` + `decideNextDispatch` round-robin).
- Phase 4 broker runtime
  (`src/platform/broker/concurrent-turn-broker.ts` —
  `createConcurrentTurnBroker` factory; per-key FIFO + bounded
  `inFlight` set + structured `[broker] *` telemetry + structured
  envelope on every reject path; never throws — invariant #15).
- Phase 5 wiring helper (`src/auto-reply/reply/dispatch-turn-via-broker.ts`)
  + integration at `src/auto-reply/reply/agent-runner-execution.ts:186-246`
  (broker resolved via process-scoped bootstrap; bypass byte-identical
  to pre-broker dispatch).
- Phase 6 backpressure envelope
  (`src/auto-reply/reply/format-broker-overflow-reply.ts`) +
  production bootstrap binder
  (`src/server/concurrent-turn-broker-bootstrap.ts`); broker NOW LIVE
  in production.

This runbook closes the loop by exercising the end-to-end concurrent
dispatch path with REAL operator input on a dev gateway, capturing the
required structural log lines for three identity-distinct turns plus
a same-identity FIFO check plus a synthetic backpressure scenario, and
confirming behaviour matches the closed Phase 4 contract.

---

## §1 Pre-conditions

1. Dev gateway HARD-RESTARTED from the merged successor of
   `feat/v1-pr-mt-phase-7-acceptance-runbook` on `dev`. The bootstrap
   binder
   (`src/server/concurrent-turn-broker-bootstrap.ts`)
   wires the broker singleton at gateway startup
   (`src/gateway/server-startup.ts:31`); that wiring runs once at
   boot, so a hot-reload IS NOT sufficient — a hard restart is
   required. Confirm:
   ```
   git -C ~/source/repos/god-mode-core rev-parse HEAD
   ```
   The gateway boot banner should also show
   `god-mode-core ... commit=<sha>`.
2. Identity `identity:vladimir` registered with the Telegram chat,
   AND a second Telegram account/identity (e.g.
   `identity:vladimir-secondary`) ALSO registered. If a second
   operator identity is unavailable, coordinate with a co-tester
   sending from a separate operator account. Confirm via
   `~/.openclaw/openclaw.json:identities.*` (READ-only — do NOT
   overwrite this file; per memory rule «never overwrite
   ~/.openclaw/openclaw.json without backup»).
3. `~/.openclaw/openclaw.json` UNTOUCHED. The PR-MT slice ships
   safe defaults (Phase 2 — `maxQueueDepthPerKey=8`,
   `maxConcurrentKeys=32`, `queueWaitTimeoutMs=120_000`,
   `fairnessMode=round_robin`) and does NOT require any new config
   key for the §2 base scenario. The §4 backpressure synthetic check
   describes a temporary opt-in override.
4. Gateway started in foreground with stdout captured to a fresh log
   file (e.g. `gateway-pr-mt-live-verify.log`) so the
   `[concurrent-turn-broker-bootstrap] bound ...` startup line plus
   the per-turn `[broker] *` log lines below can be greped reliably.
5. The Phase 4 broker logger maps `info` and `debug` levels onto the
   gateway's runtime logger surface. `[broker] enqueued ...` is
   emitted at `debug` (so a `debug`-suppressing prod logger may hide
   it); `[broker] dispatch | complete | rejected | shutdown` are at
   `info`. To capture the full log surface, bump the
   `agent/embedded` subsystem level to `debug` in
   `~/.openclaw/openclaw.json` (READ-only — verify before edit).

---

## §2 Three identity-distinct turns within 1s window (CORE acceptance)

Send three Telegram turns from THREE DIFFERENT identities (or two
operator accounts plus one co-tester) to THREE DIFFERENT chats —
within a 1s submission window. The broker MUST schedule them to
START concurrently, with overlapping wallclock between
`[broker] dispatch ...` and `[broker] complete ...` log lines.

### §2.1 Turn shape (each operator)

Any prompt that takes a non-trivial wallclock to respond (a
classifier-LLM-bound chit-chat is sufficient, ~1–3s). Prefer a
prompt that does NOT trigger Search-Composer / web_search to keep
the broker dispatch the dominant latency contributor:

> «Расскажи короткий факт о Юпитере»

OR

> «What's an interesting fact about Jupiter»

Do NOT send long-running tool combos (PDF, Search-Composer) for
this scenario — they exercise downstream pipelines, not the broker
admission path.

### §2.2 Submission protocol

1. Operator A: send turn to chat-A.
2. Operator B: within ≤1s of A, send turn to chat-B (different
   identity, different chat).
3. Operator A or co-tester: within ≤1s of B, send turn to chat-C
   (third identity, third chat).

Submission order matters only for the wallclock window — the
broker's round-robin scheduler ranks keys by enqueue order. The
1s ceiling guarantees the broker observes all three keys
simultaneously rather than draining each before the next arrives.

### §2.3 Expected log evidence

Capture the gateway log file. Grep for `[broker]`. The pass
criteria below MUST hold:

```
grep "\[concurrent-turn-broker-bootstrap\]" gateway-pr-mt-live-verify.log
grep "\[broker\]" gateway-pr-mt-live-verify.log
```

#### §2.3.1 Bootstrap line (one occurrence at startup)

```
[concurrent-turn-broker-bootstrap] bound process-scoped concurrent turn broker
```

If this line is ABSENT, the bootstrap binder did not run — STOP and
triage `src/gateway/server-startup.ts` integration.

#### §2.3.2 Three distinct enqueued queueKeys

```
[broker] enqueued queueKey=identity:<A>::<channelKey-A> depth=0 turnId=<runId-A>
[broker] enqueued queueKey=identity:<B>::<channelKey-B> depth=0 turnId=<runId-B>
[broker] enqueued queueKey=identity:<C>::<channelKey-C> depth=0 turnId=<runId-C>
```

Three lines, three DISTINCT `queueKey=identity:<...>::<...>`
strings. Same-identity-same-channel duplicates would be a routing
regression — STOP and triage. The `<channelKey-*>` portion is a
JSON-tuple `["telegram","<chatId>",<accountId>|null,<threadId>|null]`
(see `dispatch-turn-via-broker.ts:115-127`).

#### §2.3.3 Dispatch timestamps overlap (NOT strict serial)

```
[broker] dispatch queueKey=identity:<A>::<...> waitMs=<N> turnId=<runId-A>
[broker] dispatch queueKey=identity:<B>::<...> waitMs=<N> turnId=<runId-B>
[broker] dispatch queueKey=identity:<C>::<...> waitMs=<N> turnId=<runId-C>
[broker] complete queueKey=identity:<A>::<...> turnId=<runId-A>
[broker] complete queueKey=identity:<B>::<...> turnId=<runId-B>
[broker] complete queueKey=identity:<C>::<...> turnId=<runId-C>
```

ASSERTION — the three `[broker] dispatch` timestamps (the `T` prefix
in the gateway logger) MUST appear within a window MUCH smaller
than the per-turn duration. Concretely: for a per-turn classifier
LLM wallclock of ~2s, the three `dispatch` lines should land within
~200ms of each other. If they instead appear sequentially with
gaps matching the full turn wallclock, the broker is NOT dispatching
concurrently — STOP and triage.

The complementary assertion — `[broker] dispatch X` precedes
`[broker] complete Y` for at least one (X, Y) pair where X != Y —
proves overlapping in-flight execution.

#### §2.3.4 Coherent replies in all three chats

Each chat MUST receive a coherent text reply matching its own
prompt. No cross-chat bleed (e.g. operator A's reply landing in
chat B). Operator-side this is the highest-signal observable.

#### §2.3.5 No cross-identity bleed in `<memory>` / `<active_tasks>`

If the gateway is configured to log the planner-input
`<memory>` or `<active_tasks>` block (debug-level), confirm that
the block injected for turn A contains ONLY identity:A's memory /
tasks — NOT identity:B's or identity:C's. The broker is structurally
oblivious to this surface (it does not touch session state), so
this is a regression signal for adjacent layers (memory store,
intent-ledger).

---

## §3 Same-identity FIFO check (REVERSE)

After §2 captures, the same operator (e.g. operator A) sends TWO
rapid turns to the SAME Telegram chat within 500ms. The broker MUST
serialize them (per-key FIFO) — the second `[broker] dispatch` log
line MUST follow the FIRST `[broker] complete` log line for the
same `queueKey`.

### §3.1 Submission

> «Турн один»
> «Турн два»

(send back-to-back without waiting for the first reply)

### §3.2 Pass criteria

```
[broker] enqueued queueKey=identity:<A>::<channelKey-A> depth=0 turnId=<runId-1>
[broker] dispatch queueKey=identity:<A>::<channelKey-A> waitMs=<N1> turnId=<runId-1>
[broker] enqueued queueKey=identity:<A>::<channelKey-A> depth=1 turnId=<runId-2>
[broker] complete queueKey=identity:<A>::<channelKey-A> turnId=<runId-1>
[broker] dispatch queueKey=identity:<A>::<channelKey-A> waitMs=<N2> turnId=<runId-2>
[broker] complete queueKey=identity:<A>::<channelKey-A> turnId=<runId-2>
```

KEY ASSERTIONS:
- The second `enqueued` line shows `depth=1` (queue accumulated
  while turn-1 was in flight).
- The second `dispatch` for the same `queueKey` appears AFTER the
  first `complete` for that key.
- `waitMs` for turn-2 is approximately the wallclock of turn-1
  (FIFO wait observed).

Telegram-side observable: the two replies arrive in the same order
as the prompts. Concurrent overlap inside one chat would be a
regression — STOP and triage.

---

## §4 Backpressure synthetic check (OPTIONAL but RECOMMENDED)

Sub-plan §1 todo Phase 6 ships a structured envelope on overflow
(`BrokerOverflowReason` → Russian-locale user reply via
`formatBrokerOverflowReply(...)`). This step exercises that path on
a live gateway by temporarily lowering `maxQueueDepthPerKey` to 1.

### §4.1 Setup (local-only, do NOT push)

1. In a local working tree (NOT on `dev`), edit
   `src/gateway/server-startup.ts` (or wherever the gateway boot
   path calls `bindProcessConcurrentTurnBroker(...)`) to pass a
   capacity override:
   ```ts
   bindProcessConcurrentTurnBroker({
     logger: <existing logger>,
     capacityConfig: { maxQueueDepthPerKey: 1 },
   });
   ```
   This is a *test override* — do NOT commit. The override forces
   a structured `queue_depth_exceeded` rejection on the second
   same-key turn submitted within a 1-second window.
2. Restart the gateway against the local tree.

### §4.2 Submission

The same operator sends THREE rapid turns to the SAME chat (within
~200ms each). The broker admits the first (in-flight), queues the
second (depth=1, at cap), and rejects the third with a structured
envelope.

> «Один»
> «Два»
> «Три»

### §4.3 Pass criteria

Gateway log must contain:

```
[broker] enqueued queueKey=identity:<A>::<...> depth=0 turnId=<runId-1>
[broker] enqueued queueKey=identity:<A>::<...> depth=1 turnId=<runId-2>
[broker] rejected queueKey=identity:<A>::<...> reason=queue_depth_exceeded turnId=<runId-3>
[broker] user_notified queueKey=identity:<A>::<...> reason=queue_depth_exceeded retryAfterMs=<N> turnId=<runId-3>
```

The `[broker] user_notified ...` line is emitted by the Phase 6
caller-side wiring at `agent-runner-execution.ts:233-235` —
confirms the structured rejection was translated to a user-facing
reply (NEVER silently dropped — invariant #15).

Telegram-side observable: turn-1 and turn-2 reply normally; turn-3
receives the Russian-locale overflow reply:

> «Перегрузка очереди для этого канала. Повторите через ~N секунд.»

(The exact `N` derives deterministically from `getQueueDepth()` —
see `format-broker-overflow-reply.ts:108-135`.)

### §4.4 Cleanup

Revert the local override in `server-startup.ts`. Restart the
gateway. Subsequent turns observe the production default
(`maxQueueDepthPerKey=8`).

---

## §5 Telemetry capture template

Paste the following block into the slice handoff entry (sub-plan §6
Handoff Log) once verified:

```
LIVE-VERIFY 2026-05-07 — PR-MT concurrent broker
=================================================
Gateway commit:           <git rev-parse HEAD>
Live-verify start:        <ISO-8601>
Telegram chat ids:        <chat-A> / <chat-B> / <chat-C>
Identity ids:             <identity:A> / <identity:B> / <identity:C>

§2 Three identity-distinct turns:
  Bootstrap line:         [concurrent-turn-broker-bootstrap] bound  PRESENT
  Distinct queueKeys:     3                                          ✓
  Dispatch overlap:       <window in ms>                             ✓ (< 200ms)
  Coherent replies:       all three chats                            ✓
  Cross-identity bleed:   none                                       ✓

§3 Same-identity FIFO:
  Sequence depth=1:       observed                                   ✓
  Turn-2 dispatch after turn-1 complete:                             ✓
  waitMs(turn-2) ≈ wallclock(turn-1):                                ✓

§4 Backpressure synthetic (override applied / SKIPPED):
  rejected reason:        queue_depth_exceeded                       ✓ / N/A
  user_notified line:     emitted                                    ✓ / N/A
  Russian-locale reply:   delivered                                  ✓ / N/A
  Override reverted:      yes                                        ✓ / N/A

Negative assertion:
  [broker] runTurn_threw: 0 occurrences across all turns             ✓

Slice CLOSED.
```

---

## §6 Failure triage

### §6.1 If §2.3.1 bootstrap line is ABSENT

The broker singleton was not bound. Confirm
`bindProcessConcurrentTurnBroker(...)` is called at gateway boot
in `src/gateway/server-startup.ts`. If the call is present but
the line is missing from the log, the gateway logger may be
filtering `info`-level lines from `[concurrent-turn-broker-bootstrap]`
— bump the subsystem level.

### §6.2 If §2.3.2 shows duplicate queueKeys

Two distinct operator turns sharing one `queueKey` means the
identity wasn't structurally separated. Confirm
`resolveIdentityFromSessionKey(...)` returned distinct
`IdentityId` brands for the two operators. Inspect the
`channelKey` JSON tuple — if it collapses to the same string for
two distinct chats, the routing-tuple at
`get-reply-run.ts:529-532` may have lost a discriminator.

### §6.3 If §2.3.3 dispatch timestamps are strict-serial

Three sequential `[broker] dispatch` lines spanning the full
per-turn wallclock means concurrency is not happening. Possible
causes:
- `maxConcurrentKeys` accidentally set to 1 in operator config
  (read `~/.openclaw/openclaw.json` for any `concurrentBroker`
  override).
- A wrapping layer is awaiting each `dispatchTurnViaBroker(...)`
  result before submitting the next entry. Confirm the inbound
  path at `agent-runner-execution.ts:201-215` does NOT serialize
  on the dispatch promise.
- The gateway logger is itself serializing log emissions in a
  way that breaks the timestamp window — try `--log=json` or
  similar non-blocking output.

### §6.4 If §2.3.4 cross-chat bleed is observed

The broker does NOT carry session state. Cross-chat bleed indicates
a regression at the memory / intent-ledger layer — investigate
`src/platform/session/intent-ledger.ts` per-session caches and the
session-key derivation. NOT a PR-MT regression.

### §6.5 If §3 same-identity turns interleave

The per-key FIFO is broken. Confirm:
- `decideQueuePlacement(...)` admits both turns to the SAME
  `Map<BrokerQueueKey, BrokerEntry[]>` slot (same key string).
- `decideNextDispatch(...)` does not re-dispatch the same key
  while it's already in `inFlight`.
- The drain loop at `concurrent-turn-broker.ts:152-191` enforces
  `inFlight.add(queueKey)` BEFORE awaiting `runTurn`.

### §6.6 If §4 rejection envelope is not delivered to user

The `[broker] rejected ...` line is in the log but the user
received no reply, OR received a different (e.g. English stub)
reply. Confirm:
- `agent-runner-execution.ts:217-245` translates the rejection
  via `formatBrokerOverflowReply(...)` (Phase 6 wiring).
- The runtime logger is not silently dropping the
  `[broker] user_notified ...` line.

---

## §7 Rollback procedure

If live-verify fails AND a rollback to byte-identical pre-broker
behavior is required:

### §7.1 Quick rollback (skip the bootstrap binder)

In `src/gateway/server-startup.ts`, comment out the call to
`bindProcessConcurrentTurnBroker(...)`. After gateway restart,
`getProcessConcurrentTurnBroker()` returns `undefined`, the Phase 5
wiring at `agent-runner-execution.ts:186` resolves
`broker = undefined`, and `dispatchTurnViaBroker(...)` falls
through to direct `runTurn` invocation — byte-identical to the
pre-Phase-5 dispatch. No commit / merge required.

### §7.2 Code rollback (revert wiring)

In `src/auto-reply/reply/agent-runner-execution.ts:186`, replace:

```ts
const broker = params.concurrentBroker ?? getProcessConcurrentTurnBroker();
```

with:

```ts
const broker: ConcurrentTurnBroker | undefined = undefined;
```

This unconditionally bypasses the broker, even if a future caller
threads `concurrentBroker: <some broker>` via params. Restart the
gateway. `[broker] *` log lines stop being emitted; the
pre-Phase-5 dispatch path is restored.

### §7.3 Rollback acceptance

After rollback, re-run §2 above. Expected: zero `[broker] *` log
lines; turns from three identity-distinct chats are dispatched
serially by the implicit single-async-stack of `runTurnDecision`
(matches the pre-broker baseline observed in audit §a + §e).
Master plan §0 PR Progress Log row for this slice is annotated
ROLLED-BACK with the gateway commit at which the rollback took
effect; sub-plan frontmatter `status: completed` reverts to
`status: in_progress` pending re-investigation.

---

## §8 References

- Sub-plan: `.cursor/plans/commitment_kernel_pr_mt_concurrent_broker.plan.md`
- Phase 1 audit: `extensions/AUDIT-pr-mt-concurrent-broker.md`
- Hard invariants: `.cursor/rules/commitment-kernel-invariants.mdc`
- Broker runtime: `src/platform/broker/concurrent-turn-broker.ts`
- Wiring helper: `src/auto-reply/reply/dispatch-turn-via-broker.ts`
- Caller integration:
  `src/auto-reply/reply/agent-runner-execution.ts:186-246`
- Backpressure formatter:
  `src/auto-reply/reply/format-broker-overflow-reply.ts`
- Bootstrap binder:
  `src/server/concurrent-turn-broker-bootstrap.ts`
- Gateway boot wiring: `src/gateway/server-startup.ts:31`
- Acceptance fixture:
  `src/platform/broker/__tests__/concurrent-turn-broker.acceptance.test.ts`
