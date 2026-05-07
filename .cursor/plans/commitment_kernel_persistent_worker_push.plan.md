---
name: Bug F — Persistent worker subsequent push
slice: persistent-worker-push
status: completed
signoff: GRANTED via blanket authorization 2026-05-05
predecessor: be1c0ca0ae
overview: "Persistent-worker'ы (executionMode='persistent_worker') сегодня делают cron-driven daily push'ы из cron-fired turn'а во внешний канал (Telegram/Slack), но эта дорога — `TBD`: `OutboundCoalescer` обходит её через bypass `cron_persistent_worker` (slot E2 в AUDIT-outbound-coalescer §e), а фактически worker-output → channel ходит мимо kernel'а — без affordance, без done-predicate, без identity injection через canonical seam. Архитектура: (a) REUSE `COMMUNICATION_EFFECT_FAMILY`; NEW `EffectId='persistent_worker.subsequent_push'` + NEW `AffordanceId='persistent_worker.subsequent_push'` (`affordance-registry.ts` additively, slice K P4 / Cutover-4 P4 precedent). (b) NEW `WORKER_REPORT_AVAILABLE_PRECONDITION` (структурный — keyed off NEW `WorldStateSnapshot.persistentWorkerReports?` slice; observer-fed at worker-completion event). (c) NEW done-predicate `persistentWorkerPushDeliveredPredicate` checking `state.persistentWorkerReports?.delivered[]` ⊇ expectedDelta. (d) NEW runtime-adapter `runPersistentWorkerSubsequentPush` (`src/platform/persistent-worker/persistent-worker-push-runtime-adapter.ts`) — invoked by cron-fire callback, NEVER throws, closed-set failure-reason. (e) Cron-fire wiring: extend `src/cron/isolated-agent/run.ts` worker-completion event subscriber to call adapter; identity injection via `wrappedScopeIdentityId = workerRun.ownerIdentityId` (slice K precedent). (f) `OutboundCoalescer.BYPASS_REASONS`: REMOVE `cron_persistent_worker` — slot E2 лит, путь sanctioned. Pure additive on frozen contracts; 16 invariants preserved; cron callback NEVER reads raw user text (#5/#6); subagent-await/holding-mode не затрагивается (separate sub-plan). Non-goals: subagent first-pass aggregation (`commitment_kernel_subagent_result_aggregation.plan.md`), субагентский await-mode, cancel/edit/snooze worker-runs, multi-channel fanout (single-channel v1)."
todos:
  - id: pwpush-phase-1-audit
    content: "Phase 1 — AUDIT (read-only). Output `extensions/AUDIT-persistent-worker-push.md`. Map: (a) cron-fire path для persistent-worker'ов — `src/cron/isolated-agent/run.ts` cron-fired turn execution, `src/cron/isolated-agent/delivery-dispatch.ts` REUSED, parity с reminder-fire-callback (Slice K precedent); (b) emit-sites текущего push'а (`outbound-coalescer-types.ts:91` bypass reason `cron_persistent_worker`; `outbound-coalescer-bypass.test.ts:79`; `aggregation-policy.ts:11/23/144`; `subagent-aggregation.ts:43/162`); (c) подтвердить, что persistent-worker run завершается через известный event (нужен emit-site внутри `cron/isolated-agent/run.ts` worker-completion path) — найти и зафиксировать; (d) confirm `executionMode='persistent_worker'` registered в task-classifier (`task-classifier.ts:80/148/197/393/405/435/476/760/800/915/1069`); (e) confirm slice E `episodic-memory-event.ts` НЕ имеет `persistent_worker.push` STUB — это NEW effect, не STUB-light; (f) cross-identity isolation reality: cron-fire today carries `wrappedScopeIdentityId` ТОЛЬКО для reminder.set; persistent-worker pushes сегодня используют ad-hoc identity from worker-run record — нужен structural seam; (g) operator-impact: count `[outbound-coalescer] event=bypassed reason=cron_persistent_worker` за 7-day window. NO source changes."
    status: completed
  - id: pwpush-phase-2-types
    content: "Phase 2 — Types. NEW branded `PersistentWorkerPushTriggerId = string & {__brand:'PersistentWorkerPushTriggerId'}` + isPersistentWorkerPushTriggerId guard. NEW `WorkerReportRef = {workerRunId: string, ownerIdentityId: IdentityId, completedAt: ISO-8601, channel: ChannelId, to: string, content: string}` (closed shape). NEW `EffectId` constant `PERSISTENT_WORKER_SUBSEQUENT_PUSH_EFFECT='persistent_worker.subsequent_push' as EffectId`. NEW `PreconditionId` constant `WORKER_REPORT_AVAILABLE_PRECONDITION='worker.report.available' as PreconditionId`. NEW Zod schema `WorkerReportRefSchema.strict()` — `workerRunId` non-empty trimmed, `completedAt` ISO-8601, `content` length-capped (slice K P2 reminder-content cap precedent), `channel` валидируется через ChannelId guard, `to` структурный enum-or-trimmed. Tests: round-trip; brand discipline (#16); reject empty workerRunId / malformed completedAt / oversized content; identity-mismatch reverse."
    status: completed
  - id: pwpush-phase-3-affordance-and-predicate
    content: "Phase 3 — `AffordanceRegistry` extension + done-predicate (additive frozen-layer touch — slice K P4 / Cutover-4 P4 precedent). REUSE `COMMUNICATION_EFFECT_FAMILY`. NEW `PERSISTENT_WORKER_SUBSEQUENT_PUSH_AFFORDANCE_ENTRY` — id `persistent_worker.subsequent_push`, effect=`PERSISTENT_WORKER_SUBSEQUENT_PUSH_EFFECT`, target matcher `kind === 'external_channel' || kind === 'unspecified'`, operationKinds=`['push']` (NEW operationKind hint? — Phase 1 audit confirms whether 'create' suffices), requiredPreconditions=`[IDENTITY_RESOLVED_PRECONDITION, WORKER_REPORT_AVAILABLE_PRECONDITION]` (anonymous fail-closed; nothing pushed without persisted worker-report), riskTier='medium' (state crosses /new + outbound push), defaultBudgets={maxLatencyMs:15_000, maxRetries:0} (mutation idempotency unsafe — Cutover-4 precedent). NEW `done-predicate-persistent-worker-push.ts` reads `state.persistentWorkerReports?.delivered[]` + `expectedDelta.persistentWorkerReports?.added[]`. Closed missing-key set: `persistent_worker_reports.slice_absent` / `persistent_worker_reports.delivered.empty` / `worker_report_missing:<id>` / `worker_report_status_unexpected:<id>:<status>`. NEVER throws (#15). Tests: registry extended; `findByFamily('communication', target={kind:'external_channel'}, op={kind:'push'})` resolves correctly + does NOT collide with existing `answer.delivered`; predicate ~8 cases."
    status: completed
  - id: pwpush-phase-4-runtime-adapter
    content: "Phase 4 — Runtime adapter (cron-driven). NEW `src/platform/persistent-worker/persistent-worker-push-runtime-adapter.ts`: `runPersistentWorkerSubsequentPush({collector, sessionId, turnId, workerRunId, ownerIdentityId, completedAt, channel, to, content, deliveryDispatch, logger}) -> Promise<PersistentWorkerPushResult>`. Result envelope CLOSED-shape failure set: `transport_error` / `identity_unavailable` / `channel_invalid` / `worker_run_missing` / `observer_unavailable` / `report_already_pushed` / `dispatch_failed` / `internal_error`. NEVER throws (#15). Implementation: (1) validate `ownerIdentityId` via `isIdentityId` (slice K P5 precedent — cron callback never trusts caller-supplied identity, re-reads from persisted record); (2) resolve channel via existing channel-resolver (REUSE — no fork); (3) call injected `deliveryDispatch` (parity с `reminder-fire-callback.ts:60-62` `DeliveryDispatchFn`); (4) record into observer slice `persistentWorkerReports.delivered`; (5) emit `[persistent-worker-push-runtime-adapter] runPersistentWorkerSubsequentPush workerRunId=<...> identityId=<...> channel=<...> to=<...> result=<ok|fail:<reason>>`. Pure functional; `deliveryDispatch` injected (mirrors `cronAdd` injection в `record-reminder-tool.ts`). Tests fail-first ~10: success path; identity_unavailable reverse; transport_error reverse; report_already_pushed idempotency reverse; dispatch_failed mapped from underlying envelope; logger never throws on adapter return; observer never invoked when identity_unavailable; closed-shape `to` rejection; NaN/oversized content tolerance."
    status: completed
  - id: pwpush-phase-5-cron-callback-wiring
    content: "Phase 5 — Cron-fire callback wiring + WorldState slice + observer. NEW `WorldStateSnapshot.persistentWorkerReports?: {delivered: readonly DeliveredWorkerReportRecord[], failed: readonly FailedWorkerReportRecord[]}` slice (mirrors slice K + Cutover-4 observer pattern). NEW process-scoped `PersistentWorkerReportObserver` (per-(sessionId,turnId) keying, last-writer-wins on `workerRunId`, perTurnLimit=2 — daily push кросс-turn редок). Wired into `createDefaultMonitoredRuntime`. NEW callback `src/cron/isolated-agent/persistent-worker-push-fire-callback.ts` invoked at worker-completion event inside `cron/isolated-agent/run.ts`: (1) load `WorkerRunRecord` by `workerRunId` (DI'd store; cross-identity reads return `undefined` — defense-in-depth, identical к reminder-fire-callback `get(reminderId, identityId)` predicate); (2) construct payload `{workerRunId, wrappedScopeIdentityId: record.ownerIdentityId, completedAt, channel, to, content}` — `wrappedScopeIdentityId` = persisted record's `ownerIdentityId`, NEVER caller-supplied (slice K precedent); (3) call `runPersistentWorkerSubsequentPush` adapter; (4) on `ok`: mark worker-run `subsequentPushStatus='pushed'` (idempotent on retry); on `fail`: structured error envelope, NO replay (operator re-issues manually). NEVER throws. Tests fail-first ~12: cross-identity defense (operator A's worker-run NEVER pushes on operator B's session); markPushed before dispatch arm-order; dispatch_failed → record stays `pushed` (no infinite replay, parity с reminder-fire markFired-before-dispatch); identity_mismatch reverse; logger emits `[persistent-worker-push-fire-callback] workerRunId=<...> wrappedScopeIdentityId=<...> channel=<...> result=<...>`."
    status: completed
  - id: pwpush-phase-6-coalescer-bypass-removal
    content: "Phase 6 — `OutboundCoalescer` bypass-reason `cron_persistent_worker` REMOVED + coverage guard. Edit `src/infra/outbound/outbound-coalescer-types.ts:75/91`: drop `cron_persistent_worker` from `BYPASS_REASONS` tuple (length 7→6) — slot E2 теперь sanctioned path through `runPersistentWorkerSubsequentPush` adapter; `BypassReason` union narrows. Edit comment block `:73-87` (audit §e mapping) — add line: «`cron_persistent_worker`: REMOVED at Bug F slice (lit by `persistent_worker.subsequent_push` affordance); persistent-worker pushes now flow through `OutboundCoalescer.register({ turnId, channelKey, kind: 'final' })` like every per-turn user-facing path». Coverage guard: extend `outbound-coalescer-bypass.test.ts` reverse-test — `bypass({reason:'cron_persistent_worker', ...})` MUST fail-fast with structured error (closed-set rejection, parity с invariant #5 «no user-prompt-derived reasons»). NEW positive test: persistent-worker push → `event=committed` (NOT `event=bypassed`). Update audit `extensions/AUDIT-outbound-coalescer.md:230-231` E2 row → status=`LIT (Bug F slice CLOSED)`. Acceptance grep: zero `[outbound-coalescer] event=bypassed reason=cron_persistent_worker` лог-линий after this phase."
    status: completed
  - id: pwpush-phase-7-acceptance-and-live-verify
    content: "Phase 7 — Acceptance + log-line evidence + live-verify runbook. NEW `src/platform/persistent-worker/__tests__/persistent-worker-push.acceptance.test.ts` (~10 cases): (1) Worker-run completes → cron-fire fires → adapter dispatches → DeliveryReceipt observed → coalescer pass-through `event=committed` (NOT bypassed). (2) Done-predicate satisfied for `persistent_worker.subsequent_push` effect after observer slice updated. (3) Cross-identity defense: A's worker-run NEVER pushes to B's channel. (4) Reverse: anonymous identity → `identity_unavailable` failure-reason; ZERO writes to observer; ZERO transport invocation. (5) Reverse: `WorkerRunRecord` missing → `worker_run_missing`; ZERO retry. (6) Reverse: dispatch_failed → record stays `pushed` (no infinite replay, idempotency-on-retry parity с reminder-fire markFired-before-dispatch). (7) Reverse: bypass with reason `cron_persistent_worker` rejected (closed-set narrowed). (8) Pre-Phase-3 byte-identical 5 frozen contracts. (9) Frozen `MemoryStore` / `TaskLedger` / `EpisodicMemoryEvent` / `ShadowBuildResult` interfaces unchanged. (10) Cron-fire callback NEVER reads raw user text (#5/#6 reverse). NEW write-target `extensions/RUNBOOK-persistent-worker-push.md` — Phase 7 deliverable: maintainer-facing runbook for staging/production verification (gateway restart + live worker-run completion → Telegram delivery). **Live-verify (REQUIRED — invariant #15)**: gateway restart + 1 maintainer-side persistent-worker spawn + wait for cron-fire boundary + assert: `[persistent-worker-push-fire-callback] workerRunId=<...> wrappedScopeIdentityId=<...> channel=<...> result=ok`; `[persistent-worker-push-runtime-adapter] runPersistentWorkerSubsequentPush ... result=ok`; `[outbound-coalescer] event=committed runId=<...>` (NOT `event=bypassed`); `[telegram] sendMessage ok`; `[commitment] persistent_worker.subsequent_push effectFamily=communication operationKind=push decision=kernel`; ZERO `[outbound-coalescer] event=bypassed reason=cron_persistent_worker`. Reverse: anonymous spawn → fail-closed; ZERO push. Slice CLOSED."
    status: completed
