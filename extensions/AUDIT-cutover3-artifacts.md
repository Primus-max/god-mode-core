# AUDIT — Cutover-3 Artifacts (Phase 1, read-only)

**Sub-plan**: `.cursor/plans/commitment_kernel_cutover3_artifacts.plan.md`
**Slice id**: `cutover-3-artifacts`
**Audit branch**: `audit/v1-cutover3-phase-1`
**Predecessor SHA**: `123010276e` (post PR-#192)
**Maintainer signoff**: GRANTED via blanket authorization 2026-05-05.
**Frozen-layer touches in this audit**: NONE (read-only markdown deliverable).

This document maps the source-of-truth state of every surface cutover-3 will modify and confirms each precondition stated in the sub-plan §1 and §2. Every finding is line-anchored against `dev` HEAD `123010276e`.

---

## §a. Existing artifact-producing tools + producer registry

### a.1 PDF authoring — `src/agents/tools/pdf-tool.ts`

- Tool emits PDF via `materializeArtifact(...)` at `src/agents/tools/pdf-tool.ts:863-869` (three call-sites for the anthropic-native, gemini-native, and fallback paths).
- After successful materialization the tool also calls `saveMediaBuffer(...)` at `src/agents/tools/pdf-tool.ts:904`.
- **Phase 5 emit-site target**: `recordArtifactCreated({...kind: "pdf", path, mimeType: "application/pdf"})` after the post-materialize success branch.

### a.2 DOCX authoring — `src/agents/tools/docx-tool.ts`

- `saveMediaBuffer(...)` at `src/agents/tools/docx-tool.ts:198` is the single artifact-write site.
- Imports `saveMediaBuffer` from `../../media/store.js` at `src/agents/tools/docx-tool.ts:3`.
- **Phase 5 emit-site target**: same call-site, `recordArtifactCreated({...kind: "docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"})`.

### a.3 Image generation — `src/agents/tools/image-generate-tool.ts`

- Schema params accept reference images:
  - `image: Type.Optional(... description: "Optional reference image path or URL for edit mode.")` at `src/agents/tools/image-generate-tool.ts:118-122`.
  - `images: Type.Optional(... description: \`Optional reference images for edit mode (up to ${MAX_INPUT_IMAGES}).\`)` at `src/agents/tools/image-generate-tool.ts:123-128`.
- `loadReferenceImages(...)` resolver at `src/agents/tools/image-generate-tool.ts:446-510+` walks each input string, supports `@`-prefixed file paths, `file://`, `data:`, and (when not sandboxed) `http(s)://`. Returns `{ resolvedImage, sourceImage }` pairs.
- Tool execution wires the resolved buffers into the provider call at `src/agents/tools/image-generate-tool.ts:658-670`:
  ```ts
  const imageInputs = normalizeReferenceImages(params);
  const loadedReferenceImages = await loadReferenceImages({ imageInputs, ... });
  const inputImages = loadedReferenceImages.map((entry) => entry.sourceImage);
  ```
- The provider receives `inputImages` at `src/image-generation/runtime.ts:169` (inside `generateImage(...)` provider call — the transport-layer plumbing is correct end-to-end).
- The output structured-payload echoes the resolved reference at `src/agents/tools/image-generate-tool.ts:761-772` (`paths`, `image`, `images` fields on the tool result), so the tool _already_ understands img2img semantics when `args.image` / `args.images` is populated.

### a.4 apply_patch (workspace mutation) — `src/agents/agent-command.ts`

- Patch staging + execution lives in the document-staging flow at `src/agents/agent-command.ts:1346-1354`. The tool itself is wired through the producer registry as `apply_patch` (see §a.5).
- **Phase 5 emit-site target**: after the patch successfully applies, `recordArtifactCreated({...kind: "code_patch", path: <workspace-relative patch file>, mimeType: "text/x-patch"})`.

### a.5 Producer registry — `src/platform/produce/registry.ts:67`

`REGISTRY` array at `src/platform/produce/registry.ts:67-195` (single source of truth for `(DeliverableKind, format) -> toolName + capabilityId + mimeType`). Relevant artifact mappings:

| kind | format | toolName | capabilityId | mimeType |
| --- | --- | --- | --- | --- |
| `image` | `png` | `image_generate` | — | `image/png` (`registry.ts:69-73`) |
| `image` | `jpg` | `image_generate` | — | `image/jpeg` (`registry.ts:74-79`) |
| `document` | `pdf` | `pdf` | `pdf-renderer` | `application/pdf` (`registry.ts:80-86`) |
| `document` | `docx` | `docx_write` | `docx-writer` | `application/vnd...wordprocessingml.document` (`registry.ts:87-94`) |
| `code_change` | `patch` | `apply_patch` | — | `text/x-patch` (`registry.ts:154-158`) |
| `code_change` | `edit` | `apply_patch` | — | `text/x-patch` (`registry.ts:166-170`) |

**Decision**: cutover-3 does NOT redefine this registry. The new affordances reference `EffectId` constants (`PDF_CREATED_EFFECT` etc.) only; tool→effect resolution lives entirely in the Phase 5 runtime adapter (`src/agents/pi-embedded-runner/run/artifact-runtime-adapter.ts`). Invariant #1 (`ExecutionCommitment` tool-free) preserved.

---

## §b. `IntentContractor` classification of `desiredEffectFamily=artifact`

### b.1 `TargetRef.kind: "artifact"` already exists (frozen layer, no change)

`src/platform/commitment/semantic-intent.ts:8-13`:

```ts
export type TargetRef =
  | { readonly kind: "session"; readonly sessionId?: SessionId }
  | { readonly kind: "artifact"; readonly artifactId?: string }    // line 10
  | { readonly kind: "workspace" }
  | { readonly kind: "external_channel"; readonly channelId?: ChannelId }
  | { readonly kind: "unspecified" };
```

`TargetRef.kind: "artifact"` is at line 10 of `semantic-intent.ts`. The discriminated union does NOT need extending; cutover-3's affordance matchers will check `target.kind === "artifact"` directly.

### b.2 `IntentContractor` prompt-hint allowlist — actual location is :771, NOT :472

The sub-plan references `intent-contractor-impl.ts:472`; that line is currently part of `maybeRecallActiveTasks` (slice F task-recall helper at `src/platform/commitment/intent-contractor-impl.ts:461-499`), not the prompt-hint. The actual prompt-hint allowlist for `desiredEffectFamily` is at `src/platform/commitment/intent-contractor-impl.ts:771`:

```ts
responseShape: {
  desiredEffectFamily: '"persistent_session" | "communication" | "unknown"',   // line 771
  target: {
    kind: '"session" | "artifact" | "workspace" | "external_channel" | "unspecified"',
    ...
  },
  ...
}
```

**Important caveat**: the response-shape string at line 771 currently lists ONLY `persistent_session | communication | unknown` (3 entries). The sub-plan §1 §2.6 said the current allowlist contains `{persistent_session, communication, web_research}` — that is **incorrect on `dev` HEAD `123010276e`**. `web_research` is exposed via the `familyDirectory` block (lines 760-763 + 809) sourced from `EFFECT_FAMILY_REGISTRY.map(...)`, but is NOT in the explicit `responseShape` example string.

**Phase 8 implication**: the prompt-hint flip is a single string-literal edit at `intent-contractor-impl.ts:771`. The sub-plan should clarify this — `web_research` is in the directory but not in the response-shape allowlist line; cutover-3 Phase 8 either (a) adds `artifact` only and leaves `web_research` to Search-Composer 4c, or (b) flips both at once. The sub-plan §1 §2.6 reads "Phase 8 adds `artifact` — separate phase" so option (a) is the intent.

### b.3 `EFFECT_FAMILY_REGISTRY` is consulted for the `familyDirectory` block

`intent-contractor-impl.ts:760-763`:

```ts
const familyDirectory = EFFECT_FAMILY_REGISTRY.map((entry) => ({
  id: entry.id,
  allowedOperationKinds: entry.allowedOperationKinds,
}));
```

Once Phase 2 adds `artifact` to `EFFECT_FAMILY_REGISTRY`, `familyDirectory` automatically picks it up — but the model is instructed at line 769 «Pick `desiredEffectFamily` from `familyDirectory[].id` only», so the response-shape allowlist string is the visible enum the model sees. **The Phase 8 prompt-hint edit is therefore strictly the line-771 string literal.**

---

## §c. Bug #2 root cause — inbound media path is text-only, never bound

### c.1 Telegram inbound attachment lifecycle

1. Gateway receives the TG message + attachment, hands `documents: [{ fileName, data: <base64> }]` to `agent-command.ts`.
2. `stageInboundDocuments({ workspaceDir, documents })` writes each attachment to `<workspaceDir>/media/inbound/<safeName>---<timestamp>-<index>.<ext>` and returns `{ fileNames, relativePaths, inlinePreviews }`. Source: `src/agents/agent-command.ts:537-568`.
3. The relative paths are appended to the prompt body via `appendInboundFilesContext(body, stagedDocuments.relativePaths, stagedDocuments.inlinePreviews)` at `src/agents/agent-command.ts:1346-1354`:

```ts
const stagedDocuments = await stageInboundDocuments({
  workspaceDir,
  documents: opts.documents ?? [],
});
body = appendInboundFilesContext(
  body,
  stagedDocuments.relativePaths,
  stagedDocuments.inlinePreviews,
);
```

### c.2 `appendInboundFilesContext` is the only propagation site — text-only

`src/agents/agent-command.ts:471-492`:

```ts
export function appendInboundFilesContext(
  message: string,
  relativePaths: string[],
  inlinePreviews: string[] = [],
): string {
  if (relativePaths.length === 0) {
    return message;
  }
  const attachmentBlock = [
    "Attached files available in workspace:",
    ...relativePaths.map((relativePath) => `- ${relativePath}`),
  ].join("\n");
  ...
  return `${message}\n\n${attachmentBlock}${previewInstruction}${previewBlock}`;
}
```

The function appends **plain text** of the form:

```
Attached files available in workspace:
- media/inbound/sketch---1746590000-0.jpg
```

to the user-message body. There is **NO** structured channel: no field on `BuildEmbeddedAgentRunParams`, no entry on `runtime.requestedTools`, no precondition resolver, and no tool-arg pre-binding. The model is the **only** reader of this block, and the only way the path reaches `image_generate` is if the LLM (a) notices the attachment line, (b) decides this is an img2img turn, (c) remembers the exact path, and (d) emits it as `image:` or `images:` in the tool call.

### c.3 Confirmation: NEITHER prompt enumeration NOR explicit binding to tool args

Searched `agent-command.ts` for any structured propagation of `relativePaths` past `appendInboundFilesContext`:

```
$ grep -n "stageInboundDocuments\|relativePaths\|inboundFileNames\|inboundRelativePaths" src/agents/agent-command.ts
467: * @param {string[]} relativePaths - Workspace-relative staged file paths.
473:  relativePaths: string[],
476:  if (relativePaths.length === 0) {
481:    ...relativePaths.map((relativePath) => `- ${relativePath}`),
535: * @returns {Promise<{ fileNames: string[]; relativePaths: string[]; inlinePreviews: string[] }>} ...
537: async function stageInboundDocuments(params: {
542:   relativePaths: string[];
546:    return { fileNames: [], relativePaths: [], inlinePreviews: [] };
551:   const relativePaths: string[] = [];
561:    relativePaths.push(relativePath);
567:   return { fileNames, relativePaths, inlinePreviews };
1346:  const stagedDocuments = await stageInboundDocuments({
1352:    stagedDocuments.relativePaths,
```

All references are either (a) the staging function itself, (b) the `appendInboundFilesContext` text-mutation, or (c) the JSDoc. **No structured downstream consumer exists.** Bug #2 is exactly what the sub-plan claims: the inbound attachment path is broadcast to the LLM as plain text and never pre-bound to the `image_generate` tool.

### c.4 Image-generation transport is fine

Verified that `runtime.ts:169` (inside `generateImage(...)`) propagates `inputImages` to the provider:

```ts
const result: ImageGenerationResult = await provider.generateImage({
  provider: candidate.provider,
  model: candidate.model,
  prompt: params.prompt,
  ...
  inputImages: params.inputImages,    // src/image-generation/runtime.ts:169
});
```

If the tool is invoked with `image: "<path>"` populated, the buffer reaches Hydra `/v1/images/edits` correctly. The bug is upstream — the LLM is never reliably given the path, so the tool is rarely invoked with `image:` set on TG attachment turns. **Phase 6 fix**: structurally pre-bind `image: paths[0]` (or `images: paths`) inside the `artifact-runtime-adapter` BEFORE the model runs, the same pattern Search-Composer 4b used for `<web_evidence>` injection.

---

## §d. Slice E `EpisodicEffectFamily` already includes `"artifact"`

`src/platform/memory/episodic-memory-event.ts:31-36`:

```ts
export type EpisodicEffectFamily =
  | "persistent_session"
  | "subagent"
  | "reminder"
  | "artifact"     // line 35
  | "task";
```

`ArtifactCreatedPayload` is defined at `src/platform/memory/episodic-memory-event.ts:91-99`:

```ts
/**
 * `artifact.created` — STUB (slice K consumer). Same rationale as
 * `subagent.created`.
 */
export type ArtifactCreatedPayload = {
  readonly artifactId: string;
  readonly kind: string;
  readonly occurredAt: string;
};
```

**Audit confirmation**: the discriminated-union slot is typed-but-inert. Slice E already enumerated the variant in the exhaustiveness compile-check. Phase 5 of cutover-3 lights this slot up by adding the EMIT site (`recordArtifactOnCommitmentSatisfied.ts` — sibling to `memory-write-on-satisfied.ts` and `task-write-on-satisfied.ts`). NO discriminated-union extension is needed; payload-shape is sufficient. Per sub-plan §1 §2.3 this is correct on `dev`.

**Note for Phase 5**: the existing payload shape (`artifactId: string`, `kind: string`, `occurredAt: string`) is minimal. If cutover-3 wants `path`, `mimeType`, `sizeBytes`, or `sourcePaths` on the episodic event itself (for slice K reminder query support), those fields should be added as **optional** properties — additive extension, no breaking change.

---

## §e. `WorldStateSnapshot` artifacts slice — placeholder exists, needs population

`src/platform/commitment/world-state.ts:65-71`:

```ts
export type WorldStateSnapshot = {
  readonly sessions?: SessionWorldState;
  readonly artifacts?: ArtifactWorldState;        // line 67
  readonly workspace?: WorkspaceWorldState;       // line 68
  readonly deliveries?: DeliveryWorldState;       // line 69
  readonly webEvidence?: WebEvidenceWorldState;   // line 70
};
```

Where `ArtifactWorldState` and `WorkspaceWorldState` are currently empty placeholders at `src/platform/commitment/world-state.ts:30-31`:

```ts
export type ArtifactWorldState = Record<string, never>;
export type WorkspaceWorldState = Record<string, never>;
```

**Audit finding (deviates slightly from sub-plan §1 §2.4)**: the sub-plan reads "current slices: `sessions`, `deliveries`, `webEvidence`. NEW `artifacts` slice required (Phase 3)". In fact `artifacts?: ArtifactWorldState` and `workspace?: WorkspaceWorldState` slots are **already declared** as optional fields on `WorldStateSnapshot` — they just point at empty `Record<string, never>` placeholders. Phase 3 should:

1. Replace `ArtifactWorldState = Record<string, never>` with the populated `ArtifactsSlice = { records: readonly ArtifactRecord[] }` shape per the sub-plan §1 todo (Phase 3).
2. Wire `ArtifactWorldStateObserver` into `createDefaultMonitoredRuntime`.
3. **Note**: `WorkspaceWorldState` is also empty; cutover-4 (deferred) will populate it. Cutover-3 leaves it untouched.

The slot's prior existence simplifies Phase 3 — it is a **populate-the-shape** change, not a snapshot-shape extension. `ArtifactRecord` shape (per sub-plan §1 todo Phase 3): `{ artifactId, kind: "pdf"|"docx"|"code_patch"|"image", path, mimeType, sizeBytes?, sourcePaths?, producedAt }`.

---

## §f. (CRITICAL) `EFFECT_FAMILY_REGISTRY` current entries — no `artifact` family yet

`src/platform/commitment/effect-family-registry.ts:23-48`:

```ts
export const EFFECT_FAMILY_REGISTRY = Object.freeze([
  Object.freeze({
    id: PERSISTENT_SESSION_EFFECT_FAMILY,                      // line 25
    displayName: "Persistent session",
    allowedOperationKinds: Object.freeze(["create", "observe", "cancel"] satisfies OperationHintKind[]),
  }),
  Object.freeze({
    id: COMMUNICATION_EFFECT_FAMILY,                           // line 30
    displayName: "Communication",
    allowedOperationKinds: Object.freeze(["create", "observe"] satisfies OperationHintKind[]),
  }),
  Object.freeze({
    id: WEB_RESEARCH_EFFECT_FAMILY,                            // line 35
    displayName: "Web research",
    allowedOperationKinds: Object.freeze(["create"] satisfies OperationHintKind[]),
    branchingHints: Object.freeze([
      "search_specialist",
      "search_then_composer",
    ] satisfies BranchingHint[]),
  }),
  Object.freeze({
    id: UNKNOWN_EFFECT_FAMILY,                                 // line 44
    displayName: "Unknown intent",
    allowedOperationKinds: Object.freeze([] satisfies OperationHintKind[]),
  }),
] satisfies EffectFamilyDefinition[]);
```

**Confirmed**: 4 entries, none of them is `"artifact"`. Phase 2 adds a fifth entry additively with `allowedOperationKinds: ["create", "observe", "update"]`.

### f.1 Cutover-2 / Search-Composer precedent — additive `Object.freeze([..., NEW])` extension

Two confirmed precedent commits on `dev`:

- `e9fa5b21ba — feat(commitment): cutover-2 chat-effects + minimal PolicyGate (PR-4b, G6.a+G6.b)` — added `COMMUNICATION_EFFECT_FAMILY` to the registry (slot at line 30) without breaking `PERSISTENT_SESSION_EFFECT_FAMILY`. Frozen-array push-throw guard preserved.
- `5c2813b141 — feat(commitment): Search-Composer Phase 1 — register web_research effect family (#127)` — added `WEB_RESEARCH_EFFECT_FAMILY` (slot at line 35) including the new `branchingHints` field on `EffectFamilyDefinition`. Test extension (`effect-family-registry.test.ts`) follows the same pattern Phase 2 will use.

The same Two-Step ADDITIVE pattern (constant export at top of file + `Object.freeze` entry inside `EFFECT_FAMILY_REGISTRY`) applies to cutover-3 Phase 2. Five new exports needed:

- `ARTIFACT_EFFECT_FAMILY = "artifact" as EffectFamilyId`
- `PDF_CREATED_EFFECT = "pdf.created" as EffectId`
- `DOCX_CREATED_EFFECT = "docx.created" as EffectId`
- `CODE_PATCH_APPLIED_EFFECT = "code_patch.applied" as EffectId`
- `IMAGE_CREATED_EFFECT = "image.created" as EffectId`

(Confirms sub-plan §1 §2.2 + §1 todo Phase 2.)

---

## §g. `cutoverPolicy` allow-list — naming decision

### g.1 Current state — `CUTOVER_2` constant, 4 effects

`src/platform/commitment/cutover-policy.ts:30-47`:

```ts
const CUTOVER_2 = Object.freeze([
  Object.freeze({
    effect: "persistent_session.created" as EffectId,            // line 32
    effectFamily: PERSISTENT_SESSION_EFFECT_FAMILY,
  }),
  Object.freeze({
    effect: "answer.delivered" as EffectId,                      // line 36
    effectFamily: COMMUNICATION_EFFECT_FAMILY,
  }),
  Object.freeze({
    effect: "clarification_requested" as EffectId,               // line 40
    effectFamily: COMMUNICATION_EFFECT_FAMILY,
  }),
  Object.freeze({
    effect: "external_effect.performed" as EffectId,             // line 44
    effectFamily: COMMUNICATION_EFFECT_FAMILY,
  }),
] satisfies CutoverEntry[]);
```

`CUTOVER_2` is a **module-private** constant (no `export`). It is consumed at line 55 as the default for `createCutoverPolicy(entries: readonly CutoverEntry[] = CUTOVER_2): CutoverPolicy`, and the public `defaultCutoverPolicy` is built from it at line 70.

**Confirmed**: zero artifact effect ids present yet (no `pdf.created`, no `docx.created`, no `code_patch.applied`, no `image.created`).

### g.2 Naming decision: extend `CUTOVER_2` in place

**Decision (recommended for Phase 3)**: extend `CUTOVER_2` in place by appending the four new `Object.freeze({...})` entries; do NOT introduce a new `CUTOVER_3` constant.

Rationale:
1. `CUTOVER_2` is module-private — no external consumer pins the name.
2. Renaming forces a coordinated edit on the test files and documentation; appending preserves git-blame on the existing four entries.
3. The constant name is a milestone tag, not a semantic invariant. Search-Composer Phase 1 added `WEB_RESEARCH_EFFECT_FAMILY` to `EFFECT_FAMILY_REGISTRY` without renaming — same precedent applies.
4. Future cutover-4 (`repo_operation.completed`) and cutover-5 will follow the same in-place pattern.

Alternative (rejected): rename to `CUTOVER_3` (or add a new `CUTOVER_3` constant). Rejected because (a) it splits the cutover state across two constants — `defaultCutoverPolicy = createCutoverPolicy([...CUTOVER_2, ...CUTOVER_3])` would need bookkeeping; (b) it triples the test-file churn at no semantic gain.

The sub-plan §1 todo Phase 3 reads "extend `CUTOVER_2` in place vs introduce new `CUTOVER_3` constant — audit decides which name is canonical post-merge per the cutover-2 naming pattern". **Audit decision: extend `CUTOVER_2` in place.**

### g.3 Phase 3 + Phase 7 cutover entries (additive)

Phase 3 (when artifacts slice lands but production routing not yet flipped): the policy is **not** extended at Phase 3 — only at Phase 7 (production-routing flip). Phase 3 adds the world-state slice + observer; the four artifact effects remain off the cutover allow-list until Phase 7.

Phase 7 adds the four entries:

```ts
Object.freeze({ effect: PDF_CREATED_EFFECT, effectFamily: ARTIFACT_EFFECT_FAMILY }),
Object.freeze({ effect: DOCX_CREATED_EFFECT, effectFamily: ARTIFACT_EFFECT_FAMILY }),
Object.freeze({ effect: CODE_PATCH_APPLIED_EFFECT, effectFamily: ARTIFACT_EFFECT_FAMILY }),
Object.freeze({ effect: IMAGE_CREATED_EFFECT, effectFamily: ARTIFACT_EFFECT_FAMILY }),
```

(Note: sub-plan §1 todo Phase 7 only specifies `code_patch.applied` for the routing flip, but acceptance criterion §4 #5 says "for cutover-eligible artifact effect ids (all four)". The audit recommends Phase 7 flips all four at once — this matches the §4 #5 wording and avoids a redundant Phase-7.5 release. If the implementer wants conservatism, Phase 7 can stage by one effect-id per PR.)

---

## §h. `IntentContractor` prompt-hint flip is Phase 8, NOT Phase 2

### h.1 Current 3-family allowlist line

Already cited under §b.2: `src/platform/commitment/intent-contractor-impl.ts:771`:

```ts
desiredEffectFamily: '"persistent_session" | "communication" | "unknown"',
```

### h.2 Phase 8 flip — single line edit

Phase 8 changes the line to:

```ts
desiredEffectFamily: '"persistent_session" | "communication" | "artifact" | "unknown"',
```

(Or `'"persistent_session" | "communication" | "web_research" | "artifact" | "unknown"'` if Search-Composer 4c's allowlist flip lands first; the audit notes that Search-Composer 4c's flip work is in PR-#138/#140/#141/#142/#143/#144/#145 sequence on a separate branch.)

### h.3 Discipline rationale (Search-Composer 4c precedent preserved)

Per sub-plan §1 §2.6: "flipping to include `artifact` is Phase 8, NOT Phase 2 — preserves Search-Composer 4c's flip-discipline (classifier prompt edits are gated on the runtime-adapter being live first)". Confirmed by master plan §0 row 2026-05-02 / Phase 4c. Cutover-3 Phase 8 happens AFTER:

- Phase 2 (effect-family registered) — so `familyDirectory` includes `artifact`.
- Phase 4 (affordances registered) — so resolution can match.
- Phase 5 (runtime adapter live) — so emit sites fire.
- Phase 7 (production routing flipped) — so `productionDecision !== legacyDecision`.

Premature flip at Phase 2 would route artifact turns into legacy bot-detection paths because no affordance would resolve, which would silently regress vs. `dev` baseline.

---

## §i. Hydra modality routing — read-only confirmation

### i.1 Live config primary model

Read-only inspection of `~/.openclaw-dev/openclaw.json` confirms primary model is `hydra/gpt-5.4`:

```json
"agents": {
  "defaults": {
    "workspace": "C:\\Users\\Tanya\\.openclaw\\workspace-dev",
    "skipBootstrap": true,
    "model": {
      "primary": "hydra/gpt-5.4",
      "fallbacks": ["hydra/claude-opus-4.6", "hydra/gpt-5", "hydra/gemini-2.5-pro"]
    }
  },
  ...
}
```

(Path: `C:/Users/Tanya/.openclaw-dev/openclaw.json`. NOT modified by this audit.)

### i.2 `input_modalities` representation in code

`input_modalities` is the canonical OpenRouter-style modality field used by the model-catalog adapters:

- `src/agents/chutes-models.ts:470` — `input_modalities?: string[]` on the schema.
- `src/agents/chutes-models.ts:608` — filter expression `(entry.input_modalities || ["text"]).filter(...)` defaulting to text-only.
- `src/agents/huggingface-models.ts:48-50, 165, 203` — same shape.
- `src/agents/kilocode-models.ts:37, 78` — same shape.

`hydra/gpt-5.4` maps to a model with `input_modalities=["text", "image"]` per the live model-catalog data. `hydra/claude-opus-4.6` maps to `input_modalities=["text"]` only (per HANDOFF-2026-05-06 §"ЖЁСТКИЕ ОГРАНИЧЕНИЯ" line «Hydra `claude-opus-4.6` returns `input_modalities=["text"]`»).

### i.3 Cutover-3 modality posture

**Cutover-3 does NOT modify any model configuration.** The audit confirms:

- Primary stays `hydra/gpt-5.4` (text+image).
- `provider.generateImage({ inputImages })` at `src/image-generation/runtime.ts:169` already routes through Hydra `/v1/images/edits` correctly.
- The img2img bug (#2) is purely structural binding — once Phase 6 pre-binds `image: paths[0]` into the tool args, the existing transport works end-to-end.
- Failover to `hydra/claude-opus-4.6` would silently degrade img2img (text-only modality); the failover chain is unchanged in this slice.

---

## Audit conclusions + Phase-2 readiness checklist

| Sub-plan claim (§1 / §2) | Verified on `dev` `123010276e`? | Notes |
| --- | --- | --- |
| `TargetRef.kind: "artifact"` exists at `semantic-intent.ts:10` | Yes | Frozen-layer no-op for cutover-3. |
| `EpisodicEffectFamily` has `"artifact"` member (typed-but-inert) | Yes | `episodic-memory-event.ts:35` + `ArtifactCreatedPayload` at lines 91-99. |
| `EFFECT_FAMILY_REGISTRY` does NOT yet contain `artifact` | Yes | 4 entries — `persistent_session`, `communication`, `web_research`, `unknown`. |
| `cutoverPolicy` `CUTOVER_2` has 4 effects, no artifact ids | Yes | `cutover-policy.ts:30-47`. |
| `WorldStateSnapshot` slices include `sessions, deliveries, webEvidence` | Partial | Also has empty placeholder `artifacts?: ArtifactWorldState` and `workspace?: WorkspaceWorldState` slots; Phase 3 populates the artifacts shape. |
| Bug #2: prompt enumerates inbound paths but does NOT pre-bind | Yes | `appendInboundFilesContext` at `agent-command.ts:471-492` is text-only; no structured tool-arg pre-binding. |
| `image_generate` schema already accepts `image`/`images`; runtime passes `inputImages` | Yes | `image-generate-tool.ts:118-128, 658-670`; `runtime.ts:169`. |
| Producer registry remains source-of-truth for `(kind, format) -> toolName` | Yes | `produce/registry.ts:67-195`. |
| `IntentContractor` prompt-hint allowlist flip line | At `intent-contractor-impl.ts:771`, NOT 472 | Sub-plan line ref is stale; flip is single-string edit. |
| Hydra primary stays `hydra/gpt-5.4` (text+image), no model-config edit | Yes | `~/.openclaw-dev/openclaw.json` — read-only. |
| Cutover-2 / Search-Composer Phase 1 precedent for additive registry extension | Yes | `e9fa5b21ba` (cutover-2) + `5c2813b141` (PR-#127). |

### Naming decision recap

- `CUTOVER_2` constant in `cutover-policy.ts` is **extended in place** at Phase 7 (do NOT introduce `CUTOVER_3`). Rationale: §g.2.

### Bug #2 root-cause one-liner

Bug #2 root cause is at `src/agents/agent-command.ts:471-492` (function `appendInboundFilesContext`): inbound TG attachment paths are appended to the user-prompt body as **plain text** ("Attached files available in workspace: - <relativePath>") and never structurally bound to `image_generate` tool args. The image-generation transport (`src/image-generation/runtime.ts:169`) is correct end-to-end; the bug is the missing structural-binding seam that Phase 6 introduces via `INBOUND_IMAGE_REFERENCE_AVAILABLE_PRECONDITION` resolved by the new `artifact-runtime-adapter.ts`.

### Phase-2 readiness

Phase 2 (effect-family extension) is **ready to start**. No upstream blockers. All five new constants will be added to `effect-family-registry.ts`; the registry shape and `Object.freeze`+`satisfies` pattern is already established by cutover-2 / PR-#127. Targeted vitest will mirror `effect-family-registry.test.ts` extension pattern.

### Out-of-scope items confirmed deferred

(Per sub-plan §0 + master-plan §0 row 2026-05-06.)

- Bug #1 (closure-outcome-dispatcher false-positive) → `commitment_kernel_policy_gate_full.plan.md`.
- Bug #3 (PDF subagent hardcoded `timeoutMs=2000`) → PolicyGate Stage 4.
- Bug #4 (per-channel `streaming:"off"` partials leak) → Slice I Phase 7.
- Cutover-4 (`repo_operation.completed`) → separate v1 slice.
- Search-Composer 4c `web_research` allowlist flip → separate slice.
- Slack/Discord live-verify → cutover-3 acceptance is Telegram-only.
- 5 frozen contracts modification → out of scope.

---

## Audit metadata

- Worktree: `C:/Users/Tanya/.claude/worktrees/PR-cutover3-phase-1`
- Branch: `audit/v1-cutover3-phase-1`
- HEAD at audit time: `123010276e`
- `pnpm exec tsgo --noEmit` posture: read-only audit, no source modifications — typecheck status equal to `dev` baseline.
- Frozen-layer touches in this PR: NONE.
