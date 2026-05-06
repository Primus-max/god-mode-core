---
name: NEW-A — Modality-aware routing in model-fallback
slice: modality-aware-routing
status: in_progress
signoff: GRANTED via blanket authorization 2026-05-05
overview: "Live-test gap NEW-A (master §0.5.6, 2026-05-06): the `model-fallback` candidate-ordering layer orders candidates by name/heuristic but does NOT filter by modality requirements of the turn. When a turn carries an image attachment and a text-only Hydra-routed model (`hydra/claude-opus-4.6`, `input_modalities=['text']`) is first in the candidate list, that model is selected and the image is silently dropped. Architectural fix: candidate-ordering reads each model's `inputModalities` from the existing `ModelCatalogEntry` and filters/reranks by the turn's modality requirements derived from `inboundMediaResolver().attachments[].kind` (already structural per Cutover-3 P6) plus the contractor's `desiredEffectFamily`. Provider-agnostic — works identically when Opus/Sonnet/local-models change. Per-provider hacks (`ban Opus when image present`) are EXPLICITLY forbidden."
todos:
  - id: ma-phase-1-audit
    content: "Phase 1 — Audit (read-only). Output `extensions/AUDIT-modality-aware-routing.md`. Map: (a) exact site of `route candidates ordered:` log line — `src/agents/model-fallback.ts` inside `runWithModelFallback(...)` after `applyModelRoutePreflight(...)`; (b) every call site of `runWithModelFallback(...)` — confirmed callers: `src/agents/agent-command.ts`, `src/auto-reply/reply/agent-runner-execution.ts`, `src/auto-reply/reply/followup-runner.ts`, `src/cron/isolated-agent/run.ts`, `src/auto-reply/reply/agent-runner-memory.ts`; (c) the existing `ModelCatalogEntry.input?: ModelInputType[]` surface in `src/agents/model-catalog.ts` (`'text' | 'image' | 'document'`) — confirm it is populated for Hydra (`normalizeHydraCatalogInput`), Chutes (`chutes-models.ts`), HuggingFace (`huggingface-models.ts`), local providers; (d) every place the catalog is loaded — `loadModelCatalog({ config })` is already called inside `runWithModelFallback(...)`, so the catalog is in scope at the filter site; (e) the existing `RecipePlannerInput.needsVision?: boolean` at `src/platform/recipe/planner.ts` and confirm whether any caller already populates it from `inboundMediaResolver` data; (f) the `inboundMediaResolver()` surface at `src/platform/commitment/intent-contractor-impl.ts` — `InboundMediaSummary { attachments: readonly InboundMediaAttachment[] }` with `attachment.kind ∈ {'image' | 'pdf' | 'docx' | 'other'}` (closed enum per Cutover-3 P6); (g) confirm the audit file references `C:\\tmp\\openclaw\\openclaw-2026-05-06.log` lines L164/L750/L2865 with verbatim `route candidates ordered: hydra/claude-opus-4.6 -> hydra/gpt-5.4 -> ...` capture and the corresponding image-dropped reply (the missing-image symptom). Read-only deliverable; no source changes. Branch `audit/new-a-modality-aware-routing-phase-1`."
    status: pending
  - id: ma-phase-2-types-and-derivation
    content: "Phase 2 — Types + helper to derive turn modality requirements. NEW file `src/agents/model-fallback-modality.ts` (NOT under `src/platform/commitment/` per invariant #11 — orchestration-layer fix). Exported types: `ModalityRequirement = 'text' | 'image' | 'audio' | 'video'` (closed union; `audio`/`video` typed-but-inert until corresponding inbound kinds are wired in a future sub-plan). Helper `deriveTurnModalityRequirements(input: { inboundMediaSummary?: InboundMediaSummaryLike; desiredEffectFamily?: string; needsVision?: boolean }): readonly ModalityRequirement[]`. Mapping: `attachment.kind === 'image'` → adds `'image'`; `kind === 'pdf' | 'docx' | 'other'` → does NOT add `'image'` (these are document-mode, handled by `'text'` + downstream document tooling); `desiredEffectFamily.startsWith('image_generation')` → adds `'image'` ONLY IF the turn ALSO references an inbound image (img2img path); `needsVision === true` → adds `'image'` (defense-in-depth). `'text'` is ALWAYS in the requirement set. Pure structural reads — never `RawUserTurn` / `UserPrompt` (invariant #5). `InboundMediaSummaryLike` is a structural type local to this module — does NOT import from `src/platform/commitment/` (invariant #8 defense-in-depth). Tests: image attachment → `['text', 'image']`; pdf attachment → `['text']`; no attachments + no `needsVision` → `['text']`; img2img desired family + image attachment → `['text', 'image']`; pure text-to-image desired family without inbound image → `['text']`; ordering of returned tuple is stable (sorted) so downstream comparisons are deterministic."
    status: pending
  - id: ma-phase-3-model-registry-surface-confirmation
    content: "Phase 3 — Confirm `ModelCatalogEntry.input?: ModelInputType[]` is the correct registry surface. AUDIT in Phase 1 already established this field exists at `src/agents/model-catalog.ts`, populated for the Hydra catalog, Chutes, HuggingFace. Phase 3 is ADDITIVE: write a small helper `modelCoversModalityRequirement(entry: ModelCatalogEntry, requirement: ModalityRequirement): boolean` that maps `requirement` → catalog `ModelInputType` (image→image, text→text, audio→returns false until catalog gains `'audio'`, video→same — typed-but-inert). DO NOT widen `ModelInputType` in this slice (deferred to follow-up). Tests: entry with `input: ['text']` covers `['text']` but NOT `['text', 'image']`; entry with `input: ['text', 'image']` covers both; entry with `input: undefined` is treated as `['text']`-only (conservative default). Reverse-test: `audio` requirement against any current catalog entry returns `false` — proves typed-but-inert surface fails-closed."
    status: pending
  - id: ma-phase-4-candidate-filter
    content: "Phase 4 — `filterCandidatesByModality(params: { candidates: readonly ModelCandidate[]; requirements: readonly ModalityRequirement[]; catalog: readonly ModelCatalogEntry[] }): { filtered: readonly ModelCandidate[]; dropped: readonly { candidate: ModelCandidate; missingModalities: readonly ModalityRequirement[] }[] }`. Pure function in `src/agents/model-fallback-modality.ts`. Behaviour: for each candidate, look up its catalog entry by `(provider, model)` (case-insensitive — reuse `modelKey` helper); if entry not found → KEEP candidate (conservative — unknown ≠ incompatible); if entry found and ALL requirements covered → KEEP; if some requirements missing → DROP into `dropped` list. **Survivor-set non-empty invariant**: if filtering would result in ZERO survivors, RETURN UNFILTERED `candidates` and emit a warning surfaced via the returned `dropped` list — fail-open. This invariant is structurally tested. Tests: image+text requirement against `[opus(text-only), gpt-5.4(text+image)]` → filtered=[gpt-5.4], dropped=[opus]; same against `[opus(text-only)]` → filtered=[opus] (fail-open), dropped=[opus] (still recorded); unknown candidate not in catalog → KEPT; empty requirements → all KEPT (structural identity); empty candidates → empty result; case-insensitivity check."
    status: pending
  - id: ma-phase-5-wiring-into-runwithmodelfallback
    content: "Phase 5 — Wire `filterCandidatesByModality` into `runWithModelFallback(...)` immediately AFTER `applyModelRoutePreflight(...)` returns its `{ candidates, decision }` and BEFORE the `route candidates ordered:` log. Order-of-operations: (i) preflight may reorder; (ii) modality-filter trims/reorders preflight result; (iii) existing log line shows FINAL ordered list. Add ONE new `params` field to `runWithModelFallback`: `turnModalityRequirements?: readonly ModalityRequirement[]`. Existing callers pass `undefined` and behave byte-identical (regression guard). Slice's actual call-site update is in `agent-runner-execution.ts` (production path NEW-A reproduced live): derive requirements via `deriveTurnModalityRequirements(...)`. **Defensive log lines**: `[model-fallback] modality_filter applied required=image survivors=N dropped=M`; on fail-open: `[model-fallback] modality_filter fail_open required=image,text reason=zero-survivors-after-filter restoring=N candidates`; no requirements → no log emitted. Frozen `src/platform/commitment/` source NOT touched. Tests: regression — caller without `turnModalityRequirements` byte-identical output; positive — image requirement filters Opus from `[opus, gpt-5.4]`; fail-open — single-candidate `[opus]` with image requirement produces `modality_filter fail_open` log AND keeps opus."
    status: pending
  - id: ma-phase-6-acceptance-and-live-verify
    content: "Phase 6 — End-to-end acceptance + live-verify. Acceptance file: `src/agents/model-fallback.modality.acceptance.test.ts`. Fixture-mode: stubbed `loadModelCatalog` returning `[{provider:'hydra', model:'claude-opus-4.6', input:['text']}, {provider:'hydra', model:'gpt-5.4', input:['text','image']}]`; stubbed `run(provider, model, options)` recording chosen pair. Cases: (1) **NEW-A reproduction (positive)** — call with `turnModalityRequirements:['text','image']` → run is called with `(hydra, gpt-5.4)`, NOT opus, AND `[model-fallback] modality_filter applied required=image survivors=1 dropped=1` log emitted. (2) **Reverse — NEW-A symptom in absence-of-fix mode** — same call WITHOUT `turnModalityRequirements` → run called with `(hydra, claude-opus-4.6)` first. (3) **Fail-open** — single-candidate `[opus]` + image requirement → run still called with opus AND `modality_filter fail_open` log. (4) **Document-mode pass-through** — pdf attachment + no `needsVision` → requirements=`['text']`, all candidates pass, no filter log. (5) **Anonymous resolver** — `inboundMediaSummary=undefined` → no requirements derived → byte-identical to today. Live-verify (operator runbook): replay 2026-05-06 turn at `C:\\tmp\\openclaw\\openclaw-2026-05-06.log:L750` against `dev` HEAD, confirm new log lines appear AND assistant reply now references image content. NEW-A CLOSED when (a) acceptance test passes AND (b) live-replay shows correct image-aware response. Branch: `feat/new-a-modality-aware-routing-phase-6-acceptance`."
    status: pending
