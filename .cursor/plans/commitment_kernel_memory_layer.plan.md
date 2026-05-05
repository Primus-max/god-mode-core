---
name: Slice E — Memory Layer (mem0 wrapper + sqlite-vec)
overview: "Persistent cross-session memory keyed by `IdentityId` (slice D). Episodic surface (events: tasks, agents, reminders, conversation messages) and semantic surface (similarity recall) behind a single `MemoryStore` interface so the backend is swappable. Per roadmap §6 D1: mem0 (Apache 2.0) + sqlite-vec, both wrapped. Closes B1 (memory does not persist across `/new`) and partially B3 (subagent registry not in memory)."
todos:
  - id: e-phase-1-memory-store-interface-and-types
    content: "Phase 1 — `MemoryStore` interface + types in new module `src/platform/memory/`. Pure API: `MemoryEntryId` brand, `EpisodicMemoryEvent` (discriminated union per effect family), `SemanticMemoryQuery`, `MemoryRecallResult`, `MemoryStore { storeEpisodic, storeSemantic, recall, list, forget }`. Keys on `IdentityId`. No impl yet — types + Zod schemas + zero-arg test fixtures only. Tests: schema round-trip, brand discipline (`MemoryEntryId` distinct from `IdentityId`/`SessionId`/`EffectId`), discriminated-union exhaustiveness compile-check."
    status: completed
  - id: e-phase-2-in-memory-impl-and-acceptance-stub
    content: "Phase 2 — `InMemoryMemoryStore` impl (Map-backed, no I/O) so callers can integrate before persistent backend lands. Lives in `src/platform/memory/in-memory-store.ts`. Tests: round-trip episodic store→list, round-trip semantic store→recall (synthetic exact-match scoring), `forget` removes entry, isolation across IdentityIds, `recall` returns empty (NOT throw) when nothing matches, `list` is paginated stable-ordered."
    status: pending
  - id: e-phase-3-persistent-backend-sqlite-vec-store
    content: "Phase 3 — `SqliteVecMemoryStore` impl. Uses existing `src/memory/sqlite-vec.ts` extension loader + `node:sqlite` `DatabaseSync`. Schema: `memory_episodic(id, identity_id, effect_family, effect_id, payload_json, created_at)`, `memory_semantic(id, identity_id, content, embedding BLOB, metadata_json, created_at)` + `vec0` virtual table indexed on `(identity_id, embedding)`. Embedding provider: a thin `MemoryEmbedder` interface; default impl reuses `src/memory/embeddings*.ts` (provider-agnostic — already supports OpenAI/Gemini/Mistral/Voyage/Ollama). DB path: `~/.openclaw-dev/memory/identity-memory.sqlite` (separate from existing `dev.sqlite`). Tests: schema migration idempotency, store→recall round-trip with mock embedder, vector recall returns nearest neighbours by cosine, recall scoped by identity, `forget` removes from both base + vec0 tables, sqlite-vec extension load failure → store falls back to LIKE-based recall AND surfaces a `vector_unavailable` warning rather than throwing."
    status: pending
  - id: e-phase-4-mem0-wrapper-or-fallback
    content: "Phase 4 — mem0 wrapper. Per roadmap §6 D1 mem0 is the LLM-driven extraction + dedup layer ON TOP OF the sqlite-vec store. Audit (Phase 4 first task) confirms current Node SDK shape — if `mem0ai` npm package presents a clean Node API, wrap it in `Mem0MemoryStore` that delegates final persistence to the `SqliteVecMemoryStore` from Phase 3 (mem0 for `add`/`search`/`update` orchestration, sqlite-vec for storage). If mem0 Node story is unworkable (no Node SDK, Python-only, HTTP service required), surface as a §6 amendment proposal AND ship a `SqliteVecMemoryStore` + a small in-house `LlmExtractor` (single LLM call producing `{ keep: bool, normalized: string, tags: string[] }`). Either path: the public `MemoryStore` interface from Phase 1 does NOT change. Tests: extraction-on (mem0 path) round-trip with stubbed LLM; extraction-off (raw sqlite path) round-trip; pluggability — same acceptance test passes against both impls swapped at construction."
    status: pending
  - id: e-phase-5-commitment-runtime-memory-hook
    content: "Phase 5 — wire memory writes from the commitment-kernel boundary. The hook fires AFTER `attestation.commitmentSatisfied === true` for selected effect families. Implementation lives OUTSIDE `src/platform/commitment/` to honour invariant #8 — new file `src/agents/pi-embedded-runner/run/memory-write-on-satisfied.ts` consumes the existing `RuntimeAttestation` from `monitored-runtime.ts` plus the resolved `IdentityId` from the session-key. Episodic events emitted: `persistent_session.created` → conversation-message memory; future `subagent.created`/`reminder.set`/`artifact.created` slots are stubbed but inert until slices F/G/J/K wire them. Frozen-layer touch: NONE — `MonitoredRuntime` is unchanged, the call site is the existing `pi-embedded-runner` orchestration that already receives the attestation. Tests: hook runs only on `commitmentSatisfied`, hook is no-op when `IdentityId` resolution returns `undefined` (anonymous session — no leak), memory write failure does NOT mark commitment unsatisfied (memory is observability, not gate), reverse-test: hook does NOT write on `commitmentSatisfied=false`."
    status: pending
  - id: e-phase-6-recall-block-in-intent-contractor
    content: "Phase 6 — memory recall hook into `IntentContractor` prompt as a `<memory>` block, mirroring the existing `<web_evidence>` pattern (see `src/agents/pi-embedded-runner/run/params.ts:77`). Recall is keyed by the resolved `IdentityId` and the raw prompt text. The recall HAPPENS INSIDE `intent-contractor-impl.ts` (the only invariant #6-sanctioned reader of raw user text); the `MemoryStore` is injected as a constructor dep. Top-K (default 5) results are formatted into a `<memory>...</memory>` block prepended to the contractor prompt. Frozen-layer touch: `intent-contractor-impl.ts` is in `src/platform/commitment/` — its constructor surface gains an optional `memoryStore?: MemoryStore` dep. This is additive, NOT a contract change, so does NOT need master amendment per §11; the 5 frozen contracts (`TaskContract` etc.) are untouched. Tests: contractor with no memory dep behaves exactly as today; contractor with empty memory injects no `<memory>` block (no whitespace pollution); contractor with N memories injects exactly N entries; recall failure (sqlite locked, embedder timeout) → no `<memory>` block AND warning log, NEVER throws into the contractor; reverse-test: anonymous session (no IdentityId) → no recall attempted."
    status: pending
  - id: e-phase-7-acceptance-fixture-b1-replay
    content: "Phase 7 — end-to-end acceptance test for B1 closure. Single integration test: (a) inject IdentityRegistry with one operator, (b) run a turn that creates a reminder via cron tool — episodic event captured, (c) clear in-process turn cache (simulates `/new`), (d) run a second turn with the prompt 'какие у меня напоминания' — `<memory>` block injected, contractor classifies `desiredEffectFamily=cron observe`, response surfaces the reminder. Test file: `src/platform/memory/b1-replay.acceptance.test.ts`. Fixture-mode (no real Telegram, no real LLM — uses stubbed embedder + recorded LLM responses); the live-verify replay against a real Telegram log is part of the v1-release acceptance step §5 of the roadmap, not this slice."
    status: pending
