---
name: Cron / Scheduler — light reminder.set STUB + reminder write/fire UX
slice: cron-scheduler
status: in_progress
signoff: GRANTED via blanket authorization 2026-05-05
overview: "Cron/Scheduler is the WRITE-side complement to Slice K (recall-side reminder consumer). Lights the slice E typed-but-inert `reminder.set` STUB at `episodic-memory-event.ts` (Cutover-3 P5 / Cutover-4 P5 / Slice F P5 precedents). Architecture: (a) NEW `reminder` family is REUSED — Slice K registered with `allowedOperationKinds=['observe']`; this slice ADDITIVELY widens to `['observe','create']`. (b) NEW `REMINDER_SET_EFFECT='reminder.set' as EffectId` + `REMINDER_SET_AFFORDANCE_ENTRY` (riskTier=medium — state crosses /new + outbound push). (c) NEW `WorldStateSnapshot.scheduledReminders` slice + observer (per-(sessionId,turnId) keying, perTurnLimit=4). (d) NEW `RecordReminderTool` — schema accepts CLOSED `ReminderSetShape={ownerIdentityId, fireAt:ISO-8601, content, deliveryChannel, deliveryTo}` only — NEVER free-form text; LLM-driven temporal-expression resolution INSIDE IntentContractor (#5/#6). (e) NEW `SqliteReminderStore` (slice E P3 SqliteVec precedent + `src/cron/store.ts` migration discipline) keying on `(reminder_id, identity_id)`; survives restart/reset. (f) Cron-fire callback wires existing `CronService.add({schedule:{kind:'at', at:fireAt}, ...})`; on fire, delivered turn carries `wrappedScopeIdentityId = ownerIdentityId` (Slice K precedent — identity NEVER cross-leaks even from non-interactive context). (g) PolicyGate Full integration (rate-limit per-channel-hourly + per-identity-daily; role-based; anonymous fail-closed). (h) `cutoverPolicy` flip: `CUTOVER_2` extended in-place with `{REMINDER_SET_EFFECT, REMINDER_EFFECT_FAMILY}`. Closes bidirectional reminder UX (set + recall + fire); slice K reads what this slice writes."
todos:
  - id: cron-scheduler-phase-1-audit
    content: "Phase 1 — Audit (read-only). Output `extensions/AUDIT-cron-scheduler.md`. Map: existing cron infrastructure (`src/cron/service.ts` CronService class, `src/cron/store.ts` jobs.json + migration, `src/cron/types.ts` `CronSchedule={kind:'at',at}|{kind:'every'}|{kind:'cron'}`, `src/cron/isolated-agent/run.ts` cron-fired turn execution, `src/cron/isolated-agent/delivery-dispatch.ts` REUSED for fire delivery); existing `src/agents/tools/cron-tool.ts` job-management surface (NOT redefined); slice E `reminder.set` STUB at `episodic-memory-event.ts:25/105-109/336-339/427-431` + `memory-write-on-satisfied.ts:87-90` dispatch arm; slice K `REMINDER_EFFECT_FAMILY` registered with `['observe']` only; slice K `WorldStateSnapshot.reminder?.lastQuery` orthogonal to NEW `scheduledReminders` slice (Cutover-3 §2.4 precedent); `EpisodicEffectFamily` member `'reminder'` already typed (slice E P2) — no widening; PolicyGate Full reuse (5 readers landed); cron-fire identity-injection audit (`wrappedScopeIdentityId` slice K precedent); NEW invariant proposal: «no `RecordReminderTool` invocation without `ownerIdentityId` resolved at session-context layer»."
    status: pending
  - id: cron-scheduler-phase-2-effect-allowlist-widen
    content: "Phase 2 — Effect-family allowlist widen + NEW EffectId. ADDITIVE frozen-layer touch (Cutover-3/4 P2 precedent). Single edit to `effect-family-registry.ts`: `REMINDER_EFFECT_FAMILY` allowedOperationKinds `['observe']` → `['observe','create']`. NEW `REMINDER_SET_EFFECT='reminder.set' as EffectId`. NO new family. Tests: registry frozen + push throws; allowedOperationKinds === `['observe','create']` exact; brand discipline (#16 reverse). 5 frozen contracts byte-identical."
    status: pending
  - id: cron-scheduler-phase-3-world-state-slice
    content: "Phase 3 — `WorldStateSnapshot.scheduledReminders` slice + observer (Cutover-3/4 P3 precedent). NEW `ScheduledReminderRecord = {reminderId, ownerIdentityId, fireAt:ISO-8601, content, deliveryChannel, deliveryTo, createdAt, status: 'pending'|'fired'|'cancelled'}`. Extend `WorldStateSnapshot.scheduledReminders?` (orthogonal to slice K `reminder?.lastQuery`). NEW process-scoped `ScheduledReminderObserver` (mirrors Cutover-3/4 observers). Per-(sessionId,turnId) keying, last-writer-wins on `reminderId`, perTurnLimit=4. Wired into `createDefaultMonitoredRuntime`. Zod `.strict()` schema; ISO-8601 via `ISO8601_PATTERN`; `IdentityId` validated; `content` length-capped. Tests: round-trip; per-turn reset; limit; sessionId isolation; last-writer-wins; malformed reject."
    status: pending
  - id: cron-scheduler-phase-4-affordance-and-predicate
    content: "Phase 4 — `REMINDER_SET_AFFORDANCE_ENTRY` + done-predicate. ADDITIVE frozen-layer touch. Affordance: effect=`REMINDER_SET_EFFECT`, target matcher `kind === 'session_state' || kind === 'unspecified'`, operationKinds=`['create']`, requiredPreconditions=`[IDENTITY_RESOLVED_PRECONDITION]` (anonymous fail-closed), riskTier='medium', defaultBudgets={maxLatencyMs:10_000, maxRetries:0} (mutation idempotency unsafe — Cutover-4 precedent). NEW `done-predicate-reminder-set.ts` reads `state.scheduledReminders?.records` + `expectedDelta.scheduledReminders?.added[]`. Closed missing-key set: `scheduled_reminders.slice_absent` / `scheduled_reminders.records.empty` / `reminder_record_missing:<id>` / `reminder_record_status_unexpected:<id>:<status>`. NEVER throws. Tests: registry extended; `findByFamily('reminder', target, op={kind:'create'})` resolves correctly; `findByFamily(.., op={kind:'observe'})` returns slice K's affordance only (branching=2). Per-predicate ~8 cases."
    status: pending
  - id: cron-scheduler-phase-5-tool-and-cron-fire
    content: "Phase 5 — `RecordReminderTool` + cron-fire callback + memory hook. NEW `src/platform/reminder/scheduled-reminder-runtime-adapter.ts`: `recordReminderScheduled({collector, sessionId, turnId, reminderId, ownerIdentityId, fireAt, content, deliveryChannel, deliveryTo})`. Closed failure set: `transport_error`/`identity_unavailable`/`fire_at_invalid`/`fire_at_in_past`/`observer_unavailable`/`reminder_store_unavailable`/`channel_invalid`. NEVER throws. NEW `src/agents/tools/record-reminder-tool.ts` — schema accepts CLOSED `ReminderSetShape` only (NOT free-form `{when, what}` — invariants #5/#6 reverse-test); `ownerIdentityId` injected from session context (NOT user input — slice K P4 precedent); `fireAt` is ISO-8601 (relative resolution UPSTREAM in IntentContractor Phase 7); `deliveryChannel`+`deliveryTo` CLOSED enum + structured target. Implementation: resolve IdentityId; persist via Phase 6 `ReminderStore.schedule`; register cron via existing `CronService.add({schedule:{kind:'at', at:fireAt}, payload:..., delivery:{mode:'announce', channel:..., to:...}})`. NEW cron-fire callback `src/cron/isolated-agent/reminder-fire-callback.ts`: load record, mark status='fired', construct delivery with `wrappedScopeIdentityId = record.ownerIdentityId` (slice K precedent), call existing `deliveryDispatch` (REUSE, no fork). NEW `recordReminderOnCommitmentSatisfied.ts` (sibling of E/F/Cutover-3/Cutover-4 hooks): on satisfied + `effectFamily=reminder` + `effectId=reminder.set`, emit `EpisodicMemoryEvent {effectFamily:'reminder', payload: ReminderSetPayload}` — slice E `reminder.set` STUB LIT first time. Wired through `memory-wiring.ts` fan-out. Tests: adapter + tool (free-form rejection reverse + identity injection) + cron-fire callback (clock mocked) + hook ~12 cases."
    status: pending
  - id: cron-scheduler-phase-6-persistent-store
    content: "Phase 6 — `SqliteReminderStore` persistent storage (slice E P3 SqliteVec precedent for schema discipline + `src/cron/store-migration.ts` precedent). NEW interface `ReminderStore` at `src/platform/reminder/reminder-store.ts`: `schedule(record)` / `markFired(reminderId)` / `cancel(reminderId, identityId)` / `list({identityId, status?, fireBefore?})` / `get(reminderId, identityId)` — every read predicates on `identity_id = ?`. NEW `InMemoryReminderStore` (test impl) + `SqliteReminderStore` (production at `~/.openclaw/reminders.sqlite`). Schema: `CREATE TABLE reminders (reminder_id TEXT PRIMARY KEY, identity_id TEXT NOT NULL, fire_at TEXT NOT NULL, content TEXT NOT NULL, delivery_channel TEXT NOT NULL, delivery_to TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','fired','cancelled')), created_at TEXT NOT NULL, INDEX idx_identity_fire_at (identity_id, fire_at))`. Migration v1→v2 stub (forward-compat). On startup, rehydrate pending → register cron callbacks (parity with `CronService.start()` rehydration). Tests: round-trip; identity isolation (operator A's list NEVER returns operator B's); `fire_at` filter; status-transition (pending→fired one-way; pending→cancelled one-way; fired→pending illegal — schema CHECK); rehydration; `IDENTITY_RESOLVED_PRECONDITION` enforced."
    status: pending
  - id: cron-scheduler-phase-7-classifier-and-policy-gate
    content: "Phase 7 — IntentContractor classifier extension + PolicyGate Full integration. ADDITIVE frozen-layer touch. (a) Prompt-hint allowlist: existing `reminder` family already in allowlist (slice K P5); operationKind `create` distinguishes from `observe`. (b) NEW structured prompt slot `<reminder_set_intent>` (XML block carrying `{fireAt: ISO-8601, content: string, deliveryChannel?: ChannelId, deliveryTo?: string}` — populated by LLM during classification with temporal-expression → ISO-8601 conversion + content extraction as STRUCTURED output, NOT regex on raw text — invariant #5 hard line, slice K P5 `<recall_window>` precedent). PolicyGate Full integration (Cutover-4 P6 precedent): every `reminder.set` consults all 5 stages: Stage 2 (Approval — high-cardinality reminders >50 pending require approval); Stage 3 (Budget — `policy.budgets.reminder.set.perChannelHourly=10`, `perIdentityDaily=50`); Stage 4 (Role — maintainer/developer→all, viewer→none, anonymous→fail-closed); Stage 5 (Retry — ZERO retries on writes); Stage 6 (Escalation — denial fans out). NO new orthogonal `*POLICY_REASONS` tuples. Frozen layer additive only. Tests: contractor 1-shot fixture for «напомни мне через 30 минут позвонить клиенту X» produces `desiredEffectFamily=reminder` AND `operationKind=create` AND `constraints.fireAt=<+30min ISO-8601>` AND `constraints.content='позвонить клиенту X'`; reverse «какие у меня запланированы напоминания?» → `operationKind=observe` (slice K path); reverse anonymous → empty; PolicyGate per-stage denial fixtures + chain ordering."
    status: completed
  - id: cron-scheduler-phase-8-cutover-and-acceptance
    content: "Phase 8 — `cutoverPolicy` flip + acceptance + Telegram live-verify (Cutover-3/4/Slice K precedent). Extend `CUTOVER_2` in-place with `{effect: REMINDER_SET_EFFECT, effectFamily: REMINDER_EFFECT_FAMILY}` (length 13→14). Production-routing flip: kernel-derived for reminder.set turns when chain passes + commitment satisfies + cutover-on. NEW `src/platform/reminder/__tests__/cron-scheduler.acceptance.test.ts` (~10 cases): (1) «напомни мне через 30 минут позвонить клиенту X» → kernel-derived; record persisted; cron callback registered. (2) «через неделю отправь Y предложение» → reminder.set with fireAt=+7d. (3) Cron-fire path: clock advances → fire callback delivers Telegram message; reminder marked status='fired'. (4) Cross-test with slice K: set reminder → query «какие у меня запланированы?» → slice K returns just-set entry. (5) Reverse: anonymous → fail-closed; ZERO writes. (6) Reverse: cutover-off → legacy. (7) Reverse: viewer-role → RolePolicy denies + escalation. (8) Reverse: budget exceeded → BudgetPolicy denies. (9) Reverse: identity isolation (A↔B). (10) Reverse: `fireAt in past` → failure `fire_at_in_past`; ZERO cron registration. **Live-verify (REQUIRED — invariant #15)**: gateway restart + 3 Telegram prompts on maintainer: (a) «напомни мне через 2 минуты сказать «test-cron»» → wait 2min → bot pushes. (b) «через 5 минут отправь test-2» → wait 5min → bot pushes. (c) «какие у меня запланированы?» → slice K returns 2 pending. live-verifier asserts: `[commitment] reminder.set effectFamily=reminder operationKind=create decision=kernel`; `[scheduled-reminder-runtime-adapter] recordReminderScheduled reminderId=<...> fireAt=<ISO> identityId=<...>`; `[reminder-store] schedule reminderId=<...>`; `[memory-write-on-satisfied] effectFamily=reminder wrote=true` (slice E `reminder.set` STUB LIT first time); `[cron-service] add schedule.kind=at`; on fire — `[reminder-fire-callback] reminderId=<...> wrappedScopeIdentityId=<...>`; `[telegram] sendMessage ok`; `[policy-gate] event=role_checked stage=4 effect=reminder.set allowed=true`; ZERO `[reminder-store] list` WITHOUT identity_id predicate. Reverse: viewer/anonymous denied. Slice CLOSED."
    status: pending
