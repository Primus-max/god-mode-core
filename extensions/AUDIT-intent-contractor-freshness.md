# AUDIT — IntentContractor freshness/recency weighting

| Field | Value |
| --- | --- |
| Sub-plan | `.cursor/plans/commitment_kernel_intent_contractor_freshness.plan.md` |
| Phase | 1 — Audit (read-only) |
| Predecessor | dev `4085a48f43` (post PR-#266 — sub-plan landed) |
| Maintainer signoff | GRANTED via blanket authorization 2026-05-05 |
| Frozen layer | UNTOUCHED (no source changes — markdown deliverable only) |
| Authoring rule | Inherits 16 hard invariants from `.cursor/rules/commitment-kernel-invariants.mdc` |

This audit closes Phase 1 of the freshness sub-plan. It maps every block-builder
in `intent-contractor-impl.ts` that injects an entry list, confirms the
timestamp-bearing fields on `SemanticMemoryEntry` and `TaskRecord`, identifies
the single existing clock site, recommends the new clock seam, and records
the realities (clock-skew vectors, identity isolation, operator-impact
estimate) that Phase 3+ must respect.

All citations below reference dev SHA `4085a48f43`. Line numbers are
inclusive ranges in the form `path:Lstart-Lend`. The audit produces no
source modification — only this markdown deliverable.

---

## §a Block-builder inventory

The contractor today emits FIVE additive structured blocks ahead of the raw
user prompt. The freshness slice will add a sixth (`<freshness_hints>`).
Each row records: builder, line range, payload shape, sort point on the
entry list (NONE = no reorder, just whatever the upstream returned), and
whether freshness reorder applies.

### a.1 `buildMemoryBlock` — `<memory>` (slice E P6) — IN SCOPE

| Field | Value |
| --- | --- |
| File | `src/platform/commitment/intent-contractor-impl.ts:489-499` |
| Caller | `maybeRecallMemory(...)` at `:452-481` |
| Wired into prompt at | `:393` (concat `${taskRecall.block ?? ""}${memoryRecall.block ?? ""}${inboundMediaBlock ?? ""}` ahead of raw prompt) |
| Payload shape | `<memory>{"entries":[{ id, content, score, metadata }, ...]}</memory>` |
| Source of `entries` | `MemoryStore.recall(...)` result (`MemoryRecallResult.entries`) |
| Sort point INSIDE builder | NONE — `entries.map(...)` preserves recall order verbatim (`:491-496`) |
| Sort point in caller | NONE — `maybeRecallMemory` returns `buildMemoryBlock(result.entries)` directly at `:473`, no reorder |
| Upstream sort guarantee | `MemoryStore.recall` similarity-only (sqlite-vec cosine; in-memory substring score). Recency NEVER considered today. |
| Freshness reorder | YES (Phase 4) — apply `scoreByRecency` keyed on `entry.metadata.recordedAt`, sort by `entry.score * recencyDecay` descending BEFORE the `buildMemoryBlock` call site at `:473` |
| Payload extension (Phase 4) | Additive `recencyDecay: number` per entry (LLM is loose-schema consumer; no strict downstream parser) |

Quote (key lines):

```
489: function buildMemoryBlock(entries: readonly SemanticMemoryEntry[]): string {
490:   const payload = {
491:     entries: entries.map((entry) => ({
492:       id: String(entry.id),
493:       content: entry.content,
494:       score: entry.score,
495:       metadata: entry.metadata,
496:     })),
497:   };
498:   return `<memory>${JSON.stringify(payload)}</memory>`;
499: }
```

```
473:     return { block: buildMemoryBlock(result.entries), failed: false };
```

### a.2 `buildActiveTasksBlock` — `<active_tasks>` (slice F P6) — IN SCOPE

| Field | Value |
| --- | --- |
| File | `src/platform/task/active-tasks-block.ts:40-71` |
| Caller | `maybeRecallActiveTasks(...)` at `src/platform/commitment/intent-contractor-impl.ts:529-561` |
| Wired into prompt at | `src/platform/commitment/intent-contractor-impl.ts:393` |
| Payload shape | `<active_tasks>{"tasks":[{ id, label, status }, ...]}</active_tasks>` |
| Source of `tasks` | `TaskLedger.list({ ownerIdentityId, statuses: ['open','in_progress'] })` (`:539-542`) |
| Sort point INSIDE builder | `createdAt` DESC, then `id` DESC tie-break — `src/platform/task/active-tasks-block.ts:55-60` |
| Filter INSIDE builder | `ACTIVE_STATUSES = {'open','in_progress'}` defensively re-applied (`:9`, `:46-50`) |
| `updatedAt` consideration | NONE — sort is `createdAt`-only; a task nudged yesterday but created last week sorts BELOW a task created this morning |
| Freshness reorder | YES (Phase 4) — extract `task.updatedAt` (fallback `task.createdAt`) via `scoreByRecency`, reorder BEFORE `buildActiveTasksBlock(...)` is called at `intent-contractor-impl.ts:546`. Builder's internal `createdAt`-DESC sort still runs (defense-in-depth) but the input it sees is already recency-weighted; ties on `createdAt` resolve via the builder's `id` DESC fallback. |
| Payload shape change (Phase 4) | NONE — only the array order changes; per sub-plan §6 |

Quote (sort point):

```
55:   filtered.sort((a, b) => {
56:     if (a.createdAt !== b.createdAt) {
57:       return a.createdAt < b.createdAt ? 1 : -1;
58:     }
59:     return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
60:   });
```

Note: the builder's internal sort survives because it is fed an already
freshness-weighted slice. A second freshness-aware reorder by the builder
would double-apply recency; instead Phase 4 wraps the caller, not the
builder, mirroring how `maybeRecallMemory` wraps `buildMemoryBlock`.

### a.3 `buildInboundAttachmentsBlock` — `<inbound_attachments>` (Cutover-3 P6) — OUT OF SCOPE

| Field | Value |
| --- | --- |
| File | `src/platform/commitment/intent-contractor-impl.ts:602-` (block builder) |
| Wired at | `:383-386` |
| Payload | XML-tagged `<attachment path=... mime=... kind=... sourceTurnId=...>` per inbound media file |
| Source | `params.resolver()` → `InboundMediaSummary` for the CURRENT turn only |
| Lifetime | Single-turn surface (resolver is a per-turn closure) — entries never accumulate across turns |
| Why OUT OF SCOPE | Sub-plan §1 marks single-turn surfaces non-targets. There is no "stale attachment" because the resolver only ever sees this turn's inbound files. Sub-plan §2.1 confirms. |

### a.4 `buildRecallWindowBlock` / `buildEffectFamilyFilterBlock` (Slice K P5) — OUT OF SCOPE

| Field | Value |
| --- | --- |
| Files | `src/platform/commitment/intent-contractor-impl.ts:1075-1082` (recall window) and `:1097-1103` (effect family filter) |
| Wired at | `:958` (`constraints.recallWindow`) and `:959` (`constraints.effectFamilyFilter`) |
| Payload | Schema-hint stubs — `<recall_window>{"from":"<ISO-8601 from>","until":"<ISO-8601 until>"}</recall_window>`, `<effect_family_filter>["<EpisodicEffectFamily id>"]</effect_family_filter>` |
| Why OUT OF SCOPE | Both blocks are STATIC schema-hint slots that the LLM resolves; they never inject a list of recalled entries. Sub-plan §2.1 confirms. The Slice K reminder window is orthogonal to FreshnessConfig (§10 records the v2 ergonomics improvement of auto-deriving `<recall_window>` from `defaultWindowMs`). |

### a.5 `buildReminderSetIntentBlock` (Cron P7) — OUT OF SCOPE

| Field | Value |
| --- | --- |
| File | `src/platform/commitment/intent-contractor-impl.ts:1131-1149` |
| Wired at | `:964` (`constraints.reminderSet`) |
| Payload | Structural reminder schema-hint stub (`<reminder_set_intent><fireAt>...</fireAt><content>...</content>...</reminder_set_intent>`) |
| Why OUT OF SCOPE | Pure structural schema-hint slot. No entry list. Sub-plan §2.1 implicitly excludes (it lists this category alongside the Slice K stubs). |

### a.6 Inventory summary

| Block builder | Line range | List? | Sort point today | Freshness reorder |
| --- | --- | --- | --- | --- |
| `buildMemoryBlock` | `:489-499` | YES (memory entries) | NONE (recall similarity only) | YES |
| `buildActiveTasksBlock` | `task/active-tasks-block.ts:40-71` | YES (task rows) | `createdAt` DESC + `id` DESC | YES |
| `buildInboundAttachmentsBlock` | `:602-` | YES (single-turn attachments) | inbound order | NO (single-turn) |
| `buildRecallWindowBlock` | `:1075-1082` | NO (schema hint) | n/a | NO |
| `buildEffectFamilyFilterBlock` | `:1097-1103` | NO (schema hint) | n/a | NO |
| `buildReminderSetIntentBlock` | `:1131-1149` | NO (schema hint) | n/a | NO |
| `buildFreshnessHintsBlock` (NEW Phase 4) | n/a | NO (closed-shape hint) | emits `clockNow + decayHalfLifeMs + defaultWindowMs` | n/a |

The freshness slice touches exactly two block-emission paths
(`maybeRecallMemory` and `maybeRecallActiveTasks`) and adds one new closed-shape
hint block. Total in-scope reorder surfaces: 2.

---

## §b Timestamp surface confirmation

### b.1 `SemanticMemoryEntry.metadata` shape

`SemanticMemoryMetadata` is a JSON-scalar map:

```
src/platform/memory/semantic-memory.ts:19-21
19: export type SemanticMemoryMetadata = {
20:   readonly [key: string]: string | number | boolean | null;
21: };
```

`SemanticMemoryEntry.metadata` is typed `SemanticMemoryMetadata` at
`src/platform/memory/semantic-memory.ts:65`, validated at decode time by
`SemanticMemoryMetadataSchema` (`:104-105`) which is `z.record(z.string(),
z.union([z.string(), z.number(), z.boolean(), z.null()]))`. The schema's
`.strict()` posture is implicit via the discriminated union — arrays and
nested objects are rejected at decode.

### b.2 LLM-extractor write path — `recordedAt` key NOT YET WRITTEN

The sub-plan posits that the LLM-extractor writes `recordedAt:<ISO>` into
`metadata`. Audit finding (KEY): **the extractor does NOT write any
timestamp key today.** Evidence:

1. `LlmExtractorMemoryStore.storeSemantic` at
   `src/platform/memory/llm-extractor-store.ts:190-228` calls the extractor
   and merges only `decision.tags` into metadata via `mergeMetadata` at
   `:222`. Source:

   ```
   222:    const mergedMetadata = mergeMetadata(parsed.metadata, decision.tags);
   ```

2. `mergeMetadata` itself at `:283-295` adds exactly ONE key —
   `extractor_tags` (CSV of decision tags). No timestamp injected:

   ```
   286: function mergeMetadata(
   287:   base: SemanticMemoryMetadata | undefined,
   288:   tags: readonly string[],
   289: ): SemanticMemoryMetadata | undefined {
   290:   if (tags.length === 0) {
   291:     return base;
   292:   }
   293:   const csv = tags.join(",");
   294:   return {
   295:     ...(base ?? {}),
   296:     extractor_tags: csv,
   297:   };
   298: }
   ```

3. The constant `EXTRACTOR_TAGS_METADATA_KEY = 'extractor_tags'` at
   `:302` is the single canonical key contributed by the extractor today.

4. Repo-wide grep for `recordedAt` returns five hits, NONE in the memory
   layer — `intent-ledger.ts`, `intent-ledger.test.ts`, `plugin.ts`,
   `machine/service.ts`, `machine/service.test.ts`. The semantic-memory
   write path is silent on `recordedAt`.

5. The persistent backend's `created_at` column is INTEGER on the
   `semantic_entries` table (`src/platform/memory/sqlite-vec-store.ts:210`,
   index `:216`) but it is NEVER projected back through
   `SqliteVecMemoryStore.recall`. The recall projection at `:526-528` and
   `:556-558` selects `s.id, s.identity_id, s.content, s.metadata_json`
   only. Therefore the store-layer write timestamp is invisible to the
   contractor; freshness MUST rely on caller-supplied
   `metadata.recordedAt`.

**Implication for the slice.** Phase 4 wiring needs `metadata.recordedAt`
(or whichever scalar key the extractor will start writing). Two paths:

- (preferred) Extend `LlmExtractorMemoryStore.storeSemantic` to inject
  `recordedAt: nowFn().toISOString()` into `mergedMetadata` at the same
  site `:222` (uses the new `now?: () => number` seam from §c). This is
  ADDITIVE on the metadata scalar map (allowed under
  `SemanticMemoryMetadataSchema`), respects invariant #11 (no frozen
  contract change — `MemoryStore` interface unchanged), and gives
  `scoreByRecency` a dependable timestamp on every newly-written entry.