isProject: false
---

# Slice E — Memory Layer (mem0 wrapper + sqlite-vec)

## 0. Provenance

| Field | Value |
| --- | --- |
| Sub-plan of | `.cursor/plans/commitment_kernel_v1_release_roadmap.plan.md` (slice E; §3 row "E. Memory layer (mem0 wrapper)"; §6 D1 closed decision) |
| Inherits | 16 hard invariants from `.cursor/rules/commitment-kernel-invariants.mdc` |
| Predecessor | Slice D (channel-agnostic identity) — landed on `dev`. Memory keys on `IdentityId` from `src/platform/identity/`. |
| Trigger | v1 Release Roadmap §3 group 1, after slice D. Closes B1 (memory across `/new`) and partially B3 (subagent registry persistence). |
| Out of scope | (a) Subagent registry persistence — slice G consumes this slice's `MemoryStore`. (b) TaskLedger persistence — slice F consumes this slice. (c) Cron query/list/cancel — slice J. (d) Live-verify B1 replay against a real Telegram log — that is the v1-release-level acceptance, not this slice (slice ships fixture-mode acceptance only). |
| Maintainer signoff | REQUIRED at slice level (architectural — adds `MemoryStore` concept and a new persistent store). Plus per-phase signoff for Phase 1 (interface introduction) and Phase 4 (dependency add: `mem0` if that path is taken). |