isProject: false
---

# Cron / Scheduler — light reminder.set STUB + reminder write/fire UX

## 0. Provenance

| Field | Value |
| --- | --- |
| Sub-plan of | `.cursor/plans/commitment_kernel_v1_master.plan.md` (§16 deferred Cron/Scheduler mention) |
| Inherits | 16 hard invariants from `.cursor/rules/commitment-kernel-invariants.mdc` |
| Predecessors | Slice D/E/F/I CLOSED. Cutover-3/Cutover-4 SLICE COMPLETE. PolicyGate Full SLICE COMPLETE. Slice K SLICE COMPLETE (registered `reminder` family with `['observe']`). NEW-A/B/C/D SLICE COMPLETE. |
| Trigger | Master §16 Cron/Scheduler deferred. Slice K complete this session (recall-side); cron/scheduler is WRITE-side complement that lights `reminder.set` STUB. Closes bidirectional reminder UX. |
| Out of scope | Reminder cancel UX (separate slice if demand); edit/snooze (v2); recurrence (`every`/`cron` exposure — kept minimal v1); cross-tenant (v2); routing existing `cron-tool.ts` through kernel (different concern); Slack/Discord live-verify (Telegram-only); modifying 5 frozen contracts; `MemoryStore` interface widening; `EpisodicEffectFamily` widening (additive emit only). |
| Maintainer signoff | GRANTED via blanket authorization 2026-05-05 |

