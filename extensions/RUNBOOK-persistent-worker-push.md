# RUNBOOK — Bug F persistent-worker subsequent push live-verify

| Field | Value |
| --- | --- |
| Sub-plan | `.cursor/plans/commitment_kernel_persistent_worker_push.plan.md` |
| Phase | 7 — Acceptance + log-line evidence + live-verify runbook |
| Slice | `persistent-worker-push` |
| Maintainer signoff | GRANTED via blanket authorization 2026-05-05 |
| Operator | Vladimir (Telegram chat `6533456892`) |

This runbook is the operator script for the live-verify gate the slice
sub-plan §1 todo `pwpush-phase-7-acceptance-and-live-verify` and §8
require to close the slice. It is NOT a test the agent runs — Vladimir
runs it on the dev gateway and records the captured log lines +
Telegram delivery as evidence. The structural assertion is on the log
lines; the operator-side observable is a single Telegram message
arriving from the spawned `persistent_worker` after the cron-fire
boundary.

The agent has shipped (Phases 1–6):

- Phase 1 audit (`extensions/AUDIT-persistent-worker-push.md`).
- Phase 2 types (`WorkerReportRef` + Zod schema +
  `PERSISTENT_WORKER_SUBSEQUENT_PUSH_EFFECT` +
  `WORKER_REPORT_AVAILABLE_PRECONDITION` +
  `WORKER_REPORT_CONTENT_MAX_LENGTH = 4096`).
- Phase 3 affordance + done-predicate
  (`PERSISTENT_WORKER_SUBSEQUENT_PUSH_AFFORDANCE_ENTRY` registered on
  the default `AffordanceRegistry`;
  `persistentWorkerPushDeliveredPredicate` reads
  `WorldStateSnapshot.persistentWorkerReports?.delivered[]`).
- Phase 4 runtime adapter
  (`runPersistentWorkerSubsequentPush` — closed 8-entry failure set;
  NEVER throws; `wrappedScopeIdentityId` re-injected at dispatch
  boundary).
- Phase 5 cron-fire callback + `WorldState` slice + observer +
  `SubagentRunRecord` additive fields (`ownerIdentityId`,
  `frozenResultText`, `subsequentPushStatus`).
- Phase 5b spawn-site `ownerIdentityId` wiring + `subagent_ended`
  hook flip via the parallel
  `emitPersistentWorkerSubsequentPushIfApplicable` companion emitter.
- Phase 5c bootstrap binder
  (`setProcessPersistentWorkerPushFireCallback` wired at server boot).
- Phase 5d production transport closure via `dispatchCronDelivery`.
- Phase 6 `OutboundCoalescer.BYPASS_REASONS` tuple narrowed 7→6
  (`cron_persistent_worker` REMOVED — slot E2 in audit §e LIT).

This runbook closes the loop by exercising the end-to-end cron-fire
path with REAL operator input on a dev gateway, capturing the four
required structural log lines and confirming a SINGLE Telegram message
landed via the sanctioned codepath (NOT the legacy bypass slot).

---

## §1 Pre-conditions

1. Dev gateway restarted from `feat/v1-pwpush-phase-7-acceptance` (or
   a merged successor on `dev`). Confirm:
   ```
   git -C ~/source/repos/god-mode-core rev-parse HEAD
   ```
   The gateway boot banner should also show
   `god-mode-core ... commit=<sha>`. If the gateway was running before
   the merge, **HARD-RESTART** it — Phase 5c bootstrap binder is wired
   at process-init only.
2. Identity `identity:vladimir` registered with the Telegram chat.
   Confirm via `~/.openclaw/openclaw.json:agents.identityResolver`
   (READ-only — do NOT overwrite this file; per memory rule «never
   overwrite ~/.openclaw/openclaw.json without backup»).
3. `~/.openclaw/openclaw.json` UNTOUCHED. The persistent-worker push
   slice ships defaults
   (`maxLatencyMs=15_000`, `maxRetries=0`,
   `WORKER_REPORT_CONTENT_MAX_LENGTH=4096`) and does NOT require any
   new config key.
4. Gateway started in foreground with stdout captured to a fresh log
   file (e.g. `gateway-pwpush-live-verify.log`) so the structural log
   lines below can be greped reliably.
