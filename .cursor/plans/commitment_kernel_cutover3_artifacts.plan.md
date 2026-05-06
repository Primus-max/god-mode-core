---
name: Cutover-3 — Artifact effects routing through AffordanceRegistry
slice: cutover-3-artifacts
status: in_progress
signoff: GRANTED via blanket authorization 2026-05-05 (memory feedback_signoff_blanket_authorization.md)
overview: "Cutover-3 routes artifact-bound effects (PDF authoring, DOCX authoring, code-patch, image_generate img2img) through the commitment-kernel `AffordanceRegistry` (slice cutover-2 precedent — `communication` family), introducing a new `artifact` effect-family with `create`/`observe`/`update` operationKinds, four new affordances (`pdf.created`, `docx.created`, `code_patch.applied`, `image.created`), corresponding done-predicates over a NEW `WorldStateSnapshot.artifacts` slice (read-only artifact registry), and the production wiring at `runTurnDecision.cutoverPolicy` so artifact turns become first-class kernel-routed (productionDecision !== legacyDecision). Bug #2 from the 2026-05-06 live test (image_generate does NOT pass user-attached reference image into Hydra `/images/edits` despite the tool wrapper supporting `image`/`images` params) is closed structurally by the new `image.created` affordance preconditions: when an inbound `media/inbound/*` attachment is observed AND `desiredEffectFamily=artifact` AND `target.kind=artifact`, the affordance binds the attachment as a precondition value the runtime adapter passes to the tool's `image:` arg verbatim — the model is no longer required to remember the path. Slice closes (or unblocks) bug #2 in the 2026-05-06 forward queue (handoff doc `HANDOFF-2026-05-06-policy-gate-cutover3.md`); structurally fixes PDF/DOCX/code-patch routing as a side-effect."
todos:
  - id: cutover3-phase-1-audit
    content: "Phase 1 — Audit (read-only). Output `extensions/AUDIT-cutover3-artifacts.md`. Map: (a) every existing artifact-producing tool (`src/agents/tools/pdf-tool.ts`, `src/agents/tools/docx-tool.ts`, `src/agents/tools/image-generate-tool.ts`, `src/agents/tools/canvas-tool.ts`, apply_patch via `src/agents/agent-command.ts`) and the producer registry mapping at `src/platform/produce/registry.ts:67` (DeliverableKind→toolName) — confirm it remains the source of truth and is NOT redefined by this slice. (b) every place `desiredEffectFamily=artifact` is plausibly classified today by `IntentContractor` (`intent-contractor-impl.ts` prompt) — semantic-intent already has `TargetRef.kind: \"artifact\"` (frozen-layer; no change needed). (c) Bug #2 root-cause line: `image-generate-tool.ts` already has `image`/`images` schema params + `loadReferenceImages` machinery + `runtime.ts:169` passes `inputImages` to the provider; so the bug is upstream — find the path from a TG attachment under `media/inbound/*` to the model context (system-prompt enumeration / pi-embedded message history / `agent-command.ts` documents flow at lines ~534–587) and confirm that NEITHER the prompt enumerates inbound image paths NOR an explicit precondition binds them to the tool call. (d) confirm `EpisodicEffectFamily` at `src/platform/memory/episodic-memory-event.ts:35` already includes `\"artifact\"` and `ArtifactCreatedPayload` (slice E typed-but-inert STUB); slice cutover-3 lights this slot up by adding the EMIT site in Phase 5 — no discriminated-union extension needed (additive payload-shape sufficient). (e) confirm `WorldStateSnapshot` slices (`src/platform/commitment/world-state.ts`) — current slices: `sessions`, `deliveries`, `webEvidence`. NEW `artifacts` slice required (Phase 3). (f) **CRITICAL** — `EFFECT_FAMILY_REGISTRY` at `src/platform/commitment/effect-family-registry.ts:23–48` does NOT yet contain an `\"artifact\"` family. Phase 2 extends additively (cutover-2 precedent: `communication` was added the same way). (g) `cutoverPolicy` at `src/platform/commitment/cutover-policy.ts:30` (CUTOVER_2) does NOT yet contain artifact effect ids — Phase 3 amendment adds `pdf.created` / `docx.created` / `code_patch.applied` / `image.created`. (h) `IntentContractor` prompt-hint at `intent-contractor-impl.ts:472` (per master §0 row 2026-05-02 / Phase 4c) currently allows 3 families (`persistent_session`, `communication`, `web_research`); flipping to include `artifact` is a **separate prompt-hint change** in Phase 8 live-verify, NOT in Phase 2 — preserves Search-Composer 4c's flip-discipline (classifier prompt edits are gated on the runtime-adapter being live first)."
    status: pending
  - id: cutover3-phase-2-effect-family-and-payload-shapes
    content: "Phase 2 — Extend `EFFECT_FAMILY_REGISTRY` additively with one new family. NEW constant `ARTIFACT_EFFECT_FAMILY = \"artifact\" as EffectFamilyId` in `effect-family-registry.ts`. NEW entry: `{ id: ARTIFACT_EFFECT_FAMILY, displayName: \"Artifact authoring\", allowedOperationKinds: [\"create\", \"observe\", \"update\"] satisfies OperationHintKind[] }` — `update` covers code-patch (patching an existing workspace artifact) and image-edit (img2img reference); `observe` covers \"summarize this PDF\" / \"describe this image\" turns. NO new precondition ids (preconditions are introduced in Phase 4 alongside affordances). NEW `EffectId` constants: `PDF_CREATED_EFFECT = \"pdf.created\"`, `DOCX_CREATED_EFFECT = \"docx.created\"`, `CODE_PATCH_APPLIED_EFFECT = \"code_patch.applied\"`, `IMAGE_CREATED_EFFECT = \"image.created\"`. Tests: `effect-family-registry.test.ts` extended (+~6 cases): `Object.isFrozen(EFFECT_FAMILY_REGISTRY)` + push throws + `artifact` family present exactly once + `allowedOperationKinds` set === expected exactly. Frozen layer: `effect-family-registry.ts` is INSIDE `src/platform/commitment/` — additive extension only (cutover-2 PR-#104 precedent for `communication` family). 5 frozen contracts byte-identical."
    status: pending
  - id: cutover3-phase-3-world-state-artifacts-slice
    content: "Phase 3 — Add `WorldStateSnapshot.artifacts` slice (read-only artifact registry). NEW shape `ArtifactRecord = { artifactId: string, kind: \"pdf\" | \"docx\" | \"code_patch\" | \"image\", path: string, mimeType: string, sizeBytes?: number, sourcePaths?: readonly string[], producedAt: string }` in `src/platform/commitment/world-state.ts`. NEW `ArtifactsSlice = { records: readonly ArtifactRecord[] }`. Extend `WorldStateSnapshot` with optional `artifacts?: ArtifactsSlice` (additive — backward-compat per cutover-2 `deliveries` slice precedent). NEW process-scoped `ArtifactWorldStateObserver` (mirrors `delivery-receipt-registry.ts` + `WebEvidenceWorldStateObserver` from Search-Composer Phase 4a PR-#130) with per-(sessionId, turnId) keying, last-writer-wins on `artifactId`, `perTurnLimit=8`. The observer is wired into `createDefaultMonitoredRuntime` over the process registry. **Read source**: existing artifact persistence already lives under `src/platform/artifacts/service.ts` + `src/platform/registry/artifact-store.ts`; the observer READS through these via a thin adapter — does NOT introduce a parallel store. Tests: `world-state.test.ts` extended; new `artifact-world-state-observer.test.ts` (round-trip; per-turn reset; limit enforcement; sessionId isolation). Frozen layer: `world-state.ts` is INSIDE `src/platform/commitment/` — additive extension only."
    status: pending
  - id: cutover3-phase-4-affordance-registry-extend
    content: "Phase 4 — Add four affordances under the new `artifact` effect-family. NEW `requiredPreconditions` ids: `PDF_RENDERER_AVAILABLE_PRECONDITION = \"pdf_renderer_available\" as PreconditionId`, `IMAGE_GENERATION_PROVIDER_AVAILABLE_PRECONDITION = \"image_generation_provider_available\" as PreconditionId`, `INBOUND_IMAGE_REFERENCE_AVAILABLE_PRECONDITION = \"inbound_image_reference_available\" as PreconditionId`. NEW affordances in `affordance-registry.ts`: (1) `PDF_CREATED_AFFORDANCE_ENTRY` — effect=`PDF_CREATED_EFFECT`, target matcher: `kind === \"artifact\" || kind === \"workspace\"`, requiredPreconditions=`[PDF_RENDERER_AVAILABLE_PRECONDITION]`, requiredEvidence=`[{kind:\"artifact.created\", mandatory:true}]`, allowedConstraintKeys=`[\"sourcePaths\",\"templatePath\",\"language\",\"pageCount\"]`, riskTier=\"low\", defaultBudgets={ maxLatencyMs: 120_000, maxRetries: 1 } (cf. bug #3 — PDF subagent hardcoded 2000ms is in `policy_gate_full` scope, not here; this slice sets the affordance budget but does NOT alter the subagent's hardcoded value), observerHandle={ id: \"artifact_world_state\" }, donePredicate=`pdfCreatedPredicate`. (2) `DOCX_CREATED_AFFORDANCE_ENTRY` — effect=`DOCX_CREATED_EFFECT`, target matcher: `kind === \"artifact\" || kind === \"workspace\"`, requiredPreconditions=`[]`, requiredEvidence=`[{kind:\"artifact.created\", mandatory:true}]`, allowedConstraintKeys=`[\"templatePath\",\"variables\",\"language\"]`, riskTier=\"low\", defaultBudgets={maxLatencyMs: 90_000, maxRetries:1}, observerHandle={id:\"artifact_world_state\"}, donePredicate=`docxCreatedPredicate`. (3) `CODE_PATCH_APPLIED_AFFORDANCE_ENTRY` — effect=`CODE_PATCH_APPLIED_EFFECT`, target matcher: `kind === \"workspace\"`, operationKinds=[\"update\"], requiredEvidence=`[{kind:\"artifact.created\", mandatory:true}]`, allowedConstraintKeys=`[\"workspaceId\",\"patchSizeLimit\"]`, riskTier=\"medium\" (workspace mutation), defaultBudgets={maxLatencyMs: 60_000, maxRetries:0}, observerHandle={id:\"artifact_world_state\"}, donePredicate=`codePatchAppliedPredicate`. (4) `IMAGE_CREATED_AFFORDANCE_ENTRY` — effect=`IMAGE_CREATED_EFFECT`, target matcher: `kind === \"artifact\" || kind === \"workspace\" || kind === \"external_channel\"`, requiredPreconditions=`[IMAGE_GENERATION_PROVIDER_AVAILABLE_PRECONDITION]` (the `INBOUND_IMAGE_REFERENCE_AVAILABLE_PRECONDITION` is OPTIONAL — present when img2img, absent when from-scratch generation; selection happens in Phase 6). Allowed constraint keys: `[\"sourcePaths\",\"size\",\"aspectRatio\",\"resolution\",\"style\",\"count\",\"referenceMode\"]`. RiskTier=\"low\", defaultBudgets={maxLatencyMs: 60_000, maxRetries:1}, observer/predicate as above. NEW done-predicates: `done-predicate-pdf-created.ts`, `done-predicate-docx-created.ts`, `done-predicate-code-patch-applied.ts`, `done-predicate-image-created.ts` — each reads `ctx.stateAfter.artifacts?.records` for a record whose `kind` matches the family AND whose `artifactId` was emitted via `expectedDelta.artifacts?.added[]`. Closed missing-key set per predicate (slice E precedent: `artifacts.slice_absent` / `artifacts.records.empty` / `artifact_record_missing:<id>`). NEVER throws. Frozen layer: `affordance-registry.ts` is INSIDE `src/platform/commitment/` — additive entries only (cutover-2 precedent). Tests: `affordance-registry.test.ts` extended; `affordance-resolution.test.ts` covers `findByFamily(\"artifact\", target, op)` returning the right candidate set per target/op shape; per-predicate test files + invariant #9 sentinel-proxy assertions per file."
    status: pending
  - id: cutover3-phase-5-runtime-adapter-and-emit-sites
    content: "Phase 5 — Runtime adapter + emit sites OUTSIDE the frozen layer. NEW file `src/agents/pi-embedded-runner/run/artifact-runtime-adapter.ts` (cf. `web-research-runtime-adapter.ts` from Search-Composer 4a/4b) with helpers: `recordArtifactCreated({ runtime, sessionId, turnId, kind, path, mimeType, sourcePaths?, sizeBytes?, artifactId? })` — appends to the `ArtifactWorldStateObserver` AND emits the matching `ExpectedDelta.artifacts.added` so done-predicates resolve. Closed failure set: `transport_error` / `path_missing` / `kind_unsupported` / `observer_unavailable`. NEW emit sites at the FOUR existing tools (each tool calls `recordArtifactCreated(...)` after successful execution; tool surfaces themselves are NOT moved into `src/platform/commitment/`): `pdf-tool.ts` (after `materializeArtifact(...)` returns success), `docx-tool.ts` (after final write), `image-generate-tool.ts` (after `saveMediaBuffer(...)`; carries `sourcePaths` from `loadedReferenceImages` on img2img path so the observer record includes the inbound reference for downstream auditability), `agent-command.ts` apply_patch path (after patch successfully applied). NEW `recordArtifactOnCommitmentSatisfied.ts` sibling of `memory-write-on-satisfied.ts` (slice E P5 PR-#169) + `task-write-on-satisfied.ts` (slice F P5 PR-#185): on `attestation.commitmentSatisfied === true` AND `effectFamily === \"artifact\"`, emit `EpisodicMemoryEvent { effectFamily: \"artifact\", payload: ArtifactCreatedPayload }` — slice E typed-but-inert slot is now LIT. Wired through the existing `memory-wiring.ts` fan-out helper (slice F precedent for adding new hook into the same `onAttestation` fanout). Defense-in-depth: artifact-write failure is logged warn + commitment STILL satisfies (artifact tracking does NOT gate the kernel — same posture as memory + task hooks). **Frozen-layer integrity**: `artifact-runtime-adapter.ts` lives in `src/agents/pi-embedded-runner/run/` (NOT in `src/platform/commitment/`); the four tool files modify their existing emit sites only. Hook lives outside frozen layer. Tests: `artifact-runtime-adapter.test.ts` (round-trip; closed failure set; fail-first), per-tool emit-site assertions (real tool execution against tmp-dir, observer assertions), `record-artifact-on-commitment-satisfied.test.ts` (11 cases mirroring slice E P5 / slice F P5 shape: happy, reverse `commitmentSatisfied=false`, defensive flag-missing, anonymous session, missing memoryStore, payload contract verbatim, failure isolation, three reverse-tests for non-artifact families)."
    status: pending
  - id: cutover3-phase-6-image-generate-img2img-bug2-fix
    content: "Phase 6 — Bug #2 closure: route inbound TG image attachments into `image_generate` as a reference image WITHOUT requiring the model to remember the path. **Architecture**: when `desiredEffectFamily === \"artifact\"` AND target.kind ∈ {artifact, workspace, external_channel} AND there is at least one inbound media path under `media/inbound/*` from the current turn (resolved via the existing `documents` flow at `agent-command.ts:534–587`), the new `IMAGE_CREATED_AFFORDANCE_ENTRY`'s preconditions resolve `INBOUND_IMAGE_REFERENCE_AVAILABLE_PRECONDITION` to a structured value `{ paths: readonly string[] }`. The runtime adapter (Phase 5 `artifact-runtime-adapter.ts`) carries this into the `image_generate` tool call by injecting `image: paths[0]` (single ref) or `images: paths` (multi-ref) into the tool args BEFORE the model formulates its call. **Critical**: this is NOT a model-prompt edit; it is a structural pre-binding analogous to how the Search-Composer specialist injects `<web_evidence>` BEFORE the composer LLM runs (slice Search-Composer 4b PR-#131). Per invariants #5/#6, the precondition resolver reads STRUCTURED inbound media metadata (path + MIME type), NEVER raw user text. The `IntentContractor` is the only reader of raw text (invariant #6) — it classifies `desiredEffectFamily=artifact` AND emits `constraints.referenceMode = \"img2img\"` when its prompt observes the structured `<inbound_attachments>` block (NEW in this slice, mirroring the existing `<web_evidence>` and `<memory>` precedent). The `<inbound_attachments>` block injection happens INSIDE `intent-contractor-impl.ts` (frozen-layer ADDITIVE constructor extension, cutover-2 / slice E P6 precedent: optional `inboundMediaResolver?: () => InboundMediaSummary`); existing 2-arg callers compile + behave byte-identical. **Hydra primary stays `hydra/gpt-5.4`** (input_modalities=[\"text\",\"image\"]) — img2img passes the reference through Hydra `/v1/images/edits` exactly as the existing `provider.generateImage({ inputImages })` path already does (`src/image-generation/runtime.ts:169`). NO change to provider transport — the bug is structural binding, not transport. Tests: positive img2img — turn with one inbound JPG produces an `image.created` artifact with `sourcePaths` containing the inbound path; reverse-test — same turn with `inboundMediaResolver` omitted (or returning empty) → `IMAGE_CREATED_AFFORDANCE_ENTRY` selected via the from-scratch precondition path (no img2img, no `image:` arg injection); reverse-test — non-artifact family + inbound image → no precondition resolution, no `image:` injection (stays per current behaviour). Frozen-layer: `intent-contractor-impl.ts` constructor extension ADDITIVE only (cutover-2 / slice E P6 / slice F P6 pattern); 5 frozen contracts byte-identical."
    status: pending
  - id: cutover3-phase-7-code-patch-route
    content: "Phase 7 — Code-patch routing through `CODE_PATCH_APPLIED_AFFORDANCE_ENTRY`. Production-routing flip for `code_patch.applied` via `cutoverPolicy` allow-list extension (per cutover-2 PR-#104 pattern). `CODE_PATCH_APPLIED_EFFECT` added to `CUTOVER_2` array. Caller wiring: existing `apply_patch` tool at `agent-command.ts` already produces a workspace mutation; emit site from Phase 5 records the artifact; the cutover gate now derives `productionDecision=kernel-derived` for `code_patch.applied` turns when (a) `desiredEffectFamily=artifact`, (b) `target.kind=workspace`, (c) operation.kind=update, (d) commitmentSatisfied=true. Risk tier `medium` triggers PolicyGate evaluation (cutover-2 minimum gate already in place: `channel_disabled`/`no_credentials`); deeper PolicyGate stages (approvals, budgets, role-based) are explicitly OUT OF SCOPE and remain in `commitment_kernel_policy_gate_full.plan.md`. Tests: production-routing contract test (mirrors `run-turn-decision.cutover2.test.ts`) — `productionDecision !== legacyDecision` on cutover-eligible code_patch.applied turn with successful runtime attestation; bit-identical legacy fallback when cutover-off. Frozen layer: `cutover-policy.ts` allow-list extension only (additive, cutover-2 precedent)."
    status: pending
  - id: cutover3-phase-8-acceptance-and-live-verify
    content: "Phase 8 — Acceptance + Telegram live-verify. NEW `src/platform/commitment/__tests__/cutover3-artifacts.acceptance.test.ts` (5 cases): (1) JPG attachment → `сделай PDF из этого эскиза` → kernel-derived productionDecision for pdf.created turn, observer records artifact, ledger emits `ArtifactCreatedPayload`. (2) DOCX template attachment → `сделай КП по этому шаблону` → kernel-derived productionDecision for docx.created turn. (3) JPG attachment + img2img prompt → image.created turn with `sourcePaths` non-empty. (4) Reverse: omit inbound attachment, image.created turn falls through to from-scratch generation (no `image:` injection). (5) Reverse: cutover-off → legacy decision for all four families. **Live-verify (REQUIRED — invariants #4 + #15 + handoff doc «не делать «зелёные unit-тесты» как доказательство»)**: gateway restart → operator sends 3 prompts in real Telegram per HANDOFF-2026-05-06 (JPG→PDF, DOCX→DOCX-from-template, JPG→img2img); live-verifier agent parses `C:/tmp/openclaw/openclaw-<date>.log` and asserts: (a) `[commitment] artifact.* effectFamily=...` log lines fire (NOT `[task-classifier] classified=...`); (b) `[artifact-runtime-adapter] recordArtifactCreated kind=pdf|docx|image path=...` lines present; (c) for img2img turn: `[image-generate] inputImages count=1` + `[hydra] /v1/images/edits` request ID logged; (d) `[memory-write-on-satisfied] effectFamily=artifact wrote=true` line present (slice E `artifact` slot now LIT); (e) Telegram `[telegram] sendDocument ok` (PDF/DOCX) + `[telegram] sendPhoto ok` (image); (f) zero `Provider finish_reason: error` lines. **IntentContractor prompt-hint flip** (`intent-contractor-impl.ts:472` — currently 3-family allowlist {persistent_session, communication, web_research}): Phase 8 flips the allowlist to include `artifact` — this is the same pattern Search-Composer 4c uses (PR-#138/#140/#141/#142/#143/#144/#145 sequence). Standalone in this phase per the established pattern: classifier prompt edit happens AFTER runtime adapter is live (Phase 5) AND affordances resolve (Phase 4) AND production routing is wired (Phase 7) — flipping prematurely would regress turns into legacy bot-detection paths."
    status: pending