isProject: false
---

# Bug F — Persistent worker subsequent push

## 0. Provenance & Context

| Field | Value |
| --- | --- |
| Sub-plan of | `.cursor/plans/commitment_kernel_v1_master.plan.md` (§0.5/§8.5/§16 — Bug F deferred frontier) |
| Inherits | 16 hard invariants from `.cursor/rules/commitment-kernel-invariants.mdc` |
| Predecessor | dev SHA `be1c0ca0ae` (post freshness-slice + master-plan update) |
| Predecessors (closed) | NEW-C `OutboundCoalescer` SLICE COMPLETE (slot E2 bypass `cron_persistent_worker` carved out, awaiting Bug F to light). Slice K (reminder cron-fire callback + `wrappedScopeIdentityId` injection precedent). Cron/Scheduler SLICE COMPLETE (CronService.add({kind:'at'}) + reminder-fire callback). Slice I outbound-sanitizer SLICE COMPLETE (Bug F explicitly out-of-scope per `commitment_kernel_outbound_sanitizer.plan.md:119/361`). Subagent-aggregation FIRST-PASS SLICE COMPLETE (`commitment_kernel_subagent_result_aggregation.plan.md` — first-pass continuation; Bug F = SUBSEQUENT cron-driven push, separate codepath). |
| Trigger | Master §16 + AUDIT-outbound-coalescer §e E2 row (`persistent-worker push (Bug F future) — Owns its own dispatcher, not a per-turn user-facing path. Bypass reason persistent_worker_push deferred — emits today via cron`). Operator-impact: cron-driven daily push'ы из persistent_worker'а во внешний канал сегодня bypass'ят kernel — без affordance, без done-predicate, без structural identity injection через canonical seam. |
| Out of scope | First-pass subagent aggregation (`commitment_kernel_subagent_result_aggregation.plan.md` — separate sub-plan, in-turn continuation); subagent await-mode (`commitment_kernel_subagent_await.plan.md` — out-of-scope); cancel/edit/snooze worker-runs (v2); recurrence exposure beyond `kind:'at'` (v2); multi-channel fanout (single-channel v1); modifying 5 frozen contracts; `MemoryStore` interface widening; `EpisodicEffectFamily` widening (additive emit only); revert of slices E/F/I or NEW-A/B/C/D; routing existing `cron-tool.ts` через kernel (different concern); openclaw.json wholesale overwrite; per-provider hacks. |
| Maintainer signoff | GRANTED via blanket authorization 2026-05-05 |

