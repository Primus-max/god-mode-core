---
name: Slice K — Reminder query consumer (cross-effect-family episodic recall)
slice: slice-k-reminder
status: in_progress
signoff: GRANTED via blanket authorization 2026-05-05
overview: "Slice K introduces the operator-facing reminder query — «какой PDF я делал на прошлой неделе?» / «какую ветку создавал в проекте X?» / «какой коммерческий offer я отправил клиенту Y?» — by reading cross-effect-family episodic events from the slice E `MemoryStore` over the LIT payload slots populated by Cutover-3 (artifact), Cutover-4 (repo), Slice F (task), Slice E P5 (persistent_session). The slice is a pure CONSUMER: it neither emits new episodic events nor extends `EpisodicEffectFamily`. Architecture: (a) `IntentContractor` classifies reminder turns into NEW `desiredEffectFamily=reminder` with structural fields `target.kind=unspecified` and `constraints.recallWindow={from?, until?}` + `constraints.effectFamilyFilter[]` populated by the contractor's structured prompt slots — NEVER by regex on raw text (#5). (b) NEW `RecallReminderTool` constructs structured query from intent and joins recall results across families via parallel `MemoryStore.list({identityId, effectFamily})` calls, formats per-family summary. (c) Result returned through existing outbound coalescer (NEW-C surface). (d) Identity-scoped reads only — reminders NEVER cross identities (slice D `IdentityId` keying). Closes operator-facing reminder UX without lighting any new emit slot — every payload it reads was lit by E/F/Cutover-3/Cutover-4."
todos:
  - id: slice-k-phase-1-audit
    content: "Phase 1 — Audit (read-only). Output `extensions/AUDIT-slice-k-reminder.md`. Map: `MemoryStore.recall` vs `MemoryStore.list` semantics; LIT episodic-slot inventory (post-Cutover-4); IntentContractor allowlist current state (5 families post-Cutover-4 P8 → 6 with `reminder`); CRITICAL decision NEW family vs reuse `persistent_session` (audit recommends NEW family because distinct done-predicate + riskTier + budgets + constraints); confirm `SemanticIntent.constraints` is open ReadonlyRecord (slice F audit §2.4 confirmed); outbound-coalescer (NEW-C) status; existing reminder-shaped surfaces grep (cron tools — NOT consumed by slice K); privacy audit (every MemoryStore read predicates on identity_id=?). NO source changes."
    status: pending
  - id: slice-k-phase-2-types
    content: "Phase 2 — Types: `ReminderQueryShape` + `ReminderRecallResult` in NEW module `src/platform/reminder/`. Pure API: `ReminderQueryShape = {ownerIdentityId, recallWindow?:{from?,until?}, effectFamilyFilter?:readonly EpisodicEffectFamily[], textHint?, limit?}` — `from`/`until` ISO-8601 via existing `ISO8601_PATTERN` regex from `episodic-memory-event.ts:389`; `textHint` STRUCTURAL only (NOT raw text — #5). `ReminderRecallResult = {entries: readonly ReminderEntry[], unmatched: readonly UnmatchedReason[]}`. NEW `ReminderQueryShapeSchema` Zod `.strict()`. Tests: schema round-trip; `from <= until` invariant; ISO-8601 rejection; brand discipline (`IdentityId` non-substitutable); empty filter rejection. NO impl in this phase."
    status: pending
  - id: slice-k-phase-3-effect-family-and-affordance
    content: "Phase 3 — `reminder` effect-family + affordance + done-predicate. Frozen-layer ADDITIVE (cutover-3/4 + slice E P6 / F P6 precedents). NEW `REMINDER_EFFECT_FAMILY = 'reminder' as EffectFamilyId` in `effect-family-registry.ts` with `allowedOperationKinds: ['observe']` (read-only #11). NEW `REMINDER_DELIVERED_EFFECT = 'reminder.delivered'`. NEW `REMINDER_DELIVERED_AFFORDANCE_ENTRY` in `affordance-registry.ts`: target matcher `kind === 'unspecified' || kind === 'session_state'`, requiredPreconditions=`[IDENTITY_RESOLVED_PRECONDITION]` (anonymous fail-closed), requiredEvidence=`[{kind:'reminder.queried', mandatory:true}]`, allowedConstraintKeys=`['recallWindow','effectFamilyFilter','textHint','limit']`, riskTier='low', defaultBudgets={maxLatencyMs:8_000, maxRetries:1}, observerHandle={id:'reminder_world_state'}. NEW `donePredicate-reminder-delivered.ts` reads `ctx.stateAfter.reminder?.lastQuery`. Closed missing-key set: `reminder.slice_absent` / `reminder.last_query.empty` / `reminder_query_missing:<id>`. NEVER throws (#9). Tests: registry frozen + push throws; per-predicate ~6 cases incl. invariant #9 sentinel-proxy; `resultCount=0` satisfies (zero entries is success — operator was answered)."
    status: pending
  - id: slice-k-phase-4-tool-and-world-state
    content: "Phase 4 — `RecallReminderTool` + `WorldStateSnapshot.reminder` slice + runtime adapter. NEW `WorldStateSnapshot.reminder?: ReminderWorldState = {lastQuery?: ReminderQueryRecord}` (additive — Cutover-3/4 P3 precedent; perTurnLimit=1). NEW process-scoped `ReminderWorldStateObserver` wired into `createDefaultMonitoredRuntime`. NEW `src/agents/pi-embedded-runner/run/reminder-runtime-adapter.ts`: `recordReminderQueried({collector, sessionId, turnId, queryId, query, resultCount})`. Closed failure set: `transport_error`/`identity_unavailable`/`memory_store_unavailable`/`observer_unavailable`. NEVER throws (#15). NEW `src/agents/tools/recall-reminder-tool.ts` — schema accepts CLOSED `ReminderQueryShape` only (NOT free-form `query: string` — invariants #5/#6 reverse-test); identityId injected from session context (NOT user input). Implementation: resolve `IdentityId`; for each family in `effectFamilyFilter` (default = LIT families `['persistent_session','task','artifact','repo']`; `policy_*` excluded — not user-facing) call `MemoryStore.list({identityId, effectFamily, limit})` and filter by `recallWindow.from <= occurredAt <= recallWindow.until`; optionally union with `MemoryStore.recall({identityId, query: textHint})` semantic-similarity entries; format per-family `summary` via closed reducers; return `ReminderRecallResult` + emit `recordReminderQueried`. NO `MemoryStore` interface widening. Tests: per-family summary reducer; date-window filter; empty-result path; identity isolation (operator A never sees operator B's entries); free-form `query: string` rejected by schema."
    status: pending
  - id: slice-k-phase-5-intent-contractor-extension
    content: "Phase 5 — IntentContractor classifier extension. ADDITIVE frozen-layer touch (cutover-3 P6 / slice E P6 / F P6 precedent). Two changes: (a) prompt-hint allowlist gains `reminder` (current 5 families post-Cutover-4 P8 → 6). (b) NEW structured prompt slots `<recall_window>` (XML block carrying `{from, until}` for the LLM to populate when prompt mentions temporal expression — «на прошлой неделе», «yesterday» — with the LLM doing temporal-expression → ISO-8601 conversion as STRUCTURED classification, NOT regex on user text); `<effect_family_filter>` (XML block listing families implied by prompt — «PDF» → `['artifact']`, «ветка» → `['repo']`). The blocks are populated by the LLM during classification (the contractor IS the only sanctioned raw-text reader — invariant #6); slice K extends the structured surface, not the reader-set. Recall: existing `<memory>` (slice E P6) + `<active_tasks>` (slice F P6) blocks remain unchanged. Tests: contractor 1-shot fixture for «какой PDF я делал на прошлой неделе?» produces `desiredEffectFamily=reminder` AND `constraints.recallWindow={from:'<-7d>',until:'<now>'}` AND `constraints.effectFamilyFilter=['artifact']`; reverse — «привет» produces non-reminder family; reverse — anonymous session produces empty. Temporal-expression conversion is LLM-driven inside the contractor."
    status: pending
  - id: slice-k-phase-6-cutover-and-acceptance
    content: "Phase 6 — `cutoverPolicy` flip + acceptance + live-verify. Extend `CUTOVER_2` in-place (cutover-3/4 precedent) with `{effect: REMINDER_DELIVERED_EFFECT, effectFamily: REMINDER_EFFECT_FAMILY}`. Production-routing flip: cutover-eligible reminder turns → `productionDecision !== legacyDecision`. NEW `src/platform/reminder/__tests__/slice-k-reminder.acceptance.test.ts` (~6 cases): (1) «какой PDF я делал?» → kernel-derived; structured list ordered newest-first. (2) «какую ветку создавал?» → repo family with `kind='branch_created'` filter. (3) Cross-family search «какой коммерческий offer Y?» → artifact + persistent_session. (4) Reverse: anonymous → fail-closed. (5) Reverse: cutover-off → legacy. (6) Identity-isolation reverse-test — operator A NEVER sees operator B's entries. **Live-verify (REQUIRED — invariant #15 + handoff)**: gateway restart + 3 prompts in real Telegram («какой PDF я делал?», «какие ветки я создавал?», «какие у меня были задачи?»). live-verifier asserts: `[commitment] reminder.delivered effectFamily=reminder decision=kernel productionDecision !== legacyDecision`; `[reminder-runtime-adapter] recordReminderQueried queryId=<...> resultCount=<N>`; `[memory-store] list identityId=<...> effectFamily=<F> entries=<N>`; Telegram structured list response per turn; zero memory-store reads WITHOUT identityId predicate. Reverse: anonymous prompt returns structured «cannot recall» response. Slice K CLOSED."
    status: pending
