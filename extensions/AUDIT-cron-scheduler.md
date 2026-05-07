# AUDIT — Cron / Scheduler (Phase 1, read-only)

**Sub-plan**: `.cursor/plans/commitment_kernel_cron_scheduler.plan.md`
**Slice id**: `cron-scheduler`
**Audit branch**: `audit/v1-cron-scheduler-phase-1`
**Predecessor SHA**: `f97b2a02be` (`origin/dev` HEAD; post PR-#255 — Cron/Scheduler sub-plan merged).
**Maintainer signoff**: GRANTED via blanket authorization 2026-05-05.
**Frozen-layer touches in this audit**: NONE (read-only markdown deliverable).

This document maps the source-of-truth state of every surface the Cron/Scheduler slice (Phases 2-8) will read or extend, and confirms each precondition stated in `commitment_kernel_cron_scheduler.plan.md` §2. Every finding is line-anchored against `dev` HEAD `f97b2a02be`.

The Cron/Scheduler slice is the **WRITE-side complement to Slice K** (recall consumer). It lights the slice E `reminder.set` STUB by emitting a structurally typed `EpisodicMemoryEvent` on commitment-satisfied for `effectFamily='reminder' / effectId='reminder.set'` turns and registers a `CronService.add({schedule:{kind:'at', at:fireAt}, ...})` callback. It REUSES the existing `src/cron/` infrastructure (no fork) and ADDITIVELY widens the slice K `REMINDER_EFFECT_FAMILY` allow-list from `['observe']` → `['observe','create']`.

Every WorldState slot, every observer, every adapter, every memory hook, and every cutover entry is structurally orthogonal to slice K's read-only `WorldStateSnapshot.reminder?.lastQuery` slot. The 5 frozen contracts (`TaskContract`, `OutcomeContract`, `QualificationExecutionContract`, `ResolutionContract`, `RecipeRoutingHints`) stay byte-identical.

---

## §a. Existing cron infrastructure (REUSED — no fork)

Cron/Scheduler builds on the production `src/cron/` package. All Phase 5 cron-fire wiring goes through this surface; the slice does NOT introduce a new scheduler.

### a.1 `CronService` class — `src/cron/service.ts`

`src/cron/service.ts:7-60` exposes the public class:

```ts
export class CronService {
  private readonly state;
  constructor(deps: CronServiceDeps) { ... }
  async start() { ... }                                  // line 13
  stop() { ... }                                         // line 17
  async status() { ... }                                 // line 21
  async list(opts?: { includeDisabled?: boolean }) { ... }  // line 25
  async listPage(opts?: ops.CronListPageOptions) { ... } // line 29
  async add(input: CronJobCreate) { ... }                // line 33  ← Phase 5 entry
  async update(id: string, patch: CronJobPatch) { ... }  // line 37
  async remove(id: string) { ... }                       // line 41
  async run(id: string, mode?: "due" | "force") { ... }  // line 45
  async enqueueRun(id: string, mode?: "due" | "force") { ... } // line 49
  getJob(id: string): CronJob | undefined { ... }        // line 53
  wake(opts: { mode: "now" | "next-heartbeat"; text: string }) { ... } // line 57
}
```

Phase 5's `recordReminderScheduled` adapter calls `CronService.add({schedule:{kind:'at', at:fireAt}, payload: {kind:'agentTurn', message: <delivery-payload>}, delivery: {mode:'announce', channel, to}})`. The class-state implementation is delegated to `src/cron/service/ops.ts` and `src/cron/service/state.ts` (out-of-scope for this audit — Phase 5 needs only the public surface above).

### a.2 `CronSchedule` discriminated union — `src/cron/types.ts`

`src/cron/types.ts:11-20`:

```ts
export type CronSchedule =
  | { kind: "at"; at: string }                                                  // line 12
  | { kind: "every"; everyMs: number; anchorMs?: number }                       // line 13
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number };            // line 14-20
```

Phase 5 uses **only** `{kind: "at", at: <ISO-8601>}` for v1 (one-shot reminders). Recurrence (`every`/`cron`) is deferred per sub-plan §10. The `at` field is a string — Phase 5 must validate ISO-8601 BEFORE handing to `CronService.add` (failure code `fire_at_invalid`/`fire_at_in_past` per sub-plan §1 todo for Phase 5).

### a.3 `CronPayload` discriminated union — `src/cron/types.ts:90`

```ts
export type CronPayload = { kind: "systemEvent"; text: string } | CronAgentTurnPayload;
```

`CronAgentTurnPayloadFields` (`src/cron/types.ts:94-111`) carries `message: string`, `model?: string`, `deliver?: boolean`, `channel?: CronMessageChannel`, `to?: string`. Phase 5's cron-fire callback constructs `{kind: "agentTurn", message: <reminder-content>, deliver: true, channel: <ChannelId>, to: <delivery-target>}`.

### a.4 `CronDelivery` shape — `src/cron/types.ts:29-38`

```ts
export type CronDelivery = {
  mode: CronDeliveryMode;          // "none" | "announce" | "webhook"
  channel?: CronMessageChannel;    // ChannelId | "last"
  to?: string;
  accountId?: string;
  bestEffort?: boolean;
  failureDestination?: CronFailureDestination;
};
```

Phase 5 wires `mode: "announce"` (push to a messaging channel — Telegram for live-verify per sub-plan §8). `bestEffort: false` (default) — fire failure is alerted, not silently dropped.

### a.5 Persistent store — `src/cron/store.ts`

`src/cron/store.ts:9-10`:

```ts
export const DEFAULT_CRON_DIR = path.join(CONFIG_DIR, "cron");
export const DEFAULT_CRON_STORE_PATH = path.join(DEFAULT_CRON_DIR, "jobs.json");
```

Public API:
- `resolveCronStorePath(storePath?: string)` — `src/cron/store.ts:60-69`
- `loadCronStore(storePath: string): Promise<CronStoreFile>` — `src/cron/store.ts:71-100`
- `saveCronStore(storePath, store, opts?)` — `src/cron/store.ts:110-155`

Atomicity discipline (lines 138-153): write to `${storePath}.${pid}.${randomBytes(8).toString("hex")}.tmp` first, optional `.bak` snapshot, atomic rename with retries (`renameWithRetry` lines 160-180) handling `EBUSY`/`EPERM`/`EEXIST` for Windows. Phase 6's `SqliteReminderStore` follows the SAME atomicity discipline (sub-plan §6 todo) — it does NOT reuse `jobs.json`; reminders go to `~/.openclaw/reminders.sqlite` to keep the operator-data store separate from the scheduler-job store.

### a.6 Migration discipline — `src/cron/store-migration.ts`

`src/cron/store-migration.ts` (514 lines) is the v0→v1 migration path that hydrates legacy job records into `CronJob` shape. Phase 6 uses it as **structural precedent** for the `SqliteReminderStore` v1→v2 migration stub (sub-plan §6 todo: "Migration v1→v2 stub (forward-compat)") — same forward-only one-shot-on-startup pattern.

### a.7 Cron-fired turn execution — `src/cron/isolated-agent/run.ts`

`src/cron/isolated-agent/run.ts` (920 lines) is the `at`-job dispatch path: when `nextRunAtMs <= Date.now()`, the service invokes this module to execute a `CronAgentTurnPayload`. It handles model selection (`runWithModelFallback`), bootstrap warnings, sandboxing, and acceptance attestation.

Imports include `runEmbeddedPiAgent` (line 21), `resolveExecutionRuntimePlan` (line 47), `getPlatformRuntimeCheckpointService` (line 49), and `resolveCronDeliveryPlan` (line 59). The module is **identity-blind** at the type level (see §h below) — the cron-fire callback Phase 5 introduces must inject `wrappedScopeIdentityId = record.ownerIdentityId` into the dispatched turn's session context BEFORE `runEmbeddedPiAgent` is invoked.

### a.8 Delivery dispatch — `src/cron/isolated-agent/delivery-dispatch.ts`

`src/cron/isolated-agent/delivery-dispatch.ts` (637 lines) handles outbound message dispatch on cron-fire. It imports:
- `deliverOutboundPayloads` (line 9-11) — the channel-agnostic delivery primitive.
- `resolveAgentOutboundIdentity` (line 12) — outbound identity resolver.
- `buildOutboundSessionContext` (line 13) — session-context builder.

Phase 5 REUSES `delivery-dispatch.ts` AS-IS (no fork — sub-plan §0.4 hypothesis 4). The `reminder-fire-callback.ts` module adds an `EpisodicMemoryEvent` emit BEFORE returning from the cron run; the actual outbound push remains the responsibility of the existing dispatcher.

### a.9 Existing job-management tool — `src/agents/tools/cron-tool.ts` (NOT REDEFINED)

`src/agents/tools/cron-tool.ts` (705 lines) is the **operator-facing job-management surface**. Action enum at line 21:

```ts
const CRON_ACTIONS = ["status", "list", "add", "update", "remove", "run", "runs", "wake"] as const;
```

It accepts a free-form `job` object (line 39: `Type.Object({}, { additionalProperties: true })`) and validates at runtime (line 16-19 explanatory comment). The "reminder context" constants at lines 26-29 (`REMINDER_CONTEXT_MESSAGES_MAX`, `REMINDER_CONTEXT_PER_MESSAGE_MAX`, `REMINDER_CONTEXT_TOTAL_MAX`, `REMINDER_CONTEXT_MARKER`) attach the most recent N session messages to the dispatched cron-turn — they predate this slice and refer to **agent-context attachment**, NOT the structurally-typed `RecordReminderTool` introduced by Phase 5.

**Decision (sub-plan §1 todo + §0.4 hypothesis): `cron-tool.ts` STAYS UNCHANGED**. Phase 5 ADDS a structurally different `RecordReminderTool` at `src/agents/tools/record-reminder-tool.ts` whose schema is the CLOSED `ReminderSetShape={ownerIdentityId, fireAt:ISO-8601, content, deliveryChannel, deliveryTo}` — NEVER the additional-properties-true free-form shape used by `cron-tool.ts`. The two tools are orthogonal:

| Tool | Purpose | Schema | Caller |
|---|---|---|---|
| `cron-tool.ts` | Operator job CRUD | `additionalProperties: true` | Operator (manual cron management) |
| `RecordReminderTool` (Phase 5) | Kernel-derived reminder record | CLOSED `ReminderSetShape` (#5/#6) | Kernel (via affordance resolution) |

Routing `cron-tool.ts` through the kernel is explicitly **deferred** (sub-plan §10) — different concern.

---

## §b. Slice E `reminder.set` STUB inventory

Slice E (`PR-#94`-era) shipped the discriminated-union slot for `reminder.set` typed-but-inert. Cron/Scheduler is the consumer Phase 5 anticipated. Anchors:

### b.1 STUB rationale comment — `src/platform/memory/episodic-memory-event.ts:25`

`src/platform/memory/episodic-memory-event.ts:25-30`:

```
 * Slice E ships only `persistent_session.created` as a
 * payload-bearing event. The other variants — `subagent.created`,
 * `reminder.set`, `artifact.created`, and (slice F Phase 2) `task.*`
 * — are typed but inert: their payload shapes are defined here so
 * consumers (slices F / G / J / K) can wire them by adding emit
 * sites WITHOUT modifying this discriminated union.
```

The line-25 comment names this slice ("slice F / J consumer") explicitly — the typed slot was always intended for the cron/reminder write path. Phase 5 lights the emit site WITHOUT modifying the discriminated union (additive emit only — sub-plan §1 todo §f).

### b.2 `ReminderSetPayload` shape — `episodic-memory-event.ts:101-109`

```ts
/**
 * `reminder.set` — STUB (slice F / J consumer). Same rationale as
 * `subagent.created`.
 */
export type ReminderSetPayload = {
  readonly reminderId: string;
  readonly fireAt: string;
  readonly occurredAt: string;
};
```

Three readonly string fields — Phase 5's `EpisodicMemoryEvent` emit site populates `reminderId` (`crypto.randomUUID()` per sub-plan §6 schema PRIMARY KEY), `fireAt` (ISO-8601 propagated from `RecordReminderTool` input — same value passed to `CronService.add`), and `occurredAt` (ISO-8601 of the satisfied-commitment write-time, NOT the fire-time).

The shape is INTENTIONALLY MINIMAL — `content`, `deliveryChannel`, `deliveryTo` live in `ScheduledReminderRecord` (Phase 3 WorldState slice + Phase 6 `reminders.sqlite`), NOT in the episodic event. Episodic memory is an audit trail of "X happened at T"; the operational record (with mutation lifecycle `pending`/`fired`/`cancelled`) is owned by `ReminderStore`.

### b.3 Discriminated-union variant — `episodic-memory-event.ts:334-339`

`src/platform/memory/episodic-memory-event.ts:334-339`:

```ts
  | {
      readonly identityId: IdentityId;
      readonly effectFamily: "reminder";
      readonly effectId: string;
      readonly payload: ReminderSetPayload;
    }
```

Member of the `EpisodicMemoryEvent` discriminated union. Already present (slice E P2). Phase 5 does NOT modify this union — only ADDS an emit site at `recordReminderOnCommitmentSatisfied.ts` (sibling of slice E `recordMemoryOnCommitmentSatisfied`, slice F `recordTaskOnCommitmentSatisfied`, cutover-3 `recordArtifactOnCommitmentSatisfied`, cutover-4 `recordRepoOnCommitmentSatisfied`).

### b.4 Zod schema — `episodic-memory-event.ts:427-431`

```ts
export const ReminderSetPayloadSchema = z.object({
  reminderId: NonEmptyString,
  fireAt: IsoTimestampSchema,
  occurredAt: IsoTimestampSchema,
});
```

`IsoTimestampSchema` (line 392-397) validates against the canonical ISO-8601 regex `ISO8601_PATTERN` (line 389-390):

```ts
const ISO8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
```

Phase 3's `scheduledReminderRecordSchema` (NEW) and Phase 5's `RecordReminderTool` schema both reuse this pattern — same regex applied at the Zod boundary on every reminder shape, single source of truth for ISO-8601 validation across the slice.

### b.5 Memory hook dispatch arm — `memory-write-on-satisfied.ts`

The hook lives at `src/agents/pi-embedded-runner/run/memory-write-on-satisfied.ts` (NOT under `src/platform/memory/` — the path in the sub-plan §1 todo is the historical conceptual name; line offsets shift accordingly).

`src/agents/pi-embedded-runner/run/memory-write-on-satisfied.ts:86-90`:

```ts
  | {
      readonly effectFamily: "reminder";
      readonly effectId: string;
      readonly payload: ReminderSetPayload;
    }
```

This is the `EpisodicEventInput` discriminated union the hook dispatches over (lines 75-100). The `'reminder'` arm is ALREADY PRESENT — Phase 5's emit site can construct an `EpisodicEventInput` of `effectFamily: 'reminder'` and the hook will route it without further modification. **STUB-LIT FIRST TIME** acceptance evidence (sub-plan §4 acceptance #8) is `[memory-write-on-satisfied] effectFamily=reminder wrote=true` (sub-plan §5).

The hook's contract (`recordMemoryOnCommitmentSatisfied`, lines 173+):
- Skips when `attestation.commitmentSatisfied !== true` (line 178+).
- Skips when `identityId` unresolved (anonymous fail-closed — line 149+).
- Skips when `memoryStore` unavailable.
- Skips when `episodicEvent` undefined.
- Currently skips for non-`persistent_session` families with reason `effect_family_inert` (line 159-162) — the comment at line 159-162 names slices F / G / J / K as the consumers that will widen the dispatch.

**Phase 5 widening note**: Whether the existing skip-arm `effect_family_inert` covers `reminder` today depends on the dispatch-arm's CURRENT structure beyond line 100. The slice's own Phase 5 emit-site implementation must verify the hook actually writes for `effectFamily='reminder'` (not just routes through the union arm). This is a Phase 5 implementation detail, NOT a frozen-layer change — `MemoryStore.storeEpisodic` already accepts the `'reminder'` discriminant (slice E P2 union). Cutover-3/4 precedent: their hook DID write for the new families on first emit; same expected here.

---

## §c. Slice K `RecordReminderTool` is NOT redefined

`src/agents/tools/cron-tool.ts` action surface (`["status","list","add","update","remove","run","runs","wake"]` — line 21) is OPERATOR-FACING. The reminder-related constants at lines 26-29 (`REMINDER_CONTEXT_MESSAGES_MAX = 10`, `REMINDER_CONTEXT_PER_MESSAGE_MAX = 220`, `REMINDER_CONTEXT_TOTAL_MAX = 700`, `REMINDER_CONTEXT_MARKER = "\n\nRecent context:\n"`) attach truncated session-history excerpts to dispatched cron-turn payloads — this is an **agent-context-bootstrap concern**, NOT structurally tied to the kernel-derived reminder write path.

The Cron/Scheduler slice ADDS a NEW tool `src/agents/tools/record-reminder-tool.ts` (Phase 5) with disjoint:

- **Schema**: CLOSED `ReminderSetShape={ownerIdentityId: IdentityId, fireAt: ISO-8601 string, content: string, deliveryChannel: ChannelId, deliveryTo: string}` — `additionalProperties: false` enforced via Zod `.strict()`.
- **Caller**: kernel/affordance-resolution path (NOT operator-issued). Affordance resolves Phase 4 `REMINDER_SET_AFFORDANCE_ENTRY`; runtime invokes the tool with `ownerIdentityId` injected from session context (NOT user input — invariant #5/#6).
- **Failure modes**: closed set `transport_error`/`identity_unavailable`/`fire_at_invalid`/`fire_at_in_past`/`observer_unavailable`/`reminder_store_unavailable`/`channel_invalid` (sub-plan §1 todo for Phase 5).

Both tools coexist in `src/agents/tools/` registry. Live-verify (Phase 8) confirms no shadowing — operator can still invoke the legacy `cron-tool.ts` for ad-hoc cron CRUD; kernel-derived reminder turns route through the new tool.

---

## §d. Slice K `REMINDER_EFFECT_FAMILY` registration (predecessor confirmed)

`src/platform/commitment/effect-family-registry.ts:21`:

```ts
export const REMINDER_EFFECT_FAMILY = "reminder" as EffectFamilyId;
```

`src/platform/commitment/effect-family-registry.ts:33`:

```ts
export const REMINDER_DELIVERED_EFFECT = "reminder.delivered" as EffectId;
```

Registry entry at `src/platform/commitment/effect-family-registry.ts:85-95`:

```ts
  Object.freeze({
    id: REMINDER_EFFECT_FAMILY,
    displayName: "Reminder query",
    // Read-only `observe` only — slice K is a pure CONSUMER over LIT
    // episodic slots (slice E P5 / F P5 / cutover-3 P5 / cutover-4 P5)
    // and NEVER mutates state (#11). Phase 4 `RecallReminderTool`
    // issues N parallel `MemoryStore.list({identityId, effectFamily})`
    // reads + optional `MemoryStore.recall({identityId, query})` —
    // both observation-only.
    allowedOperationKinds: Object.freeze(["observe"] satisfies OperationHintKind[]),
  }),
```

**Confirmed**: `allowedOperationKinds` is the readonly tuple `['observe']` after Slice K closure (PR-#251 Phase 3, merged through PR-#254 SLICE COMPLETE). The frame for Cron/Scheduler Phase 2 is therefore a SINGLE additive widen:

```ts
allowedOperationKinds: Object.freeze(["observe", "create"] satisfies OperationHintKind[]),
```

**No new family**, no rename, no deletion. Branching factor for `findByFamily('reminder', target, ...)` becomes 2 (slice K observe-affordance + cron/scheduler create-affordance).

The slice K affordance entry is at `src/platform/commitment/affordance-registry.ts:660-686` (`REMINDER_DELIVERED_AFFORDANCE_ENTRY`) — `operationKinds: ['observe']`, target matcher `kind === 'unspecified' || kind === 'session'`, `requiredPreconditions: [IDENTITY_RESOLVED_PRECONDITION]`, `riskTier: 'low'`, `defaultBudgets: {maxLatencyMs: 8_000, maxRetries: 1}`. Phase 4 of Cron/Scheduler ADDS a sibling `REMINDER_SET_AFFORDANCE_ENTRY` with `operationKinds: ['create']`, target matcher `kind === 'session_state' || kind === 'unspecified'`, SAME `IDENTITY_RESOLVED_PRECONDITION`, `riskTier: 'medium'`, `defaultBudgets: {maxLatencyMs: 10_000, maxRetries: 0}` (mutation idempotency unsafe — cutover-4 precedent).

`DEFAULT_AFFORDANCES` array at `affordance-registry.ts:688-704` is currently length 15. Phase 4 extends to length 16 (additive append of `REMINDER_SET_AFFORDANCE_ENTRY`).

---

## §e. WorldState orthogonality — slice K `reminder?.lastQuery` ⊥ NEW `scheduledReminders.records`

Slice K added a single read-only WorldState slot:

`src/platform/commitment/world-state.ts:123-131`:

```ts
export type ReminderQueryRecord = {
  readonly queryId: string;
  readonly resultCount: number;
  readonly observedAt: ISO8601;
};

export type ReminderWorldState = {
  readonly lastQuery?: ReminderQueryRecord;
};
```

Mounted into `WorldStateSnapshot` at `src/platform/commitment/world-state.ts:234`:

```ts
export type WorldStateSnapshot = {
  readonly sessions?: SessionWorldState;       // line 230
  readonly artifacts?: ArtifactWorldState;     // line 231
  readonly workspace?: WorkspaceWorldState;    // line 232
  readonly repo?: RepoWorldState;              // line 233
  readonly reminder?: ReminderWorldState;      // line 234  ← slice K (read)
  readonly deliveries?: DeliveryWorldState;    // line 235
  readonly webEvidence?: WebEvidenceWorldState; // line 236
};
```

The slice K slot's per-turn limit is **1** (`world-state.ts:114-117` rationale comment: «single-shot query per turn»).

### e.1 NEW orthogonal slot `scheduledReminders` (Phase 3)

Cron/Scheduler Phase 3 ADDS `WorldStateSnapshot.scheduledReminders?: ScheduledReminderWorldState` where:

```ts
export type ScheduledReminderRecord = {
  readonly reminderId: string;
  readonly ownerIdentityId: IdentityId;
  readonly fireAt: ISO8601;
  readonly content: string;
  readonly deliveryChannel: ChannelId;
  readonly deliveryTo: string;
  readonly createdAt: ISO8601;
  readonly status: "pending" | "fired" | "cancelled";
};

export type ScheduledReminderWorldState = {
  readonly records: readonly ScheduledReminderRecord[];
};
```

**Orthogonality argument** (cutover-3 §2.4 precedent — separate `artifacts.records` ⊥ `repo.records` slots):

| Property | `reminder?.lastQuery` (slice K) | `scheduledReminders.records` (NEW) |
|---|---|---|
| Discriminator | last single query | per-turn `records[]` (perTurnLimit=4) |
| Lifecycle | observation-only (one tool emit per turn) | mutation lifecycle: `pending → fired \| cancelled` |
| Observer | `ReminderWorldStateObserver` (slice K Phase 4) | NEW `ScheduledReminderObserver` (Phase 3) |
| Done-predicate input | `expectedDelta.reminder.queryId` | `expectedDelta.scheduledReminders.added[]` |
| WorldState shape | `{lastQuery?}` | `{records: readonly[]}` |

Branching factor for `findByFamily('reminder', target, op)` after Phase 4: **2** (observe → slice K affordance, create → cron/scheduler affordance). No collision: the affordance registry resolves on `(effectFamily × operationKind × target)`, and the two affordances have disjoint `operationKinds` arrays.

### e.2 Other WorldState slot precedents

- `artifacts?: ArtifactWorldState` (cutover-3 P3) — `world-state.ts:231`
- `repo?: RepoWorldState` (cutover-4 P3) — `world-state.ts:233`

Both have the `{records: readonly Record[]}` shape — cron/scheduler's `scheduledReminders` follows the SAME pattern (sub-plan §6 implementation note). Per-turn limit 4 (sub-plan §1 todo Phase 3) — versus 8 (artifacts) / 4 (repo); chosen low because typical operator usage is "set 1 reminder per turn", and >4 in a single turn is unusual enough to flag.

The schema validator follows the closed-shape Zod precedent at `world-state.ts:170-180` (artifacts) and `:191-210` (repo) — `.strict()`, ISO-8601 via `ISO8601_PATTERN` (line 133), `IdentityId` validated via the slice E `IdentityIdSchema` precedent (`episodic-memory-event.ts:407-412`).

---

## §f. `EpisodicEffectFamily` membership — `'reminder'` already typed

`src/platform/memory/episodic-memory-event.ts:45-56`:

```ts
export type EpisodicEffectFamily =
  | "persistent_session"
  | "subagent"
  | "reminder"        // ← slice E P2 already typed
  | "artifact"
  | "task"
  | "policy_approval"
  | "policy_budget"
  | "policy_role"
  | "policy_retry"
  | "policy_escalation"
  | "repo";
```

The `'reminder'` literal is at line 48. **No discriminated-union extension needed** — Phase 5 adds an EMIT site only. Sub-plan §10 lists `EpisodicEffectFamily` widening as out-of-scope; that line is a no-op confirmation, not a frozen-layer touch.

The compile-time exhaustiveness check in `memory-store.contract.test.ts` (slice E acceptance) guarantees `recall` / `storeEpisodic` callers cover every variant — Phase 5's `recordReminderOnCommitmentSatisfied.ts` hook satisfies this by constructing the `'reminder'` arm explicitly.

---

## §g. PolicyGate Full integration — 5 readers exist, ZERO new orthogonal `*POLICY_REASONS` tuples

PolicyGate Full (PR-#208/#212/#216 area) shipped 5 reason tuples + 5 stage readers. All present at `src/platform/commitment/policy-gate-stages.ts`:

| Stage | Tuple | Line |
|---|---|---|
| 2 (Approval) | `APPROVAL_POLICY_REASONS` | `policy-gate-stages.ts:90` |
| 3 (Budget) | `BUDGET_POLICY_REASONS` | `policy-gate-stages.ts:103` |
| 4 (Role) | `ROLE_POLICY_REASONS` | `policy-gate-stages.ts:115` |
| 5 (Retry) | `RETRY_POLICY_REASONS` | `policy-gate-stages.ts:125` |
| 6 (Escalation) | `ESCALATION_POLICY_REASONS` | `policy-gate-stages.ts:139` |

Reader implementations:
- `src/platform/commitment/approval-policy.ts` (Stage 2)
- `src/platform/commitment/budget-policy.ts` (Stage 3)
- `src/platform/commitment/role-policy.ts` (Stage 4)
- `src/platform/commitment/retry-policy.ts` (Stage 5)
- Escalation: see `__tests__/escalation-hook.test.ts`

**Phase 7 commitment**: ZERO new `*POLICY_REASONS` entries. ZERO new readers. The slice ADDS only **config entries** (sub-plan §1 todo for Phase 7):

- `policy.budgets.reminder.set.perChannelHourly = 10`
- `policy.budgets.reminder.set.perIdentityDaily = 50`
- Stage 2 escalation threshold: high-cardinality reminders (>50 pending) require approval.
- Stage 4 role mapping: maintainer/developer → all; viewer → none; anonymous → fail-closed.
- Stage 5 retry policy: reminder.set is a write — `maxRetries=0` (mutation idempotency unsafe).

This mirrors cutover-4 P6 precedent (sub-plan §0.6 reference): cutover-4 added repo-operation budgets/role mappings to existing readers WITHOUT extending the tuple literals. Reverse test: `pnpm vitest run src/platform/commitment/__tests__/policy-gate-stages.test.ts` MUST stay green with byte-identical tuple literals.

**Frozen-layer additivity**: Phase 7's only frozen-layer touch is `IntentContractor` (`intent-contractor-impl.ts`) extension — adding the `<reminder_set_intent>` structured prompt slot (slice K `<recall_window>` precedent, sub-plan §1 todo Phase 7). This is an additive prompt-template change with NO contract surface modification (5 frozen contracts byte-identical).

---

## §h. Cron-fire identity-injection (slice K precedent — `wrappedScopeIdentityId` analog)

The identity-injection invariant: when scheduler fires a reminder in non-interactive context, the delivered turn MUST carry the SAME `IdentityId` as the operator who set the reminder. Identity NEVER cross-leaks even across the async cron-fire boundary.

### h.1 Cron infrastructure is currently identity-blind

`grep "identityId\|IdentityId" src/cron/` returns ZERO matches. The cron isolated-agent runner (`src/cron/isolated-agent/run.ts`, 920 lines) imports `runEmbeddedPiAgent`, `resolveExecutionRuntimePlan`, etc., but does NOT propagate an `IdentityId` parameter — at the cron-job-record level, identity is not currently a first-class field. This is the gap Phase 5 closes.

### h.2 Slice K precedent — `ownerIdentityId` injected from session context

The Slice K Phase 4 reminder runtime adapter (`src/agents/pi-embedded-runner/run/reminder-runtime-adapter.ts`) demonstrates the precedent. Lines 116-123:

```ts
  // future caller cannot smuggle a ZERO-identity emit past the gate
  const ownerIdentityId =
    typeof input.query?.ownerIdentityId === "string"
      ? input.query.ownerIdentityId.trim()
      : "";
  if (ownerIdentityId.length === 0) {
    return { ok: false, reason: "identity_unavailable" };
  }
```

`ownerIdentityId` is sourced from the resolved session context (NOT user input — invariant #5/#6 hard line). The SAME pattern applies to the WRITE path (Phase 5):

1. `RecordReminderTool` schema accepts `ownerIdentityId: IdentityId` — but the **caller** (kernel) injects it from session context, not from LLM-generated arguments.
2. `ReminderStore.schedule(record)` writes `record.ownerIdentityId` to SQL `identity_id` column.
3. On cron-fire, `reminder-fire-callback.ts` LOADS the record (`ReminderStore.get(reminderId, identityId)`), then constructs the dispatched turn with `wrappedScopeIdentityId = record.ownerIdentityId` (sub-plan §1 todo Phase 5: "construct delivery with `wrappedScopeIdentityId = record.ownerIdentityId`").

### h.3 Where `wrappedScopeIdentityId` plumbs in

The literal symbol `wrappedScopeIdentityId` does not currently appear in the codebase (`grep wrappedScope` returns zero matches). Phase 5 of this slice introduces it as a **new field on the cron-fired turn's session-context plumbing**. The shape lands at `src/cron/isolated-agent/reminder-fire-callback.ts` (NEW per Phase 5) and is consumed by the dispatched `runEmbeddedPiAgent` invocation through `buildOutboundSessionContext` (`delivery-dispatch.ts:13`).

The naming aligns with the slice K Phase 4 acceptance log line precedent (sub-plan §5 evidence): `[reminder-fire-callback] reminderId=<...> wrappedScopeIdentityId=<...>`.

### h.4 Defense-in-depth — `ReminderStore` predicates on `identity_id=?`

Sub-plan §6 todo: "every read predicates on `identity_id = ?`". Three layers of identity-isolation:

1. **Adapter layer** — `RecordReminderTool` rejects empty/missing `ownerIdentityId` with `identity_unavailable` (slice K precedent above).
2. **Storage layer** — every `SqliteReminderStore.list / .get / .markFired / .cancel` SQL statement includes `WHERE identity_id = ?`. SQL CHECK constraint prevents status-transition `fired → pending`.
3. **Cron-fire layer** — fire callback loads record by `(reminderId, identityId)` tuple, NOT by `reminderId` alone. If the runtime context's identity differs from `record.ownerIdentityId`, the callback drops + warns (sub-plan §6 risks: «Bot offline at fire-time → CronService rehydration replays missed `at` jobs»; «Identity-resolution failure on fire → drop + warn»).

Live-verify assertion (sub-plan §8): «ZERO `[reminder-store] list` WITHOUT `identity_id` predicate». A test harness grep of the production log over the verify window confirms this.

---

## §i. NEW invariant — «no `RecordReminderTool` invocation without `ownerIdentityId` resolved at session-context layer»

### i.1 Statement

> A `RecordReminderTool` invocation MUST carry `ownerIdentityId` resolved at the session-context layer, NEVER from user input or tool-call arguments.

This generalizes the slice K Phase 4 reminder runtime adapter pattern (anonymous fail-closed via `ownerIdentityId.trim().length === 0` check at `reminder-runtime-adapter.ts:116-123`) to the WRITE side. Invariant #5/#6 (no new readers of raw user text) is the parent rule; this invariant is the structural-resolver corollary for the reminder-set affordance.

### i.2 Lint rule sketch — `lint:reminder:no-tool-invocation-without-injected-identity`

Static-analysis rule (proposed implementation by Phase 5 or as separate lint slice):

**Detection**:

The rule flags any `RecordReminderTool` invocation site where `ownerIdentityId` is NOT sourced from a `SessionContext`-derived value. Concrete patterns to flag:

1. `recordReminderTool.invoke({ ownerIdentityId: <STRING_LITERAL>, ... })` — fail.
2. `recordReminderTool.invoke({ ownerIdentityId: <ARGUMENT_OF_TOOL_CALL>, ... })` — fail (argument MUST be a session-context binding).
3. `recordReminderTool.invoke({ ownerIdentityId: parseUserInput(...), ... })` — fail.
4. `recordReminderTool.invoke({ ownerIdentityId: sessionContext.identityId, ... })` — pass.
5. `recordReminderTool.invoke({ ownerIdentityId: deps.identityId, ... })` where `deps.identityId` is type-narrowed to `IdentityId` and originates from `SessionContextResolver` — pass.

**Implementation hint**: TypeScript AST pass over `src/agents/tools/record-reminder-tool.ts` callers — check that the value passed to `ownerIdentityId` resolves (via type-flow analysis) to an `IdentityId` that traces back to a `SessionContext` source. The parent-source slice E `IdentityIdSchema` decode pathway (`episodic-memory-event.ts:407-412`) is the canonical structural resolver.

**Test fixtures** (Phase 5 acceptance, sub-plan §1 todo):
- Reverse test: tool invocation where `ownerIdentityId` originates from raw `UserPrompt.text` MUST FAIL the lint check.
- Reverse test: tool invocation where `ownerIdentityId` is undefined → `identity_unavailable` failure code returned by the adapter (NOT a thrown exception — sub-plan §1 todo Phase 5: "NEVER throws").
- Forward test: tool invocation where `ownerIdentityId` is a session-resolved `IdentityId` → success path with `[scheduled-reminder-runtime-adapter] recordReminderScheduled reminderId=<...> identityId=<...>` log line.

The lint rule lives outside the frozen layer; its addition is a separate concern (sub-plan §6 implementation notes: «NEW lint rule `lint:reminder:no-tool-invocation-without-injected-identity`»). Phase 5 ships the structural enforcement (adapter rejects empty `ownerIdentityId`); the lint rule is defense-in-depth on top.

---

## Cross-references

- Master plan §16 deferred Cron/Scheduler mention.
- Slice K sub-plan `commitment_kernel_slice_k_reminder.plan.md` (recall-side complement).
- Slice E sub-plan (`reminder.set` STUB origin + SqliteVec precedent for Phase 6 `SqliteReminderStore`).
- Cutover-3 sub-plan (`AUDIT-cutover3-artifacts.md` — additive WorldState slice + observer template).
- Cutover-4 sub-plan (`AUDIT-cutover4-repo-operation.md` — additive frozen-layer touch precedent).
- PolicyGate Full sub-plan (`AUDIT-policy-gate-full.md` — 5 readers reuse).
- 16 hard invariants — `.cursor/rules/commitment-kernel-invariants.mdc`.

## Phase 1 conclusion

All nine audit sections are filled with line-anchored evidence against `dev` HEAD `f97b2a02be`. The Cron/Scheduler slice is structurally feasible:

1. Existing `src/cron/` infrastructure provides `CronService.add({schedule:{kind:'at', at:fireAt}, ...})` AS-IS — no fork.
2. Slice E `reminder.set` STUB (`episodic-memory-event.ts:25 / 101-109 / 334-339 / 427-431`) is typed-but-inert; Phase 5 lights the emit site additively.
3. Slice K `REMINDER_EFFECT_FAMILY` registered at `effect-family-registry.ts:85-95` with `allowedOperationKinds=['observe']`. Phase 2 widens to `['observe','create']` with a single one-line tuple edit.
4. WorldState slot `reminder?.lastQuery` (slice K, `world-state.ts:123-131/234`) is structurally orthogonal to the new `scheduledReminders.records` slot (different shape, different lifecycle, different observer, different done-predicate).
5. `EpisodicEffectFamily` discriminated union ALREADY contains `'reminder'` (line 48) — Phase 5 emit-only, NO union extension.
6. PolicyGate Full 5-reader surface is intact; Phase 7 adds config entries WITHOUT new `*POLICY_REASONS` literals.
7. Cron-fire identity-injection has clear precedent (slice K `ownerIdentityId` injection at `reminder-runtime-adapter.ts:116-123`); `wrappedScopeIdentityId` is a NEW field plumbed by Phase 5's `reminder-fire-callback.ts`.
8. NEW invariant «no `RecordReminderTool` invocation without `ownerIdentityId` resolved at session-context layer» captured + lint-rule sketch documented.
9. `cron-tool.ts` operator surface stays unchanged — `RecordReminderTool` is structurally disjoint (closed `ReminderSetShape` vs free-form `additionalProperties: true`).

Frozen-layer touches across Phases 2, 4, 7 are all ADDITIVE (one tuple widen, one affordance entry, one cutover-policy entry, one prompt-template extension). 5 frozen contracts (`TaskContract`, `OutcomeContract`, `QualificationExecutionContract`, `ResolutionContract`, `RecipeRoutingHints`) stay byte-identical. Slice is GREEN to proceed to Phase 2 (effect-family allow-list widen + NEW `REMINDER_SET_EFFECT`).
