// Bundle-as-contract Phase 3 tests — pure `filterToolSchemaByBundle` helper.
//
// Sub-plan: .cursor/plans/commitment_kernel_bundle_as_contract.plan.md
// (todo `bundle-contract-phase-3-pure-filter`).
// Audit anchor: extensions/AUDIT-bundle-as-contract.md §3.4 reverse-defense,
// §6 bundle-emission contracts, §8 Phase-3 checklist.
//
// Fail-first stance: tests exercise the real `filterToolSchemaByBundle`
// implementation with no `vi.spyOn` on the function under test. The helper is
// pure and returns `{ kept, removed }`. Two layers covered:
//   1. bundle-allowlist filter — drops tools whose `name` is not in the union
//      of bundle allowlists; pass-through when the resolver returns
//      `{ kind: 'allow_all' }` (legacy parity).
//   2. reverse-defense filter — when the model has no native web-search AND
//      the turn does NOT carry `public_web_lookup` bundle, drop any
//      `web_search` tool that survived layer 1.
//
// Stub-fail check: replacing the production body with `return { kept:
// params.tools, removed: [] };` makes EVERY non-`allow_all` test below fail
// (verified before the real implementation was committed).

import { describe, expect, it } from "vitest";

import {
  DEFAULT_BUNDLE_ALLOWED_TOOLS,
  type BundleId,
  type BundleSchemaFilterConfig,
} from "../bundle-schema-filter.js";
import { filterToolSchemaByBundle } from "../bundle-schema-filter-apply.js";

// Minimal fixture tool — only the structural `.name` field that the filter
// inspects. No real `AgentTool` instances needed; the filter is generic over
// `{ readonly name?: string }`.
type FixtureTool = { readonly name?: string };

function makeTool(name: string | undefined): FixtureTool {
  return { name };
}

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

function defaultConfig(
  overrides: Partial<BundleSchemaFilterConfig> = {},
): BundleSchemaFilterConfig {
  return {
    allowedToolsByBundle: DEFAULT_BUNDLE_ALLOWED_TOOLS,
    ...overrides,
  };
}

describe("filterToolSchemaByBundle — bundle-allowlist layer", () => {
  it("bundles=[respond_only] removes web_search and every other tool", () => {
    const result = filterToolSchemaByBundle({
      tools: CATALOG,
      bundles: ["respond_only"],
      config: defaultConfig(),
    });
    expect(result.kept).toEqual([]);
    // Every catalog tool removed with reason `not_in_bundle_allowlist`.
    expect(result.removed.length).toBe(CATALOG.length);
    for (const r of result.removed) {
      expect(r.reason).toBe("not_in_bundle_allowlist");
    }
    const removedNames = result.removed.map((r) => r.tool).sort();
    const expected = CATALOG.map((t) => t.name as string).sort();
    expect(removedNames).toEqual(expected);
  });

  it("bundles=[public_web_lookup] keeps web_search + web_fetch only", () => {
    const result = filterToolSchemaByBundle({
      tools: CATALOG,
      bundles: ["public_web_lookup"],
      // No `modelCapabilities` provided → reverse-defense layer is gated by
      // `nativeWebSearchTool !== true` BUT the turn carries `public_web_lookup`
      // → bundle wins, web_search kept.
      modelCapabilities: { nativeWebSearchTool: true },
      config: defaultConfig(),
    });
    const keptNames = result.kept.map((t) => t.name).sort();
    expect(keptNames).toEqual(["web_fetch", "web_search"]);
    // Removed = catalog minus the two kept.
    expect(result.removed.length).toBe(CATALOG.length - 2);
    for (const r of result.removed) {
      expect(r.reason).toBe("not_in_bundle_allowlist");
    }
  });

  it("bundles=[] + missingBundlePolicy='allow_all' is byte-identical pass-through", () => {
    const result = filterToolSchemaByBundle({
      tools: CATALOG,
      bundles: [],
      // `nativeWebSearchTool=true` so the reverse-defense never fires for
      // web_search either; this MUST be byte-identical legacy parity.
      modelCapabilities: { nativeWebSearchTool: true },
      config: defaultConfig({ missingBundlePolicy: "allow_all" }),
    });
    // kept array values are identical (referential and structural) to the
    // input. removed is empty.
    expect(result.kept).toEqual(CATALOG);
    expect(result.kept.length).toBe(CATALOG.length);
    for (let i = 0; i < CATALOG.length; i += 1) {
      // Reference equality — pure helper does NOT clone tool objects.
      expect(result.kept[i]).toBe(CATALOG[i]);
    }
    expect(result.removed).toEqual([]);
  });

  it("bundles=[] + missingBundlePolicy='restrict_to_default' honours defaultAllowedTools", () => {
    const result = filterToolSchemaByBundle({
      tools: CATALOG,
      bundles: [],
      modelCapabilities: { nativeWebSearchTool: true },
      config: defaultConfig({
        missingBundlePolicy: "restrict_to_default",
        defaultAllowedTools: new Set<string>(["exec"]),
      }),
    });
    expect(result.kept.map((t) => t.name)).toEqual(["exec"]);
    // Non-exec tools dropped via bundle-allowlist reason.
    for (const r of result.removed) {
      expect(r.reason).toBe("not_in_bundle_allowlist");
    }
    expect(result.removed.length).toBe(CATALOG.length - 1);
  });
});