isProject: false
---

# Slice K — Reminder query consumer

## 0. Provenance

| Field | Value |
| --- | --- |
| Sub-plan of | `.cursor/plans/commitment_kernel_v1_master.plan.md` (§0.5.6 + §16 — open frontier «Slice K (reminder)») |
| Inherits | 16 hard invariants from `.cursor/rules/commitment-kernel-invariants.mdc` |
| Predecessors | Slice D, E, F, I CLOSED. Cutover-3 SLICE COMPLETE (LIT `artifact`). Cutover-4 SLICE COMPLETE (LIT `repo`). PolicyGate Full SLICE COMPLETE (LIT `policy_*`, excluded from reminder default filter). Search-Composer pipeline COMPLETE. NEW-A/B/C/D SLICE COMPLETE. |
| Trigger | Master §0.5.6 + §16 — Slice K reminder was deferred behind Cutover-3/4 because reminder reads cross-effect-family episodic events; both cutovers needed to LIT their slots first. With this session's closes, all slots populated; slice K unblocked. |
| Out of scope | Cron-fired reminders / `reminder.set` STUB (separate Cron/Scheduler slice); `EpisodicEffectFamily` widening (slice K is pure CONSUMER); cross-tenant reminder query (v2); PII redaction (slice I sanitizer wraps); persistent reminder-history; `MemoryStore` interface widening. |
| Maintainer signoff | GRANTED via blanket authorization 2026-05-05 |

