// Bundle-as-contract Phase 3 — pure `filterToolSchemaByBundle` helper.
//
// Lives under `src/agents/` (orchestration / adapter layer) per master
// invariant #11 (`src/platform/commitment/**` is NOT touched) and #8 (the
// fix lives in the orchestration layer rather than crossing back into
// `src/platform/decision/`). Phase 4 wires this helper at
// `src/agents/pi-embedded-runner/run/attempt.ts:2004`. This phase is
// deliberately stand-alone: NO caller wiring, NO modification of
// `applyModelProviderToolPolicy`, NO touch of `attempt.ts`.
//
// Sub-plan: .cursor/plans/commitment_kernel_bundle_as_contract.plan.md
// (todo `bundle-contract-phase-3-pure-filter`).
// Audit anchor: extensions/AUDIT-bundle-as-contract.md §3.4 reverse-defense
// rationale, §6 bundle-emission contracts.
//
// Architecture (two layers, applied in order):
//
//   1. **Bundle-allowlist filter** — drop any tool whose `name` is not in the
//      union of per-bundle allowlists for the supplied `bundles`. The
//      `BundleAllowedTools` discriminated union from `bundle-schema-filter.ts`
//      distinguishes `{ kind: 'allow_all' }` (legacy parity / pass-through —
//      empty bundles array + `missingBundlePolicy='allow_all'`) from
//      `{ kind: 'restrict_to', tools }` (closed allowlist). This is critical:
//      treating `allow_all` as an empty allowlist would drop every tool for
//      legacy callers (heartbeat / cron / synthetic flows that bypass the
//      classifier — audit §6.2 / §7.3 risk row 1).
//   2. **Reverse-defense filter** — when `modelCapabilities.nativeWebSearchTool
//      !== true` AND the turn does NOT carry `public_web_lookup`, drop any
//      `web_search` tool that survived layer 1. This is the symmetric defense
//      that `applyModelProviderToolPolicy` (`pi-tools.ts:94-104`) does NOT
//      provide: the sister filter only removes DDG `web_search` from
//      native-search models (forward direction); the reverse direction —
//      hiding DDG from non-native-search models — is the exact gap that the
//      `355ae135` symptom exposed. Bundle-driven authority: when the turn
//      legitimately carries `public_web_lookup`, the user (via the contractor)
//      asked for web lookup, and reverse-defense MUST NOT override that.
//
// Invariants honoured:
// - **#1, #2, #11**: filter is a pure orchestration-layer helper; no
//   `ExecutionCommitment` / `Affordance` shape change; no frozen-contract
//   touch.
// - **#5, #6**: the only inputs are structural (`BundleId[]` from
//   `ResolutionContract.toolBundles`, `nativeWebSearchTool` from
//   `ModelCompatConfig`, tool catalog with `name` strings). NO `RawUserTurn` /
//   `UserPrompt` reach this filter.
// - **#15**: never throws. Unknown tool name (no `.name`) → kept (conservative
//   — flagging as removed without evidence of what to flag is worse than
//   keeping a possibly-out-of-bundle tool that the LLM may not invoke
//   anyway). Unknown bundle id → silently treated as empty (closed enum +
//   closed-shape default-coverage test in
//   `bundle-schema-filter.types.test.ts` guards against drift).
//
// Pure: the helper produces NEW arrays. Input arrays / sets / maps are NEVER
// mutated. Reference equality of kept items is preserved (the helper does
// NOT clone the tool objects themselves) so downstream identity-sensitive
// checks (e.g. `applyModelProviderToolPolicy` already-filtered detection,
// future telemetry hashing) keep working.

import {
  type BundleId,
  type BundleSchemaFilterConfig,
  DEFAULT_BUNDLE_ALLOWED_TOOLS,
  resolveBundleAllowedTools,
} from "./bundle-schema-filter.js";

/**
 * Closed reason codes for a removed tool. Telemetry consumer at Phase 6 maps
 * these to the `[bundle-filter] removed_tools=[<name>:<reason>,...]` log line.
 */
export type BundleSchemaFilterRemovedReason =
  | "not_in_bundle_allowlist"
  | "reverse_defense_no_native_search";

/**
 * One row in the `removed` accumulator. `tool` is the canonical `tool.name`
 * string (or, for tools that lacked a `.name`, omitted entirely — see
 * conservative-keep rule for nameless tools).
 */
export type BundleSchemaFilterRemoved = {
  readonly tool: string;
  readonly reason: BundleSchemaFilterRemovedReason;
};

/**
 * Result of `filterToolSchemaByBundle`. `kept` preserves input order;
 * `removed` lists each dropped tool with its reason. `removed` records
 * tools removed by EITHER layer; only the layer that fired first records the
 * tool (a tool dropped by layer 1 cannot be dropped again by layer 2).
 */
