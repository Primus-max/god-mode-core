/**
 * Search-Composer Phase 4c — IntentContractor prompt-hint allowlist flip.
 *
 * The runtime adapter, observers, affordances, and production routing for
 * `web_research` are already wired by Search-Composer PRs #127-#145. The
 * FINAL flip is the classifier prompt-hint instruction that the LLM may
 * emit `web_research` as `desiredEffectFamily`.
 *
 * Before this PR the prompt-hint allowlist was 4 families:
 *   `persistent_session | communication | artifact | unknown`
 *
 * After this PR it is 5 families:
 *   `persistent_session | communication | web_research | artifact | unknown`
 *
 * These tests:
 *   1. Source-level assertion of the literal allowlist string in
 *      `intent-contractor-impl.ts` (the actual flip artefact).
 *   2. Functional assertions via mock adapter that each family resolves
 *      end-to-end through `createIntentContractor` so we know the registry
 *      and parser still accept all five symbols (regression for Cutover-3
 *      `artifact` flip + slice E `persistent_session` + base
 *      `communication` / `unknown`).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { OpenClawConfig } from "../../../config/config.js";
import {
  ARTIFACT_EFFECT_FAMILY,
  COMMUNICATION_EFFECT_FAMILY,
  PERSISTENT_SESSION_EFFECT_FAMILY,
  UNKNOWN_EFFECT_FAMILY,
  WEB_RESEARCH_EFFECT_FAMILY,
  createIntentContractor,
  type IntentContractorAdapter,
} from "../index.js";
import type { SemanticIntent } from "../semantic-intent.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMPL_PATH = resolve(__dirname, "..", "intent-contractor-impl.ts");
const IMPL_SOURCE = readFileSync(IMPL_PATH, "utf8");

function mockCfg(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        embeddedPi: {
          intentContractor: { backend: "mock" },
        },
      },
    },
  } as OpenClawConfig;
}

function fixedIntentAdapter(intent: SemanticIntent): IntentContractorAdapter {
  return { classify: async () => intent };
}

describe("IntentContractor prompt-hint allowlist (Search-Composer Phase 4c)", () => {
  it("source-level: prompt-hint allowlist literal contains `web_research` between `communication` and `artifact`", () => {
    // The Search-Composer 4c flip introduced `web_research` to the
    // `responseShape.desiredEffectFamily` allowlist. Subsequent flips
    // (Cutover-4 Phase 8 added `repo`) extend the literal in place; we
    // pin only the substring guarantee that this slice ships — the
    // ordering segment `... "communication" | "web_research" | "artifact" ...`.
    // The exact-set guarantee is owned by the most recent slice's flip
    // test (`intent-contractor-repo-flip.test.ts` post-cutover-4 P8).
    const requiredSegment =
      '"communication" | "web_research" | "artifact"';

    expect(IMPL_SOURCE).toContain(requiredSegment);
  });

  it("source-level: pre-Cutover-3-P8 4-family allowlist literal is gone (regression guard)", () => {
    // Negative coverage — the original pre-Cutover-3-P8 4-family string
    // (without `artifact`) MUST NOT remain. Verifies the Cutover-3 P8 +
    // Search-Composer 4c flips are still in effect even after subsequent
    // family additions in later cutover phases.
    const preFlipLiteral =
      '\'"persistent_session" | "communication" | "unknown"\'';

    expect(IMPL_SOURCE).not.toContain(preFlipLiteral);
  });

  it("functional: classifier emitting `web_research` is accepted end-to-end", async () => {
    // Positive case: prompt "найди новости про X" with mock adapter that
    // returns `web_research` (mirroring the LLM's allowed output once the
    // prompt hint includes it). The contractor MUST surface the family
    // unchanged with NO `family_not_in_registry` uncertainty tag.
    const adapter = fixedIntentAdapter({
      desiredEffectFamily: WEB_RESEARCH_EFFECT_FAMILY,
      target: { kind: "unspecified" },
      operation: { kind: "create" },
      constraints: { topic: "новости про X" },
      uncertainty: [],
      confidence: 0.86,
    });
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: adapter },
    });

    const result = await contractor.classify("найди новости про X");

    expect(result.desiredEffectFamily).toBe(WEB_RESEARCH_EFFECT_FAMILY);
    expect(result.confidence).toBeCloseTo(0.86);
    expect(result.uncertainty).not.toContain("family_not_in_registry");
  });

  it("regression: classifier emitting `artifact` still works (Cutover-3 P8 preserved)", async () => {
    const adapter = fixedIntentAdapter({
      desiredEffectFamily: ARTIFACT_EFFECT_FAMILY,
      target: { kind: "artifact" },
      operation: { kind: "create" },
      constraints: {},
      uncertainty: [],
      confidence: 0.9,
    });
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: adapter },
    });

    const result = await contractor.classify("сделай PDF");

    expect(result.desiredEffectFamily).toBe(ARTIFACT_EFFECT_FAMILY);
    expect(result.uncertainty).not.toContain("family_not_in_registry");
  });

  it("regression: classifier emitting `communication` still works (base behavior)", async () => {
    const adapter = fixedIntentAdapter({
      desiredEffectFamily: COMMUNICATION_EFFECT_FAMILY,
      target: { kind: "external_channel" },
      operation: { kind: "create" },
      constraints: {},
      uncertainty: [],
      confidence: 0.85,
    });
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: adapter },
    });

    const result = await contractor.classify("привет");

    expect(result.desiredEffectFamily).toBe(COMMUNICATION_EFFECT_FAMILY);
    expect(result.uncertainty).not.toContain("family_not_in_registry");
  });

  it("regression: classifier emitting `persistent_session` still works (slice E behavior)", async () => {
    const adapter = fixedIntentAdapter({
      desiredEffectFamily: PERSISTENT_SESSION_EFFECT_FAMILY,
      target: { kind: "session" },
      operation: { kind: "create" },
      constraints: {},
      uncertainty: [],
      confidence: 0.88,
    });
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: adapter },
    });

    const result = await contractor.classify("запомни X");

    // Either persistent_session (slice E classifier) OR unknown (low-conf
    // fallback path) is acceptable; we assert the registered branch since
    // the mock adapter returned PERSISTENT_SESSION above.
    expect(result.desiredEffectFamily).toBe(PERSISTENT_SESSION_EFFECT_FAMILY);
    expect(result.uncertainty).not.toContain("family_not_in_registry");
  });

  it("registry symmetry: all 5 families resolve as registered (no `family_not_in_registry` introduced)", async () => {
    // The flip is purely the prompt-hint string. The runtime registry
    // already contains all 5 families. This test sweeps every family
    // through the contractor to confirm no path silently downgrades to
    // `unknown` with `family_not_in_registry`.
    const families = [
      PERSISTENT_SESSION_EFFECT_FAMILY,
      COMMUNICATION_EFFECT_FAMILY,
      WEB_RESEARCH_EFFECT_FAMILY,
      ARTIFACT_EFFECT_FAMILY,
      UNKNOWN_EFFECT_FAMILY,
    ] as const;

    for (const family of families) {
      const adapter = fixedIntentAdapter({
        desiredEffectFamily: family,
        target: { kind: "unspecified" },
        // `unknown` family disallows any operation; omit `operation` for
        // it (matches `lowConfidenceIntent`) and use `create` for the
        // capability families.
        ...(family === UNKNOWN_EFFECT_FAMILY
          ? {}
          : { operation: { kind: "create" as const } }),
        constraints: {},
        uncertainty: [],
        confidence: family === UNKNOWN_EFFECT_FAMILY ? 0.1 : 0.8,
      });
      const contractor = createIntentContractor({
        cfg: mockCfg(),
        adapterRegistry: { mock: adapter },
      });

      const result = await contractor.classify(`probe-${family}`);

      expect(result.desiredEffectFamily).toBe(family);
      expect(result.uncertainty).not.toContain("family_not_in_registry");
    }
  });
});
