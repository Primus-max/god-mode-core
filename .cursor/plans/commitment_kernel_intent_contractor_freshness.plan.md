---
name: IntentContractor freshness/recency weighting
slice: intent-contractor-freshness
status: completed
signoff: GRANTED via blanket authorization 2026-05-05
overview: "IntentContractor today injects every recalled `<memory>` entry and every `<active_tasks>` row equally — high-traffic operators with 100+ semantic memories see stale low-relevance entries dominate the prompt's effective attention. Architecture: (a) NEW pure decay scoring helper `scoreByRecency(items, clockNow, decayHalfLifeMs)` returning `RecencyScored<T>`. (b) NEW optional dep `freshnessConfig?: FreshnessConfig` + `now?: () => number` clock-seam on `createIntentContractor` (additive constructor extension — slice E P6 / F P6 / Cutover-3 P6 / Slice K P5 precedent). (c) `<memory>` recall results sorted by `score * recencyDecay`; `<active_tasks>` rows sorted by `updatedAt`-then-`createdAt`. (d) NEW closed-shape `<freshness_hints>` block carrying resolved decay window + half-life so LLM observes same temporal frame. Pure additive; 16 invariants preserved; no regex on raw text (#5); decay clock-injected. Non-goals: changing MemoryStore.recall interface, adding new effect families, changing LLM-driven temporal-expression resolution (Slice K stays unchanged)."
todos:
  - id: freshness-phase-1-audit
    content: "Phase 1 — Audit (read-only). Output `extensions/AUDIT-intent-contractor-freshness.md`. Map: every block-builder in `intent-contractor-impl.ts` injecting entry list (`buildMemoryBlock` / `buildActiveTasksBlock` / `buildInboundAttachmentsBlock` — last is single-turn, OUT OF SCOPE; `buildRecallWindowBlock` / `buildEffectFamilyFilterBlock` are schema-hint stubs OUT OF SCOPE); confirm `SemanticMemoryEntry` carries timestamp via `metadata` scalar map (LLM-extractor writes `recordedAt:<ISO>`); `TaskRecord` carries `createdAt`+`updatedAt` ISO-8601; clock-injection seam: contractor today calls Date.now() ONLY in PiIntentContractorAdapter.classify — decay scoring needs independent clock via NEW optional `now?: () => number` seam (mirrors slice E logger discipline); operator-impact estimate via `[intent-contractor] memory.recall entries=N` log over 7-day window. NO source changes."
    status: completed
  - id: freshness-phase-2-types
    content: "Phase 2 — Types. NEW `FreshnessConfig = {decayHalfLifeMs?:number, defaultWindowMs?:number, missingTimestampPolicy?:'penalize_to_floor'|'treat_as_now'}` in `intent-contractor-impl.ts` or sibling `freshness.ts` (Phase 1 audit decides). Defaults: `decayHalfLifeMs=7d` (Slice K reminder window precedent), `defaultWindowMs=30d`, `missingTimestampPolicy='penalize_to_floor'` (legacy entries kept but down-weighted, encourages LLM-extractor backfill). NEW `RecencyScored<T> = {item, recencyDecay:number, ageMs:number|null}`. NEW `DECAY_FLOOR=0.05` constant (entries always retain non-zero weight — never silently dropped). NEW Zod `FreshnessConfigSchema.strict()`, all fields optional positive integers. Tests: schema round-trip; reject negative half-life / zero window; brand discipline; default-application correctness."
    status: completed
  - id: freshness-phase-3-scoring-helper
    content: "Phase 3 — Pure decay scoring helper. NEW `scoreByRecency<T>(params: {items: readonly T[], extractTimestamp: (item: T) => string|number|undefined, clockNowMs: number, config: Required<FreshnessConfig>}): readonly RecencyScored<T>[]`. Function pure: returns NEW array sorted descending by `recencyDecay`, NEVER mutates input. Decay formula: `recencyDecay = max(DECAY_FLOOR, 0.5 ^ (ageMs / decayHalfLifeMs))` exponential half-life; entry `decayHalfLifeMs` old → 0.5; two half-lives → 0.25; floored at DECAY_FLOOR. Missing/unparseable timestamp → policy-driven (`penalize_to_floor`: recencyDecay=DECAY_FLOOR ageMs=null; `treat_as_now`: recencyDecay=1.0 ageMs=0). ISO-8601 via `Date.parse()` with NaN guard. NEVER throws (#15). Tests fail-first (~8 cases): ordering newer-higher; half-life math `Date.now() - 7d` ≈ 0.5; floor at -365d; both missing-timestamp policies; NaN tolerance; clock-now=fixed determinism (no Date.now() inside helper); input non-mutation."
    status: completed
  - id: freshness-phase-4-block-wiring
    content: "Phase 4 — Wire scoring into `<memory>` + `<active_tasks>` block builders + emit `<freshness_hints>`. ADDITIVE frozen-layer touch (slice E P6 / F P6 / Cutover-3 P6 / Slice K P5 precedent — five additive structured blocks already coexist). (a) Extend `createIntentContractor(deps)` deps with optional `freshnessConfig?: FreshnessConfig` + optional `now?: () => number`; defaults applied when omitted. (b) `maybeRecallMemory` passes recall result through `scoreByRecency` keyed on `entry.metadata.recordedAt`; `combinedScore = entry.score * recencyDecay`; entries sorted descending by combinedScore before `buildMemoryBlock`. `<memory>` payload gains additive `recencyDecay: number` per entry. (c) `maybeRecallActiveTasks` extracts `task.updatedAt` (fallback `task.createdAt`) and reorders via `scoreByRecency` BEFORE `buildActiveTasksBlock`. (d) NEW `buildFreshnessHintsBlock(config, clockNowMs)` emits closed-shape `<freshness_hints>{clockNow, decayHalfLifeMs, defaultWindowMs}</freshness_hints>` (mirrors Slice K `<recall_window>`). Block placement: AFTER `<inbound_attachments>` BEFORE user prompt. (e) Block self-elides when no recall path fired. Tests fail-first (~7 cases): memory ordering changes when timestamps differ; recencyDecay tag injected; active_tasks nudged-yesterday > created-week-ago; freshness_hints fires only when recall fired; pre-Phase-4 byte-identical when freshnessConfig=undefined AND now=undefined AND no entries have timestamps; reverse — `freshnessConfig.decayHalfLifeMs=-1` rejected at decode."
    status: completed
  - id: freshness-phase-5-acceptance
    content: "Phase 5 — Acceptance + log-line evidence + live-verify. NEW `src/platform/commitment/__tests__/intent-contractor-freshness-acceptance.test.ts`: high-N cohort (16 mixed-age memory entries spanning 0d/1d/3d/7d/14d/30d/90d + legacy missing-recordedAt) asserts items ≤ 7d sort BEFORE items > 14d, missing-recordedAt sorts LAST at DECAY_FLOOR=0.05, active-tasks reorder by `updatedAt ?? createdAt`, `<freshness_hints>` block content, four log lines fire with expected fields, pinned-clock determinism, real `LlmExtractorMemoryStore` writes `recordedAt` end-to-end, frozen-layer sha256 byte-identical. Four `[intent-contractor]` log lines wired in `classify` (`freshness.applied` / `memory.block` / `active_tasks.block` / `freshness_hints.block`). Operator runbook `extensions/RUNBOOK-freshness-live-verify.md` for live-verify. Slice CLOSED pending Vladimir's live-verify run."
    status: completed