## 1. Hard invariants this slice keeps

- **#1**: `ExecutionCommitment` tool-free.
- **#2**: Structural selection only. `IDENTITY_RESOLVED_PRECONDITION` is structural resolver.
- **#3**: Production success requires `commitmentSatisfied=true`. Done-predicate over `WorldStateSnapshot.scheduledReminders.records`.
- **#4**: State-after via `ScheduledReminderObserver`.
- **#5, #6**: NO new readers of raw user text. Temporal-expression resolution inside IntentContractor LLM (sole sanctioned). `RecordReminderTool` schema rejects free-form `{when, what}`; closed `ReminderSetShape` only.
- **#7**: ShadowBuilder unchanged.
- **#8**: Module `src/platform/reminder/` (slice K shared) imports only identity/memory/ids/Zod/stdlib. Adapter+tool+cron-fire callback+hook OUTSIDE frozen layer.
- **#9, #10**: Done-predicate text-blind; closed missing-key set; never throws.
- **#11**: 5 frozen contracts BYTE-IDENTICAL. Frozen-layer touches additive only.
- **#12**: NO emergency phrase patches.
- **#13**: `terminalState` ⊥ `acceptanceReason`.
- **#14**: `ShadowBuildResult` unchanged.
- **#15**: Blanket signoff. Live-verify mandatory at Phase 8. Defense-in-depth: identity predicate at storage layer; anonymous fail-closed; cron-fire respects `wrappedScopeIdentityId`; identity NEVER cross-leaks even from non-interactive context.
- **#16**: `EffectFamilyId` ⊥ `EffectId` preserved. NEW `REMINDER_SET_EFFECT` brand cast at module init. `REMINDER_EFFECT_FAMILY` reused (slice K).

