# Slice E Gateway Wiring Bridge — Audit (READ-ONLY)

Branch: `feat/v1-slice-e-gateway-wiring-bridge`
Base SHA: `dev` HEAD `961fd461d1` (slice E COMPLETE — PR #170 + handoff PR #171).

This document VERIFIES the wiring sites where `RunTurnDecisionInput.{memoryStore, identityId, memoryLogger, onAttestation}` must be populated in production so the Phase-7 fixture's behaviour replays at runtime.

No code under `src/` was modified during the audit. Findings are line-anchored
to current `dev` HEAD.

Hard invariants kept by this slice: #5 (no text matching on `UserPrompt`), #6
(`IntentContractor` sole reader of raw user text — wiring threads structured
`IdentityId` + `MemoryStore`, never raw text), #8 (`src/platform/commitment/`
unchanged — wiring is decision-side and gateway-side only), #11 (5 frozen
contracts unchanged), #15 (defense-in-depth — bootstrap downgrades to
`InMemoryMemoryStore` when SqliteVecMemoryStore.open throws), #16 (`IdentityId`
is the only cross-session key — anonymous sessions skip recall + write).

---

## 1. Boot path identification

### 1.1. Gateway boot site

`src/gateway/server-startup.ts:80` exports `startGatewaySidecars(...)` — the
single gateway-server boot path that runs once per gateway process. It receives
`cfg: ReturnType<typeof loadConfig>` and orchestrates: hooks loader, channel
launch, plugin services, ACP reconcile, and at line 229 the existing memory
backend (`startGatewayMemoryBackend` for `qmd` memory tools).

This is the natural insertion point for the slice E memory-store singleton
construction. The bootstrap helper will be invoked once from
`startGatewaySidecars` to construct `{ memoryStore, identityRegistry }` and
register them on the per-process global singleton. Lazy-on-first-use is also
acceptable (the helper supports both shapes); the canonical shape mirrors
`src/memory/manager.ts` which uses `resolveGlobalSingleton(...)` from
`src/shared/global-singleton.ts:1` to gate `INDEX_CACHE`.

### 1.2. Per-turn message arrival → `runTurnDecision` chain

A Telegram (or any channel) message lands in the agent runner via two distinct
production paths, both terminating at `runTurnDecision`:

1. **Auto-reply path** (`src/auto-reply/reply/...`):
   - `agent-runner-execution.ts:146` calls
     `resolveRoutingSnapshotForTemplateRun(...)` from
     `src/auto-reply/reply/agent-runner-utils.ts:278`, which invokes
     `buildClassifiedExecutionDecisionInput(...)` at line 296.
   - The auto-reply path has access to `params.run.sessionKey` (line 181 of
     `agent-runner-utils.ts`) — the full session-key is known when this path is
     invoked.

2. **Direct CLI / agent-command path** (`src/agents/agent-command.ts`):
   - `prepareAgentCommandExecution` at line 1181 calls
     `buildClassifiedPlatformPlannerInput(...)` at line 1280, which delegates
     to `buildClassifiedExecutionDecisionInput(...)` at line 704.
   - `sessionKey` is in scope at the call site (line 1280) — it is destructured
     from `sessionResolution` at line 1272.

Both callers thus already have `sessionKey` available; the wiring follow-up is
to thread it (or the resolved `IdentityId`) into
`buildClassifiedExecutionDecisionInput`.

### 1.3. `buildClassifiedExecutionDecisionInput` → `runTurnDecision`

`src/platform/decision/input.ts:433` defines
`buildClassifiedExecutionDecisionInput(params)`. It already constructs every
other ledger / clarify / identity context block, then at line 548 dispatches to
`runTurnDecision({...})` passing `monitoredRuntime`, `expectedDeltaResolver`,
and `cfg`. This is the SOLE production caller of `runTurnDecision` for
external-user prompts (the second call at line 587 is the workspace-context
re-classify branch — same `runTurnDecision`).

