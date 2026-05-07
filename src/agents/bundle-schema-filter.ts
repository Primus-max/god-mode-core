// Bundle-as-contract Phase 2 — types + closed `BundleId → allowed-tool-set`
// mapping + pure `resolveBundleAllowedTools` resolver.
//
// Lives under `src/agents/` (orchestration / adapter layer) per master invariant
// #11 — `src/platform/commitment/**` is NOT touched, and per invariant #8 the
// fix lives in the orchestration layer rather than crossing back into
// `src/platform/decision/`. `BundleId` is a single-source-of-truth re-export of
// `ResolutionToolBundle` (closed Zod enum at
// `src/platform/decision/resolution-contract.ts:12-23`); widening the bundle id
// set requires a separate signoff and a dedicated sub-plan (see
// `commitment_kernel_bundle_as_contract.plan.md` §5 out-of-scope row 5).
//
// Phase 3 (next slice) adds the pure `filterToolSchemaByBundle(...)` helper
// that consumes the `BundleAllowedTools` discriminated union returned by
// `resolveBundleAllowedTools`. Phase 4 wires it at
// `src/agents/pi-embedded-runner/run/attempt.ts:2004`. Phases 3-4 are
// deliberately NOT introduced here.
//
// Sub-plan: .cursor/plans/commitment_kernel_bundle_as_contract.plan.md
// (todo `bundle-contract-phase-2-types`).
// Audit anchor: extensions/AUDIT-bundle-as-contract.md §1, §6 (bundle-emission
// contracts), §8 Phase-2 checklist.

import { z } from "zod";
import {
  ResolutionToolBundleSchema,
  type ResolutionToolBundle,
} from "../platform/decision/resolution-contract.js";

/**
 * Single source of truth — re-export of the closed `ResolutionToolBundle`
 * union (9 closed values: `respond_only`, `repo_run`, `repo_mutation`,
 * `interactive_browser`, `public_web_lookup`, `document_extraction`,
 * `artifact_authoring`, `external_delivery`, `session_orchestration`).
 *
 * Re-export — NEVER widen. The Zod enum at
 * `src/platform/decision/resolution-contract.ts:12-23` is the authoritative
 * shape; this module imports it verbatim.
 */
export type BundleId = ResolutionToolBundle;

/**
 * The set of LLM tool names allowed for a single `BundleId`. Tool names are
 * the canonical `tool.name` strings emitted by the `createOpenClawCodingTools`
 * factory at `src/agents/pi-tools.ts:200` (e.g. `"web_search"`, `"web_fetch"`,
 * `"exec"`, `"apply_patch"`, `"pdf"`, `"image_generate"`, ...). The set is
 * `ReadonlySet<string>` so callers cannot mutate the default mapping.
 */
export type BundleAllowedToolSet = ReadonlySet<string>;

/**
 * Behaviour for a turn that arrives with an empty `bundles: BundleId[]`
 * array (legacy non-`contractFirst` callers, heartbeat / cron / synthetic
 * flows that bypass the classifier — see audit §6.2).
 *
 * - `'allow_all'` (default): `resolveBundleAllowedTools` returns
 *   `{ kind: 'allow_all' }` — Phase 3's filter MUST treat this as
 *   "no restriction / pass-through" so byte-identical legacy behaviour is
 *   preserved (regression guard for empty-bundles class). This is the
 *   default per audit §6.2 / §7.3 risk row 1.
 * - `'restrict_to_default'`: returns `{ kind: 'restrict_to', tools:
 *   config.defaultAllowedTools ?? new Set() }`. Used by stricter call sites
 *   that prefer fail-closed posture for missing-bundle inputs.
 */
export type MissingBundlePolicy = "allow_all" | "restrict_to_default";

/**
 * Configuration for `resolveBundleAllowedTools`.
 *
 * - `allowedToolsByBundle`: per-bundle allowlists. Closed by the Zod schema
 *   (rejects unknown bundle ids). The `DEFAULT_BUNDLE_ALLOWED_TOOLS` constant
 *   is the canonical default — pass it directly OR pass a downstream-customised
 *   map. NO bundle id may be left unmapped (the closed-shape coverage test
 *   in `bundle-schema-filter.types.test.ts` enforces this for the default).
 * - `defaultAllowedTools`: tool set used by the `'restrict_to_default'`
 *   missing-bundle policy. Defaults to empty when unset.
 * - `missingBundlePolicy`: behaviour when the resolver receives an empty
 *   bundle array. See `MissingBundlePolicy` above.
 */