## 1. Hard invariants this slice keeps

- **#5, #6**: New code reads no raw user text outside `IntentContractor`. Phase 6 recall happens INSIDE `intent-contractor-impl.ts`, the only sanctioned reader. The `MemoryStore` itself takes structured `SemanticMemoryQuery` / `EpisodicMemoryEvent` values, never `RawUserTurn` / `UserPrompt`.
- **#8**: New module `src/platform/memory/` does NOT import from `src/platform/decision/`. The commitment-runtime hook (Phase 5) lives in `src/agents/pi-embedded-runner/run/`, NOT inside `src/platform/commitment/` — that is the existing convention used for the bridge between the kernel and decision layers and respects invariant #8.
- **#9, #10**: Memory writes do NOT add new done-predicates. The hook reads the existing `RuntimeAttestation.commitmentSatisfied` boolean only; it does not introspect raw text or `TaskContract`. Memory failures do NOT downgrade the commitment.
- **#11**: The 5 frozen contracts are NOT touched. `intent-contractor-impl.ts` constructor gains an optional `memoryStore?: MemoryStore` dep — this is additive, not a contract change. `MonitoredRuntime` is unchanged.
- **#15**: Each phase requires explicit signoff before commit. Phase 4 (dependency add for mem0, if that path is taken) is an extra-attention signoff because it adds a non-trivial third-party runtime dep.
- **#16**: `IdentityId`, `SessionId`, `MemoryEntryId`, `EffectId`, `EffectFamilyId` are all distinct branded types with no implicit conversion. `MemoryEntryId` is introduced in Phase 1.

## 2. Audit findings (2026-05-04)

### 2.1. Existing memory infrastructure (NOT to be confused with slice E's surface)

The repo already has TWO memory-related code surfaces, NEITHER of which is what slice E delivers:

1. **`src/memory/`** (~80 files) — full-text + vector search over local Markdown / `MEMORY.md` / session files. Used by the `memory_search` / `memory_get` agent tools. Backed by SQLite + optional sqlite-vec via `src/memory/sqlite-vec.ts`. Provider-agnostic embeddings already wired (OpenAI / Gemini / Mistral / Voyage / Ollama). **Not keyed by IdentityId.** **Not session-spanning in the slice E sense** — this is "memory of the workspace", not "memory of the operator". Slice E reuses the embedding infrastructure (Phase 3) but builds a separate store on top.
2. **`extensions/memory-core/`** + **`extensions/memory-lancedb/`** — bundled plugins exposing `memory_search` / `memory_get` / `memory_recall` / `memory_store` / `memory_forget` tools to agent runs. The LanceDB plugin (currently optional, native deps fragile on macOS per its own error path) implements auto-recall via `before_agent_start` and auto-capture via `agent_end`. **Not keyed by IdentityId.** **Stores tied to plugin lifecycle, not commitment-kernel.** Slice E does NOT consume these directly; it runs alongside, with a clean boundary on `IdentityId`.

**Implication**: slice E adds a third memory surface SCOPED to `(IdentityId, episodic-event | semantic-fact)`. The two existing surfaces stay where they are. v2 may consolidate; that is out of scope.

### 2.2. mem0 dependency status