5. No leftover persistent-worker runs from prior sessions: confirm the
   `subagentRuns` registry is clean (or accept that prior runs may
   surface in the cron-fire path on the next tick — they will short-
   circuit via `report_already_pushed` once the observer slice carries
   a `pushed` record for them).

---

## §2 Operator prompts (1 turn)

Send the following prompt via Telegram. Wait the prescribed cron-fire
interval (2 minutes for the canonical fixture below) so the cron-fire
boundary actually fires within the same gateway uptime window.

### Turn 1 — Spawn a persistent-worker with a +2min cadence

> «создай persistent worker `daily-test-pwpush-<YYYYMMDD>`, который раз
> в 2 минуты пишет «push fixture: <ts>» в этот чат»

Where `<YYYYMMDD>` is today's date and `<ts>` is whatever ISO timestamp
the worker mints on each tick (the model fills it in — exact text is
operator-judged for sanity).

Expected immediate behaviour (Telegram side):

- Persistent-worker spawn ack arrives within 5–10s. The ack body
  varies by classifier — accept any structured «worker spawned» reply.
- The spawn-site wiring records `ownerIdentityId = identity:vladimir`
  on the `SubagentRunRecord` (Phase 5b deliverable). Confirmed
  structurally — no operator-visible artifact.

Then **WAIT 2 MINUTES** for the first cron-fire boundary.

---

## §3 Structural log assertions

After the 2-minute wait, grep the gateway log file for the four
required structural lines. The exact values vary per run; the
**presence** of each line is the assertion.

```
grep "\[persistent-worker-push-fire-callback\]"           gateway-pwpush-live-verify.log
grep "\[persistent-worker-push-runtime-adapter\]"         gateway-pwpush-live-verify.log
grep "\[outbound-coalescer\] event=committed"             gateway-pwpush-live-verify.log
grep "\[outbound-coalescer\] event=bypassed reason=cron_persistent_worker" gateway-pwpush-live-verify.log
```

### §3.1 Pass criteria — every one of the following MUST hold

| # | Pattern | Expected |
| --- | --- | --- |
| 1 | `[persistent-worker-push-fire-callback] workerRunId=<id> wrappedScopeIdentityId=identity:vladimir channel=telegram result=ok` | ≥ 1 line |
| 2 | `[persistent-worker-push-runtime-adapter] runPersistentWorkerSubsequentPush workerRunId=<id> identityId=identity:vladimir channel=telegram to=6533456892 result=ok` | ≥ 1 line, same `<id>` as #1 |
| 3 | `[outbound-coalescer] event=committed runId=<id>` | ≥ 1 line |
| 4 | `[outbound-coalescer] event=bypassed reason=cron_persistent_worker` | **0 lines** |

Pattern #4 is the negative assertion that closes Phase 6 in production:
the legacy bypass slot was retired, the closed `BypassReason` runtime
guard rejects the literal at `outbound-coalescer.ts:486-490`. A non-
zero count here is a RED-FLAG regression.

### §3.2 Telegram-side assertion

Within the 60-second OutboundCoalescer watchdog window after the
`[persistent-worker-push-runtime-adapter] ... result=ok` line, **exactly
one** new Telegram message arrives in chat `6533456892`. The body
contains `push fixture: <ts>` (or whichever string the worker minted on
the cron-fire tick).

If TWO messages arrive (e.g. one via the legacy bypass slot, one via
the sanctioned coalescer pass-through), this is a regression — open an
incident and revert.

---

## §4 Reverse case — anonymous spawn fail-closed

This reverse exercises sub-plan §1 todo Phase 7 case (4)
`identity_unavailable` and the new structural invariant from sub-plan
§1 audit §i.

### §4.1 Setup

1. Spawn a persistent-worker via a NON-IDENTITY-RESOLVED channel —
   e.g. an anonymous webchat session whose `~/.openclaw/openclaw.json`
   identity resolver returns `undefined`. (Production deployments
   typically map every channel to an identity; if your dev gateway
   has none unmapped, skip this reverse — the structural fail-closed
   is also asserted at the unit-test layer in
   `subagent-ended-hook-pwpush.test.ts` Case `Predicate 2` and at the
   acceptance test `Case 4`.)