export type BundleSchemaFilterConfig = {
  readonly allowedToolsByBundle: ReadonlyMap<BundleId, BundleAllowedToolSet>;
  readonly defaultAllowedTools?: BundleAllowedToolSet;
  readonly missingBundlePolicy?: MissingBundlePolicy;
};

/**
 * Discriminated-union result from `resolveBundleAllowedTools`.
 *
 * - `{ kind: 'allow_all' }` — Phase 3's filter treats this as "no restriction
 *   / pass-through". Used for `bundles.length === 0` AND
 *   `missingBundlePolicy='allow_all'` (regression-parity branch). The
 *   discriminated-union form is preferred over `null` / sentinel symbols
 *   because consumers cannot accidentally treat a "no restriction" decision
 *   as an empty allowlist (which would drop ALL tools — the exact regression
 *   failure mode the missing-bundle policy is designed to avoid).
 * - `{ kind: 'restrict_to', tools }` — Phase 3's filter keeps only tools whose
 *   `name` is in `tools`.
 *
 * Naming: `BundleAllowedTools` (singular outer / plural concept) — the
 * consumer of `resolveBundleAllowedTools` calls it once and pattern-matches on
 * `result.kind`.
 */
export type BundleAllowedTools =
  | { readonly kind: "allow_all" }
  | { readonly kind: "restrict_to"; readonly tools: BundleAllowedToolSet };

/**
 * Closed initial mapping of `BundleId → BundleAllowedToolSet`. Frozen via
 * `Object.freeze` (the `ReadonlyMap` declaration is structural; the
 * `Object.freeze` call hardens the runtime shape so a careless caller cannot
 * mutate the constant in place via a downcast).
 *
 * Tool names are the canonical `tool.name` strings actually emitted by the
 * production `createOpenClawCodingTools(...)` catalog (audit §3.1). Allowlists
 * for bundle classes whose production tool names are not yet known (e.g.
 * `interactive_browser` whose factory only emits `"browser"` not
 * `"browser_navigate"`/`"browser_click"`/...) are kept narrow rather than
 * widened with guessed aliases — per sub-plan instruction "Prefer empty +
 * document than guess wrong tool names." Phase 3 / 4 may widen these as the
 * empirical catalog drift is mapped; widening this constant is a strict
 * superset operation that does NOT affect the closed `BundleId` enum.
 *
 * Bundle-by-bundle rationale:
 * - `respond_only` — empty by definition (chit-chat turn; no tools).
 * - `public_web_lookup` — DDG / fetch tools surfaced by `web-tools.ts`.
 * - `interactive_browser` — single `"browser"` tool emitted by
 *   `tools/browser-tool.ts:306`. No `browser_*` aliases exist in the catalog.
 * - `document_extraction` — no production extraction tools currently emit a
 *   `pdf_extract` / `docx_extract` name; the closest catalog members
 *   (`pdf` / `docx_write`) are AUTHORING tools (audit §3.1). Keep narrow:
 *   empty for now; widening MUST cite an actual catalog tool name.
 * - `artifact_authoring` — `pdf` / `docx_write` / `image_generate` /
 *   `apply_patch` exist in the catalog (`tools/pdf-tool.ts:669`,
 *   `tools/docx-tool.ts:137`, `tools/image-generate-tool.ts:591`,
 *   `apply-patch.ts:94`). `csv_write` / `xlsx_write` / `site_pack` /
 *   `image` / `canvas` are also authoring-class but the sub-plan §3.3 mapping
 *   table whitelists only the four canonical names; downstream Phase 3 may
 *   widen this set if the live runbook surfaces a catalog-drift gap.
 * - `external_delivery` — no `delivery_*` tools exist in the catalog
 *   (`message` is the closest, but its scope is broader than delivery).
 *   Keep empty; widening requires identifying a concrete catalog name.
 * - `session_orchestration` — `sessions_spawn` / `sessions_yield` /
 *   `sessions_list` / `sessions_history` / `sessions_send` /
 *   `session_status` / `subagents` exist in the catalog
 *   (`tools/sessions-*.ts`, `tools/session-status-tool.ts:209`,
 *   `tools/subagents-tool.ts:34`).
 * - `repo_run` — `exec` (`bash-tools.exec.ts:229`) and `apply_patch`
 *   (`apply-patch.ts:94`).
 * - `repo_mutation` — `exec` + `apply_patch`. No `git_*` tools currently
 *   exist in the catalog; spec sub-plan §3.3 listed `git_*` aspirationally.
 *   Keep `exec` + `apply_patch`; widening MUST cite an actual git tool name.
 *
 * IMPORTANT: every `BundleId` enum member MUST appear as a key (closed-shape
 * coverage test in `bundle-schema-filter.types.test.ts` enforces this — a
 * future widening of `ResolutionToolBundleSchema` without a corresponding
 * entry here will fail-fast in CI).
 */