isProject: false
---

# NEW-A — Modality-aware routing in model-fallback

## 0. Provenance

| Field | Value |
| --- | --- |
| Sub-plan of | `.cursor/plans/commitment_kernel_v1_master.plan.md` (§0.5.6 row NEW-A) |
| Inherits | 16 hard invariants from `.cursor/rules/commitment-kernel-invariants.mdc` |
| Predecessor | Cutover-3 P6 (`inboundMediaResolver` + `InboundMediaSummary` structural surface). Slice E P6 / Slice F P6 contractor recall pattern. |
| Trigger | Master §0.5.6 NEW-A: live-test on dev `735f65c019` (2026-05-06) showed `route candidates ordered: hydra/claude-opus-4.6 -> hydra/gpt-5.4 -> ...` for image-bearing turns; Hydra-routed Opus has `input_modalities=['text']` and silently drops the image. |
| Out of scope | (a) Per-provider blocklists — explicitly forbidden; fix MUST be capability-driven, provider-agnostic. (b) Widening `ModelInputType` to include `'audio'`/`'video'` — typed-but-inert. (c) Changing Hydra primary in config. (d) Modifying `src/platform/commitment/` source — invariant #11. (e) Live-verify replay automation in CI — manual operator runbook only. |
| Maintainer signoff | GRANTED via blanket authorization 2026-05-05. Per-phase signoff implicit. |