### §4.2 Pass criteria

After 2 minutes (cron-fire boundary):

- ZERO `[persistent-worker-push-runtime-adapter] ... result=ok` lines
  for the anonymous worker's `workerRunId`.
- ZERO new Telegram messages.
- The Phase 5b emitter `[subagent-ended-pwpush] workerRunId=<id>
  result=fail:identity_unavailable` MAY appear (gating predicate
  fail), OR the emitter MAY short-circuit BEFORE invoking the
  callback (gating predicate 2 — `ownerIdentityId` undefined). Either
  is acceptable — the operator-visible observable is identical: ZERO
  push delivered.

---

## §5 Telemetry capture template

Paste the following block into the slice handoff entry (sub-plan §6
Handoff Log) once verified:

```
LIVE-VERIFY 2026-05-07 — Bug F persistent-worker subsequent push
================================================================
Gateway commit:           <git rev-parse HEAD>
Cron-fire boundary at:    <ISO-8601 of the +2min tick>
Telegram turnId:          <runId minted by emitPersistentWorkerSubsequentPushIfApplicable>
Worker runId:             <SubagentRunRecord.runId>

Structural log lines captured:
  [persistent-worker-push-fire-callback]   workerRunId=<id> wrappedScopeIdentityId=identity:vladimir channel=telegram result=ok
  [persistent-worker-push-runtime-adapter] runPersistentWorkerSubsequentPush workerRunId=<id> identityId=identity:vladimir channel=telegram to=6533456892 result=ok
  [outbound-coalescer] event=committed runId=<id>

Negative assertion (Phase 6 closed-set):
  [outbound-coalescer] event=bypassed reason=cron_persistent_worker  →  0 occurrences

Telegram side:
  Single message delivered, body matched worker output.

Reverse (anonymous spawn): SKIPPED / VERIFIED  (mark whichever applies)
  ZERO push delivered, ZERO transport invocation.

Slice CLOSED.
```

---

## §6 Failure triage

If §3.1 pattern #1 is missing (callback not invoked):
- Verify Phase 5b binder is wired. Search the gateway log for
  `[bootstrap]` lines mentioning `setProcessPersistentWorkerPushFireCallback`.
- Verify the spawn carried `ownerIdentityId` — see
  `subagent-ended-hook-pwpush.test.ts` for the predicate set.
- Verify `frozenResultText` non-empty —
  `subagent-registry.ts:freezeRunResultAtCompletion` runs at
  completion; if the worker output is empty the emitter short-
  circuits.

If §3.1 pattern #2 is missing but pattern #1 present:
- The fire-callback succeeded but the adapter did not. Inspect for
  `result=fail:<reason>` log lines on pattern #1; the closed 8-entry
  failure set tells you which guard fired
  (`identity_unavailable` / `worker_run_missing` / `channel_invalid`
  / `report_already_pushed` / `dispatch_failed` / `transport_error`
  / `observer_unavailable` / `internal_error`).

If §3.1 pattern #3 is missing but pattern #2 present:
- The adapter dispatched via `dispatchCronDelivery` but the
  OutboundCoalescer did not commit. Check the coalescer's per-bucket
  watchdog (`maxBufferMs=60_000`) and the `commit_signal` /
  `timeout_committed` events.

If §3.1 pattern #4 is non-zero:
- **STOP, do not merge.** The legacy bypass slot is being exercised
  somewhere — Phase 6 contract violation. Trace the source by
  grepping the codebase for the literal string
  `cron_persistent_worker` (should match ONLY documentation /
  audit / test files post Phase 6, never a live caller).

---

## §7 Slice CLOSED criteria

The slice is considered CLOSED when:

1. §3.1 patterns #1, #2, #3 each match ≥ 1 line.
2. §3.1 pattern #4 matches 0 lines.
3. §3.2 Telegram-side single-message delivery confirmed.
4. §5 telemetry block pasted into the handoff log.

The reverse case (§4) is NICE-TO-HAVE — the structural fail-closed is
already asserted at the unit-test layer; the live-verify reverse is
an additional belt-and-braces check the operator can run when an
unmapped channel is conveniently available.