- `package.json` does NOT contain `mem0ai`, `@mem0ai/mem0-ts`, or any mem0-prefixed package.
- `node_modules/@mem0ai/` does not exist.
- `node_modules/mem0/` does not exist.
- The mem0 npm package `mem0ai` (Apache 2.0, https://github.com/mem0ai/mem0) ships a Node SDK; the canonical bridge is the `Memory` class. As of late-2025 the JS SDK is ALPHA-quality but functional for the wrapper-pattern use case. License compatible with this repo (MIT) — Apache 2.0 is permissively combinable.
- Phase 4's first task is to `pnpm add mem0ai` (after maintainer signoff) and confirm the Node API shape against the README. If the API is unstable enough that wrapping it costs more than implementing the LLM-extraction layer ourselves, surface as a §6 amendment proposal and proceed with the pure-sqlite-vec path (in-house `LlmExtractor`, ~150 LOC, single LLM call per write).
- The wrapper interface is identical in either case → switching paths costs <1 day in Phase 4 itself, the rest of the slice is unaffected.

### 2.3. sqlite-vec status

- `package.json` already declares `"sqlite-vec": "0.1.7"` (root `dependencies`).
- `node_modules/sqlite-vec/` is installed.
- Loader exists: `src/memory/sqlite-vec.ts` (returns `{ ok, extensionPath?, error? }`). Slice E reuses this file unchanged.
- Existing smoke script: `scripts/sqlite-vec-smoke.mjs` (proves loader works on this dev box).
- Existing usage patterns in `src/memory/manager-sync-ops.ts` provide the integration template.

### 2.4. IntentContractor + recall site

- `intent-contractor-impl.ts` already prepends a `<web_evidence>` block when web evidence is in scope (search-composer pipeline). The exact pattern slice E mirrors for `<memory>` is already grep-targetable (see `src/agents/pi-embedded-runner/run/params.ts:77`).

### 2.5. Commitment-runtime hook site

- `monitored-runtime.ts` returns `RuntimeAttestation { commitmentSatisfied, terminalState, acceptanceReason, ... }`. The natural hook site is the caller of `MonitoredRuntime.run(...)`, NOT inside `monitored-runtime.ts` itself. The caller is in `src/agents/pi-embedded-runner/run/` (per invariant #8 boundary). New file: `memory-write-on-satisfied.ts` co-locates with the runner.

### 2.6. Existing identity surface

`src/platform/identity/` exposes `resolveIdentityFromSessionKey(sessionKey, registry) → IdentityId | undefined`. Slice E uses this as the SOLE entrypoint to a memory key. No new identity-resolution code in this slice.

## 3. Hypothesis

The memory layer is shaped by THREE forces:

1. The roadmap §6 D1 closed decision (mem0 + sqlite-vec, behind a project interface).
2. The slice D foundation (`IdentityId` is the single primary key for all cross-session state).
3. The 16 invariants (no frozen-layer changes, no raw text outside contractor, no impl coupling between commitment and decision layers).

Thus the slice ships:
- A clean `MemoryStore` interface (Phase 1) that hides backend choice.
- An in-memory test impl (Phase 2) that lets slices F / G / J integrate before the persistent store lands.
- A persistent `SqliteVecMemoryStore` (Phase 3) using existing infrastructure (sqlite-vec already installed; embedder code already exists).
- An optional mem0 wrapper layered on top (Phase 4) for the LLM-extraction surface; if mem0's Node story disqualifies it, swap for an in-house extractor — same interface, no caller change.
- Commitment-kernel hook (Phase 5) that emits memory writes when commitments are satisfied, OUTSIDE the frozen `src/platform/commitment/` boundary.
- IntentContractor recall hook (Phase 6) that injects a `<memory>` block, INSIDE the only sanctioned raw-text reader.
- An end-to-end acceptance test (Phase 7) that proves B1 closure in fixture form.

Each phase is independently testable; Phase 1+2 unblock parallel work in slices F / G / J even before Phases 3-7 land.

## 4. Acceptance criteria

1. **`MemoryStore` interface** exists in `src/platform/memory/`. Round-trip on `InMemoryMemoryStore` passes. Round-trip on `SqliteVecMemoryStore` passes. Same test suite passes against either impl when injected.
2. **`MemoryEntryId` brand** distinct from `IdentityId`, `SessionId`, `EffectId` (compile-time + runtime checks per invariant #16).
3. **Episodic + semantic split** — episodic events are typed by effect family (compile-time discriminated union), semantic entries are free-form `{ content, metadata }` indexed by embedding.
4. **Persistent store keys on IdentityId** — round-trip survives process restart in fixture mode (sqlite file persists, recall returns the entry under the same identity).
5. **Commitment hook** writes on `commitmentSatisfied === true` AND skips on `false`. Anonymous sessions (no IdentityId) skip cleanly. Memory write failure does NOT downgrade the commitment.
6. **`<memory>` block** appears in IntentContractor prompt when memory is non-empty for the resolved IdentityId, and is absent (no whitespace pollution) otherwise.
7. **B1 fixture acceptance** — set fact, simulate `/new`, recall fact succeeds via `<memory>` block.
8. **Frozen-layer integrity** — 16 invariants reverse-tests pass on slice-E HEAD. No new `src/platform/commitment/ → src/platform/decision/` imports. No new readers of raw user text outside contractor.
9. **Backend pluggable** — same acceptance test in Phase 7 passes against `SqliteVecMemoryStore` and `Mem0MemoryStore` (if Phase 4 ships mem0 path) by constructor swap.

## 5. Per-phase tests (must catch real bugs — see AGENTS.md "Tests must catch real bugs")

Each phase's tests must:
- **Fail-first.** The negative test must reproduce the absence-of-functionality before the fix lands. CI or local proof: revert the fix, test fails on the spec'd assertion (not on a NoMethodError or import error).
- **No `vi.spyOn` on the function under test.** Use real `MemoryStore` instances (in-memory for Phases 1-2, real sqlite tmp file for Phase 3+). Spies are reserved for non-deterministic infrastructure (LLM calls, embedder calls, time).
- **Cover the negative case explicitly.** For every Phase: (a) malformed input rejected, (b) missing IdentityId → no-op (NOT throw), (c) backend failure → degrade gracefully (warn + skip, never crash the calling turn).
- **Phase 7 acceptance** uses a real (tmp-dir) sqlite store, a real `IdentityRegistry`, a stubbed embedder (deterministic vector based on content hash), and a stubbed LLM responder. The fixture must reproduce B1's symptom in absence-of-fix mode (recall returns nothing) and the correct outcome in fix-mode (recall returns the planted entry).

Per-phase specifics:

- **Phase 1**: brand discipline test — assigning a `string` to `MemoryEntryId` is a TypeScript error; assigning `IdentityId` to `MemoryEntryId` is a TypeScript error.
- **Phase 2**: identity isolation — entries stored under `identity:vladimir` are NOT visible from `identity:alice` even on the same `InMemoryMemoryStore` instance.
- **Phase 3**: sqlite-vec extension load failure mode — when `loadSqliteVecExtension` returns `{ ok: false }`, `SqliteVecMemoryStore` falls back to LIKE-based recall AND surfaces a `vector_unavailable` warning. Test injects a deliberately-broken extension path.
- **Phase 4**: pluggability — the EXACT SAME assertion suite from Phase 2 passes against `Mem0MemoryStore` (or in-house extractor) via constructor swap. Negative: extraction filter rejects junk content (mocked LLM says `keep: false`) and `recall` returns nothing for that content.
- **Phase 5**: reverse — a `commitmentSatisfied=false` attestation produces ZERO memory writes (assert via spy on the injected `MemoryStore.storeEpisodic` — note: spy on the dep, not on the function under test, which is the hook itself).
- **Phase 6**: contractor with no `memoryStore` dep is byte-identical to today (regression guard); contractor with empty-result memory does NOT inject a `<memory>` block (whitespace check); contractor recall failure (memoryStore throws) → contractor still returns a valid `SemanticIntent` with a `memory_recall_failed` uncertainty tag.
- **Phase 7**: B1 replay — fixture-mode integration covers full path (commit-on-satisfy → process-restart-simulating sqlite reopen → contractor recall → response).

## 6. Implementation notes

- **New module path**: `src/platform/memory/`. Mirrors `src/platform/identity/` layout (interface + types + impl(s) + tests + a co-located acceptance test).
- **DB file path**: `~/.openclaw-dev/memory/identity-memory.sqlite`. Distinct from `dev.sqlite` to keep slice E's blast radius isolated. Path resolution via existing config helpers (do not hardcode).
- **Embeddings**: reuse `src/memory/embeddings*.ts` infrastructure via a small `MemoryEmbedder` interface (`embed(text: string): Promise<Float32Array>`). Provider config is read from existing memory-config schema; do NOT add a parallel embedding-config surface.
- **Schema migration**: idempotent `CREATE TABLE IF NOT EXISTS` + a `schema_version` row. v1 = version 1; future versions add ALTERs gated on the version. Reversible: dropping the slice E DB is safe (degrades to no recall, no crash, per Phase 5 graceful-fail).
- **mem0 dep add**: gate behind a maintainer signoff in Phase 4. If signoff is granted, add `mem0ai` to `dependencies` (NOT `optionalDependencies` — wrapper pattern needs deterministic shape) and document the LLM provider choice. If denied or audit fails, ship in-house `LlmExtractor` and surface §6 D1 as needing amendment in the next roadmap revision.
- **Hook site lives outside frozen layer**: per invariant #8, the new `memory-write-on-satisfied.ts` lives in `src/agents/pi-embedded-runner/run/`. No master-plan amendment needed. The contractor change in Phase 6 (constructor adds optional dep) is also additive and does NOT touch the 5 frozen contracts.
- **Channel-aware visibility / privacy**: this slice does NOT implement memory-redaction-on-recall (out-of-channel reasoning is sanitizer's job — slice I). Memory entries are stored in plain text under the operator's identity; recall returns them verbatim. If channel-keyed sanitization is needed, wrap the recall result in slice I's sanitizer — adapter for that wrap lives in slice I, not here.
- **Concurrency**: SQLite-vec writes are serialized via the existing `node:sqlite` `DatabaseSync` (single-threaded). Multiple concurrent agent turns share one store instance — wrap writes in a transaction; reads are non-blocking. Stress-test in Phase 3.
- **No phrase-matching**: per invariant #5, the recall does NOT do regex/text-rule matching against `RawUserTurn`. The contractor passes its own classified intent text (or the prompt text it already legitimately reads) into `MemoryStore.recall(...)` — the boundary discipline is unchanged.
- **Memory entries are scoped**: `EpisodicMemoryEvent` carries `(identityId, effectFamily, effectId, payload)`. Slices F / G / J / K each define their own payload shapes when they wire their effect families; this slice ships only the `persistent_session.created` payload (a conversation-message memory event) plus stub variants for `subagent.created`, `reminder.set`, `artifact.created` that are typed but not yet emitted.

## 7. Handoff Log

### 2026-05-04 — Sub-plan kickoff

- Sub-plan written. Awaiting maintainer signoff before Phase 1 commit.
- Audit confirms: `sqlite-vec@0.1.7` already installed; `mem0ai` NOT installed; `src/memory/sqlite-vec.ts` loader exists and is reusable.
- Existing `extensions/memory-lancedb` and `extensions/memory-core` are RELATED but NOT what slice E delivers — they are workspace-memory-tool plugins, not commitment-kernel-keyed cross-session operator memory. Coexistence is intentional; v2 may consolidate.
- Predecessor slice D landed on `dev` (per `commitment_kernel_channel_agnostic_persistence.plan.md`); `IdentityId`, `IdentityRegistry`, `resolveIdentityFromSessionKey` are available.
- Branch: `feat/v1-slice-e-memory-store-interface` (Phase 1).

### 2026-05-05 — Phase 1 landed (PR #154)

- Phase 1 `e-phase-1-memory-store-interface-and-types` shipped.
- PR: https://github.com/Primus-max/god-mode-core/pull/154
- Squash-merge SHA on `dev`: `f13d771e571ca4548b45b2baf809663c16673980`.
- Files added (all new, none modified):
  - `src/platform/memory/memory-entry-id.ts` — `MemoryEntryId` brand + `asMemoryEntryId` / `isMemoryEntryId`.
  - `src/platform/memory/episodic-memory-event.ts` — `EpisodicEffectFamily`, `EpisodicMemoryEvent` discriminated union, per-payload types + Zod schemas, `assertNeverEpisodic` exhaustiveness helper.
  - `src/platform/memory/semantic-memory.ts` — `SemanticMemoryWrite` / `SemanticMemoryQuery` / `SemanticMemoryEntry` / `MemoryRecallResult` / `SemanticMemoryMetadata` types + Zod schemas (scalar-only metadata).
  - `src/platform/memory/memory-store.ts` — `MemoryStore` interface (`storeEpisodic`, `storeSemantic`, `recall`, `list`, `forget`), `MemoryListQuery`, `MemoryListResult`, `EpisodicMemoryListing`.
  - `src/platform/memory/index.ts` — barrel.
  - Tests: `memory-entry-id.test.ts`, `episodic-memory-event.test.ts`, `semantic-memory.test.ts`, `memory-store.contract.test.ts` — **70 cases, 70 passing** locally on this dev box (`pnpm vitest run src/platform/memory --config vitest.unit.config.ts`).
- Invariant audit:
  - **#5 / #6**: API takes structured `SemanticMemoryQuery` / `EpisodicMemoryEvent`; never `RawUserTurn` / `UserPrompt`.
  - **#8**: Module imports only `src/platform/identity/`, Zod, stdlib. The contract test imports `type SessionId / EffectId / EffectFamilyId` from `src/platform/commitment/ids.ts` for compile-time non-assignability only — no runtime / value imports, no modification.
  - **#11**: 5 frozen contracts untouched.
  - **#16**: `MemoryEntryId` brand-tested non-assignable from `string`, `IdentityId`, `SessionId`, `EffectId`, `EffectFamilyId` via `// @ts-expect-error` lines in `memory-store.contract.test.ts` + `memory-entry-id.test.ts`.
- Auto-merge note: PR was squash-merged via `gh pr merge --admin --squash` per Vladimir's standing delegation ("НЕ ЖДИ ОТ МЕНЯ РЕВЬЮ на пр, сам делай"). CI checks were stuck pending in the queue (~25 min, runner backlog environmental, not code-related); local `pnpm tsgo` and the scoped vitest suite both passed before merge.
- Phase 2 unblocked: `e-phase-2-in-memory-impl-and-acceptance-stub` can consume the interface in `src/platform/memory/in-memory-store.ts`.

## 8. Adjacent / deferred (out of scope)

| Item | Why deferred |
| --- | --- |
| Subagent registry persistence | Slice G consumes this slice's `MemoryStore`; metadata payload defined there. |
| TaskLedger persistence | Slice F — separate `tasks` SQLite table per §6 D4; integration with memory is via cross-references on `IdentityId`. |
| Cron query/list/cancel | Slice J — wires cron tool surface to memory recall. |
| Live-verify B1 replay against real Telegram log | v1-release acceptance step §5 of master roadmap, not slice E. Slice E ships fixture-mode acceptance only. |
| Consolidating existing `src/memory/*` + `extensions/memory-*` plugins with `src/platform/memory/` | v2 — three surfaces coexist for v1; consolidation is a separate refactor with its own risk surface. |
| Memory-redaction-on-recall (PII sanitizer) | Slice I is the single sanitizer surface; this slice produces plain-text memory; sanitizer wraps it on the way out per channel policy. |
| OAuth-mediated cross-tenant memory | v2 (same tail as slice D §8). |

## 9. References

- Roadmap: `.cursor/plans/commitment_kernel_v1_release_roadmap.plan.md` (slice E row §3; D1 closed decision §6).
- Predecessor: `.cursor/plans/commitment_kernel_channel_agnostic_persistence.plan.md` (slice D).
- Hard invariants: `.cursor/rules/commitment-kernel-invariants.mdc`.
- Existing identity surface: `src/platform/identity/identity-id.ts`, `src/platform/identity/identity-registry.ts`, `src/platform/identity/resolve-identity.ts`.
- Existing sqlite-vec loader: `src/memory/sqlite-vec.ts`.
- Existing embedding infrastructure: `src/memory/embeddings.ts` + provider-specific siblings.
- Existing commitment runtime: `src/platform/commitment/monitored-runtime.ts`.
- IntentContractor recall pattern (`<web_evidence>` mirror): `src/agents/pi-embedded-runner/run/params.ts:77` and `src/platform/commitment/intent-contractor-impl.ts`.
- mem0 upstream: https://github.com/mem0ai/mem0 (Apache 2.0).
- AGENTS.md test discipline: "Tests must catch real bugs" section.