**NEW structural invariant (Phase 1 audit §i)**: «no `RecordReminderTool` invocation without `ownerIdentityId` resolved at session-context layer (NOT user-input)». Lint rule `lint:reminder:no-tool-invocation-without-injected-identity`.

## 2. Audit findings (TO BE FILLED IN BY PHASE 1)

> Phase 1 produces `extensions/AUDIT-cron-scheduler.md`. Sketches:

### 2.1. Existing cron infrastructure
- `src/cron/service.ts` — `CronService` class
- `src/cron/store.ts` — jobs.json + migration via `src/cron/store-migration.ts`
- `src/cron/types.ts` — `CronSchedule={kind:'at'|'every'|'cron'}`
- `src/cron/isolated-agent/run.ts` — cron-fired turn execution
- `src/cron/isolated-agent/delivery-dispatch.ts` — REUSED for fire delivery
- `src/agents/tools/cron-tool.ts` — existing job-management tool (NOT redefined)

### 2.2. Slice E `reminder.set` STUB inventory
- `episodic-memory-event.ts:25` (comment), `:105-109` (`ReminderSetPayload`), `:336-339` (event variant), `:427-431` (Zod schema)
- `memory-write-on-satisfied.ts:87-90` (dispatch arm — already routes `effectFamily==='reminder'`)
- Comment expects "slice F / J consumer" — Cron/Scheduler is that consumer