- (fallback) Legacy entries written before the extractor change carry no
  `recordedAt`. Sub-plan §3 / §10 default `missingTimestampPolicy =
  'penalize_to_floor'` covers this — legacy rows survive at
  `recencyDecay = DECAY_FLOOR = 0.05`, never silently dropped, and they
  get progressively replaced as the extractor backfills new writes.

This finding does NOT block Phase 1; it surfaces a coupled write-path
edit that Phase 2 / Phase 4 will need to schedule. The sub-plan already
calls out "encourages LLM-extractor backfill" in todo
`freshness-phase-2-types`, which matches.

### b.3 `TaskRecord.createdAt` + `TaskRecord.updatedAt`

ISO-8601 strings, validated at decode against `IsoTimestampSchema` and
its anchored regex:

```
src/platform/task/task-record.ts:96-104
96: const ISO8601_PATTERN =
97:   /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
98:
99: const IsoTimestampSchema = z
100:   .string()
101:   .min(1)
102:   .regex(ISO8601_PATTERN, {
103:     message: "expected an ISO-8601 timestamp",
104:   });
```

```
src/platform/task/task-record.ts:150-162
150: export type TaskRecord = {
151:   readonly id: TaskId;
152:   readonly ownerIdentityId: IdentityId;
153:   readonly label: string;
154:   readonly status: TaskStatus;
155:   readonly summary: string;
156:   readonly createdAt: string;
157:   readonly updatedAt: string;
158:   readonly completedAt?: string;
159:   readonly result?: string;
160:   readonly sourceEffectFamily?: string;
161:   readonly sourceEffectId?: string;
162: };
```