## 1. Hard invariants this slice keeps

- **#5, #6**: No new readers of raw user text. `deriveTurnModalityRequirements` reads only structural fields. `inboundMediaResolver` is the single sanctioned source — already established by Cutover-3 P6.
- **#8**: New module `src/agents/model-fallback-modality.ts` lives in `src/agents/`. Does NOT import from `src/platform/commitment/`. Structural type `InboundMediaSummaryLike` duck-types the contractor type.
- **#11**: 5 frozen contracts NOT touched. `intent-contractor-impl.ts` NOT modified. Cutover-3 P6 seam consumed downstream.
- **#15**: Blanket signoff covers NEW-A per master §0.5.6.
- **#16**: No new branded ID types. `ModalityRequirement` is a string literal union.
- **No per-provider hacks**: filter keyed on `ModelCatalogEntry.input` (capability declaration), NOT on `provider` or `model` strings.

## 2. Audit findings (TO BE FILLED IN BY PHASE 1)

> Phase 1 produces `extensions/AUDIT-modality-aware-routing.md`. Sketches below are starting points.

### 2.1. Routing layer site (sketch)

- Exact site: `src/agents/model-fallback.ts` — `log.info(\`route candidates ordered: ...\`)` inside `runWithModelFallback(...)`.
- Catalog already loaded via `loadModelCatalog({ config })` inside `runWithModelFallback`.
- Preflight runs at `applyModelRoutePreflight(...)`. Modality filter MUST run AFTER preflight.
- Production callers via grep: `agent-runner-execution.ts` (NEW-A reproducer), `followup-runner.ts`, `agent-runner-memory.ts`, `cron/isolated-agent/run.ts`, `agent-command.ts`. Slice updates ONE call-site explicitly; others pass `undefined` (regression guard).