## 1. Hard invariants this slice keeps

- **#1**: `ExecutionCommitment` tool-free. Affordance references effect id + target shape only.
- **#2**: Structural selection only. No phrase matching.
- **#3**: Production success requires `commitmentSatisfied=true`. Done-predicate over `WorldStateSnapshot.reminder.lastQuery`. **Empty result IS success** — operator asked, was answered with structurally correct «no entries in window».
- **#4**: State-after via `ReminderWorldStateObserver`.
- **#5, #6**: NO new readers of raw user text. Date-range parsing inside `IntentContractor` LLM classification (sole sanctioned raw-text reader). `RecallReminderTool` schema rejects free-form `query: string` field.
- **#7**: ShadowBuilder unchanged.
- **#8**: New module `src/platform/reminder/` imports only identity, memory, ids (type-only), Zod, stdlib.
- **#9, #10**: Done-predicate text-blind; closed missing-key set; never throws.
- **#11**: 5 frozen contracts BYTE-IDENTICAL. Frozen-layer touches additive only.
- **#12**: NO emergency phrase patches.
- **#13**: `terminalState` ⊥ `acceptanceReason`.
- **#14**: ShadowBuildResult unchanged.
- **#15**: Blanket signoff. Live-verify mandatory at Phase 6. Defense-in-depth: identity predicate enforced at storage layer; anonymous → fail-closed.
- **#16**: `EffectFamilyId` ⊥ `EffectId` preserved. NEW `REMINDER_EFFECT_FAMILY` + `REMINDER_DELIVERED_EFFECT` constructed via brand cast at module init.