## 1. Symptom + Root Cause

### 1.1. Symptom (что видит пользователь)

Operator spawn'ит persistent_worker (`executionMode='persistent_worker'`, e.g. `open-models-daily`). Cron-fire boundary срабатывает по расписанию → worker emits result → result needs to ходит BACK to operator's channel (Telegram/Slack). Сегодня этот путь — **TBD**: emit-site эмитит outbound message, но через `OutboundCoalescer.bypass({reason:'cron_persistent_worker', ...})` — без affordance, без commitment-satisfied edge, без done-predicate. Live-evidence: gateway log `terminals/466813.txt:619-820` (live TG session, persistent worker `open-models-daily`).

### 1.2. Architectural root cause

NO sanctioned codepath worker-output → channel push. Slot E2 в AUDIT-outbound-coalescer §e (`extensions/AUDIT-outbound-coalescer.md:231`) был ЯВНО carve-out'нут с пометкой «defered — emits today via cron» в ожидании Bug F sub-plan'а. На сегодня:

1. NO `EffectId` для `persistent_worker.subsequent_push` (только `answer.delivered` для in-turn replies; `reminder.set` для slice K cron-fire — другая семантика).
2. NO affordance в `affordance-registry.ts` matching `('communication', external_channel, push)` operation hint.
3. NO `WorldStateSnapshot.persistentWorkerReports` slice → done-predicate cannot prove «push observed in state-after».
4. NO structural identity-injection seam parity с `wrappedScopeIdentityId` из reminder-fire-callback — push сегодня использует ad-hoc identity from worker-run record без canonical re-injection при пересечении cron-fire boundary.
5. `OutboundCoalescer` обходит этот путь через bypass `cron_persistent_worker` (`outbound-coalescer-types.ts:75/91`) — единственный bypass slot БЕЗ кросс-проверки `Single_final_user_facing_message_per_user_turn` invariant'а через done-predicate edge.