`runTurnDecision` itself (`src/platform/decision/run-turn-decision.ts:226`)
already accepts `memoryStore?`, `identityId?`, `memoryLogger?`, and
`onAttestation?` per Phase 7 (PR #170 — see lines 112–137). The fields are
threaded into `createIntentContractor(...)` inside `runShadowBranch` (lines
339–342) and the `onAttestation` callback is invoked from the cutover-gate
result at lines 294–304.

**Production gap (the bug this slice fixes)**:
`buildClassifiedExecutionDecisionInput` does NOT currently pass any of those
four fields to `runTurnDecision`. So at runtime the contractor's recall hook
stays inert (no `<memory>` block) and `onAttestation` is never fired (no
episodic write on `commitmentSatisfied`).

## 2. Existing components — no new abstractions required

### 2.1. `IdentityRegistry` factory

`src/platform/identity/load-identities-from-config.ts:51`
`loadIdentityRegistryFromConfig(cfg.identities)` returns a
`StaticIdentityRegistry`. The schema field is wired —
`src/config/zod-schema.ts:279` declares `identities: IdentitiesSchema.optional()`.

No production caller exists today (grep confirmed: only test file +
acceptance fixture at `cross-channel-identity.acceptance.test.ts`). The
bootstrap helper introduced by this slice is the first production caller.

### 2.2. `SqliteVecMemoryStore`

`src/platform/memory/sqlite-vec-store.ts:241`
`SqliteVecMemoryStore.open(opts)` (async factory) — opens / migrates the DB,
loads the sqlite-vec extension, and returns a `MemoryStore`-conforming
instance. Default DB path comes from
`defaultSqliteVecMemoryStorePath()` at line 44 (`<resolveConfigDir>/memory/
identity-memory.sqlite`). Defense-in-depth: the constructor itself never
throws on extension load failure — it falls back to LIKE-based recall. It
will, however, throw if `requireNodeSqlite()` cannot find `node:sqlite`. The
bootstrap helper catches that, logs once, and returns an
`InMemoryMemoryStore` instead (invariant #15).

### 2.3. `MemoryEmbedder` resolution

`src/memory/embeddings.ts:168` `createEmbeddingProvider(options)` returns
`{ provider: EmbeddingProvider | null, ... }`. The provider exposes
`embedQuery(text) → Promise<number[]>`. The bootstrap adapts it to the
slice-E `MemoryEmbedder` interface
(`embed(text) → Promise<Float32Array>`) via a thin lambda. Provider config
is pulled from `agents/memory-search.ts:378`
`resolveMemorySearchConfig(cfg, agentId)`; when `null` is returned (memory
disabled or no configuration), the bootstrap downgrades to
`InMemoryMemoryStore`.

The agentId for the embedder follows existing project convention — the
default agent (the first id from `listAgentIds(cfg)`) is used because the
v1 memory layer is a per-process operator surface, not per-agent. A
multi-agent embedder cache is v2's concern.

### 2.4. `resolveIdentityFromSessionKey`

`src/platform/identity/resolve-identity.ts:102`
`resolveIdentityFromSessionKey(sessionKey, registry)` returns
`IdentityId | undefined`. Already used by the Phase-7 acceptance fixture
(`b1-replay.acceptance.test.ts:485`) but NOT by any production code path.

Anonymous sessions (no mapping match, malformed key, wrapped scopes:
cron/subagent/acp) return `undefined` — invariant #16 is honoured by the
existing helper without any new logic.

### 2.5. Phase-5 hook: `recordMemoryOnCommitmentSatisfied`

`src/agents/pi-embedded-runner/run/memory-write-on-satisfied.ts:167` is the
single production hook that converts a `RuntimeAttestation` into an
episodic memory write. It already enforces every guard (commitment must be
satisfied, identityId must be resolved, store must be present, family must
be `persistent_session` for v1). The `onAttestation` callback this slice
wires into `RunTurnDecisionInput` invokes this hook directly.

## 3. Wiring plan

### 3.1. New bootstrap helper

`src/server/memory-store-bootstrap.ts` (NEW, ≤80 LOC):

- `getMemoryRuntime(cfg, deps?) → { memoryStore, identityRegistry }` —
  resolves once per process via `resolveGlobalSingleton`. `deps` exists for
  test injection of an embedder factory + an open-store factory.
- Memory-store path:
  - When `resolveMemorySearchConfig(cfg, defaultAgentId)` returns a config
    and `createEmbeddingProvider(...)` returns a non-null provider:
    `await SqliteVecMemoryStore.open({ dbPath:
    defaultSqliteVecMemoryStorePath(), embedder: <adapted>, vectorDims:
    <provider-dims>, logger })`.
  - On any throw (including missing node:sqlite, sqlite-vec extension
    missing on Windows, embedder construction failure, dimensionality
    mismatch): log warn once and downgrade to `InMemoryMemoryStore`
    (invariant #15).
  - When memory-config is absent / disabled (the auto-reply demo deploy
    runs without `memorySearch`): construct `InMemoryMemoryStore` directly
    so the chain stays callable end-to-end (in-memory recall replays
    same-process turns, which closes the demo path; persistence across
    process restarts is the next deploy step).
- Identity registry: `loadIdentityRegistryFromConfig(cfg.identities)` —
  always succeeds (returns an empty registry when config has no
  `identities` section).

### 3.2. `input.ts` populate the four optional fields

`src/platform/decision/input.ts:433` `buildClassifiedExecutionDecisionInput`
gains an optional `sessionKey?: string` param. Inside the function (just
before the `runTurnDecision({...})` call at line 548):

- Resolve `{ memoryStore, identityRegistry } = getMemoryRuntime(params.cfg)`.
- Resolve `identityId =
  resolveIdentityFromSessionKey(sessionKey, identityRegistry)` — may be
  `undefined` (anonymous; invariant #16).
- Build an `onAttestation` closure that, on
  `commitmentSatisfied===true`, invokes
  `recordMemoryOnCommitmentSatisfied(...)` with the
  `persistent_session.created` payload (mirrors the Phase-7 fixture
  shape; concrete payload is the prompt + sessionId).
- Pass all four fields into both `runTurnDecision({...})` calls (the main
  one at line 548 + the workspace-context re-classify at line 587).

Surface cap: ≤30 LOC at the input site (verified during impl).

### 3.3. Upstream callers thread `sessionKey`

- `src/agents/agent-command.ts:704`
  `buildClassifiedPlatformPlannerInput` — accept `sessionKey?: string`
  and forward to `buildClassifiedExecutionDecisionInput`.
- `src/agents/agent-command.ts:1280` call site — pass the in-scope
  `sessionKey` through.
- `src/auto-reply/reply/agent-runner-utils.ts:278`
  `resolveRoutingSnapshotForTemplateRun` — accept `sessionKey?: string`
  (or pass `params.run.sessionKey` directly from the existing run).
- `src/auto-reply/reply/agent-runner-execution.ts:146` call site — already
  has `params.followupRun.run.sessionKey` in scope.

LOC impact at boot site (server-startup): ≤1 LOC (a single eager
resolution call to warm the singleton; the lazy path also works).
Bootstrap helper module: ≤80 LOC. Input-site delta: ≤30 LOC.

## 4. Frozen-layer audit

- `src/platform/commitment/**` — UNTOUCHED. Contractor recall hook is
  Phase-6 (PR #168) and is invariant-#11 additive (constructor-only,
  already merged).
- 5 frozen contracts (`TaskContract`, `OutcomeContract`,
  `QualificationExecutionContract`, `ResolutionContract`,
  `RecipeRoutingHints`) — UNTOUCHED.
- `RuntimeAttestation` — UNTOUCHED. The `onAttestation` callback reads it
  via the structural `CommitmentSatisfiedAttestationLike` type already
  defined in `memory-write-on-satisfied.ts`.
- No new readers of raw `UserPrompt` / `RawUserTurn` are added — invariant
  #5 / #6 honoured. The wiring threads `IdentityId` (from sessionKey, not
  user text) and the structured `MemoryStore` interface only.

## 5. Risk surface

- Per-process singleton: if `cfg` reloads (gateway hot-reload), the
  registry / store would be stale. The bootstrap helper keys the
  singleton on `cfg` reference equality and rebuilds when the reference
  changes. Acceptable for v1; multi-tenant cfg-reload is a v2 concern.
- Embedder cost: `createEmbeddingProvider` may issue an outbound network
  call on startup (auto-mode probes). The bootstrap defers provider
  creation until first `recall` / `storeSemantic` if `enabled === false`.
- Concurrency: `SqliteVecMemoryStore` writes are serialized by sqlite +
  the `busy_timeout = 5000` PRAGMA already set. Multiple agent turns
  share one store instance.
- Anonymous session recall: invariant #16 — anonymous turns never recall
  and never write. The wiring trusts `resolveIdentityFromSessionKey` to
  return `undefined`; the contractor + Phase-5 hook both gate on
  `identityId !== undefined`.

## 6. Test strategy (covered in the fail-first commit)

- `getMemoryRuntime` returns a `SqliteVecMemoryStore` instance when
  memory-config is present AND the open-store factory does not throw.
- `getMemoryRuntime` returns an `InMemoryMemoryStore` instance when:
  - memory-config is absent (no `agents.defaults.memorySearch`); OR
  - memory-config is present but `createEmbeddingProvider` returns a
    null provider; OR
  - the SqliteVecMemoryStore factory throws (defensive downgrade).
- `getMemoryRuntime(cfg)` is idempotent within a process — same `cfg`
  reference returns the same instance.
- Identity registry built from `cfg.identities` resolves a known
  Telegram session-key to the configured `IdentityId` and returns
  `undefined` for an unmapped peer.

End of audit.