## 2. Audit findings (TO BE FILLED IN BY PHASE 1)

> Phase 1 produces `extensions/AUDIT-slice-k-reminder.md`. Sketches:

### 2.1. `MemoryStore` surface
`MemoryStore.recall` returns embedding-scored entries. `MemoryStore.list({identityId, effectFamily?, limit?})` returns episodic listings. Reminder needs MULTIPLE families per query — Phase 4 uses N parallel `list()` calls + client-side union. NO interface widening.

### 2.2. LIT slot inventory post-Cutover-4
- `persistent_session.created` (slice E P5)
- `task.{created,completed,cancelled,failed}` (slice F P5)
- `artifact.created` (cutover-3 P5)
- `repo.{branch_created,commit_landed,merge_completed,diff_observed}` (cutover-4 P5)
- `policy_*` (PolicyGate Full P3-P7) — excluded from reminder default filter
- `subagent.created` STUB — never emitted (slice G open)
- `reminder.set` STUB — semantic mismatch (cron-set vs recall-query); slice K does NOT light it

### 2.3. CRITICAL decision: NEW family vs reuse
Audit recommends NEW `reminder` family. Justification:
- Distinct done-predicate (resultCount>=0 vs message-persisted)
- Distinct riskTier (low read-only vs medium write)
- Distinct budgets (8s vs 30s+)
- Distinct constraints (recallWindow + effectFamilyFilter)

### 2.4. `SemanticIntent.constraints` open-record
Confirmed via slice F audit §2.4 — open `ReadonlyRecord<string, unknown>` at `intent-contractor-impl.ts:121`. Reminder constraints pass through additively.

### 2.5. Privacy audit
Every storage-layer read predicates on `identity_id = ?`. `InMemoryMemoryStore`, `SqliteVecMemoryStore`, `LlmExtractorMemoryStore` all enforce. Reminder inherits.

### 2.6. Date-range invariant #5 hard line
Operator prompts contain «на прошлой неделе» / «yesterday» / «last 7 days». Slice K modules NEVER regex-match. Resolution: IntentContractor LLM populates `<recall_window>` block with ISO-8601 strings; Zod `ISO8601_PATTERN` validates at boundary. If LLM fails, fail-soft (no window filter, emit `recall_window_invalid` uncertainty tag).

## 3. Hypothesis

Five forces:
1. Slice E foundation — every read predicates on `identity_id`. Slice K is the FIRST cross-family episodic READER.
2. Cutover-3 + Cutover-4 LIT slot completion — every slot reminder needs is now emitting.
3. Slice F `<active_tasks>` + Slice E `<memory>` precedent — contractor-block pattern for read-side enrichment established. Slice K extends with structured slots.
4. Cutover-3/4 frozen-layer additive pattern — new effect-family + affordance + world-state slice + cutoverPolicy entry are all sanctioned additive. Slice K mirrors field-for-field.
5. Invariant #5 hard line — LLM contractor is the only place temporal-expression resolution happens.

## 4. Acceptance criteria

