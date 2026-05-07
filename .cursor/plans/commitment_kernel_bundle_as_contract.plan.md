---
name: Bundle-as-contract enforcement at LLM schema layer
slice: bundle-as-contract
status: completed
signoff: GRANTED via blanket authorization 2026-05-05
predecessor: c1294b0f71
overview: "LLM tool schema собирается в `src/agents/pi-embedded-runner/run/attempt.ts:1915` через `createOpenClawCodingTools(...)` БЕЗ параметра `toolBundles`. `ResolutionContract.toolBundles` (закрытый enum: `respond_only` / `repo_run` / `repo_mutation` / `interactive_browser` / `public_web_lookup` / `document_extraction` / `artifact_authoring` / `external_delivery` / `session_orchestration`) сегодня advisory metadata — НЕ hard schema-filter. Единственный capability-фильтр (`applyModelProviderToolPolicy` at `src/agents/pi-tools.ts:94-104`) асимметричен: removes DDG `web_search` от моделей с `nativeWebSearchTool=true`, но НЕ защищает обратную сторону — модели без native search всё равно получают DDG-tool в schema. Live evidence: `gateway-grok-route.log` 2026-05-02 turn `355ae135` — classifier mis-emit `bundles=[respond_only] requestedTools=[]` → autonomous `web_search` exposed → DDG bot-detection → `Provider finish_reason: error`. Архитектурный fix: NEW pure `BundleSchemaFilter` policy/predicate; closed `bundle → allowed-tool-set` mapping; wired в `createOpenClawCodingTools(...)` call site at `attempt.ts:1915`; layered ATOP existing `applyModelProviderToolPolicy`. Симметричная reverse-defense: model-without-native-search НИКОГДА не получает `web_search` — закрывает противоположный gap `applyModelProviderToolPolicy`. Pure additive; 16 invariants preserved; bundle-id enum закрыт (расширение требует отдельного signoff). Non-goals: per-provider hacks; openclaw.json wholesale overwrite; revert slices E/F/I; widen bundle-id enum; modify `applyModelProviderToolPolicy` semantics."
todos:
  - id: bundle-contract-phase-1-audit
    content: "Phase 1 — Audit (read-only). Output `extensions/AUDIT-bundle-as-contract.md`. Map: (a) `ResolutionToolBundleSchema` enum at `src/platform/decision/resolution-contract.ts:12-23` — 9 closed values; (b) every advisory consumer of `toolBundles` — `src/platform/decision/route-preflight.ts:847` (PR-#125+#126 narrow `public_web_lookup` gate), `src/platform/decision/web-evidence-prefetch.ts` (Search-Composer pre-orchestrator hook), `src/platform/recipe/planner.ts` (recipe planner), `src/platform/recipe/runtime-adapter.ts`, `src/platform/profile/{resolver,overlay}.ts`; (c) every schema-construction site of `createOpenClawCodingTools(...)` — confirmed callers via grep: `src/agents/pi-embedded-runner/run/attempt.ts:1915-1971` (production hot path — NEW-A reproducer parallel), `src/auto-reply/reply/commands-system-prompt.ts:55` (commands-system-prompt — NOT in scope; classifier-time prompt construction), `src/cron/isolated-agent/run.owner-auth.test.ts:70` (test only); (d) `applyModelProviderToolPolicy` semantics — confirms ONLY removes `web_search` for `nativeWebSearchTool=true` models; reverse direction NOT covered; (e) `attempt.ts:1915` argument shape — 50+ params, NONE is `toolBundles`; identify the structural source of `bundles` reaching the runtime (must trace `SemanticIntent.resolutionContract.toolBundles` → runtime adapter → attempt params); (f) bundle-emission contracts of recipe planner — confirm classifier ALWAYS emits non-empty `toolBundles` (production turns) OR may emit empty array (legacy fallback); (g) operator-impact estimate via `[bundle-filter]` not yet present; baseline log search for `Provider finish_reason: error` over 7-day window. NO source changes."
    status: completed
  - id: bundle-contract-phase-2-types
    content: "Phase 2 — Types + closed bundle→tool-set mapping. NEW file `src/agents/bundle-schema-filter.ts` (NOT under `src/platform/commitment/` per invariant #11; NOT under `src/platform/decision/` per invariant #8 — fix lives in adapter/runner orchestration layer). Types: `BundleId` (re-export of `ResolutionToolBundle` from `src/platform/decision/resolution-contract.ts` — single source of truth, NO new enum); `BundleAllowedToolSet = ReadonlySet<string>`; `BundleSchemaFilterConfig = { allowedToolsByBundle: ReadonlyMap<BundleId, BundleAllowedToolSet>; defaultAllowedTools?: BundleAllowedToolSet; missingBundlePolicy?: 'allow_all' | 'restrict_to_default' }`. NEW `resolveBundleAllowedTools(bundles: readonly BundleId[], config: BundleSchemaFilterConfig): BundleAllowedToolSet` — pure: union of per-bundle sets; empty bundles array honors `missingBundlePolicy` (default `allow_all` = legacy advisory parity for regression guard). Closed allowlists (initial mapping; widen ONLY via separate signoff): `respond_only` → `Set()` (NO tools — pure reply); `public_web_lookup` → `Set(['web_search', 'web_fetch'])`; `interactive_browser` → `Set(['browser_*'])`; `document_extraction` → `Set(['pdf_extract', 'docx_extract'])`; `artifact_authoring` → `Set(['pdf', 'docx', 'image_generate', 'apply_patch'])`; `external_delivery` → `Set(['delivery_*'])`; `session_orchestration` → `Set(['session_*'])`; `repo_run` → `Set(['exec', 'apply_patch'])`; `repo_mutation` → same as `repo_run` plus `git_*`. Mapping lives in NEW `DEFAULT_BUNDLE_ALLOWED_TOOLS` constant; closed-shape reverse-test enforces `Object.isFrozen` + every `BundleId` has an entry. NEW Zod `BundleSchemaFilterConfigSchema.strict()`. Tests fail-first (~6 cases): schema round-trip; reject unknown bundle id; closed-shape default mapping covers all 9 enum values; `resolveBundleAllowedTools(['respond_only'])` = empty; `resolveBundleAllowedTools(['respond_only','public_web_lookup'])` = union of both; empty bundles honors policy."
    status: completed
  - id: bundle-contract-phase-3-pure-filter
    content: "Phase 3 — Pure filter helper. NEW `filterToolSchemaByBundle(params: { tools: readonly AnyAgentTool[]; bundles: readonly BundleId[]; modelCapabilities?: { nativeWebSearchTool?: boolean }; config?: BundleSchemaFilterConfig }): { kept: readonly AnyAgentTool[]; removed: readonly { tool: string; reason: 'not_in_bundle_allowlist' | 'reverse_defense_no_native_search' }[] }`. Pure function — NEVER mutates input; returns new arrays. Two layers: (1) bundle-allowlist filter — drops tools NOT in `resolveBundleAllowedTools(bundles, config)` UNLESS `bundles.length === 0` AND `missingBundlePolicy === 'allow_all'` (legacy parity); (2) reverse-defense — when `modelCapabilities?.nativeWebSearchTool !== true` AND turn does NOT carry `public_web_lookup` bundle, drop `web_search` (closes symmetric gap of `applyModelProviderToolPolicy`). NEVER throws (#15) — unknown tool name → kept (conservative); unknown bundle id → silently treated as empty (typed-but-inert; closed enum guards). Tests fail-first (~9 cases): `bundles=[respond_only]` removes web_search + every other tool; `bundles=[public_web_lookup]` keeps web_search + web_fetch only; `bundles=[]` + `missingBundlePolicy='allow_all'` byte-identical input; `bundles=[]` + `restrict_to_default` honors `defaultAllowedTools`; reverse-defense — `bundles=[artifact_authoring] modelCapabilities.nativeWebSearchTool=false` removes web_search even if it slipped in; reverse-defense — `bundles=[public_web_lookup] modelCapabilities.nativeWebSearchTool=false` KEEPS web_search (bundle wins); idempotency — `filter(filter(x))===filter(x)`; non-mutation; unknown tool name kept."
    status: completed
  - id: bundle-contract-phase-4-attempt-wiring
    content: "Phase 4 — Wiring at `attempt.ts:1915`. Thread `toolBundles?: readonly BundleId[]` from `AttemptParams` into the `createOpenClawCodingTools(...)` call site. Order-of-operations at `attempt.ts:1915-1971`: (i) construct full tool catalog via `createOpenClawCodingTools(...)` — UNCHANGED; (ii) apply existing `applyMessageProviderToolPolicy(...)` — UNCHANGED; (iii) apply existing `applyModelProviderToolPolicy(...)` — UNCHANGED; (iv) **NEW** apply `filterToolSchemaByBundle(...)` last; (v) feed result into LLM. Existing two filters are UNCHANGED — Phase 5's reverse-defense is the symmetric defense layer, NOT a refactor of `applyModelProviderToolPolicy`. Adapter glue: trace `SemanticIntent.resolutionContract.toolBundles` from runtime adapter through `runEmbeddedAttempt` params; Phase 1 audit identifies the hop chain (likely `agent-runner-execution.ts` / `pi-embedded-runner` orchestration). When `toolBundles` undefined or empty AND `missingBundlePolicy='allow_all'` → byte-identical to today (regression guard). Tests fail-first (~6 cases): regression — caller without `toolBundles` byte-identical tools; positive — `bundles=[respond_only]` reaches LLM with empty tool array; positive — `bundles=[public_web_lookup]` keeps web_search+web_fetch only; reverse-defense layered atop existing filters — model `claude-opus-4.6` (`nativeWebSearchTool=false`) + `bundles=[respond_only]` produces zero tools AND telemetry records `web_search removed` for both reasons (bundle + reverse-defense); replay of turn `355ae135` shape (`bundles=[respond_only] requestedTools=[]`) produces empty tool schema; commands-system-prompt path UNCHANGED (separate caller, separate scope)."
    status: completed
  - id: bundle-contract-phase-5-reverse-defense
    content: "Phase 5 — Reverse defense (symmetric to `applyModelProviderToolPolicy`). Already specified inside Phase 3's filter; Phase 5 acceptance is integration-level: prove that the reverse-defense layer fires INDEPENDENT of bundle-allowlist for the case where a future regression re-introduces `web_search` into the catalog AND a non-native-search model is selected. Phase 5 ALSO documents the explicit non-goal: `applyModelProviderToolPolicy` is NOT modified — its native-search-removes-DDG semantics retained verbatim. Tests (~3 cases): adversarial — manually inject `web_search` post-`applyModelProviderToolPolicy` (simulating future-regression catalog drift) + `bundles=[artifact_authoring]` + `nativeWebSearchTool=false` → reverse-defense removes it; `bundles=[public_web_lookup]` + `nativeWebSearchTool=false` → reverse-defense KEEPS web_search (bundle authority wins; this is the legitimate DDG-search path); `bundles=[public_web_lookup]` + `nativeWebSearchTool=true` (grok-4) → existing `applyModelProviderToolPolicy` already removed web_search before reverse-defense ran; reverse-defense is a no-op (no double-fire telemetry)."
    status: completed
  - id: bundle-contract-phase-6-telemetry-and-acceptance
    content: "Phase 6 — Telemetry + end-to-end acceptance. NEW log line at filter exit: `[bundle-filter] turnId=<...> bundles=[<...>] removed_tools=[<name>:<reason>,...] kept_tools=[<...>]`. Emit at `info` level when removals > 0; at `debug` when zero removals. NEW `src/agents/__tests__/bundle-schema-filter.acceptance.test.ts` (~5 cases): (1) **`355ae135` reproduction** — replay gateway-grok-route.log 2026-05-02 turn fixture (`bundles=[respond_only] requestedTools=[] model=claude-opus-4.6`); assert: tool schema reaching LLM is empty; assert log line emitted with `removed_tools` containing `web_search:not_in_bundle_allowlist`; assert NO `Provider finish_reason: error` (downstream coupling proxy: assert `web_search` absent from request payload). (2) **Reverse — pre-Phase-4 absence-of-fix mode** — same fixture WITHOUT new filter wired → tools list contains `web_search` (proves regression-guard direction). (3) **`public_web_lookup` happy path** — `bundles=[public_web_lookup] model=grok-4` → `applyModelProviderToolPolicy` removes DDG (existing); `applyModelProviderToolPolicy` order preserved; no double-removal. (4) **Composer combo** — `bundles=[artifact_authoring,public_web_lookup] model=opus-4.6` → kept tools = {pdf, docx, image_generate, apply_patch, web_search, web_fetch}; reverse-defense not fired (bundle present). (5) **Heartbeat-class regression guard** — `bundles=[]` + missing-policy=`allow_all` → byte-identical legacy catalog; PR-#126 sub-plan §8 row 1 concern explicitly addressed."
    status: completed
  - id: bundle-contract-phase-7-runbook-and-master
    content: "Phase 7 — Live-verify runbook + sub-plan flip + master plan entry. (a) NEW `extensions/RUNBOOK-bundle-as-contract.md` (write target; this sub-plan reads-only sketches the structure): operator restart + 3 live turns covering `respond_only`, `public_web_lookup`, `artifact_authoring`; expected `[bundle-filter]` telemetry per turn; rollback procedure (set `missingBundlePolicy='allow_all'` + drop new filter from chain — restores advisory semantics). (b) Master §0.5.1 row 'Tool exposure согласована с model capability и bundle-контрактом' flips from open to CLOSED with this sub-plan path. (c) Frontmatter `status: closed` after live-verify green on dev `c1294b0f71`+. (d) `commitment_kernel_search_composer_pipeline.plan.md` §8 row 1 — bug entry resolved; cross-link added. (e) `orchestrator_web_search_capability_routing.plan.md` §8 row 1 — H2 architectural deferral resolved; cross-link added."
    status: completed
