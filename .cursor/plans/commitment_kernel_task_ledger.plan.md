---
name: Slice F — TaskLedger (per-IdentityId task scheduler)
overview: "Cross-`/new` task tracking keyed by `IdentityId` (slice D) on top of `MemoryStore` (slice E). New `TaskLedger { create, list, get, update, complete, cancel }` makes tasks first-class persistent entities so the orchestrator can answer «какие у меня сейчас задачи?» / «какая последняя задача?» / «отмени задачу X» across `/new` boundaries. Closes B7 (parallel tasks) reframed for v1 (per-user multi-task; multi-user is v2). Interface lives in NEW module `src/platform/task/`. The 5 frozen contracts — including `TaskContract` — are NOT redefined; `TaskLedger` is a separate runtime surface for cross-session task RECALL/list."
todos:
  - id: f-phase-1-audit
    content: "Phase 1 — Audit (read-only). Output `extensions/AUDIT-task-ledger.md`. Map: (a) every existing «task»-shaped surface (`src/platform/decision/task-classifier.ts` frozen, `src/plugin-sdk/llm-task.ts`, `src/agents/*` task usages, `src/platform/session/intent-ledger.ts` per-session sibling pattern), (b) the frozen `TaskContract` shape vs. the new `TaskRecord` shape (must be syntactically distinct types — no name collision, no implicit conversion), (c) every place a `task.*` effect family exists or is implied in `src/platform/commitment/effect-family-*` and `monitored-runtime.ts` attestation outputs, (d) the slice E `EpisodicMemoryEvent` `task.*` slot status (typed-but-inert per Phase 5 handoff PR-#169), (e) confirm `IntentContractor` recall pattern (`<memory>` block PR-#168) is reusable for an `<active_tasks>` block, (f) **CRITICAL** decision: does extending `TargetRef` in `src/platform/commitment/semantic-intent.ts` with `kind: \"task\"` count as a frozen-layer change requiring master-plan amendment? §11 + roadmap row F suggest yes; resolve before Phase 2."
    status: pending
  - id: f-phase-2-task-ledger-interface-and-types
    content: "Phase 2 — `TaskLedger` interface + types in NEW module `src/platform/task/`. Pure API: `TaskId` brand (distinct from `IdentityId`/`SessionId`/`EffectId`/`MemoryEntryId`), `TaskStatus = \"open\" | \"in_progress\" | \"completed\" | \"cancelled\" | \"failed\"`, `TaskRecord { id, ownerIdentityId, label, status, summary, createdAt, updatedAt, completedAt?, result?, sourceEffectFamily?, sourceEffectId? }`, `TaskCreateInput`, `TaskUpdatePatch`, `TaskListQuery { ownerIdentityId, statuses?, limit?, since? }`, `TaskListResult`, `TaskLedger { create, list, get, update, complete, cancel }`. Pure types + Zod schemas + zero-arg test fixtures only — no impl. Tests: schema round-trip, brand discipline (assigning `string`/`IdentityId`/`MemoryEntryId` to `TaskId` is a TypeScript error), status state-machine validation (e.g. `cancelled → completed` rejected by `TaskUpdatePatch.parse`), discriminated-union exhaustiveness compile-check on `TaskStatus`. **Frozen `TaskContract` is NOT touched** — `TaskRecord` is a sibling, not a successor."
    status: pending
  - id: f-phase-3-in-memory-impl
    content: "Phase 3 — `InMemoryTaskLedger` impl (Map-backed, no I/O) in `src/platform/task/in-memory-task-ledger.ts`. Per-`IdentityId` isolation via internal Map keys (mirrors `InMemoryMemoryStore` discipline from slice E Phase 2 PR-#156). Tests: round-trip create→get→update→complete, identity isolation (`identity:vladimir` tasks NOT visible from `identity:alice`), `list` paginated stable-ordered (newest-first by `createdAt` then `id`), status filter (`statuses: [\"open\", \"in_progress\"]`), state-machine guard (cannot transition `completed → open`), idempotent `cancel` on already-cancelled (no-op + warning), `get` of unknown id returns `undefined` (NOT throw), schema rejection on malformed `TaskCreateInput`."
    status: pending
  - id: f-phase-4-sqlite-impl
    content: "Phase 4 — `SqliteTaskLedger` impl in `src/platform/task/sqlite-task-ledger.ts`. Mirrors slice E `SqliteVecMemoryStore` storage discipline (PR-#160) — `node:sqlite` `DatabaseSync`, idempotent `CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, identity_id TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL, source_effect_family TEXT, source_effect_id TEXT, result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER)` + `schema_version` row + index on `(identity_id, status, created_at DESC)`. **Per-`IdentityId` isolation** — every read predicates on `identity_id = ?`; `TaskId` alone never crosses operators. DB path: `~/.openclaw-dev/task/identity-task-ledger.sqlite` (separate from memory DB to keep blast radius isolated). Tests against real tmp-dir sqlite file: round-trip persists across reopen, schema migration idempotency (3 sequential opens), identity isolation across two operators on same DB, malformed input rejected by Zod, `update` on unknown id returns `{kind: \"not_found\"}` (NOT throw), `list` with status filter + pagination, concurrent-write transaction safety."
    status: pending
  - id: f-phase-5-commitment-runtime-task-hook
    content: "Phase 5 — wire task lifecycle into the commitment-runtime boundary. Hook lives OUTSIDE `src/platform/commitment/` per invariant #8 — NEW file `src/agents/pi-embedded-runner/run/task-write-on-satisfied.ts` (sibling of slice E's `memory-write-on-satisfied.ts` PR-#169). Trigger: `attestation.commitmentSatisfied === true` AND attestation effect family is `task.*` (or carries a `taskRef`). On `task.created` → ledger `create` + episodic memory event family `task.created` (slot already typed-but-inert in slice E). On `task.completed` → ledger `complete` + episodic `task.completed`. On `task.cancelled` → ledger `cancel` + episodic `task.cancelled`. **Defense-in-depth (#15)**: ledger write failure is logged warn and the commitment STILL satisfies — task tracking does NOT gate the kernel. Anonymous sessions (no `IdentityId`) skip cleanly with no leak. **Frozen layer untouched**: `MonitoredRuntime` is unchanged; the hook reads the attestation OBJECT through the same structural type pattern slice E established (`CommitmentSatisfiedAttestationLike` shape, no value imports from `src/platform/commitment/`). Tests: hook fires only on `task.*` effect family + `commitmentSatisfied=true` (reverse: `false` writes nothing; non-task family writes nothing); ledger write failure does NOT downgrade attestation; missing `IdentityId` → no-op; both ledger AND episodic memory event are emitted (cross-reference invariant)."
    status: pending
  - id: f-phase-6-active-tasks-block-and-recall
    content: "Phase 6 — task recall surface. Two readers: (a) `IntentContractor` injects an `<active_tasks>` block into its prompt, mirroring slice E's `<memory>` block (PR-#168) and the `<web_evidence>` precedent. (b) Helper `src/platform/task/active-tasks-block.ts` formats `TaskRecord[]` (filtered to `status ∈ {open, in_progress}`) into the prompt block — newest-first, with `id`/`label`/`status` only (NOT `summary` — keep block compact; LLM can cross-reference). The `TaskLedger` is injected into `createIntentContractor(...)` as an optional dep alongside `MemoryStore`: `taskLedger?: TaskLedger`, `identityId?: IdentityId` (already present from slice E). Recall happens INSIDE `intent-contractor-impl.ts` — the only invariant #6-sanctioned reader of raw user text. Empty result → no `<active_tasks>` block (no whitespace pollution). Recall failure → no block + `task_recall_failed` uncertainty tag + warn log; NEVER throws into the contractor. Tests: contractor with no `taskLedger` dep is byte-identical to today (regression guard); empty list → no block; N tasks → exactly N entries; recall failure → uncertainty tag; anonymous session (no `IdentityId`) → no recall attempted."
    status: pending
  - id: f-phase-7-acceptance-fixture-b7-replay
    content: "Phase 7 — end-to-end acceptance test for B7 closure (per-user parallel tasks survive `/new`). Test file: `src/platform/task/b7-replay.acceptance.test.ts`. Fixture-mode (no real Telegram, no real LLM — stubbed embedder + recorded LLM responses + real tmp-dir sqlite for both `SqliteVecMemoryStore` AND `SqliteTaskLedger`): (a) inject `IdentityRegistry` with one operator + a `SqliteTaskLedger` pointed at a tmp file, (b) turn 1 fires a tool that produces a `task.created` attestation → ledger row written, episodic event written, (c) clear in-process turn cache (simulates `/new`); reopen contractor with a fresh `SqliteTaskLedger` instance against the SAME tmp file, (d) turn 2 with prompt «какая моя последняя задача?» → `<active_tasks>` block appears in contractor prompt → response surfaces task label. Reverse-tests: omit `taskLedger` → no `<active_tasks>` block (proves wiring is what carries closure); anonymous session → no block; `commitmentSatisfied=false` reverse → no ledger row written. **B7 CLOSED** when this test passes."
    status: pending