1. `reminder` effect-family registered with `allowedOperationKinds=['observe']`.
2. `REMINDER_DELIVERED_AFFORDANCE_ENTRY` registered. Done-predicate satisfies on `resultCount >= 0`.
3. `WorldStateSnapshot.reminder` slice populated; perTurnLimit=1.
4. `RecallReminderTool` schema rejects free-form `query: string` (invariant #5/#6 reverse).
5. Production-routing flip: kernel-derived for reminder.delivered turns.
6. Identity scope: operator A never sees operator B's entries.
7. Date-range invariant #5 hard line: NO regex on raw text in slice K modules. Lint guard enforces.
8. Anonymous session fail-closed: structured «cannot recall — no identity» response; ZERO MemoryStore calls.
9. Frozen-layer integrity: 16 invariants preserved; 5 frozen contracts BYTE-IDENTICAL; additive touches only.
10. `MemoryStore` interface UNCHANGED (`git diff` empty).
11. `EpisodicEffectFamily` UNCHANGED (`git diff` empty — pure consumer).
12. Telegram live-verify: 3 prompts succeed end-to-end.

## 5. Per-phase tests + log-line evidence

- Fail-first per phase. No `vi.spyOn` on function under test.
- Phase 1: audit md.
- Phase 2: schema round-trip + brand discipline + `from<=until` invariant.
- Phase 3: registry frozen + done-predicate `resultCount=0` satisfies.
- Phase 4: per-family summary reducer + date-window + identity isolation + free-form rejection.
- Phase 5: contractor 1-shot fixture for «какой PDF я делал на прошлой неделе?» produces structured output.
- Phase 6: 6 acceptance cases + live Telegram verify.

Log-line evidence:
- `[commitment] reminder.delivered effectFamily=reminder decision=kernel`
- `[reminder-runtime-adapter] recordReminderQueried queryId=<...> resultCount=<N>`
- `[recall-reminder-tool] families=<artifact,task,...> identityId=<...> entries=<N>`
- `[memory-store] list identityId=<...> effectFamily=<F> entries=<N>` per family
- `[intent-contractor] desiredEffectFamily=reminder constraints.recallWindow.from=<ISO> until=<ISO>`

## 6. Implementation notes

- NEW module `src/platform/reminder/` imports only identity/memory/ids/Zod/stdlib.
- Frozen-layer touches all additive: `effect-family-registry.ts`, `affordance-registry.ts`, `cutover-policy.ts`, `world-state.ts`, `intent-contractor-impl.ts` (prompt-hint allowlist line + structured blocks).
- NO `MemoryStore` interface widening — Phase 4 uses N parallel `list()` calls + client-side union.
- NO new `EpisodicEffectFamily` member — pure consumer.
- Tool schema CLOSED structured args only (`ReminderQueryShape`); rejects free-form text.
- Hook lives outside frozen layer (sibling of slice E/F/cutover-3/cutover-4 hooks).
- Defense-in-depth: partial-result tolerance (artifact succeeds, repo fails → response includes artifact + emits warning).
- Channel-agnostic; Telegram-only live-verify per handoff scope.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Cross-identity leak | Acceptance #6 reverse-test; lint `lint:reminder:no-memory-store-call-without-identity` |
| Regex on raw user text | Acceptance #7 hard line; lint `lint:reminder:no-raw-text-regex` |
| `policy_*` slot leak to operator | Default filter excludes `policy_*` |
| Empty-result confusion | Done-predicate satisfies `resultCount>=0`; structured response handles empty case |
| Subagent/cron wrapped-identity | Anonymous resolver → fail-closed |
| NEW-C double-message | Live-verify Phase 6 flags as NEW-C-blocking observation; not slice K's fix |

## 8. Maintainer signoff

GRANTED via blanket authorization 2026-05-05. Auto-merge per PR.

## 9. Handoff Log

(Empty — filled by handoff-writer post-phase-merge.)

## 10. Adjacent / deferred

| Item | Why deferred |
|---|---|
| Cron-fired reminders / `reminder.set` lighting | Separate Cron/Scheduler slice |
| Persistent reminder-history | Out-of-scope |
| Cross-tenant reminder | v2 |
| PII redaction | Slice I sanitizer wraps |
| `MemoryStore` interface widening | N parallel calls suffice |
| `EpisodicEffectFamily` extension | Pure consumer |
| NEW-A/B/C/D | Orthogonal; live-verify may flag NEW-C blocker |
| Subagent registry recall (slice G) | STUB never lit |
| Slack/Discord live-verify | Telegram-only per handoff |
| Reminder analytics («сколько PDF в марте?») | Future slice if demand |

## 11. References

- Master plan §0.5.6 + §16
- Hard invariants
- Slice E/F/Cutover-3/Cutover-4/PolicyGate Full sub-plans (template + LIT slot precedents)
- AffordanceRegistry, EFFECT_FAMILY_REGISTRY, WorldState, CutoverPolicy, IntentContractor (frozen-layer additive points)
- TargetRef (frozen, kinds `unspecified`/`session_state` cover reminder targets)
- EpisodicEffectFamily (UNCHANGED by slice K)
- MemoryStore interface (UNCHANGED by slice K)
- Slice E/F/cutover-3/cutover-4 hook precedents
- Memory wiring fan-out helper
- Identity surface