isProject: false
---

# Bundle-as-contract enforcement at LLM schema layer

## 0. Provenance & Context

| Field | Value |
| --- | --- |
| Sub-plan of | `.cursor/plans/commitment_kernel_v1_master.plan.md` (§0.5.1 row 'Tool exposure...'; §8 deferred 'bundle-as-contract') |
| Inherits | 16 hard invariants from `.cursor/rules/commitment-kernel-invariants.mdc` |
| Predecessor | dev SHA `c1294b0f71` (post handoff PR-#285) |
| Sister gaps | NEW-A modality-aware routing (`commitment_kernel_modality_aware_routing.plan.md`) — closes the *capability-vs-modality* sister gap; bundle-as-contract closes the *capability-vs-bundle* gap on the SAME architectural axis (schema-layer enforcement of structural data). Search-Composer pipeline (`commitment_kernel_search_composer_pipeline.plan.md`) — established the precedent of tool-schema gating in the composer dispatch path; this slice generalises that precedent to ALL bundle classes. Slice B (PR-#125+#126 narrow `public_web_lookup` gate at `route-preflight.ts:797`) — narrow routing-side gate; this slice adds the schema-side enforcement layer that the routing-side gate cannot reach. Prior `applyModelProviderToolPolicy` (`pi-tools.ts:94-104`) — single-direction capability filter; this slice adds the symmetric reverse-defense AND the bundle-driven layer above it. |
| Trigger | Live evidence: `gateway-grok-route.log` 2026-05-02 turn `355ae135` — classifier mis-emit `bundles=[respond_only] requestedTools=[]` → autonomous `web_search` → DDG bot-detection → `Provider finish_reason: error`. Today the bundle is advisory metadata; the LLM tool schema is not gated by it. |
| Out of scope | Per-provider hacks (e.g. "ban DDG-tool when provider=hydra"); `openclaw.json` wholesale overwrite; revert of Slice E / F / I behaviour; modifications to `src/platform/commitment/` source (frozen layer additive only); widening `ResolutionToolBundleSchema` enum (closed; widening requires separate signoff); modifying `applyModelProviderToolPolicy` semantics (Phase 5 is symmetric defense, NOT refactor); concurrent / multi-tenant turn pipeline (`pr-mt-broker-future`); IntentContractor `freshness` constraint (deferred to `commitment_kernel_intent_contractor_freshness.plan.md`). |
| Maintainer signoff | GRANTED via blanket authorization 2026-05-05 ("until orchestrator demos green"). |

## 1. Symptom + Root Cause

### 1.1. Concrete symptom

Live `gateway-grok-route.log` 2026-05-02 turn `355ae135`:

- Classifier emits `resolutionContract.toolBundles = ["respond_only"]` AND `requestedTools = []`.
- `route-preflight.ts:849` gate: `requestedTools.includes("web_search") || toolBundles.includes("public_web_lookup")` — BOTH false → no native-search promotion.
- `attempt.ts:1915` builds tool catalog via `createOpenClawCodingTools(...)` WITHOUT bundle parameter → `web_search` (DDG-backed) STAYS in schema.
- `applyModelProviderToolPolicy` removes `web_search` ONLY for `nativeWebSearchTool=true` models; selected model is `claude-opus-4.6` → tool kept.
- LLM, seeing `web_search` in schema, autonomously calls it (model heuristic; turn text mentions current event).
- DDG returns bot-detection HTML → tool error → `Provider finish_reason: error`.

### 1.2. Architectural root cause

Bundle is currently *advisory metadata* — consumed by `route-preflight.ts:847` (narrow gate), `web-evidence-prefetch.ts` (composer hook), `recipe/planner.ts` (planning hint) — but is **never** a hard schema-layer filter on the tool catalog reaching the LLM. The single capability filter (`applyModelProviderToolPolicy`) is asymmetric: removes DDG `web_search` for native-search models; does NOT remove it for non-native-search models (the inverse defence).

Result: classifier mis-emit of `bundles=[respond_only]` with no compensating routing signal exposes the full tool catalog to a model that will autonomously misuse it.

## 2. Hard invariants this slice keeps

- **#1** `ExecutionCommitment` tool-free — slice operates on LLM tool schema (orchestration layer), NOT on commitment shape.
- **#2** Affordance selection unchanged — slice gates tool-EXPOSURE, not affordance selection.
- **#3, #4** Production success / state-after observers unchanged.
- **#5** NO phrase / text-rule matching on `UserPrompt` / `RawUserTurn`. Bundle is structural enum (closed Zod schema in `resolution-contract.ts:12`), NOT text-derived.
- **#6** `IntentContractor` remains sole sanctioned `RawUserTurn` reader. Bundle filter operates STRICTLY on structural-data layer DOWNSTREAM of contractor — reads `ResolutionContract.toolBundles` (already structural) + `ModelCompatConfig` (already structural).
- **#7** `ShadowBuilder` accepts `SemanticIntent` only — unchanged.
- **#8** Bundle filter lives in `src/agents/bundle-schema-filter.ts` (orchestration / adapter layer). Does NOT cross from `src/platform/decision/` into `src/platform/commitment/`. Re-exports `BundleId` from `src/platform/decision/resolution-contract.ts` (consumer direction allowed; producer direction NOT inverted).
- **#9** `DonePredicate` untouched.
- **#10** `DonePredicate`-on-`Affordance` invariant untouched.
- **#11** 5 frozen contracts BYTE-IDENTICAL. `ResolutionContract.toolBundles` enum is the source of truth — slice consumes verbatim, NEVER widens. `BundleId` type is RE-EXPORT of `ResolutionToolBundle` (single source of truth).
- **#12** No emergency phrase patches.
- **#13** `terminalState` ⊥ `acceptanceReason` untouched.
- **#14** `ShadowBuildResult` untouched.
- **#15** Filter never throws; unknown bundle id → typed-but-inert. Live-verify mandatory at Phase 7.
- **#16** `EffectFamilyId` ⊥ `EffectId` preserved. `BundleId` is its own brand (re-export); no cross-conversion.

## 3. Architecture sketch

### 3.1. New `BundleSchemaFilter` policy

Location: `src/agents/bundle-schema-filter.ts` (NEW).

Public surface:
- `type BundleId = ResolutionToolBundle` (re-export — single source of truth).
- `type BundleAllowedToolSet = ReadonlySet<string>`.
- `interface BundleSchemaFilterConfig`.
- `const DEFAULT_BUNDLE_ALLOWED_TOOLS: ReadonlyMap<BundleId, BundleAllowedToolSet>` (frozen; closed).
- `function resolveBundleAllowedTools(bundles, config): BundleAllowedToolSet` (pure).
- `function filterToolSchemaByBundle({tools, bundles, modelCapabilities, config}): {kept, removed}` (pure; never throws).

### 3.2. Wiring at `attempt.ts:1915`

Order at the schema-construction site:

1. `createOpenClawCodingTools(...)` — full catalog (UNCHANGED).
2. `applyMessageProviderToolPolicy(...)` — message-provider deny-list (UNCHANGED).
3. `applyModelProviderToolPolicy(...)` — native-search removes DDG (UNCHANGED).
4. **NEW** `filterToolSchemaByBundle({tools, bundles: params.toolBundles, modelCapabilities})` — bundle allowlist + reverse-defense.
5. Result fed to LLM.

### 3.3. Closed bundle → allowed-tool mapping (initial)

| Bundle | Allowed tools |
|---|---|
| `respond_only` | (empty) |
| `public_web_lookup` | `web_search`, `web_fetch` |
| `interactive_browser` | `browser_*` |
| `document_extraction` | `pdf_extract`, `docx_extract` |
| `artifact_authoring` | `pdf`, `docx`, `image_generate`, `apply_patch` |
| `external_delivery` | `delivery_*` |
| `session_orchestration` | `session_*` |
| `repo_run` | `exec`, `apply_patch` |
| `repo_mutation` | `exec`, `apply_patch`, `git_*` |

Mapping closed; widening requires separate signoff (per §5 out-of-scope).

### 3.4. Reverse defense

Symmetric to `applyModelProviderToolPolicy`: when `modelCapabilities.nativeWebSearchTool !== true` AND turn does NOT carry `public_web_lookup` bundle, `web_search` removed regardless of how it slipped through previous filters. `applyModelProviderToolPolicy` is NOT modified — reverse-defense lives in the new filter as a defense-in-depth layer.

### 3.5. Telemetry

`[bundle-filter] turnId=<...> bundles=[<...>] removed_tools=[<name>:<reason>,...] kept_tools=[<...>]`

Emitted at `info` when removals > 0; at `debug` otherwise. Reasons: `not_in_bundle_allowlist`, `reverse_defense_no_native_search`.

## 4. Phase-by-phase TODOs

See frontmatter `todos:` array. Seven phases:

1. **Phase 1 — Audit (read-only)**: enumerate bundle types, advisory consumers, schema-construction sites, capability-filter semantics, behaviour-change risk classes. Output `extensions/AUDIT-bundle-as-contract.md`.
2. **Phase 2 — Types**: `BundleId` (re-export), `BundleAllowedToolSet`, `BundleSchemaFilterConfig`, Zod schemas, `DEFAULT_BUNDLE_ALLOWED_TOOLS` closed map, `resolveBundleAllowedTools(...)` pure helper.
3. **Phase 3 — Pure filter**: `filterToolSchemaByBundle(...)` with two layers (bundle allowlist + reverse defense); never-throws; closed failure set; ~9 fail-first cases.
4. **Phase 4 — Wiring at `attempt.ts:1915`**: thread `toolBundles` from runtime adapter into attempt params; layer new filter atop existing two filters; regression-guard via `missingBundlePolicy='allow_all'` for empty bundles array.
5. **Phase 5 — Reverse defense**: integration-level proof that reverse defence fires independently of bundle allowlist; `applyModelProviderToolPolicy` UNCHANGED (explicit non-goal).
6. **Phase 6 — Telemetry + acceptance**: `[bundle-filter]` log line; `bundle-schema-filter.acceptance.test.ts` replays `355ae135` symptom + 4 reverse / happy-path cases.
7. **Phase 7 — Runbook + flip**: `extensions/RUNBOOK-bundle-as-contract.md`; master plan §0.5.1 row flips closed; cross-links to Search-Composer §8 and capability-routing §8 added; sub-plan `status: closed`.

## 5. Out of scope (explicit)

- Per-provider hacks (e.g. provider-string blocklists) — fix MUST be capability-driven and structural.
- `openclaw.json` wholesale overwrite — slice touches code only.
- Revert of Slice E (`<memory>`), Slice F (`<active_tasks>`), Slice I (sanitizer) — orthogonal.
- Frozen layer (`src/platform/commitment/`) source changes — additive consumers only; `BundleId` is RE-EXPORT.
- Widening `ResolutionToolBundleSchema` enum — closed; widening requires separate signoff and dedicated sub-plan.
- Modifying `applyModelProviderToolPolicy` (`pi-tools.ts:94-104`) — Phase 5 is SYMMETRIC defense, NOT refactor of the existing filter.
- IntentContractor `freshness` / `recency` constraint extension — covered by `commitment_kernel_intent_contractor_freshness.plan.md`.
- Concurrent / multi-tenant turn pipeline — `pr-mt-broker-future` in roadmap.
- Live-verify replay automation in CI — manual operator runbook only at Phase 7.

## 6. Handoff Log

| Date | Phase | PR | Merge SHA | Notes |
| --- | --- | --- | --- | --- |
| 2026-05-06 | Sub-plan landing | [#286](https://github.com/Primus-max/god-mode-core/pull/286) | `6a2dac5911` | Sub-plan written + master plan §8 deferred-row pointer; signoff GRANTED via blanket authorization. |
| 2026-05-06 | Phase 1 — Audit | [#287](https://github.com/Primus-max/god-mode-core/pull/287) | `559628d458` | `extensions/AUDIT-bundle-as-contract.md` — schema construction site at `attempt.ts:2004` (line drifted from `:1915` cited in sub-plan); 9 closed `ResolutionToolBundle` enum values + 6 advisory consumers + reverse-defense gap documented. NO source changes. |
| 2026-05-06 | Phase 2 — Types + closed mapping | [#288](https://github.com/Primus-max/god-mode-core/pull/288) | `8b3fbc240f` | `src/agents/bundle-schema-filter.ts` — `BundleSchemaFilterConfig` + `DEFAULT_BUNDLE_ALLOWED_TOOLS` (covers all 9 enum values; `Object.isFrozen` + closed-shape reverse-test) + `resolveBundleAllowedTools` pure helper + Zod `BundleSchemaFilterConfigSchema.strict()`. `BundleId` re-export of `ResolutionToolBundle` — invariant #11 preserved. |
| 2026-05-06 | Phase 3 — Pure filter | [#289](https://github.com/Primus-max/god-mode-core/pull/289) | `82be6c031b` | `filterToolSchemaByBundle` two-layer (bundle-allowlist + reverse-defense); never throws (#15); pure (never mutates input); idempotent. ~9 fail-first cases. |
| 2026-05-06 | Phase 4 — Wiring at attempt.ts | [#290](https://github.com/Primus-max/god-mode-core/pull/290) | `4df9c1489c` | `applyBundleSchemaFilterAtAttempt` adapter at `attempt.ts:2074-2087` (was `:1915` per sub-plan; drift due to PR-#145 / Search-Composer landings) AFTER `applyModelProviderToolPolicy` and BEFORE `disableWebSearchTool` / `sanitizeToolsForGoogle`. Empty `toolBundles` → byte-identical pass-through via `missingBundlePolicy: 'allow_all'`. |
| 2026-05-06 | Phase 5 — Reverse-defense integration | [#291](https://github.com/Primus-max/god-mode-core/pull/291) | `781091972d` | Adversarial post-`applyModelProviderToolPolicy` `web_search` re-injection caught when `nativeWebSearchTool=false` AND no `public_web_lookup` bundle. `applyModelProviderToolPolicy` UNCHANGED — explicit non-goal documented. |
| 2026-05-06 | Phase 6 — Telemetry + acceptance | [#292](https://github.com/Primus-max/god-mode-core/pull/292) | `8384eb8e98` | `[bundle-filter] turnId=<id> bundles=[<...>] removed_tools=[<name>:<reason>,...] kept_tools=[<...>]` log line at filter exit; `info` when removals > 0, `debug` otherwise; defensive try/catch (#15). `bundle-schema-filter.acceptance.test.ts` replays 355ae135 fixture — empty tool schema asserted + `web_search:not_in_bundle_allowlist` asserted. |
| 2026-05-07 | Phase 7 — Runbook + closure | (this PR) | `<final-sha>` | `extensions/RUNBOOK-bundle-as-contract.md` operator runbook (3-turn live-verify covering `respond_only` / `public_web_lookup` / `artifact_authoring`); sub-plan frontmatter flipped to `status: completed` + 7 todos `completed`; master plan §0 PR Progress Log row appended; master §0.5.1 row "Tool exposure согласована..." closure cell flipped to CLOSED; cross-links added to `commitment_kernel_search_composer_pipeline.plan.md` §8 row 1 + `orchestrator_web_search_capability_routing.plan.md` §8 row 1. **Frozen-layer integrity preserved across all 7 phases**: `src/platform/commitment/**` UNTOUCHED; 5 frozen contracts BYTE-IDENTICAL (concat sha256 `75f926ef25f057f006ae9f48cd0eb624c392feea3206f6990e013df2cf23d25e`). 16 invariants preserved. **Slice CLOSED.** |

## 7. Test plan

Fail-first per phase; no `vi.spyOn` on function under test.

- **Phase 1**: audit md only.
- **Phase 2**: ~6 cases — schema round-trip; reject unknown bundle id; closed-shape coverage of all 9 bundles; `resolveBundleAllowedTools` purity; union semantics; empty-bundles policy.
- **Phase 3**: ~9 cases — `respond_only` empties tool list; `public_web_lookup` keeps web_search/web_fetch only; empty bundles + `allow_all` byte-identical; empty bundles + `restrict_to_default` honored; reverse-defense fires for non-native-search model; reverse-defense bypassed when `public_web_lookup` present; idempotency; non-mutation; unknown tool name kept.
- **Phase 4**: ~6 cases — regression byte-identical when `toolBundles=undefined`; `bundles=[respond_only]` reaches LLM with empty tools; `bundles=[public_web_lookup]` keeps web_search+web_fetch only; reverse-defense layered atop existing filters; `355ae135` shape replay produces empty schema; commands-system-prompt path UNCHANGED.
- **Phase 5**: ~3 cases — adversarial post-`applyModelProviderToolPolicy` injection caught; `public_web_lookup` + non-native KEEPS web_search; native-search idempotent (no double-fire).
- **Phase 6 (acceptance)**: ~5 cases including the `355ae135` live-fixture replay (assert empty tool schema; assert telemetry line; assert no `Provider finish_reason: error`).
- **Phase 7**: live-verify (3 turns covering `respond_only` / `public_web_lookup` / `artifact_authoring`); rollback procedure validated.

Log-line evidence:
- `[bundle-filter] turnId=<...> bundles=[<...>] removed_tools=[<name>:<reason>,...] kept_tools=[<...>]`
- Reverse-defense fire: `[bundle-filter] reverse_defense_no_native_search removed=web_search model=<id>`

## 8. Live-verify runbook gist

Phase 7 deliverable. Future write target: `extensions/RUNBOOK-bundle-as-contract.md`.

Sketch:
1. Restart gateway on dev `c1294b0f71`+ with new filter wired.
2. Live turn 1 — chit-chat ("hi, how are you") — expect `bundles=[respond_only]`, `[bundle-filter] removed_tools=[<all-non-respond-tools>:not_in_bundle_allowlist]`, kept=[].
3. Live turn 2 — current-event query routed via `public_web_lookup` — expect `kept_tools=[web_search,web_fetch]`; if `nativeWebSearchTool=true` selected (grok-4) → existing `applyModelProviderToolPolicy` already removed DDG; bundle filter no-op on it.
4. Live turn 3 — `artifact_authoring` PDF combo turn — expect `kept_tools=[pdf,docx,image_generate,apply_patch]`; reverse-defense removes any stray `web_search`.
5. Reverse — same test set with new filter dropped from chain → tools list legacy-shape; proves filter is the sole gate.
6. Rollback: set `missingBundlePolicy='allow_all'` AND drop filter from `attempt.ts:1915` chain — restores advisory semantics. Master row reverts.

## 9. Maintainer signoff

GRANTED via blanket authorization 2026-05-05.

## 10. References

- Master plan §0.5.1 row 'Tool exposure...'; §0.5/§8 deferred bundle-as-contract entry.
- Hard invariants `.cursor/rules/commitment-kernel-invariants.mdc`.
- `commitment_kernel_intent_contractor_freshness.plan.md` (sister sub-plan; just CLOSED).
- `commitment_kernel_search_composer_pipeline.plan.md` (tool-schema gating precedent; §8 row 1 cross-resolves).
- `commitment_kernel_modality_aware_routing.plan.md` (NEW-A — sister-axis capability gap; closes capability-vs-modality side).
- `orchestrator_web_search_capability_routing.plan.md` (Slice B — narrow PR-#125+#126 routing-side gate; §8 row 1 cross-resolves).
- `src/platform/decision/resolution-contract.ts:12-23` — closed `ResolutionToolBundleSchema` enum.
- `src/agents/pi-embedded-runner/run/attempt.ts:1915-1971` — schema-construction site.
- `src/agents/pi-tools.ts:94-104` — `applyModelProviderToolPolicy` (sister filter).
- `src/platform/decision/route-preflight.ts:797,847-865` — narrow routing-side gate.
- `src/platform/decision/web-evidence-prefetch.ts` — Search-Composer pre-orchestrator hook.
- Live evidence: `gateway-grok-route.log` 2026-05-02 turn `355ae135`.