isProject: false
---

# Cutover-3 — Artifact effects routing through AffordanceRegistry

## 0. Provenance

| Field | Value |
| --- | --- |
| Sub-plan of | `.cursor/plans/commitment_kernel_v1_master.plan.md` (§0 forward-queue row 2026-05-06: bug #2 image_generate img2img maps to this slice; §8.5.1 cutover-3 / cutover-4 sequencing) |
| Sub-plan slice id | `cutover-3-artifacts` |
| Status | `in_progress` |
| Maintainer signoff | **GRANTED** via blanket authorization 2026-05-05 (`memory: feedback_signoff_blanket_authorization.md` — Vladimir granted blanket maintainer-signoff for v1 commitment-kernel slices on 2026-05-05; HANDOFF-2026-05-06 §"ЖЁСТКИЕ ОГРАНИЧЕНИЯ" line «НЕ задавай мне вопросов по signoff»). NO per-phase signoff queries. |
| Inherits | 16 hard invariants from `.cursor/rules/commitment-kernel-invariants.mdc` |
| Predecessors | Cutover-1 (PR-4a #103 — `persistent_session.created` flip; merged 2026-04-28). Cutover-2 (PR-4b #104 — `communication` family; merged 2026-04-28). Slice D (identity, PRs #146-#151). Slice E (memory, PRs #154/#156/#160/#165/#168/#169/#170/#172). Slice F (TaskLedger, PRs #181-#187). Slice I (sanitizer, PRs #152/#157/#161/#162/#166 + revert #174 + #175 wrapper temp-disabled). Search-Composer (effect-family additive extension precedent — PR-#127; affordance additive extension precedent — PR-#128; world-state slice additive extension precedent — PR-#129/#130; runtime adapter precedent — PR-#130/#131; classifier prompt-hint flip precedent — PR-#138/#140/#141/#142/#143/#144/#145). |
| Trigger | 2026-05-06 live test surfaced bug #2 (`image_generate` does not pass user-attached reference image into Hydra `/images/edits` despite the tool wrapper supporting `image`/`images` params). Master plan §0 row 2026-05-06 maps this to cutover-3 — the architectural fix is to bind inbound media as a structural precondition through the AffordanceRegistry, NOT to add per-provider hacks (HANDOFF-2026-05-06 §"ЖЁСТКИЕ ОГРАНИЧЕНИЯ" line «НЕ писать костыли per-provider»). The slice ALSO unlocks PDF/DOCX/code-patch first-class kernel routing as a side-effect — closing the cutover-3 step in the v1 release roadmap. |
| Out of scope | (a) Bug #1 (`closure-outcome-dispatcher` false-positive «bootstrap pending») → `commitment_kernel_policy_gate_full.plan.md`. (b) Bug #3 (PDF subagent hardcoded `timeoutMs=2000`) → `commitment_kernel_policy_gate_full.plan.md` (budget/retry policy lives in PolicyGate Stage 4). (c) Bug #4 (per-channel `streaming:"off"` partials leak) → Slice I Phase 7 standalone follow-up. (d) Cutover-4 (`repo_operation.completed` — broader workspace mutation, requires full PolicyGate); this slice scopes `code_patch.applied` only as a narrow `artifact` family member. (e) Concurrent broker (PR-MT) — separate roadmap step. (f) IntentContractor freshness/recency constraint extension. (g) Modifying the 5 frozen contracts. (h) `IntentContractor` prompt-hint allowlist flip beyond the `artifact` family addition (Search-Composer 4c remains a separate slice for `web_research`). (i) Live verification against Slack/Discord (those are deferred sanitizer surfaces; cutover-3 acceptance is Telegram-only per the handoff prompt list). |

## 1. Hard invariants this slice keeps

- **#1**: `ExecutionCommitment` stays tool-free. The new affordances reference effect ids and target shapes, NOT tool names. Tool→effect mapping lives in the runtime adapter (Phase 5), NOT in the affordance.
- **#2**: New affordances are selected by (effect + target + preconditions + policy + budgets) only. No phrase matching anywhere in the resolution path. The img2img path (Phase 6) is gated by a STRUCTURED precondition (`INBOUND_IMAGE_REFERENCE_AVAILABLE_PRECONDITION`) that reads inbound-media metadata, never raw user text.
- **#3**: Production success requires `commitmentSatisfied(...) === true`. Done-predicates over `WorldStateSnapshot.artifacts` slice (Phase 3) are the gate.
- **#4**: Success requires at least one observed state-after fact. The artifact-record observer (Phase 3) is the read-side; the runtime adapter (Phase 5) is the write-side. Per invariant #9, predicates see only `state`/`delta`/`receipts`/`trace`.
- **#5, #6**: No new readers of raw user text. The contractor change in Phase 6 (optional `inboundMediaResolver?` constructor dep) reads STRUCTURED inbound-media metadata — paths + MIME types, never raw text. The `<inbound_attachments>` block in the contractor prompt is built INSIDE `intent-contractor-impl.ts` (the only invariant #6-sanctioned reader), mirroring slice E `<memory>` and Search-Composer `<web_evidence>` precedents.
- **#7**: ShadowBuilder accepts `SemanticIntent` only. New affordances live downstream of the contractor; ShadowBuilder is unchanged.
- **#8**: `src/platform/commitment/` does NOT import from `src/platform/decision/`. The Phase 5 hook (`recordArtifactOnCommitmentSatisfied`) lives in `src/agents/pi-embedded-runner/run/`, the established bridge boundary (slice E P5, slice F P5). The runtime adapter (`artifact-runtime-adapter.ts`) likewise lives in `src/agents/pi-embedded-runner/run/`.
- **#9, #10**: No new done-predicates outside the per-affordance file pattern. Each predicate lives on the affordance, sees `state`/`delta`/`receipts`/`trace` only, and uses a closed missing-key set (slice E precedent: `web_evidence.slice_absent` etc.) to surface diagnostics without exfiltrating raw text.
- **#11**: 5 frozen contracts (`TaskContract`, `OutcomeContract`, `QualificationExecutionContract`, `ResolutionContract`, `RecipeRoutingHints`) are NOT touched. The frozen-layer touches (`effect-family-registry.ts`, `affordance-registry.ts`, `cutover-policy.ts`, `world-state.ts`, `intent-contractor-impl.ts`) are all ADDITIVE — same pattern as cutover-2 PR-#104 (which extended the same files for `communication` family). `TargetRef.kind: "artifact"` already exists in `semantic-intent.ts:10` — NO discriminated-union widening required.
- **#12**: No emergency phrase patches. The img2img fix (Phase 6) is a structural binding via preconditions, not a regex.
- **#13**: `terminalState` is orthogonal to `acceptanceReason`; both populated by the runtime adapter (Phase 5) on artifact emit.
- **#14**: `ShadowBuildResult` typed as `{ kind: 'commitment'; ... } | { kind: 'unsupported'; reason }` — unchanged.
- **#15**: Maintainer signoff GRANTED via blanket 2026-05-05 (no per-phase queries). Live verify in Telegram is REQUIRED at Phase 8 — green CI alone is INSUFFICIENT proof per HANDOFF-2026-05-06 §"ЖЁСТКИЕ ОГРАНИЧЕНИЯ" line «НЕ делать «зелёные unit-тесты» как доказательство. Только live verify в Telegram».
- **#16**: `EffectFamilyId` and `EffectId` distinct branded types preserved. The four NEW `EffectId` constants (`PDF_CREATED_EFFECT` etc.) are constructed via `as EffectId` cast at module init exactly as `WEB_EVIDENCE_COLLECTED_EFFECT` is in PR-#127.

## 2. Audit findings (TO BE FILLED IN BY PHASE 1)

> Phase 1 produces `extensions/AUDIT-cutover3-artifacts.md` with concrete line-anchored findings; the sketches below are starting points, not conclusions.

### 2.1. Existing artifact-producing surfaces (sketch)

The audit must enumerate every artifact-producing tool and confirm the producer registry mapping is the single source of truth:

- `src/agents/tools/pdf-tool.ts` — PDF authoring (anthropic-native, gemini-native, fallback). Pre-existing `materializeArtifact(...)` call → success path is the candidate emit site for Phase 5.
- `src/agents/tools/docx-tool.ts` — DOCX authoring. Audit confirms current emit shape.
- `src/agents/tools/image-generate-tool.ts` — image generation, including img2img via `inputImages`. Already accepts `image`/`images` schema params + has `loadReferenceImages` machinery + passes `inputImages` to provider (line 730 + `runtime.ts:169`). Bug #2 root-cause is upstream — model is not given the inbound path.
- `src/agents/agent-command.ts` apply_patch path — workspace mutation; emit site for `code_patch.applied`.
- `src/platform/produce/registry.ts:67` — `REGISTRY` array maps `(DeliverableKind, format) → toolName`. Source-of-truth for tool selection; cutover-3 does NOT redefine.

### 2.2. `EFFECT_FAMILY_REGISTRY` extension (sketch)

`src/platform/commitment/effect-family-registry.ts:23–48` currently has 4 entries: `persistent_session`, `communication`, `web_research`, `unknown`. NEW `artifact` family added additively — same shape as cutover-2's `communication` extension (PR-#104).

### 2.3. `EpisodicEffectFamily` slot already exists (audit confirmation)

`src/platform/memory/episodic-memory-event.ts:35` — discriminated union ALREADY contains `"artifact"` member with `ArtifactCreatedPayload` type defined at lines 92–99 (slice E typed-but-inert STUB). Cutover-3 lights this slot up — no discriminated-union extension needed. The `assertNeverEpisodicEventInput` exhaustiveness guard already enumerates the variant; the Phase 5 hook simply adds the EMIT site.

### 2.4. `WorldStateSnapshot` artifacts slice (sketch)

`src/platform/commitment/world-state.ts` currently has slices `sessions`, `deliveries`, `webEvidence`. NEW `artifacts` slice. The shape mirrors `WebEvidenceSlice` from PR-#129 (read-only record list, per-(sessionId, turnId) keying).

### 2.5. `cutoverPolicy` allow-list (sketch)

`src/platform/commitment/cutover-policy.ts:30` `CUTOVER_2` currently lists 4 effects. Phase 3 amendment extends to `CUTOVER_3` (or extends `CUTOVER_2` in place — audit decides which name is canonical post-merge per the cutover-2 naming pattern).

### 2.6. `IntentContractor` prompt-hint allowlist (sketch)

`intent-contractor-impl.ts:472` (Search-Composer 4c flip site) currently allows `{persistent_session, communication, web_research}`. Phase 8 adds `artifact` — separate phase per the established Search-Composer 4c discipline (classifier prompt edit happens AFTER runtime adapter + affordances + production routing are live).

### 2.7. Bug #2 root cause (sketch)

`image-generate-tool.ts` schema accepts `image` and `images` reference args; `loadReferenceImages` resolves paths under sandboxed media; `runtime.ts:169` passes `inputImages` to the provider; the provider hits Hydra `/v1/images/edits` correctly. **The bug is upstream**: nothing in the model context surfaces the inbound `media/inbound/*` paths from the current TG turn, AND nothing pre-binds them to the tool args. Per invariants #5/#6 the fix is structural, not a prompt-edit: bind the path through a precondition resolver. See Phase 6.

### 2.8. Hydra modality routing constraint (CRITICAL)

Per HANDOFF-2026-05-06: primary stays `hydra/gpt-5.4` (input_modalities=["text","image"]). Switching to `claude-opus-4.6` through Hydra returns input_modalities=["text"] only — img2img would silently degrade. **Slice cutover-3 does NOT change model configuration.** The fix routes the reference through the existing `hydra/gpt-5.4` → `/v1/images/edits` path that already works at the transport layer; only the structural binding is missing.

## 3. Hypothesis

The cutover-3 slice is shaped by FOUR forces:

1. **Cutover-2 precedent** (PR-#104) — established the additive-extension pattern for new effect-families, affordances, world-state slices, cutoverPolicy allow-list, and PolicyGate minimum reasons. Cutover-3 follows it field-for-field for the `artifact` family.
2. **Search-Composer precedent** (PRs #127–#145) — established the runtime-adapter-outside-frozen-layer + classifier-prompt-flip-as-final-phase pattern. Cutover-3 mirrors the phasing.
3. **Slice E typed-but-inert slot** — `EpisodicEffectFamily` `"artifact"` and `ArtifactCreatedPayload` are already defined; cutover-3 adds the EMIT site (analogous to slice F P5 lighting up `task.*`).
4. **Bug #2 architectural shape** — preconditions in the AffordanceRegistry are designed exactly for "the runtime needs to pre-bind a structural value before tool execution"; the inbound-image path is a textbook precondition, not a prompt instruction.

Thus the slice ships:

- **Phase 1** — Audit, with deliverable `extensions/AUDIT-cutover3-artifacts.md` (line-anchored).
- **Phase 2** — `EFFECT_FAMILY_REGISTRY` additive extension (`artifact`, 4 effect ids).
- **Phase 3** — `WorldStateSnapshot.artifacts` slice + `ArtifactWorldStateObserver`.
- **Phase 4** — Four affordances + four done-predicates.
- **Phase 5** — Runtime adapter + emit sites at the 4 tools + `recordArtifactOnCommitmentSatisfied` hook (lights slice E artifact slot).
- **Phase 6** — Bug #2 closure: img2img through structural precondition + `<inbound_attachments>` block in IntentContractor.
- **Phase 7** — Code-patch routing via cutoverPolicy extension.
- **Phase 8** — Acceptance fixture + Telegram live-verify + IntentContractor prompt-hint flip to include `artifact` family.

Each phase is independently testable; Phases 2–4 can run in parallel after Phase 1; Phases 5–7 depend on Phases 2–4; Phase 8 depends on all preceding.

## 4. Acceptance criteria

1. **`artifact` effect-family** registered in `EFFECT_FAMILY_REGISTRY` with `allowedOperationKinds=["create","observe","update"]`. `Object.isFrozen` reverse-test passes; push throws.
2. **Four new affordances** (`pdf.created`, `docx.created`, `code_patch.applied`, `image.created`) registered in `affordance-registry.ts`. `findByFamily("artifact", target, op)` returns the correct candidate per target/op shape. Branching factor on `artifact` family > 1 (cutover-2 G6.a structural canary preserved).
3. **`WorldStateSnapshot.artifacts`** slice present and populated by `ArtifactWorldStateObserver` on every successful artifact-tool execution. Per-(sessionId, turnId) keying; `perTurnLimit=8`.
4. **Done-predicates** read structured `state`/`delta`/`receipts`/`trace` only; closed missing-key set; never throw; reverse-test for invariant #9 sentinel-proxy.
5. **Production-routing flip**: for cutover-eligible artifact effect ids (all four), `productionDecision !== legacyDecision` when (a) `desiredEffectFamily=artifact`, (b) commitment satisfies, (c) cutover-on. Bit-identical legacy fallback when cutover-off.
6. **Bug #2 closure**: Phase 6 acceptance test — turn with one inbound JPG attachment + `desiredEffectFamily=artifact` + `target.kind ∈ {artifact, workspace, external_channel}` produces an `image.created` artifact whose `sourcePaths` is non-empty AND the runtime adapter passes `image:` arg to `image_generate` tool. Reverse-test: omit attachment → from-scratch generation, no `image:` injection.
7. **Slice E `artifact` slot LIT**: `recordArtifactOnCommitmentSatisfied` hook emits `EpisodicMemoryEvent { effectFamily: "artifact", payload: ArtifactCreatedPayload }` on `commitmentSatisfied=true`. Memory layer cross-references new artifacts by `IdentityId`.
8. **Frozen-layer integrity**: 16 invariants reverse-tests pass on slice-cutover-3 HEAD. Touches inside `src/platform/commitment/` are ALL additive (no signature change to existing exports; `intent-contractor-impl.ts` constructor extension follows slice E P6 / slice F P6 / cutover-2 PR-#104 pattern). 5 frozen contracts byte-identical.
9. **Hydra modality preservation**: primary stays `hydra/gpt-5.4`; img2img path uses existing `provider.generateImage({ inputImages })` → `/v1/images/edits` transport unchanged. NO model-config edits in this slice.
10. **Telegram live-verify**: gateway restart + 3 prompts (JPG→PDF, DOCX→DOCX-from-template, JPG→img2img) succeed end-to-end; live-verifier agent confirms log-line evidence per Phase 8 spec.

## 5. Per-phase tests + log-line evidence + Telegram acceptance

Each phase's tests must:

- **Fail-first.** Negative test reproduces absence-of-functionality before the fix. Local proof: revert the change, test fails on the spec'd assertion (not on a `NoMethodError` or import error).
- **No `vi.spyOn` on the function under test.** Use real registries / observers / runtime adapters (in-memory or tmp-dir). Spies reserved for non-deterministic infrastructure (clock, randomness) AND for verifying that hooks called into injected DEPS — those are spies on DEPS, not on the function under test.
- **Cover the negative case explicitly.** Each phase: (a) malformed input rejected by Zod, (b) missing precondition value → no-op (NOT throw), (c) backend failure → degrade gracefully (warn + skip), (d) state-machine illegal transition rejected.
- **Each phase must produce log-line evidence**, NOT just unit-test greens. HANDOFF-2026-05-06 §"ЖЁСТКИЕ ОГРАНИЧЕНИЯ" line: «НЕ делать «зелёные unit-тесты» как доказательство. Только live verify в Telegram».

Per-phase specifics:

### Phase 1 (audit)

- Deliverable: `extensions/AUDIT-cutover3-artifacts.md` markdown only.
- `pnpm exec tsgo --noEmit` clean (read-only).

### Phase 2 (effect-family extension)

- Tests: `effect-family-registry.test.ts` extended (~6 cases): registry frozen; `artifact` present exactly once; `allowedOperationKinds` exact; new `EffectId` constants distinct from existing.
- Log-line evidence: NONE (data-only change; production behaviour unchanged).
- Acceptance: gate-runner reports `pnpm exec tsgo --noEmit` exit 0; targeted vitest 6/6.

### Phase 3 (world-state artifacts slice)

- Tests: `world-state.test.ts` schema round-trip; new `artifact-world-state-observer.test.ts` (~10 cases: round-trip, per-turn reset, limit enforcement, sessionId isolation, last-writer-wins on `artifactId`, malformed reject).
- Log-line evidence: NONE in production behaviour yet (observer wired to `createDefaultMonitoredRuntime` but no production caller invokes it until Phase 5).
- Acceptance: targeted vitest green; observer instance reachable from `defaultMonitoredRuntime`.

### Phase 4 (affordance registry + done-predicates)

- Tests: `affordance-registry.test.ts` extended (4 new entries; `findByFamily` candidate sets per shape); new `done-predicate-pdf-created.test.ts`, `done-predicate-docx-created.test.ts`, `done-predicate-code-patch-applied.test.ts`, `done-predicate-image-created.test.ts` (each ~8 cases incl. invariant #9 sentinel-proxy).
- Log-line evidence: NONE (registry-only; production routing not yet flipped).
- Acceptance: targeted vitest green; ShadowBuilder smoke test still passes for non-artifact families (regression guard).

### Phase 5 (runtime adapter + emit sites + memory hook)

- Tests: `artifact-runtime-adapter.test.ts` (round-trip; closed failure set; sandbox media path); per-tool emit-site assertions for pdf-tool, docx-tool, image-generate-tool, agent-command apply_patch path (real tool execution against tmp-dir + observer assertions); `record-artifact-on-commitment-satisfied.test.ts` (11 cases mirroring slice E P5 / slice F P5).
- Log-line evidence (production wiring landed but cutover policy NOT yet flipped — observed via `gateway-cutover3-p5.log` smoke):
  - `[artifact-runtime-adapter] recordArtifactCreated kind=<pdf|docx|image|code_patch> path=<...>`
  - `[memory-write-on-satisfied] effectFamily=artifact wrote=true` (slice E `artifact` slot now LIT — this is the first time this line appears on `dev`)
- Acceptance: smoke gateway restart; one `pdf` tool turn produces both log lines; targeted vitest green; `pi-embedded-runner` regression baseline pre-existing-failure count unchanged.

### Phase 6 (img2img bug #2 fix)

- Tests:
  - Positive img2img: turn with one inbound JPG → `image.created` artifact with `sourcePaths` containing the inbound path; `image:` arg present in tool invocation.
  - Reverse: same turn with `inboundMediaResolver` omitted (or returning empty) → no `image:` injection; from-scratch generation.
  - Reverse: non-artifact family + inbound image → no precondition resolution.
  - Frozen-layer regression: existing 2-arg `createIntentContractor(...)` callers compile + behave byte-identical.
- Log-line evidence (NEW — first time visible on `dev`):
  - `[intent-contractor] inbound_attachments_block injected paths=<n>` (NEW; mirrors `[intent-contractor] memory_block_injected entries=<n>` from slice E P6)
  - `[image-generate] inputImages count=1 referenceMode=img2img`
  - `[hydra] /v1/images/edits request_id=<...>` (existing transport line — confirms reference reached Hydra)
- Telegram acceptance prompt: «(JPG attachment) сделай PDF из этого эскиза» and «(JPG attachment) сделай этот эскиз более ярким» (img2img). Live-verifier asserts the full log chain + Telegram delivers `sendDocument`/`sendPhoto` ok.

### Phase 7 (code-patch routing)

- Tests: production-routing contract test (mirrors `run-turn-decision.cutover2.test.ts`) — `productionDecision !== legacyDecision` on cutover-eligible `code_patch.applied` turn with successful runtime attestation; bit-identical legacy fallback when cutover-off; cutover-policy reverse-test extended.
- Log-line evidence:
  - `[run-turn-decision] cutover gate effect=code_patch.applied decision=kernel acceptanceReason=...`
  - `[artifact-runtime-adapter] recordArtifactCreated kind=code_patch ...`
- Acceptance: smoke turn applying a one-line patch produces both log lines + `productionDecision=kernel` in trace.

### Phase 8 (acceptance + Telegram live-verify + classifier prompt flip)

- Tests: `cutover3-artifacts.acceptance.test.ts` (5 cases: JPG→PDF, DOCX→DOCX-template, JPG→img2img, omit-attachment reverse, cutover-off reverse).
- IntentContractor prompt-hint flip: `intent-contractor-impl.ts:472` allowlist gains `artifact`. Tests: contractor 1-shot fixture turn for «(JPG attachment) сделай PDF из этого эскиза» produces `desiredEffectFamily=artifact` AND `target.kind=artifact` AND `constraints.referenceMode="img2img"` when the JPG inbound block is present (structural query — no raw text matched).
- **Telegram live-verify (REQUIRED — gateway restart)**:
  1. «привет» → expect ≤5s answer (smoke).
  2. «запомни X» → /new → «что я запомнил?» → expect memory recall (slice E baseline).
  3. (JPG attachment) «сделай PDF из этого эскиза» → expect Telegram `sendDocument` PDF ≤120s.
  4. (DOCX attachment) «сделай КП по этому шаблону» → expect Telegram `sendDocument` DOCX ≤90s.
  5. (JPG attachment) «сделай этот эскиз более ярким» → expect Telegram `sendPhoto` ≤60s; live-verifier confirms `[image-generate] inputImages count=1 referenceMode=img2img` + `[hydra] /v1/images/edits` log lines.
- Log-line evidence per turn (live-verifier asserts):
  - `[commitment] artifact.<created|applied> effectFamily=artifact decision=kernel productionDecision !== legacyDecision`
  - `[artifact-runtime-adapter] recordArtifactCreated kind=<pdf|docx|image|code_patch> path=...`
  - For img2img: `[image-generate] inputImages count=1 referenceMode=img2img` + `[hydra] /v1/images/edits request_id=...`
  - `[memory-write-on-satisfied] effectFamily=artifact wrote=true`
  - Telegram delivery: `[telegram] sendDocument ok` (PDF/DOCX) or `[telegram] sendPhoto ok` (image)
  - Zero `Provider finish_reason: error` lines across all 5 turns.

## 6. Implementation notes

- **New module path**: NONE. The slice does NOT introduce a new `src/platform/<x>/` module; it ADDITIVELY extends existing surfaces (`effect-family-registry`, `affordance-registry`, `cutover-policy`, `world-state`, `intent-contractor-impl`) and adds a runtime adapter + hook outside the frozen layer (`src/agents/pi-embedded-runner/run/`).
- **Frozen-layer touches** (all additive, cutover-2 PR-#104 precedent): `effect-family-registry.ts` (Phase 2), `affordance-registry.ts` (Phase 4), `cutover-policy.ts` (Phase 3 + Phase 7), `world-state.ts` (Phase 3), `intent-contractor-impl.ts` (Phase 6 — optional `inboundMediaResolver?` constructor dep ADDITIVE; Phase 8 — prompt-hint allowlist line edit).
- **NO frozen-contract changes**: 5 frozen contracts byte-identical. `TargetRef.kind: "artifact"` already exists at `semantic-intent.ts:10` — no discriminated-union widening.
- **Hook lives outside frozen layer**: `recordArtifactOnCommitmentSatisfied.ts` lives in `src/agents/pi-embedded-runner/run/`, sibling to slice E's `memory-write-on-satisfied.ts` (PR-#169) and slice F's `task-write-on-satisfied.ts` (PR-#185). Wired through `memory-wiring.ts` fan-out (slice F precedent — `onAttestation` callback dispatches to memory + task + artifact hooks from a single seam).
- **Producer registry NOT redefined**: `src/platform/produce/registry.ts:67` REGISTRY remains the single source of truth for `(DeliverableKind, format) → toolName`. The new affordances do NOT duplicate this; they reference effect ids only (invariant #1).
- **Hydra primary stays `hydra/gpt-5.4`**: NO model configuration edit in this slice. Slice cutover-3 only adds structural binding (preconditions); the existing `provider.generateImage({ inputImages })` → `/v1/images/edits` transport already works.
- **Per-tool emit-site discipline**: each of the 4 tools (pdf, docx, image_generate, apply_patch) gains ONE call to `recordArtifactCreated(...)` after successful execution. NO change to tool surface, schema, or auth. NO new tool wrappers.
- **Memory cross-reference**: `recordArtifactOnCommitmentSatisfied` writes `EpisodicMemoryEvent { effectFamily: "artifact", payload: ArtifactCreatedPayload }` keyed on `IdentityId` (slice D). Slice K's reminder query («какой PDF я делал на прошлой неделе?») will read this slot in a future slice.
- **Defense-in-depth (#15)**: artifact-write failure is `warn` + commitment STILL satisfies. Same posture as slice E memory hook + slice F task hook. Artifact tracking is observability, NOT gating.
- **NO per-provider hacks** (HANDOFF-2026-05-06 §"ЖЁСТКИЕ ОГРАНИЧЕНИЯ" line «НЕ писать костыли per-provider»): the img2img fix is a structural precondition binding through the AffordanceRegistry, NOT a regex on user prompts and NOT a wrapper around the Hydra payload. Anthropic-thinking-wrapper PR #175 (currently temp-disabled) is the anti-pattern this slice must NOT replicate.
- **Anti-checklist (cutover-3-specific scope creep guards)**:
  - Approvals/budgets/role-based PolicyGate: STOP, surface to user → `commitment_kernel_policy_gate_full.plan.md`.
  - PDF subagent timeout fix: STOP → `commitment_kernel_policy_gate_full.plan.md` (budgets in PolicyGate Stage 4).
  - Slack/Discord live-verify: STOP → cutover-3 acceptance is Telegram-only.
  - Modifying `~/.openclaw-dev/openclaw.json` or `~/.openclaw/openclaw.json` wholesale: STOP — only Edit on specific lines, backup first (HANDOFF-2026-05-06 §"ЖЁСТКИЕ ОГРАНИЧЕНИЯ" line «НИКОГДА не править … wholesale»).
  - Switching primary model away from `hydra/gpt-5.4`: STOP — Hydra `claude-opus-4.6` returns `input_modalities=["text"]`, breaks img2img silently.

## 7. Maintainer signoff

**GRANTED** via blanket authorization 2026-05-05 (`memory: feedback_signoff_blanket_authorization.md`). Vladimir's standing delegation: «НЕ ЖДИ ОТ МЕНЯ РЕВЬЮ на пр, сам делай». Per-phase signoff queries are EXPLICITLY suppressed by HANDOFF-2026-05-06 §"ЖЁСТКИЕ ОГРАНИЧЕНИЯ" line «НЕ задавай мне вопросов по signoff». Auto-merge via `gh pr merge --admin --squash --delete-branch` per PR.

## 8. Commit / PR convention

Per phase, single PR squash-merged via admin:
- Branch: `feat/v1-cutover3-phase-<n>-<topic>`
- Commit subject: `feat(slice-cutover3): phase <N> — <topic>`
  - Example: `feat(slice-cutover3): phase 2 — extend EFFECT_FAMILY_REGISTRY with artifact family`
  - Example: `feat(slice-cutover3): phase 6 — bind inbound image as img2img precondition (closes bug #2)`
- PR body: phase id + acceptance bullets + log-line evidence + frozen-layer-integrity note + targeted vitest counts.
- Phase 1 audit PR: `docs(slice-cutover3): phase 1 — audit deliverable`.

## 9. Handoff Log

### 2026-05-06 — Sub-plan kickoff

- Sub-plan written by Plan-agent per HANDOFF-2026-05-06 §"ДЕЙСТВИЯ ПО ПОРЯДКУ" step 2.
- Predecessors confirmed: Slice D, E, F, I COMPLETE on `dev` SHA `0c71dd8e36` (post PR-#191). Cutover-2 (PR-#104) provides the additive-extension pattern. Search-Composer phases 1–4c provide the runtime-adapter + classifier-prompt-flip phasing template.
- Maintainer signoff: GRANTED (blanket 2026-05-05). NO per-phase queries.
- Forward queue: this sub-plan + `commitment_kernel_policy_gate_full.plan.md` run in parallel per HANDOFF-2026-05-06 §"ДЕЙСТВИЯ ПО ПОРЯДКУ" step 3.
- Branch for Phase 1: `audit/v1-cutover3-phase-1`.

### 2026-05-06 — Phase 1 audit (TBD by handoff-writer after merge)

| Phase | Date | PR | Squash SHA | Notes |
| --- | --- | --- | --- | --- |
| Phase 1 audit | TBD | TBD | TBD | TBD |
| Phase 2 effect-family | TBD | TBD | TBD | TBD |
| Phase 3 world-state slice | TBD | TBD | TBD | TBD |
| Phase 4 affordances + predicates | TBD | TBD | TBD | TBD |
| Phase 5 runtime adapter + emit sites | TBD | TBD | TBD | TBD |
| Phase 6 img2img bug #2 fix | TBD | TBD | TBD | TBD |
| Phase 7 code-patch routing | TBD | TBD | TBD | TBD |
| Phase 8 acceptance + live-verify + classifier flip | TBD | TBD | TBD | TBD |

## 10. Adjacent / deferred (out of scope)

| Item | Why deferred |
| --- | --- |
| Bug #1 closure-outcome-dispatcher false-positive «bootstrap pending» | `commitment_kernel_policy_gate_full.plan.md` PolicyGate Stage 2-6 (approvals) |
| Bug #3 PDF subagent hardcoded `timeoutMs=2000` | `commitment_kernel_policy_gate_full.plan.md` PolicyGate Stage 4 (budgets) |
| Bug #4 per-channel `streaming:"off"` partials leak | Slice I Phase 7 standalone follow-up |
| Cutover-4 (`repo_operation.completed`) | Requires full PolicyGate; cutover-3 narrow-scopes `code_patch.applied` only |
| Bug A.2 streaming buffering | Slice I follow-up |
| Slice H Phase 5 (stress) + Phase 6 (live-verify) | Non-blockers for v1 demo |
| Search-Composer Phase 4c `web_research` allowlist flip | Separate slice; cutover-3 only flips for `artifact` family |
| Concurrent broker (PR-MT) | Roadmap §6 row 4 — separate v2 slice |
| Bundle-as-contract enforcement at LLM schema layer | Roadmap §8 row 1 — separate slice |
| IntentContractor freshness/recency constraint extension | Roadmap §8 row 2 — separate slice |
| Slack/Discord live-verify | Cutover-3 acceptance is Telegram-only; Slack/Discord deferred to slice I follow-up |
| OAuth-mediated cross-tenant artifact registry | v2 |
| Artifact-redaction-on-recall (PII sanitizer over PDF/DOCX content) | Slice I sanitizer is the single sanitizer surface; this slice produces plain-text artifacts; sanitizer wraps on the way out per channel policy |
| Unifying `extensions/feishu/src/docx*.ts` Feishu DOCX surface with the new `docx.created` affordance | Different layer; out of scope for v1 |
| `recordArtifactOnCommitmentSatisfied` consumed by slice K reminder query («какой PDF я делал?») | Slice K — out of scope for cutover-3 |

## 11. References

- HANDOFF: `.cursor/plans/HANDOFF-2026-05-06-policy-gate-cutover3.md`
- Master plan: `.cursor/plans/commitment_kernel_v1_master.plan.md` (§0 row 2026-05-06; §8.5.1)
- Roadmap: `.cursor/plans/commitment_kernel_v1_release_roadmap.plan.md`
- Hard invariants: `.cursor/rules/commitment-kernel-invariants.mdc`
- Cutover-2 sub-plan (structural template): `.cursor/plans/commitment_kernel_pr4_chat_effects_cutover.plan.md` (Wave B, PR-#104)
- Search-Composer phasing template: `.cursor/plans/commitment_kernel_search_composer_pipeline.plan.md`
- Slice E sub-plan (slice template): `.cursor/plans/commitment_kernel_memory_layer.plan.md`
- Slice F sub-plan (slice template): `.cursor/plans/commitment_kernel_task_ledger.plan.md`
- Slice I sub-plan (sanitizer): `.cursor/plans/commitment_kernel_reply_sanitizer.plan.md`
- AffordanceRegistry: `src/platform/commitment/affordance-registry.ts`
- EFFECT_FAMILY_REGISTRY: `src/platform/commitment/effect-family-registry.ts`
- WorldState: `src/platform/commitment/world-state.ts`
- CutoverPolicy: `src/platform/commitment/cutover-policy.ts`
- IntentContractor: `src/platform/commitment/intent-contractor-impl.ts`
- TargetRef (frozen-but-already-has-`artifact`): `src/platform/commitment/semantic-intent.ts:10`
- EpisodicEffectFamily artifact slot (typed-but-inert): `src/platform/memory/episodic-memory-event.ts:35`, `ArtifactCreatedPayload` lines 92–99
- Slice E memory hook precedent: `src/agents/pi-embedded-runner/run/memory-write-on-satisfied.ts` (PR-#169)
- Slice F task hook precedent: `src/agents/pi-embedded-runner/run/task-write-on-satisfied.ts` (PR-#185)
- Search-Composer runtime adapter precedent: `src/agents/pi-embedded-runner/run/web-research-runtime-adapter.ts` (PR-#130/#131)
- Memory wiring fan-out helper: `src/platform/decision/memory-wiring.ts`
- image_generate tool: `src/agents/tools/image-generate-tool.ts` (already accepts `image`/`images` ref args; bug #2 is upstream binding)
- Image generation runtime: `src/image-generation/runtime.ts:169` (already passes `inputImages` to provider; transport is fine)
- pdf-tool: `src/agents/tools/pdf-tool.ts`
- docx-tool: `src/agents/tools/docx-tool.ts`
- Producer registry (source of truth): `src/platform/produce/registry.ts:67`
- AGENTS.md test discipline: "Tests must catch real bugs" section.