isProject: false
---

# Slice F — TaskLedger (per-IdentityId task scheduler)

## 0. Provenance

| Field | Value |
| --- | --- |
| Sub-plan of | `.cursor/plans/commitment_kernel_v1_release_roadmap.plan.md` (slice F; §3 row "F. Per-user task scheduler — TaskLedger") |
| Inherits | 16 hard invariants from `.cursor/rules/commitment-kernel-invariants.mdc` |
| Predecessors | Slice D (channel-agnostic identity) — landed on `dev`. `IdentityId` / `IdentityRegistry` / `resolveIdentityFromSessionKey` available. Slice E (memory layer) — landed on `dev` 2026-05-05 (PRs #154/#156/#160/#168/#169/#170; B1 CLOSED). `MemoryStore`, `EpisodicMemoryEvent` `task.*` slot (typed-but-inert), `<memory>` block + `memory-write-on-satisfied.ts` hook pattern available. |
| Trigger | v1 Release Roadmap §3 group 1, after slice E. Closes B7 (parallel tasks). Reframed from original "concurrent broker (multi-user)" — multi-user is v2; v1 covers per-user multi-task. |
| Out of scope | (a) Multi-user / multi-tenant — v2. (b) Subagent registry — slice G. (c) Cron query/list/cancel — slice J (cron entries are NOT TaskLedger entries; they live in their own surface, but a cron-fired task may produce a `TaskRecord` via the Phase-5 hook). (d) Live-verify B7 against a real Telegram log — v1-release acceptance step §5 of master roadmap, not this slice (slice ships fixture-mode acceptance only). (e) Modifying the frozen `TaskContract` — `TaskLedger`/`TaskRecord` are siblings, not successors. (f) Extending `TargetRef` in `src/platform/commitment/semantic-intent.ts` with `kind: "task"` — see §3 hypothesis: this slice ships WITHOUT that extension; if the orchestrator-level UX in roadmap row F demands it, surface as a §6-amendment proposal in Phase 6 handoff. |
| Maintainer signoff | REQUIRED at slice level (architectural — adds `TaskLedger` concept and a new persistent store). Plus per-phase signoff for Phase 2 (interface introduction) and Phase 5 (commitment-runtime hook). Phase 6 is additive (constructor adds optional dep) per slice E precedent — does NOT need master amendment. |

## 1. Hard invariants this slice keeps

- **#5, #6**: `TaskLedger` reads structured types (`TaskCreateInput`, `TaskUpdatePatch`, `TaskListQuery`), NEVER `RawUserTurn` / `UserPrompt`. The `<active_tasks>` block in Phase 6 is built INSIDE `intent-contractor-impl.ts` — the only invariant #6-sanctioned reader of raw user text. The contractor stays the sole reader; the ledger is fed structured records.
- **#8**: New module `src/platform/task/` mirrors `src/platform/identity/` and `src/platform/memory/` layout. NO modifications to `src/platform/commitment/` source — including the 5 frozen contracts (§11). The Phase 5 hook (`task-write-on-satisfied.ts`) lives in `src/agents/pi-embedded-runner/run/`, the established bridge boundary. New module imports only `src/platform/identity/`, `src/platform/memory/` (for episodic cross-reference), Zod, and stdlib.
- **#9, #10**: No new done-predicates. The Phase 5 hook reads the existing `RuntimeAttestation.commitmentSatisfied` boolean only; it does not introspect raw text or `TaskContract`. State-machine guards (e.g. `completed → open` rejected) live in the LEDGER layer, not in any predicate.
- **#11**: **The 5 frozen decision contracts (`TaskContract`, `OutcomeContract`, `QualificationExecutionContract`, `ResolutionContract`, `RecipeRoutingHints`) are NOT touched.** **Critical distinction**: `TaskContract` is a frozen DECISION-LAYER contract (planner input shape under `src/platform/decision/`); `TaskRecord` is a NEW commitment-runtime artifact for cross-session RECALL/list under `src/platform/task/`. They are sibling concerns: `TaskContract` describes "what to do this turn"; `TaskRecord` describes "what got committed across all turns under this identity". A `task.*` effect-family attestation is the bridge between them — it carries enough structured signal for the Phase 5 hook to write a `TaskRecord` WITHOUT reading the planner's `TaskContract` value. The Phase 6 contractor change is additive (optional `taskLedger?` constructor dep), mirroring slice E Phase 6 PR-#168.
- **#15**: Defense-in-depth — Phase 5 ledger write failure does NOT gate commitment satisfaction. Failure path: `warn` log + commitment still satisfies + caller turn proceeds. Same posture slice E established for memory writes.
- **#16**: `IdentityId` is the ONLY cross-session key. `TaskId` is a NEW brand distinct from `IdentityId`/`SessionId`/`EffectId`/`EffectFamilyId`/`MemoryEntryId`; runtime + compile-time non-assignability tested in Phase 2.

## 2. Audit findings (TO BE FILLED IN BY PHASE 1)

> Phase 1 produces `extensions/AUDIT-task-ledger.md` with concrete findings; the sketches below are starting points, not conclusions.

### 2.1. Existing task-shaped surfaces in the repo (sketch)

The audit must enumerate every surface that uses the word "task" and classify each as: (i) frozen / off-limits, (ii) related but distinct (coexists), (iii) consumed by slice F. Initial pointers:

- `src/platform/decision/task-classifier.ts` — **frozen** (rule-heavy classifier; produces `ClassifiedTaskResolution.plannerInput.taskContract` — the frozen `TaskContract` value). Slice F neither reads nor writes this.
- `src/platform/decision/contracts.ts` — **frozen**. Home of `TaskContract`, `OutcomeContract`, `QualificationExecutionContract`. Slice F does not import.
- `src/plugin-sdk/llm-task.ts` — plugin-side LLM task abstraction (single-shot LLM call). Distinct concept from `TaskRecord`. Coexists.
- `src/daemon/schtasks*.ts`, `src/infra/windows-task-restart.ts` — Windows scheduled-task OS surface. Different layer. Coexists.
- `src/platform/session/intent-ledger.ts` — **per-session** sibling pattern. Slice F's `TaskLedger` is the **cross-`/new`** analog keyed by `IdentityId`, not `sessionId`.
- `extensions/*` — audit must check for any plugin that emits `task.*` effect-family attestations today.

### 2.2. `task.*` effect family in the commitment runtime (sketch)

Audit must answer:
- Does the current `EffectFamilyId` registry already enumerate a `task.*` family? If yes, who emits it today?
- Does `RuntimeAttestation` (`monitored-runtime.ts`) carry enough structured signal (`effectFamily`, `effectId`, optional payload) for the Phase 5 hook to construct a `TaskRecord` WITHOUT reading `TaskContract`?
- Slice E Phase 5 (PR-#169) typed-but-inert `EpisodicMemoryEvent` slots include `subagent.created` / `reminder.set` / `artifact.created`. Confirm whether `task.created` / `task.completed` / `task.cancelled` slots already exist in the discriminated union or need to be added in Phase 2.

### 2.3. `<active_tasks>` block / contractor recall site (sketch)

`intent-contractor-impl.ts` already prepends `<web_evidence>` (search-composer pipeline) and `<memory>` (slice E PR-#168) blocks. The `<active_tasks>` block follows the SAME pattern. The recall-failure-emits-uncertainty-tag pattern (slice E `memory_recall_failed` → `task_recall_failed`) is also reusable verbatim.

### 2.4. CRITICAL audit question — `TargetRef` extension

Roadmap row F lists `src/platform/commitment/semantic-intent.ts` (extend `target` with `task` kind + `taskRef`) under "Files". `semantic-intent.ts` is INSIDE the frozen `src/platform/commitment/` boundary. Per invariant #11 + the frozen-layer label policy, ANY change to source under `src/platform/commitment/` requires explicit master-plan amendment + maintainer signoff.

**This sub-plan defaults to NOT extending `TargetRef`** — the orchestrator's user-facing UX («отмени PDF» / «как там?») can be served by the contractor's `<active_tasks>` block PLUS the existing `TargetRef.kind: "unspecified"` plus an LLM-resolved `taskRef` carried in `constraints` (free-form `ReadonlyRecord`, already part of `SemanticIntent`). If Phase 1 audit concludes `constraints` is insufficient and a first-class `TargetRef.kind: "task"` is required, that finding is escalated as a **§6-amendment proposal** before Phase 2 commits — slice F does NOT silently widen the frozen surface.

### 2.5. Identity surface (sketch)

`src/platform/identity/` exposes `resolveIdentityFromSessionKey(sessionKey, registry) → IdentityId | undefined`. Slice F uses this as the SOLE entrypoint to a ledger key; no new identity-resolution code in this slice.

### 2.6. Slice E memory store (sketch)

`MemoryStore` from `src/platform/memory/` is consumed in Phase 5 (cross-reference: every ledger write also emits an episodic memory event of family `task.*`) and ALSO available to the contractor in Phase 6 (memory-and-tasks recall side-by-side). The `EpisodicMemoryEvent` `task.*` slot is typed-but-inert per slice E PR-#169 — slice F lights it up.

## 3. Hypothesis

The TaskLedger is shaped by THREE forces:

1. **Slice D foundation** — `IdentityId` is the single primary key for all cross-session state. TaskLedger keys on `IdentityId`, not `sessionId` or `chatId`.
2. **Slice E foundation** — `MemoryStore` already typed `task.*` episodic slots as load-bearing-but-inert (PR-#169). Slice F is the slice that lights them up. The `<active_tasks>` recall pattern is a near-clone of `<memory>` recall (PR-#168).
3. **The 16 invariants** — frozen `TaskContract` stays frozen; `TaskRecord` is a sibling, not a successor. New module under `src/platform/task/`. Hook outside `src/platform/commitment/`. Defense-in-depth on write failure.

Thus the slice ships:

- **Phase 1** — Audit, with one critical decision (`TargetRef` extension yes/no — see §2.4) escalated before Phase 2 starts.
- **Phase 2** — `TaskLedger` interface + types + Zod schemas. Pure types; no impl. Brand discipline + state-machine guards baked in at the type layer. Unblocks parallel work in Phases 3/4.
- **Phase 3** — `InMemoryTaskLedger` Map-backed impl, mirroring `InMemoryMemoryStore` (slice E PR-#156). Lets Phases 5-7 wire against a deterministic in-process backend before sqlite lands.
- **Phase 4** — `SqliteTaskLedger` `node:sqlite` impl, mirroring `SqliteVecMemoryStore` storage discipline (slice E PR-#160) — schema migration, per-`IdentityId` predicates on every read, separate DB file from memory layer.
- **Phase 5** — Commitment-runtime hook OUTSIDE the frozen layer (sibling of `memory-write-on-satisfied.ts`). On `task.*` family + `commitmentSatisfied=true`: ledger write + episodic memory write (cross-referenced via shared `taskId`/`identityId`).
- **Phase 6** — `<active_tasks>` block in `IntentContractor`, mirroring `<memory>` block (slice E PR-#168). Additive optional constructor dep. Recall-failure → uncertainty tag, never throws.
- **Phase 7** — End-to-end fixture-mode acceptance: B7 closure («какая моя последняя задача?» across `/new`).

Each phase is independently testable; Phase 2 unblocks consumers in slice G (subagent registry can cross-reference tasks) and slice J (cron query → optionally writes a `TaskRecord`).

## 4. Acceptance criteria

1. **`TaskLedger` interface** exists in `src/platform/task/`. Round-trip on `InMemoryTaskLedger` passes. Round-trip on `SqliteTaskLedger` passes. Same test suite passes against either impl when injected.
2. **`TaskId` brand** distinct from `IdentityId`, `SessionId`, `EffectId`, `EffectFamilyId`, `MemoryEntryId` (compile-time + runtime checks per invariant #16).
3. **State-machine guards** — illegal transitions (`completed → open`, `cancelled → in_progress`) rejected at the `TaskUpdatePatch.parse` boundary AND at the impl boundary (defense-in-depth).
4. **Persistent store keys on `IdentityId`** — round-trip survives process restart in fixture mode (sqlite file persists, `list` returns the entry under the same identity, `TaskId` alone never crosses operators).
5. **Commitment hook** writes on `commitmentSatisfied === true` AND `effectFamily` matches `task.*`; skips on `false` or non-task family. Anonymous sessions (no `IdentityId`) skip cleanly. Ledger write failure does NOT downgrade the commitment.
6. **Cross-reference**: every Phase-5 ledger write also emits an `EpisodicMemoryEvent` of family `task.*` carrying the same `taskId` / `identityId`. Memory layer and task ledger are joinable on `IdentityId × TaskId`.
7. **`<active_tasks>` block** appears in `IntentContractor` prompt when at least one open/in-progress task exists for the resolved `IdentityId`, and is absent (no whitespace pollution) otherwise.
8. **B7 fixture acceptance** — turn 1 creates a task (commitment satisfies → ledger write), `/new` simulated, turn 2 with «какая моя последняя задача?» surfaces the task label via `<active_tasks>` injection.
9. **Frozen-layer integrity** — 16 invariants reverse-tests pass on slice-F HEAD. **No new edits to `src/platform/commitment/` source**, including `semantic-intent.ts` (default path; if §2.4 audit forces an amendment, that amendment is a separate gated PR). No new readers of raw user text outside contractor.
10. **Backend pluggable** — Phase 7 acceptance passes against `InMemoryTaskLedger` AND `SqliteTaskLedger` by constructor swap (proves interface integrity).

## 5. Per-phase tests (must catch real bugs — see AGENTS.md "Tests must catch real bugs")

Each phase's tests must:

- **Fail-first.** The negative test must reproduce the absence-of-functionality before the fix lands. Local proof: revert the fix, test fails on the spec'd assertion (not on a `NoMethodError` or import error).
- **No `vi.spyOn` on the function under test.** Use real `TaskLedger` instances (in-memory for Phases 2-3, real tmp-dir sqlite for Phase 4+). Spies are reserved for non-deterministic infrastructure (clock, randomness) AND for verifying that the Phase-5 hook actually called into the injected `TaskLedger` / `MemoryStore` deps — those are spies on DEPS, not on the function under test (the hook itself).
- **Cover the negative case explicitly.** For every Phase: (a) malformed input rejected by Zod, (b) missing `IdentityId` → no-op (NOT throw), (c) backend failure → degrade gracefully (warn + skip, never crash the calling turn), (d) state-machine illegal transition rejected.
- **Phase 7 acceptance** uses a real (tmp-dir) `SqliteTaskLedger` AND a real `SqliteVecMemoryStore`, a real `IdentityRegistry`, a stubbed embedder (deterministic vector based on content hash), and a stubbed LLM responder. The fixture must reproduce B7's symptom in absence-of-fix mode (no `<active_tasks>` block when `taskLedger` is omitted) and the correct outcome in fix-mode (block injected, response surfaces task).

Per-phase specifics:

- **Phase 1**: audit produces a markdown deliverable, not code.
- **Phase 2**: brand discipline — `// @ts-expect-error` lines confirm `string`, `IdentityId`, `MemoryEntryId`, `SessionId`, `EffectId`, `EffectFamilyId` are all non-assignable to `TaskId`. Status state-machine table covered exhaustively (5×5 = 25 transition cells, each marked allowed/rejected).
- **Phase 3**: identity isolation — tasks under `identity:vladimir` not visible from `identity:alice` on the same `InMemoryTaskLedger` instance. Idempotent `cancel` on already-cancelled → no-op + warn.
- **Phase 4**: persistence — open ledger, create task, close, reopen on same DB path, `list` returns the task. Schema migration idempotent across 3 sequential opens. Stress: 100 sequential creates from one process. Identity isolation across two operators on the SAME DB file.
- **Phase 5**: reverse — `commitmentSatisfied=false` produces ZERO ledger writes; non-task family produces ZERO writes. Cross-reference: every successful ledger write triggers exactly one `MemoryStore.storeEpisodic` call with matching `taskId`. Failure isolation: ledger throws → commitment still satisfies AND warn log emitted.
- **Phase 6**: regression — contractor with no `taskLedger` dep is byte-identical to today (snapshot match against slice E PR-#168 baseline). Empty result → no `<active_tasks>` block (whitespace check). Recall failure → contractor still returns a valid `SemanticIntent` with a `task_recall_failed` uncertainty tag. Anonymous session (no `IdentityId`) → no recall attempted.
- **Phase 7**: B7 replay — fixture-mode integration covers full path. Reverse-test: omit `taskLedger`, assert `<active_tasks>` absent and response does NOT mention the task.

## 6. Implementation notes

- **New module path**: `src/platform/task/`. Mirrors `src/platform/identity/` + `src/platform/memory/` layout.
- **DB file path**: `~/.openclaw-dev/task/identity-task-ledger.sqlite`. Distinct from slice E's memory DB.
- **Schema migration**: idempotent `CREATE TABLE IF NOT EXISTS` + a `schema_version` row. v1 = version 1.
- **Cross-reference with slice E memory layer**: Phase 5 hook ALWAYS writes BOTH a `TaskRecord` AND an `EpisodicMemoryEvent` of family `task.*`. Episodic event payload includes `taskId` for downstream JOIN on `(identityId, taskId)`. Failure mode: if EITHER write fails, commitment STILL satisfies; partial-write tolerated.
- **Hook site lives outside frozen layer**: `task-write-on-satisfied.ts` lives in `src/agents/pi-embedded-runner/run/`, sibling to `memory-write-on-satisfied.ts`.
- **`TargetRef` deferral** (per §2.4): slice DOES NOT extend `TargetRef`. User references like «отмени PDF» resolved via `<active_tasks>` block + `constraints` free-form record.
- **No phrase-matching**: per invariant #5, recall does NOT do regex/text-rule matching against `RawUserTurn`.
- **Concurrency**: `node:sqlite` `DatabaseSync` is single-threaded. Wrap writes in transactions; reads non-blocking.
- **Status state machine** (canonical):
  - `open → in_progress`, `open → cancelled`
  - `in_progress → completed`, `in_progress → cancelled`, `in_progress → failed`
  - `completed`, `cancelled`, `failed` are terminal
  - Idempotent: `cancel` on `cancelled` → no-op + warn; `complete` on `completed` → no-op + warn.
- **`TaskRecord.label` is operator-facing text** — stored as-is, channel-keyed sanitization is slice I's job.

## 7. Handoff Log

### 2026-05-05 — Sub-plan kickoff

- Sub-plan written. Awaiting maintainer signoff before Phase 1 commit.
- Predecessor slice E COMPLETE (PRs #154/#156/#160/#168/#169/#170; B1 CLOSED 2026-05-05). `MemoryStore`, `SqliteVecMemoryStore`, `<memory>` block, `memory-write-on-satisfied.ts`, B1-replay fixture all available as templates.
- Predecessor slice D landed on `dev`; identity surface available.
- Frozen `TaskContract` is in `src/platform/decision/contracts.ts`; this slice does NOT touch it.
- **CRITICAL open audit question** for Phase 1: does extending `TargetRef` in `src/platform/commitment/semantic-intent.ts` count as a frozen-layer change? Default per §2.4 is NO extension; resolved as part of Phase 1 deliverable.
- Branch: `audit/v1-slice-f-task-ledger-phase-1` (Phase 1, read-only audit).

## 8. Adjacent / deferred (out of scope)

| Item | Why deferred |
| --- | --- |
| Multi-user / multi-tenant TaskLedger | v2. |
| Subagent registry | Slice G — separate surface. |
| Cron query/list/cancel | Slice J — cron entries live in their own surface. |
| Live-verify B7 replay against real Telegram log | v1-release acceptance step §5 of master roadmap. |
| Modifying frozen `TaskContract` | Frozen per §11. `TaskRecord` is a sibling. |
| Extending `TargetRef` with `kind: "task"` | Frozen-layer touch; default deferred unless Phase 1 escalates. |
| Channel-aware redaction of task labels | Slice I (sanitizer) wraps the `<active_tasks>` block. |
| Consolidating with `src/daemon/schtasks*` Windows OS surface | Different layer; out of scope. |
| Reconciliation between F ledger and E episodic events on partial-write | Slice K (reconciler) — out of scope. |

## 9. References

- Roadmap: `.cursor/plans/commitment_kernel_v1_release_roadmap.plan.md` (slice F row §3).
- Predecessor: `.cursor/plans/commitment_kernel_memory_layer.plan.md` (slice E — landed).
- Predecessor: `.cursor/plans/commitment_kernel_channel_agnostic_persistence.plan.md` (slice D — landed).
- Hard invariants: `.cursor/rules/commitment-kernel-invariants.mdc`.
- Frozen-layer policy: `.cursor/rules/decision-layer-frozen.mdc`.
- Frozen `TaskContract`: `src/platform/decision/contracts.ts`.
- Frozen `task-classifier`: `src/platform/decision/task-classifier.ts`.
- Per-session `IntentLedger`: `src/platform/session/intent-ledger.ts`.
- Identity surface: `src/platform/identity/`.
- Slice E memory surface: `src/platform/memory/`.
- Slice E hook precedent: `src/agents/pi-embedded-runner/run/memory-write-on-satisfied.ts` (PR-#169).
- Slice E recall precedent: `src/platform/commitment/intent-contractor-impl.ts` `<memory>` block (PR-#168).
- Slice E acceptance precedent: `src/platform/memory/b1-replay.acceptance.test.ts` (PR-#170).
- Master plan: `.cursor/plans/commitment_kernel_v1_master.plan.md`.
- AGENTS.md test discipline: "Tests must catch real bugs" section.
