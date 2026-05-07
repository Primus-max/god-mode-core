// Bundle-as-contract Phase 5 — reverse-defense integration proof.
//
// Sub-plan: .cursor/plans/commitment_kernel_bundle_as_contract.plan.md
// (todo `bundle-contract-phase-5-reverse-defense`).
// Audit anchor: extensions/AUDIT-bundle-as-contract.md §3.4 reverse-defense
// rationale.
//
// Phase 3 implemented the reverse-defense layer inside the pure
// `filterToolSchemaByBundle` helper. Phase 4 wired the helper at
// `attempt.ts:2004` via `applyBundleSchemaFilterAtAttempt`. Phase 5 adds
// INTEGRATION-LEVEL proof: the reverse-defense layer fires INDEPENDENT of
// the bundle allowlist when traversing the production wiring chain
// (`platformExecutionContext.resolutionContract.toolBundles` + `modelCompat`
// → `applyBundleSchemaFilterAtAttempt` → filtered catalog).
//
// Specifically this file proves:
//
//   1. Adversarial post-`applyModelProviderToolPolicy` injection — a future
//      regression that re-introduces `web_search` into the catalog AFTER the
//      sister filter ran is still removed by the bundle filter. The integration
//      assertion has two facets to prove independence: (a) through the
//      production wiring chain `web_search` is removed (layer 1 fires because
//      `artifact_authoring` does NOT allow `web_search`); (b) through the pure
//      filter with a HYPOTHETICALLY-BYPASSED allowlist (custom config that
//      widens `artifact_authoring` to include `web_search`) the same removal
//      is recorded by reverse-defense — proving layer 2 fires INDEPENDENT of
//      layer 1. The two assertions together prove the defense-in-depth
//      invariant: even if a future change widens or bypasses the allowlist,
//      reverse-defense still catches the symptom.
//   2. Bundle authority wins — `public_web_lookup` + non-native search → DDG
//      `web_search` is KEPT (the legitimate composer path). Reverse-defense
//      MUST NOT override this.
//   3. No double-fire — `public_web_lookup` + native search (grok-4) →
//      `applyModelProviderToolPolicy` already removed `web_search`; the
//      bundle filter does NOT record `web_search` as removed (it was already
//      gone before our filter ran).
//
// `applyModelProviderToolPolicy` (`pi-tools.ts:94-104`) is NOT modified —
// per sub-plan §5 out-of-scope and explicit non-goal. The reverse-defense
// layer is a SYMMETRIC defense added in `bundle-schema-filter-apply.ts`.

import { describe, expect, it } from "vitest";
import {
  type BundleId,
  type BundleSchemaFilterConfig,
  DEFAULT_BUNDLE_ALLOWED_TOOLS,
} from "../../../bundle-schema-filter.js";
import { filterToolSchemaByBundle } from "../../../bundle-schema-filter-apply.js";
import type { ResolutionToolBundle } from "../../../../platform/decision/resolution-contract.js";
import type { RecipeRuntimePlan } from "../../../../platform/recipe/runtime-adapter.js";
import { applyBundleSchemaFilterAtAttempt } from "../bundle-filter-wiring.js";

type FixtureTool = { readonly name?: string };

function makeTool(name: string): FixtureTool {
  return { name };
}

// Minimal `RecipeRuntimePlan`-shape carrier — only the bundles field the
// wiring reads is populated; everything else is irrelevant for the filter.
function makePlatformExecutionContext(
  bundles: readonly ResolutionToolBundle[],
): RecipeRuntimePlan {
  return {
    resolutionContract: { toolBundles: bundles },
  } as unknown as RecipeRuntimePlan;
}