### 2.3. Slice K family registration (predecessor)
`REMINDER_EFFECT_FAMILY` registered with `allowedOperationKinds=['observe']`. Phase 2 widens to `['observe','create']` additively.

### 2.4. WorldState orthogonal slices
Slice K added `WorldStateSnapshot.reminder?.lastQuery`. Cron/Scheduler adds `WorldStateSnapshot.scheduledReminders.records` (orthogonal — different shape, different lifecycle). Cutover-3 §2.4 precedent.

### 2.5. EpisodicEffectFamily already covers reminder
`'reminder'` already in discriminated union (slice E P2). Phase 5 only adds EMIT site.

### 2.6. PolicyGate Full reuse
All 5 readers landed. Phase 7 ADDS config entries only.

### 2.7. Cron-fire identity-injection
Fired turn must carry `wrappedScopeIdentityId = record.ownerIdentityId` (slice K precedent).

### 2.8. NEW invariant
«no `RecordReminderTool` invocation without `ownerIdentityId` resolved at session-context layer».

## 3. Hypothesis

Five forces:
1. Slice K complementarity — recall CONSUMER + write PRODUCER, symmetric.
2. Cutover-3/4 precedent — additive-extension pattern.
3. Slice E STUB ready — typed-but-inert since slice E P2; comment line 25 anticipates this slice.
4. Existing cron infrastructure REUSED — no fork.
5. Identity-scope hard line — wrapped-scope identity injection on cron-fire (slice K precedent).