## 2. Hard invariants this slice keeps

- **#1**: `ExecutionCommitment` tool-free. Adapter и cron-fire callback живут в `src/platform/persistent-worker/` + `src/cron/isolated-agent/`, OUTSIDE frozen layer.
- **#2**: Structural selection only. Cron-fire trigger structural (worker-completion event + persisted `WorkerRunRecord`), NEVER text-based.
- **#3**: Production success requires `commitmentSatisfied=true`. Done-predicate over `WorldStateSnapshot.persistentWorkerReports.delivered`.
- **#4**: State-after via `PersistentWorkerReportObserver`.
- **#5**: NO phrase-matching на user text. Push trigger — STRUCTURAL (cron-fire boundary + `WorkerRunRecord` lookup), NOT text-based. Closed-set bypass enum в coalescer гарантирует invariant.
- **#6**: `IntentContractor` — sole sanctioned `RawUserTurn` reader. Push path bypasses contractor entirely; cron-driven (no UserPrompt at all). Adapter receives only structured `WorkerReportRef`.
- **#7**: `ShadowBuilder` unchanged.
- **#8**: `commitment` ↛ `decision` import direction. Module `src/platform/persistent-worker/` imports identity/world-state/ids/Zod/stdlib only. Adapter + cron-fire callback OUTSIDE frozen layer.
- **#9, #10**: Done-predicate text-blind; closed missing-key set; never throws (#15).
- **#11**: 5 frozen contracts BYTE-IDENTICAL. Frozen-layer touches additive only — `affordance-registry.ts` + new effect const + new precondition const (slice K P4 / Cutover-4 P4 precedent — additive entries).
- **#12**: NO emergency phrase patches.
- **#13**: `terminalState` ⊥ `acceptanceReason` untouched.
- **#14**: `ShadowBuildResult` unchanged.
- **#15**: Blanket signoff. Live-verify mandatory at Phase 7. Defense-in-depth: identity predicate at storage layer (`get(workerRunId, identityId)`); anonymous fail-closed; cron-fire respects `wrappedScopeIdentityId = record.ownerIdentityId`; identity NEVER cross-leaks из non-interactive context (slice K precedent).
- **#16**: `EffectFamilyId` ⊥ `EffectId` preserved. NEW `PERSISTENT_WORKER_SUBSEQUENT_PUSH_EFFECT` brand cast at module init. `COMMUNICATION_EFFECT_FAMILY` REUSED.