describe("bundle-filter Phase 5 — reverse-defense integration proof", () => {
  // ── Case 1: Adversarial post-`applyModelProviderToolPolicy` injection ────
  it(
    "drops web_search when it is artificially injected post-`applyModelProviderToolPolicy` " +
      "with bundles=[artifact_authoring] + nativeWebSearchTool=false — " +
      "AND reverse-defense fires INDEPENDENT of bundle allowlist",
    () => {
      // Adversarial fixture — the catalog reaching our wiring helper has
      // `web_search` present even though `artifact_authoring` does NOT
      // legitimately allow it. Simulates a future regression where some
      // refactor re-introduces DDG `web_search` after the existing two
      // filters have run.
      const adversarialCatalog: readonly FixtureTool[] = [
        makeTool("pdf"),
        makeTool("docx_write"),
        makeTool("image_generate"),
        makeTool("apply_patch"),
        // Injected — should NOT be allowed for artifact_authoring + non-native.
        makeTool("web_search"),
      ];

      // ── 1a: Through production wiring chain (layer 1 fires first) ────────
      const wiringResult = applyBundleSchemaFilterAtAttempt({
        tools: adversarialCatalog,
        platformExecutionContext: makePlatformExecutionContext([
          "artifact_authoring",
        ]),
        modelCompat: { nativeWebSearchTool: false },
      });
      expect(wiringResult.kept.map((t) => t.name)).not.toContain("web_search");
      expect(wiringResult.kept.map((t) => t.name).sort()).toEqual([
        "apply_patch",
        "docx_write",
        "image_generate",
        "pdf",
      ]);
      const wiringWsRemoval = wiringResult.removed.find(
        (r) => r.tool === "web_search",
      );
      expect(wiringWsRemoval).toBeDefined();
      // Layer 1 (bundle allowlist) catches it first via the production
      // wiring's `DEFAULT_BUNDLE_ALLOWED_TOOLS`.
      expect(wiringWsRemoval?.reason).toBe("not_in_bundle_allowlist");

      // ── 1b: Independence proof — hypothetically bypass layer 1 via a
      //       custom config that widens `artifact_authoring` to include
      //       `web_search`. Layer 1 then PASSES web_search through; layer 2
      //       (reverse-defense) MUST still catch it. This is the integration
      //       assertion the sub-plan calls out: "reverse-defense layer fires
      //       INDEPENDENT of bundle-allowlist (if bundle allowlist had been
      //       bypassed, reverse-defense still catches it)". ─────────────────
      const widenedConfig: BundleSchemaFilterConfig = {
        allowedToolsByBundle: new Map<BundleId, ReadonlySet<string>>([
          ...DEFAULT_BUNDLE_ALLOWED_TOOLS,
          // Hypothetically widened — simulates an upstream
          // misconfiguration / drift that bypasses layer 1 for web_search.
          [
            "artifact_authoring",
            new Set<string>([
              "pdf",
              "docx_write",
              "image_generate",
              "apply_patch",
              "web_search",
            ]),
          ],
        ]),
        missingBundlePolicy: "allow_all",
      };
      const bypassedResult = filterToolSchemaByBundle({
        tools: adversarialCatalog,
        bundles: ["artifact_authoring"],
        modelCapabilities: { nativeWebSearchTool: false },
        config: widenedConfig,
      });
      // Even with the widened allowlist, web_search MUST be removed by
      // reverse-defense.
      expect(bypassedResult.kept.map((t) => t.name)).not.toContain(
        "web_search",
      );
      const bypassedWsRemoval = bypassedResult.removed.find(
        (r) => r.tool === "web_search",
      );
      expect(bypassedWsRemoval).toBeDefined();
      expect(bypassedWsRemoval?.reason).toBe(
        "reverse_defense_no_native_search",
      );
    },
  );

  // ── Case 2: Bundle authority wins — DDG kept on legitimate path ──────────
  it(
    "keeps web_search on the legitimate DDG-search path: " +
      "bundles=[public_web_lookup] + nativeWebSearchTool=false",
    () => {
      // The legitimate path: classifier emitted `public_web_lookup`, the
      // model has no native web search, so DDG `web_search` is the
      // intended tool. Reverse-defense MUST be bypassed — the bundle
      // contract authorises web lookup. This is the exact case where the
      // sister filter (`applyModelProviderToolPolicy`) is also a no-op
      // (it only removes DDG for native-search models). The composer path
      // depends on this behaviour.
      const catalog: readonly FixtureTool[] = [
        makeTool("web_search"),
        makeTool("web_fetch"),
        makeTool("exec"),
        makeTool("apply_patch"),
        makeTool("pdf"),
      ];

      const result = applyBundleSchemaFilterAtAttempt({
        tools: catalog,
        platformExecutionContext: makePlatformExecutionContext([
          "public_web_lookup",
        ]),
        modelCompat: { nativeWebSearchTool: false },
      });

      // web_search is in `kept` — bundle authority wins.
      const keptNames = result.kept.map((t) => t.name);
      expect(keptNames).toContain("web_search");
      expect(keptNames.sort()).toEqual(["web_fetch", "web_search"]);

      // web_search MUST NOT appear in `removed` — neither layer fired.
      const wsRemoval = result.removed.find((r) => r.tool === "web_search");
      expect(wsRemoval).toBeUndefined();
    },
  );

  // ── Case 3: No double-fire when native-search already removed web_search ─
  it(
    "is a no-op for web_search when `applyModelProviderToolPolicy` already " +
      "removed it (grok-4 native-search path): bundles=[public_web_lookup] + " +
      "nativeWebSearchTool=true",
    () => {
      // Grok-4 path: `applyModelProviderToolPolicy` removed DDG `web_search`
      // BEFORE our wiring runs (it lives inside the `createOpenClawCodingTools`
      // chain — see `pi-tools.ts:94-104`). The catalog reaching us therefore
      // has no `web_search`. Our filter MUST NOT record `web_search` in
      // `removed` (no double-fire, no spurious telemetry).
      const catalogPostNativeSearchPolicy: readonly FixtureTool[] = [
        // web_search is intentionally absent — already filtered upstream.
        makeTool("web_fetch"),
        makeTool("exec"),
        makeTool("apply_patch"),
        makeTool("pdf"),
      ];

      const result = applyBundleSchemaFilterAtAttempt({
        tools: catalogPostNativeSearchPolicy,
        platformExecutionContext: makePlatformExecutionContext([
          "public_web_lookup",
        ]),
        modelCompat: { nativeWebSearchTool: true },
      });

      // The bundle filter never sees `web_search` (it was already gone) —
      // therefore `removed` does NOT contain `web_search` from EITHER layer.
      const wsRemoval = result.removed.find((r) => r.tool === "web_search");
      expect(wsRemoval).toBeUndefined();

      // `web_fetch` is the only allowlisted member of `public_web_lookup`
      // present in the post-native-search catalog, so it is kept.
      expect(result.kept.map((t) => t.name)).toEqual(["web_fetch"]);

      // Other catalog members are removed by layer 1 (not in
      // `public_web_lookup` allowlist) — they record `not_in_bundle_allowlist`.
      // None record `reverse_defense_no_native_search` (reverse-defense is
      // disabled for `public_web_lookup` AND for native-search models).
      for (const r of result.removed) {
        expect(r.reason).toBe("not_in_bundle_allowlist");
      }
    },
  );
});