isProject: false
---

# IntentContractor freshness/recency weighting

## 0. Provenance

| Field | Value |
| --- | --- |
| Sub-plan of | `.cursor/plans/commitment_kernel_v1_master.plan.md` (§0.5/§8 deferred — «IntentContractor freshness/recency» open frontier) |
| Inherits | 16 hard invariants from `.cursor/rules/commitment-kernel-invariants.mdc` |
| Predecessors | Slice E P6 (`<memory>` block) CLOSED. Slice F P6 (`<active_tasks>` block) CLOSED. Cutover-3 P6 (`<inbound_attachments>`) CLOSED. Slice K P5 (`<recall_window>` + `<effect_family_filter>`) CLOSED. PolicyGate Full / Cutover-4 / NEW-A/B/C/D / Cron-Scheduler all closed. |
| Trigger | Master §0.5.6/§8/§16 deferred — operator-impact: high-traffic operators see 100+ recalled entries dominated by stale content because all blocks inject equally-weighted JSON arrays. |
| Out of scope | `MemoryStore` interface widening (use existing `recall` result shape only); changing LLM-driven temporal-expression resolution (Slice K P5 unchanged); cron-fired decay refresh (no background indexer); cross-identity decay (still per-identity); persistent-store schema changes (timestamps round-trip via `metadata` scalar map); new effect-family registration; new world-state slice; reply-side ordering (sanitizer/coalescer orthogonal). |
| Maintainer signoff | GRANTED via blanket authorization 2026-05-05 |