export type BundleSchemaFilterResult<TTool extends { readonly name?: string }> = {
  readonly kept: readonly TTool[];
  readonly removed: readonly BundleSchemaFilterRemoved[];
};

/**
 * Parameters for `filterToolSchemaByBundle`.
 *
 * - `tools`: the LLM tool catalog — typically the result of
 *   `applyModelProviderToolPolicy(...)` at the wiring site (Phase 4). Generic
 *   over `{ readonly name?: string }` so callers can pass any tool-shape
 *   record without depending on a specific `AnyAgentTool` import (avoids
 *   coupling to `pi-tools.types`).
 * - `bundles`: the structural `BundleId[]` carried by the turn (sourced from
 *   `ResolutionContract.toolBundles`).
 * - `modelCapabilities.nativeWebSearchTool`: when `true`, reverse-defense is
 *   bypassed (the model has its own first-party search; DDG removal is a
 *   separate concern handled by `applyModelProviderToolPolicy`). When `false`
 *   or `undefined`, reverse-defense fires for `web_search` UNLESS the turn
 *   carries `public_web_lookup`.
 * - `config`: optional override for the per-bundle allowlist mapping +
 *   missing-bundle policy. Defaults to `DEFAULT_BUNDLE_ALLOWED_TOOLS` +
 *   implicit `'allow_all'` policy (legacy parity).
 */
export type BundleSchemaFilterParams<TTool extends { readonly name?: string }> = {
  readonly tools: readonly TTool[];
  readonly bundles: readonly BundleId[];
  readonly modelCapabilities?: { readonly nativeWebSearchTool?: boolean };
  readonly config?: BundleSchemaFilterConfig;
};

/**
 * Pure two-layer filter. See file header for full semantics.
 *
 * Returns `{ kept, removed }`. NEVER throws (#15). NEVER mutates inputs.
 */
export function filterToolSchemaByBundle<
  TTool extends { readonly name?: string },
>(params: BundleSchemaFilterParams<TTool>): BundleSchemaFilterResult<TTool> {
  const config: BundleSchemaFilterConfig =
    params.config ?? { allowedToolsByBundle: DEFAULT_BUNDLE_ALLOWED_TOOLS };

  const allowed = resolveBundleAllowedTools(params.bundles, config);

  // Pass-through fast path — `allow_all` is the legacy-parity branch
  // (empty bundles + `missingBundlePolicy='allow_all'`, used by heartbeat
  // / cron / synthetic flows that bypass the classifier). When the
  // resolver returns `allow_all` we honour byte-identical legacy behaviour
  // and do NOT run reverse-defense either: without a structural bundle
  // contract on the turn, we have no signed authority to override the
  // model-provider filter chain. Reverse-defense is a *contract-driven*
  // layer — it gates contracts, it is not a free-running guard. Audit
  // §6.2 / §7.3 risk row 1.
  if (allowed.kind === "allow_all") {
    return { kept: params.tools, removed: [] };
  }

  // Layer 2 gating bit — captured before we begin filtering so the closure
  // remains pure and stable across the loop. Reverse-defense applies only
  // under a `restrict_to` contract (the bundles ARE structurally present;
  // see allow_all early return above).
  const hasPublicWebLookup = params.bundles.includes("public_web_lookup");
  const reverseDefenseActive =
    params.modelCapabilities?.nativeWebSearchTool !== true &&
    !hasPublicWebLookup;

  const kept: TTool[] = [];
  const removed: BundleSchemaFilterRemoved[] = [];

  for (const tool of params.tools) {
    const name = tool.name;

    // Layer 1: bundle-allowlist filter.
    if (allowed.kind === "restrict_to") {
      // Conservative keep for nameless tools — the closed allowlist is
      // keyed by string `name`, so a tool with no `.name` cannot be
      // matched. Dropping silently would discard catalog members that
      // future refactors may legitimately use; recording them as
      // `not_in_bundle_allowlist` would also be misleading because the
      // bundle never explicitly excluded them. Per invariant #15 the
      // filter never throws and never spuriously flags — keep them.
      if (name === undefined) {
        kept.push(tool);
        continue;
      }
      if (!allowed.tools.has(name)) {
        removed.push({ tool: name, reason: "not_in_bundle_allowlist" });
        continue;
      }
    }
    // (allowed.kind === 'allow_all' falls through to layer 2 — no layer-1
    // drop because there is no restriction.)

    // Layer 2: reverse-defense — drop a `web_search` that survived layer 1
    // when the model has no native search AND the turn does not legitimise
    // public web lookup. This branch is reached for both `allow_all` (when
    // reverseDefenseActive is true) and `restrict_to` configs where the
    // bundle allowlist DID include `web_search` (e.g. a future drift or a
    // mis-wired downstream config).
    if (reverseDefenseActive && name === "web_search") {
      removed.push({
        tool: name,
        reason: "reverse_defense_no_native_search",
      });
      continue;
    }

    kept.push(tool);
  }

  return { kept, removed };
}