describe("filterToolSchemaByBundle — reverse-defense layer", () => {
  it("fires when bundle is not public_web_lookup AND model has no native search", () => {
    // artifact_authoring allowlist is {pdf, docx_write, image_generate,
    // apply_patch} — does NOT include web_search. To exercise the
    // reverse-defense layer we artificially inject web_search into a
    // catalog whose bundle ALSO lists web_search (simulating future drift),
    // by widening the config's allowedToolsByBundle for artifact_authoring
    // to include web_search. Then reverse-defense MUST drop it.
    const wideAllow = new Map<BundleId, ReadonlySet<string>>(
      DEFAULT_BUNDLE_ALLOWED_TOOLS,
    );
    wideAllow.set(
      "artifact_authoring",
      new Set<string>([
        "pdf",
        "docx_write",
        "image_generate",
        "apply_patch",
        "web_search", // injected to prove reverse-defense fires post-allowlist.
      ]),
    );

    const result = filterToolSchemaByBundle({
      tools: CATALOG,
      bundles: ["artifact_authoring"],
      modelCapabilities: { nativeWebSearchTool: false },
      config: { allowedToolsByBundle: wideAllow },
    });

    // web_search MUST NOT be in kept (reverse-defense dropped it).
    const keptNames = result.kept.map((t) => t.name);
    expect(keptNames).not.toContain("web_search");
    // pdf/docx_write/image_generate/apply_patch ARE kept.
    expect(keptNames.sort()).toEqual(
      ["apply_patch", "docx_write", "image_generate", "pdf"].sort(),
    );
    // The web_search removal carries the reverse-defense reason — NOT the
    // bundle-allowlist reason — because the bundle DID include it.
    const wsRemoval = result.removed.find((r) => r.tool === "web_search");
    expect(wsRemoval).toBeDefined();
    expect(wsRemoval?.reason).toBe("reverse_defense_no_native_search");
  });

  it("is bypassed when bundle=public_web_lookup even on no-native-search model", () => {
    const result = filterToolSchemaByBundle({
      tools: CATALOG,
      bundles: ["public_web_lookup"],
      modelCapabilities: { nativeWebSearchTool: false },
      config: defaultConfig(),
    });
    // public_web_lookup wins — web_search kept even on non-native model.
    const keptNames = result.kept.map((t) => t.name).sort();
    expect(keptNames).toEqual(["web_fetch", "web_search"]);
    // No reverse-defense removal recorded.
    const reverseRemovals = result.removed.filter(
      (r) => r.reason === "reverse_defense_no_native_search",
    );
    expect(reverseRemovals).toEqual([]);
  });

  it("does not fire when bundles=[] resolves to allow_all (legacy parity)", () => {
    // Empty bundles + allow_all policy MUST be a pure pass-through —
    // reverse-defense MUST NOT silently drop web_search on legacy callers.
    const result = filterToolSchemaByBundle({
      tools: CATALOG,
      bundles: [],
      modelCapabilities: { nativeWebSearchTool: false },
      config: defaultConfig({ missingBundlePolicy: "allow_all" }),
    });
    expect(result.kept.map((t) => t.name)).toContain("web_search");
    expect(result.removed).toEqual([]);
  });
});

