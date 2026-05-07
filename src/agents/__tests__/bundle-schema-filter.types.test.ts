// Bundle-as-contract Phase 2 tests — types + closed mapping + resolver.
//
// Sub-plan: .cursor/plans/commitment_kernel_bundle_as_contract.plan.md
// (todo `bundle-contract-phase-2-types`).
// Audit anchor: extensions/AUDIT-bundle-as-contract.md §1, §6, §8 Phase-2.
//
// Fail-first stance: each `it` covers one bullet from sub-plan §7 Phase-2 test
// list. Tests exercise the real `resolveBundleAllowedTools` resolver and the
// strict `BundleSchemaFilterConfigSchema` Zod shape — no `vi.spyOn` on the
// function under test (per slice-implementer "no mocking the guard" rule).

import { describe, expect, it } from "vitest";

import { ResolutionToolBundleSchema } from "../../platform/decision/resolution-contract.js";
import {
  BundleSchemaFilterConfigSchema,
  DEFAULT_BUNDLE_ALLOWED_TOOLS,
  type BundleId,
  type BundleSchemaFilterConfig,
  resolveBundleAllowedTools,
} from "../bundle-schema-filter.js";

// Helper: a fresh, independent copy of the default config so individual tests
// can override one knob without mutating shared state.
function makeConfig(overrides: Partial<BundleSchemaFilterConfig> = {}): BundleSchemaFilterConfig {
  return {
    allowedToolsByBundle: DEFAULT_BUNDLE_ALLOWED_TOOLS,
    ...overrides,
  };
}

describe("BundleSchemaFilterConfigSchema — Zod round-trip", () => {
  it("accepts a fully-populated valid config", () => {
    const config: BundleSchemaFilterConfig = {
      allowedToolsByBundle: new Map<BundleId, ReadonlySet<string>>([
        ["respond_only", new Set<string>()],
        ["public_web_lookup", new Set<string>(["web_search", "web_fetch"])],
        ["interactive_browser", new Set<string>(["browser"])],
        ["document_extraction", new Set<string>()],
        ["artifact_authoring", new Set<string>(["pdf"])],
        ["external_delivery", new Set<string>()],
        ["session_orchestration", new Set<string>(["sessions_spawn"])],
        ["repo_run", new Set<string>(["exec"])],
        ["repo_mutation", new Set<string>(["exec", "apply_patch"])],
      ]),
      defaultAllowedTools: new Set<string>(["web_search"]),
      missingBundlePolicy: "allow_all",
    };
    const parsed = BundleSchemaFilterConfigSchema.parse(config);
    expect(parsed.allowedToolsByBundle.get("public_web_lookup")?.has("web_search")).toBe(true);
    expect(parsed.missingBundlePolicy).toBe("allow_all");
  });

  it("accepts a minimal config (only allowedToolsByBundle present)", () => {
    const config = {
      allowedToolsByBundle: new Map<BundleId, ReadonlySet<string>>([
        ["respond_only", new Set<string>()],
      ]),
    };
    expect(() => BundleSchemaFilterConfigSchema.parse(config)).not.toThrow();
  });

  it("rejects unknown bundle id in allowedToolsByBundle (closed enum)", () => {
    const bad = {
      allowedToolsByBundle: new Map<string, ReadonlySet<string>>([
        ["respond_only", new Set<string>()],
        // Intentionally invalid bundle id — Zod must reject via the closed
        // ResolutionToolBundleSchema enum.
        ["not_a_bundle", new Set<string>(["web_search"])],
      ]),
    };
    expect(() => BundleSchemaFilterConfigSchema.parse(bad)).toThrow();
  });

  it(".strict() rejects unknown top-level keys", () => {
    const bad = {
      allowedToolsByBundle: new Map<BundleId, ReadonlySet<string>>([
        ["respond_only", new Set<string>()],
      ]),
      // Unknown extra knob — strict() must reject. Guards against future
      // config-shape drift in Phase 3+ wiring.
      mysteryKnob: true,
    };
    expect(() => BundleSchemaFilterConfigSchema.parse(bad)).toThrow();
  });

  it("rejects an unknown missingBundlePolicy value", () => {
    const bad = {
      allowedToolsByBundle: new Map<BundleId, ReadonlySet<string>>([
        ["respond_only", new Set<string>()],
      ]),
      missingBundlePolicy: "deny_all",
    };
    expect(() => BundleSchemaFilterConfigSchema.parse(bad)).toThrow();
  });
});

