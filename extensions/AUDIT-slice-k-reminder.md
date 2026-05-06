# AUDIT — Slice K Reminder Query Consumer (Phase 1, read-only)

**Sub-plan**: `.cursor/plans/commitment_kernel_slice_k_reminder.plan.md`
**Slice id**: `slice-k-reminder`
**Audit branch**: `audit/v1-slice-k-phase-1`
**Predecessor SHA**: `5c09a4959a` (`origin/dev` HEAD; post PR-#248 — slice-k sub-plan merged).
**Maintainer signoff**: GRANTED via blanket authorization 2026-05-05.
**Frozen-layer touches in this audit**: NONE (read-only markdown deliverable).

This document maps the source-of-truth state of every surface slice K Phase 2-6 will read or extend, and confirms each precondition stated in `commitment_kernel_slice_k_reminder.plan.md` §2. Every finding is line-anchored against `dev` HEAD `5c09a4959a`.

Slice K is a **pure CONSUMER** over already-LIT episodic slots (slice E P5 / slice F P5 / cutover-3 P5 / cutover-4 P5). It introduces a NEW `reminder` effect-family (closed-set additive in `EFFECT_FAMILY_REGISTRY`) but does NOT extend `EpisodicEffectFamily`, does NOT extend `MemoryStore`, and does NOT touch the 5 frozen contracts.

---

## §a. `MemoryStore` surface inventory

The slice-E `MemoryStore` interface ships TWO read primitives that slice K will consume.

### a.1 `MemoryStore.recall(query)` — embedding-scored semantic recall

`src/platform/memory/memory-store.ts:106-112`:

```ts
/**
 * Recall semantic entries similar to `query.query`, scoped to
 * `query.identityId`. Returns at most `query.limit` entries (or the
 * store's default cap when omitted). Returns `{ entries: [] }` when
 * nothing matches — never throws on no-match.
 */
recall(query: SemanticMemoryQuery): Promise<MemoryRecallResult>;
```

Input shape `SemanticMemoryQuery` at `src/platform/memory/semantic-memory.ts:48-52`:

```ts
export type SemanticMemoryQuery = {
  readonly identityId: IdentityId;
  readonly query: string;
  readonly limit?: number;
};
```

Returns `MemoryRecallResult` (`src/platform/memory/semantic-memory.ts:77-79`) — `readonly entries: readonly SemanticMemoryEntry[]` — entries carry `score: number` (`src/platform/memory/semantic-memory.ts:61-67`). Sqlite-vec impl runs cosine similarity; in-memory impl uses substring + token-overlap (see §i.1, §i.2 below).

Slice K may UNION this surface (operator's free-form `textHint`) with the per-family episodic listing union in §a.2. Phase 4 will gate on whether `textHint` is present in the structured `ReminderQueryShape`.

### a.2 `MemoryStore.list(query)` — episodic listing keyed on `identityId × effectFamily?`

`src/platform/memory/memory-store.ts:114-121`:

```ts
/**
 * List every entry (episodic + semantic) for the given identity,
 * optionally filtered to a single episodic family. Result fields
 * are always arrays (possibly empty). Used by slice G (subagent
 * registry persistence) and slice F (task ledger) to enumerate
 * their stored events in later phases.
 */
list(query: MemoryListQuery): Promise<MemoryListResult>;
```

Input shape `MemoryListQuery` at `src/platform/memory/memory-store.ts:24-28`:

```ts
export type MemoryListQuery = {
  readonly identityId: IdentityId;
  readonly effectFamily?: EpisodicEffectFamily;
  readonly limit?: number;
};
```

`effectFamily` is **SINGLE OPTIONAL** — there is no multi-family vector. Returns `MemoryListResult` (`src/platform/memory/memory-store.ts:49-52`) with two parallel arrays (`episodic`, `semantic`).

### a.3 Decision: extend `MemoryListQuery.families[]` vs N parallel `list()` calls

Slice K must read across **5 LIT families** (`persistent_session` / `task` / `artifact` / `repo`, plus optional `policy_*` excluded by default — see §d).

| Option | Pros | Cons |
|---|---|---|
| (1) Extend `MemoryListQuery` with `families?: readonly EpisodicEffectFamily[]` | Single round-trip; storage layer can OR-filter at the `WHERE` clause | Widens slice-E Phase-1 frozen interface; sub-plan §10 explicitly defers `MemoryStore` widening; touches every impl (`InMemoryMemoryStore`, `SqliteVecMemoryStore`, `LlmExtractorMemoryStore`); requires master-plan amendment per slice-K invariant §1 #11 ("frozen contracts BYTE-IDENTICAL"). |
| (2) **N parallel `list()` calls** (one per family) + client-side union | Zero touch on slice-E surface; fits sub-plan §10 ("MemoryStore interface UNCHANGED — N parallel calls suffice"); per-family failure isolated (artifact succeeds, repo fails → partial result) per sub-plan §6 defense-in-depth | 5 simultaneous round-trips in p95; client-side merge cost. |

**RECOMMENDATION: Option (2) — N parallel `list()` calls.**

Latency budget: p95 storage `list()` < 100ms (sqlite-vec indexed at `src/platform/memory/sqlite-vec-store.ts:200-202` — see §i.2). 5 families × 100ms in parallel via `Promise.all` ≈ 100ms p95 (parallel), 500ms p95 (worst-case serialized). Affordance `defaultBudgets.maxLatencyMs = 8_000` (sub-plan Phase 3) covers both with >16× margin.

Sub-plan §10 line 170 reads:

> | `MemoryStore` interface widening | N parallel calls suffice |

Audit confirms: **slice K does NOT widen `MemoryStore`**.

### a.4 The other two `MemoryStore` methods are out of scope for slice K

`storeEpisodic` (`memory-store.ts:91-97`) and `storeSemantic` (`memory-store.ts:99-104`) are write paths; slice K is read-only (sub-plan §0.5.6 + invariant §1 #11). `forget` (`memory-store.ts:122-132`) is for compliance / opt-out (sub-plan §10 defers). Slice K consumes only `recall` + `list`.

---

## §b. LIT episodic-event slot inventory (post-Cutover-4)

`EpisodicEffectFamily` is the discriminated union at `src/platform/memory/episodic-memory-event.ts:45-56` — 11 variants. Five PRs lit them in the v1 sequence. Verified PR squash SHAs against `git log --oneline` on `5c09a4959a`:

### b.1 `persistent_session.created` — slice E P5 PR #169 squash `24ed296923`

```
24ed296923 feat(memory): record memory on commitmentSatisfied (slice E Phase 5) (#169)
```

Emit site: `src/agents/pi-embedded-runner/run/memory-write-on-satisfied.ts`. Payload `PersistentSessionCreatedPayload` defined at `src/platform/memory/episodic-memory-event.ts:80-85`:

```ts
export type PersistentSessionCreatedPayload = {
  readonly messageRole: "user" | "assistant";
  readonly messageText: string;
  readonly messageId: string;
  readonly occurredAt: string;
};
```

Closes B1 ("memory across `/new`"). Reminder consumes via `MemoryStore.list({identityId, effectFamily: 'persistent_session'})`.

### b.2 `task.{created,completed,cancelled,failed}` — slice F P5 PR #185 squash `9e3dd386a6`

```
9e3dd386a6 feat(task): record task on commitmentSatisfied (slice F Phase 5) (#185)
```

Single `EpisodicEffectFamily` member `"task"` with payload-level `kind` discriminator (`episodic-memory-event.ts:46-50, 121-192`). The four lifecycle payloads (`TaskCreatedPayload` / `TaskCompletedPayload` / `TaskCancelledPayload` / `TaskFailedPayload`) sit under `TaskLifecyclePayload` (line 188-192), validated by `TaskLifecyclePayloadSchema` (line 516-522).

Reminder consumes the union via `MemoryStore.list({identityId, effectFamily: 'task'})` and routes per-`payload.kind` into the result formatter (Phase 4 reducer).

### b.3 `artifact.created` — cutover-3 P5 PR #200 squash `57889861ee`

```
57889861ee feat(slice-cutover3): phase 5 — artifact runtime adapter + 4 emit sites + commitment-satisfied hook (#200)
```

Family member `"artifact"` (`episodic-memory-event.ts:49`) with payload `ArtifactCreatedPayload` (line 115-119):

```ts
export type ArtifactCreatedPayload = {
  readonly artifactId: string;
  readonly kind: string;
  readonly occurredAt: string;
};
```

Schema at line 433-437. PR-#200 wired emit sites in `src/agents/pi-embedded-runner/run/recordArtifactOnCommitmentSatisfied.ts` (verified via `Grep EpisodicEffectFamily` results — see file enumeration in §i.3).

NOTE: header-comment on `episodic-memory-event.ts:111-113` still says "STUB (slice K consumer)" — historic comment from slice E P1 (PR #154); the cutover-3 P5 PR (PR #200) lit the slot. Slice K Phase 1 audit notes this comment drift but does NOT change it (read-only audit). Phase 2-6 may refresh the comment as adjacent doc-touch when Phase 4 consumes the slot.

### b.4 `repo.{branch_created,commit_landed,merge_completed,diff_observed}` — cutover-4 P5 PR #242 squash `3785e6336b`

```
3785e6336b feat(slice-cutover4): phase 5 — repo-runtime-adapter + repo-tool + commit hook + lint rule (#PR) (#242)
```

Single family member `"repo"` (`episodic-memory-event.ts:56`) with payload-level `kind` discriminator (line 299-305):

```ts
export type RepoOperationCompletedPayload = {
  readonly repoOperationId: string;
  readonly kind: "branch_created" | "commit_landed" | "merge_completed" | "diff_observed";
  readonly branchName?: string;
  readonly commitSha?: string;
  readonly occurredAt: string;
};
```

Schema at line 595-607. Same compaction strategy as `task.*` — discriminated-union surface stays narrow.

### b.5 `policy_*` — PolicyGate Full P3-P7 — **EXCLUDED from default reminder filter**

Five family members landed by PolicyGate Full Stages 2-6 (`episodic-memory-event.ts:51-55`):

- `policy_approval` (line 51, payload at line 204-209)
- `policy_budget` (line 52, payload at line 220-227)
- `policy_role` (line 53, payload at line 235-240)
- `policy_retry` (line 54, payload at line 249-256)
- `policy_escalation` (line 55, payload at line 267-273)

These slots ARE LIT (typed-but-INERT until each Stage's emit site wires per `commitment_kernel_policy_gate_full.plan.md`). However sub-plan §0.5.6 + §2.2 + §10 default-filter list excludes `policy_*` because:

1. **Not user-facing reminder semantics.** Operator asking «какой PDF я делал?» does NOT mean «show me my approval denials».
2. **Cross-cuts privacy.** `policy_role.requiredRole` may leak organisational role names; `policy_budget.limit` may leak per-window quotas.
3. **PolicyGate Full produces audit-bound records, not operator-recall material.** Phase 5 contractor allowlist (§d) reflects this: `reminder` joins `{persistent_session, communication, web_research, artifact, repo}` — not the policy bundle.

Phase 4 default `effectFamilyFilter` enumerates `['persistent_session', 'task', 'artifact', 'repo']` — 4 LIT families, `policy_*` omitted. Future operator-facing PolicyGate UX (e.g. «show my approval denials this week») would be a SEPARATE slice with explicit role-gating — not slice K.

### b.6 `subagent.created` — STUB, NEVER emitted

Family member `"subagent"` (`episodic-memory-event.ts:47`) with payload `SubagentCreatedPayload` (line 95-99). Header-comment at line 88-94 explicitly marks "STUB (slice G consumer)" — slice G is OPEN per sub-plan §0 references. No production emit site.

Phase 4 default filter does NOT include `subagent` because no entries exist. If slice G later lights this slot, Phase 5 contractor allowlist + Phase 4 default filter can be ADDITIVELY extended in a follow-up slice — not in slice K.

### b.7 `reminder.set` — STUB, semantic mismatch with this slice

Family member `"reminder"` (`episodic-memory-event.ts:48`) with payload `ReminderSetPayload` (line 105-109):

```ts
export type ReminderSetPayload = {
  readonly reminderId: string;
  readonly fireAt: string;
  readonly occurredAt: string;
};
```

This is the **CRON-SET** reminder («remind me at 9 AM tomorrow») — a future Cron/Scheduler slice. Slice K is the **RECALL-QUERY** reminder («какой PDF я делал на прошлой неделе?»). The two share the verb but are semantically orthogonal:

- `reminder.set` payload carries `fireAt: ISO8601` (when to wake up).
- Slice K `RecallReminderTool` will read `recallWindow.{from, until}` (a closed time range to query the past).

Sub-plan §0.5.6 + §10 ("Cron-fired reminders / `reminder.set` lighting | Separate Cron/Scheduler slice") explicitly defers cron. Slice K does NOT light `reminder.set` and does NOT consume it. Phase 4 default `effectFamilyFilter` omits the `reminder` episodic family slot.

NOTE: Slice K's NEW effect-family `reminder` (Phase 3 — see §e) lives in `EFFECT_FAMILY_REGISTRY` (slice-D registry) — NOT in `EpisodicEffectFamily` (slice-E memory shape). The two registries are orthogonal: an effect family is a routing/affordance discriminator, an episodic family is a write-shape discriminator. The naming collision (`reminder` in both) is acknowledged; sub-plan §3 ("five forces") confirms `EpisodicEffectFamily` UNCHANGED by slice K.

---

## §c. `MemoryListQuery.effectFamily` audit — interface widening vs parallel calls

Confirms §a.3 by line-anchoring the present interface on `dev`:

`src/platform/memory/memory-store.ts:24-28`:

```ts
export type MemoryListQuery = {
  readonly identityId: IdentityId;
  readonly effectFamily?: EpisodicEffectFamily;   // SINGLE optional
  readonly limit?: number;
};
```

Phase 1 of slice E (PR #154 = `f13d771e57`) froze this interface on dev. The header-comment on `memory-store.ts:18-19` notes:

> `effectFamily`, when set, restricts to a single episodic family — useful for slice F's "list reminders for this operator" surface in a later slice.

This is the sole option-(1) opening. Sub-plan §10 closes the door — N parallel calls is the chosen path.

**DECISION: Option (2). Phase 4 issues `Promise.all(families.map(family => store.list({identityId, effectFamily: family, limit: perFamilyLimit})))`.**

Per-family `limit` ≈ `requestedLimit / families.length` so the union does not exceed the operator-supplied cap. Phase 4 will round up by 1 per family to absorb post-merge sort truncation.

---

## §d. `IntentContractor` allowlist current state (post-Cutover-4 P8)

The contractor's `responseShape.desiredEffectFamily` documentation list at `src/platform/commitment/intent-contractor-impl.ts:917`:

```ts
desiredEffectFamily:
  '"persistent_session" | "communication" | "web_research" | "artifact" | "repo" | "unknown"',
```

**5 families** (excluding `unknown`): `persistent_session`, `communication`, `web_research`, `artifact`, `repo`.

The actual closed registry that drives `familyDirectory` (line 905-908) is `EFFECT_FAMILY_REGISTRY` at `src/platform/commitment/effect-family-registry.ts:33-83` — same 5 + `unknown`:

- `PERSISTENT_SESSION_EFFECT_FAMILY` (line 15, def at line 34-38)
- `COMMUNICATION_EFFECT_FAMILY` (line 16, def at line 39-43)
- `WEB_RESEARCH_EFFECT_FAMILY` (line 17, def at line 44-52)
- `UNKNOWN_EFFECT_FAMILY` (line 18, def at line 53-57)
- `ARTIFACT_EFFECT_FAMILY` (line 19, def at line 58-68; cutover-3 P2 PR #194)
- `REPO_EFFECT_FAMILY` (line 20, def at line 69-82; cutover-4 P2 PR #239)

Phase 5 of slice K will:

1. Add `REMINDER_EFFECT_FAMILY = "reminder"` constant (Phase 3) to the registry as a new `Object.freeze({...})` entry with `allowedOperationKinds: ['observe']` (read-only — invariant §1 #11).
2. Extend the literal union docstring at `intent-contractor-impl.ts:917` to include `"reminder"` — making the contractor allowlist **6 families** post-slice-K-P5.
3. Add structured prompt slots `<recall_window>` and `<effect_family_filter>` to the prompt body (sub-plan §2.6 + invariant #5 — LLM-driven temporal-expression resolution INSIDE the contractor).

Frozen-layer additive precedent: cutover-3 P6 / cutover-4 P6 ran the same shape — append a literal-union member + new `Object.freeze` entry. Acceptance §11 requires byte-identical 5 frozen contracts; effect-family-registry is **NOT** one of the 5 — its registry is a closed-set runtime allowlist (slice-D PR-2 surface).

Confirms sub-plan §1 ("Hard invariants this slice keeps") — additive frozen-layer touch is sanctioned by master plan §0.5.6 precedents.

---

## §e. CRITICAL audit decision: NEW `reminder` family vs reuse `persistent_session` / `web_research`

Sub-plan §2.3 recommends NEW `reminder` family. This audit confirms with line-anchored reasoning across **four orthogonal axes**:

### e.1 Distinct done-predicate

`persistent_session.created` done-predicate (slice E P5 hook at `src/agents/pi-embedded-runner/run/memory-write-on-satisfied.ts`) requires **message persisted** to the operator session log — a write-side commitment.

`web_research.summarized` done-predicate (search-composer pipeline) requires **summary text rendered** — also write-side.

Slice K reminder done-predicate is **structurally distinct**: `resultCount >= 0` over the structured query response. Sub-plan §3 reads:

> **#3**: Production success requires `commitmentSatisfied=true`. Done-predicate over `WorldStateSnapshot.reminder.lastQuery`. **Empty result IS success** — operator asked, was answered with structurally correct «no entries in window».

A done-predicate that satisfies on `resultCount=0` is **incompatible** with a `persistent_session` predicate that asserts a write happened. Reuse would force one of:

- (a) Lying about the write — silently fail to write, claim satisfaction.
- (b) Coupling a query to a write — write a `reminder.queried` row on every recall (storage cost; new emit site; widens `EpisodicEffectFamily`).

Both violate invariant #11 (frozen-layer additive only). NEW family avoids both.

### e.2 Distinct riskTier

`persistent_session` carries riskTier `medium` — every write mutates operator memory. `web_research` carries riskTier `medium` — outbound network calls. Sub-plan Phase 3 sets reminder `riskTier: 'low'`:

> riskTier='low', defaultBudgets={maxLatencyMs:8_000, maxRetries:1}

`'low'` is justified because:

- **No mutation.** `MemoryStore.list` is read-only — no episodic write, no semantic write.
- **No outbound network.** Reads are local sqlite + in-process maps.
- **No PII export.** Result formatter renders within the same identity scope.

PolicyGate Full Stage 5 retry budget at `src/platform/commitment/policy-gate-stages.ts` differentiates retry counts per `riskTier`. Reusing `persistent_session` (medium) or `web_research` (medium) would over-restrict the recall budget; reuse would conflate observation with mutation.

### e.3 Distinct affordance budgets

Sub-plan Phase 3:

> defaultBudgets={maxLatencyMs:8_000, maxRetries:1}

`persistent_session.created` budget (slice E P3 affordance) ≈ 30s+ (memory writes can stall on sqlite locks during heavy concurrent traffic). `web_research.summarized` budget ≈ 30s+ (external HTTP). Reminder p95 ≈ 500ms (5 parallel `list()` × 100ms — see §a.3); 8s budget gives 16× headroom.

### e.4 Distinct structural constraints

Reminder Phase 2 introduces `ReminderQueryShape` (sub-plan §5 Phase 2):

```ts
ReminderQueryShape = {
  ownerIdentityId,
  recallWindow?: {from?, until?},
  effectFamilyFilter?: readonly EpisodicEffectFamily[],
  textHint?,
  limit?,
};
```

Constraint keys `recallWindow`, `effectFamilyFilter`, `textHint`, `limit` are **structurally unique to reminder** — none of `persistent_session` / `communication` / `web_research` / `artifact` / `repo` accept these on their affordance constraint allowlist.

`SemanticIntent.constraints` is open (`ReadonlyRecord<string, unknown>` — see §f) so the contractor CAN populate any key, but the affordance allowlist gates final acceptance per slice-D PR-2 closed-set discipline.

**CONCLUSION**: NEW `REMINDER_EFFECT_FAMILY = 'reminder'` is the right shape across all four axes. Reuse violates done-predicate semantics, riskTier classification, budget alignment, and constraint surface.

---

## §f. `SemanticIntent.constraints` open-record confirmation

Re-verifies slice F audit §2.4 finding. Two sources of truth:

### f.1 Type-level

`src/platform/commitment/semantic-intent.ts:22-29`:

```ts
export type SemanticIntent = {
  readonly desiredEffectFamily: EffectFamilyId;
  readonly target: TargetRef;
  readonly operation?: OperationHint;
  readonly constraints: ReadonlyRecord<string, unknown>;
  readonly uncertainty: readonly string[];
  readonly confidence: number;
};
```

`ReadonlyRecord<string, unknown>` is **open** at the type level — any string key, any value.

### f.2 Schema-level (Zod boundary)

`src/platform/commitment/intent-contractor-impl.ts:184`:

```ts
constraints: z.record(z.string(), z.unknown()).default({}),
```

`z.record(z.string(), z.unknown())` is **non-strict** — Zod accepts every additional key without rejection. Slice F audit §2.4 confirmed; slice K Phase 1 re-confirms on `dev` HEAD `5c09a4959a`.

**Implication for slice K**: Phase 5 contractor extension can populate `constraints.recallWindow = {from, until}` and `constraints.effectFamilyFilter = ['artifact', 'task']` ADDITIVELY without schema migration. Phase 4 `RecallReminderTool` reads these structural fields via Zod parsing of a **closed `ReminderQueryShape` schema** — the tool's own schema is `.strict()`, but the upstream `SemanticIntent.constraints` remains open.

This is invariant-#5-compatible: the tool surface stays closed, the upstream record stays open, and the contractor (sole sanctioned reader of raw text per `intent-contractor-impl.ts:21, 70, 357`) is the bridge.

---

## §g. Outbound coalescer (NEW-C) status

`src/infra/outbound/outbound-coalescer.ts` exists on `dev` HEAD `5c09a4959a`. Source files present:

```
src/infra/outbound/outbound-coalescer.ts
src/infra/outbound/outbound-coalescer.test.ts
src/infra/outbound/outbound-coalescer.integration.test.ts
src/infra/outbound/outbound-coalescer-types.ts
src/infra/outbound/outbound-coalescer-types.test.ts
src/infra/outbound/outbound-coalescer-bypass.test.ts
src/infra/outbound/__tests__/outbound-coalescer-bypass-coverage.test.ts
```

Landing PRs (verified via `git log --grep`):

- PR #229 `429befb339` — Phase 2 types + DI seam + telemetry helper
- PR #231 `2c12a44f12` — Phase 3 coalescer impl with watchdog + 2 merge strategies
- PR #234 `091d5e16f1` — Phase 4 wire all emit-sites through coalescer
- PR #235 `6f96247217` — Phase 5 commit-on-satisfied hook + finalizeAfterRun fallback
- PR #236 `9fa2939678` — Phase 6 bypass allowlist + coverage guard
- PR #237 `dec877fc72` — Phase 7 acceptance fixture (NEW-C SLICE COMPLETE)

**Slice K composes through the EXISTING coalescer surface, NOT through a new path.** The reminder response is rendered as a final outbound message; `agent-runner.ts` already routes through `coalescer.register({kind:'final',...})` per PR-#234. Slice K does NOT extend the coalescer, does NOT add a new emit site outside the existing fan-in, and does NOT touch the bypass allowlist.

Sub-plan §0.5.6 confirms: «Result returned through existing outbound coalescer (NEW-C surface).»

---

## §h. Existing reminder-shaped surfaces — cron / Scheduler

### h.1 `reminder.set` payload stub — `episodic-memory-event.ts:101-109`

The STUB payload exists (slice E P1 PR #154 `f13d771e57`). Header-comment at line 101-104:

> `reminder.set` — STUB (slice F / J consumer). Same rationale as `subagent.created`.

**No production code path emits `reminder.set`.** Confirmed by repo-wide `Grep ReminderSet` — every match is in:

- `src/platform/memory/index.ts` (re-export)
- `src/platform/memory/episodic-memory-event.ts` (type def + Zod schema)
- `src/platform/memory/episodic-memory-event.test.ts` (round-trip schema test)
- `src/agents/pi-embedded-runner/run/memory-write-on-satisfied.ts` (header-comment reference at line 26-28, NOT an emit site)

### h.2 Cron / Scheduler tools — none in extensions/

Glob `extensions/**/cron*` returns **zero matches**. The repo has NO cron-style scheduler plugin. The whatsapp `heartbeat-runner` mentions "cron" in TEST-ONLY (`extensions/whatsapp/src/auto-reply/heartbeat-runner.test.ts`) and in commit history docs (`extensions/diffs/assets/viewer-runtime.js` is a frontend asset, not a backend scheduler).

**Slice K does NOT consume cron output.** The reminder query is **PULL** semantics (operator asks → tool reads). Cron is **PUSH** semantics (scheduler fires → notify operator). Sub-plan §10 explicitly defers PUSH to a future Cron/Scheduler slice.

---

## §i. Privacy audit — every `MemoryStore` read predicates on `identity_id = ?`

Sub-plan §1 invariant #15:

> Defense-in-depth: identity predicate enforced at storage layer; anonymous → fail-closed.

Three storage-layer impls; all three predicate every read on `identity_id`.

### i.1 `InMemoryMemoryStore` — slice E P2 PR #156

`src/platform/memory/in-memory-store.ts`:

- Storage layout (line 86-94 header):
  > Identity isolation is enforced by keying both maps on `IdentityId` — a query for one identity NEVER reads another identity's array. There is no cross-identity index of any kind.
- `recall` reads `this.semanticByIdentity.get(parsed.identityId)` at line 165 — NO fallback to other identities.
- `list` (line 202-208) delegates to `listPaginated` (line 219-241) which reads `this.episodicByIdentity.get(query.identityId)` (line 226) and `this.semanticByIdentity.get(query.identityId)` (line 232) — both keyed on `IdentityId`.
- `forget` (line 248-250) delegates to `tryForget` which walks `removeFromMap` (line 417-429); the bucket walk is keyed on the `MemoryEntryId` brand, not on identity — but `forget` is NOT called by slice K.

**Anonymous identity fail-closed**: `MemoryListQuery.identityId` is `IdentityId` brand-typed (line 25). Constructing one requires `asIdentityId(string)` (`src/platform/identity/identity-id.ts`) which the slice-D resolver short-circuits when no identity is bound. Phase 4 `RecallReminderTool` will resolve the identity at the tool-context boundary and fail-closed when undefined — ZERO `MemoryStore` calls in the anonymous path.

### i.2 `SqliteVecMemoryStore` — slice E P3 PR #160

`src/platform/memory/sqlite-vec-store.ts`:

- Schema (line 151, 160 header comments):
  > `identity_id TEXT NOT NULL,     -- IdentityId`
- Storage class (line 170-172 header):
  > Identity isolation: every read predicates on `identity_id = ?`. There is NO cross-identity index. The vec0 table omits `identity_id` (vec0 columns are 32-bit-only); identity scoping is enforced by JOIN to `semantic_entries` and re-applies the `identity_id` filter.
- Schema CREATE statements (lines 186-220):
  - `episodic_events` table line 186: `identity_id TEXT NOT NULL`
  - `episodic_events_identity_idx` index line 195-197: `ON episodic_events(identity_id, created_at)`
  - `episodic_events_identity_family_idx` index line 200-202: `ON episodic_events(identity_id, effect_family, created_at)`
  - `semantic_entries` table line 207: `identity_id TEXT NOT NULL`
  - `semantic_entries_identity_idx` index line 215-217: `ON semantic_entries(identity_id, created_at)`
- Read sites (line numbers from `Grep identity_id`):
  - line 392: `INSERT episodic_events ... identity_id = parsed.identityId` (write)
  - line 412: `INSERT semantic_entries ... identity_id = parsed.identityId` (write)
  - line 453: `recallVector(parsed.identityId, queryVec, limit)` (read)
  - line 466: `recallLike(parsed.identityId, parsed.query, limit)` (read fallback)
  - line 476: `listEpisodicRows(this.db, query.identityId, query.effectFamily, limit)` (read)
  - line 477: `listSemanticRows(this.db, query.identityId, limit)` (read)
  - line 530: `WHERE s.identity_id = ?` (recallVector JOIN clause)
  - line 558: `WHERE identity_id = ?` (recallLike LIKE clause)
  - line 602: `WHERE identity_id = ? AND effect_family = ?` (listEpisodicRows family-filtered)
  - line 611: `WHERE identity_id = ?` (listEpisodicRows family-unfiltered)
  - line 629: `WHERE identity_id = ?` (listSemanticRows)

**Every SQL `WHERE` clause on a read site has `identity_id = ?` as the first predicate.** No cross-identity index exists; even the vec0 cosine-similarity JOIN re-applies the filter at line 530.

### i.3 `LlmExtractorMemoryStore` — slice E P4 PR #165

`src/platform/memory/llm-extractor-store.ts`:

- Read paths (line 235-237, 243-245):
  ```ts
  recall(query: SemanticMemoryQuery): Promise<MemoryRecallResult> {
    return this.delegate.recall(query);
  }

  list(query: MemoryListQuery): Promise<MemoryListResult> {
    return this.delegate.list(query);
  }
  ```
  Both delegate verbatim to the underlying store (in-memory or sqlite-vec). NO transformation, NO unwrapping of `identityId`.
- Write paths (line 209, 224) preserve `parsed.identityId` through `SemanticMemoryWriteSchema.parse(write)` (line 193) — `identityId` is brand-validated at the boundary before delegation.

**LlmExtractorMemoryStore does NOT introduce a cross-identity read path.** It is a pure wrapper.

### i.4 Payload-field privacy enumeration

Every payload field carried by the 5 LIT families that slice K reads:

| Family | Field | Cross-identity leak risk if predicate dropped |
|---|---|---|
| `persistent_session` | `messageRole` | None (literal `"user"` / `"assistant"`) |
| `persistent_session` | `messageText` | **HIGH** (operator-typed text) |
| `persistent_session` | `messageId` | None (opaque session id) |
| `persistent_session` | `occurredAt` | None (timestamp) |
| `task` | `taskId` | Low (opaque slug) |
| `task` | `ownerIdentityId` | **HIGH** (other identity's id) |
| `task` | `label` | **HIGH** (operator-named task label) |
| `task` | `result` | **HIGH** (operator-typed result text) |
| `task` | `occurredAt` | None |
| `artifact` | `artifactId` | Low (opaque) |
| `artifact` | `kind` | Low (closed enum-like) |
| `artifact` | `occurredAt` | None |
| `repo` | `repoOperationId` | Low (opaque) |
| `repo` | `kind` | None (closed enum) |
| `repo` | `branchName` | **MEDIUM** (operator branch name often carries project / customer name) |
| `repo` | `commitSha` | None |
| `repo` | `occurredAt` | None |

**HIGH-leak fields**: `persistent_session.messageText`, `task.ownerIdentityId`, `task.label`, `task.result`. Identity-predicate enforcement is **non-negotiable**. Phase 4 acceptance test `identity-isolation reverse-test` (sub-plan Phase 4 + Phase 6 case 6) MUST verify operator A never receives operator B's entries even when both call `RecallReminderTool` with overlapping `recallWindow`.

### i.5 Lint guard recommendation

Sub-plan §7 Risks row 1 stipulates:

> Cross-identity leak | Acceptance #6 reverse-test; lint `lint:reminder:no-memory-store-call-without-identity`

Phase 4 will introduce a guard that asserts every `memoryStore.list(...)` / `memoryStore.recall(...)` call site **inside `src/platform/reminder/`** has `identityId:` in its argument literal. Phase 4 implementation note.

---

## §j. Date-range invariant #5 hard line

Slice K modules (`src/platform/reminder/**/*.ts`, `src/agents/tools/recall-reminder-tool.ts`, `src/agents/pi-embedded-runner/run/reminder-runtime-adapter.ts`) **NEVER regex-match raw user text**.

### j.1 Sole sanctioned raw-text reader is `IntentContractor`

`src/platform/commitment/intent-contractor-impl.ts:21, 70, 357`:

- Line 21 imports `RawUserTurn` (the brand-typed wrapper).
- Line 70 docstring on `InboundMediaAttachment`:
  > Per invariants #5/#6 the resolver MUST NOT route raw user text through this surface — the contractor stays the ONLY sanctioned reader of `RawUserTurn` text.
- Line 357 (inline comment context):
  > only sanctioned reader of `RawUserTurn` / `UserPrompt`).
- Line 671: `const rawTurn = makeRawUserTurn(params.prompt);` — the construction site; raw text crosses the trust boundary here and ONLY here.

### j.2 Validation chain — LLM output → Zod → `SemanticIntent.constraints` → `RecallReminderTool`

Phase 5 + Phase 4 chain:

1. **LLM classification** (Phase 5). Operator types «какой PDF я делал на прошлой неделе?» → contractor LLM populates `<recall_window>` block with `{from: "<-7d>", until: "<now>"}` ISO-8601 strings. The LLM is the temporal-expression resolver — NOT a regex layer in slice K modules. Sub-plan Phase 5:
   > the LLM doing temporal-expression → ISO-8601 conversion as STRUCTURED classification, NOT regex on user text
2. **Zod validation at contractor boundary**. `src/platform/memory/episodic-memory-event.ts:389-397`:
   ```ts
   const ISO8601_PATTERN =
     /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

   const IsoTimestampSchema = z
     .string()
     .min(1)
     .regex(ISO8601_PATTERN, {
       message: "occurredAt must be a valid ISO-8601 timestamp",
     });
   ```
   Phase 2 `ReminderQueryShapeSchema` will reuse this `ISO8601_PATTERN` (re-export from `episodic-memory-event.ts` or a dedicated `src/platform/reminder/iso8601.ts` re-export — Phase 2 decides). Malformed temporal output from the LLM → schema rejection → `recall_window_invalid` uncertainty tag → fail-soft (no window filter, contractor proceeds without `recallWindow`).
3. **`SemanticIntent.constraints.recallWindow` carrier**. Open record (see §f) carries the validated structured value across the contractor boundary. The structural fields are NEVER raw text.
4. **`RecallReminderTool` reads structured value**. Phase 4 schema:
   ```ts
   ReminderQueryShape = {
     ownerIdentityId,
     recallWindow?: {from?, until?},
     effectFamilyFilter?: readonly EpisodicEffectFamily[],
     textHint?,
     limit?,
   };
   ```
   Tool schema is `.strict()` (sub-plan Phase 4) and rejects free-form `query: string` — invariant #5/#6 reverse-test:
   > schema accepts CLOSED `ReminderQueryShape` only (NOT free-form `query: string` — invariants #5/#6 reverse-test); identityId injected from session context (NOT user input)

### j.3 Lint guard recommendation

Sub-plan §7 Risks row 2:

> Regex on raw user text | Acceptance #7 hard line; lint `lint:reminder:no-raw-text-regex`

Phase 4 / Phase 6 will add a lint that scans `src/platform/reminder/**/*.ts` and `src/agents/tools/recall-reminder-tool.ts` for `\.match(/`, `\.test(/`, `\.exec(/`, `RegExp(`, `new RegExp` — any hit fails the build. The guard does NOT scan `intent-contractor-impl.ts` (the contractor is the sanctioned reader and uses `ISO8601_PATTERN` regex on LLM-emitted output, not on raw user text).

### j.4 `textHint` field is structural, NOT raw text

Phase 4 `ReminderQueryShape.textHint`:

> textHint STRUCTURAL only (NOT raw text — #5)

The contractor's LLM produces `textHint` as a **structured classification fragment** (e.g. «PDF» when the operator says «какой коммерческий offer»), not by extracting a substring of the raw turn. Phase 4 + 5 implementation note: the contractor MUST NOT pipe `params.rawTurn.text` into `textHint`. Phase 5 contractor 1-shot fixture asserts the LLM produces `textHint: 'commercial offer'` (or similar normalized hint) — NOT the verbatim user phrase. The tool then UNIONs the per-family episodic listings with `MemoryStore.recall({identityId, query: textHint})` semantic similarity (sub-plan Phase 4):

> optionally union with `MemoryStore.recall({identityId, query: textHint})` semantic-similarity entries

`SemanticMemoryQuery.query` (`src/platform/memory/semantic-memory.ts:50`) is `string` — it takes whatever structured hint slice K supplies; it does NOT receive raw user text per §j.1.

---

## §k. Phase 1 deliverable summary — go/no-go for Phase 2

| Gate | Status |
|---|---|
| §a `MemoryStore.recall` + `list` mapped; SINGLE-`effectFamily` confirmed | OK |
| §a Decision N parallel `list()` calls | OK — sub-plan §10 aligned |
| §b 5 LIT episodic-event slots + PR squash SHAs verified | OK |
| §b `policy_*` exclusion confirmed | OK |
| §b `subagent.created` + `reminder.set` STUB exclusions confirmed | OK |
| §c `MemoryListQuery` interface UNCHANGED | OK — invariant §1 #11 holds |
| §d Contractor allowlist 5 → 6 (post-slice-K-P5) | OK — additive precedent |
| §e NEW `reminder` family decision justified across 4 axes | OK |
| §f `SemanticIntent.constraints` open record re-confirmed | OK — slice F audit §2.4 carry-over |
| §g NEW-C outbound coalescer landed; slice K consumes existing surface | OK |
| §h Cron / Scheduler PUSH path explicitly out of scope | OK |
| §i Storage-layer identity predicate enforced in all 3 impls | OK |
| §j Date-range invariant #5 hard line — LLM-driven via `ISO8601_PATTERN` Zod | OK |

**Phase 1 audit complete. Phase 2 (`ReminderQueryShape` types + Zod schema) is unblocked.**

---

## References

- `src/platform/memory/memory-store.ts` (slice E P1 — frozen interface)
- `src/platform/memory/episodic-memory-event.ts` (slice E P1 + cutover-3 P2 + cutover-4 P2 + PolicyGate Full P2 — discriminated-union episodic surface)
- `src/platform/memory/in-memory-store.ts` (slice E P2 — InMemoryMemoryStore impl, identity-keyed)
- `src/platform/memory/sqlite-vec-store.ts` (slice E P3 — SqliteVecMemoryStore impl, `identity_id` SQL predicate)
- `src/platform/memory/llm-extractor-store.ts` (slice E P4 — LlmExtractorMemoryStore wrapper)
- `src/platform/memory/semantic-memory.ts` (slice E P1 — SemanticMemoryQuery / Write / Entry shapes)
- `src/platform/commitment/intent-contractor-impl.ts` (frozen-layer additive — sole `RawUserTurn` reader)
- `src/platform/commitment/effect-family-registry.ts` (slice-D PR-2 — closed-set effect-family allowlist)
- `src/platform/commitment/semantic-intent.ts` (slice-D PR-2 — `SemanticIntent` shape + open `constraints`)
- `src/platform/commitment/cutover-policy.ts` (cutover-2/3/4 — `CUTOVER_2` array)
- `src/platform/commitment/world-state.ts` (cutover-3 / cutover-4 P3 precedent — `WorldStateSnapshot` slice)
- `src/infra/outbound/outbound-coalescer.ts` (NEW-C P3 — outbound coalescer impl)
- `extensions/AUDIT-cutover3-artifacts.md` (cutover-3 audit precedent — frozen-layer additive shape)
- `extensions/AUDIT-cutover4-repo-operation.md` (cutover-4 audit precedent — same)
- `extensions/AUDIT-task-ledger.md` (slice F audit — §2.4 SemanticIntent.constraints open-record finding)
- `.cursor/plans/commitment_kernel_slice_k_reminder.plan.md` (slice K sub-plan)
- `.cursor/plans/commitment_kernel_v1_master.plan.md` (master plan §0.5.6 + §16 — slice K open frontier)
- `.cursor/rules/commitment-kernel-invariants.mdc` (16 hard invariants)
