# AUDIT — Bundle-as-contract enforcement at LLM schema layer (Phase 1, read-only)

| Field | Value |
| --- | --- |
| Sub-plan | `.cursor/plans/commitment_kernel_bundle_as_contract.plan.md` |
| Phase | 1 — Audit (read-only) |
| Predecessor | dev SHA `6a2dac5911` (post PR-#286 — sub-plan landing) |
| Maintainer signoff | GRANTED via blanket authorization 2026-05-05 |
| Frozen-layer integrity | `src/platform/commitment/**` UNTOUCHED. 5 frozen contracts byte-identical. `src/platform/decision/resolution-contract.ts` UNTOUCHED (consumer-only audit). |
| Output | This file. NO source changes. |

---

## 0. Summary

Phase 1 maps the surface for the bundle-as-contract slice. Goal: prove that
`ResolutionContract.toolBundles` is **advisory metadata** today (consumed by
routing / planner / profile / overlay / trace / web-evidence-prefetch) but is
**never** a hard schema-layer filter on the LLM tool catalog. The
schema-construction site at `src/agents/pi-embedded-runner/run/attempt.ts:2004`
(spec drift: spec text said `:1915` — actual line `:2004` after PR landings;
anchored by `createOpenClawCodingTools(...)` symbol) takes ~52 named params and
NONE is `toolBundles`. The structural source for `bundles` is reachable only
via `params.platformExecutionContext: RecipeRuntimePlan` — the plan exposes
`resolutionContract.toolBundles` (`src/platform/recipe/runtime-adapter.ts:66`)
but the runner never reads it for tool-schema gating.

Result: classifier mis-emit of `bundles=[respond_only]` exposes the full
catalog (`web_search`, `web_fetch`, `browser`, …) to the LLM. For models
without `compat.nativeWebSearchTool=true` (`applyModelProviderToolPolicy` only
removes DDG for the *opposite* direction), the autonomous `web_search` invoke
hits DDG bot-detection → `Provider finish_reason: error`.

---

## 1. (a) `ResolutionToolBundleSchema` enum — 9 closed values

**Location:** `src/platform/decision/resolution-contract.ts:12-23`

```ts
export const ResolutionToolBundleSchema = z.enum([
  "respond_only",          // L13
  "repo_run",              // L14
  "repo_mutation",         // L15
  "interactive_browser",   // L16
  "public_web_lookup",     // L17
  "document_extraction",   // L18
  "artifact_authoring",    // L19
  "external_delivery",     // L20
  "session_orchestration", // L21
]);
export type ResolutionToolBundle = z.infer<typeof ResolutionToolBundleSchema>;
```

- 9 closed enum values **CONFIRMED**.
- Type alias `ResolutionToolBundle` exported at `:23`.
- Schema is closed (Zod `enum`); widening would surface as a Zod parse fail.
- The enum is the **source of truth** per the schema-level comment at
  `:60` ("Source of truth for production routing.") — `toolBundles` field of
  `ResolutionContractSchema` (`:61`) typed as `z.array(ResolutionToolBundleSchema)`.
- Frozen-layer status: `resolution-contract.ts` LIVES at `src/platform/decision/`,
  NOT `src/platform/commitment/`. It IS one of the 5 reference contracts
  consumed across the kernel. Slice will RE-EXPORT — never widen — the enum.

---

## 2. (b) Advisory consumers of `toolBundles`

Every reachable read of `resolutionContract.toolBundles` (or `toolBundles`
field of `MaybeFetchWebEvidenceParams`). Distinguishing **hard gate** (decision
fork that affects routing or system behaviour) vs **advisory** (logging,
profile signal weighting, recipe scoring).

### 2.1. `src/platform/decision/route-preflight.ts:847-865` — narrow web-search promotion

```ts
// L847
const toolBundles = plannerInput.resolutionContract?.toolBundles ?? [];
const isWebSearchSignaled =
  requestedTools.includes("web_search") || toolBundles.includes("public_web_lookup"); // L848-849
if (isWebSearchSignaled) {
  const nativeIndex = list.findIndex(hasNativeWebSearchCapability);
  if (nativeIndex > 0) {
    // ... promote grok-4-class candidate ahead of chain
  }
}
```

- **Role:** Hard gate ON ROUTING ORDER, but NOT on tool-schema construction.
  Promotes a `compat.nativeWebSearchTool=true` candidate (today only `grok-4`)
  when `public_web_lookup` bundle present. Does NOT prune `web_search` from
  the LLM catalog when the bundle is absent.
- **Verdict:** Hard-gate — but **routing-side only**. Schema-side gap is
  exactly what this slice fills.
- **PR provenance:** PR-#125 (initial gate) + PR-#126 (extended to bundle).

### 2.2. `src/platform/decision/web-evidence-prefetch.ts:67-112` — Search-Composer pre-orchestrator

```ts
// L67-83 — type
export type MaybeFetchWebEvidenceParams = {
  readonly toolBundles?: readonly string[] | undefined; // L76
  // …
};
// L85-93 — predicate
function shouldFetchWebEvidence(params): boolean {
  return Boolean(
    params.requestedTools?.includes("web_search") ||
      params.toolBundles?.includes("public_web_lookup"), // L91
  );
}
// L107-112 — public predicate
export function hasWebSearchSignal(params): boolean {
  return shouldFetchWebEvidence(params);
}
```

- **Role:** Hard gate on whether the sonar specialist runs to populate
  `<web_evidence>`. Also feeds `disableWebSearchTool` flag at
  `agent-command.ts:1519` and `agent-runner-execution.ts:481` — that flag
  removes `web_search` / `web_fetch` / `browser` AT `attempt.ts:2060`.
- **Verdict:** Hard-gate — but **conditional on the prefetch hook
  firing**. The hook is bundle-driven, but a bundle of `[respond_only]` skips
  the hook AND leaves `disableWebSearchTool=false` AND leaves the catalog
  intact — the exact `355ae135` failure path.

### 2.3. `src/platform/recipe/planner.ts` — recipe planner

| Line | Read shape | Role |
| --- | --- | --- |
| `:68` | `params.input.resolutionContract?.toolBundles ?? []` | Logging only (`logPlannerSelection` builds telemetry string). Advisory. |
| `:633` | `new Set(input.resolutionContract?.toolBundles ?? [])` | Hard fallback-recipe selection inside `selectContractFallbackRecipe` (`:627`). Drives `preferredIds` via `bundles.has("session_orchestration")`, `bundles.has("artifact_authoring")`, etc. Hard gate ON RECIPE SELECTION. |
| `:670` | `input.resolutionContract?.toolBundles ?? []` | Hard gate inside `narrowRecipesByContract` (`:660`). Empty bundles → empty recipe set; otherwise `toolBundlesMatchRecipe` filters. Hard gate ON RECIPE NARROWING. |
| `:758` | `new Set(input.resolutionContract?.toolBundles ?? [])` | Inside `recipeMatchesProfile` / contract scoring path. Hard gate ON RECIPE-PROFILE MATCH. |
| `:1291` | `(input.resolutionContract?.toolBundles?.length ?? 0) > 0` | `needsTools` flag for emitter `preflight` event — telemetry trigger. Advisory. |
| `:1294` | `input.resolutionContract?.toolBundles ?? []` | Same emitter detail string. Advisory. |
| `:1408` | string in fallback-reason text | Advisory (log line). |
| `:525-527` | `toolBundlesMatchRecipe(toolBundles, recipe)` | Pure helper. Used by `:680`. Hard gate. |

- **Verdict:** Mix of hard gates (recipe selection / narrowing — driving WHICH
  recipe runs) and advisory (logging). NONE of these reach into the LLM tool
  schema. They drive `selectedRecipeId` which drives profile / overlay / model
  selection — orthogonal to the catalog passed to the model.

### 2.4. `src/platform/recipe/runtime-adapter.ts` — runtime adapter

| Line | Read shape | Role |
| --- | --- | --- |
| `:66` | `resolutionContract?: ResolutionContract` field on `RecipeRuntimePlan` | **Structural carrier** — this is HOW `toolBundles` reaches the runtime via `params.platformExecutionContext.resolutionContract.toolBundles`. |
| `:893` | `{ resolutionContract: params.input.resolutionContract }` (spread) | Pure copy from planner input into `RecipeRuntimePlan`. |
| `:958-960` | `{ toolBundles: params.input.resolutionContract.toolBundles }` (spread) | Pure copy into `decisionTrace.resolution`. Telemetry. |
| `:1097` | `{ resolutionContract: runtime.resolutionContract }` (spread) | Re-hydrated planner input. |

- **Verdict:** Pure data carrier. NO gating. The CRITICAL hop chain is here:
  - planner produces `RecipePlannerInput` → adapter assembles `RecipeRuntimePlan`
  - `RecipeRuntimePlan.resolutionContract.toolBundles` is reachable.
  - `RunEmbeddedPiAgentParams.platformExecutionContext` (`params.ts:179`)
    typed as `RecipeRuntimePlan` carries it into the runner.
  - `attempt.ts:2006` reads `params.platformExecutionContext?.selectedProfileId`
    only — **does NOT read `resolutionContract.toolBundles`**.

### 2.5. `src/platform/profile/resolver.ts` — profile resolver

| Line | Read | Role |
| --- | --- | --- |
| `:32` | type field `resolutionContract: Pick<…, "toolBundles">` | Type carrier. |
| `:89` | `new Set(input.resolutionContract?.toolBundles ?? [])` | Profile signal weighting (`extractProfileSignalsFromContracts`). Hard gate on profile selection. |
| `:164` | `(input.resolutionContract?.toolBundles?.length ?? 0) > 0` | Profile selection gate. |

- **Verdict:** Hard gate on PROFILE selection. Orthogonal to LLM tool catalog.

### 2.6. `src/platform/profile/overlay.ts` — task overlay

| Line | Read | Role |
| --- | --- | --- |
| `:28` | type field | Type carrier. |
| `:48` | `new Set(input.resolutionContract?.toolBundles ?? [])` | `bundles.has("respond_only")`, `bundles.has("repo_mutation")`, `bundles.has("external_delivery")` etc. drive `getTaskOverlay(profile, "general_chat" / "code_first" / "integration_first")` choice. Hard gate on TASK OVERLAY selection. |

- **Verdict:** Hard gate on overlay selection. Orthogonal to LLM tool catalog.

### 2.7. `src/platform/decision/trace.ts:289-355` — trace error tags

| Line | Read | Role |
| --- | --- | --- |
| `:289-290` | `trace.resolution?.toolBundles?.length ? trace.resolution.toolBundles.join(",") : …` | Telemetry string in classifier-debug output. Advisory. |
| `:355` | `trace.resolution?.toolBundles ?? []` | Inside `deriveDecisionTraceErrorTags` — drives `unnecessary_clarify` / `missing_required_tool` / `bundle_recipe_mismatch` tags. Advisory (diagnostic tags). |
| `:361, :365` | same | Same diagnostic tag derivation. Advisory. |

- **Verdict:** Advisory tag emission only.

### 2.8. `src/auto-reply/reply/agent-runner-execution.ts:156-481` — gateway prefetch hook

| Line | Read | Role |
| --- | --- | --- |
| `:156` | log line `toolBundles=[…]` | Advisory log. |
| `:160` | passed into `maybeFetchWebEvidence` | Hard-gate carrier — see §2.2. |
| `:481` | passed into `hasWebSearchSignal` for `disableWebSearchTool` | Hard gate driver — see §2.2. |

- **Verdict:** Carrier into `web-evidence-prefetch.ts`.

### 2.9. `src/agents/agent-command.ts:1459-1519` — agent-command prefetch hook

Same shape as `agent-runner-execution.ts` for the `agent-command` caller path.
Lines `:1459` (log), `:1463` (carrier into prefetch), `:1519` (carrier into
`hasWebSearchSignal` → `disableWebSearchTool`).

### 2.10. Aggregate verdict

**No advisory consumer reaches the LLM tool schema today.** The closest is
`disableWebSearchTool` at `attempt.ts:2060`, but it drops only the
`{web_search, web_fetch, browser}` triple AND only when the prefetch hook
inferred a `web_search` signal. For `bundles=[respond_only]` the hook is not
triggered, the catalog stays full, and the model freely autonomous-invokes
`web_search`.

---

## 3. (c) `createOpenClawCodingTools(...)` schema-construction sites

### 3.1. `src/agents/pi-embedded-runner/run/attempt.ts:2002-2058` — production hot path

Spec said `:1915-1971`. Real anchor (after recent PRs): `:2002-2058`. Symbol
`createOpenClawCodingTools` at `:2004`. ~52 named params:

```
agentId, selectedProfileId, exec.{...,elevated}, sandbox, messageProvider,
agentAccountId, messageTo, messageThreadId, groupId, groupChannel, groupSpace,
spawnedBy, senderId, senderName, senderUsername, senderE164, senderIsOwner,
allowGatewaySubagentBinding, sessionKey, sessionId, runId, agentDir,
workspaceDir, spawnWorkspaceDir, config, abortSignal, modelProvider, modelId,
modelCompat, modelContextWindowTokens, modelAuthMode, currentChannelId,
currentThreadTs, currentMessageId, replyToMode, hasRepliedRef, modelHasVision,
requireExplicitMessageTarget, disableMessageTool, onYield
```

**`toolBundles` parameter: ABSENT — confirmed.**
**`resolutionContract` parameter: ABSENT — confirmed.**

Downstream chain after construction:
1. `:2002-2058` — `toolsRaw = createOpenClawCodingTools({...})`
2. `:2060-2065` — `disableWebSearchTool` filter (drops `web_search`,
   `web_fetch`, `browser` when set).
3. `:2066-2069` — `sanitizeToolsForGoogle({ tools: toolsEnabled ? … : [], … })`.
4. `:2096-2099` — `filterDeliveryManagedTools(...)` adds bundle-mcp + bundle-lsp.
5. → fed into LLM call.

Inside `createOpenClawCodingTools` (`pi-tools.ts`):
- `:573-576` — `applyMessageProviderToolPolicy` removes `tts` for `voice`
  channel (only known mapping at `:67-69`).
- `:577-579` — `applyModelProviderToolPolicy` removes `web_search` ONLY when
  `hasNativeWebSearchTool(modelCompat) === true`. See §4.

### 3.2. `src/auto-reply/reply/commands-system-prompt.ts:55-66` — system-prompt builder

```ts
return createOpenClawCodingTools({
  config: params.cfg,
  agentId: params.agentId,
  workspaceDir,
  // …
});
```

- **Role:** Builds tool list for the *system prompt rendering* (commands
  surface). Distinct call site from the runtime LLM call. Used to compute tool
  list to embed into a system-prompt section.
- **`toolBundles` parameter: ABSENT.**
- **In-scope for slice?** NO — sub-plan §4 explicitly marks this caller
  out-of-scope ("commands-system-prompt path UNCHANGED — separate caller,
  separate scope"). Phase 4 acceptance includes a regression test for that
  path.

### 3.3. `src/cron/isolated-agent/run.owner-auth.test.ts:70` — test only

```ts
const toolNames = createOpenClawCodingTools({ senderIsOwner }).map(t => t.name);
```

- **Role:** Test-only assertion that `cron` and `gateway` tools are exposed
  for owner. NOT a production schema-construction site.
- **`toolBundles` parameter: ABSENT.**

### 3.4. Aggregate

Only **one** production schema-construction site: `attempt.ts:2002-2058`.
Wiring at Phase 4 has a single target. Other 22 import-only files (per grep
in §0) are unrelated test fixtures or test helpers.

---

## 4. (d) `applyModelProviderToolPolicy` semantics

**Location:** `src/agents/pi-tools.ts:94-104`

```ts
function applyModelProviderToolPolicy(
  tools: AnyAgentTool[],
  params?: { modelCompat?: ModelCompatConfig },
): AnyAgentTool[] {
  if (!hasNativeWebSearchTool(params?.modelCompat)) {
    return tools;                                          // L99 — short-circuit
  }
  // Models with a native web_search tool cannot receive OpenClaw's
  // web_search at the same time or the request will collide.
  return tools.filter((tool) => !TOOL_DENY_FOR_XAI_PROVIDERS.has(tool.name)); // L103
}
```

`TOOL_DENY_FOR_XAI_PROVIDERS = new Set(["web_search"])` at `pi-tools.ts:70`.

| Direction | Behaviour | Coverage |
| --- | --- | --- |
| Native-search ON (`grok-4`-class, `compat.nativeWebSearchTool=true`) → remove DDG `web_search` | YES — filter at L103 | Covered |
| Native-search OFF (`claude-opus-4.6`-class) → remove DDG `web_search` when no `public_web_lookup` bundle | NO — short-circuit at L99 returns the catalog as-is | **NOT COVERED** |

**Confirmed asymmetry.** The reverse defense — "non-native-search model
does NOT see `web_search` unless the turn's bundle authorizes it" — is the
exact gap Phase 5 of the slice closes via the new
`filterToolSchemaByBundle` helper (Phase 3).

---

## 5. (e) `attempt.ts:2002-2058` argument shape and the bundle hop chain

Already mapped in §3.1. The 52 params come from `EmbeddedRunAttemptParams`
(typing imported at `attempt.ts:164` from `./types.ts`). `RunEmbeddedPiAgentParams`
(see `params.ts:30-188`) has **no `toolBundles` field** — confirmed by grep.

**The structural source of `bundles` reaching the runtime — full hop chain:**

```
┌───────────────────────────────────────────────────────────────────────┐
│ classifier (decision/task-classifier.ts)                              │
│     emits resolutionContract.toolBundles                              │
└──────────────────────────────────┬────────────────────────────────────┘
                                   ▼
┌───────────────────────────────────────────────────────────────────────┐
│ resolveResolutionContract (decision/resolution-contract.ts:359)       │
│     deriveToolBundles(...) → ResolutionContract.toolBundles           │
└──────────────────────────────────┬────────────────────────────────────┘
                                   ▼
┌───────────────────────────────────────────────────────────────────────┐
│ recipe runtime adapter (recipe/runtime-adapter.ts:893)                │
│     plan.resolutionContract = input.resolutionContract                │
│     RecipeRuntimePlan.resolutionContract.toolBundles  ← STRUCTURAL    │
└──────────────────────────────────┬────────────────────────────────────┘
                                   ▼
┌───────────────────────────────────────────────────────────────────────┐
│ RunEmbeddedPiAgentParams (pi-embedded-runner/run/params.ts:179)       │
│     platformExecutionContext: RecipeRuntimePlan                       │
└──────────────────────────────────┬────────────────────────────────────┘
                                   ▼
┌───────────────────────────────────────────────────────────────────────┐
│ runEmbeddedAttempt (attempt.ts:1882)                                  │
│     params.platformExecutionContext?.resolutionContract?.toolBundles  │
│     ── REACHABLE BUT UNREAD AT THE SCHEMA-CONSTRUCTION SITE ──        │
│ at :2006 reads only `selectedProfileId` from platformExecutionContext │
└───────────────────────────────────────────────────────────────────────┘
```

**Phase 4 wiring strategy (read-only sketch):** thread bundles into the
schema-construction call by reading `params.platformExecutionContext?.
resolutionContract?.toolBundles ?? []` (typed as
`readonly ResolutionToolBundle[]`) immediately before/after the
`createOpenClawCodingTools(...)` call, then post-filter via the new pure
`filterToolSchemaByBundle({...})` helper. **No new field on
`EmbeddedRunAttemptParams` is strictly necessary** — the carrier already
exists; the runner just doesn't read it.

This avoids any modification to `params.ts` / `types.ts` shape, which is
preferable since `EmbeddedRunAttemptParams` is widely typed across the
runner subsystem. (Phase 4 may still choose to surface an explicit
`toolBundles?: readonly BundleId[]` param for testability — ship as
optional with `defaultMode='read_from_platformExecutionContext'`.)

---

## 6. (f) Bundle-emission contracts of recipe planner

### 6.1. Production turn — classifier emits non-empty `toolBundles`

`deriveToolBundles(...)` at `resolution-contract.ts:252-308` ALWAYS produces
a non-empty array because at least one of these always fires:

- `:272-274` — `respond_only` added when `!requiresTools && tools.size === 0`.
- `:275-277` — `repo_run` added when exec/process tools or `requiresLocalProcess`.
- `:278-280` — `repo_mutation` added when patch tool or `requiresWorkspaceMutation`.
- `:281-283` — `interactive_browser` added when `browser` tool requested.
- `:284-286` — `public_web_lookup` added when `web_search` tool requested.
- `:287-294` — `document_extraction` for attachments + structured artifact.
- `:295-300` — `artifact_authoring` for explicit authoring or structured artifact.
- `:301-303` — `external_delivery` for publish targets.
- `:304-306` — `session_orchestration` for `sessions_spawn`.

For a chit-chat turn that classifies into `text_response` outcome with no
tool requests: `respond_only` is produced (covers the `355ae135` scenario).

### 6.2. Empty `toolBundles` — possible only from non-classifier paths

Empty `toolBundles` array can arise from:
- Legacy non-`contractFirst` callers that pass `RecipePlannerInput` without
  `resolutionContract`. Planner falls back at `planner.ts:670` (empty bundles
  short-circuit recipe narrowing).
- Heartbeat / cron / synthetic flows that bypass the classifier.
- Test fixtures.

This is the rationale for `missingBundlePolicy: 'allow_all'` (Phase 2 default)
— preserves byte-identical legacy behaviour for the empty-bundles regression
class. PR-#126 sub-plan §8 row 1 highlighted this same regression concern.

---

## 7. (g) Operator-impact estimate

### 7.1. Telemetry baseline

`[bundle-filter]` log lines: **NOT YET PRESENT** — confirmed via repo-wide grep
returns 0 hits. Phase 6 deliverable.

### 7.2. `Provider finish_reason: error` baseline

Repo-wide grep across `*.log` files (caller-side gateway log artefacts):

| Log artefact | Count |
| --- | --- |
| `gateway-pipeline-rollback.log` | 11 |
| `gateway-phase4c-restart.log` | 11 |
| `gateway-pr142.log` | 6 |
| `gateway-classifier-debug.log` | 5 |
| `gateway-pr211.log` | 2 |
| `gateway-restart-caption-fix.log` | 2 |
| `gateway-grok-route.log` | 2 |
| `gateway-phase4c-restart-pr140.log` | 2 |
| `gateway-phase-c-edge.log` | 2 |
| `gateway-pr144.log` | 1 |
| `gateway-pr143.log` | 1 |
| `gateway-pr141.log` | 1 |
| `gateway-phase4c-restart-fix.log` | 1 |
| `gateway-phase-c.log` | 1 |
| `gateway-oneshot.log` | 1 |
| **Total across 15 files** | **49** |

`gateway-grok-route.log` carries the `355ae135` evidence (1 occurrence of the
turn id, 2 occurrences of the `finish_reason: error` symptom — the second one
likely the retried fallback). Phase 6 fixture replays this turn shape.

### 7.3. Risk classes

| Risk | Mitigation |
| --- | --- |
| Empty-bundles regression (heartbeat / cron / synthetic) | `missingBundlePolicy='allow_all'` default |
| Reverse-defense double-fire with native-search filter | `applyModelProviderToolPolicy` runs first; reverse-defense layer is no-op when `web_search` already removed (idempotent). Phase 5 acceptance test #3. |
| Future regression re-introduces `web_search` post `applyModelProviderToolPolicy` | Reverse-defense layer is independent — fires regardless of how the tool slipped in. Phase 5 acceptance test #1. |
| Bundle-id widened in `resolution-contract.ts` without updating allowlist | `Object.isFrozen` guard + closed-shape reverse-test enforces every `BundleId` has an entry (Phase 2). |
| Commands-system-prompt path drift | Phase 4 regression test asserts UNCHANGED tool list for that caller. |

---

## 8. (h) Identified gaps for Phases 2-7 (checkboxes)

### Phase 2 — Types + closed map
- [ ] NEW file `src/agents/bundle-schema-filter.ts` (under `src/agents/`, NOT
      `src/platform/commitment/` per invariant #11; NOT `src/platform/decision/`
      per invariant #8 — fix lives in adapter/runner orchestration layer).
- [ ] `type BundleId = ResolutionToolBundle` re-export (single source of truth).
- [ ] `type BundleAllowedToolSet = ReadonlySet<string>`.
- [ ] `interface BundleSchemaFilterConfig` + `BundleSchemaFilterConfigSchema.strict()`.
- [ ] `const DEFAULT_BUNDLE_ALLOWED_TOOLS: ReadonlyMap<BundleId, BundleAllowedToolSet>`
      — `Object.freeze`d, closed across all 9 `BundleId` values.
- [ ] `function resolveBundleAllowedTools(bundles, config): BundleAllowedToolSet` — pure.
- [ ] ~6 fail-first tests — schema round-trip, reject unknown id, closed-shape coverage,
      union semantics, empty-bundles policy honored.

### Phase 3 — Pure filter
- [ ] `function filterToolSchemaByBundle({ tools, bundles, modelCapabilities, config })`
      — pure, never throws, returns `{kept, removed[{tool,reason}]}`.
- [ ] Two layers: (1) bundle allowlist; (2) reverse-defense
      (`!nativeWebSearchTool && !bundles.includes("public_web_lookup")` → drop `web_search`).
- [ ] ~9 fail-first tests including idempotency, non-mutation, unknown-tool kept.

### Phase 4 — Wiring at `attempt.ts:2002`
- [ ] Read `params.platformExecutionContext?.resolutionContract?.toolBundles ?? []`
      at the schema-construction site (line drift from spec `:1915` to actual `:2004`).
- [ ] Invoke `filterToolSchemaByBundle({...})` AFTER the existing
      `applyModelProviderToolPolicy` chain (which lives inside
      `createOpenClawCodingTools`). Layered atop, NOT replacing.
- [ ] Order-of-operations preserved: catalog → message-provider deny →
      model-provider deny → **NEW bundle filter** → `disableWebSearchTool` → google sanitizer → bundle-mcp/lsp → LLM.
- [ ] Regression byte-identical test for `toolBundles=[] && missingPolicy='allow_all'`.
- [ ] Commands-system-prompt path UNCHANGED — separate test.

### Phase 5 — Reverse defense
- [ ] Adversarial test: post-`applyModelProviderToolPolicy` injection of
      `web_search` into the catalog + non-native-search model → reverse-defense removes.
- [ ] `bundles=[public_web_lookup] && !nativeWebSearchTool` → KEEP `web_search`
      (bundle authority wins).
- [ ] `bundles=[public_web_lookup] && nativeWebSearchTool=true (grok-4)` →
      `applyModelProviderToolPolicy` already removed; reverse-defense is no-op.

### Phase 6 — Telemetry + acceptance
- [ ] NEW log line at filter exit:
      `[bundle-filter] turnId=<...> bundles=[<...>] removed_tools=[<name>:<reason>,...] kept_tools=[<...>]`.
- [ ] NEW `src/agents/__tests__/bundle-schema-filter.acceptance.test.ts`:
      `355ae135` reproduction + 4 reverse / happy-path / heartbeat-regression cases.
- [ ] Telemetry hook MUST log via existing `subsystem` logger to be greppable.

### Phase 7 — Runbook + flip
- [ ] NEW `extensions/RUNBOOK-bundle-as-contract.md` with 3 live turns
      (`respond_only`, `public_web_lookup`, `artifact_authoring`).
- [ ] Master plan §0.5.1 row 'Tool exposure согласована…' flips to CLOSED.
- [ ] `commitment_kernel_search_composer_pipeline.plan.md` §8 row 1 cross-links.
- [ ] `orchestrator_web_search_capability_routing.plan.md` §8 row 1 cross-links.
- [ ] Sub-plan frontmatter `status: closed` after live-verify green.

---

## 9. (i) NEW structural invariant proposal

### 9.1. Statement

> **«No LLM tool-schema construction reaches the model without a
> bundle-allowlist filter applied AT the schema-construction site.»**

### 9.2. Operationalization (Phase 6 lint-guard)

A test-time lint guard — NOT a TypeScript-level constraint (the type
`AnyAgentTool[]` reaching the LLM does not change shape). Instead, structural
test:

- **Test name:** `bundle-schema-filter.invariant.test.ts`
  (under `src/agents/__tests__/`).
- **Scope:** AST-grep / source-text scan of every production call site of
  `createOpenClawCodingTools(...)` (whitelist-based — production paths, NOT
  test fixtures, NOT system-prompt builder). Today: just `attempt.ts:2004`.
- **Assertion:** Within ~50 lines AFTER each whitelisted call site, the
  symbol `filterToolSchemaByBundle` MUST appear (text presence is sufficient
  given the closed call-site whitelist).
- **Failure mode:** new production caller of `createOpenClawCodingTools` is
  added without bundle filter → guard test fails → reviewer surfaced.

### 9.3. Why this invariant matters

- Closes the architectural gap: bundle is structural data (closed Zod enum)
  yet today is advisory at the schema layer. Promoting it to a hard filter
  AT the construction site makes mis-emission a recoverable telemetry event,
  not an LLM-visible failure.
- Symmetric to `applyModelProviderToolPolicy` (capability-side filter) —
  bundle filter is the contract-side filter on the same axis.
- Pure-additive — does not modify the 5 frozen contracts, the
  `ResolutionToolBundleSchema` enum, OR `applyModelProviderToolPolicy` semantics
  (Phase 5 explicit non-goal).

---

## 10. Frozen-layer integrity declaration

This audit is read-only.

- `src/platform/commitment/**` — UNTOUCHED.
- `src/platform/decision/resolution-contract.ts` — UNTOUCHED (consumer-only audit).
- `src/platform/decision/qualification-contract.ts` — UNTOUCHED.
- `src/platform/decision/intent-contractor-types.ts` (or equivalent) — UNTOUCHED.
- 5 frozen contracts byte-identical: `TaskContract`, `OutcomeContract`,
  `QualificationExecutionContract`, `ResolutionContract`, `RecipeRoutingHints`.

`tsgo` not invoked because no source changes were made; full-tree typecheck
not in Phase 1 scope.

---

## 11. References

- `.cursor/plans/commitment_kernel_bundle_as_contract.plan.md`
- `.cursor/rules/commitment-kernel-invariants.mdc`
- `src/platform/decision/resolution-contract.ts:12-23, :252-308, :359-424`
- `src/platform/decision/route-preflight.ts:847-865`
- `src/platform/decision/web-evidence-prefetch.ts:67-112`
- `src/platform/decision/trace.ts:289-290, :353-365`
- `src/platform/recipe/planner.ts:62-98, :525-527, :627-704, :1283-1302`
- `src/platform/recipe/runtime-adapter.ts:48-101, :893, :958-960, :1097`
- `src/platform/profile/resolver.ts:22-81, :87-180`
- `src/platform/profile/overlay.ts:22-95`
- `src/agents/pi-tools.ts:67-104, :573-580`
- `src/agents/pi-embedded-runner/run/attempt.ts:1882, :2002-2099`
- `src/agents/pi-embedded-runner/run/params.ts:30-188`
- `src/auto-reply/reply/agent-runner-execution.ts:140-180, :470-495`
- `src/auto-reply/reply/commands-system-prompt.ts:55-66`
- `src/agents/agent-command.ts:1459-1519`
- `src/cron/isolated-agent/run.owner-auth.test.ts:70`
- Live evidence: `gateway-grok-route.log` 2026-05-02 turn `355ae135`.
