---
name: SLICE B — robust web_search routing (capability lookup + bundle-aware gate predicate)
overview: |
  Bug observed live (gateway-grok-route.log 2026-05-02 11:06–11:21): when the planner classifies a follow-up turn as `bundles=[respond_only] requestedTools=[] intent=general` but the LLM (`hydra/claude-opus-4.6`) autonomously emits `web_search` tool calls anyway, the local DDG-backed scraper returns `bot-detection challenge` × 3, and the provider finally terminates the run with `finish_reason: error` (turn `355ae135` line 157 — silent UX death, no reply at all).

  PR-#125 (`e3d8c538f8`) closed the case where `requestedTools.includes("web_search")` is correctly emitted by the planner. It promotes a Grok candidate first via a hardcoded substring match (`model.toLowerCase().includes("grok")`). Two issues remain:

  1. **Predicate too narrow** — when the recipe planner emits `toolBundles=["public_web_lookup"]` but `requestedTools=[]` (intent surfaces the *bundle* but not the per-tool list — a real shape observed in `src/platform/decision/resolution-contract.ts` since `deriveToolBundles` and `deriveRequestedTools` are independent functions), the gate doesn't fire.
  2. **Candidate predicate is name-coupled** — `includes("grok")` is a substring match against any future Grok variant ID, including ones that may NOT have a working native search (e.g. a hypothetical `grok-vision-3` without xAI Live Search). The structural marker is `compat.nativeWebSearchTool: true` in `~/.openclaw-dev/agents/dev/agent/models.json`, which today applies ONLY to `grok-4`.

  This slice fixes BOTH narrow issues without crossing the architectural boundary into bundle-as-contract enforcement at the schema layer (see §8 adjacent / deferred work).

  Scope:
  - Replace hardcoded `model.toLowerCase().includes("grok")` with a curated closed set `NATIVE_WEB_SEARCH_MODEL_IDS = new Set(["grok-4"])` mirrored against `models.json` compat blocks.
  - Broaden the gate predicate: fire on `requestedTools.includes("web_search")` OR `(resolutionContract?.toolBundles ?? []).includes("public_web_lookup")`.
  - Wire `resolutionContract` through `LocalRoutingPlannerInput` Pick (private type local to `route-preflight.ts`; no public surface change).
  - Reuse existing `preflight_routed_grok_for_web_search` reasonCode (frozen union member from PR-#125; no new code → no `compatibility` checkbox required).
  - Tests: 3 new (bundle-only signal promotes; promotion is exact-match not substring; chain without native-search candidate stays put).

  EXPLICITLY OUT OF SCOPE (deferred to future signoff-required slices, see §8):
  - Bundle-as-contract enforcement at the LLM schema layer (i.e. dropping `web_search` tool from schema when `bundles=[respond_only]`). This is architectural — currently bundle is *advisory* and heartbeat / follow-up flows depend on the model's tool autonomy (turn `26092435` in the same log: `bundles=[respond_only]` → model successfully made a `pdf` tool call).
  - IntentContractor surfacing a structural `freshness` / `recency` constraint so routing can detect "needs current data" turns even when the classifier's `requestedTools` is empty.
  - Adding `compat?: ModelCompatConfig` to `ModelCatalogEntry` so route-preflight can read `nativeWebSearchTool` directly instead of mirroring a curated set.

  Hard invariants this slice MUST keep:
  - **#5** — no phrase / text-rule matching on `UserPrompt` / `RawUserTurn`. The new predicate reads only structured outputs (`requestedTools`, `resolutionContract.toolBundles`).
  - **#6** — `IntentContractor` remains the only reader of raw user text. Not touched.
  - **#8** — `src/platform/commitment/` does not import from `src/platform/decision/`. Edit lives entirely in `src/platform/decision/route-preflight.ts`.
  - **#11** — five frozen decision contracts (`TaskContract`, `OutcomeContract`, `QualificationExecutionContract`, `ResolutionContract`, `RecipeRoutingHints`) untouched. We READ `ResolutionContract.toolBundles` (already part of its frozen shape) but do not modify it.
  - **#15** — narrow bug-fix slice; signoff not required (same class of change as PR-#114 model-fallback-respect-order and PR-#125 web_search promotion).

audit_gaps_closed: []

todos:
  - id: write-subplan
    order: 1
    status: completed
    content: |
      Drafted this plan from `gateway-grok-route.log` (lines 92–157), models.json compat audit, route-preflight.ts:789–815 read-through, and tool-registry / pi-tools wiring audit.

  - id: implement-capability-and-bundle-gate
    order: 2
    status: pending
    content: |
      Edit `src/platform/decision/route-preflight.ts`:
      1. Add `NATIVE_WEB_SEARCH_MODEL_IDS: ReadonlySet<string>` at module top, initialised to `new Set(["grok-4"])`. Comment cross-referencing `~/.openclaw-dev/agents/dev/agent/models.json` compat block as the source of truth — the set MUST stay in sync when new models acquire `nativeWebSearchTool: true`.
      2. Add a private predicate `hasNativeWebSearchCapability(candidate: ModelCandidate): boolean` performing exact lowercased match against the set.
      3. Extend `LocalRoutingPlannerInput` Pick (line 11) with `"resolutionContract"` so the gate can read `plannerInput.resolutionContract?.toolBundles`.
      4. Replace the gate block at line 796–812:
         - New predicate: `requestedTools.includes("web_search") || toolBundles.includes("public_web_lookup")`.
         - New candidate lookup: `list.findIndex(hasNativeWebSearchCapability)`.
         - Refresh inline comment to reflect both signals.
         - Update `reason` string to read "Promoted ${native.provider}/${native.model} ahead of the configured chain because the turn signals web_search (requestedTools or public_web_lookup bundle) and ${native.provider}/${native.model} has compat.nativeWebSearchTool=true."
         - reasonCode unchanged (`preflight_routed_grok_for_web_search`) — frozen union; rename deferred to a future slice if/when we add a second native-search model.

  - id: tests
    order: 3
    status: pending
    content: |
      Edit `src/platform/decision/route-preflight.test.ts`:
      1. NEW: "promotes hydra/grok-4 first when bundles=[public_web_lookup] and requestedTools=[]" — bundle-only signal fires gate.
      2. NEW: "uses exact-match against NATIVE_WEB_SEARCH_MODEL_IDS, ignoring substring-only model names" — chain `[hydra/grok-coder-fast-1, hydra/claude-opus-4.6]` with web_search requested → no promotion (grok-coder-fast-1 is NOT in the native-search set; today only grok-4 is). Defends the regression PR-#125's substring `includes("grok")` would have been vulnerable to.
      3. NEW: "leaves chain unchanged when public_web_lookup bundle is signaled but no native-search model is in the chain" — chain `[hydra/claude-opus-4.6, hydra/gpt-5.4]` with bundles=[public_web_lookup] → reasonCode is NOT `preflight_routed_grok_for_web_search`.
      4. EXISTING test at line 161 (`promotes hydra/grok-4 first when web_search is requested`) should still pass without modification.
      5. EXISTING test at line 186 (`does not touch the chain when web_search is requested but no grok candidate`) should still pass.

  - id: tsgo-and-targeted-tests
    order: 4
    status: pending
    content: |
      `pnpm tsgo` clean (whole repo) + targeted `pnpm test -- src/platform/decision/route-preflight.test.ts` green. ReadLints clean.

  - id: commit-and-pr
    order: 5
    status: pending
    content: |
      Single commit on `fix/orchestrator-web-search-capability-routing`. PR via `gh pr create --base dev`. Frozen layer NOT touched (`reasonCode` union unchanged, `ResolutionContract` only read). PR body labels: `bug-fix` only — no `compatibility` checkbox needed. CI infra likely offline (BlackSmith total_count=0 historical) → admin-merge after frozen-layer SUCCESS + local validation per recent slice precedent (PR-#114, PR-#118, PR-#122, PR-#125).

  - id: handoff-and-master-row
    order: 6
    status: pending
    content: |
      After merge:
      - docs(plan) commit on dev with handoff log row in `commitment_kernel_smart_orchestrator_roadmap.plan.md` §6 + master `commitment_kernel_v1_master.plan.md` §0 PR Progress Log row.
      - Master §0.5 audit findings: NEW row "tool exposure ↔ model capability gating" — flag the architectural gap (deferred §8) so it's tracked alongside other audit-findings rows.
      - Restart `pnpm gateway:dev:channels`. Live verify: turn requesting web_search via bundle (e.g. "поищи в интернете последние модели") → expect `decision=preflight_routed_grok_for_web_search reordered=true first=hydra/grok-4` even if `requestedTools=[]`.

isProject: false
---

# SLICE B — robust web_search routing (capability lookup + bundle-aware gate predicate)

## 0. Provenance

| Field | Value |
| --- | --- |
| Sub-plan of | `.cursor/plans/commitment_kernel_smart_orchestrator_roadmap.plan.md` (post-PR-#125 narrow follow-up; tracked in roadmap §6 Handoff Log next-row) |
| Inherits | 16 hard invariants (`.cursor/rules/commitment-kernel-invariants.mdc`) — unchanged |
| Trigger | `gateway-grok-route.log` 2026-05-02 11:06:55–11:21:08, turns `efcc1476` / `26092435` / `355ae135`. Turn `efcc1476`: planner `bundles=[respond_only] requestedTools=[]` → preflight `decision=preflight_no_local_candidate first=hydra/claude-opus-4.6` → model autonomously emitted `web_search` × 3 → DDG bot-detection × 3 → partial reply streamed, then continued with pdf+web_search tool calls (lines 109–116). Turn `355ae135` (line 157): `embedded run agent end isError=true error=Provider finish_reason: error` — silent UX death. |
| Target branch | `fix/orchestrator-web-search-capability-routing` off latest `origin/dev` (HEAD `e3d8c538f8` — PR-#125). |
| Merge target | `dev`, single PR. Frozen layer NOT touched (reasonCode union unchanged). |

## 1. Hard invariants this fix MUST keep

| # | Invariant | How not to break |
| --- | --- | --- |
| 5 | No phrase / text-rule matching on `UserPrompt` / `RawUserTurn` outside whitelist | Predicate reads only structured outputs (`plannerInput.requestedTools`, `plannerInput.resolutionContract.toolBundles`). Zero raw text reads. |
| 6 | `IntentContractor` is the only reader of raw user text | Not touched. |
| 8 | `src/platform/commitment/` does not import from `src/platform/decision/` | Edit lives entirely in `src/platform/decision/route-preflight.ts`. No `commitment/` import added or moved. |
| 11 | Five legacy decision contracts frozen | `ResolutionContract.toolBundles` is READ only (existing field). No shape modification. `RecipeRoutingHints` untouched. |
| 12 | Emergency phrase / routing patches require ticket + retire deadline | Not an emergency patch; structural improvement of an already-merged routing rule (PR-#125). |
| 13 | `terminalState` ⊥ `acceptanceReason` | Not touched. |
| 15 | PR-1 / 1.5 / 2 / 3 require maintainer signoff | This is NOT one of those PRs. Same narrow class as PR-#114 / PR-#118 / PR-#122 / PR-#125. |

`ExecutionCommitment` / `Affordance` / `MonitoredRuntime` / `ShadowBuilder` / `DonePredicate` not touched.

Frozen call sites (`src/platform/plugin.ts:80,340`, `src/platform/decision/input.ts:444,481`) — not touched.

## 2. Bug repro & evidence

### 2.1. Live evidence — `gateway-grok-route.log`

**Turn `efcc1476` (line 92–122) — gate-too-narrow case:**

```
[planner] selected: recipe=general_reasoning ... toolBundles=[respond_only] requestedTools=[] intent=general
[model-fallback] route preflight: decision=preflight_no_local_candidate eligible=true reordered=false first=hydra/claude-opus-4.6
[model-fallback] route candidates ordered: hydra/claude-opus-4.6 -> hydra/gpt-5.4 -> hydra/grok-4 -> hydra/hydra-gpt-pro
[assistant-reply] runId=efcc1476 lang=ru ... head="Давай я сначала соберу актуальную информацию по всем направлениям, чтобы ничего не упустить."
[tools] web_search failed: DuckDuckGo returned a bot-detection challenge.   (×3)
[progress] turn=efcc1476 seq=4 phase=tool_call toolName=pdf
[progress] turn=efcc1476 seq=5 phase=tool_call toolName=web_search
[progress] turn=efcc1476 seq=6 phase=tool_call toolName=web_search
```

Result: user got a degraded answer (PDF without web data). Did NOT die silently.

**Turn `355ae135` (line 157) — silent UX death:**

```
embedded run agent end: runId=355ae135 isError=true model=claude-opus-4.6 provider=hydra error=Provider finish_reason: error
```

The same routing pattern (planner `bundles=[respond_only] requestedTools=[]` → claude-opus-4.6 → autonomous web_search → DDG fail) ended with provider-side `finish_reason: error` and zero user-facing reply.

**Turn `26092435` (line 124–143) — heartbeat counter-example:**

```
[planner] selected: ... toolBundles=[respond_only] requestedTools=[] intent=general caller=auto-reply-runtime-plan
[progress] turn=26092435 seq=4 phase=tool_call toolName=pdf
[progress] turn=26092435 seq=5 phase=done
```

Heartbeat-driven turn with the SAME planner output successfully made a `pdf` tool call. **Critical:** this proves bundle is currently advisory — if we added a hard bundle filter at the schema layer, this turn would lose pdf access and silently fail in a different way. ⇒ §8 deferred.

### 2.2. Capability map (Phase 1 finding)

`~/.openclaw-dev/agents/dev/agent/models.json` per-model `compat` audit:

| Model id (hydra) | `nativeWebSearchTool` | `toolSchemaProfile` | `toolCallArgumentsEncoding` |
| --- | --- | --- | --- |
| `grok-4` | **true** | `xai` | `html-entities` |
| `claude-opus-4.6` | absent | absent | absent |
| `gpt-5.4` | absent | absent | absent |
| `hydra-gpt-pro` | absent | absent | absent |
| `gpt-5-mini` | absent | absent | absent |
| `claude-sonnet-4.6` | absent | absent | absent |
| `deepseek-v3.2` | absent | absent | absent |
| (every other entry) | absent | absent | absent |

**Conclusion:** `grok-4` is the ONLY hydra-proxied model with a native server-side web_search through Hydra (xAI Live Search via `openai-completions` schema with the xai compat profile). All other openai-completions hydra models would require client-side function-tool execution; their `web_search` tool calls run through OpenClaw's local DDG scraper which is rate-limited / bot-detected.

### 2.3. Code path (Phase 2 finding)

1. `src/platform/recipe/planner.ts` emits `RecipePlannerInput.resolutionContract.toolBundles` (frozen contract) AND `requestedTools` independently. `bundles=[public_web_lookup]` does NOT guarantee `requestedTools.includes("web_search")` (the latter depends on the recipe matching `requestedTools` derivation in `resolution-contract.ts:412`).
2. `src/platform/decision/route-preflight.ts:796` — current PR-#125 gate: `if (requestedTools.includes("web_search"))`. Misses bundle-only signal.
3. `src/platform/decision/route-preflight.ts:798` — current candidate lookup: `list.findIndex((c) => c.model.toLowerCase().includes("grok"))`. Substring match against any "grok"-named model.
4. `src/agents/pi-tools.ts:98–103` — `applyModelProviderToolPolicy` removes the OpenClaw `web_search` tool from the schema for models with `nativeWebSearchTool=true` (so grok-4 does NOT see the DDG tool — its own native search is used). For all other models the DDG tool stays in the schema → autonomous tool calls fail with bot-detection.
5. `src/agents/pi-embedded-runner/run/attempt.ts:1915–1971` — `createOpenClawCodingTools()` is called WITHOUT `toolBundles`. Bundle does NOT filter the schema. ⇒ §8 deferred.

## 3. Hypothesis

**H1 (primary, addressed by this slice):** PR-#125's gate fires on `requestedTools.includes("web_search")` only and matches candidates by `includes("grok")`. The recipe planner can legitimately produce `bundles=[public_web_lookup]` without `requestedTools=["web_search"]` (the two derivations are independent in `resolution-contract.ts`). When that happens today, the gate skips and the chain leads with claude-opus-4.6 → DDG scraper → bot-detection. Broadening the predicate to include `bundles.includes("public_web_lookup")` AND replacing the substring lookup with a curated closed set `NATIVE_WEB_SEARCH_MODEL_IDS` closes this narrow case without touching bundle-as-schema-contract semantics.

**H2 (NOT addressed; documented in §8):** When the classifier mis-emits `bundles=[respond_only] requestedTools=[]` for a turn that *does* need fresh data (turns `efcc1476` and `355ae135`), neither H1's broadened predicate nor any narrow fix can catch it. Closing this requires either (a) bundle-as-contract enforcement at the schema layer (architectural; risks regressing turn `26092435`-class flows that depend on bundle being advisory) or (b) IntentContractor surfacing a structural `freshness` constraint and routing keying off it (architectural; new SemanticIntent field, requires #6-respecting wiring).

## 4. Scope-of-fix matrix

| # | Layer | File | Change | LOC est. | Invariant |
| --- | --- | --- | --- | --- | --- |
| 1 | Native-search capability set | `src/platform/decision/route-preflight.ts` | Module-top `const NATIVE_WEB_SEARCH_MODEL_IDS = new Set(["grok-4"])` + cross-ref comment to models.json compat | ~8 | #11 (mirrors frozen models.json compat, no contract change) |
| 2 | Capability predicate | `src/platform/decision/route-preflight.ts` | New private `hasNativeWebSearchCapability(candidate)` returning exact-set membership | ~6 | — |
| 3 | Planner-input Pick widening | `src/platform/decision/route-preflight.ts` | Extend `LocalRoutingPlannerInput` Pick with `"resolutionContract"` (private type, not exported) | ~1 | — |
| 4 | Gate predicate broadening | `src/platform/decision/route-preflight.ts` | Replace lines 796–812: `isWebSearchSignaled = requestedTools.includes("web_search") \|\| (resolutionContract?.toolBundles ?? []).includes("public_web_lookup")`; candidate lookup via `findIndex(hasNativeWebSearchCapability)`; refreshed `reason` string; reasonCode unchanged | ~25 | #5 (structural reads only), #11 (reasonCode unchanged) |
| 5 | Tests | `src/platform/decision/route-preflight.test.ts` | 3 new tests (bundle-only signal, exact-match capability, no-op when chain has no native-search candidate) + verify existing 2 web_search tests still pass | ~80 | — |

**Total:** ~120 LOC across 2 files. Frozen layer not touched. No public API surface change.

## 5. Acceptance criteria

1. `requestedTools=["web_search"]` + chain `[claude-opus-4.6, gpt-5.4, grok-4, hydra-gpt-pro]` → grok-4 promoted first; reasonCode `preflight_routed_grok_for_web_search`; remaining chain order preserved. (Existing test, no regression.)
2. `requestedTools=[]` + `resolutionContract.toolBundles=["public_web_lookup"]` + chain with grok-4 present → grok-4 promoted first; same reasonCode. (NEW behavior.)
3. `requestedTools=["web_search"]` + chain `[claude-opus-4.6, hydra/grok-coder-fast-1]` (NO grok-4) → no promotion; `grok-coder-fast-1` is NOT in `NATIVE_WEB_SEARCH_MODEL_IDS`; reasonCode is NOT `preflight_routed_grok_for_web_search`. (NEW; defends against substring-match regression.)
4. `bundles=["public_web_lookup"]` + chain `[claude-opus-4.6, gpt-5.4, hydra-gpt-pro]` (no native-search candidate) → no promotion; reasonCode is NOT `preflight_routed_grok_for_web_search`. (NEW.)
5. `bundles=[respond_only] requestedTools=[]` + chain with grok-4 present → no promotion (gate doesn't fire — NEITHER signal present). (Existing implicit behavior preserved.)
6. `pnpm tsgo` clean; `pnpm test -- src/platform/decision/route-preflight.test.ts` green; ReadLints clean.
7. Hard invariants #5, #6, #8, #11, #15 unchanged. Frozen layer (`ModelRoutePreflightDecision.reasonCode` union) unchanged. `ResolutionContract` shape unchanged. `RecipeRoutingHints` unchanged.

## 6. Implementation notes

### 6.1. The capability set

```ts
/**
 * Models with `compat.nativeWebSearchTool: true` in
 * `~/.openclaw-dev/agents/dev/agent/models.json`.
 *
 * SOURCE OF TRUTH for which candidates can serve web_search end-to-end via
 * Hydra without falling back to OpenClaw's local DDG scraper. Mirror this set
 * any time a new model gains `nativeWebSearchTool: true` in models.json.
 *
 * Current members:
 * - grok-4 — xAI Live Search via openai-completions schema (PR-#125 added the
 *   compat block).
 */
const NATIVE_WEB_SEARCH_MODEL_IDS: ReadonlySet<string> = new Set(["grok-4"]);

function hasNativeWebSearchCapability(candidate: ModelCandidate): boolean {
  return NATIVE_WEB_SEARCH_MODEL_IDS.has(candidate.model.trim().toLowerCase());
}
```

### 6.2. Planner-input widening

```ts
type LocalRoutingPlannerInput = Pick<
  RecipePlannerInput,
  | "intent"
  | "requestedTools"
  | "fileNames"
  | "artifactKinds"
  | "routing"
  | "resolutionContract"
>;
```

`resolutionContract` (frozen `ResolutionContract`) carries `toolBundles: ResolutionToolBundle[]`. We READ `toolBundles` only — no shape mutation.

### 6.3. The gate

```ts
// Tool-aware routing (extended from PR-#125): when the turn signals a
// web_search need — either explicitly via requestedTools OR structurally via
// the public_web_lookup bundle — promote any candidate that has a working
// native search capability ahead of the configured chain. OpenClaw's local
// DDG-backed web_search tool is rate-limited / bot-detected, and for models
// without compat.nativeWebSearchTool=true an autonomous web_search call
// dies with `Provider finish_reason: error` (gateway-grok-route.log
// 2026-05-02 turn 355ae135). Today only grok-4 carries the marker; the
// curated NATIVE_WEB_SEARCH_MODEL_IDS set must be kept in sync with
// models.json compat blocks. Fallbacks remain in their original order
// behind the promoted candidate — failover semantics unchanged.
const requestedTools = plannerInput.requestedTools ?? [];
const toolBundles = plannerInput.resolutionContract?.toolBundles ?? [];
const isWebSearchSignaled =
  requestedTools.includes("web_search") || toolBundles.includes("public_web_lookup");
if (isWebSearchSignaled) {
  const nativeIndex = list.findIndex(hasNativeWebSearchCapability);
  if (nativeIndex > 0) {
    const native = list[nativeIndex];
    const ordered = [native, ...list.filter((_, idx) => idx !== nativeIndex)];
    return {
      candidates: ordered,
      decision: buildDecisionForOrdered(ordered, {
        reasonCode: "preflight_routed_grok_for_web_search",
        reason: `Promoted ${native.provider}/${native.model} ahead of the configured chain because the turn signals web_search (requestedTools or public_web_lookup bundle) and ${native.provider}/${native.model} is the candidate with compat.nativeWebSearchTool=true.`,
        localRoutingEligible: false,
        reordered: true,
      }),
    };
  }
}
```

`reasonCode` reused unchanged: extending the frozen `ModelRoutePreflightDecision.reasonCode` union to `"preflight_routed_native_search"` would force the `compatibility` PR-body checkbox; deferred until a second native-search model lands and the rename becomes load-bearing.

### 6.4. Tests

Add to `src/platform/decision/route-preflight.test.ts`:

```ts
it("promotes hydra/grok-4 first when bundles=[public_web_lookup] and requestedTools is empty (slice B bundle-signal)", () => {
  const chain: ModelCandidate[] = [
    { provider: "hydra", model: "claude-opus-4.6" },
    { provider: "hydra", model: "gpt-5.4" },
    { provider: "hydra", model: "grok-4" },
    { provider: "hydra", model: "hydra-gpt-pro" },
  ];
  const { candidates, decision } = applyModelRoutePreflight({
    candidates: chain,
    plannerInput: {
      intent: "general",
      requestedTools: [],
      resolutionContract: {
        // minimal frozen shape — only toolBundles read by the gate
        toolBundles: ["public_web_lookup"],
      } as unknown as ResolutionContract,
    },
  });
  expect(candidates[0]).toEqual({ provider: "hydra", model: "grok-4" });
  expect(decision?.reasonCode).toBe("preflight_routed_grok_for_web_search");
  expect(decision?.reordered).toBe(true);
});

it("uses exact-match against NATIVE_WEB_SEARCH_MODEL_IDS, ignoring grok-named models without nativeWebSearchTool", () => {
  const chain: ModelCandidate[] = [
    { provider: "hydra", model: "claude-opus-4.6" },
    { provider: "hydra", model: "grok-coder-fast-1" }, // grok-named but no nativeWebSearchTool
  ];
  const { candidates, decision } = applyModelRoutePreflight({
    candidates: chain,
    plannerInput: { intent: "general", requestedTools: ["web_search"] },
  });
  expect(candidates).toEqual(chain);
  expect(decision?.reasonCode).not.toBe("preflight_routed_grok_for_web_search");
});

it("leaves chain unchanged when public_web_lookup bundle is signaled but no native-search candidate is in the chain", () => {
  const chain: ModelCandidate[] = [
    { provider: "hydra", model: "claude-opus-4.6" },
    { provider: "hydra", model: "gpt-5.4" },
  ];
  const { candidates, decision } = applyModelRoutePreflight({
    candidates: chain,
    plannerInput: {
      intent: "general",
      requestedTools: [],
      resolutionContract: {
        toolBundles: ["public_web_lookup"],
      } as unknown as ResolutionContract,
    },
  });
  expect(candidates).toEqual(chain);
  expect(decision?.reasonCode).not.toBe("preflight_routed_grok_for_web_search");
});
```

Existing tests at lines 161 and 186 are unaffected (they test the `requestedTools.includes("web_search")` branch with grok-4 present / absent).

## 7. Handoff Log

### 2026-05-02 — Bootstrap audit + sub-plan

Investigation findings (Phases 1+2):

**Phase 1 — capability map.** Read `~/.openclaw-dev/agents/dev/agent/models.json` (463 LOC). Of the 21 hydra-proxied models, ONLY `grok-4` carries `compat: { nativeWebSearchTool: true, toolSchemaProfile: "xai", toolCallArgumentsEncoding: "html-entities" }` (lines 348–352). All other models use the bare `openai-completions` API path; their `web_search` tool calls would route through OpenClaw's local DDG scraper which fails under bot-detection. Architecturally, only the xAI Live Search backend can serve web_search server-side via the Hydra proxy on the openai-completions schema; non-xAI hydra-proxied models would require client-side function-tool execution. Curl probes intentionally skipped — the protocol fundamentals plus the existing PR-#125 documentation already establish the conclusion.

**Phase 2 — bundle vs schema audit.** Read `route-preflight.ts:1–1100`, `tool-registry.ts`, `tool-catalog.ts`, `pi-tools.ts:60–280` (`createOpenClawCodingTools` signature + `applyModelProviderToolPolicy` filter), `pi-embedded-runner/run/attempt.ts:1880–1980` (the actual call site). Findings:
1. `bundle` is **advisory**, not a schema filter. `attempt.ts:1915–1971` builds the tool list with `createOpenClawCodingTools(...)` passing 50+ params, NONE of which is `toolBundles`. The bundle is a planner/recipe hint that never reaches the LLM tool schema.
2. The only model-capability filter that exists at the schema layer is `applyModelProviderToolPolicy` (`pi-tools.ts:94–104`), which REMOVES `web_search` from the schema for models with `nativeWebSearchTool=true` (so grok-4 does not see the OpenClaw DDG tool — its native search is used instead). For models without the marker, the DDG tool stays.
3. Heartbeat turn `26092435` (gateway-grok-route.log line 124–143) demonstrates that hard bundle filtering would regress `bundles=[respond_only]` flows that legitimately need tools. Closing the architectural gap is deferred (§8).
4. `route-preflight.ts:796–812` — PR-#125 gate predicate (`requestedTools.includes("web_search")`) and candidate predicate (`includes("grok")`) — both narrow. This slice broadens both.

Frozen layer impact assessment:
- `ModelRoutePreflightDecision.reasonCode` union (`contracts.ts`) — UNCHANGED. Reusing existing `preflight_routed_grok_for_web_search`.
- `ResolutionContract.toolBundles` — READ only, shape unchanged.
- `RecipePlannerInput` — extending the *internal* `LocalRoutingPlannerInput` Pick (private to `route-preflight.ts`); `RecipePlannerInput` itself unchanged.
- 5 frozen contracts (#11) — none modified.
- 4 frozen call sites — not in path.

Hard invariants check (16):
- #5 — gate reads only `requestedTools` (string[]) and `resolutionContract.toolBundles` (string[]); zero raw user text reads.
- #6 — `IntentContractor` not touched.
- #8 — edit lives in `decision/`, no `commitment/` import added or moved.
- #11 — 5 frozen contracts unchanged.
- #12 — not an emergency phrase patch.
- #15 — narrow bug-fix slice; signoff not required.

### 2026-05-02 — Implementation, tests, merge

(To be filled after merge — PR # / merge SHA / live verification result.)

## 8. Adjacent / deferred bugs (signoff required; out of scope for this slice)

| Order | Bug | Symptom | Required scope | Why deferred |
| --- | --- | --- | --- | --- |
| 1 | **Bundle-as-contract enforcement at the LLM schema layer** | When the classifier mis-emits `bundles=[respond_only] requestedTools=[]` but the user actually needs fresh data (turn `355ae135` line 157 — `Provider finish_reason: error` after autonomous web_search hits DDG bot-detection), no narrow routing gate can catch it because neither signal reaches preflight. Hard fix: thread `toolBundles` from planner output into `attempt.ts:1915` and filter the tool schema with a curated `BUNDLE_TO_TOOL_ALLOWLIST` (e.g. `respond_only` excludes `web_search`). | (a) New parameter `toolBundles?: ResolutionToolBundle[]` on `createOpenClawCodingTools`. (b) `BUNDLE_TO_TOOL_ALLOWLIST` curated map. (c) Wire the bundle from `attempt.ts` params (which itself needs the field threaded from planner output via the runner-execution glue). (d) Tests for every bundle × tool intersection. | Heartbeat turn `26092435` proves bundle is currently advisory — flows depend on model tool autonomy. Hard filtering = behavior change crossing bundle-as-contract semantics. Maintainer signoff required (invariant #15-equivalent class). |
| 2 | **IntentContractor `freshness` / `recency` constraint surface** | Same misclassification case as #1, addressed from the routing side instead of the schema side. IntentContractor would emit a structural `constraints.freshness: "current" \| "historical" \| undefined` (closed-string union). Route-preflight gate would also fire on `intent.constraints.freshness === "current"` even when `requestedTools=[]` and `bundles=[respond_only]`. | (a) Extend `SemanticIntent.constraints` shape. (b) Update `IntentContractor` prompt + reshape to populate from raw text WITHOUT phrase-matching outside the IntentContractor whitelist (#5). (c) Wire `intent` exposure through `RunTurnDecisionResult.intent?` (already partially exposed for PR-H Phase 2) into preflight. | New SemanticIntent field is structural; risk of mis-classification on its own. Cleaner deferred until #1 lands or is rejected. |
| 3 | **`ModelRoutePreflightDecision.reasonCode` rename** `preflight_routed_grok_for_web_search` → `preflight_routed_native_search` | Naming staleness once a second native-search model lands. | Frozen union edit + `compatibility` PR-body checkbox + downstream telemetry consumers. | Defer until a second model (e.g. an Anthropic-with-search variant or a Gemini variant) gains the marker. |
| 4 | **`ModelCatalogEntry.compat?: ModelCompatConfig`** | Eliminates the curated `NATIVE_WEB_SEARCH_MODEL_IDS` mirror by letting `findModelInCatalog` return compat directly. | Type widening; verify all `loadModelCatalog` paths populate compat from underlying `Model<Api>` objects. | Cosmetic / structural improvement, not blocking. Pickup any time the curated set grows past 1 entry. |

## 9. References

- Master plan: `.cursor/plans/commitment_kernel_v1_master.plan.md` (§0 PR Progress Log, §0.5 Audit Findings — new row to be added in handoff for "tool exposure ↔ model capability gating", §3 hard invariants).
- Roadmap: `.cursor/plans/commitment_kernel_smart_orchestrator_roadmap.plan.md` (§6 Handoff Log — new row this slice, §8 forward-deferred slices — Telegram caption-overflow already there).
- PR-#125 baseline: merge `e3d8c538f8` — original grok-promotion gate this slice broadens.
- Live evidence: `gateway-grok-route.log` (2026-05-02 11:06–11:21 turns `efcc1476` / `26092435` / `355ae135`).
- Capability source-of-truth: `~/.openclaw-dev/agents/dev/agent/models.json` (grok-4 compat block lines 348–352).
- Code paths:
  - `src/platform/decision/route-preflight.ts:11` (`LocalRoutingPlannerInput` Pick), `:796–812` (PR-#125 gate this slice replaces).
  - `src/platform/decision/contracts.ts:93` (`ModelRoutePreflightDecision.reasonCode` frozen union).
  - `src/platform/recipe/planner.ts:206` (`RecipePlannerInput` shape) / `:525` (`toolBundlesMatchRecipe` — bundle-recipe matching that today does not propagate to schema).
  - `src/platform/decision/resolution-contract.ts:412` (`deriveToolBundles`) / `:61` (`ResolutionToolBundleSchema`).
  - `src/agents/model-compat.ts:39–56` (`applyXaiModelCompat`, `hasNativeWebSearchTool` — capability marker helpers).
  - `src/agents/pi-tools.ts:94–104` (`applyModelProviderToolPolicy` — schema-layer xai-native filter).
  - `src/agents/pi-embedded-runner/run/attempt.ts:1915–1971` (`createOpenClawCodingTools` call site that has NO bundle parameter today — see §8 row 1).
- Hard invariants: `.cursor/rules/commitment-kernel-invariants.mdc` (16 invariants, all preserved).

---

**Stop gate:** narrow improvement; ship the slice; if live verify after restart still shows turn-class `355ae135` failures (classifier-mis-emit case), escalate to §8 row 1 sub-plan with maintainer signoff.