## 1. Hard invariants this slice keeps

- **#1**: `ExecutionCommitment` tool-free.
- **#2**: Structural selection only. Decay reads numeric/ISO-8601 fields, NEVER text.
- **#3**: Production success unchanged — freshness only reorders prompt; done-predicates untouched.
- **#4**: State-after observers untouched.
- **#5, #6**: NO new readers of raw user text. Decay extracts `metadata.recordedAt` + `task.updatedAt`/`createdAt` — structured fields only. Contractor remains sole sanctioned `RawUserTurn` reader.
- **#7**: ShadowBuilder unchanged.
- **#8**: New helper imports identity/memory types/Zod/stdlib only.
- **#9, #10**: Decay text-blind; never throws; clock-injected.
- **#11**: 5 frozen contracts BYTE-IDENTICAL. Constructor extension additive only (slice E/F/Cutover-3/Slice K precedent).
- **#12**: NO emergency phrase patches.
- **#13**: `terminalState` ⊥ `acceptanceReason` untouched.
- **#14**: ShadowBuildResult unchanged.
- **#15**: Decay failure / NaN / clock-skew → fail-soft (floored or capped, never throws). Live-verify mandatory at Phase 5.
- **#16**: `EffectFamilyId` ⊥ `EffectId` preserved. No new branded ids.

## 2. Audit findings (TO BE FILLED IN BY PHASE 1)

> Phase 1 produces `extensions/AUDIT-intent-contractor-freshness.md`. Sketches:

### 2.1. Block-builder inventory
- `buildMemoryBlock(entries)` — slice E P6 — sort point: NONE (relies on `MemoryStore.recall` similarity-only)
- `buildActiveTasksBlock(tasks)` — slice F P6 — sort: `createdAt DESC, id DESC` — does NOT consider `updatedAt`
- `buildInboundAttachmentsBlock` — Cutover-3 P6 — single-turn, OUT OF SCOPE
- `buildRecallWindowBlock` / `buildEffectFamilyFilterBlock` — Slice K P5 — schema-hint stubs, OUT OF SCOPE

### 2.2. Timestamp surface
- `SemanticMemoryEntry.metadata` is `{[k]: string|number|boolean|null}` scalar map; LLM-extractor writes `recordedAt:<ISO>` (Phase 1 confirms exact key)
- `TaskRecord.createdAt` + `TaskRecord.updatedAt` ISO-8601 strings (slice F P2 contract)

### 2.3. Clock seam
- `intent-contractor-impl.ts` reads `Date.now()` ONLY in `PiIntentContractorAdapter.classify`. Decay needs independent clock via NEW optional `now?: () => number` seam.

### 2.4. Clock-skew reality
3 vectors: gateway / extractor / store hosts. Acceptance #5 caps `recencyDecay <= 1.0`.

### 2.5. Privacy / identity isolation
`MemoryStore.recall` keyed on `identityId` at storage layer; freshness operates per-identity; isolation cannot regress.

## 3. Hypothesis

