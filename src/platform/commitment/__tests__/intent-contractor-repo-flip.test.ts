/**
 * Cutover-4 Phase 8 — IntentContractor prompt-hint allowlist flip.
 *
 * The runtime adapter, world-state observer, affordances, PolicyGate Full
 * integration and production routing for `repo` are wired by cutover-4
 * Phases 2-7 (PRs #239-#244). The FINAL flip is the classifier prompt-hint
 * `responseShape.desiredEffectFamily` literal that the LLM may emit `repo`
 * as `desiredEffectFamily`.
 *
 * Before this PR the prompt-hint allowlist was 5 families:
 *   `persistent_session | communication | web_research | artifact | unknown`
 *
 * After this PR it is 6 families:
 *   `persistent_session | communication | web_research | artifact | repo | unknown`
 *
 * Tests:
 *   1. Source-level assertion of the literal allowlist string in
 *      `intent-contractor-impl.ts` (the actual flip artefact).
 *   2. Negative regression guard: the pre-flip 5-family literal MUST NOT
 *      remain.
 *   3. Functional: classifier emitting `repo` is accepted end-to-end with
 *      structured `constraints.branchName` carried through verbatim.
 *   4. Regression: classifier emitting `artifact` still works (Cutover-3 P8
 *      preserved).
 *   5. Registry symmetry: all 6 families resolve as registered (no
 *      `family_not_in_registry` introduced).
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
  REPO_EFFECT_FAMILY,
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

describe("IntentContractor prompt-hint allowlist (Cutover-4 Phase 8 — repo flip)", () => {
  it("source-level: prompt-hint allowlist literal carries the 6 cutover-4 families in order (artifact, repo present)", () => {
    // The flip is a single-line edit to the responseShape literal at
    // `intent-contractor-impl.ts:917` (post Search-Composer P4c). Assert
    // the post-flip ordering of the 6 cutover-4 families: existing 5 +
    // `repo` inserted before `unknown` to keep the family-grouping
    // reading (session + comms first, capability families next, then
    // unknown sentinel — same ordering rule as `EFFECT_FAMILY_REGISTRY`).
    //
    // NOTE: slice K Phase 5 EXTENDS the literal with `reminder` after
    // `repo`. This test pins only the cutover-4 ordering invariant
    // (artifact → repo → … → unknown) by checking the substring chain;
    // the slice-K-P5 reminder-flip test pins the full post-K literal.
    const cutover4Substring =
      '"persistent_session" | "communication" | "web_research" | "artifact" | "repo"';

    expect(IMPL_SOURCE).toContain(cutover4Substring);
  });

  it("source-level: pre-flip 5-family allowlist literal is gone (regression guard)", () => {
    const preFlipLiteral =
      '\'"persistent_session" | "communication" | "web_research" | "artifact" | "unknown"\'';

    expect(IMPL_SOURCE).not.toContain(preFlipLiteral);
  });

  it("functional: classifier emitting `repo` family + branchName constraint is accepted end-to-end", async () => {
    // Positive case: prompt "создай ветку feature/X" with mock adapter
    // that returns `repo` (mirroring the LLM's allowed output once the
    // prompt hint includes it). The contractor MUST surface the family
    // unchanged with NO `family_not_in_registry` uncertainty tag. The
    // structured `constraints.branchName` carried through verbatim is the
    // critical structural seam — Phase 5 `repo-runtime-adapter.ts` reads
    // it (NOT raw user text — invariant #5/#6).
    const adapter = fixedIntentAdapter({
      desiredEffectFamily: REPO_EFFECT_FAMILY,
      target: { kind: "workspace" },
      operation: { kind: "create" },
      constraints: { branchName: "feature/X" },
      uncertainty: [],
      confidence: 0.91,
    });
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: adapter },
    });

    const result = await contractor.classify("создай ветку feature/X");

    expect(result.desiredEffectFamily).toBe(REPO_EFFECT_FAMILY);
    expect(result.target.kind).toBe("workspace");
    expect(result.operation?.kind).toBe("create");
    expect(result.constraints).toMatchObject({ branchName: "feature/X" });
    expect(result.uncertainty).not.toContain("family_not_in_registry");
    expect(result.confidence).toBeCloseTo(0.91);
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

  it("registry symmetry: all 6 families resolve as registered (no `family_not_in_registry` introduced)", async () => {
    // The flip is purely the prompt-hint string. The runtime registry
    // already contains all 6 families. This test sweeps every family
    // through the contractor to confirm no path silently downgrades to
    // `unknown` with `family_not_in_registry`.
    const families = [
      PERSISTENT_SESSION_EFFECT_FAMILY,
      COMMUNICATION_EFFECT_FAMILY,
      WEB_RESEARCH_EFFECT_FAMILY,
      ARTIFACT_EFFECT_FAMILY,
      REPO_EFFECT_FAMILY,
      UNKNOWN_EFFECT_FAMILY,
    ] as const;

    for (const family of families) {
      const adapter = fixedIntentAdapter({
        desiredEffectFamily: family,
        target: { kind: "unspecified" },
        // `unknown` family disallows any operation; omit `operation` for
        // it and use `create` for the capability families.
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