### 2.2. Model registry surface (sketch)

- `ModelCatalogEntry.input?: ModelInputType[]` exists at `src/agents/model-catalog.ts` — `ModelInputType = 'text' | 'image' | 'document'`.
- Hydra populates via `normalizeHydraCatalogInput`. Opus surfaces `['text']` only.
- Chutes filters to `'text' | 'image'`. HuggingFace reads `architecture.input_modalities`.
- Local providers may NOT populate — Phase 3 helper treats `undefined` as `['text']`-only.

### 2.3. Turn modality derivation (sketch)

- `inboundMediaResolver?: () => InboundMediaSummary | undefined` — Cutover-3 P6 at `intent-contractor-impl.ts`.
- `attachment.kind ∈ {'image' | 'pdf' | 'docx' | 'other'}` (closed).
- `RecipePlannerInput.needsVision?: boolean` exists at `src/platform/recipe/planner.ts` — defensive secondary signal.
- `routingSnapshot.plannerInput` already passed into `runWithModelFallback`. Slice plumbs `inboundMediaSummary` alongside.

## 3. Hypothesis

The fix is shaped by FOUR forces:

1. **NEW-A symptom is structural**: `route candidates ordered: hydra/claude-opus-4.6 -> hydra/gpt-5.4` is the LITERAL preflight output for many text-bearing turns. Today's preflight does not consider modality.
2. **Cutover-3 P6 already established structural inbound-media metadata**. Data is in scope; this slice consumes it.
3. **Existing `ModelCatalogEntry.input` field** carries `'text' | 'image' | 'document'`. Zero registry-shape change needed.
4. **Invariants forbid frozen-layer touches**; user directive forbids per-provider hacks. Fix lives in `src/agents/`.

Phase plan: 6 phases (audit, types+derivation, registry-surface confirmation, candidate filter, wiring, acceptance).

## 4. Acceptance criteria

1. `ModalityRequirement` type exists in `src/agents/model-fallback-modality.ts`.
2. `deriveTurnModalityRequirements` correctly maps inbound attachments + desired effect family + `needsVision`.
3. `modelCoversModalityRequirement` treats `entry.input === undefined` as `['text']`-only; reverse-tested against `'audio'`.
4. `filterCandidatesByModality` drops incompatible candidates AND fails open when filtering would empty survivors.
5. `runWithModelFallback(...)` accepts optional `turnModalityRequirements`; existing callers byte-identical.
6. Operator log lines `[model-fallback] modality_filter applied|fail_open ...` emitted at exact filter moment.
7. NEW-A acceptance test reproduces live symptom in absence-of-fix mode + closes it in fix-mode.
8. Live-verify replay confirms image-aware response on `dev` HEAD post-merge.
9. Frozen-layer integrity — `src/platform/commitment/` source byte-identical pre/post slice.
10. No per-provider hacks — audit grep confirms zero `provider === 'hydra'` strings in slice-introduced code.