Five forces:
1. Slice E/F/Cutover-3/Slice K established additive-block precedent — five blocks coexist; freshness adds sixth.
2. Operator memory cohorts grow without bound — without recency weighting LLM attention scales as 1/N.
3. Contractor is sole sanctioned raw-text reader (#6) and sole place LLM resolves temporal expressions (Slice K P5) — placing recency weighting INSIDE contractor unifies temporal-reasoning surface.
4. `MemoryStore.recall` similarity score and recency decay are orthogonal signals; product `combinedScore` preserves relevance while down-weighting stale duplicates.
5. Decay function purity + clock-injection + fail-soft tolerance lets slice land additively without crossing frozen layer.

## 4. Acceptance criteria

1. NEW `FreshnessConfig` type registered; defaults applied on omit.
2. `scoreByRecency<T>(...)` helper pure (no clock side-effects); injected clock honoured by tests.
3. `<memory>` block reordered by `score * recencyDecay`; `<active_tasks>` reordered by `updatedAt`-then-`createdAt` newest-first.
4. NEW `<freshness_hints>` block emitted ONLY when at least one recall path fires; carries `clockNow` + `decayHalfLifeMs` + `defaultWindowMs`.
5. Pre-Phase-4 byte-identical output when `freshnessConfig=undefined` AND `now=undefined` AND no entry carries timestamp metadata (regression guard).
6. Frozen-layer integrity: 16 invariants preserved; 5 frozen contracts BYTE-IDENTICAL; touches strictly additive on `createIntentContractor` deps.
7. Identity isolation preserved — freshness NEVER promotes another identity's entry.
8. Decay function never throws (#15) — NaN/future/negative-age inputs degrade gracefully (floor/cap).
9. NO new raw-user-text readers (#5/#6); decay reads numeric/ISO-8601 only.
10. `MemoryStore` interface UNCHANGED (`git diff` empty). `TaskLedger` UNCHANGED.
11. Telegram live-verify: 3 live operator turns with high-N memory cohort succeed; recency log lines emitted.

## 5. Per-phase tests + log-line evidence

- Fail-first per phase. No `vi.spyOn` on function under test.
- Phase 1: audit md.
- Phase 2: schema round-trip + brand discipline + reject negative/zero.
- Phase 3: 8 helper cases.
- Phase 4: 7 wiring cases (memory reorder, recencyDecay payload, active_tasks updatedAt-driven, hints block fire/elide, two byte-identical regression, schema decode reject).
- Phase 5: 6 acceptance + live Telegram verify.

Log-line evidence:
- `[intent-contractor] freshness.applied entries=<N> halfLifeMs=<N> windowMs=<N>`
- `[intent-contractor] memory.block injected entries=<N> recencyDecayMin=<f> recencyDecayMax=<f>`
- `[intent-contractor] active_tasks.block injected tasks=<N> oldestAgeMs=<N>`
- `[intent-contractor] freshness_hints.block injected clockNow=<ISO>`

## 6. Implementation notes

- Pure additive on `createIntentContractor` deps (slice E/F/Cutover-3/Slice K precedent — five additive constructor extensions already coexist).
- `<freshness_hints>` block placement: AFTER `<inbound_attachments>` BEFORE raw user prompt.
- Decay helper purity load-bearing: clock injected, no `Date.now()` inside.
- `<memory>` payload gains additive `recencyDecay: number` per entry (slice E P6 payload tolerates additive — downstream is LLM, not strict schema).
- `<active_tasks>` payload shape unchanged (only array order changes).
- `combinedScore = entry.score * recencyDecay` — relevance signal dominant, decay multiplier.
- Slice K `<recall_window>` block stays unchanged — different tag, different consumer.
- Defense-in-depth: `recencyDecay` capped at 1.0; floored at DECAY_FLOOR=0.05.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Decay tuning inappropriate for operator cohort | Defaults config-driven; ops override via `freshnessConfig` per-deployment |
| Clock-skew across hosts | Cap `recencyDecay <= 1.0`; floor at DECAY_FLOOR |
| Missing timestamp metadata on legacy entries | `missingTimestampPolicy='penalize_to_floor'` default |
| Freshness reorder masks relevance-critical old entry | `recencyDecay` is MULTIPLIER on similarity, not replacement |
| Frozen-layer drift via additive deps | Slice E/F/Cutover-3/Slice K precedent; byte-identical regression test |
| Adversarial timestamp shape | Helper NaN-tolerant; falls back to policy |
| `<memory>` payload field addition breaks downstream parser | Downstream is LLM (loose-schema); no strict consumer |
| Live-verify regression of L2392-class meta-leak | Slice I sanitizer wraps OUTBOUND, orthogonal to contractor INBOUND |

## 8. Maintainer signoff

GRANTED via blanket authorization 2026-05-05.

## 9. Handoff Log

| Date | Phase | PR | Status | Notes |
| --- | --- | --- | --- | --- |
| 2026-05-07 | Phase 1 — Audit | #267 | merged | `extensions/AUDIT-intent-contractor-freshness.md` shipped; key finding: `recordedAt` not yet written by extractor today — coupled write fix scheduled for Phase 4. |
| 2026-05-07 | Phase 2 — Types | #268 | merged | `FreshnessConfig` + `RecencyScored<T>` + `DECAY_FLOOR` + `FreshnessConfigSchema` + `resolveFreshnessConfig` landed in `src/platform/freshness/freshness-config.ts`. |
| 2026-05-07 | Phase 3 — Pure scoring helper | #269 | merged | `scoreByRecency<T>(...)` pure helper in `src/platform/freshness/score-by-recency.ts`. Clock-injected, NaN-tolerant, capped at 1.0 / floored at `DECAY_FLOOR`. |
| 2026-05-07 | Phase 4 — Block-builder wiring | #270 | merged | `intent-contractor-impl.ts` wires `<memory>` reorder via `combinedScore = score * recencyDecay`, `active-tasks-block.ts` reorders via `updatedAt ?? createdAt`, NEW `<freshness_hints>` block, additive `now?` + `freshnessConfig?` deps on `createIntentContractor`, `LlmExtractorMemoryStore.storeSemantic` stamps `recordedAt` epoch ms. 1309/1309 regression green. |
| 2026-05-07 | Phase 5 — Acceptance + log emissions + runbook | this PR | open | Four `[intent-contractor]` log lines added (`freshness.applied` / `memory.block` / `active_tasks.block` / `freshness_hints.block`), high-N acceptance test (`intent-contractor-freshness-acceptance.test.ts`) covering items ≤ 7d before > 14d + missing-`recordedAt` floor + active-tasks reorder + `<freshness_hints>` content + log-line shape + pinned-clock determinism + real `LlmExtractorMemoryStore` end-to-end + frozen-layer sha256, runbook `extensions/RUNBOOK-freshness-live-verify.md` for operator live-verify. Slice CLOSED pending Vladimir's live-verify run. |

## 10. Adjacent / deferred

| Item | Why deferred |
|---|---|
| Cron-fired memory GC / TTL eviction | Separate slice; freshness here is read-side only |
| Adaptive half-life tuning per identity | v2 — needs telemetry feedback loop |
| Cross-identity recency comparison | Out-of-scope (per-identity isolation) |
| Persistent-store schema migration to canonical timestamp column | Out-of-scope (metadata scalar map suffices for v1) |
| Reply-side recency weighting | Orthogonal; coalescer is NEW-C surface |
| Slice K reminder window auto-derived from FreshnessConfig.defaultWindowMs | v2 ergonomics improvement |
| Subagent-registry recall freshness | Slice G STUB never lit |
| Telemetry dashboard for freshness.applied | Observability roadmap |

## 11. References

- Master plan §0.5/§8/§16
- Hard invariants
- Slice E sub-plan (`<memory>` block + MemoryStore precedent)
- Slice F sub-plan (`<active_tasks>` block + TaskLedger precedent)
- Cutover-3 sub-plan (`<inbound_attachments>` block precedent)
- Slice K sub-plan (`<recall_window>` + `<effect_family_filter>` block precedent)
- `src/platform/commitment/intent-contractor-impl.ts`
- `src/platform/memory/semantic-memory.ts`
- `src/platform/task/task-record.ts`
- `src/platform/task/active-tasks-block.ts`