## 4. Acceptance criteria

1. `reminder` family `allowedOperationKinds === ['observe', 'create']`.
2. `REMINDER_SET_AFFORDANCE_ENTRY` registered. Branching factor=2 (observe + create).
3. `WorldStateSnapshot.scheduledReminders` slice; perTurnLimit=4.
4. Done-predicate closed missing-key set; never throws.
5. `RecordReminderTool` schema rejects free-form `{when, what}`; closed `ReminderSetShape` only.
6. PolicyGate Full integration: 5 stages consulted; denial short-circuits; escalation fans out.
7. Production-routing flip: kernel-derived for `reminder.set` turns.
8. Slice E `reminder.set` slot LIT first time on dev.
9. `SqliteReminderStore` survives restart; rehydration registers cron callbacks; identity isolation at SQL.
10. Cron-fire path: scheduler fires at `fireAt`; `wrappedScopeIdentityId` injected; identity NEVER cross-leaks.
11. Identity scope: A's writes never visible/fireable to B.
12. Frozen-layer integrity: 16 invariants; 5 frozen contracts byte-identical.
13. `EpisodicEffectFamily` UNCHANGED.
14. Telegram live-verify: 3 prompts succeed; reverse runs fail-closed.

## 5. Per-phase tests + log-line evidence

- Fail-first per phase. No `vi.spyOn` on function under test.
- Phase 1: audit md only.
- Phase 2: registry frozen; allowlist widen; brand discipline.
- Phase 3: observer round-trip + per-turn reset + limit + isolation + last-writer-wins.
- Phase 4: `findByFamily('reminder', target, op={kind:'create'})` resolves; branching=2.
- Phase 5: adapter + tool (free-form reverse + identity injection) + cron-fire callback + hook ~12 cases.
- Phase 6: SqliteReminderStore round-trip + identity isolation + status-transition + rehydration.
- Phase 7: contractor 1-shot fixture; PolicyGate per-stage fixtures.
- Phase 8: 10 acceptance cases + Telegram live-verify (3 prompts + cron-fire wait).

Log-line evidence:
- `[commitment] reminder.set effectFamily=reminder operationKind=create decision=kernel`
- `[scheduled-reminder-runtime-adapter] recordReminderScheduled reminderId=<...> fireAt=<ISO>`
- `[reminder-store] schedule reminderId=<...> identity_id=<...>`
- `[memory-write-on-satisfied] effectFamily=reminder wrote=true` (FIRST time)
- `[cron-service] add schedule.kind=at at=<ISO>`
- `[reminder-fire-callback] reminderId=<...> wrappedScopeIdentityId=<...>` (on fire)
- `[telegram] sendMessage ok` (fire delivery)
- `[policy-gate] event=role_checked stage=4 effect=reminder.set allowed=<bool>`

## 6. Implementation notes