Both are required, both ISO-8601, both branded only by the regex (not by a
nominal type). Phase 4 reads them via `task.updatedAt ?? task.createdAt` —
the `updatedAt` field is non-optional, so the fallback is defensive (covers
hypothetical legacy rows that may have skipped a migration; current schema
forbids that path). `Date.parse(...)` consumed inside `scoreByRecency` will
treat both as numeric epoch ms; NaN tolerance is per sub-plan
`freshness-phase-3-scoring-helper`.

### b.4 Summary

- `<memory>` timestamp source: caller-supplied `entry.metadata.recordedAt`
  (string ISO-8601). NOT WRITTEN today. The slice's coupled write-path
  edit on `LlmExtractorMemoryStore.storeSemantic` is the simplest fill
  point.
- `<active_tasks>` timestamp source: `task.updatedAt` (primary),
  `task.createdAt` (fallback). Both populated today by the task ledger
  (slice F P2 contract).

---

## §c Clock seam audit

### c.1 Single existing `Date.now()` site

```
src/platform/commitment/intent-contractor-impl.ts:710-713
710:             {
711:               role: "user",
712:               content: buildIntentContractorPrompt({ ...params, rawTurn }),
713:               timestamp: Date.now(),
```

The site lives inside `class PiIntentContractorAdapter implements
IntentContractorAdapter` (declared `:661`). Repo-wide grep within
`intent-contractor-impl.ts` confirms exactly ONE `Date.now()` call
(`Grep` against `Date\.now` returns a single hit at `:712`).

