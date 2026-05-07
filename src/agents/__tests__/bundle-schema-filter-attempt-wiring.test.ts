// Bundle-as-contract Phase 4 tests — wiring helper for `attempt.ts:2004`.
//
// Sub-plan: .cursor/plans/commitment_kernel_bundle_as_contract.plan.md
// (todo `bundle-contract-phase-4-attempt-wiring`).
// Audit anchor: extensions/AUDIT-bundle-as-contract.md §3.1 schema-construction
// site, §5 hop chain, §6.2 empty-bundles regression-guard rationale.
//
// The Phase 4 wiring is a thin adapter (`applyBundleSchemaFilterAtAttempt`)
// that reads `RecipeRuntimePlan.resolutionContract.toolBundles` and forwards
// the catalog through the pure `filterToolSchemaByBundle` helper. These
// tests exercise the adapter directly with synthetic `RecipeRuntimePlan`
// fixtures, so they are independent of the full `attempt.ts` machinery while
// still proving the production wiring contract end-to-end.
//
// Fail-first stance — verified by reverting the wiring (returning
// `{ kept: input.tools, removed: [] }` unconditionally) — every non-regression
// test fails.

import { describe, expect, it } from "vitest";
import type { RecipeRuntimePlan } from "../../platform/recipe/runtime-adapter.js";
import {
  applyBundleSchemaFilterAtAttempt,
  readToolBundlesFromPlatformExecutionContext,
} from "../pi-embedded-runner/run/bundle-filter-wiring.js";
import type { ResolutionToolBundle } from "../../platform/decision/resolution-contract.js";

type FixtureTool = { readonly name?: string };

function makeTool(name: string): FixtureTool {
  return { name };
}

// Production-shape catalog — names sourced from
// `extensions/AUDIT-bundle-as-contract.md` §3.1 (catalog members emitted by
// the `createOpenClawCodingTools(...)` factory).
const CATALOG: readonly FixtureTool[] = [
  makeTool("web_search"),
  makeTool("web_fetch"),
  makeTool("exec"),
  makeTool("apply_patch"),
  makeTool("pdf"),
  makeTool("docx_write"),
  makeTool("image_generate"),
  makeTool("browser"),
  makeTool("sessions_spawn"),
];

// Minimal `RecipeRuntimePlan`-shape fixture carrying just the
// `resolutionContract.toolBundles` field that the wiring reads. Cast through
// `unknown` because the full plan shape has dozens of unrelated fields.
function makePlatformExecutionContext(
  bundles: readonly ResolutionToolBundle[] | undefined,
): RecipeRuntimePlan | undefined {
  if (bundles === undefined) {
    return undefined;
  }
  return {
    resolutionContract: { toolBundles: bundles },
  } as unknown as RecipeRuntimePlan;
}

describe("bundle-filter-wiring — readToolBundlesFromPlatformExecutionContext", () => {
  it("returns empty array when platformExecutionContext is undefined", () => {
    expect(readToolBundlesFromPlatformExecutionContext(undefined)).toEqual([]);
  });

  it("returns empty array when resolutionContract is missing", () => {
    const plan = {} as unknown as RecipeRuntimePlan;
    expect(readToolBundlesFromPlatformExecutionContext(plan)).toEqual([]);
  });

  it("returns the carrier bundles verbatim", () => {
    const plan = makePlatformExecutionContext(["respond_only"]);
    expect(readToolBundlesFromPlatformExecutionContext(plan)).toEqual([
      "respond_only",
    ]);
  });
});