## 5. Per-phase tests (must catch real bugs)

- **Fail-first**: negative test reproduces absence-of-functionality before the fix.
- **No `vi.spyOn` on the function under test.** Spies reserved for `loadModelCatalog` stub and injected `run` callback.
- **Cover negative case**: malformed input handled, missing data → conservative default, fail-open invariant tested.

Per-phase specifics:
- Phase 1: audit produces markdown deliverable.
- Phase 2: matrix 5×3×2 across attachment-kind × effect-family × `needsVision`. Stable sorted output.
- Phase 3: reverse-test `'audio'` returns `false`.
- Phase 4: fail-open invariant tested. Case-insensitive lookup tested.
- Phase 5: regression test — snapshot match `route candidates ordered:` log without `turnModalityRequirements`.
- Phase 6: full reproduction (absence-of-fix) + closure (fix-mode) + operator runbook.

## 6. Implementation notes

- New module path: `src/agents/model-fallback-modality.ts` (co-located with `model-fallback.ts`).
- Wiring site: `src/agents/model-fallback.ts` after `applyModelRoutePreflight` + before `route candidates ordered:` log.
- Fail-open posture: when filtering would empty survivor list, original (unfiltered) list returned + `modality_filter fail_open` log emitted.
- Catalog `undefined` posture: treated as `['text']`-only (conservative).
- Defense-in-depth on invariant #8: structural `InboundMediaSummaryLike` declared locally, NOT imported.
- No phrase-matching (invariant #5).
- Hydra primary stays `hydra/gpt-5.4` at config level — slice changes runtime filtering only.
- Audio/video typed-but-inert in this slice.
- Operator log discipline: zero spam for legacy callers (no `turnModalityRequirements` → no log).

## 7. Maintainer signoff

GRANTED via blanket authorization 2026-05-05. Admin-merge via `gh pr merge --admin --squash --delete-branch`.

## 8. Deferred / out-of-scope

| Item | Why deferred |
| --- | --- |
| Widening `ModelInputType` to include `'audio'`/`'video'` | Typed-but-inert until audio/video models actually land. |
| Per-provider blocklist hacks | Forbidden by user directive. |
| Modifying Hydra primary in config | Out of scope — runtime filtering only. |
| Live-verify replay automation in CI | Operator runbook only. |
| Modifying `src/platform/commitment/` source | Frozen per invariant #11. |
| Extending `inboundMediaResolver` seam | Cutover-3 P6 already shipped structural surface. |

## 9. Handoff Log

### YYYY-MM-DD — Phase N landed (PR #...)

(To be filled by handoff-writer per master §0 protocol after each phase merges.)

## 10. References

- Master plan: `.cursor/plans/commitment_kernel_v1_master.plan.md` (§0.5.6 row NEW-A).
- Hard invariants: `.cursor/rules/commitment-kernel-invariants.mdc`.
- Live evidence: `C:\tmp\openclaw\openclaw-2026-05-06.log` lines L164/L750/L2865.
- Routing layer: `src/agents/model-fallback.ts`.
- Cutover-3 P6 inbound-media surface: `src/platform/commitment/intent-contractor-impl.ts`.
- Existing model registry surface: `src/agents/model-catalog.ts`.
- Existing planner profile vision flag: `src/platform/recipe/planner.ts`.
- Slice E sub-plan template: `.cursor/plans/commitment_kernel_memory_layer.plan.md`.
- Sibling NEW-B/C/D + cutover-4 sub-plans (TBD).