export const DEFAULT_BUNDLE_ALLOWED_TOOLS: ReadonlyMap<BundleId, BundleAllowedToolSet> =
  Object.freeze(
    new Map<BundleId, BundleAllowedToolSet>([
      ["respond_only", new Set<string>()],
      ["public_web_lookup", new Set<string>(["web_search", "web_fetch"])],
      ["interactive_browser", new Set<string>(["browser"])],
      ["document_extraction", new Set<string>()],
      [
        "artifact_authoring",
        new Set<string>(["pdf", "docx_write", "image_generate", "apply_patch"]),
      ],
      ["external_delivery", new Set<string>()],
      [
        "session_orchestration",
        new Set<string>([
          "sessions_spawn",
          "sessions_yield",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "session_status",
          "subagents",
        ]),
      ],
      ["repo_run", new Set<string>(["exec", "apply_patch"])],
      ["repo_mutation", new Set<string>(["exec", "apply_patch"])],
    ]),
  );

/**
 * Strict Zod validator for `BundleSchemaFilterConfig`.
 *
 * - `allowedToolsByBundle` is validated as `z.map(BundleIdSchema, z.set(z.string()))`.
 *   Unknown bundle ids are rejected by the closed `ResolutionToolBundleSchema`
 *   enum (defense-in-depth — TypeScript already forbids them at compile time,
 *   but Zod catches runtime drift from JSON-deserialised configs).
 * - `defaultAllowedTools` is optional `z.set(z.string())`.
 * - `missingBundlePolicy` is the closed enum `'allow_all' | 'restrict_to_default'`.
 * - `.strict()` rejects unknown keys — protects against config-shape drift in
 *   Phase 3+ wiring sites.
 */
export const BundleSchemaFilterConfigSchema = z
  .object({
    allowedToolsByBundle: z.map(ResolutionToolBundleSchema, z.set(z.string())),
    defaultAllowedTools: z.set(z.string()).optional(),
    missingBundlePolicy: z.enum(["allow_all", "restrict_to_default"]).optional(),
  })
  .strict();

/**
 * Resolve the union of allowlists for the given `bundles`, honouring the
 * configured `missingBundlePolicy` for empty inputs.
 *
 * Semantics:
 * - `bundles.length === 0` AND `missingBundlePolicy === 'restrict_to_default'`
 *   → returns `{ kind: 'restrict_to', tools: config.defaultAllowedTools ?? new Set() }`.
 * - `bundles.length === 0` AND `missingBundlePolicy === 'allow_all'` (also the
 *   default when undefined) → returns `{ kind: 'allow_all' }`. Phase 3's
 *   filter MUST pass-through the catalog unchanged for this branch.
 * - `bundles.length > 0` → returns `{ kind: 'restrict_to', tools: union }`,
 *   where `union` is the union of `config.allowedToolsByBundle.get(b)` for
 *   each `b` in `bundles`. Unknown bundle ids are silently treated as empty
 *   — defense-in-depth for the closed-enum guard. Per invariant #15 the
 *   resolver NEVER throws.
 *
 * Pure — no side effects, no mutation of input arrays / sets / map.
 */
export function resolveBundleAllowedTools(
  bundles: readonly BundleId[],
  config: BundleSchemaFilterConfig,
): BundleAllowedTools {
  if (bundles.length === 0) {
    const policy = config.missingBundlePolicy ?? "allow_all";
    if (policy === "allow_all") {
      return { kind: "allow_all" };
    }
    // 'restrict_to_default' — empty-set fallback when no default configured.
    return {
      kind: "restrict_to",
      tools: config.defaultAllowedTools ?? new Set<string>(),
    };
  }

  const union = new Set<string>();
  for (const bundle of bundles) {
    const allowed = config.allowedToolsByBundle.get(bundle);
    if (allowed === undefined) {
      // Defensive — TS already forbids non-`BundleId` keys at compile time.
      // Closed enum + closed-shape default coverage test guard against
      // run-time drift; we treat unknown ids as empty rather than throw
      // (invariant #15 — filter never throws).
      continue;
    }
    for (const tool of allowed) {
      union.add(tool);
    }
  }
  return { kind: "restrict_to", tools: union };
}