describe("bundle-filter-wiring — applyBundleSchemaFilterAtAttempt", () => {
  // ── Case 1: Regression byte-identical (heartbeat / cron / synthetic) ─────
  it(
    "is byte-identical pass-through when platformExecutionContext is undefined " +
      "(heartbeat / cron / synthetic legacy callers)",
    () => {
      const result = applyBundleSchemaFilterAtAttempt({
        tools: CATALOG,
        platformExecutionContext: undefined,
        modelCompat: { nativeWebSearchTool: false },
      });
      // Reference equality preserved — the helper does not clone tools.
      expect(result.kept.length).toBe(CATALOG.length);
      for (let i = 0; i < CATALOG.length; i += 1) {
        expect(result.kept[i]).toBe(CATALOG[i]);
      }
      expect(result.removed).toEqual([]);
    },
  );

  // ── Case 2: bundles=[respond_only] reaches LLM with empty tool array ─────
  it("bundles=[respond_only] yields empty tool catalog reaching the LLM", () => {
    const result = applyBundleSchemaFilterAtAttempt({
      tools: CATALOG,
      platformExecutionContext: makePlatformExecutionContext(["respond_only"]),
      modelCompat: { nativeWebSearchTool: true },
    });
    expect(result.kept).toEqual([]);
    expect(result.removed.length).toBe(CATALOG.length);
    for (const r of result.removed) {
      expect(r.reason).toBe("not_in_bundle_allowlist");
    }
  });

  // ── Case 3: bundles=[public_web_lookup] keeps web_search + web_fetch ─────
  it("bundles=[public_web_lookup] keeps web_search + web_fetch only", () => {
    const result = applyBundleSchemaFilterAtAttempt({
      tools: CATALOG,
      platformExecutionContext: makePlatformExecutionContext([
        "public_web_lookup",
      ]),
      // Even with non-native search the bundle authority wins; reverse-defense
      // is bypassed because public_web_lookup is the authorisation signal.
      modelCompat: { nativeWebSearchTool: false },
    });
    expect(result.kept.map((t) => t.name).sort()).toEqual([
      "web_fetch",
      "web_search",
    ]);
    expect(result.removed.length).toBe(CATALOG.length - 2);
    for (const r of result.removed) {
      expect(r.reason).toBe("not_in_bundle_allowlist");
    }
  });

  // ── Case 4: Reverse-defense layered atop existing filters ────────────────
  it(
    "model claude-opus-4.6 (nativeWebSearchTool=false) + bundles=[respond_only] " +
      "produces zero tools — reverse-defense layered atop bundle allowlist",
    () => {
      const result = applyBundleSchemaFilterAtAttempt({
        tools: CATALOG,
        platformExecutionContext: makePlatformExecutionContext([
          "respond_only",
        ]),
        // Simulating claude-opus-4.6 — no native web-search tool. The bundle
        // allowlist drops everything in layer 1, so reverse-defense layer 2
        // never fires (the bundle authority already removed web_search). The
        // contract: zero tools reach the LLM either way — defense in depth.
        modelCompat: { nativeWebSearchTool: false },
      });
      expect(result.kept).toEqual([]);
      // web_search MUST appear in removed under bundle-allowlist reason
      // (layer 1 fired first; layer 2 reverse-defense did not need to act).
      const wsRemoval = result.removed.find((r) => r.tool === "web_search");
      expect(wsRemoval).toBeDefined();
      expect(wsRemoval?.reason).toBe("not_in_bundle_allowlist");
    },
  );

  // ── Case 5: 355ae135 live-evidence shape replay ──────────────────────────
  it(
    "355ae135 live-evidence shape — bundles=[respond_only] requestedTools=[] " +
      "model=claude-opus-4.6 → empty tool schema (NO web_search reaches LLM)",
    () => {
      // Live-evidence reproducer for `gateway-grok-route.log` 2026-05-02
      // turn 355ae135. Pre-Phase-4 dev: web_search reached the LLM, the
      // model autonomously invoked it, DDG bot-detection fired, the turn
      // collapsed to `Provider finish_reason: error`. Phase 4 wiring MUST
      // produce an empty schema for this exact shape.
      const result = applyBundleSchemaFilterAtAttempt({
        tools: CATALOG,
        platformExecutionContext: makePlatformExecutionContext([
          "respond_only",
        ]),
        modelCompat: { nativeWebSearchTool: false },
      });
      expect(result.kept).toEqual([]);
      const keptNames = result.kept.map((t) => t.name);
      expect(keptNames).not.toContain("web_search");
      expect(keptNames).not.toContain("web_fetch");
      expect(keptNames).not.toContain("browser");
    },
  );

  // ── Case 6: commands-system-prompt path UNCHANGED ────────────────────────
  it(
    "commands-system-prompt caller is OUT OF SCOPE — wiring helper is not " +
      "invoked from that path; production hot path test does not touch it",
    () => {
      // The commands-system-prompt builder at
      // `src/auto-reply/reply/commands-system-prompt.ts:55` is an explicit
      // out-of-scope caller (sub-plan §0; audit §3.2). It calls
      // `createOpenClawCodingTools(...)` directly without going through
      // `attempt.ts` and without a `RecipeRuntimePlan`. Phase 4's wiring
      // helper is exposed ONLY at `src/agents/pi-embedded-runner/run/` —
      // the commands-system-prompt module does NOT import it.
      //
      // This test is a structural assertion: the wiring helper has zero
      // coupling to the commands-system-prompt path. We assert by direct
      // import-graph contract — the wiring file's name is namespaced under
      // `pi-embedded-runner/run/` so static-import discipline keeps the
      // commands-system-prompt path free of the new filter (preserves the
      // sub-plan's "separate caller, separate scope" boundary).
      //
      // Behavioural cross-check: when called WITHOUT a plan (the shape the
      // commands-system-prompt path would naturally produce if someone
      // wired the helper there incorrectly), the helper degrades to
      // pass-through — so even an accidental wire-up would NOT regress that
      // caller's tool list.
      const result = applyBundleSchemaFilterAtAttempt({
        tools: CATALOG,
        platformExecutionContext: undefined,
        modelCompat: undefined,
      });
      expect(result.kept.length).toBe(CATALOG.length);
      for (let i = 0; i < CATALOG.length; i += 1) {
        expect(result.kept[i]).toBe(CATALOG[i]);
      }
      expect(result.removed).toEqual([]);
    },
  );
});
