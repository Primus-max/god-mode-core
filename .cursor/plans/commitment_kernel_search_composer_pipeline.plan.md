---
name: Search-Composer Pipeline — specialist-search worker + composer agent через AffordanceRegistry
overview: |
  Архитектурный slice (signoff required) поверх master plan §16 (умный оркестратор) + §0.5.2 G6.c (full PolicyGate) + §8.5.1 (cutover-3 artifact authoring).

  Цель: turn'ы, которым нужны актуальные веб-данные, проходят через **specialist worker** (Perplexity Sonar / Sonar Pro — search-only модели, у которых рабочий native search через Hydra) → результаты search'а попадают как **structured evidence** в **composer agent** (Claude Opus 4.6 / GPT-5.4 — модели, умеющие в function-tools и multimodal authoring), который собирает финальный артефакт (PDF / structured response).

  Это закрывает корневую проблему, которую обнажил PR-#126 + sonar-promotion live test (2026-05-02 turn `af38758f`):
  - Search-specialty модели (sonar, sonar-pro) НЕ принимают arbitrary function-tool schemas → HTTP 400 на combo turn'ах вида `bundles=[artifact_authoring, public_web_lookup]`.
  - Composer-class модели (opus 4.6, gpt-5.4) умеют в tools, но через Hydra `openai-completions` schema у них НЕТ native web_search; локальный DDG fallback регулярно падает в bot-detection (turn `355ae135` — `Provider finish_reason: error`).
  - Никакой одной модели в текущем catalog'е НЕТ, которая одновременно умеет в swap-search И в multimodal artifact authoring через Hydra-прокси.

  Решение: специализация по effect family + tie-break по affordance preconditions. Это полностью укладывается в hard invariants (commitment-kernel framework уже описан в master §6 / §8 / §16).

  EXPLICITLY OUT OF SCOPE этого slice'а:
  - Параллельные turn-pipeline'ы (это `pr-mt-broker-future` в roadmap §6 row 4).
  - Bundle-as-contract enforcement at the LLM schema layer (deferred §8 row 1 в `orchestrator_web_search_capability_routing.plan.md`).
  - IntentContractor `freshness` / `recency` constraint extension (deferred §8 row 2 там же).

  Maintainer signoff REQUIRED (invariant #15):
  - Slice вводит новый effect family (`web_research`) → master §13 effect-family registry extension.
  - Slice вводит две новые Affordance в `affordance-registry.ts` → branching factor canary > 1 на этой семье.
  - Slice расширяет PolicyGate с `web_research`-specific reasons (`needs_web_search_specialist`, `composer_unavailable`).

audit_gaps_closed: ["G6.c (partial — web_research effect family + affordances; full PolicyGate completion остаётся за рамками)"]

todos:
  - id: signoff-and-branch
    order: 1
    status: pending
    signoff: required
    content: |
      Maintainer signoff (Vladimir) на ВСЕ ниже изложенные дизайн-решения ДО первой строки кода. Это invariant #15 — architectural shift.
      Branch: `feat/orchestrator-search-composer-pipeline` от свежего `origin/dev`.

  - id: phase1-effect-family-registry
    order: 2
    status: pending
    signoff: required
    content: |
      **Phase 1 — Effect family `web_research`.**

      Edit `src/platform/commitment/effect-family-registry.ts` (или эквивалент per master §13.4):
      - Add new EffectFamily entry: `id: "web_research"`, `allowedOperationKinds: ["create"]`, `branchingHints: ["search_specialist", "search_then_composer"]`.
      - Add new EffectId: `web_evidence.collected` (operation=`create`, target=`evidence_record`).
      - Add new EffectId: `web_research.summarized` (operation=`create`, target=`document` | `text_response`) — composed final artifact.

      Contracts touched:
      - `EffectFamilyId` union extended (closed-string union; freezing constant + reverse-test).
      - NOT touching 5 frozen decision contracts (`TaskContract` / `OutcomeContract` / `QualificationExecutionContract` / `ResolutionContract` / `RecipeRoutingHints`). New effect family lives in commitment-kernel layer per invariant #11.

      Reverse-test: `effect-family-registry.test.ts` — `Object.isFrozen(EFFECT_FAMILY_REGISTRY)` + `push throws`; новый `web_research` присутствует ровно один раз.

  - id: phase2-affordance-registry
    order: 3
    status: pending
    signoff: required
    content: |
      **Phase 2 — Two affordances under family `web_research`.**

      Edit `src/platform/commitment/affordance-registry.ts`:

      Affordance #1: `perplexity_search_specialist`:
      - effect: `web_evidence.collected`
      - target: `evidence_record`
      - preconditions: `chain_has_native_web_search_candidate` (looks up if any `ModelCandidate` in current chain matches `NATIVE_WEB_SEARCH_MODEL_IDS = {sonar, sonar-pro}`)
      - policy: `requires_external_network` (passes if no policy block on outbound HTTP)
      - budgets: `evidence_token_budget` (default 4000 tokens for SERP context)
      - donePredicate: `evidence.records.length >= 1 AND evidence.records.some(r => r.url)` (at least one cited URL — proves real search, not training-cutoff fallback)

      Affordance #2: `composer_after_search`:
      - effect: `web_research.summarized`
      - target: `document` (when `requestedEvidence` includes `pdf`) or `text_response` (otherwise)
      - preconditions: `composer_model_available` (any non-search model in chain — `claude-opus-4.6` / `gpt-5.4` / `hydra-gpt-pro` / etc.) AND `evidence.records.length >= 1` (must follow successful Affordance #1 completion)
      - policy: same as existing answer-delivery affordances
      - budgets: `composer_completion_budget` (default 8000 tokens)
      - donePredicate: existing artifact-authoring done predicate (PDF tool returned receipt, OR text_response delivered)

      Crucial: Affordance #2's precondition `evidence.records.length >= 1` makes it dependent on Affordance #1's WorldState slice — this is the **structural** way to encode "search → composer" sequencing without any orchestration-text plane (invariants #1, #2, #5).

  - id: phase3-worldstate-slice
    order: 4
    status: pending
    signoff: required
    content: |
      **Phase 3 — `WebEvidenceSlice` in WorldState.**

      Edit `src/platform/commitment/world-state.ts` (or per master §11):
      - Add `webEvidence?: { records: ReadonlyArray<{ url: string; snippet: string; title?: string; capturedAt: ISODate }> }` slice.
      - Slice population: handler for `MonitoredRuntime.observeEvidence("web_evidence.collected", record)` — appends to slice atomically per turn.
      - Reset semantics: slice cleared at turn-start; survives within-turn multi-affordance sequencing.

      WorldState read APIs for `composer_after_search.preconditions` + `donePredicate` evaluation.

  - id: phase4-runtime-wiring
    order: 5
    status: pending
    signoff: required
    content: |
      **Phase 4 — MonitoredRuntime adapter for the two-affordance run.**

      `src/agents/pi-embedded-runner/run/attempt.ts` или `src/auto-reply/reply/agent-runner.ts`:
      - When `commitmentSatisfied` evaluation chooses Affordance(`perplexity_search_specialist`):
        - Run a sonar/sonar-pro turn with **only** the user-prompt + system instruction "Return findings as structured JSON with cited URLs"; tool schema = empty (Perplexity rejects custom tools).
        - On success: parse the model's reply; populate `WebEvidenceSlice`. Emit `[commitment] effect=web_evidence.collected records=<N>` telemetry.
        - On failure (HTTP 400 / 5xx / no citations): mark Affordance #1 unsatisfied; fall through to legacy single-model path (current behaviour, no regression).
      - When Affordance(`composer_after_search`) is selected (via `findByFamily(web_research, ...)` after Affordance #1 satisfied):
        - Run a composer-class model (opus 4.6 / gpt-5.4 / etc.) with full tool schema + system message "Use the provided web evidence (cited URLs) as ground truth; do NOT call web_search yourself."
        - Inject `WebEvidenceSlice.records` into prompt as structured `<web_evidence>` block (closed-shape, not user text → invariant #5 safe).
        - Existing PDF / artifact authoring path unchanged.

      No changes to `createOpenClawCodingTools()` signature (invariant #8 safe — edit lives in `src/platform/decision` + `src/platform/commitment` + adapter glue, not crossing into `commitment/` from `decision/`).

  - id: phase5-route-preflight-rollout
    order: 6
    status: pending
    signoff: required
    content: |
      **Phase 5 — Re-enable `route-preflight` capability gate.**

      `src/platform/decision/route-preflight.ts`:
      - Populate `NATIVE_WEB_SEARCH_MODEL_IDS = new Set(["sonar", "sonar-pro"])`.
      - The existing gate (preserved as dead-code infrastructure during this slice's deferral) becomes hot again BUT only fires when:
        - `requestedTools.includes("web_search")` OR `toolBundles.includes("public_web_lookup")`
        - AND no `artifact_authoring` bundle is present (or other tool that the search-specialist cannot satisfy — exact list curated alongside Affordance #1 preconditions).
      - For combo turns (search + artifact): preflight does NOT promote sonar; the runtime adapter (Phase 4) handles them via the two-affordance sequence: Affordance #1 (sonar search) → Affordance #2 (composer pdf).

      Add closed-string reasonCode `preflight_routed_native_search` to `ModelRoutePreflightDecision.reasonCode` union (`src/platform/decision/contracts.ts`) — frozen union extension → `compatibility` PR-body checkbox required. Old `preflight_routed_grok_for_web_search` kept for backwards compat with PR-#125 / PR-#126 audit trail; deprecated in jsdoc.

  - id: phase6-policygate-extend
    order: 7
    status: pending
    signoff: required
    content: |
      **Phase 6 — PolicyGate reasons for web_research family.**

      Extends `commitment_kernel_policy_gate_full.plan.md` (G6.c). New reason-codes added to `POLICY_GATE_REASONS`:
      - `needs_web_search_specialist` — emitted when `web_research` is selected family but chain has no `NATIVE_WEB_SEARCH_MODEL_IDS` candidate.
      - `composer_unavailable` — emitted when `web_evidence.collected` is satisfied but no composer-class model is reachable (chain exhausted).
      - `web_evidence_budget_exceeded` — token budget hit during Affordance #1.

      Reverse-test: `Object.isFrozen(POLICY_GATE_REASONS)` extended; ровно три новых code присутствуют.

  - id: phase7-tests-and-eval
    order: 8
    status: pending
    signoff: required
    content: |
      **Phase 7 — Tests + decision-eval extension.**

      Unit tests:
      - `effect-family-registry.test.ts` — `web_research` entry + reverse-test.
      - `affordance-registry.test.ts` — both new affordances; `findByFamily(web_research, ...)` selection given different chain configurations + WorldState states.
      - `world-state.test.ts` — `WebEvidenceSlice` ingestion + read APIs.
      - `route-preflight.test.ts` — Phase 5 re-enabled; promotion ONLY for pure-search bundles, no-op for artifact_authoring combo.
      - `attempt.search-composer.test.ts` (new) — integration: end-to-end two-affordance run on stubbed sonar + stubbed composer; verify (a) WebEvidenceSlice populated, (b) composer prompt includes `<web_evidence>` block, (c) composer does NOT see web_search tool in schema.

      Decision-eval (`scripts/dev/task-contract-eval/`):
      - New synthetic case set `cutover3-search-composer.jsonl` covering: pure-search turn, search+pdf combo, search-with-no-results-fallback, classifier-mis-emit case (turn-class `355ae135`).
      - Quant gate metric: `search_composer_branching_factor` ≥ 1.0 on combo turns.

  - id: phase8-handoff-and-master-rows
    order: 9
    status: pending
    signoff: required
    content: |
      **Phase 8 — Handoff + master plan rows.**

      After merge:
      - Master §0 PR Progress Log row: `Search-Composer Pipeline — web_research effect family + 2 affordances + WorldState slice + runtime two-affordance sequencer + PolicyGate web_research reasons`.
      - Master §0.5.1 audit findings row "tool exposure ↔ model capability gating" — mark closed; reference this slice's merge SHA.
      - Master §13 effect-family registry — new entry documented.
      - Roadmap §6 Handoff Log row.
      - Sub-plan `commitment_kernel_policy_gate_full.plan.md` — G6.c partially closed (web_research reasons added; rest of full PolicyGate still pending).

isProject: false
---

# Search-Composer Pipeline — specialist-search worker + composer agent через AffordanceRegistry

## 0. Provenance

| Field | Value |
| --- | --- |
| Sub-plan of | `.cursor/plans/commitment_kernel_v1_master.plan.md` (§13 effect-family registry, §16 умный оркестратор vision, §0.5.2 G6.c, §8.5.1 cutover-3) |
| Inherits | 16 hard invariants — unchanged. New `EffectFamilyId.web_research` is a closed-string extension; doesn't violate #16 (distinct branded type from `EffectId`). |
| Trigger | Live evidence: PR-#126 (`e7da04fb3e`) + sonar-promotion follow-up (`3b366481cf`) revealed that NO single Hydra-proxied model handles combo turns (`bundles=[artifact_authoring, public_web_lookup]`). Sonar-pro returns HTTP 400 on tool schema; opus/gpt have no native web_search through Hydra → fall back to local DDG → bot-detection. Existing routing is structurally unable to close turn-class `355ae135`. |
| Target branch | `feat/orchestrator-search-composer-pipeline` off latest `origin/dev`. |
| Maintainer signoff | **REQUIRED** (invariant #15) — architectural shift: new effect family + 2 affordances + WorldState slice + runtime adapter. |

## 1. Hard invariants this slice MUST keep

| # | Invariant | How not to break |
| --- | --- | --- |
| 1 | `ExecutionCommitment` is tool-free | New affordances live in `commitment/`; no tool/recipe/route fields added to `ExecutionCommitment`. |
| 2 | `Affordance` selected by (effect + target + preconditions + policy + budgets) | The two new affordances follow this exactly; no `recipeId` / `model_hint` shortcut. |
| 3 | Production success requires `commitmentSatisfied(...) === true` | Both affordances have explicit `donePredicate`s evaluated against WorldState. |
| 4 | Success requires at least one observed state-after fact | Affordance #1 produces `WebEvidenceSlice.records[*]`; Affordance #2 produces an artifact / text_response receipt. |
| 5 | No phrase / text-rule matching on UserPrompt outside whitelist | Composer's `<web_evidence>` injection is structural (closed-shape JSON-like records), not user text. |
| 6 | `IntentContractor` is the sole reader of raw user text | Sonar specialist does NOT read user text via prompts — it receives the **commitment-derived query** (closed-shape record from `IntentContractor`'s output). |
| 7 | `ShadowBuilder` accepts `SemanticIntent` only | Untouched. |
| 8 | `commitment/` does not import from `decision/` | Edit splits cleanly: effect-family + affordances + WorldState in `commitment/`; route-preflight + reasonCode in `decision/`; runtime adapter in `agents/pi-embedded-runner/` (allowed to import both). |
| 9 | `DonePredicate` sees state/delta/receipts/trace only | Both new predicates follow this; no raw text. |
| 10 | `DonePredicate` lives on `Affordance` | Both predicates declared on the affordance entries. |
| 11 | 5 legacy decision contracts frozen | `TaskContract` / `OutcomeContract` / `QualificationExecutionContract` / `ResolutionContract` / `RecipeRoutingHints` untouched. New effect family + affordances are commitment-layer, not decision-layer contracts. |
| 12 | Emergency phrase / routing patches require ticket + retire deadline | Not an emergency patch; structural extension. |
| 13 | `terminalState` ⊥ `acceptanceReason` | Untouched. |
| 14 | `ShadowBuildResult` typed | Untouched. |
| 15 | PR-1 / 1.5 / 2 / 3 + architectural shifts require human signoff | This slice REQUIRES signoff. |
| 16 | `EffectFamilyId` and `EffectId` distinct branded types | New `web_research` family + new `web_evidence.collected` / `web_research.summarized` effects respect distinct branded types. |

## 2. Bug repro & evidence

### 2.1. Live evidence (consolidated)

| Date | Turn | Symptom | Root cause | Reference |
| --- | --- | --- | --- | --- |
| 2026-05-02 | `355ae135` | Provider finish_reason: error after autonomous web_search hits DDG bot-detection | claude-opus-4.6 has no native search via Hydra; DDG fallback fails | `gateway-grok-route.log` line 157 |
| 2026-05-02 | `efcc1476` | Degraded reply (PDF without web data) — model emits partial reply after 3× DDG bot-detection failures | Same as above; classifier emitted `bundles=[respond_only] requestedTools=[]`, model called web_search anyway | `gateway-grok-route.log` lines 92–122 |
| 2026-05-02 | `098ad94d` | Successful PDF generation BUT with content marked "v1.0 · Июль 2025" — training-cutoff knowledge instead of fresh data | grok-4 was wrongly marked `nativeWebSearchTool: true` by PR-#125; live test confirmed grok-4 does not actually run xAI Live Search through Hydra | `gateway-sonar-restart.log` |
| 2026-05-02 | `af38758f` | HTTP 400 from Hydra when planner emitted `bundles=[artifact_authoring, public_web_lookup] requestedTools=[image_generate, pdf, web_search]` and route-preflight promoted sonar-pro first | Perplexity sonar-pro is search-specialty, rejects arbitrary function-tool schemas | `gateway-sonar-restart.log` |

### 2.2. Capability map (Hydra `/v1/models` audit, 2026-05-02)

| Model id | `web_search: true` flag in Hydra catalog | Accepts function-tool schema | Suitable role |
| --- | --- | --- | --- |
| `sonar` | YES | NO | Search specialist |
| `sonar-pro` | YES | NO | Search specialist (preferred — better citations in live test) |
| `claude-opus-4.6` | no | YES | Composer / artifact authoring |
| `gpt-5.4` | no | YES | Composer / artifact authoring |
| `hydra-gpt-pro` | no | YES | Composer / fallback |
| `grok-4` | no | YES | General; PR-#125 compat block was wrong, removed |
| (every other entry) | no | YES (mostly) | General |

**Conclusion:** No single model in the Hydra catalog combines reliable native web_search AND function-tool authoring. Two-affordance sequencing is the structurally correct fix.

## 3. Hypothesis

**H1 (primary):** Adding effect family `web_research` with two affordances — `perplexity_search_specialist` (reads user query commitment, emits `WebEvidenceSlice`) and `composer_after_search` (precondition: `webEvidence.records.length >= 1`; runs composer model with structural `<web_evidence>` injection) — closes turn-class `355ae135` AND `af38758f` simultaneously without violating any hard invariants. The selection logic falls out of `findByFamily(web_research, ...)` tie-break by preconditions + policy + budgets per master §16.

**H2 (rejected by Phase 1 audit, kept for completeness):** A single multimodal model that does both search AND artifact authoring would simplify routing. **Refuted** by Hydra `/v1/models` 2026-05-02 evidence — no such model is currently advertised on this proxy.

**H3 (deferred, not in this slice):** A bundle-as-contract enforcement at the LLM schema layer would gate `web_search` tool exposure per planner output. Deferred per `orchestrator_web_search_capability_routing.plan.md` §8 row 1 — orthogonal to this slice (this slice handles the case where the planner correctly emits `public_web_lookup`; H3 handles the case where the planner mis-emits `respond_only`).

## 4. Scope-of-fix matrix

| # | Layer | File | Change | LOC est. | Invariant |
| --- | --- | --- | --- | --- | --- |
| 1 | Effect family registry | `src/platform/commitment/effect-family-registry.ts` | New `web_research` entry + 2 new EffectIds | ~30 | #11, #16 |
| 2 | Affordance registry | `src/platform/commitment/affordance-registry.ts` | 2 new affordances (perplexity_search_specialist + composer_after_search) | ~120 | #2, #9, #10 |
| 3 | WorldState | `src/platform/commitment/world-state.ts` | `WebEvidenceSlice` + ingestion + read APIs | ~80 | #4 |
| 4 | Runtime adapter | `src/agents/pi-embedded-runner/run/attempt.ts` (or new helper file) | Two-affordance sequencer; populate WebEvidenceSlice from sonar reply; inject `<web_evidence>` into composer prompt | ~150 | #5, #6, #8 |
| 5 | Route preflight | `src/platform/decision/route-preflight.ts` | Populate `NATIVE_WEB_SEARCH_MODEL_IDS`; gate fires only for pure-search bundles | ~30 | — |
| 6 | Decision contract | `src/platform/decision/contracts.ts` | Add reasonCode `preflight_routed_native_search` (closed-string union extension) | ~5 | #11 (frozen union → compatibility checkbox) |
| 7 | PolicyGate | `commitment_kernel_policy_gate_full.plan.md` rows | 3 new reasons | ~30 | G6.c partial |
| 8 | Tests | various | Per Phase 7 | ~400 | — |
| 9 | Decision-eval synthetic | `scripts/dev/task-contract-eval/cutover3-search-composer.jsonl` | New case set | ~50 cases | — |

**Total:** ~850 LOC + 50 eval cases + maintainer signoff. Frozen layer touched: `ModelRoutePreflightDecision.reasonCode` union extension (compatibility checkbox required).

## 5. Acceptance criteria

1. Combo turn `bundles=[artifact_authoring, public_web_lookup] requestedTools=[pdf, web_search]` runs as: Affordance(perplexity_search_specialist) on sonar-pro → WebEvidenceSlice with ≥1 cited URL → Affordance(composer_after_search) on opus 4.6 → PDF artifact with citations matching the search records. Total turn latency budget: ≤ 60s; degrades gracefully (single-model fallback) on Affordance #1 timeout.
2. Pure-search turn `bundles=[public_web_lookup] requestedTools=[web_search]` runs as: Affordance(perplexity_search_specialist) only → text reply with citations.
3. Turn-class `355ae135` (classifier-mis-emit `bundles=[respond_only] requestedTools=[]` for a question that needs fresh data) — STILL not closed by this slice; closure deferred (see deferred §8 row 2 в `orchestrator_web_search_capability_routing.plan.md` — IntentContractor freshness constraint). Documented explicitly in handoff.
4. `pnpm tsgo` clean; new + existing tests green; decision-eval `cutover3-search-composer.jsonl` quant-gate passes.
5. Hard invariants #1–#16 unchanged. Frozen layer extension (reasonCode) carries `compatibility` PR-body checkbox.
6. WorldState `WebEvidenceSlice` per-turn isolation (no cross-turn leakage); per `(sessionId, turnId)` keying respects forward-compat constraints from roadmap §4.

## 6. Implementation notes

### 6.1. Affordance #1 prompt skeleton (sonar specialist)

Closed-shape record built from `SemanticIntent` (from `IntentContractor`):

```
{
  "user_query": <SemanticIntent.task.summary>,    // commitment-derived, NOT raw user text
  "constraints": <SemanticIntent.constraints>,    // freshness/region/etc
  "max_records": <budgets.evidence_token_budget / avg_record_size>
}
```

System message: "Respond with structured JSON: `{ records: [{ url, snippet, title }], summary }`. Each record must cite a real URL from your search."

Output validator: `webEvidenceRecordSchema.parse(...)` — Zod schema in `world-state.ts`. Failure → Affordance #1 unsatisfied.

### 6.2. Affordance #2 composer prompt injection

System message extended with structural block:

```
<web_evidence>
{ records: [...], summary: ... }
</web_evidence>

You MUST use cited URLs from `web_evidence.records` as ground truth. Do NOT call web_search yourself.
```

Tool schema for composer: full `createOpenClawCodingTools(...)` minus `web_search` (drop from set per `applyModelProviderToolPolicy`-style filter, but keyed on "web_evidence already collected" instead of model compat).

### 6.3. Sequencing without orchestration-text plane

The kernel selects affordances structurally:
1. Initial commitment for a `web_research` family turn has empty WorldState. `findByFamily(web_research)` returns Affordance #1 (only one whose preconditions are met).
2. After Affordance #1 produces `WebEvidenceSlice` with ≥1 record, kernel re-evaluates: WorldState now satisfies Affordance #2's precondition AND Affordance #1's donePredicate is true. Affordance #2 selected next.
3. After Affordance #2 produces artifact receipt, both affordances satisfied → `commitmentSatisfied = true` → terminal.

No "I just searched, now compose" text-rule. Pure structural sequencing per master §16.

## 7. Handoff Log

### 2026-05-02 — Sub-plan kickoff

- Sub-plan written (this file). Frontmatter todos in `pending` state pending maintainer signoff.
- Source evidence consolidated from: PR-#125 (`e3d8c538f8`), PR-#126 (`e7da04fb3e`), sonar-rollback (`3b366481cf`), Hydra `/v1/models` curl audit (2026-05-02), live turns `efcc1476` / `355ae135` / `098ad94d` / `af38758f`.
- `route-preflight.ts` `NATIVE_WEB_SEARCH_MODEL_IDS` set to empty (`new Set<string>()`) as the safest rollback while this slice waits for signoff. Infrastructure (gate predicate + capability lookup) preserved as dead code so Phase 5 only needs to populate the set + add the artifact-bundle exclusion clause.
- `~/.openclaw-dev/agents/dev/agent/models.json` retains `sonar` and `sonar-pro` entries with `compat: { nativeWebSearchTool: true }` — they will be consumed by Phase 5 when this slice ships.
- `~/.openclaw-dev/openclaw.json` chain retains `hydra/sonar-pro` as a fallback so the model is loadable when Phase 4 runtime adapter calls it.

### (To be filled per phase as work progresses post-signoff.)

## 8. Adjacent / deferred bugs (out of scope)

| Order | Bug | Symptom | Required scope | Why deferred |
| --- | --- | --- | --- | --- |
| 1 | Bundle-as-contract enforcement at the LLM schema layer | `bundles=[respond_only]` mis-emit case (turn `355ae135`) where model autonomously calls web_search and dies | Thread `toolBundles` through `attempt.ts:1915` into `createOpenClawCodingTools(...)` + bundle→tool allowlist | Heartbeat-class turns currently depend on bundle being advisory; full deferral covered in `orchestrator_web_search_capability_routing.plan.md` §8 row 1. Orthogonal to this slice. |
| 2 | IntentContractor `freshness` / `recency` constraint surface | Same as above, addressed from routing side | Extend `SemanticIntent.constraints` shape; route-preflight gate also fires on `intent.constraints.freshness === "current"` | Architectural addition to `SemanticIntent`; deferred per `orchestrator_web_search_capability_routing.plan.md` §8 row 2. |
| 3 | Concurrent / multi-tenant turn pipeline | Single-threaded turn-blocked processing | New broker / scheduler with concurrency limits | `pr-mt-broker-future` in roadmap §6 row 4; requires this slice + PR-G + PR-A.2 + PR-H all merged. |
| 4 | Image-search specialist (besides web_search text) | Some turns need image search (e.g. "find logos of these models") | Extend Affordance(`perplexity_search_specialist`) or new `image_search_specialist` affordance | Out of scope; pickup after this slice settles. |

## 9. References

- Master plan: `.cursor/plans/commitment_kernel_v1_master.plan.md` (§6 freeze, §11 WorldState, §13 effect-family registry, §16 умный оркестратор, §0.5.2 G6.c).
- PR-#125 baseline: merge `e3d8c538f8` (introduced `preflight_routed_grok_for_web_search` reasonCode).
- PR-#126: merge `e7da04fb3e` — broadened gate to bundle-signal + capability lookup.
- Sonar rollback: commit `3b366481cf` — replaced grok-4 with sonar/sonar-pro in NATIVE_WEB_SEARCH_MODEL_IDS; revealed combo-turn HTTP 400.
- Sub-plan rollback to dead-code: this slice's commit (TBD) — empties the set pending Phase 5 signoff.
- Hard invariants: `.cursor/rules/commitment-kernel-invariants.mdc` (16 invariants).
- Sibling sub-plans:
  - `commitment_kernel_policy_gate_full.plan.md` — G6.c partially closed by Phase 6 here.
  - `orchestrator_web_search_capability_routing.plan.md` — narrow PR-#126 sub-plan; its §8 deferred items intersect with this slice's §8.
  - `commitment_kernel_smart_orchestrator_roadmap.plan.md` — §6 Handoff Log carries this slice's row when phases progress.
- Live evidence:
  - `gateway-grok-route.log` (turns `efcc1476`, `355ae135`).
  - `gateway-sonar-restart.log` (turns `098ad94d`, `af38758f`).
  - Hydra `/v1/models` curl 2026-05-02 (sonar/sonar-pro web_search flag confirmation).

---

**Stop gate:** maintainer signoff REQUIRED before any code change beyond this sub-plan + the route-preflight rollback. Phases 1–8 each require signoff individually; this is invariant #15.