- Module `src/platform/reminder/` already exists (slice K). Cron/Scheduler EXTENDS additively.
- Frozen-layer touches all additive (Cutover-3/4 precedent): `effect-family-registry.ts`, `affordance-registry.ts`, `cutover-policy.ts`, `world-state.ts`, `intent-contractor-impl.ts`.
- Adapter+tool+cron-fire callback+hook OUTSIDE frozen layer.
- NO `MemoryStore` interface widening.
- NO `EpisodicEffectFamily` widening.
- Tool schema CLOSED `ReminderSetShape` only.
- `CronService` REUSED via `add({schedule:{kind:'at', at:fireAt}, ...})`; v1 only one-shot reminders.
- Hook lives outside frozen layer (sibling of slice E/F/Cutover-3/Cutover-4 hooks).
- Defense-in-depth: post-execution observer write failure → warn + commitment STILL satisfies; cron-fire callback failure → warn + retry once; identity-resolution failure on fire → drop + warn.
- Channel-agnostic; Telegram-only live-verify.
- NEW lint rule `lint:reminder:no-tool-invocation-without-injected-identity`.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Cross-identity leak on fire | `wrappedScopeIdentityId` injection; `ReminderStore` predicate on `identity_id=?` |
| Time-zone ambiguous | LLM resolves to ISO-8601 with TZ inside contractor; identity profile MAY carry preferred TZ |
| Reminder content sanitization | Slice I sanitizer wraps; observer length-cap prevents bloat |
| `fireAt` in past or wildly future | `fire_at_invalid`/`fire_at_in_past` failure codes; max horizon via budget config |
| Duplicate reminder on retry | maxRetries=0; cron registration idempotent on `reminderId` |
| Reminder after `/new` | Identity-scoped, NOT session-scoped; survives `/new` |
| Bot offline at fire-time | Existing `CronService.start()` rehydration replays missed `at` jobs |
| Anonymous attempting reminder.set | Stage 4 RolePolicy denies; ZERO writes |
| Budget exceeded | Stage 3 BudgetPolicy denies; escalation |
| Identity profile lacks `deliveryTo` | Adapter `channel_invalid` failure; reminder NOT persisted |
| NEW-C double-message on fire | Live-verify flags as observation; not slice's fix |

## 8. Maintainer signoff

GRANTED via blanket authorization 2026-05-05.

## 9. Handoff Log

(Empty — filled by handoff-writer post-phase-merge.)

## 10. Adjacent / deferred

| Item | Why deferred |
|---|---|
| Reminder cancel UX | Separate slice if demand |
| Edit/snooze | v2 |
| Recurrence (`every`/`cron`) | Underlying `CronService` supports; v1 minimal surface |
| Cross-tenant | v2 |
| Reminder analytics | Slice K extension if demand |
| PII redaction | Slice I sanitizer wraps |
| Routing `cron-tool.ts` through kernel | Different concern |
| Slack/Discord live-verify | Telegram-only |
| `MemoryStore` widening | Phase 5 emits via existing `storeEpisodic` |
| `EpisodicEffectFamily` widening | Pure additive emit; member already typed |
| NEW-A/B/C/D | Orthogonal |

## 11. References

- Master plan §16
- Slice K sub-plan (recall-side complement)
- Slice E sub-plan (`reminder.set` STUB origin + SqliteVec precedent)
- Cutover-3/4 sub-plans (LIT precedent + structural template)
- PolicyGate Full sub-plan
- Hard invariants
- `reminder.set` STUB origin: `episodic-memory-event.ts:25/105-109/336-339/427-431`
- Memory hook dispatch arm: `memory-write-on-satisfied.ts:87-90`
- Slice K `REMINDER_EFFECT_FAMILY`: `effect-family-registry.ts`
- Existing cron: `src/cron/service.ts`, `src/cron/store.ts`, `src/cron/types.ts`, `src/cron/isolated-agent/`
- Existing job-management tool: `src/agents/tools/cron-tool.ts`
- Slice E memory hook precedent
- Cutover-3/4 runtime adapter precedents
- Memory wiring fan-out
- Identity surface
- ISO-8601 pattern: `episodic-memory-event.ts:389`