**NEW structural invariant (Phase 1 audit §i)**: «no `runPersistentWorkerSubsequentPush` invocation without `ownerIdentityId` resolved at persisted-`WorkerRunRecord` layer (NOT caller-supplied at cron callback boundary)». Lint guard: cron callback test asserts `wrappedScopeIdentityId === record.ownerIdentityId` byte-equal.

## 3. Architecture sketch

### 3.1. Effect family + affordance

REUSE existing `COMMUNICATION_EFFECT_FAMILY` (slice E P5 precedent). Push to external channel — communication effect by family. NEW `EffectId` `persistent_worker.subsequent_push` distinguishes from `answer.delivered` (in-turn user-facing reply) и от slice K `reminder.set` (different family entirely).

NEW affordance entry в `affordance-registry.ts`:
```
PERSISTENT_WORKER_SUBSEQUENT_PUSH_AFFORDANCE_ENTRY = {
  id: 'persistent_worker.subsequent_push',
  effectFamily: COMMUNICATION_EFFECT_FAMILY,
  effect: PERSISTENT_WORKER_SUBSEQUENT_PUSH_EFFECT,
  operationKinds: ['push'],
  target: matchesExternalChannel,    // kind === 'external_channel' | 'unspecified'
  requiredPreconditions: [IDENTITY_RESOLVED_PRECONDITION, WORKER_REPORT_AVAILABLE_PRECONDITION],
  riskTier: 'medium',
  donePredicate: persistentWorkerPushDeliveredPredicate,
  defaultBudgets: { maxLatencyMs: 15_000, maxRetries: 0 },
}
```

