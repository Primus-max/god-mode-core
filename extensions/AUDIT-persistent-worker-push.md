# AUDIT — Bug F Persistent Worker Subsequent Push (Phase 1, read-only)

**Sub-plan**: `.cursor/plans/commitment_kernel_persistent_worker_push.plan.md`
**Slice id**: `persistent-worker-push`
**Audit branch**: `audit/v1-persistent-worker-push-phase-1`
**Predecessor SHA**: `7225308ccb` (`origin/dev` HEAD; post PR-#273 — sub-plan landed).
**Maintainer signoff**: GRANTED via blanket authorization 2026-05-05.
**Frozen-layer touches in this audit**: NONE (read-only markdown deliverable; the 5 frozen contracts under `src/platform/decision/` and `src/platform/commitment/` 5-contract surface remain BYTE-IDENTICAL).

This document maps the source-of-truth state of every surface Phase 2-7 of Bug F will read or extend, line-anchored against `dev` HEAD `7225308ccb`. It establishes the structural seam between `cron/isolated-agent/run.ts` worker-completion path, `affordance-registry.ts`, `OutboundCoalescer.BYPASS_REASONS`, and the prospective NEW `runPersistentWorkerSubsequentPush` runtime adapter.

---

## §a. Cron-fire path for persistent-workers

### a.1 `src/cron/isolated-agent/run.ts` — cron-fired turn execution

Authoritative entry point: `runCronIsolatedAgentTurn(params)` at `src/cron/isolated-agent/run.ts:179-920`.

Lifecycle, anchored against the `params.job: CronJob` argument:

| Stage | File | Lines | What |
|---|---|---|---|
| Pre-check delivery requested | `src/cron/isolated-agent/run.ts` | 123-167 | `resolveCronDeliveryContext` builds `{ deliveryPlan, deliveryRequested, resolvedDelivery, toolPolicy }`. `resolveCronToolPolicy` decides `disableMessageTool: true` for `deliveryContract === "cron-owned"`. |
| Resolve session | `src/cron/isolated-agent/run.ts` | 250-291 | `resolveCronSession(...)` resolves `(sessionId, sessionEntry)`. Cron sessions are KEYED on `cron:<jobId>` derivative; the operator's `IdentityId` is NOT plumbed onto the cron job today (see §f below). |
| Resolve model | `src/cron/isolated-agent/run.ts` | 292-307 | `resolveCronModelSelection(...)`. |
| Build commandBody | `src/cron/isolated-agent/run.ts` | 333-381 | Wraps external content with security boundaries (`buildSafeExternalPrompt`); calls `appendCronDeliveryInstruction`. |
| Resolve `messageChannel` | `src/cron/isolated-agent/run.ts` | 382-389 | `resolvedDelivery.channel` is THE channel for Phase 5 dispatch. |
| Run agent (`runPrompt`) | `src/cron/isolated-agent/run.ts` | 475-619 | Either `runCliAgent` or `runEmbeddedPiAgent`. The agent emits assistant turn payloads. |
| **Worker-completion side-effects** | `src/cron/isolated-agent/run.ts` | 619-680 | `await runPrompt(commandBody)` returns. The cron isolated turn ENDS here from the agent's perspective; payloads are aggregated into `runResult.payloads` (line 681). This is the moment where the persistent_worker run "completes" within the cron-fire boundary. |
| Acceptance + delivery | `src/cron/isolated-agent/run.ts` | 779-919 | `acceptanceOutcome` evaluated via `runtimeService.evaluateAcceptance(...)`; `dispatchCronDelivery({...})` dispatched (line 873-899). |

**Key observation**: Today the cron-fire path NEVER routes through the `OutboundCoalescer` for the `executionMode='persistent_worker'` daily-push semantics — it goes directly through `dispatchCronDelivery` (`src/cron/isolated-agent/delivery-dispatch.ts:299`). The coalescer is only consulted when `runReplyAgent` is the wrapping caller; cron isolated agents bypass that wrapper. `OutboundCoalescer.bypass({reason:'cron_persistent_worker', ...})` is the documented escape hatch (see §b.1).

### a.2 `src/cron/isolated-agent/delivery-dispatch.ts` — REUSED for delivery

Authoritative dispatch entry: `dispatchCronDelivery(params)` at `src/cron/isolated-agent/delivery-dispatch.ts:299-637`.

Internals to REUSE in Phase 4 adapter:

- `deliverViaDirect(delivery, options)` at `:324-437` — calls `deliverOutboundPayloads({...})` (`src/infra/outbound/deliver.ts`). Idempotency keying via `buildDirectCronDeliveryIdempotencyKey({ runSessionId, delivery })` at `:218-229`.
- `retryTransientDirectCronDelivery(...)` at `:270-297` — closed-set transient retry loop with the existing transient/permanent regex tuples at `:115-135`.
- `finalizeTextDelivery(...)` at `:439-562` — wait-for-descendant subagent summary path (NOT applicable to Bug F — we're at the worker-completion seam, not at parent reply seam).

**Phase 4 architectural decision**: `runPersistentWorkerSubsequentPush` will accept `deliveryDispatch: DeliveryDispatchFn` as DI param (closed-shape function — parity with `reminder-fire-callback.ts:60-62`). Production wires the injected `deliveryDispatch` through `dispatchCronDelivery` (or its sub-helpers `deliverViaDirect`+`retryTransientDirectCronDelivery`) — REUSE, NO fork.

### a.3 Parity with `reminder-fire-callback.ts` (Slice K Phase 5 precedent)

`src/cron/isolated-agent/reminder-fire-callback.ts:1-202` is the canonical parallel: cron-fire boundary → load persisted `ReminderRecord` predicated on `(reminderId, identityId)` → mark `markFired` BEFORE dispatch (idempotent on retry) → call injected `deliveryDispatch` carrying `wrappedScopeIdentityId = record.ownerIdentityId`.

Specific shape parities to mirror in Phase 5 callback:

| Shape | Slice K (today) | Bug F (Phase 5 callback) |
|---|---|---|
| Closed payload type | `ReminderFireDispatchPayload` (`reminder-fire-callback.ts:47-54`) | NEW `PersistentWorkerPushDispatchPayload` |
| Failure-reason union | `FireReminderFailureReason` (`:72-77`) — 5 entries (`reminder_store_unavailable` / `record_missing` / `dispatch_failed` / `identity_unavailable` / `internal_error`) | NEW `PersistentWorkerPushFailureReason` — 8 entries (sub-plan §3.3) |
| Identity injection | `wrappedScopeIdentityId = record.ownerIdentityId` (`:162-169`) NEVER caller-supplied | Identical discipline; persisted `WorkerRunRecord.ownerIdentityId` is the seam (NEW field — see §f) |
| Mark-before-dispatch | `await input.reminderStore.markFired(reminderId, identityId)` at `:149-157` BEFORE `deliveryDispatch(payload)` at `:181` | `subsequentPushStatus='pushed'` BEFORE `deliveryDispatch(payload)` |
| Closed-shape result | `FireReminderResult` discriminated union (`:79-89`) | Identical discipline — NEW `PersistentWorkerPushResult` |
| NEVER throws | All paths return typed envelope (try/catch wraps at `:126-134/151-157/180-188`) | Identical discipline (#15) |
| `logger?` injection | Optional structured-line emitter (`:171-173`) | Identical signature |

The slice K precedent is the unambiguous architectural template for the Phase 5 cron-fire callback — we translate the contract one-for-one to the persistent-worker domain.

---

## §b. Existing emit-sites for the current bypass

### b.1 `src/infra/outbound/outbound-coalescer-types.ts:91` — `cron_persistent_worker` bypass slot

```ts
export const BYPASS_REASONS = [
  "system_init",
  "cron_persistent_worker",   // line 91 — SLOT TO REMOVE at Phase 6
  "internal_canvas",
  "internal_stdout",
  "internal_log",
  "standalone_command",
  "internal_acp_lane",
] as const;
```

| Field | Value (today, dev `7225308ccb`) |
|---|---|
| File | `src/infra/outbound/outbound-coalescer-types.ts` |
| Line | 91 (entry); 75 (audit-block comment row) |
| Tuple length | 7 |
| What it does | Membership check at `isBypassReason(value)` (`:107-112`). Closed-set rejection at runtime in `coalescer.bypass(reason, body, deliver)` rejects any reason outside the tuple. |
| What it gates | Cron-fire emit-sites that today bypass `OutboundCoalescer.register({turnId, channelKey, kind:'final'})` because (a) no `turnId` aligned with a `runReplyAgent` user-turn boundary; (b) no commitment-satisfied edge; (c) no done-predicate. |
| Phase 6 action | REMOVE the `"cron_persistent_worker"` entry. Tuple narrows 7→6. `BypassReason` compile-time union narrows. Acceptance test asserts runtime rejection. |

### b.2 `src/infra/outbound/outbound-coalescer-bypass.test.ts:79` — bypass coverage

```ts
expect(BYPASS_REASONS).toEqual([
  "system_init",
  "cron_persistent_worker",   // line 79 — assertion keyed on current 7-entry shape
  "internal_canvas",
  ...
]);
```

| Field | Value |
|---|---|
| File | `src/infra/outbound/outbound-coalescer-bypass.test.ts` |
| Lines | 73-86 (positive assertion); 88-98 (per-entry compile-time loop); 100-176 (B1 — bypass delivers immediately, never buckets); 178-221 (B2 — bypass during active turn isolated); 223-283 (B3 — internal channel composes with sanitizer) |
| What it does | Phase 6 spec lock — closed-union shape is asserted byte-identical at runtime. |
| Phase 6 action | Update positive-shape assertion to drop `cron_persistent_worker` (now 6-entry); ADD new test asserting `bypass({reason:'cron_persistent_worker', ...})` rejected with `unknown bypass reason` error (parity with the existing `user_supplied_text` reject case at `:129-153`). |

### b.3 `src/auto-reply/reply/aggregation-policy.ts:11/23/144` — first-pass aggregation references

```ts
// :11
slice: persistent-worker-push (out-of-scope at this seam — see :22-25)
// :22-25
 * Aggregation policy касается ТОЛЬКО first_pass'а (immediate continuation
 * сразу после spawn'а в том же user-turn'е). Cron-driven persistent_worker
 * push'ы — отдельный codepath / sub-plan (Bug F, см. §8 sub-plan'а).
// :144
  // Continuation = persistent_worker (mode="session") или followup
  // (mode="run" + expectsCompletionMessage=true). One-shot run без
  // expectsCompletionMessage не требует aggregation gate'а.
```

| Field | Value |
|---|---|
| File | `src/auto-reply/reply/aggregation-policy.ts` |
| Lines | 11 (header — first_pass scope marker), 22-25 (commentary delimiting Bug F out-of-scope), 144-148 (`decideAggregationMode` continuation branch) |
| What it does | `decideAggregationMode({spawn, userChannelTarget, configMode})` at `:133-153` — returns `"holding"` / `"await"` / `"none"` for IN-TURN aggregation only. Bug F is structurally orthogonal: it lives at the cron-fire seam (no `runReplyAgent` user-turn around it). |
| What it gates | NOT a Bug F gate. Documents the demarcation: holding/await aggregation is for the `sessions_spawn` continuation in the same user-turn; subsequent cron-driven push of worker-output is a SEPARATE codepath (Phase 5 callback). Bug F MUST NOT collide with this gate's idempotency keys (see `buildVerbatimIdempotencyKey` at `:211-216` — keyed on `childRunId`; Bug F idempotency is keyed on `workerRunId × subsequentPushStatus`, distinct namespace). |
| Phase 5 action | NONE — the policy stays untouched. We only confirm there is no overlap: `evaluateAggregationOverride` requires `detectSpawnToolInvocation(runResult) === true` (`subagent-aggregation.ts:178`), which is false at the cron-fire boundary because the cron-isolated turn does NOT invoke `sessions_spawn` to produce its own output (the worker IS already the spawned descendant). |

### b.4 `src/auto-reply/reply/subagent-aggregation.ts:43/162` — subagent aggregation references

```ts
// :43-49 (pseudocode anchor)
const CURRENT_TURN_WINDOW_MS = 5 * 60 * 1000;
// :162
 * Sub-plan §4 #2 default = Option A `holding`. Опция `await` зарезервирована
 * за future cron/persistent_worker push sub-plan'ом (Bug F).
```

| Field | Value |
|---|---|
| File | `src/auto-reply/reply/subagent-aggregation.ts` |
| Lines | 43-49 (`CURRENT_TURN_WINDOW_MS = 5 * 60 * 1000` — in-turn detection window for first-pass aggregation), 162-163 (`evaluateAggregationOverride` `await` mode reservation note pointing at Bug F) |
| What it does | Same demarcation as §b.3 — `evaluateAggregationOverride(...)` at `:164-235` returns early `"passthrough"` when no in-turn `sessions_spawn` receipt. Cron-fire callbacks for subsequent_push run OUTSIDE the user-turn surface; this gate never sees them. |
| Phase 5 action | NONE. Confirm no overlap; the gate's `parentSessionKey` predicate (`:171-174`) is empty at cron-fire boundary (no parent reply context), so `evaluatePendingChildOverride` also short-circuits at `:430-432`. |

### b.5 Summary table — emit-sites and gates

| # | Site | File:Line | Reason gate | Phase 6 action |
|---|---|---|---|---|
| 1 | `cron_persistent_worker` bypass entry | `src/infra/outbound/outbound-coalescer-types.ts:91` | Closed-set tuple `BYPASS_REASONS` | REMOVE entry |
| 2 | Bypass coverage positive assertion | `src/infra/outbound/outbound-coalescer-bypass.test.ts:79` | Membership check | Update assertion (length 7→6) |
| 3 | First-pass aggregation policy delimiter | `src/auto-reply/reply/aggregation-policy.ts:11/23-25/144` | (informational comment) | NONE |
| 4 | Subagent aggregation `await` mode delimiter | `src/auto-reply/reply/subagent-aggregation.ts:43/162-163` | (informational comment) | NONE |

Items 3-4 are **commentary-only** delimiters that explicitly carve out Bug F as a future sibling sub-plan; they do NOT gate any runtime branch. Phase 6 lights item 1 and updates item 2.

---

## §c. Persistent-worker run completion event

### c.1 Where does `executionMode='persistent_worker'` worker complete?

**Finding**: There is **NO single `WorkerRunRecord.markComplete(...)` invocation** in the codebase today — the closest analogue is the `subagent_ended` lifecycle hook + `SubagentRunRecord.endedAt` mutation:

| Aspect | Source | Status |
|---|---|---|
| Worker run record type | `SubagentRunRecord` at `src/agents/subagent-registry.types.ts:6-63` | LIT |
| Spawn-mode discriminator | `spawnMode?: SpawnSubagentMode` at `:19` | LIT (`"session"` discriminates persistent_worker) |
| Completion field | `endedAt?: number` at `:27` | LIT |
| Outcome | `outcome?: SubagentRunOutcome` at `:28` | LIT |
| `subagent_ended` plugin hook | `emitSubagentEndedHookOnce(...)` at `src/agents/subagent-registry-completion.ts:44-96` | LIT (calls `hookRunner.runSubagentEnded(...)` at `:69-87`) |
| **`subsequentPushStatus`** | NONE | **MISSING — Phase 5 NEW field** |
| **`ownerIdentityId`** | NONE | **MISSING — Phase 5 NEW field** |

`SubagentRunRecord` does NOT carry `ownerIdentityId` today (see §f). Phase 5 sub-plan introduces `WorkerRunRecord` as a NEW conceptual layer — the cron-fire callback queries this layer keyed by `(workerRunId, identityId)` (slice K precedent).

**Architectural decision** (Phase 5): EITHER (a) extend `SubagentRunRecord` with optional `ownerIdentityId?: IdentityId` + `subsequentPushStatus?: 'pending' | 'pushed' | 'failed'` fields (additive — no breaking change for existing consumers); OR (b) introduce a NEW `WorkerRunRecord` shape sitting alongside `SubagentRunRecord`, joinable by `runId`. Sub-plan frontmatter §1 todo Phase 5 is ambiguous between the two; Phase 5 architectural review decides. **Audit recommendation**: option (a) — additive — fewer moving parts, same `subagent_ended` hook fires, no parallel registry to maintain.

### c.2 Where would Phase 5 wire the cron-fire callback?

The wiring point is at `src/cron/isolated-agent/run.ts` IMMEDIATELY AFTER `await runPrompt(commandBody)` returns at line 619 — right before line 624 acceptance/delivery branches. At that seam:

- `runResult` is populated;
- `acceptanceOutcome` evaluated (line 781-832) — `subsequentPushStatus='pushed'` should be marked BEFORE `dispatchCronDelivery(...)` at `:873` (parity with reminder-fire-callback `markFired` BEFORE `deliveryDispatch` at `:149-181`);
- `resolvedDelivery.channel` and `resolvedDelivery.to` are available (line 152-156).

**Concrete Phase 5 wiring sketch**:
```ts
// src/cron/isolated-agent/run.ts — INSERT between lines 832 and 873
if (cronJobIsPersistentWorker(params.job)) {
  const callbackResult = await firePersistentWorkerSubsequentPush({
    workerRunId: cronSession.sessionEntry.sessionId,
    ownerIdentityId: resolveOwnerIdentityFromSessionEntry(cronSession.sessionEntry),
    workerRunStore: deps.workerRunStore,
    deliveryDispatch: makeDeliveryDispatchFn({...}),
    logger: defaultRuntime.log,
  });
  // ... structured envelope handling ...
}
```

The actual identity-resolver helper does NOT exist yet (`resolveOwnerIdentityFromSessionEntry` is illustrative; Phase 5 introduces it OR re-uses `resolveAgentOutboundIdentity(cfg, agentId)` from `src/infra/outbound/identity.ts` which is REUSED at `delivery-dispatch.ts:328`).

---

## §d. `executionMode='persistent_worker'` registry

Confirmed all 11 anchor lines from sub-plan frontmatter §1 todo Phase 1 against `src/platform/decision/task-classifier.ts` (HEAD `7225308ccb`):

| Line | Function/Block | What |
|---|---|---|
| 80 | `executionMode` JSON-schema enum value | One of 7 enum values for `executionMode` field; constants emitted in IntentContractor result schema. |
| 148 | Same block, second `executionMode` enum block (variant for primaryOutcome refinement) | Mirror of L80 in the secondary schema variant. |
| 197 | LLM-prompt-side enumeration documentation comment | Documentation block listing operations: `persistent_worker: create/spawn a persistent worker, named subagent, background/follow-up session...`. |
| 393 | TS type alias `ExecutionMode = ...` | `\| "persistent_worker"` union member. |
| 405 | TS type alias `PrimaryOutcome = ...` | `\| "persistent_worker"` union member. |
| 435 | Validation array (cuts down to closed enum at runtime) | `"persistent_worker"` literal in `EXECUTION_MODE_VALUES`. |
| 476 | Validation array (`PRIMARY_OUTCOME_VALUES`) | `"persistent_worker"` literal. |
| 760 | `if (contract.executionMode === "persistent_worker" \|\| ...)` | Routing branch in `inferPrimaryOutcomeFromContract(...)` — sets `primaryOutcome = "persistent_worker"` (line 764). |
| 800 | `if (primaryOutcome === "persistent_worker") {` | Decision-tree branch in classifier output projection. |
| 915 | `case "persistent_worker":` | switch arm in classification narrative-builder. |
| 1069 | `if (contract.executionMode === "persistent_worker" \|\| ...)` | Second routing branch (recipe-routing-hints projection). |

Plus 3 supplementary anchors discovered (NOT in sub-plan list, but relevant for Phase 7 acceptance test framing):

| Line | What |
|---|---|
| 1136 | switch arm in `recipe-routing-hints` continuation kind. |
| 1185 | Combined predicate `executionMode === "persistent_worker" \|\| target === "persistent_session"` for routing-hint annotation. |
| 1250 | Routing-hint shape branch keyed off persistent_worker. |
| 1271 | Telemetry/debug projection of `primaryOutcome === "persistent_worker"`. |

The classifier surface treats `executionMode='persistent_worker'` as a stable, closed-set literal; Bug F does NOT extend it. Phase 7 `[commitment] persistent_worker.subsequent_push effectFamily=communication operationKind=push decision=kernel` log-line emission is keyed on the affordance (not the classifier result), so no churn on this surface.

---

## §e. Slice E episodic-memory-event confirmation

`src/platform/memory/episodic-memory-event.ts` declares `EpisodicEffectFamily` at lines 45-56:

```ts
export type EpisodicEffectFamily =
  | "persistent_session"
  | "subagent"
  | "reminder"
  | "artifact"
  | "task"
  | "policy_approval"
  | "policy_budget"
  | "policy_role"
  | "policy_retry"
  | "policy_escalation"
  | "repo";
```

**No `persistent_worker.push` STUB exists** — the closest semantic neighbours are:

- `subagent` — `SubagentCreatedPayload` at `:95-99` (STUB, slice G consumer; emit-site not yet lit). `subagent.created` payload carries `{subagentId, displayName, occurredAt}` — completion is NOT modelled here.
- `reminder` — `ReminderSetPayload` at `:105-109` (STUB, slice F/J consumer; emit-site not yet lit). Slice K Phase 5 added the `reminder-fire-callback` adapter but did NOT wire an episodic emit-site for `reminder.fired`.

**Conclusion (sub-plan frontmatter §1 todo Phase 1 (e))**: `persistent_worker.push` is **NEW effect, not STUB-light**.

Bug F's effect falls under `COMMUNICATION_EFFECT_FAMILY` (sub-plan §3.1: «REUSE existing `COMMUNICATION_EFFECT_FAMILY`»). Episodic record-keeping for the push event is OUT OF SCOPE for v1 (sub-plan §0/§5 — episodic surface widening explicitly excluded). Future episodic-emit hook would land under a `subagent.completed` STUB extension (slice G consumer scope), NOT here.

**Phase 5 architectural decision**: do NOT widen `EpisodicEffectFamily`. The `persistent_worker.subsequent_push` effect lives entirely on the `WorldStateSnapshot.persistentWorkerReports` slice (NEW per sub-plan §3.2) + affordance entry in `affordance-registry.ts` (NEW per sub-plan §3.1). Frozen-layer touches stay additive (`affordance-registry.ts` extension only — slice K P4 / Cutover-4 P4 precedent).

---

## §f. Cross-identity isolation reality

### f.1 Today, where does cron-fire carry `wrappedScopeIdentityId`?

**Single LIT site**: `src/cron/isolated-agent/reminder-fire-callback.ts:163` —

```ts
const payload: ReminderFireDispatchPayload = {
  reminderId: record.reminderId,
  wrappedScopeIdentityId: record.ownerIdentityId,   // line 164
  fireAt: record.fireAt,
  ...
};
```

The `wrappedScopeIdentityId` is sourced from the persisted `ReminderRecord.ownerIdentityId` field — NEVER from caller-supplied input. The `ReminderStore.get(reminderId, identityId)` predicate at `:127` filters by identity AT THE STORAGE LAYER (cross-identity reads return `undefined` — defense-in-depth, identical wording in the slice K Phase 6 SQLite impl).

### f.2 Does `reminder-fire-callback.ts` use it? At which line?

YES. Anchored:

| Line | What |
|---|---|
| `:106-109` | `if (!isIdentityId(ownerIdentityIdRaw)) return { ok: false, reason: "identity_unavailable" };` — anonymous fail-closed at entry. |
| `:127` | `record = await input.reminderStore.get(reminderId, identityId);` — store predicates on identity (cross-identity get returns undefined). |
| `:135-141` | `if (!record) return { ok: false, reason: "record_missing" };` — defense-in-depth on cross-identity miss. |
| `:150` | `await input.reminderStore.markFired(reminderId, identityId);` — mark-before-dispatch keyed on identity. |
| `:162-169` | `wrappedScopeIdentityId: record.ownerIdentityId` — re-injected from persisted record (NOT caller-supplied). |
| `:172` | Logger emits `[reminder-fire-callback] reminderId=... wrappedScopeIdentityId=... channel=... to=...`. |

### f.3 Does persistent-worker push today use it? Where is the gap?

**NO**. Today's persistent-worker push path:

1. `runCronIsolatedAgentTurn(params)` does NOT receive `IdentityId` — it receives `params.job: CronJob` and resolves session via `resolveCronSession(...)` (`run.ts:250-257`), agent via `resolveDefaultAgentId(...)` (`:201-215`). Neither projects `IdentityId` onto a kernel-visible payload.
2. `dispatchCronDelivery({...})` (`delivery-dispatch.ts:299`) calls `resolveAgentOutboundIdentity(cfg, agentId)` at `:328` — this returns an `OutboundIdentity` (account/persona shape), DISTINCT from `IdentityId` (slice E identity-id brand at `src/platform/identity/identity-id.ts`).
3. `SubagentRunRecord` does NOT carry `ownerIdentityId` (see §c.1). `CronJob.payload` (kind `agentTurn`) does NOT carry `ownerIdentityId` either.
4. `OutboundCoalescer.bypass({reason:'cron_persistent_worker', body, deliver})` (today's path) takes `BypassReason | ReplyPayload | BlockReplyDeliver` only — no `IdentityId` at all.

**Gap explicitly enumerated** (Phase 5 closes all four):

| Gap | Today | Phase 5 fix |
|---|---|---|
| `WorkerRunRecord.ownerIdentityId` field | MISSING | Additive field on `SubagentRunRecord` (or NEW `WorkerRunRecord` — see §c.1). Persisted at spawn time. |
| `WorkerRunRecord.subsequentPushStatus` field | MISSING | Additive `'pending' \| 'pushed' \| 'failed'` field; mark `'pushed'` BEFORE dispatch (parity with reminder-fire-callback markFired). |
| Storage-layer identity predicate | NOT enforced | `WorkerRunStore.get(workerRunId, identityId)` returns `undefined` for cross-identity; SQL `WHERE identity_id = ?` (slice K SQLite impl precedent). |
| Cron-fire callback identity injection seam | NONE | NEW `firePersistentWorkerSubsequentPush({workerRunId, ownerIdentityId, ...})` at `src/cron/isolated-agent/persistent-worker-push-fire-callback.ts`. Constructs payload with `wrappedScopeIdentityId = record.ownerIdentityId` from PERSISTED record. |

Phase 5 is the ONLY phase that touches cross-identity isolation; Phases 2-4 prepare types/affordance/adapter without runtime wiring.

---

## §g. Operator-impact estimate

**Available evidence today** (HEAD `7225308ccb`):

- Sub-plan §1.1 cites `terminals/466813.txt:619-820` as live-evidence of a TG persistent_worker `open-models-daily` push. That terminal log file is NOT checked into the repo (the directory does not exist under `god-mode-core/terminals/`); it is a maintainer-side capture referenced for the live-verify runbook.
- No checked-in gateway logs contain `[outbound-coalescer] event=bypassed reason=cron_persistent_worker`. A grep across `god-mode-core/**/*.log` (40 untracked log files in dev tree) returned zero hits — none of the recent gateway sessions exercised the persistent-worker push path during their captures.
- The `cron_persistent_worker` bypass entry was carved out at NEW-C SLICE COMPLETE (`outbound-coalescer-types.ts:91`, `:75` audit-block comment) explicitly for Bug F to light. It has been a STUB since NEW-C P6 merged.

**Quantitative estimate (qualitative — we have no telemetry sample)**:

- Production cron jobs with `executionMode='persistent_worker'` run on operator-defined schedules (typical: daily, weekly). One TG operator with one persistent_worker firing daily produces 1 push/day = ~30 bypassed-coalescer events / month / worker.
- The `open-models-daily` worker referenced in the sub-plan is one such; per maintainer telemetry referenced in `commitment_kernel_subagent_await.plan.md:128`, multiple persistent_worker spawns can co-exist per operator session.
- After Bug F lands, every one of those events shifts from `event=bypassed reason=cron_persistent_worker` to `event=committed runId=<cron:job-id>` — tradable telemetry surface plus done-predicate enforceability.

**Phase 7 acceptance gate** (sub-plan frontmatter §1 todo Phase 7): grep ZERO `[outbound-coalescer] event=bypassed reason=cron_persistent_worker` lines after Phase 6 lands, against a live-verify gateway run. The historical-occurrence count is non-zero by construction (sub-plan §1.1 evidence), but unmeasured because the bypass slot has carried no telemetry-uplift work to date.

---

## §h. Identified gaps — concrete checklist for Phases 2-7

### Phase 2 — Types

- [ ] NEW branded `PersistentWorkerPushTriggerId = string & { __brand: 'PersistentWorkerPushTriggerId' }` + `isPersistentWorkerPushTriggerId` guard. Brand enforces #16 separation from `EffectId` and from `WorkerRunId`.
- [ ] NEW `WorkerReportRef = { workerRunId: string, ownerIdentityId: IdentityId, completedAt: ISO-8601, channel: ChannelId, to: string, content: string }` closed shape.
- [ ] NEW `EffectId` constant `PERSISTENT_WORKER_SUBSEQUENT_PUSH_EFFECT = 'persistent_worker.subsequent_push' as EffectId` (cast at module init — slice K Phase 2 precedent).
- [ ] NEW `PreconditionId` constant `WORKER_REPORT_AVAILABLE_PRECONDITION = 'worker.report.available' as PreconditionId`.
- [ ] NEW Zod schema `WorkerReportRefSchema.strict()`: `workerRunId` non-empty trimmed; `completedAt` ISO-8601 (`ISO8601_PATTERN` reuse from `episodic-memory-event.ts:389-390`); `content` length-capped (slice K Phase 2 reminder-content cap precedent at 4000 chars); `channel` validated through `isChannelId` guard; `to` structural enum-or-trimmed.
- [ ] Tests fail-first ~6: round-trip; brand discipline (#16); reject empty `workerRunId` / malformed `completedAt` / oversized `content`; identity-mismatch reverse.

### Phase 3 — Affordance + done-predicate

- [ ] EXTEND `affordance-registry.ts`: NEW `PERSISTENT_WORKER_SUBSEQUENT_PUSH_AFFORDANCE_ENTRY` entry (additive — slice K P4 / Cutover-4 P4 precedent at `affordance-registry.ts:760-789`). Fields: `effectFamily=COMMUNICATION_EFFECT_FAMILY`, `effect=PERSISTENT_WORKER_SUBSEQUENT_PUSH_EFFECT`, `operationKinds=['push']` (CONFIRM whether `'push'` is a valid `OperationHint["kind"]` literal — IF NOT, downgrade to `'create'` per Phase 1 audit recommendation), `target` matcher accepts `kind === 'external_channel' || kind === 'unspecified'`, `requiredPreconditions=[IDENTITY_RESOLVED_PRECONDITION, WORKER_REPORT_AVAILABLE_PRECONDITION]`, `riskTier='medium'`, `defaultBudgets={maxLatencyMs:15_000, maxRetries:0}` (mutation idempotency unsafe — Cutover-4 precedent).
- [ ] NEW `done-predicate-persistent-worker-push.ts` reads `state.persistentWorkerReports?.delivered[]` + `expectedDelta.persistentWorkerReports?.added[]`. Closed missing-key set: `persistent_worker_reports.slice_absent` / `persistent_worker_reports.delivered.empty` / `worker_report_missing:<id>` / `worker_report_status_unexpected:<id>:<status>`. NEVER throws (#15).
- [ ] APPEND to `DEFAULT_AFFORDANCES` array at `affordance-registry.ts:791-808` (additive — index after `REMINDER_SET_AFFORDANCE_ENTRY`).
- [ ] Tests fail-first: registry extended (~4 cases); `findByFamily('communication', target={kind:'external_channel'}, op={kind:'push'})` resolves correctly + does NOT collide with `ANSWER_DELIVERED_AFFORDANCE_ENTRY` (`affordance-registry.ts:111` — same family, different operationKind); predicate ~8 cases over closed missing-key set.

### Phase 4 — Runtime adapter

- [ ] NEW file `src/platform/persistent-worker/persistent-worker-push-runtime-adapter.ts` (NEW directory).
- [ ] Export `runPersistentWorkerSubsequentPush({collector, sessionId, turnId, workerRunId, ownerIdentityId, completedAt, channel, to, content, deliveryDispatch, logger}) -> Promise<PersistentWorkerPushResult>`.
- [ ] Closed failure-set: `transport_error` / `identity_unavailable` / `channel_invalid` / `worker_run_missing` / `observer_unavailable` / `report_already_pushed` / `dispatch_failed` / `internal_error`. NEVER throws (#15).
- [ ] Pure functional: `deliveryDispatch` injected (closed-shape function — parity with `DeliveryDispatchFn` at `reminder-fire-callback.ts:60-62`).
- [ ] Logger emits `[persistent-worker-push-runtime-adapter] runPersistentWorkerSubsequentPush workerRunId=<...> identityId=<...> channel=<...> to=<...> result=<ok|fail:<reason>>`.
- [ ] Tests fail-first ~10: success path; identity_unavailable reverse; transport_error reverse; report_already_pushed idempotency reverse; dispatch_failed mapped from underlying envelope; logger never throws on adapter return; observer never invoked when identity_unavailable; closed-shape `to` rejection; NaN/oversized content tolerance.

### Phase 5 — Cron-fire callback wiring + WorldState slice + observer

- [ ] EXTEND `WorldStateSnapshot` (`src/platform/commitment/world-state.ts`) with NEW optional slice `persistentWorkerReports?: { delivered: readonly DeliveredWorkerReportRecord[], failed: readonly FailedWorkerReportRecord[] }` (additive optional field — slice K Phase 3 precedent at `world-state.ts:326`). The frozen-layer touch is additive ONLY; consumers that don't read this slice are unaffected.
- [ ] NEW `PersistentWorkerReportObserver` (`src/platform/commitment/persistent-worker-report-world-state-observer.ts`) — process-scoped, per-(sessionId, turnId) keying, last-writer-wins on `workerRunId`, `perTurnLimit=2` (daily push cross-turn rare).
- [ ] WIRE observer into `createDefaultMonitoredRuntime` (`src/platform/commitment/production-runtime-defaults.ts` or `monitored-runtime.ts`).
- [ ] EXTEND `SubagentRunRecord` (`src/agents/subagent-registry.types.ts`) with optional `ownerIdentityId?: IdentityId` + `subsequentPushStatus?: 'pending' | 'pushed' | 'failed'` fields (additive — see §c.1, §f.3 above).
- [ ] NEW callback `src/cron/isolated-agent/persistent-worker-push-fire-callback.ts` — invoked from `cron/isolated-agent/run.ts` worker-completion seam (between `:832` and `:873`, see §c.2).
- [ ] Cross-identity defense: `WorkerRunStore.get(workerRunId, identityId)` returns `undefined` cross-identity; `wrappedScopeIdentityId = record.ownerIdentityId` (NEVER caller-supplied); `markPushed` BEFORE `deliveryDispatch` (idempotent on retry); `dispatch_failed → record stays 'pushed'` (no infinite replay, parity with reminder-fire-callback `:149-181`).
- [ ] Logger emits `[persistent-worker-push-fire-callback] workerRunId=<...> wrappedScopeIdentityId=<...> channel=<...> to=<...> result=<...>`.
- [ ] Tests fail-first ~12: cross-identity defense; markPushed-before-dispatch arm-order; dispatch_failed → record stays `pushed`; identity_mismatch reverse; logger emit; clock-mock determinism; perTurnLimit; sessionId isolation; etc.

### Phase 6 — `OutboundCoalescer` bypass-reason removal + coverage guard

- [ ] EDIT `src/infra/outbound/outbound-coalescer-types.ts`: drop `"cron_persistent_worker"` from `BYPASS_REASONS` tuple (length 7→6) at `:91`. `BypassReason` union narrows automatically.
- [ ] UPDATE comment block at `:73-87` (audit §e mapping): mark `cron_persistent_worker` as «REMOVED at Bug F slice (lit by `persistent_worker.subsequent_push` affordance); persistent-worker pushes now flow through `OutboundCoalescer.register({turnId, channelKey, kind:'final'})` like every per-turn user-facing path».
- [ ] EDIT `src/infra/outbound/outbound-coalescer-bypass.test.ts`:
  - Update positive `BYPASS_REASONS` shape assertion at `:73-86` (length 7→6).
  - ADD reverse test: `bypass({reason:'cron_persistent_worker', ...})` rejected with `unknown bypass reason` error (parity with rogue-string reject at `:129-153`).
  - ADD positive test: persistent-worker push → `event=committed`.
- [ ] UPDATE audit doc `extensions/AUDIT-outbound-coalescer.md:230-231` E2 row: status from «deferred — emits today via cron» → `LIT (Bug F slice CLOSED)`.
- [ ] Acceptance grep: zero `[outbound-coalescer] event=bypassed reason=cron_persistent_worker` log lines after Phase 6 (live-verify Phase 7).

### Phase 7 — Acceptance + log-line evidence + live-verify runbook

- [ ] NEW `src/platform/persistent-worker/__tests__/persistent-worker-push.acceptance.test.ts` — ~10 cases (sub-plan frontmatter §1 todo Phase 7).
- [ ] NEW `extensions/RUNBOOK-persistent-worker-push.md` — maintainer-facing runbook for staging/production verification (parity with `RUNBOOK-freshness-live-verify.md`).
- [ ] Live-verify (REQUIRED — invariant #15): gateway restart + 1 maintainer-side persistent-worker spawn + cron-fire boundary + assert structured log lines:
  - `[persistent-worker-push-fire-callback] workerRunId=<...> wrappedScopeIdentityId=<...> channel=<...> result=ok`;
  - `[persistent-worker-push-runtime-adapter] runPersistentWorkerSubsequentPush ... result=ok`;
  - `[outbound-coalescer] event=committed runId=<...>` (NOT `event=bypassed`);
  - `[telegram] sendMessage ok`;
  - `[commitment] persistent_worker.subsequent_push effectFamily=communication operationKind=push decision=kernel`;
  - ZERO `[outbound-coalescer] event=bypassed reason=cron_persistent_worker`;
  - Reverse: anonymous spawn → fail-closed; ZERO push.

---

## §i. NEW structural invariant — Phase 1 audit deliverable

**Invariant (Bug F structural)**:

> **No `runPersistentWorkerSubsequentPush` invocation without `ownerIdentityId` resolved at persisted-`WorkerRunRecord` layer (NOT caller-supplied at the cron callback boundary).**

The callback layer MUST query persisted `WorkerRunStore.get(workerRunId, identityId)` and re-inject `wrappedScopeIdentityId = record.ownerIdentityId` from the persisted record — caller-supplied `ownerIdentityId` is treated as an identity-predicate hint at the storage layer (cross-identity reads return `undefined`, defense-in-depth) but is NEVER trusted as the dispatch payload's `wrappedScopeIdentityId`.

This is the slice K precedent translated to the persistent-worker domain. It closes hard invariant #15 (defense-in-depth) at the cron-fire seam — anonymous fail-closed; identity NEVER cross-leaks from a non-interactive context.

**Lint guard test name**:

```
src/cron/isolated-agent/__tests__/persistent-worker-push-fire-callback.identity-injection.test.ts
  it("wrappedScopeIdentityId === record.ownerIdentityId byte-equal", () => {...});
  it("caller-supplied ownerIdentityId mismatching record returns identity_mismatch", () => {...});
  it("anonymous (empty) ownerIdentityId fails closed with identity_unavailable", () => {...});
```

These three test cases (Phase 5) form the lint guard for the invariant — they MUST be present in the Phase 5 PR's test diff and assertively cover the byte-equality predicate, the caller-supplied-mismatch reverse, and the anonymous-fail-closed reverse.

**Why this invariant is structural, not text-based** (#5 / #6):

- It keys on a typed `IdentityId` brand (`src/platform/identity/identity-id.ts`), validated via `isIdentityId(...)` guard.
- It NEVER reads `RawUserTurn` / `UserPrompt`. The cron-fire callback runs OUTSIDE any user-text reading context (cron-driven; no operator-initiated request triggered the boundary).
- `WorkerRunStore.get(...)` predicates on identity at the SQL layer (slice K Phase 6 precedent — `WHERE identity_id = ?`).
- The dispatch payload's `wrappedScopeIdentityId` is sourced from the persisted record, not from any caller frame.

---

## §j. Frozen-layer integrity — pre-Phase-2 byte-identical baseline

The 5 frozen contracts under `src/platform/decision/`:

| Contract | File | Phase 1 touch |
|---|---|---|
| `TaskContract` | `src/platform/decision/contracts.ts` | NONE |
| `OutcomeContract` | `src/platform/decision/contracts.ts` | NONE |
| `QualificationExecutionContract` | `src/platform/decision/contracts.ts` | NONE |
| `ResolutionContract` | `src/platform/decision/contracts.ts` | NONE |
| `RecipeRoutingHints` | `src/platform/decision/contracts.ts` | NONE |

Phase 1 deliverable is markdown-only. NO source files under `src/platform/decision/` are modified. NO source files under `src/platform/commitment/` are modified. Phase 7 acceptance test will assert byte-identical baseline against `7225308ccb`.

Frozen-layer additive touches in Phases 2-7 are confined to:

- `src/platform/commitment/affordance-registry.ts` — additive entry registration (slice K P4 / Cutover-4 P4 precedent).
- `src/platform/commitment/world-state.ts` — additive optional slice `persistentWorkerReports?` (slice K P3 precedent at `:326`).
- `src/platform/memory/episodic-memory-event.ts` — NO touch (Bug F effect lives outside `EpisodicEffectFamily`; see §e).

NEW files under `src/platform/persistent-worker/` (Phase 4) and `src/cron/isolated-agent/` (Phase 5) are OUTSIDE the frozen layer (per #8 import discipline — they import identity/world-state/ids/Zod/stdlib only).

---

## §k. References

- Master plan §0/§0.5.6/§3 (16 invariants)/§8.5/§16
- Hard invariants `.cursor/rules/commitment-kernel-invariants.mdc`
- Sub-plan `.cursor/plans/commitment_kernel_persistent_worker_push.plan.md`
- `.cursor/plans/commitment_kernel_subagent_result_aggregation.plan.md` (sister sub-plan; first-pass aggregation)
- `.cursor/plans/commitment_kernel_subagent_await.plan.md:128` (Bug F = cron-driven persistent_worker push)
- `.cursor/plans/commitment_kernel_outbound_sanitizer.plan.md:119/361` (Bug F priority=medium)
- `.cursor/plans/commitment_kernel_outbound_coalescer.plan.md` (NEW-C SLICE COMPLETE; bypass slot E2 awaiting Bug F)
- `.cursor/plans/commitment_kernel_self_feedback_loop_fix.plan.md` (persistent_worker semantics + provenance gate)
- `.cursor/plans/commitment_kernel_cron_scheduler.plan.md` (CronService + reminder-fire-callback precedent)
- `.cursor/plans/commitment_kernel_slice_k_reminder.plan.md` (`wrappedScopeIdentityId` injection precedent)
- `extensions/AUDIT-outbound-coalescer.md:231` E2 row (slot awaiting Bug F to light)
- `src/cron/isolated-agent/run.ts:179-920` (cron-fired turn execution)
- `src/cron/isolated-agent/delivery-dispatch.ts:299-637` (REUSED transport)
- `src/cron/isolated-agent/reminder-fire-callback.ts:1-202` (slice K Phase 5 precedent)
- `src/infra/outbound/outbound-coalescer-types.ts:75/91` (bypass slot to remove at Phase 6)
- `src/infra/outbound/outbound-coalescer-bypass.test.ts:73-86/100-176/178-221/223-283` (Phase 6 coverage guard)
- `src/platform/commitment/affordance-registry.ts:760-789` (REMINDER_SET_AFFORDANCE_ENTRY shape — Bug F mirror)
- `src/platform/commitment/effect-family-registry.ts:16/43` (COMMUNICATION_EFFECT_FAMILY REUSED)
- `src/platform/commitment/world-state.ts:326` (scheduledReminders slice precedent)
- `src/platform/decision/task-classifier.ts:80/148/197/393/405/435/476/760/800/915/1069` (`executionMode='persistent_worker'`)
- `src/platform/memory/episodic-memory-event.ts:45-56` (`EpisodicEffectFamily` — Bug F NOT a member)
- `src/agents/subagent-registry.types.ts:6-63` (`SubagentRunRecord` — gap analysis §c.1, §f.3)
- `src/agents/subagent-registry-completion.ts:44-96` (`subagent_ended` lifecycle hook — worker-completion analogue)
- `src/auto-reply/reply/aggregation-policy.ts:11/22-25/144` (first-pass scope clarifier)
- `src/auto-reply/reply/subagent-aggregation.ts:43/162-163` (subagent aggregation)