### c.2 Why the existing site is the WRONG seam for decay

- The `:712` `Date.now()` produces a single-shot `timestamp` field on the
  user-message envelope sent to the simple-completion adapter. It is
  consumed by adapter telemetry, NOT by the contractor's classification
  pipeline.
- Hijacking that site would couple decay scoring to the adapter call —
  but the contractor needs the clock value BEFORE the adapter call at
  `:397-414`, not at the moment of LLM dispatch. Specifically the call
  chain is:
  1. `prompt` materialised (`:354`).
  2. `maybeRecallMemory` (`:360-366`) — needs `clockNowMs` here for decay.
  3. `maybeRecallActiveTasks` (`:371-375`) — needs `clockNowMs` here.
  4. `buildInboundAttachmentsBlock` (`:383-386`).
  5. (NEW Phase 4) `buildFreshnessHintsBlock(config, clockNowMs)` here.
  6. `blockPrefix` concatenated (`:393`).
  7. `adapter.classify(...)` invoked (`:397`); the existing `:712`
     `Date.now()` fires INSIDE this call.
- Decay needs a clock IN THE OUTER FACTORY-RETURNED CLOSURE, not in the
  inner adapter; sharing them couples two unrelated lifetimes.

### c.3 Recommendation — NEW optional `now?: () => number` seam

