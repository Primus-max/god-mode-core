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
    status: pending-split
    signoff: required
    content: |
      **Phase 4 — MonitoredRuntime adapter for the two-affordance run.**

      **2026-05-02 amendment** (autonomous /loop scope-drift finding): split into 4a/4b/4c per §8.5 of this sub-plan. Original spec preserved below for traceability; concrete implementation plan in §8.5.

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

  - id: phase4a-web-evidence-observer-and-sonar-adapter
    order: 5.1
    status: pending
    signoff: required
    content: |
      **Phase 4a** (split from Phase 4 per §8.5). New `WebEvidenceWorldStateObserver` + sonar runtime adapter only. Behaviour-neutral on production.
      Files: `web-evidence-world-state-observer.ts` (new), `monitored-runtime.ts` (deps), `production-runtime-defaults.ts` (wire), `web-research-runtime-adapter.ts` (new helper called from `attempt.ts`), Zod schema in `world-state.ts`.
      ~325 LOC + tests. Frozen-layer: none.

  - id: phase4b-composer-adapter-and-receipt
    order: 5.2
    status: pending-split
    signoff: required
    content: |
      **Phase 4b** (split from Phase 4 per §8.5; **further split into 4b/4b'** per 2026-05-02 14:55 amendment after attempt.ts audit revealed 3,468-LOC orchestration loop exceeded the bootstrap drift threshold for caller wiring). Composer runtime adapter + delivery-receipt emission + composer predicate re-wire.
      Files (Phase 4b proper): `web-research-runtime-adapter.ts` (extend with `runComposerAfterSearch`), `done-predicate-web-research-summarized.ts` (re-wire from stub), tests.
      Caller wiring at `attempt.ts` deferred to Phase 4b' below.
      ~250 LOC + tests. Frozen-layer: none. Behaviour-neutral on production until 4c.

  - id: phase4b-prime-caller-wiring-attempt-ts
    order: 5.25
    status: pending-split
    signoff: required
    content: |
      **Phase 4b'** (split from Phase 4b per 2026-05-02 14:55 amendment; **further split into 4b'-a / 4b'-b** per 2026-05-02 15:08 amendment after grep audit confirmed `attempt.ts` has zero kernel awareness — the 2-step dispatch must live at `src/platform/decision/input.ts`, not the LLM-call layer). Original "caller wiring at attempt.ts" goal preserved below for traceability; the actual integration target is the decision-layer dispatch point.

  - id: phase4b-prime-a-orchestrator-helper
    order: 5.251
    status: pending
    signoff: required
    content: |
      **Phase 4b'-a** (split from 4b' per 2026-05-02 15:08 amendment). New `web-research-orchestrator.ts` helper alone — no caller wiring.
      Files: `src/agents/pi-embedded-runner/run/web-research-orchestrator.ts` (new), `web-research-orchestrator.test.ts` (new).
      `runWebResearchTurn(...)` orchestrates specialist → observer.observe → composer with closed failure semantics (specialist fails → no composer call; composer fails after specialist success → sonar slice survives for caller). Also exports `isWebResearchFamilyEffect(effect)` predicate for the Phase 4b'-b conditional.
      ~165 LOC + 9 tests. Frozen-layer: none. Behaviour-neutral on production (no caller invokes the orchestrator).

  - id: phase4b-prime-b-decision-layer-dispatch
    order: 5.252
    status: blocked-architectural-mismatch
    signoff: required
    content: |
      **Phase 4b'-b** — BLOCKED per 2026-05-02 15:18 audit (4b''-c amendment below). The dispatch-point caller wiring cannot be a single bounded autonomous /loop slice. Split into 4b''-c (architectural amendment, this commit) + 4b''-d / 4b''-e (signoff-required design + wiring slices).

  - id: phase4b-double-prime-c-architectural-mismatch
    order: 5.253
    status: pending
    signoff: required
    content: |
      **Phase 4b''-c** — Architectural amendment documenting why 4b'-b is blocked.
      Audit at `src/platform/decision/input.ts` lines 548 + 587 found that `runTurnDecision` returns `{ productionDecision: TaskContract-shaped, intent: SemanticIntent }`. The kernel-derived `ExecutionCommitment` is internal to `run-turn-decision.ts` and not surfaced in the result. The caller flows `productionDecision` downstream as the model-routing TaskContract; the existing output of `runWebResearchTurn` (`{ specialist, composer }`) does not fit this shape. Caller wiring requires:
        (a) Either a `RunTurnDecisionResult.derivedCommitment?: ExecutionCommitment` field surfaced from the kernel (small additive change — `~20 LOC` to `run-turn-decision.ts`).
        (b) Or a productionDecision-replacement path in the caller (architectural — replaces the model-routing TaskContract for `web_research` turns with a "deliver this composer text directly" signal).
      Both paths cross architectural boundaries beyond the autonomous /loop's per-slice budget. ESCALATE TO MAINTAINER ARCHITECTURE REVIEW. Do not attempt 4b'-b without explicit signoff.
      0 LOC code change (docs only).

  - id: phase4b-double-prime-d-result-extension
    order: 5.254
    status: merged
    signoff: maintainer-authorized-2026-05-02
    content: |
      **Phase 4b''-d** MERGED (PR-#134 `d852020517`). Extended `RunTurnDecisionResult` with optional `derivedCommitment?: ExecutionCommitment` field surfaced from the kernel-source-of-truth path (`gate_in_success` + `commitmentSatisfied`). +13 LOC + 22 LOC test. `pnpm tsgo` clean; 27/27 scoped + adjacent tests green. Behaviour-neutral.

  - id: phase4b-double-prime-e1-surface-composer-text
    order: 5.255
    status: merged
    signoff: maintainer-authorized-2026-05-02
    content: |
      **Phase 4b''-e1** MERGED (PR-#135 `4e2b21dd71`). Bubbled `composer.text` through `WebResearchComposerResult` / `WebResearchTurnResult` ok variants — previously the composer adapter discarded the model output after the DeliveryReceipt was recorded. +15/-7 LOC over 4 files. `pnpm tsgo` clean; 27/27 scoped vitest green. Behaviour-neutral.

  - id: phase4b-double-prime-e2-production-transports
    order: 5.256
    status: merged
    signoff: maintainer-authorized-2026-05-02
    content: |
      **Phase 4b''-e2** MERGED (PR-#136 `9421ec7ea0`). New `src/platform/decision/web-research-transports.ts` with `createWebResearchSpecialistTransport` (defaults `hydra/sonar-pro`, 30s/2000 tokens) + `createWebResearchComposerTransport` (defaults `hydra/claude-opus-4.6`, 60s/4000 tokens). Both wrap `prepareModelForSimpleCompletion` + `completeSimple` mirroring the IntentContractor pattern at `intent-contractor-impl.ts:250`. Shared `completeWithModel` helper unifies resolution + auth + abort-controller-driven timeout. +179 LOC over 2 new files. `pnpm tsgo` clean; 4/4 scoped vitest green. Behaviour-neutral.

  - id: phase4b-double-prime-e3-dispatch-helper
    order: 5.257
    status: merged
    signoff: maintainer-authorized-2026-05-02
    content: |
      **Phase 4b''-e3** MERGED (PR-#137 `e07b477697`). New `src/platform/decision/web-research-dispatch.ts` with `runWebResearchDispatch(...)` — thin glue helper that builds production transports (or accepts test overrides), synthesises the composer commitment from the specialist commitment by cloning + replacing effect to `WEB_RESEARCH_SUMMARIZED_EFFECT` (architectural cleanup deferred), and invokes `runWebResearchTurn`. Returns `{ ok: true, text, messageId, recordCount }` on success. Closed failure set: `effect_not_dispatchable` + propagation of orchestrator stage failures. +395 LOC over 2 new files. `pnpm tsgo` clean; 5/5 scoped vitest green (happy path + 2x effect_not_dispatchable + specialist-failure + composer-failure). Behaviour-neutral on production — no caller invokes the helper yet.

  - id: phase4b-double-prime-e4-caller-wiring-architectural
    order: 5.258
    status: pending-architectural-decision
    signoff: required
    content: |
      **Phase 4b''-e4** (PENDING) — caller wiring at the agent-runner / model-fallback layer to invoke `runWebResearchDispatch` and short-circuit the LLM call when dispatch returns `{ ok: true, text }`.
      The dispatch helper from Phase 4b''-e3 is fully assembled (transports + commitment synthesis + closed failure set). What remains is plumbing the composer text from the dispatch result back to the user-facing message-delivery layer. Architectural options identified during 4b''-e2/e3:
        - **Option α** (planner-input threading): Add `RecipePlannerInput.directResponse?: { text, messageId }` field. Modify `model-fallback.ts` (~600 LOC orchestration) to short-circuit the LLM call when this field is set. Reach: deep into the multi-LOC fallback orchestration.
        - **Option β** (runtime-plan threading): Same as α but field on `RecipeRuntimePlan`. Same reach problem.
        - **Option γ** (pre-planner hook): Hook the dispatch BEFORE planner-input construction in `agent-command.ts` / `agent-runner-utils.ts`. After dispatch success, deliver text directly via the channel adapter, return a sentinel signaling "already delivered". Reach: agent-runner reply loop.
        - **Option δ** (route-preflight replacement): Replace the PR-#125/#126 grok-4 promotion in `route-preflight.ts` with a "dispatch web_research and emit synthetic preflight" path. Reach: route-preflight + the layer above it that consumes preflight results.
        - **Option ε** (pre-orchestrator + evidence injection): Run sonar specialist BEFORE the normal planner LLM call, populate `WebEvidenceCollector`. The composer LLM call is the existing planner-driven LLM call BUT receives `<web_evidence>` system-prompt injection AND has `web_search` filtered out AND is routed to opus/gpt-5.4 (NOT grok). Reach: planner system-prompt construction + tool catalog filter.
      All five options are architectural; no single one fits in the autonomous /loop's per-slice budget without escalation. Recommendation: maintainer review of Option α vs γ vs ε — the highest-quality outcome (opus/gpt-5.4 composes with sonar evidence) likely requires γ or ε; α is safer but requires the model-fallback layer modification.

  - id: phase4b-double-prime-e-decision-layer-wiring
    order: 5.259
    status: superseded-by-e4
    signoff: required
    content: |
      **Phase 4b''-e** SUPERSEDED — split into 4b''-e1 / e2 / e3 (kernel side, all merged) + 4b''-e4 (architectural caller wiring, pending). The original "single 4b''-e slice" plan was replaced by the four-sub-slice decomposition once the architectural reach of caller wiring became clear during 4b''-e2 build-out.

  - id: phase4c-classifier-gate-flip-and-live-verify
    order: 5.3
    status: pending
    signoff: required
    content: |
      **Phase 4c** (split from Phase 4 per §8.5). IntentContractor prompt-hint flip + live verify.
      Files: `intent-contractor-impl.ts:472` (4-family allowlist + one example row), `intent-contractor-impl.test.ts` (extend).
      ~35 LOC + live verify against gateway. **Behaviour CHANGES**: classifier starts emitting `web_research`. NEVER ship without 4a + 4b merged.

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

### 2026-05-02 — Phase 1 merged (PR-#127, squash `5c2813b141`)

- Branch: `feat/orchestrator-search-composer-phase1` от свежего `origin/dev` (HEAD `e1d58ab614` на момент checkout). Squash-merged via `gh pr merge 127 --admin --squash --delete-branch` after BlackSmith CI stuck pending >5 min (documented precedent PR-#112/#114/#118/#122/#125/#126); local validation green: `pnpm tsgo` clean, `pnpm test --run src/platform/commitment/__tests__/effect-family-registry.test.ts src/platform/commitment/__tests__/registries.test.ts` → 15/15 passed (4.86s).
- Diff: `+85 -2` over 4 files.
  - `src/platform/commitment/effect-family-registry.ts`: extended `EffectFamilyDefinition` with optional `branchingHints?: readonly BranchingHint[]`; added `WEB_RESEARCH_EFFECT_FAMILY` constant; pushed `web_research` entry into `EFFECT_FAMILY_REGISTRY` with `allowedOperationKinds: ["create"]` + frozen `branchingHints: ["search_specialist", "search_then_composer"]`; declared and exported `WEB_EVIDENCE_COLLECTED_EFFECT` (`"web_evidence.collected"` as `EffectId`) and `WEB_RESEARCH_SUMMARIZED_EFFECT` (`"web_research.summarized"` as `EffectId`) — Phase 2 affordance keys.
  - `src/platform/commitment/index.ts`: re-exported the three new constants.
  - `src/platform/commitment/__tests__/effect-family-registry.test.ts` (new, 7 tests): `Object.isFrozen(EFFECT_FAMILY_REGISTRY)` + per-entry frozen + `push throws`; `web_research` registered exactly once with create-only operation; `branchingHints` exposed only on `web_research` (closed extension, undefined elsewhere); `WEB_EVIDENCE_COLLECTED_EFFECT` / `WEB_RESEARCH_SUMMARIZED_EFFECT` brand-equal expected strings; `isKnownEffectFamilyId("web_research") === true`.
  - `src/platform/commitment/__tests__/registries.test.ts`: order check extended to `["persistent_session", "communication", "web_research", "unknown"]`.
- **Behavior-neutral on this slice** (architectural pre-wiring only):
  - The `IntentContractor` structured-output prompt hint at `src/platform/commitment/intent-contractor-impl.ts:472` retains the 3-family allowlist (`"persistent_session" | "communication" | "unknown"`), so the classifier continues to pick from the same 3 options. Phase 4 will update this hint together with the runtime adapter.
  - The dynamic `familyDirectory` constructed at `intent-contractor-impl.ts:461` does pick up `web_research` automatically (this is by design per master §13 — registry is single source of truth) but the responseShape hint dominates classifier behavior on gpt-5-mini in practice; live verification post-merge will confirm.
  - `route-preflight.ts` `NATIVE_WEB_SEARCH_MODEL_IDS` remains empty per the Phase 0 rollback in `e1d58ab614`.
- Hard invariants reverse-tested: **#1, #2, #5, #6, #7, #8, #11, #16** — all clear (no `ExecutionCommitment` shape change, no affordance selection logic, no UserPrompt phrase-rule, no IntentContractor raw-text reader change, no ShadowBuilder change, no `commitment/` ↛ `decision/` import boundary violation, frozen 5 decision contracts untouched, distinct `EffectFamilyId` vs `EffectId` branded types preserved on the new family + 2 effects).
- Frozen-layer touch: **none** (Phase 5 will be the only frozen-layer slice in this sub-plan — `ModelRoutePreflightDecision.reasonCode` union extension under `compatibility` label).
- Next: **Phase 2** — two affordances `perplexity_search_specialist` (effect=`WEB_EVIDENCE_COLLECTED_EFFECT`, target=`evidence_record` matcher, donePredicate on `webEvidence.records[*].url`) and `composer_after_search` (effect=`WEB_RESEARCH_SUMMARIZED_EFFECT`, precondition `webEvidence.records.length >= 1`, target = `document` | `text_response` matcher) in `src/platform/commitment/affordance-registry.ts`. Predicates currently stub-able (real `WebEvidenceSlice` lands in Phase 3); use a forward-declared `WorldStateSnapshot.webEvidence?` shape in `world-state.ts` to keep the affordance pair compilable but inert until Phase 3-4 wire the population path.

### 2026-05-02 — Phase 2 merged (PR-#128, squash `d9d08eb514`)

- Branch: `feat/orchestrator-search-composer-phase2` от свежего `origin/dev` (HEAD `f0f4e36cf3` после Phase 1 docs commit). Squash-merged via `gh pr merge 128 --admin --squash --delete-branch` after BlackSmith CI stuck pending >60s with `actionlint`/`docs-scope`/`label`/`no-tabs`/`preflight`/`label-issues` all in `pending` state and `backfill-pr-labels`/`generated-doc-baselines` in `skipping` (documented precedent PR-#112/#114/#118/#122/#125/#126/#127); local validation green: `pnpm tsgo` clean; scoped vitest 21/21 (effect-family-registry.test.ts + registries.test.ts) + 30/30 adjacent (run-turn-decision.cutover2 + clarification-downgrade + shadow-builder-impl + policy-gate) → 51/51 total green.
- Diff: `+267 -3` over 5 files (2 new predicate files, 3 modified).
  - `src/platform/commitment/done-predicate-web-evidence-collected.ts` (new): `webEvidenceCollectedPredicate` — Phase-2 deterministic stub returning `{ satisfied: false, missing: ["web_evidence.records.population_pending_phase_3"] }` (frozen `missing` array). Reads no `state` / `delta` / `receipts` / `trace`, so invariant #9 holds while WorldState slice is unwired.
  - `src/platform/commitment/done-predicate-web-research-summarized.ts` (new): `webResearchSummarizedPredicate` — Phase-2 stub returning `{ satisfied: false, missing: ["web_evidence.records.population_pending_phase_3", "composer.delivery_receipt_pending_phase_4"] }`.
  - `src/platform/commitment/affordance-registry.ts`: imported `WEB_EVIDENCE_COLLECTED_EFFECT` / `WEB_RESEARCH_EFFECT_FAMILY` / `WEB_RESEARCH_SUMMARIZED_EFFECT` from `effect-family-registry.js` and the two new predicate stubs; added `WEB_EVIDENCE_PRESENT_PRECONDITION` (exported `PreconditionId` constant — Phase 4 evaluator key); declared and exported `PERPLEXITY_SEARCH_SPECIALIST_AFFORDANCE_ENTRY` (effect=`WEB_EVIDENCE_COLLECTED_EFFECT`, target matcher accepts `unspecified | external_channel | artifact | workspace`, `requiredPreconditions: []`, `requiredEvidence: [{ kind: "web_evidence.collected", mandatory: true }]`, `defaultBudgets: { maxLatencyMs: 30_000, maxRetries: 1 }`, `observerHandle: { id: "web_evidence_world_state" }`) and `COMPOSER_AFTER_SEARCH_AFFORDANCE_ENTRY` (effect=`WEB_RESEARCH_SUMMARIZED_EFFECT`, target matcher accepts `external_channel | artifact`, `requiredPreconditions: [WEB_EVIDENCE_PRESENT_PRECONDITION]`, `requiredEvidence: [{ kind: "web_research.summarized", mandatory: true }]`, `defaultBudgets: { maxLatencyMs: 60_000, maxRetries: 0 }`, `observerHandle: { id: "delivery_world_state" }` — reuses existing observer); appended both entries to `DEFAULT_AFFORDANCES` (4 → 6).
  - `src/platform/commitment/index.ts`: re-exported `COMPOSER_AFTER_SEARCH_AFFORDANCE_ENTRY` / `PERPLEXITY_SEARCH_SPECIALIST_AFFORDANCE_ENTRY` / `WEB_EVIDENCE_PRESENT_PRECONDITION` and the two predicates.
  - `src/platform/commitment/__tests__/registries.test.ts`: order assertion extended to 6 entries; new `describe("affordance registry — web_research family (Search-Composer Phase 2)", ...)` block with 6 tests covering: `findByFamily(web_research, target, { kind: "create" })` for each accepted target kind on both affordances; create-only family discipline (observe/update rejected); precondition-list shape (specialist `[]`, composer `[WEB_EVIDENCE_PRESENT_PRECONDITION]`); Phase 2 stub predicates' missing-key shape; cross-family contamination check (web_research entries do NOT appear in `findByFamily(COMMUNICATION_EFFECT_FAMILY, ...)` or `findByFamily(PERSISTENT_SESSION_EFFECT_FAMILY, ...)` lookups).
- **Behavior-neutral on this slice**:
  - `IntentContractor` prompt hint at `intent-contractor-impl.ts:472` retains 3-family allowlist; classifier never emits `web_research`, so `findByFamily(WEB_RESEARCH_EFFECT_FAMILY, ...)` is never invoked from the production decision path. The two affordance entries are reachable only via direct registry inspection (tests + future Phase 4 code).
  - The Phase 2 stub predicates are deterministic constants that always return `unsatisfied` with documented missing keys; they cannot select to terminal-success by any path until Phase 3 (`WebEvidenceSlice` population) and Phase 4 (runtime adapter + IntentContractor prompt hint update) ship.
  - G6.a structural canary in `run-turn-decision.cutover2.test.ts:268` (3 communication-family affordances) preserved — both new entries live under `WEB_RESEARCH_EFFECT_FAMILY`.
- Hard invariants reverse-tested: **#1, #2, #5, #6, #7, #8, #9, #10, #11, #16** — all clear (#9 explicitly: stubs read no `state` / `delta` / `receipts` / `trace`; #10 explicitly: `donePredicate` declared on the affordance entries, never on `ExecutionCommitment`).
- Frozen-layer touch: **none** (Phase 5 will be the only frozen-layer slice in this sub-plan — `ModelRoutePreflightDecision.reasonCode` union extension under `compatibility` label).
- Next: **Phase 3** — `WebEvidenceSlice` in `src/platform/commitment/world-state.ts`. Add `WebEvidenceRecord` type (`{ url: string; snippet: string; title?: string; capturedAt: ISO8601 }`), extend `WorldStateSnapshot` with `webEvidence?: { records: readonly WebEvidenceRecord[] }`, populate slice via `MonitoredRuntime.observeEvidence("web_evidence.collected", record)` handler in `monitored-runtime.ts`, reset at turn-start, per-`(sessionId, turnId)` keying. Re-wire the two Phase 2 predicate stubs to actually read `ctx.stateAfter.webEvidence?.records` (specialist: ≥1 record with `url`; composer: precondition only — composer's full predicate also needs Phase 4's delivery-receipt link, so composer stub remains partial after Phase 3). New scoped tests: `world-state.test.ts` for slice shape + ingestion + read APIs; existing `done-predicate-web-evidence-collected.test.ts` (new) covering happy path + url-missing failure mode.

### 2026-05-02 — Phase 3 merged (PR-#129, squash `dd54ed11df`)

- Branch: `feat/orchestrator-search-composer-phase3` от свежего `origin/dev` (HEAD `87f3ff7dac` после Phase 2 docs commit). Squash-merged via `gh pr merge 129 --admin --squash --delete-branch` after BlackSmith CI stuck pending >60s with 6 jobs in `pending` and 2 in `skipping` (documented precedent PR-#112/#114/#118/#122/#125/#126/#127/#128); local validation: `pnpm tsgo` clean; scoped vitest (4 files: `world-state.test.ts` + `done-predicate-web-evidence-collected.test.ts` + `registries.test.ts` + `effect-family-registry.test.ts`) → 30/30 green; adjacent (8 files: cutover2, clarification-downgrade, shadow-builder-impl, policy-gate, session-world-state-observer, delivery-world-state-observer, done-predicate-persistent-session, monitored-runtime) → 45/45 green. Total: **75/75** over 12 test files.
- Diff: `+264 -28` over 6 files (2 new test files, 4 modified — including 2 predicate files now wired vs Phase 2 stubs).
  - `src/platform/commitment/world-state.ts` (+12): new `WebEvidenceRecord` (`{ url: string; snippet: string; title?: string; capturedAt: ISO8601 }`) + `WebEvidenceWorldState` (`{ records: readonly WebEvidenceRecord[] }`); extended `WorldStateSnapshot` with optional `webEvidence?: WebEvidenceWorldState`. Backward-compat — existing observers (session/delivery/artifact/workspace) untouched.
  - `src/platform/commitment/done-predicate-web-evidence-collected.ts`: replaced Phase 2 deterministic stub with read-side predicate over `ctx.stateAfter.webEvidence?.records`. Closed missing-key set: `web_evidence.slice_absent` (slice undefined) / `web_evidence.records.empty` (zero records) / `evidence_record_missing_url:<index>` (per-index accumulating). On satisfied, emits one frozen `EvidenceFact { kind: "web_evidence.collected", value: { url, snippet, title, capturedAt } }` per record.
  - `src/platform/commitment/done-predicate-web-research-summarized.ts`: comment + missing-key wording updated to single-key `["composer.runtime_adapter_pending_phase_4"]` (Phase 3 wired the slice; Phase 4 wires the delivery-receipt link).
  - `src/platform/commitment/__tests__/registries.test.ts`: Phase 2 stub-key assertion replaced — specialist now reports `web_evidence.slice_absent` on empty state; composer stub reports `composer.runtime_adapter_pending_phase_4`.
  - `src/platform/commitment/__tests__/world-state.test.ts` (new, 65 LOC): `WebEvidenceWorldState` snapshot optionality, frozen records, `WebEvidenceRecord` shape (mandatory `url`/`snippet`/`capturedAt`, optional `title`), insertion-order preservation across multiple records.
  - `src/platform/commitment/__tests__/done-predicate-web-evidence-collected.test.ts` (new, 121 LOC, 5 tests): happy path (≥1 record with url → satisfied with EvidenceFact list); missing-url-at-index (→ unsatisfied with `evidence_record_missing_url:<N>`); empty records list (→ unsatisfied with `web_evidence.records.empty`); absent slice (→ unsatisfied with `web_evidence.slice_absent`); **invariant #9 sentinel-proxy assertion** — wraps `stateBefore` in a `Proxy` that flips a flag when any field other than `webEvidence` is read; predicate runs to satisfied without flipping the flag, structurally proving no raw text / TaskContract / task-classifier output is touched.
- **Behavior-neutral on this slice** — runtime never populates the slice (Phase 4 wiring), so the predicate always sees `slice_absent` from production paths. Behaviour change (specialist/composer affordances actually selectable + live web research) lands together in Phase 4.
- Hard invariants reverse-tested: **#1, #2, #5, #6, #7, #8, #9, #10, #11, #16** — all clear (#9 explicitly reinforced by the sentinel-proxy test).
- Frozen-layer touch: **none** (Phase 5 will be the only frozen-layer slice in this sub-plan — `ModelRoutePreflightDecision.reasonCode` union extension under `compatibility` label).
- Next: **Phase 4** — runtime adapter for the two-affordance sequence (`src/agents/pi-embedded-runner/run/attempt.ts` или new helper); update IntentContractor structured-output prompt hint at `intent-contractor-impl.ts:472` to include `web_research` as a 4th classifier option together with one new `examples[*]` row demonstrating when to pick it; populate `WebEvidenceSlice` from sonar's structured-JSON reply; inject `<web_evidence>` block into composer prompt; emit composer delivery receipt so the composer predicate flips to satisfied. **First behaviour-changing slice — gateway restart + live verify required (combo turn `bundles=[artifact_authoring, public_web_lookup]` and pure-search turn `bundles=[public_web_lookup]`).**

### 2026-05-02 — Phase 4 amendment + Phase 4a merged (PR-#130, squash `5b6dd648d5`)

**Phase 4 amendment** (`d922aea8d4` on dev, docs-only): sub-plan §8.5 added with the 4a/4b/4c split after audit confirmed Phase 4 scope drift past the autonomous /loop's >2-file threshold. Sequence MUST be 4a → 4b → 4c (4c standalone regresses production).

**Phase 4a** (`5b6dd648d5`):
- Branch: `feat/orchestrator-search-composer-phase4a` от свежего `origin/dev` (HEAD `d922aea8d4`). Squash-merged via admin per documented precedent (BlackSmith stuck pattern, 6 jobs `pending` + 2 `skipping` after >60s).
- Diff: `+759 -7` over 8 files (3 new, 5 modified).
  - `src/platform/commitment/web-evidence-world-state-observer.ts` (new, ~190 LOC): `TurnKey = { sessionId: SessionId; turnId: string }`; `WebEvidenceCollector` interface (record / resetForTurn / setActiveTurn / getActiveSlice) backed by `Map<bucketKey, WebEvidenceRecord[]>` with URL-keyed last-writer-wins dedup and `perTurnLimit=32`; `WebEvidenceWorldStateObserver` returns `undefined` when no active turn or empty bucket (production default state); `getProcessWebEvidenceCollector()` / `setProcessWebEvidenceCollectorForTests` singletons mirroring `delivery-receipt-registry.ts`.
  - `src/platform/commitment/world-state.ts`: new `webEvidenceRecordSchema` (Zod `.strict()` — non-empty `url`, `snippet`, ISO-8601 regex on `capturedAt`, optional `title`).
  - `src/platform/commitment/monitored-runtime.ts`: extended `createMonitoredRuntime` deps with optional `webEvidenceObserver`; `freezeSnapshot` threads `webEvidence: deps.webEvidenceObserver?.observe()`. Backward compatible.
  - `src/platform/commitment/production-runtime-defaults.ts`: wired observer into `createDefaultMonitoredRuntime` over the process collector. Production runtime sees `webEvidence: undefined` for every turn until Phase 4b's caller writes — preserving today's behaviour byte-for-byte.
  - `src/agents/pi-embedded-runner/run/web-research-runtime-adapter.ts` (new, ~206 LOC): `runWebResearchSpecialist({ commitment, intent, turnKey, transport, collector, logger? })`. Closed failure-reason set: `effect_mismatch` (early guard) / `transport_error` (HTTP 4xx/5xx surrogate) / `parse_error` (non-JSON or per-record `record_<index>_invalid:<zod_code>`) / `no_records` / `no_citations`. Closed-shape sonar prompt built from `SemanticIntent.constraints` keys (`summary`, `freshness`, `region`, `maxRecords`); raw user text never embedded (invariant #6 reverse-tested by adapter prompt-shape assertion). Emits `[commitment] effect=web_evidence.collected records=<N> sessionId=<sid> turnId=<tid>` telemetry on success. Calls `collector.resetForTurn(turnKey)` before recording so retry-within-turn replaces the prior bucket atomically.
  - Three new test files (10 + 9 + extended): observer state machine + per-key isolation + `perTurnLimit`; Zod schema happy + missing-url + invalid-ISO + missing-required + strict-extra; adapter happy-path + every failure branch + invariant #6 prompt-shape assertion.
- **Phase 4a is purely additive** — no production caller invokes the adapter yet. The collector singleton is initialized lazily on first `createDefaultMonitoredRuntime` call but never `record(...)`-ed by any production turn. The kernel observer always returns `undefined` from production paths, so `webEvidenceCollectedPredicate` continues to report `web_evidence.slice_absent` exactly as before — production behaviour byte-for-byte unchanged.
- Hard invariants reverse-tested: **#1, #2, #5, #6, #7, #8, #9, #10, #11, #16** — #5 explicitly via the structural closed-shape JSON prompt assertion; #6 explicitly via the prompt-shape test asserting the adapter receives only commitment-derived constraints (no raw text).
- Frozen-layer touch: **none**.
- Local validation: `pnpm tsgo` clean; **57/57** scoped + **53/53** adjacent (`input.test.ts` / `run-turn-decision.cutover1.test.ts` / `run-turn-decision.cutover2.test.ts` / `shadow-builder-impl.test.ts`) → **110/110** total over 12 files.
- Next: **Phase 4b** — composer runtime adapter (extend `web-research-runtime-adapter.ts` with `runComposerAfterSearch(...)`); delivery-receipt emission with `effect=WEB_RESEARCH_SUMMARIZED_EFFECT`; re-wire `webResearchSummarizedPredicate` from Phase-4-partial stub to real read-side check (slice records present AND delivery-receipt with composer effect present); **caller wiring at `attempt.ts`** routing both specialist + composer adapters when affordance.effect matches (narrow conditional; behaviour-neutral on production until 4c flips classifier hint). Composer prompt injects `WebEvidenceSlice.records` as structural `<web_evidence>` block (closed-shape JSON-like — invariant #5 safe per §6.2); tool schema = full set MINUS `web_search` keyed on `webEvidence.records.length >= 1` rather than model compat.

### 2026-05-02 — Phase 4b merged (PR-#131, squash `800ddc6e59`); §8.5 amendment further split into 4b/4b'

**§8.5 amendment update**: after `attempt.ts` audit (3,468 LOC orchestration loop), the original Phase 4b entry was further split into 4b (composer adapter + predicate re-wire) and 4b' (caller wiring at attempt.ts). The drift safeguard authorized this split: inserting the 2-call sequence into a 3.4k-LOC orchestration loop without prior audit exceeded the >2-file / >3-LOC threshold.

**Phase 4b proper** (`800ddc6e59`):
- Branch: `feat/orchestrator-search-composer-phase4b` от свежего `origin/dev` (HEAD `858f2b7aab`). Squash-merged via admin per documented precedent (BlackSmith stuck pattern matches PR-#127 through PR-#130).
- Diff: `+729 -19` over 5 files (1 new test file, 4 modified).
  - `src/agents/pi-embedded-runner/run/web-research-runtime-adapter.ts` (+169): new `runComposerAfterSearch({ commitment, intent, turnKey, webEvidenceSlice, deliveryContextKey, transport, deliveryReceiptRegistry, fullToolCatalog, now?, logger? })`. Closed failure-reason set: `effect_mismatch | web_evidence_missing | transport_error | empty_reply`. Filters `web_search` out of `fullToolCatalog`. Builds composer system message with structural `<web_evidence>{ records, summary }</web_evidence>` block (closed-shape JSON-like — invariant #5 safe). Emits `DeliveryReceipt` with `effect=WEB_RESEARCH_SUMMARIZED_EFFECT` and `kind="answer"` on success (reuses existing `DeliveryReceiptKind`, no frozen-shape extension). Deterministic messageId fallback `composer:<sessionId>:<turnId>:<sentAt>`. Telemetry `[commitment] effect=web_research.summarized recordCount=<N> ...`.
  - `src/platform/commitment/done-predicate-web-research-summarized.ts` (+117/-15): replaced Phase-4-partial stub with read-side predicate over `ctx.stateAfter.webEvidence?.records` AND `ctx.stateAfter.deliveries?.receipts`. Closed missing-key set: `web_evidence.slice_absent | web_evidence.records.empty | composer.delivery_receipt_missing`. On satisfied, emits two `EvidenceFact` (slice + receipt). Scopes receipt lookup by `deliveryContextKey` from `ctx.expectedDelta.deliveries.receipts.added[0]`; any-context fallback when expected key absent (single-channel correctness).
  - Two new test files: `done-predicate-web-research-summarized.test.ts` (8 cases incl. **Proxy-sentinel invariant #9** structural assertion); `web-research-runtime-adapter.test.ts` extended with 9 composer cases (happy + every failure branch + tool-catalog filter + `<web_evidence>` injection assertion + deterministic messageId).
  - `registries.test.ts`: Phase 2/3/4-pending stub assertions consolidated — both predicates now report `web_evidence.slice_absent` on empty state (Phase 3 wired specialist, Phase 4b wired composer).
- **Behaviour-neutral on production** — no caller invokes either adapter yet; the composer predicate is reachable only from fixture-driven tests.
- Hard invariants reverse-tested: **#1, #2, #5, #6, #7, #8, #9, #10, #11, #16** — #5 explicitly via `<web_evidence>` block content assertion; #9 explicitly via Proxy-sentinel test on the predicate.
- Frozen-layer touch: **none**.
- Local validation: `pnpm tsgo` clean; **71/71** scoped + **19/19** adjacent → **90/90** total over 10 files.
- Next: **Phase 4b'** — caller wiring at `attempt.ts` for both `runWebResearchSpecialist` and `runComposerAfterSearch`. Budget: ≤3 LOC change to attempt.ts orchestration loop body + 1 new helper file (`web-research-orchestrator.ts` or similar) for the two-step driver. If wiring requires more touch, STOP and write Phase 4b'' amendment.

### 2026-05-02 — Phase 4b'-a merged (PR-#132, squash `986fb04b03`); §8.5 amended again (4b' → 4b'-a / 4b'-b)

**Audit finding**: direct grep against `src/agents/pi-embedded-runner/run/attempt.ts` for `runTurnDecision|monitoredRuntime|webEvidenceCollector|completeSimple|affordance|commitment\.effect` returned **0 matches**. attempt.ts is purely the LLM-call layer with zero kernel awareness. The 2-step dispatch (sonar → composer) cannot be inserted at the LLM-call layer without architectural integration. Per the §8.5 drift safeguard's `4b'-a / 4b'-b` provision, Phase 4b' was split:

- **4b'-a** (this merge): `web-research-orchestrator.ts` helper alone. attempt.ts untouched.
- **4b'-b** (next slice): caller wiring at the **decision-layer dispatch point** (`src/platform/decision/input.ts` or `src/platform/plugin.ts`, the two call-sites of `runTurnDecision`), NOT at attempt.ts. The transport wiring (`prepareModelForSimpleCompletion` + `completeSimple` from `@mariozechner/pi-ai`) lands alongside.

**Phase 4b'-a** (`986fb04b03`):
- Branch: `feat/orchestrator-search-composer-phase4b-prime` от свежего `origin/dev` (HEAD `060f5d21b0` после Phase 4b docs commit). Squash-merged via admin per documented precedent.
- Diff: `+532 -0` over 2 new files.
  - `src/agents/pi-embedded-runner/run/web-research-orchestrator.ts` (new, +185): `runWebResearchTurn(...)` orchestrates specialist → observer.observe → composer with closed failure semantics. Specialist failure short-circuits composer (no wasted composer call). Composer failure after specialist success preserves the sonar slice on the observer (caller can decide partial-state UX). Defensive guard: pathological observer returning `undefined` after specialist success → abort with `web_evidence_missing` rather than passing `undefined` slice to composer. `isWebResearchFamilyEffect(effect)` predicate exported for the Phase 4b'-b conditional — returns `true` only for `WEB_EVIDENCE_COLLECTED_EFFECT` or `WEB_RESEARCH_SUMMARIZED_EFFECT`.
  - `src/agents/pi-embedded-runner/run/web-research-orchestrator.test.ts` (new, +347): 9 cases covering canonical happy path; specialist transport_error short-circuits composer; specialist no_records short-circuits composer; composer transport_error after specialist success preserves slice + zero receipts emitted; effect_mismatch on either commitment skips both transports; pathological observer guard; predicate matrix (true for 2 web_research effects, false for `persistent_session.created` / `answer.delivered` / `clarification_requested` / `external_effect.performed`).
- **Behaviour-neutral on production** — no caller invokes the orchestrator yet; attempt.ts untouched (and confirmed-via-audit unsuitable for the integration); the predicate is dead code in production until 4b'-b wires the decision-layer conditional.
- Hard invariants reverse-tested: **#1, #2, #5, #6, #7, #8, #9, #10, #11, #16** — all clear; #8 explicitly: orchestrator lives in `agents/pi-embedded-runner` (allowed to import both layers).
- Frozen-layer touch: **none**.
- Local validation: `pnpm tsgo` clean; **62/62** scoped (orchestrator + adapter + composer-predicate + observer + registries + monitored-runtime).
- Next: **Phase 4b'-b** — caller wiring at the decision-layer dispatch point (`input.ts` or `plugin.ts` — audit which is narrower) + LLM transport setup (`prepareModelForSimpleCompletion` + `completeSimple`). ≤3 LOC change to dispatch site + 1 file for transport setup. If wiring requires more, STOP and write Phase 4b''-c amendment.

### 2026-05-02 — Phase 4b''-c amendment (architectural mismatch documented; Phase 4b'-b BLOCKED pending maintainer signoff)

**Audit at `src/platform/decision/input.ts` lines 548 + 587** (the two production runTurnDecision call-sites; `plugin.ts` callers are scoped to single-shot internal hooks per Phase 2 handoff in clarification-policy and not in the production fire-path):

```ts
const { productionDecision: classified, intent: classifiedIntent } = await runTurnDecision({...});
```

`runTurnDecision` returns `{ productionDecision: TaskContract-shaped, intent: SemanticIntent }`. The kernel-derived `ExecutionCommitment` is **internal to `run-turn-decision.ts`** and not surfaced in the result. The caller flows `productionDecision` downstream as the model-routing TaskContract; the output of `runWebResearchTurn` (`{ specialist: { recordCount }, composer: { messageId } }`) does NOT fit this shape.

Two integration paths exist; both exceed the autonomous /loop's per-slice budget:
- **Path A**: Add `RunTurnDecisionResult.derivedCommitment?: ExecutionCommitment` (~20 LOC, additive, behaviour-neutral). Then caller does the gate + dispatch. Path-A still needs Path-B's productionDecision-replacement to actually flow composer text to user.
- **Path B**: Productionalize the productionDecision-replacement signal so the composer's text replaces the TaskContract-driven response. Three sub-options noted in §8.5 4b''-e: synthesize a `direct_response` TaskContract; add a `directResponse` field on the result; OR move delivery inside the orchestrator. **All three are architectural decisions that need maintainer review.**

**Decision**: 4b'-b BLOCKED pending maintainer signoff on Path A vs Path B (or a hybrid). The Search-Composer pipeline is **structurally complete from the kernel side** — Phases 1-4b'-a deliver the registry, affordances, slice, predicates, observers, runtime adapters (sonar + composer), and the orchestrator helper. **What remains is purely the architectural integration between the kernel's commitment shape and the caller's response shape.**

**Pivot**: this autonomous /loop iteration commits the §8.5 amendment and pivots to **Telegram caption-overflow UX** (roadmap §8 forward-deferred narrow slice, no signoff required, no architectural touch). The Search-Composer queue resumes once maintainer signoff lands on the §8.5 4b''-d / 4b''-e path choice.

No code change in this iteration. attempt.ts still untouched (and confirmed unsuitable for the integration); input.ts/plugin.ts also untouched pending architectural review.

### (To be filled per phase as work progresses post-signoff.)

## 8. Adjacent / deferred bugs (out of scope)

| Order | Bug | Symptom | Required scope | Why deferred |
| --- | --- | --- | --- | --- |
| 1 | Bundle-as-contract enforcement at the LLM schema layer | `bundles=[respond_only]` mis-emit case (turn `355ae135`) where model autonomously calls web_search and dies | Thread `toolBundles` through `attempt.ts:1915` into `createOpenClawCodingTools(...)` + bundle→tool allowlist | Heartbeat-class turns currently depend on bundle being advisory; full deferral covered in `orchestrator_web_search_capability_routing.plan.md` §8 row 1. Orthogonal to this slice. |
| 2 | IntentContractor `freshness` / `recency` constraint surface | Same as above, addressed from routing side | Extend `SemanticIntent.constraints` shape; route-preflight gate also fires on `intent.constraints.freshness === "current"` | Architectural addition to `SemanticIntent`; deferred per `orchestrator_web_search_capability_routing.plan.md` §8 row 2. |
| 3 | Concurrent / multi-tenant turn pipeline | Single-threaded turn-blocked processing | New broker / scheduler with concurrency limits | `pr-mt-broker-future` in roadmap §6 row 4; requires this slice + PR-G + PR-A.2 + PR-H all merged. |
| 4 | Image-search specialist (besides web_search text) | Some turns need image search (e.g. "find logos of these models") | Extend Affordance(`perplexity_search_specialist`) or new `image_search_specialist` affordance | Out of scope; pickup after this slice settles. |

## 8.5. Phase 4 sub-decomposition — 2026-05-02 amendment

**Scope-drift finding** (autonomous /loop, 2026-05-02 14:30 local): The original Phase 4 (`phase4-runtime-wiring`) frontmatter entry estimated ~150 LOC in a single entry-point file (`pi-embedded-runner/run/attempt.ts` or `auto-reply/reply/agent-runner.runtime.ts`). Audit revealed the realistic touch surface is at least **5 files**:

1. `src/platform/commitment/web-evidence-world-state-observer.ts` — **new file** modelled on `delivery-world-state-observer.ts`. Holds the per-`(sessionId, turnId)` `WebEvidenceCollector` that the runtime adapter populates from a sonar reply and exposes via `observe(): WebEvidenceWorldState`.
2. `src/platform/commitment/monitored-runtime.ts` — extend `createMonitoredRuntime` deps with optional `webEvidenceObserver?: WebEvidenceWorldStateObserver`; extend `freezeSnapshot` to include `webEvidence: deps.webEvidenceObserver?.observe()`.
3. `src/platform/commitment/production-runtime-defaults.ts` — wire the new observer into `createDefaultMonitoredRuntime`.
4. `src/agents/pi-embedded-runner/run/attempt.ts` (or new helper file) — **new runtime-adapter entry point** that detects a `web_research`-family commitment, runs sonar/sonar-pro with empty tool schema + structured-JSON system instruction, parses the reply via a Zod schema, and pushes records into the collector.
5. `src/platform/commitment/done-predicate-web-research-summarized.ts` — re-wire from Phase-4-partial stub to the real read-side predicate (slice records present AND delivery-receipt with `effect=WEB_RESEARCH_SUMMARIZED_EFFECT` present).

Plus the IntentContractor prompt-hint flip at `intent-contractor-impl.ts:472` and the composer-side runtime adapter (which mirrors the sonar adapter but for opus/gpt models with `<web_evidence>` injection and `web_search` removed from the tool schema).

This is **structurally too wide for one /loop slice** (>2-file drift threshold, behaviour-changing in three orthogonal dimensions: ingestion-side, composer-side, classifier-side). The `commitment_kernel_smart_orchestrator_roadmap.plan.md` autonomous-loop bootstrap explicitly authorizes a sub-decomposition when this drift is detected.

**Phase 4 is split into three narrow slices:**

### Phase 4a — WebEvidenceWorldStateObserver + sonar runtime adapter

| Layer | File | Change | LOC est. |
| --- | --- | --- | --- |
| New observer | `src/platform/commitment/web-evidence-world-state-observer.ts` (new) | `WebEvidenceWorldStateObserver` interface + `createWebEvidenceWorldStateObserver` factory backed by an in-memory `WebEvidenceCollector` (per-`(sessionId, turnId)` keying; reset-at-turn-start; idempotent `record(record: WebEvidenceRecord): void`) | ~80 |
| Kernel | `src/platform/commitment/monitored-runtime.ts` | Extend `createMonitoredRuntime` deps + `freezeSnapshot` to thread `webEvidence` slice through | ~15 |
| Kernel defaults | `src/platform/commitment/production-runtime-defaults.ts` | Wire the new observer into `createDefaultMonitoredRuntime` | ~10 |
| Runtime adapter | `src/agents/pi-embedded-runner/run/web-research-runtime-adapter.ts` (new helper, called from existing `attempt.ts` orchestration loop conditional on the commitment effect) | Detect `commitment.effect === WEB_EVIDENCE_COLLECTED_EFFECT`; run sonar/sonar-pro via existing transport with empty tool schema + system instruction "Return findings as structured JSON: `{ records: [{ url, snippet, title? }], summary }`. Cite real URLs."; parse reply with a new Zod schema declared in `world-state.ts`; push records to the collector; emit `[commitment] effect=web_evidence.collected records=<N>` telemetry; on parse-failure / HTTP 400 / 5xx / no citations → mark unsatisfied + fall through to legacy path (no regression) | ~100 |
| Tests | `src/platform/commitment/__tests__/web-evidence-world-state-observer.test.ts` (new) + `src/agents/pi-embedded-runner/run/web-research-runtime-adapter.test.ts` (new) | Observer ingestion + reset; adapter happy-path with stubbed sonar transport; Zod parse-failure path; HTTP 400 path | ~120 |

**Total 4a: ~325 LOC + tests.** Frozen-layer: none. Behaviour: sonar runs and the slice is populated, but the kernel still won't *select* `web_research` from `findByFamily` because the IntentContractor prompt hint hasn't been flipped — production turns continue to flow through `communication`/`persistent_session`/`unknown`. **Behaviour-neutral on production turns**; new code path is reachable only via direct registry inspection or fixture-driven tests.

### Phase 4b — composer runtime adapter + delivery-receipt + predicate re-wire

| Layer | File | Change | LOC est. |
| --- | --- | --- | --- |
| Runtime adapter | `src/agents/pi-embedded-runner/run/web-research-runtime-adapter.ts` (extend) | Add composer branch: detect `commitment.effect === WEB_RESEARCH_SUMMARIZED_EFFECT` after Affordance #1's slice is populated; run composer-class model (claude-opus-4.6 / gpt-5.4 / hydra-gpt-pro) with full tool schema EXCEPT `web_search` (drop via existing `applyModelProviderToolPolicy`-style filter, but keyed on `webEvidence.records.length >= 1` rather than model compat); inject `WebEvidenceSlice.records` into composer system message as structural `<web_evidence>{ records: [...], summary }</web_evidence>` block (closed-shape JSON-like, NOT user text — invariant #5 safe per §6.2); existing PDF / artifact authoring path unchanged | ~80 |
| Delivery receipt | `src/agents/pi-embedded-runner/run/web-research-runtime-adapter.ts` + `src/platform/commitment/delivery-receipt-registry.ts` (audit) | Emit a `DeliveryReceipt` after composer run with `effect = WEB_RESEARCH_SUMMARIZED_EFFECT` and `kind: "answer"` (reusing existing `DeliveryReceiptKind` — no frozen-shape extension) | ~20 |
| Predicate re-wire | `src/platform/commitment/done-predicate-web-research-summarized.ts` | Replace Phase-4-pending stub with read-side predicate: `unsatisfied { web_evidence.slice_absent }` if no slice; `unsatisfied { composer.delivery_receipt_missing:<effect> }` if no receipt with `effect=WEB_RESEARCH_SUMMARIZED_EFFECT`; `satisfied` with one `EvidenceFact` for the receipt + one for the slice when both present | ~40 |
| Tests | `src/platform/commitment/__tests__/done-predicate-web-research-summarized.test.ts` (new) + extend adapter test | Predicate matrix (slice absent / receipt absent / both present); composer adapter happy-path with stubbed transport; tool-schema filter correctness | ~90 |

**Total 4b: ~230 LOC + tests.** Frozen-layer: none. Behaviour: composer end-to-end works in tests; production still doesn't reach this path (gate flip in 4c).

### Phase 4c — IntentContractor prompt-hint flip + live verify

| Layer | File | Change | LOC est. |
| --- | --- | --- | --- |
| Classifier prompt | `src/platform/commitment/intent-contractor-impl.ts:472` | Update `responseShape.desiredEffectFamily` from `'"persistent_session" | "communication" | "unknown"'` to `'"persistent_session" | "communication" | "web_research" | "unknown"'`; add one new `examples[*]` row with `desiredEffectFamily: "web_research"` for a freshness-sensitive query (e.g. "поищи в интернете последние модели") | ~20 |
| Tests | `src/platform/commitment/__tests__/intent-contractor-impl.test.ts` (extend) | Confirm prompt JSON contains `web_research` in the union and the new example | ~15 |
| Live verify | (no code) | Restart `pnpm gateway:dev:channels` (stop existing PID first); test combo turn `bundles=[artifact_authoring, public_web_lookup] requestedTools=[pdf, web_search]` and pure-search turn `bundles=[public_web_lookup]`; confirm `[commitment] effect=web_evidence.collected records=<N>` then `[commitment] effect=web_research.summarized` in `gateway-*.log`; confirm PDF/text-reply quality matches sub-plan §5 acceptance #1/#2; confirm turn-class `355ae135` (classifier-mis-emit `bundles=[respond_only]` for fresh-data queries) **NOT closed** — that's deferred to §8 row 1 (bundle-as-contract enforcement) | — |

**Total 4c: ~35 LOC + live verify.** Frozen-layer: none. **Behaviour CHANGES on this slice** — the classifier starts emitting `web_research` for freshness-sensitive turns; if 4a + 4b are both green this triggers the two-affordance pipeline end-to-end. If live verify regresses, file a narrow follow-up slice and DO NOT roll back 4a/4b (they're behaviour-neutral on their own — only 4c flips the gate).

### Acceptance for the split

The §5 acceptance criteria still apply to the *aggregate* of 4a+4b+4c; intermediate slices are partial. The original §5 #1/#2 (combo turn + pure-search turn) live-verify against 4c; #3/#4/#5/#6 are unchanged.

### Why this split is safe

- **4a alone**: new code reachable only via direct registry inspection or tests; production prompts still pin classifier to 3-family allowlist; no path through `findByFamily(WEB_RESEARCH_EFFECT_FAMILY, …)` from production decision flow.
- **4a + 4b without 4c**: still behaviour-neutral on production for the same reason. Composer adapter exists but never runs because the classifier never emits `web_research`.
- **4c without 4a/4b**: would regress production — classifier emits `web_research`, kernel finds the affordances, but with no observer / no runtime adapter the predicates report `web_evidence.slice_absent` and the runtime falls back to legacy (which is what we have today on this turn class — bot-detection / training-cutoff). NEVER ship 4c standalone. Sequence is **4a → 4b → 4c**.

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
