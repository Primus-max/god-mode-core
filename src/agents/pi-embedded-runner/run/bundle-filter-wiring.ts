// Bundle-as-contract Phase 4 — wiring adapter for `attempt.ts:2004`.
//
// Lives next to `attempt.ts` (`src/agents/pi-embedded-runner/run/`) so the
// schema-construction site can call it inline without crossing additional
// import boundaries. The wiring is intentionally a thin adapter: it pulls
// `bundles` out of `RecipeRuntimePlan.resolutionContract` (the structural
// carrier identified in audit §5) and forwards the catalog through the pure
// `filterToolSchemaByBundle` helper from Phase 3.
//
// Design rationale (audit anchor: extensions/AUDIT-bundle-as-contract.md §5):
//
//   - `RunEmbeddedPiAgentParams.platformExecutionContext` already carries
//     `resolutionContract.toolBundles` — the runner just never read it for
//     tool-schema gating. NO new field on `EmbeddedRunAttemptParams`.
//   - For empty-bundles callers (heartbeat / cron / synthetic flows that
//     bypass the classifier — audit §6.2) the resolver returns
//     `{ kind: 'allow_all' }` and the filter is a byte-identical pass-through.
//     `missingBundlePolicy: 'allow_all'` is the explicit default.
//   - Reverse-defense gating uses `params.model.compat?.nativeWebSearchTool`
//     verbatim (the same field `applyModelProviderToolPolicy` reads), so the
//     two filters share a single source of truth for capability detection.
//
// Phase 4 does NOT emit telemetry (Phase 6 will add `[bundle-filter]` log
// line). Phase 4 does NOT modify `applyModelProviderToolPolicy`. Phase 4
// does NOT widen the bundle id enum or the default allowlist.
//
// Sub-plan: .cursor/plans/commitment_kernel_bundle_as_contract.plan.md
// (todo `bundle-contract-phase-4-attempt-wiring`).

import type { ModelCompatConfig } from "../../../config/types.models.js";
import type { RecipeRuntimePlan } from "../../../platform/recipe/runtime-adapter.js";
import {
  type BundleId,
  DEFAULT_BUNDLE_ALLOWED_TOOLS,
} from "../../bundle-schema-filter.js";
import {
  filterToolSchemaByBundle,
  type BundleSchemaFilterResult,
} from "../../bundle-schema-filter-apply.js";

/**
 * Read the structural `BundleId[]` carried by the turn's
 * `RecipeRuntimePlan.resolutionContract.toolBundles`. Returns an empty array
 * when the carrier is absent (legacy / test paths) — combined with
 * `missingBundlePolicy: 'allow_all'` this preserves byte-identical legacy
 * behaviour for those callers.
 *
 * Pure read-only — never mutates the input plan.
 */
export function readToolBundlesFromPlatformExecutionContext(
  platformExecutionContext: RecipeRuntimePlan | undefined,
): readonly BundleId[] {
  return platformExecutionContext?.resolutionContract?.toolBundles ?? [];
}

/**
 * Apply Phase 3's `filterToolSchemaByBundle` to the LLM tool catalog returned
 * by `createOpenClawCodingTools(...)`. Wires it at the schema-construction
 * site between the existing tool-policy chain (which lives inside
 * `createOpenClawCodingTools`) and the `disableWebSearchTool` /
 * `sanitizeToolsForGoogle` post-processing chain.
 *
 * Generic over `{ readonly name?: string }` so callers (production + tests)
 * can pass any tool-shape record. Production wiring at `attempt.ts:2004`
 * passes `AnyAgentTool[]`; tests pass minimal `{ name }` fixtures.
 *
 * Result: `{ kept, removed }`. The `kept` array is what feeds the LLM call.
 * `removed` is currently unused at the call site (Phase 4 keeps the diff
 * minimal); Phase 6 will pipe it into the `[bundle-filter]` telemetry line.
 *
 * Pure — never throws (#15), never mutates inputs. When `bundles` is empty
 * the result is byte-identical pass-through (audit §6.2 / §7.3 risk row 1).
 */
export function applyBundleSchemaFilterAtAttempt<
  TTool extends { readonly name?: string },
>(input: {
  readonly tools: readonly TTool[];
  readonly platformExecutionContext: RecipeRuntimePlan | undefined;
  readonly modelCompat: ModelCompatConfig | undefined;
}): BundleSchemaFilterResult<TTool> {
  const bundles = readToolBundlesFromPlatformExecutionContext(
    input.platformExecutionContext,
  );
  return filterToolSchemaByBundle({
    tools: input.tools,
    bundles,
    modelCapabilities: {
      nativeWebSearchTool: input.modelCompat?.nativeWebSearchTool === true,
    },
    config: {
      allowedToolsByBundle: DEFAULT_BUNDLE_ALLOWED_TOOLS,
      missingBundlePolicy: "allow_all",
    },
  });
}