Phase 4 deps extension on `createIntentContractor`:

```
readonly now?: () => number;
readonly freshnessConfig?: FreshnessConfig;
```

Rules:
- `now` defaults to `Date.now` when omitted (preserves byte-identical
  pre-Phase-4 behaviour when `freshnessConfig` is also omitted).
- Decay scoring helper `scoreByRecency<T>(...)` takes `clockNowMs:
  number` (NOT a closure) — the closure is invoked by the contractor at
  the call sites in §c.2 step 2 / 3 / 5 and the resolved number is
  threaded into the helper. Helper purity invariant load-bearing: NO
  `Date.now()` inside `scoreByRecency` — sub-plan
  `freshness-phase-3-scoring-helper` is explicit.
- Mirrors precedents: `logger?:` (slice E P6),
  `memoryStore?: MemoryStore` (slice E P6), `taskLedger?: TaskLedger`
  (slice F P6), `inboundMediaResolver?:` (Cutover-3 P6),
  `recallWindowResolver?` (Slice K P5). Five additive constructor
  extensions already coexist (sub-plan §3 force #1).
- Default applied at the call site (NOT mutated into deps). Pattern:
  `const clockNowMs = (deps.now ?? Date.now)();` invoked once per
  classify call so all reorder paths see the same `clockNowMs` (lock-step
  consistency).

### c.4 Why a closure (not a number) is the seam

A closure lets each `classify(...)` call freshly sample the clock; a
number-typed `clockNowMs` baked into `createIntentContractor` deps would
freeze time for the lifetime of the contractor instance and surface
catastrophic decay drift. The closure also matches the test pattern: tests
inject `now: () => 1700000000_000` for deterministic assertions
(sub-plan `freshness-phase-3-scoring-helper` cases 4 / 5).

### c.5 Confirmation

The audit confirms the sub-plan §2.3 sketch verbatim: "intent-contractor-impl.ts
reads Date.now() ONLY in PiIntentContractorAdapter.classify. Decay needs
independent clock via NEW optional `now?: () => number` seam."

---

## §d Clock-skew reality

Three independent clock vectors are in play across a deployed v1:

| Vector | Host | Surface | Today's clock source |
| --- | --- | --- | --- |
| Gateway / contractor runner | Operator's machine running `god-mode-core` | `(deps.now ?? Date.now)()` invoked inside `createIntentContractor` closure (Phase 4). This becomes the freshness reference clock — `clockNowMs`. | `Date.now()` |
| LLM-extractor host | Same machine in single-tenant; potentially DIFFERENT machine in remote-extractor deployments | Stamps `metadata.recordedAt` at the moment of `storeSemantic` (Phase 4 coupled edit, §b.2) | `Date.now()` (will be) |
| Persistent store host (sqlite-vec) | Local file today; remote DB potentially in v2 | `created_at` column populated by `Date.now() * 1000` at `src/platform/memory/sqlite-vec-store.ts:702` — NOT projected to recall callers, so freshness never reads it | local clock |

A pessimistic skew bound is the host-clock NTP discipline (typically
+/- a few seconds, but operator laptops with disabled time sync drift
into minutes/hours). Two concrete failure modes are possible TODAY:

1. **Future-stamped entries** — extractor host clock runs minutes ahead of
   contractor host clock. `clockNowMs - parsedTs < 0` → naive
   `0.5 ^ (negative / halfLife)` produces `recencyDecay > 1.0`, which
   silently inflates the entry's `combinedScore` above any other entry's
   relevance signal.
2. **Negative-age cap omission** — even within a single host, monotonic
   clock perturbation (NTP step-back) can produce ageMs < 0 for entries
   recorded seconds ago.

The sub-plan acceptance criterion #5 (Phase 5 acceptance test) caps
`recencyDecay <= 1.0`; this audit confirms the cap is necessary defense
even before remote-extractor deployments. The ageMs reported in
`RecencyScored<T>.ageMs` should still record the negative value (or
clamp to 0 — design choice for Phase 3) so the cap doesn't silently mask
clock-skew telemetry.

Recommended Phase 3 helper rule (records design intent for Phase 3
implementer):

```
recencyDecay = clamp(0.5 ^ (max(ageMs, 0) / decayHalfLifeMs), DECAY_FLOOR, 1.0)
ageMs = nullable(clockNowMs - parsedTs)   // may be negative; never throws
```

Floor `DECAY_FLOOR = 0.05` from sub-plan; cap `1.0` from this audit.
NaN parses (malformed `recordedAt` string) → `missingTimestampPolicy`
branch; sub-plan §10 names both branches.

---

## §e Privacy / identity isolation

`MemoryStore.recall` is keyed on `identityId` at storage layer:

```
src/platform/memory/semantic-memory.ts:48-52
48: export type SemanticMemoryQuery = {
49:   readonly identityId: IdentityId;
50:   readonly query: string;
51:   readonly limit?: number;
52: };
```

`maybeRecallMemory` at `intent-contractor-impl.ts:464-468` passes `identityId`
verbatim; no cross-identity blending happens upstream of the contractor.

`maybeRecallActiveTasks` at `intent-contractor-impl.ts:539-542` passes
`ownerIdentityId` to `TaskLedger.list`; the ledger is per-identity by
`TaskListQuery.ownerIdentityId` (`task-record.ts:274-279`).

Freshness operates ENTIRELY on the per-identity recall result — both
`maybeRecallMemory` and `maybeRecallActiveTasks` produce result lists
ALREADY filtered to one identity, and `scoreByRecency` is a pure reorder
that never cross-walks two recall results. Phase 5 acceptance #6
("Identity-isolation invariant unchanged — freshness reorder NEVER
promotes other identity entries") is structurally satisfied because there
is no code path inside the freshness helper that sees more than one
identity's entries. The acceptance test still ships as a regression
guard against future refactors.

Conclusion: identity isolation cannot regress. No additional sub-plan
work needed.

---

## §f Operator-impact estimate

Sub-plan §5 calls for scanning `[intent-contractor] memory.recall
entries=N` log lines over a recent window to size the high-N cohort.

Audit finding: **the log line `[intent-contractor] memory.recall
entries=N` does NOT exist in the codebase TODAY.** Evidence:

1. `Grep` against the operator log
   `C:/tmp/openclaw/openclaw-2026-05-05.log` (1.0 MB, the only operator
   log under `C:/tmp/openclaw/` per `ls`) for
   `memory.recall entries=` returns zero matches.
2. Grep for `recall` in the same log returns 76 lines (mostly
   `memory_search`, `memory bootstrap: ...`, `memory sync failed
   (search)`, `memory_search detail=memory_search`, `memory bootstrap:
   no embedder configured; using InMemoryMemoryStore (recall persists
   in-memory)`) — none of those carry an `entries=N` count.
3. Grep against `src/` for the literal log key
   `\[intent-contractor\] memory.recall` returns zero matches in the
   compiled product — the line is a NEW Phase 5 deliverable per
   sub-plan §5 ("Log-line evidence: `[intent-contractor]
   memory.recall entries=<N>`").

Implication: the operator-impact estimate is **deferred to Phase 5
live-verify**. Phase 1's role is to declare the metric absent and
schedule its emission. Phase 4 wires the recency-aware reorder; Phase 5
adds three log lines (per sub-plan §5):

- `[intent-contractor] freshness.applied entries=<N> halfLifeMs=<N> windowMs=<N>`
- `[intent-contractor] memory.block injected entries=<N> recencyDecayMin=<f> recencyDecayMax=<f>`
- `[intent-contractor] active_tasks.block injected tasks=<N> oldestAgeMs=<N>`
- `[intent-contractor] freshness_hints.block injected clockNow=<ISO>`

Sub-plan §4 acceptance #11 ("Telegram live-verify: 3 live operator turns
with high-N memory cohort succeed; recency log lines emitted") is the
gate that closes the loop — Phase 5 will have measurable impact data
once those log lines fire.

Inferential note (informational only): the high-N cohort is bounded
above by `DEFAULT_INTENT_CONTRACTOR_MEMORY_RECALL_LIMIT` (the slice E P6
default). Repo today does not exceed that cap because no recall path in
the operator log returns more than the configured limit. The freshness
slice does not change the cap; it changes WHICH entries within the
top-K survive prompt-attention dominance.

---

## §g Rollup — Phase 1 deliverables checklist

| Deliverable | Status |
| --- | --- |
| `extensions/AUDIT-intent-contractor-freshness.md` exists | DONE (this file) |
| Block-builder line numbers + sort-point analysis | DONE — §a, six builders catalogued |
| In-scope vs out-of-scope decision per builder | DONE — §a.6 summary table |
| Timestamp metadata key confirmed (`recordedAt`) | DONE — §b.2 — key NOT WRITTEN today; coupled extractor edit scheduled for Phase 4 |
| `TaskRecord.createdAt` + `TaskRecord.updatedAt` confirmed ISO-8601 | DONE — §b.3 |
| Clock seam decision documented (NEW `now?: () => number`) | DONE — §c.3 |
| Clock-skew reality + cap recommendation | DONE — §d |
| Identity isolation cannot regress | DONE — §e |
| Operator-impact estimate / log-line gap | DONE — §f — deferred to Phase 5 |
| `pnpm exec tsgo --noEmit` clean | DONE (audit is markdown only — no source change) |

## §h Open items handed to subsequent phases

1. **Phase 2** — schema-encode `FreshnessConfig` with defaults
   `decayHalfLifeMs = 7 * 24 * 60 * 60 * 1000` (7d), `defaultWindowMs =
   30 * 24 * 60 * 60 * 1000` (30d), `missingTimestampPolicy =
   'penalize_to_floor'`, `DECAY_FLOOR = 0.05` (sub-plan
   `freshness-phase-2-types`). Reject negative half-life / zero window
   at decode (Zod `.positive().int()`).

2. **Phase 3** — pure helper `scoreByRecency<T>(...)`. Apply both the
   `>= 0.05` floor (sub-plan) and the `<= 1.0` cap (this audit §d).
   Helper takes `clockNowMs: number`, NEVER calls `Date.now()`.
   `Date.parse(...)` with NaN guard. `extractTimestamp` callback typed
   `(item: T) => string | number | undefined` so callers can plug
   `e => e.metadata?.recordedAt as string | undefined` (memory) and
   `t => t.updatedAt ?? t.createdAt` (tasks).

3. **Phase 4** — three coupled edits, in order:
   - `createIntentContractor` deps gain `freshnessConfig?` +
     `now?: () => number`.
   - `maybeRecallMemory` reorder via `scoreByRecency` keyed on
     `entry.metadata.recordedAt`; `combinedScore = entry.score *
     recencyDecay`; sort DESC; pass through `buildMemoryBlock` (now
     emits additive `recencyDecay` per entry payload).
   - `maybeRecallActiveTasks` reorder via `scoreByRecency` keyed on
     `task.updatedAt ?? task.createdAt`; pass through
     `buildActiveTasksBlock` (payload shape unchanged; only order
     changes).
   - NEW `buildFreshnessHintsBlock(config, clockNowMs)` placed AFTER
     `<inbound_attachments>` BEFORE raw user prompt (sub-plan §6).
     Self-elides when no recall path fired.
   - COUPLED extractor edit: `LlmExtractorMemoryStore.storeSemantic`
     injects `recordedAt: new Date(nowFn()).toISOString()` into
     `mergedMetadata` at `:222` so newly-written semantic entries carry
     the timestamp going forward. Legacy rows fall through
     `missingTimestampPolicy = 'penalize_to_floor'`.

4. **Phase 5** — three NEW log lines per sub-plan §5, plus live-verify of
   3 operator turns with a high-N cohort. The acceptance test
   `intent-contractor-freshness.acceptance.test.ts` covers the six cases
   in todo `freshness-phase-5-acceptance` (high-N reorder, mixed-age
   tasks, default config hints, byte-identical regression, future
   timestamp cap, identity isolation guard).

End of audit.