### 3.2. NEW WorldState slice

`WorldStateSnapshot.persistentWorkerReports?` orthogonal to `scheduledReminders` / `inboundAttachments` / другим slices. Per-(sessionId,turnId) keying, last-writer-wins on `workerRunId`, perTurnLimit=2. Wired через `createDefaultMonitoredRuntime`. Zod `.strict()`; ISO-8601 via `ISO8601_PATTERN`; `IdentityId` validated; content length-capped.

### 3.3. NEW runtime adapter

`src/platform/persistent-worker/persistent-worker-push-runtime-adapter.ts` — `runPersistentWorkerSubsequentPush(...)`. CLOSED failure-set: `transport_error` | `identity_unavailable` | `channel_invalid` | `worker_run_missing` | `observer_unavailable` | `report_already_pushed` | `dispatch_failed` | `internal_error`. NEVER throws (#15). DI'd `deliveryDispatch` (parity с `DeliveryDispatchFn` из `reminder-fire-callback.ts:60-62`).

### 3.4. Cron-fire wiring

NEW `src/cron/isolated-agent/persistent-worker-push-fire-callback.ts` — invoked at worker-completion event внутри `cron/isolated-agent/run.ts`. Constructs payload с `wrappedScopeIdentityId = record.ownerIdentityId` (NEVER caller-supplied — slice K precedent). Calls adapter. Marks `subsequentPushStatus='pushed'` BEFORE dispatch (idempotent on retry, parity с `markFired`-before-dispatch в reminder-fire-callback `:149-157`).

### 3.5. OutboundCoalescer bypass slot lit

`src/infra/outbound/outbound-coalescer-types.ts:91` `BYPASS_REASONS` tuple narrows length 7→6: `cron_persistent_worker` REMOVED. Слот E2 в audit §e — ASSERTED LIT. Coverage guard в `outbound-coalescer-bypass.test.ts` теперь требует, что `bypass({reason:'cron_persistent_worker', ...})` отвергается closed-set check'ом (parity с invariant #5 «no user-prompt-derived reasons»).

## 4. Phase-by-phase TODOs

См. frontmatter `todos`. Phase 1 — AUDIT-FIRST (read-only deliverable `extensions/AUDIT-persistent-worker-push.md`); Phase 2 types; Phase 3 affordance + done-predicate; Phase 4 runtime adapter; Phase 5 cron-fire callback wiring + WorldState slice + observer; Phase 6 coalescer bypass-reason removal + coverage guard; Phase 7 acceptance + live-verify runbook.

## 5. Out-of-scope

- NO per-provider hacks (Telegram/Slack handled через REUSED `deliveryDispatch`).
- NO openclaw.json wholesale overwrite.
- NO revert of slices E/F/I or NEW-A/B/C/D.
- Frozen layer additive only — 5 frozen contracts BYTE-IDENTICAL.
- Subagent-await / await-mode НЕ затрагивается (separate `commitment_kernel_subagent_await.plan.md`).
- Subagent first-pass aggregation НЕ затрагивается (`commitment_kernel_subagent_result_aggregation.plan.md` — in-turn continuation, different codepath).
- Reminder cancel/edit/snooze (v2).
- Recurrence beyond `kind:'at'` (v2).
- Multi-channel fanout (v1 — single-channel).
- Routing existing `cron-tool.ts` через kernel (different concern).

## 6. Handoff Log

### 2026-05-07 — Bug F SLICE COMPLETE (all 7+ phases)

| Phase | PR | Deliverable |
| --- | --- | --- |
| (sub-plan landing) | #273 | sub-plan landed on dev |
| Phase 1 — Audit | #274 | `extensions/AUDIT-persistent-worker-push.md` |
| Phase 2 — Types | #275 | `WorkerReportRef` + Zod schema + effect + precondition + `WORKER_REPORT_CONTENT_MAX_LENGTH=4096` |
| Phase 3 — Affordance + done-predicate | #276 | `PERSISTENT_WORKER_SUBSEQUENT_PUSH_AFFORDANCE_ENTRY` + `persistentWorkerPushDeliveredPredicate` |
| Phase 4 — Runtime adapter | #277 (closed) → #278 | `runPersistentWorkerSubsequentPush` + closed 8-entry failure set + NEVER-throws contract |
| Phase 5 — Cron-fire callback + WorldState slice + observer | #279 | `persistentWorkerPushFireCallback` + `PersistentWorkerReportObserver` + `SubagentRunRecord` additive fields |
| Phase 5b — Spawn-site `ownerIdentityId` wiring + `subagent_ended` companion emitter | #280 | `emitPersistentWorkerSubsequentPushIfApplicable` parallel fan-out at `subagent-registry.ts:666` |
| Phase 5c — Bootstrap binder | #281 | `setProcessPersistentWorkerPushFireCallback` wired at server bootstrap |
| Phase 5d — Production transport closure | #282 | `dispatchCronDelivery`-backed `deliveryDispatch` |
| Phase 6 — `OutboundCoalescer` bypass-reason removal | #283 | `BYPASS_REASONS` 7→6 (`cron_persistent_worker` REMOVED) + closed-set runtime guard |
| Phase 7 — Acceptance + log-line evidence + live-verify runbook + sub-plan flip | (this PR) | `persistent-worker-push.acceptance.test.ts` (16 cases, fail-first verified) + `extensions/RUNBOOK-persistent-worker-push.md` + frontmatter `status: completed` + master plan §0 row |

Frozen-layer additively touched only; 16 invariants preserved; 5 frozen contracts BYTE-IDENTICAL (sha256 `57fc96305711690f5d75d99d63c673ee6389f624fdf7a6c750aad0dc02e624db`) throughout the full slice. Live-verify gated on operator runbook (`extensions/RUNBOOK-persistent-worker-push.md`).

## 7. Test plan

Fail-first per phase. No `vi.spyOn` on function under test (slice E discipline).

- Phase 1: AUDIT md deliverable.
- Phase 2: types ~6 cases (schema round-trip; brand discipline; reject empty/malformed/oversized; identity-mismatch reverse).
- Phase 3: affordance ~4 cases + predicate ~8 cases (`findByFamily` resolves persistent_worker.subsequent_push correctly + does NOT collide с answer.delivered; predicate closed missing-key set).
- Phase 4: runtime adapter ~10 cases (success path; identity_unavailable / transport_error / report_already_pushed / dispatch_failed / observer_unavailable reverses; logger never throws; closed-shape `to` rejection).
- Phase 5: cron-fire callback ~12 cases (cross-identity defense; markPushed-before-dispatch arm-order; dispatch_failed → record stays `pushed`; identity_mismatch reverse; logger emit; clock-mock determinism; perTurnLimit; sessionId isolation).
- Phase 6: coalescer bypass-removal ~3 cases (bypass `cron_persistent_worker` rejected by closed-set check; persistent-worker push emits `event=committed`; absence of `event=bypassed reason=cron_persistent_worker` после Phase 6).
- Phase 7 acceptance ~10 cases (см. frontmatter `pwpush-phase-7-acceptance-and-live-verify`); end-to-end simulates worker-run completion → cron fire → push affordance → DeliveryReceipt → coalescer pass-through.

Log-line evidence:
- `[persistent-worker-push-fire-callback] workerRunId=<...> wrappedScopeIdentityId=<...> channel=<...> to=<...> result=<ok|fail:<reason>>`
- `[persistent-worker-push-runtime-adapter] runPersistentWorkerSubsequentPush workerRunId=<...> identityId=<...> channel=<...> to=<...> result=<...>`
- `[commitment] persistent_worker.subsequent_push effectFamily=communication operationKind=push decision=kernel`
- `[outbound-coalescer] event=committed runId=<...>` (NOT `event=bypassed`)
- ZERO `[outbound-coalescer] event=bypassed reason=cron_persistent_worker` после Phase 6

## 8. Live-verify runbook gist

Phase 7 deliverable — write target `extensions/RUNBOOK-persistent-worker-push.md` (parity с `RUNBOOK-cron-scheduler.md` если уже существует). Maintainer-facing runbook:

1. Gateway restart.
2. Maintainer spawn'ит persistent-worker (executionMode='persistent_worker') с расписанием +2min on Telegram.
3. Wait 2min для cron-fire boundary.
4. Assert log lines per §7 above.
5. Assert Telegram delivery received (single message, sanctioned path).
6. Reverse: anonymous spawn → fail-closed; ZERO push.
7. Slice CLOSED.

## 9. Maintainer signoff

GRANTED via blanket authorization 2026-05-05.

## 10. References

- Master plan §0/§0.5.6/§3 (16 invariants)/§8.5/§16
- Hard invariants `.cursor/rules/commitment-kernel-invariants.mdc`
- `.cursor/plans/commitment_kernel_subagent_result_aggregation.plan.md` (sister sub-plan; first-pass aggregation)
- `.cursor/plans/commitment_kernel_subagent_await.plan.md` line 128 (Bug F = cron-driven persistent_worker push'ы)
- `.cursor/plans/commitment_kernel_outbound_sanitizer.plan.md:119/361` (Bug F priority=medium scope clarifier)
- `.cursor/plans/commitment_kernel_outbound_coalescer.plan.md` (NEW-C SLICE COMPLETE; bypass slot E2 awaiting Bug F)
- `.cursor/plans/commitment_kernel_self_feedback_loop_fix.plan.md` (persistent_worker semantics + provenance gate)
- `.cursor/plans/commitment_kernel_cron_scheduler.plan.md` (CronService + reminder-fire-callback precedent)
- `.cursor/plans/commitment_kernel_slice_k_reminder.plan.md` (`wrappedScopeIdentityId` injection precedent)
- `extensions/AUDIT-outbound-coalescer.md:231` E2 row (slot awaiting Bug F to light)
- `src/cron/isolated-agent/reminder-fire-callback.ts` (mirror impl — adapter + identity injection)
- `src/infra/outbound/outbound-coalescer-types.ts:75/91` (bypass slot to remove at Phase 6)
- `src/platform/commitment/affordance-registry.ts` (additive entry registration)
- `src/platform/commitment/effect-family-registry.ts` (REUSE `COMMUNICATION_EFFECT_FAMILY`)
- `src/platform/decision/task-classifier.ts:80/197/393/405/435/476/760/800/915/1069` (`executionMode='persistent_worker'`)
- `src/auto-reply/reply/aggregation-policy.ts:11/23/144` + `subagent-aggregation.ts:43/162` (first-pass scope clarifier)
