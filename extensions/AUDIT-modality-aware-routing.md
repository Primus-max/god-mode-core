# NEW-A — Modality-aware routing audit (Phase 1, read-only)

**Sub-plan:** `.cursor/plans/commitment_kernel_modality_aware_routing.plan.md`
**Phase:** 1 (audit, read-only deliverable)
**Predecessor:** dev SHA `2d3d79a7ee` (post PR-#213 — five sub-plans merged: NEW-A/B/C/D + cutover-4)
**Maintainer signoff:** GRANTED via blanket authorization 2026-05-05
**Frozen-layer touch:** none (markdown-only)
**Live evidence:** `C:\tmp\openclaw\openclaw-2026-05-06.log` lines L164 / L750 / L2865 (and L2389 contrast).

This audit maps the existing structural surfaces required for the modality-aware-routing fix in
phases 2-6. All findings are line-anchored against `dev@2d3d79a7ee`. No source code is modified.

---

## §a. Exact site of `route candidates ordered:` log line

**File:** `src/agents/model-fallback.ts` — function `runWithModelFallback<T>(params)`.

The log emission lives at **`src/agents/model-fallback.ts:732-734`**, inside the function body
that begins at `src/agents/model-fallback.ts:657`:

```ts
// model-fallback.ts:732-734
log.info(
  `route candidates ordered: ${candidates.map((candidate) => `${sanitizeForLog(candidate.provider)}/${sanitizeForLog(candidate.model)}`).join(" -> ")}`,
);
```

Order-of-operations inside `runWithModelFallback(...)`:

| Step | Site | Effect |
| --- | --- | --- |
| 1. Catalog load | `model-fallback.ts:691` — `const modelCatalog = params.cfg ? await loadModelCatalog({ config: params.cfg }) : [];` | Catalog already in scope at the filter site. |
| 2. Base candidates | `model-fallback.ts:692-697` — `resolveFallbackCandidates(...)` | Reads cfg + fallbacks override. |
| 3. Preflight | `model-fallback.ts:704-715` — `applyModelRoutePreflight(...)` (skipped when `skipRoutePreflight === true`) | May reorder. |
| 4. Final candidate list | `model-fallback.ts:716` — `const candidates = preflight.candidates;` | Single source-of-truth array. |
| 5. **`preflightMode:` log** | `model-fallback.ts:721-727` | Operator anchor. |
| 6. Debug preflight log | `model-fallback.ts:729-731` | Decision summary. |
| 7. **`route candidates ordered:` log** | `model-fallback.ts:732-734` | **Insertion point for modality filter must be BEFORE this log.** |

The Phase 5 wiring spec calls for inserting `filterCandidatesByModality(...)` **between step 4
(`const candidates = preflight.candidates;`) and step 7 (the `route candidates ordered:` log)**, so
that the log shows the FINAL ordered survivor list. The catalog from step 1 is in scope and reused.

---

## §b. Every call site of `runWithModelFallback(...)`

Production code (non-test) call-sites (grep `runWithModelFallback` against `src/**`):

| Caller | Line | Purpose |
| --- | --- | --- |
| `src/agents/agent-command.ts:100` (import) `:1998` (call) | Top-level `agent` CLI command. |
| `src/auto-reply/reply/agent-runner-execution.ts:7` (import) `:313` (call) | **Production NEW-A reproducer path** — auto-reply orchestrator's primary turn-execution. |
| `src/auto-reply/reply/followup-runner.ts:12` (import) `:296` (call) | Auto-reply follow-up turn (after primary completes). |
| `src/auto-reply/reply/agent-runner-memory.ts:6` (import) `:538` (call) | Memory-flush helper (background memory consolidation). |
| `src/cron/isolated-agent/run.ts:19` (import) `:476` (call) | Isolated cron-spawned agent run. |

All five callers match the spec list. Test-side mocks (e.g.
`src/test-utils/model-fallback.mock.ts`, `src/cron/isolated-agent/run.test-harness.ts:114`,
`src/auto-reply/reply/agent-runner.misc.runreplyagent.test.ts:35`) need the new optional
`turnModalityRequirements?` field; they pass `undefined` today and remain byte-identical
(regression guard for Phase 5).

The slice's actual call-site update (Phase 5) is `agent-runner-execution.ts` — the live NEW-A
reproducer. Other callers pass `undefined` and behave byte-identical until later sub-plans wire
them.

---

## §c. Existing `ModelCatalogEntry.input?: ModelInputType[]` surface

**File:** `src/agents/model-catalog.ts`.

### Type declaration

```ts
// model-catalog.ts:9
export type ModelInputType = "text" | "image" | "document";

// model-catalog.ts:26-42
export type ModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: ModelInputType[];      //  ← line 32 — the field driving Phase 4 filter
  output?: string[];
  type?: string;
  active?: boolean;
  supportsTools?: boolean;
  // ... (cost / status / architecture / quantization / ownedBy)
};
```

### Hydra population — `normalizeHydraCatalogInput`

`src/agents/model-catalog.ts:226-248`:

```ts
function normalizeHydraCatalogInput(params: {
  inputModalities?: string[];
  supportedFileTypes?: string[];
}): ModelInputType[] | undefined {
  const inputs = new Set<ModelInputType>();
  for (const modality of params.inputModalities ?? []) {
    if (modality === "text")  inputs.add("text");
    if (modality === "image") inputs.add("image");
    if (modality === "document" || modality === "file" || modality === "pdf") inputs.add("document");
  }
  for (const fileType of params.supportedFileTypes ?? []) {
    if (fileType === "pdf" || fileType === "doc" || fileType === "docx" || fileType === "txt") {
      inputs.add("document");
    }
  }
  return inputs.size > 0 ? Array.from(inputs) : undefined;
}
```

Wired at `src/agents/model-catalog.ts:411` / `:421` — Hydra discovery loop reads
`model.input_modalities` from the upstream `/v1/models` payload and passes it through
`normalizeHydraCatalogInput`. The resulting `ModelCatalogEntry.input` is the live,
provider-agnostic capability declaration consumed in Phase 4.

### Hydra Opus capability — CRITICAL CONFIRMATION

There is **no static fixture** for `hydra/claude-opus-4.6` in this repo — Hydra's catalog is
discovered at runtime from the upstream `/v1/models` HTTP endpoint
(`src/agents/model-catalog.ts:396` `await modelsResponse.json()`). The audit therefore confirms
the capability indirectly via two complementary lines of evidence:

1. **Code path is sound.** `normalizeHydraCatalogInput` (lines 226-248) faithfully mirrors the
   provider's declared `input_modalities` array onto `ModelCatalogEntry.input`. If Hydra reports
   `input_modalities: ["text"]` for Opus, the catalog entry surfaces `input: ["text"]`. There is
   no path that fabricates `"image"` for Opus.
2. **Live behaviour is consistent with `input: ["text"]`.** The 2026-05-06 turn at L2865 sent an
   inbound JPG attachment, ordering placed Opus first, and the assistant's reply at L2867
   verbatim says: `"переключаюсь на GPT-5.4 для более точного распознавания изображения"` —
   "switching to GPT-5.4 for more accurate image recognition". This is the symptom of an
   image-incapable model being attempted first; it is consistent with (and only with) Hydra
   surfacing `input: ["text"]` for Opus.

If Phase 5 testing produces a runtime probe of `loadModelCatalog({ config })` against the live
Hydra deployment, the operator should snapshot `entry.input` for `id === "claude-opus-4.6"` to
make the capability declaration explicit. For the purposes of Phase 1 the audit treats Opus as
text-only and notes the conservative `undefined → ["text"]` posture from Phase 3 as the safety
net (catalog miss / catalog absent → conservative default).

### Other provider populations

- **Chutes** — `src/agents/chutes-models.ts` static fixture; sample lines `:33 input:["text"]`,
  `:78 input:["text","image"]`, `:114 input:["text","image"]`, etc. Both modalities present.
- **HuggingFace** — `src/agents/huggingface-models.ts:203-216` reads
  `entry.architecture?.input_modalities` and surfaces `Array<"text" | "image">`.
- **Local providers (kilocode + opt-in)** — `src/agents/model-catalog.ts:75-83` (config
  `models.providers.<name>.models[].input`) — operator-supplied; may be `undefined`.

This confirms the spec's claim that `input` is populated across providers but `undefined` is a
real possibility for some local entries — Phase 3 helper handles `undefined` as `["text"]`-only
(conservative default).

---

## §d. Catalog loaded inside `runWithModelFallback`

Confirmed at **`src/agents/model-fallback.ts:691`**:

```ts
const modelCatalog = params.cfg ? await loadModelCatalog({ config: params.cfg }) : [];
```

The catalog is already in scope from line 691 onward and threaded into `applyModelRoutePreflight`
at `:714` (`catalog: modelCatalog`). Phase 5 reuses the same `modelCatalog` reference at the
filter site — **zero additional load calls**, zero TTL contention.

`loadModelCatalog` itself (`src/agents/model-catalog.ts:441`) is cache-backed (60 s TTL —
`MODEL_CATALOG_CACHE_TTL_MS`), so even if Phase 5 pessimistically called it twice, the second
call would resolve from cache. Reuse keeps the implementation cleaner.

---

## §e. Existing `RecipePlannerInput.needsVision?: boolean`

**Type surface:** `src/platform/recipe/planner.ts:199-204`:

```ts
export type RecipeRoutingHints = {
  localEligible?: boolean;
  remoteProfile?: "cheap" | "code" | "strong" | "presentation";
  preferRemoteFirst?: boolean;
  needsVision?: boolean;          // ← line 203
};
```

Threaded into `RecipePlannerInput` via `routing?: RecipeRoutingHints` at
`src/platform/recipe/planner.ts:218`.

### Population today

`needsVision` is computed by `inferNeedsVision(...)` inside the resolution-contract layer at
**`src/platform/decision/resolution-contract.ts:128-138`**:

```ts
function inferNeedsVision(params: {
  fileNames: string[];
  requestedTools: string[];
  artifactKinds: string[];
}): boolean {
  return (
    params.requestedTools.includes("browser") ||
    params.fileNames.some((name) => VISION_ATTACHMENT_EXTENSION.test(name)) ||
    params.artifactKinds.some((kind) => kind === "image" || kind === "video")
  );
}
```

Called from `resolveRecipeResolution(...)` at `resolution-contract.ts:373`, then folded into the
`RecipeRoutingHints` at `:389-399` and surfaced through `routing.needsVision` at `:431`.

### Confirmation: `needsVision` is NOT populated from `inboundMediaResolver` data today

Grep `needsVision\s*=\s*true|needsVision:\s*true` across `src/**` returns ONLY:

- `src/platform/recipe/planner.test.ts:94, :290` — fixtures.
- `src/platform/decision/route-preflight.test.ts:152` — fixture.
- `src/platform/decision/resolution-contract.ts:431` — the `?:` propagation site.
- `src/platform/decision/input.test.ts:351, :358` — fixtures.

Production code never assigns `needsVision = true` directly; the value is wholly derived from
`fileNames` (filename-extension regex) + `requestedTools` (`browser`) + `artifactKinds`
(`image`/`video`). No call site reads `inboundMediaResolver` data and forwards an `image` kind
into `needsVision`.

Concretely: a Telegram turn with a JPG attachment whose filename is `photo_2026-05-06.jpg` will
hit `VISION_ATTACHMENT_EXTENSION.test(name)` and produce `needsVision: true` — but a turn whose
upstream filename has been stripped or normalized (or whose attachment is surfaced through
`InboundMediaSummary` without a vision-suffix filename) will produce `needsVision: false` even
though an image is structurally present. This is exactly the gap NEW-A's Phase 2 helper closes
via `inboundMediaSummary.attachments[].kind === "image"`.

`needsVision` therefore stays as a **defense-in-depth secondary signal** in
`deriveTurnModalityRequirements(...)` (Phase 2) — additive to the structural attachment check,
not authoritative.

---

## §f. `inboundMediaResolver()` surface

**File:** `src/platform/commitment/intent-contractor-impl.ts`.

### Type declarations (Cutover-3 Phase 6 closed shapes)

```ts
// intent-contractor-impl.ts:62
export type InboundMediaAttachmentKind = "image" | "pdf" | "docx" | "other";

// intent-contractor-impl.ts:77-82
export type InboundMediaAttachment = {
  readonly path: string;
  readonly mimeType: string;
  readonly kind: InboundMediaAttachmentKind;
  readonly sourceTurnId?: string;
};

// intent-contractor-impl.ts:92-94
export type InboundMediaSummary = {
  readonly attachments: readonly InboundMediaAttachment[];
};
```

Resolver seam declared at:

```ts
// intent-contractor-impl.ts:329
readonly inboundMediaResolver?: () => InboundMediaSummary | undefined;
```

Wired through the contractor deps at `:384` and the run-shim at `:603 / :609`. Test fixtures and
acceptance tests confirm the closed enum: `InboundMediaSummary` consumed at
`src/platform/commitment/__tests__/cutover3-artifacts.acceptance.test.ts:309 / :343`,
`src/platform/commitment/__tests__/inbound-image-reference-precondition-resolver.test.ts:28-119`.

Non-frozen consumers already in scope (read-only):

- `src/agents/agent-command.ts:55, :467, :473, :496, :524, :800` — gateway-side resolver
  construction (closure factory).
- `src/platform/decision/run-turn-decision.ts:22, :356` — decision-input wiring.
- `src/platform/decision/input.ts:35, :490` — decision-input shape.

The surface meets the spec exactly:

- Closed `kind` enum `"image" | "pdf" | "docx" | "other"`.
- Optional `sourceTurnId` for join-on-id (no raw text re-read).
- `readonly` everywhere (immutability discipline).
- Resolver returns `undefined | InboundMediaSummary` (no exception path).

### Phase 2 derivation rules (consumed by Phase 5)

Per the sub-plan §2.3 sketch:

| Inbound state | `ModalityRequirement` set |
| --- | --- |
| no resolver / `undefined` summary / empty `attachments` | `["text"]` |
| any `attachment.kind === "image"` | `["text", "image"]` |
| only `pdf` / `docx` / `other` | `["text"]` (document-mode handled by downstream tooling) |
| `desiredEffectFamily.startsWith("image_generation")` AND inbound image present | `["text", "image"]` (img2img) |
| pure text-to-image (no inbound image) | `["text"]` |
| `needsVision === true` (defense-in-depth) | `["text", "image"]` |

`text` is ALWAYS in the requirement set — every model the system selects must minimally accept
text input. Output is sorted (deterministic) for downstream comparison.

The Phase 2 helper consumes a structural `InboundMediaSummaryLike` LOCAL type — does not import
from `src/platform/commitment/` per invariant #8 defense-in-depth. The structural
duck-typed shape:

```ts
type InboundMediaAttachmentLike = {
  readonly kind: "image" | "pdf" | "docx" | "other";
};
type InboundMediaSummaryLike = {
  readonly attachments: readonly InboundMediaAttachmentLike[];
};
```

is byte-compatible with the frozen-layer type while keeping `src/agents/` import-clean.

---

## §g. Live evidence cross-check (`C:\tmp\openclaw\openclaw-2026-05-06.log`)

Three turns reproduce the NEW-A symptom — Opus appearing first in the candidate list when an
image (or image-bearing artifact recipe) is in scope.

### Turn 1 — L161-L168 (turn `56443d6f-b120-4437-997f-06090fe46597`, channel telegram, 2026-05-06T07:21:28Z)

```
L161: route preflight input: promptPresent=true plannerInputPresent=true promptLength=403 mode=default skipRoutePreflight=false candidates=hydra/claude-opus-4.6,hydra/gpt-5.4,hydra/sonar-pro,hydra/hydra-gpt-pro
L162: preflightMode: remote_required
L163: route preflight: decision=preflight_stronger_route eligible=false reordered=false first=hydra/claude-opus-4.6
L164: route candidates ordered: hydra/claude-opus-4.6 -> hydra/gpt-5.4 -> hydra/sonar-pro -> hydra/hydra-gpt-pro
```

Opus is first — image-bearing turn would silently drop the image. (Note: this turn's prompt is
short — 403 chars — but the candidate-ordering path is identical regardless of attachment
presence; the routing layer is currently modality-blind.)

### Turn 2 — L745-L750 (session `6dadf297`, doc_authoring recipe, 2026-05-06T08:44:48Z)

```
L746: planner selected: recipe=doc_authoring routingOutcome=matched:ranked contractFirst=true requiresTools=true requiresArtifactEvidence=true outcomeContract=structured_artifact toolBundles=[artifact_authoring] requestedTools=[docx_write,image_generate] intent=document
L747: route preflight input: candidates=hydra/claude-opus-4.6,hydra/gpt-5.4,hydra/sonar-pro,hydra/hydra-gpt-pro
L748: preflightMode: remote_required
L749: route preflight: decision=preflight_stronger_route eligible=false reordered=false first=hydra/claude-opus-4.6
L750: route candidates ordered: hydra/claude-opus-4.6 -> hydra/gpt-5.4 -> hydra/sonar-pro -> hydra/hydra-gpt-pro
```

Recipe `doc_authoring` requested both `docx_write` AND `image_generate` — the agent intends to
produce an embedded image inside a docx. Opus first means the image-generation tool reaches a
text-only adapter and the image step degrades. Same modality-blind ordering.

### Turn 3 — L2861-L2867 (turn `824a9040-fd33-4807-a275-22b1380cfe1d`, session `749782db`, channel telegram, 2026-05-06T15:51:45Z)

This is the **clearest reproduction** — direct user-attached image:

```
L2861: planner selected: recipe=ops_orchestration routingOutcome=matched:ranked contractFirst=true requiresTools=true outcomeContract=text_response toolBundles=[session_orchestration] requestedTools=[sessions_spawn] intent=general
L2862: route preflight input: candidates=hydra/gpt-5.4,hydra/claude-opus-4.6,hydra/gpt-5,hydra/gemini-2.5-pro
L2863: preflightMode: remote_required
L2864: route preflight: decision=preflight_reordered_remote_first eligible=false reordered=true first=hydra/claude-opus-4.6
L2865: route candidates ordered: hydra/claude-opus-4.6 -> hydra/gpt-5.4 -> hydra/gpt-5 -> hydra/gemini-2.5-pro
L2866: route preflight: Promoted hydra/claude-opus-4.6 ahead of local candidates for a tool-heavy artifact turn. first=hydra/claude-opus-4.6
L2867: [assistant-reply] runId=824a9040 lang=ru cyr=115 lat=3 head="Понял, переключаюсь на GPT-5.4 для более точного распознавания изображения. Сейчас займусь анализом вашей фотографии. Не..."
```

**Anatomy of the bug:**

1. Cfg-level fallbacks order BEGAN as `gpt-5.4, claude-opus-4.6, gpt-5, gemini-2.5-pro`
   (L2862) — gpt-5.4 (image-capable) was first.
2. `applyModelRoutePreflight` REORDERED the list (`reordered=true`, decision
   `preflight_reordered_remote_first`) and PROMOTED Opus to position 1 (L2864 / L2866).
3. Final ordered list at L2865 places `hydra/claude-opus-4.6` first.
4. The assistant reply at L2867 explicitly says it's switching TO GPT-5.4 "для более точного
   распознавания изображения" ("for more accurate image recognition") — i.e. the bot itself
   acknowledges Opus could not handle the image and is asking to retry with GPT-5.4. This is
   semantic confirmation that Opus is image-incompetent on Hydra.
5. The retry chain at L2872-L2874 indeed lands on a session-spawn that targets GPT-5.4
   ("Запускаю фоновую сессию с моделью GPT-5.4 для распознавания и обработки вашего
   изображения") — confirming the user's intent succeeds only after a manual hop.

This is precisely the symptom NEW-A closes: turn carries an image; cfg primary or
preflight-reorder places a text-only model first; runtime burns latency + UX before falling back.

### Contrast — L2386-L2389 (turn `4407441e`, 2026-05-06T14:14:31Z)

```
L2386: route preflight input: candidates=hydra/gpt-5.4,hydra/claude-opus-4.6,hydra/gpt-5,hydra/gemini-2.5-pro
L2389: route candidates ordered: hydra/gpt-5.4 -> hydra/claude-opus-4.6 -> hydra/gpt-5 -> hydra/gemini-2.5-pro
```

Same cfg primary order as L2862, but preflight kept gpt-5.4 first (decision
`preflight_no_local_candidate`, `reordered=false`). Ordering is INCIDENTAL — sometimes safe,
sometimes not. The ordering depends on heuristics that have no notion of attachment modality.
Capability-driven filtering is the only correct fix.

---

## §h. Decisions / open questions for Phase 2-6

1. **Filter site is unambiguous** — between `model-fallback.ts:716` (`const candidates = preflight.candidates;`) and `:732` (the `route candidates ordered:` log).
2. **Catalog reuse** — Phase 5 reuses the existing `modelCatalog` reference at line 691; no extra `loadModelCatalog` call needed.
3. **`undefined` catalog entry posture** — `modelCoversModalityRequirement` treats `entry.input === undefined` as `["text"]`-only (conservative). Reverse-test: any `audio` requirement against today's catalog returns `false` (typed-but-inert).
4. **Fail-open invariant** — when filtering would empty survivors, return UNFILTERED `candidates` and emit `modality_filter fail_open` log; never silently route to zero candidates (would produce `lastError: "no candidates"` regression).
5. **Defense-in-depth structural seam** — Phase 2's `InboundMediaSummaryLike` is locally declared in `src/agents/model-fallback-modality.ts`; no import from `src/platform/commitment/` (invariant #8).
6. **Non-blocking question for operator (informational only):** does the Hydra runtime catalog ever surface `entry.input === undefined` for any production-relevant model? If yes, those models would pass any image-only filter under the conservative posture — fail-open is sufficient but a follow-up runbook step could harden by treating `undefined` as `not_image_capable` once we confirm the catalog is reliable. Out of scope for this slice (typed-but-inert posture).
7. **Single production wiring site for Phase 5** — `agent-runner-execution.ts:313` is the live NEW-A reproducer. Other four callers pass `undefined` in Phase 5 and stay byte-identical (regression guard); they get wired in follow-up sub-plans.
8. **No per-provider hacks** — Phase 4 implementation MUST NOT contain any string match against `provider === "hydra"` or `model.startsWith("claude")`; capability-driven filter only.

---

## §i. Frozen-layer integrity

This audit is markdown-only — no source files modified. `pnpm exec tsgo --noEmit` is expected to
remain identical to baseline. The five frozen contracts (`TaskContract`, `OutcomeContract`,
`QualificationExecutionContract`, `ResolutionContract`, `RecipeRoutingHints`) and
`src/platform/commitment/**` source remain byte-identical.

The closest read-only reference into the frozen layer is the type shape of `InboundMediaSummary`
documented in §f. Phase 2 will introduce a structural `InboundMediaSummaryLike` LOCAL declaration
to keep `src/agents/model-fallback-modality.ts` import-clean (invariant #8 defense-in-depth).

---

## §j. References

- Sub-plan: `.cursor/plans/commitment_kernel_modality_aware_routing.plan.md`.
- Master plan: `.cursor/plans/commitment_kernel_v1_master.plan.md` (§0.5.6 row NEW-A).
- Hard invariants: `.cursor/rules/commitment-kernel-invariants.mdc`.
- Routing layer: `src/agents/model-fallback.ts:657-734`.
- Catalog surface: `src/agents/model-catalog.ts:9, :26-42, :226-248, :411-421, :441`.
- Inbound media surface: `src/platform/commitment/intent-contractor-impl.ts:62-94, :329`.
- Vision-flag derivation: `src/platform/decision/resolution-contract.ts:128-138, :373, :431`.
- Live evidence: `C:\tmp\openclaw\openclaw-2026-05-06.log` lines L161-L168 / L745-L750 / L2861-L2867 / L2386-L2389.