describe("filterToolSchemaByBundle — purity, idempotency, edge cases", () => {
  it("is idempotent — filter(filter(x)) === filter(x) on kept names", () => {
    const first = filterToolSchemaByBundle({
      tools: CATALOG,
      bundles: ["public_web_lookup"],
      modelCapabilities: { nativeWebSearchTool: true },
      config: defaultConfig(),
    });
    const second = filterToolSchemaByBundle({
      tools: first.kept,
      bundles: ["public_web_lookup"],
      modelCapabilities: { nativeWebSearchTool: true },
      config: defaultConfig(),
    });
    expect(second.kept.map((t) => t.name)).toEqual(
      first.kept.map((t) => t.name),
    );
    // Second pass removes nothing.
    expect(second.removed).toEqual([]);
  });

  it("does NOT mutate the input tools array", () => {
    const tools = [...CATALOG];
    const snapshotRefs = tools.map((t) => t);
    const snapshotNames = tools.map((t) => t.name);
    filterToolSchemaByBundle({
      tools,
      bundles: ["respond_only"],
      config: defaultConfig(),
    });
    expect(tools.length).toBe(snapshotRefs.length);
    for (let i = 0; i < tools.length; i += 1) {
      expect(tools[i]).toBe(snapshotRefs[i]);
      expect(tools[i]?.name).toBe(snapshotNames[i]);
    }
  });

  it("keeps a tool with undefined name (conservative — never throws)", () => {
    const noisyCatalog: readonly FixtureTool[] = [
      makeTool("exec"),
      makeTool(undefined),
      { /* no `.name` property at all */ },
      makeTool("web_search"),
    ];
    const result = filterToolSchemaByBundle({
      tools: noisyCatalog,
      bundles: ["repo_run"],
      modelCapabilities: { nativeWebSearchTool: false },
      config: defaultConfig(),
    });
    // exec kept by allowlist; the two unnamed tools KEPT (conservative);
    // web_search dropped by allowlist (repo_run does not include web_search).
    expect(result.kept.length).toBe(3);
    expect(result.kept.map((t) => t.name)).toEqual([
      "exec",
      undefined,
      undefined,
    ]);
    // Only web_search removed; reason is bundle-allowlist (it never reached
    // reverse-defense layer because it was already dropped by layer 1).
    expect(result.removed).toEqual([
      { tool: "web_search", reason: "not_in_bundle_allowlist" },
    ]);
  });

  it("preserves stable input order in the kept array", () => {
    // Mix tools whose names ARE allowed with tools whose names are NOT, in a
    // particular order, then assert kept tools come out in input order.
    const ordered: readonly FixtureTool[] = [
      makeTool("pdf"),
      makeTool("web_search"), // dropped by allowlist for artifact_authoring
      makeTool("apply_patch"),
      makeTool("exec"), // dropped by allowlist for artifact_authoring
      makeTool("image_generate"),
      makeTool("docx_write"),
    ];
    const result = filterToolSchemaByBundle({
      tools: ordered,
      bundles: ["artifact_authoring"],
      modelCapabilities: { nativeWebSearchTool: true },
      config: defaultConfig(),
    });
    expect(result.kept.map((t) => t.name)).toEqual([
      "pdf",
      "apply_patch",
      "image_generate",
      "docx_write",
    ]);
  });
});
