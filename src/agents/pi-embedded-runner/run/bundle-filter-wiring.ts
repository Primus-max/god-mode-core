// Bundle-as-contract Phase 4 / Phase 6 — wiring adapter for `attempt.ts:2004`.
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
// Phase 6 ADDS the `[bundle-filter]` telemetry log line. The line is emitted
// at filter exit and follows the spec from sub-plan §3.5:
//   `[bundle-filter] turnId=<...> bundles=[<...>] removed_tools=[<name>:<reason>,...] kept_tools=[<...>]`
// `info` level when removals > 0; `debug` level when zero removals.
// Telemetry NEVER throws — emission is wrapped in try/catch (#15) and a
// missing logger is treated as a noop. The log line is for operator runbook
// debugging; assertion-grade tests use the optional `logger` param and a
// capture array.
//
// Phase 6 does NOT modify `applyModelProviderToolPolicy`. Phase 6 does NOT
// widen the bundle id enum or the default allowlist. Phase 6 does NOT change
// any of the existing return semantics — the `kept` / `removed` shape is
// unchanged.
//
// Sub-plan: .cursor/plans/commitment_kernel_bundle_as_contract.plan.md
// (todos `bundle-contract-phase-4-attempt-wiring`,
// `bundle-contract-phase-6-telemetry-and-acceptance`).

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
 * Minimal logger surface for `[bundle-filter]` telemetry. Compatible with the
 * production `SubsystemLogger` (see `src/logging/subsystem.ts`) — both
 * `info` and `debug` accept `(message: string, meta?: Record<string, unknown>)`,
 * so production callers can pass the existing `log` instance directly. Tests
 * pass a thin capture stub. Defined locally so the wiring file does not
 * pull a logging-subsystem import (keeps the import graph minimal and the
 * filter pure-by-default — invariant #15 demands the filter never throws,
 * and a defensive logger surface is the smallest contract that supports it).
 */
export type BundleFilterTelemetryLogger = {
  readonly info: (message: string, meta?: Record<string, unknown>) => void;
  readonly debug: (message: string, meta?: Record<string, unknown>) => void;
};

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
 * Phase 6 also emits the `[bundle-filter]` telemetry log line at exit when
 * a `logger` is supplied; the return shape is unchanged.
 *
 * Telemetry (Phase 6):
 *   `[bundle-filter] turnId=<...> bundles=[<...>] removed_tools=[<name>:<reason>,...] kept_tools=[<...>]`
 * Emitted at `info` when removals > 0; at `debug` otherwise. Telemetry is
 * defensive: a missing `logger` is treated as a noop, and the emission is
 * wrapped in try/catch so a logger throwing CANNOT propagate into the
 * filter-result path (invariant #15).
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
  readonly turnId?: string;
  readonly logger?: BundleFilterTelemetryLogger;
}): BundleSchemaFilterResult<TTool> {
  const bundles = readToolBundlesFromPlatformExecutionContext(
    input.platformExecutionContext,
  );
  const result = filterToolSchemaByBundle({
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
  emitBundleFilterTelemetry({
    logger: input.logger,
    turnId: input.turnId,
    bundles,
    result,
  });
  return result;
}

/**
 * Emit the `[bundle-filter]` telemetry log line. Defensive: never throws,
 * never propagates a logger error into the filter result. When `logger` is
 * `undefined` this is a noop (Phase 4 wiring sites that have not adopted
 * Phase 6 yet keep working with byte-identical behaviour).
 *
 * Format spec (sub-plan §3.5):
 *   `[bundle-filter] turnId=<id> bundles=[<b1>,<b2>] removed_tools=[<name>:<reason>,...] kept_tools=[<n1>,<n2>,...]`
 *
 * `info` level when `result.removed.length > 0`; `debug` otherwise. The
 * level split lets operators search for the actionable cases (some tool was
 * removed) at `info` while the full audit trail is still recorded at
 * `debug`.
 */
function emitBundleFilterTelemetry<
  TTool extends { readonly name?: string },
>(args: {
  readonly logger: BundleFilterTelemetryLogger | undefined;
  readonly turnId: string | undefined;
  readonly bundles: readonly BundleId[];
  readonly result: BundleSchemaFilterResult<TTool>;
}): void {
  if (args.logger === undefined) {
    return;
  }
  try {
    const removedDescriptors = args.result.removed
      .map((r) => `${r.tool}:${r.reason}`)
      .join(",");
    const keptNames = args.result.kept
      .map((t) => t.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0)
      .join(",");
    const bundlesList = args.bundles.join(",");
    const turnIdSegment = args.turnId ?? "<unknown>";
    const message = `[bundle-filter] turnId=${turnIdSegment} bundles=[${bundlesList}] removed_tools=[${removedDescriptors}] kept_tools=[${keptNames}]`;
    if (args.result.removed.length > 0) {
      args.logger.info(message);
    } else {
      args.logger.debug(message);
    }
  } catch {
    // Invariant #15 — telemetry MUST NOT propagate. A logger that throws
    // (e.g. transient file-write failure during a runbook-restart race)
    // cannot break the filter result that the LLM call site depends on.
  }
}