describe("DEFAULT_BUNDLE_ALLOWED_TOOLS — closed-shape coverage", () => {
  it("has an entry for every BundleId enum value", () => {
    // Drive the loop directly off the Zod enum's runtime value list — when
    // ResolutionToolBundleSchema is widened in a future slice WITHOUT a
    // matching DEFAULT_BUNDLE_ALLOWED_TOOLS entry, this assertion fails.
    const enumValues = ResolutionToolBundleSchema.options as readonly BundleId[];
    expect(enumValues.length).toBe(9);
    for (const value of enumValues) {
      expect(DEFAULT_BUNDLE_ALLOWED_TOOLS.has(value)).toBe(true);
    }
  });

  it("is frozen via Object.freeze — runtime callers cannot mutate", () => {
    expect(Object.isFrozen(DEFAULT_BUNDLE_ALLOWED_TOOLS)).toBe(true);
  });

  it("respond_only maps to an empty set", () => {
    expect(DEFAULT_BUNDLE_ALLOWED_TOOLS.get("respond_only")?.size).toBe(0);
  });

  it("public_web_lookup includes web_search and web_fetch", () => {
    const tools = DEFAULT_BUNDLE_ALLOWED_TOOLS.get("public_web_lookup");
    expect(tools?.has("web_search")).toBe(true);
    expect(tools?.has("web_fetch")).toBe(true);
  });
});

describe("resolveBundleAllowedTools — pure resolver", () => {
  it("['respond_only'] → restrict_to with empty tool set", () => {
    const result = resolveBundleAllowedTools(["respond_only"], makeConfig());
    expect(result.kind).toBe("restrict_to");
    if (result.kind === "restrict_to") {
      expect(result.tools.size).toBe(0);
    }
  });

  it("['respond_only', 'public_web_lookup'] → union of both allowlists", () => {
    const result = resolveBundleAllowedTools(
      ["respond_only", "public_web_lookup"],
      makeConfig(),
    );
    expect(result.kind).toBe("restrict_to");
    if (result.kind === "restrict_to") {
      // respond_only contributes ∅; public_web_lookup contributes {web_search, web_fetch}.
      expect(result.tools.has("web_search")).toBe(true);
      expect(result.tools.has("web_fetch")).toBe(true);
      expect(result.tools.size).toBe(2);
    }
  });

  it("empty bundles + default policy ('allow_all') → { kind: 'allow_all' }", () => {
    // Default policy when missingBundlePolicy is unset MUST be allow_all
    // (regression guard — empty bundles legacy parity per audit §6.2 / §7.3).
    const result = resolveBundleAllowedTools([], makeConfig());
    expect(result.kind).toBe("allow_all");
  });

  it("empty bundles + missingBundlePolicy='allow_all' → { kind: 'allow_all' }", () => {
    const result = resolveBundleAllowedTools(
      [],
      makeConfig({ missingBundlePolicy: "allow_all" }),
    );
    expect(result.kind).toBe("allow_all");
  });

  it("empty bundles + missingBundlePolicy='restrict_to_default' → uses defaultAllowedTools", () => {
    const result = resolveBundleAllowedTools(
      [],
      makeConfig({
        missingBundlePolicy: "restrict_to_default",
        defaultAllowedTools: new Set<string>(["web_search"]),
      }),
    );
    expect(result.kind).toBe("restrict_to");
    if (result.kind === "restrict_to") {
      expect(result.tools.has("web_search")).toBe(true);
      expect(result.tools.size).toBe(1);
    }
  });

  it("empty bundles + 'restrict_to_default' without defaultAllowedTools → empty set", () => {
    // No defaultAllowedTools configured — resolver returns an empty set rather
    // than throwing (invariant #15 — never throws).
    const result = resolveBundleAllowedTools(
      [],
      makeConfig({ missingBundlePolicy: "restrict_to_default" }),
    );
    expect(result.kind).toBe("restrict_to");
    if (result.kind === "restrict_to") {
      expect(result.tools.size).toBe(0);
    }
  });

  it("does NOT mutate the input bundles array", () => {
    const bundles: BundleId[] = ["respond_only", "public_web_lookup"];
    const snapshot = [...bundles];
    resolveBundleAllowedTools(bundles, makeConfig());
    expect(bundles).toEqual(snapshot);
  });

  it("does NOT mutate the config's allowedToolsByBundle map or its sets", () => {
    const lookup = DEFAULT_BUNDLE_ALLOWED_TOOLS.get("public_web_lookup");
    const beforeSize = lookup?.size ?? -1;
    resolveBundleAllowedTools(
      ["public_web_lookup", "artifact_authoring"],
      makeConfig(),
    );
    expect(DEFAULT_BUNDLE_ALLOWED_TOOLS.get("public_web_lookup")?.size).toBe(beforeSize);
    expect(beforeSize).toBeGreaterThan(0);
  });
});
