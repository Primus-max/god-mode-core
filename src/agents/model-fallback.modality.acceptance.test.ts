// NEW-A Phase 6 — end-to-end ACCEPTANCE fixture for modality-aware routing.
//
// Purpose: prove the live demo bug (master §0.5.6 NEW-A; live evidence
// `C:\tmp\openclaw\openclaw-2026-05-06.log:L750`) is closed AND demonstrate
// the symptom in absence-of-fix mode. Fixture-mode only — no live providers,
// no real network. Stubbed `loadModelCatalog` returns a deterministic
// 2-entry Hydra catalog (text-only Opus + text/image gpt-5.4), stubbed
// `run(provider, model, options)` records the chosen pair so we can assert
// the routing decision per case.
//
// Five cases per sub-plan §Phase 6:
//   1. NEW-A reproduction (positive — fix-mode):
//        `turnModalityRequirements:['text','image']` → run is called with
//        `(hydra, gpt-5.4)` NOT opus. `[model-fallback] modality_filter
//        applied required=image,text survivors=1 dropped=1` log emitted.
//   2. Reverse — NEW-A symptom in absence-of-fix mode:
//        same call WITHOUT `turnModalityRequirements` → run called with
//        `(hydra, claude-opus-4.6)` first. Proves the wiring carries the
//        closure (i.e. opting out of the field reverts to today's broken
//        ordering).
//   3. Fail-open invariant:
//        single-candidate `[opus]` + image requirement → run still called
//        with opus AND `modality_filter fail_open ...` log emitted (turn
//        not silently dropped).
//   4. Document-mode pass-through:
//        pdf attachment + no `needsVision` → derived requirements `['text']`
//        → all candidates pass, `applied required=text dropped=0` log
//        emitted (filter wired but inert; no fail_open). Zero spam beyond
//        the one applied line.
//   5. Anonymous resolver:
//        `inboundMediaSummary=undefined` AND no `turnModalityRequirements`
//        passed → byte-identical to today (opus first, zero filter logs).
//
// Live-verify (operator runbook — NOT executed in CI; documented in PR
// body): replay the 2026-05-06 turn at
// `C:\tmp\openclaw\openclaw-2026-05-06.log:L750` against `dev` HEAD
// post-merge and confirm:
//   (a) `[model-fallback] modality_filter applied required=image,text
//       survivors=N dropped=M` appears;
//   (b) `route candidates ordered: hydra/gpt-5.4 -> ...` (NOT opus first
//       anymore);
//   (c) the assistant reply references image content (NOT a text-only
//       fallback that drops the attachment).
//
// Sub-plan: `.cursor/plans/commitment_kernel_modality_aware_routing.plan.md`
// (todo `ma-phase-6-acceptance-and-live-verify`).
// Audit: `extensions/AUDIT-modality-aware-routing.md` §a / §i.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import * as modelCatalogModule from "./model-catalog.js";
import {
  modelFallbackOperatorLogTestBuffer,
  runWithModelFallback,
} from "./model-fallback.js";
import { deriveTurnModalityRequirements } from "./model-fallback-modality.js";
import {
  resetModelCatalogCacheForTest,
  type ModelCatalogEntry,
} from "./model-catalog.js";

// Deterministic NEW-A reproducer catalog. Lives in fixture only — production
// catalog is unaffected. Mirrors the test-harness pattern in
// `model-fallback.modality-wiring.test.ts` so a future reader can compare the
// wiring-level expectations against this end-to-end acceptance assertion.
const TEST_CATALOG: ModelCatalogEntry[] = [
  {
    id: "claude-opus-4.6",
    name: "Claude Opus 4.6",
    provider: "hydra",
    input: ["text"],
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    provider: "hydra",
    input: ["text", "image"],
  },
];

const OPERATOR_LOG_CAPTURE_ENV = "OPENCLAW_CAPTURE_MODEL_FALLBACK_LOGS";

function makeHydraCfg(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary: "hydra/claude-opus-4.6",
          fallbacks: ["hydra/gpt-5.4"],
        },
      },
    },
  } as OpenClawConfig;
}

function makeSingleHydraCfg(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary: "hydra/claude-opus-4.6",
          fallbacks: [],
        },
      },
    },
  } as OpenClawConfig;
}

describe("NEW-A acceptance — modality-aware routing closes live demo bug", () => {
  let loadCatalogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env[OPERATOR_LOG_CAPTURE_ENV] = "1";
    modelFallbackOperatorLogTestBuffer.length = 0;
    resetModelCatalogCacheForTest();
    // Stub `loadModelCatalog` so the catalog index inside
    // `runWithModelFallback` is deterministic. We never spy on the function
    // under test (`runWithModelFallback`) nor on its private dependency
    // (`filterCandidatesByModality`) — invariant per slice spec §"No mocking
    // the guard". The real filter code path runs end-to-end here.
    loadCatalogSpy = vi
      .spyOn(modelCatalogModule, "loadModelCatalog")
      .mockResolvedValue(TEST_CATALOG);
  });

  afterEach(() => {
    delete process.env[OPERATOR_LOG_CAPTURE_ENV];
    loadCatalogSpy.mockRestore();
    vi.unstubAllGlobals();
    resetModelCatalogCacheForTest();
  });

  // -------------------------------------------------------------------------
  // CASE 1 — NEW-A reproduction (positive / fix-mode).
  // -------------------------------------------------------------------------
  it("CASE 1 (positive): turnModalityRequirements=['text','image'] → run called with (hydra, gpt-5.4) NOT opus, `modality_filter applied` emitted", async () => {
    // The `run` stub records every (provider, model) pair the orchestrator
    // chooses. With the modality filter wired, opus must be excluded entirely.
    const run = vi.fn().mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg: makeHydraCfg(),
      provider: "hydra",
      model: "claude-opus-4.6",
      fallbacksOverride: ["hydra/gpt-5.4"],
      turnModalityRequirements: ["text", "image"],
      run,
    });

    expect(result.result).toBe("ok");
    // PRIMARY ASSERTION — opus is NOT chosen first (NEW-A symptom closed).
    expect(run.mock.calls[0]?.slice(0, 2)).toEqual(["hydra", "gpt-5.4"]);
    // Negative coverage — opus is NOT in the call list at all.
    expect(
      run.mock.calls.some(
        (call) => call[0] === "hydra" && call[1] === "claude-opus-4.6",
      ),
    ).toBe(false);

    // Operator-grep anchor — exact log shape per audit §i.
    const appliedLine = modelFallbackOperatorLogTestBuffer.find((line) =>
      line.startsWith("[model-fallback] modality_filter applied"),
    );
    expect(appliedLine).toBeDefined();
    // `requirements` is sorted in-place by `deriveTurnModalityRequirements`,
    // but the wiring honours caller-supplied tuple ordering verbatim. Caller
    // passed `['text','image']` so the log echoes `text,image`.
    expect(appliedLine).toContain("required=text,image");
    expect(appliedLine).toContain("survivors=1");
    expect(appliedLine).toContain("dropped=1");
    // Sanity — fail_open did NOT trip on this branch.
    expect(
      modelFallbackOperatorLogTestBuffer.some((line) =>
        line.includes("modality_filter fail_open"),
      ),
    ).toBe(false);
  });

  // -------------------------------------------------------------------------
  // CASE 2 — reverse / absence-of-fix mode.
  // -------------------------------------------------------------------------
  it("CASE 2 (reverse, absence-of-fix): same call WITHOUT turnModalityRequirements → run called with (hydra, claude-opus-4.6) first (proves the live symptom)", async () => {
    // This case is the acceptance-fixture witness for the live bug:
    // dropping the closure (`turnModalityRequirements` omitted) reverts to
    // today's broken ordering — opus first, image silently dropped. If this
    // test ever flips to gpt-5.4 first WITHOUT the field, the wiring has
    // regressed into unconditional filtering and CASE 1 / CASE 5 lose their
    // guard. Fail-first guard for the slice's regression-safety contract.
    const run = vi.fn().mockResolvedValueOnce("ok");
    await runWithModelFallback({
      cfg: makeHydraCfg(),
      provider: "hydra",
      model: "claude-opus-4.6",
      fallbacksOverride: ["hydra/gpt-5.4"],
      run,
    });

    expect(run.mock.calls[0]?.slice(0, 2)).toEqual([
      "hydra",
      "claude-opus-4.6",
    ]);
    // ZERO `modality_filter` log lines when field is omitted (legacy callers
    // are byte-identical, no operator-log spam).
    expect(
      modelFallbackOperatorLogTestBuffer.filter((line) =>
        line.includes("modality_filter"),
      ),
    ).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // CASE 3 — fail-open invariant.
  // -------------------------------------------------------------------------
  it("CASE 3 (fail-open): single-candidate [opus] + image requirement → opus still attempted AND `modality_filter fail_open` emitted (turn not silently dropped)", async () => {
    const run = vi.fn().mockResolvedValueOnce("ok");
    const result = await runWithModelFallback({
      cfg: makeSingleHydraCfg(),
      provider: "hydra",
      model: "claude-opus-4.6",
      turnModalityRequirements: ["text", "image"],
      run,
    });

    expect(result.result).toBe("ok");
    // Survivor-set non-empty invariant — opus IS attempted (image dropped at
    // the Hydra-routed model end is a known failure mode but routing-layer
    // silence is strictly worse — see audit §i).
    expect(run.mock.calls[0]?.slice(0, 2)).toEqual([
      "hydra",
      "claude-opus-4.6",
    ]);

    const failOpenLine = modelFallbackOperatorLogTestBuffer.find((line) =>
      line.startsWith("[model-fallback] modality_filter fail_open"),
    );
    expect(failOpenLine).toBeDefined();
    expect(failOpenLine).toContain("required=text,image");
    expect(failOpenLine).toContain("reason=zero-survivors-after-filter");
    expect(failOpenLine).toContain("restoring=1");
    // No `applied` line on fail_open branch — the spec uses fail_open as the
    // mutually-exclusive observable.
    expect(
      modelFallbackOperatorLogTestBuffer.some((line) =>
        line.includes("modality_filter applied"),
      ),
    ).toBe(false);
  });

  // -------------------------------------------------------------------------
  // CASE 4 — document-mode pass-through.
  // -------------------------------------------------------------------------
  it("CASE 4 (document-mode): pdf attachment derivation → ['text'] only → all candidates pass, applied line emits with dropped=0 (no fail_open spam)", async () => {
    // `deriveTurnModalityRequirements` is the production derivation site
    // (mirrors `agent-runner-execution.ts` Phase 5 wiring). Use it directly
    // here so the acceptance fixture exercises the same closure the live
    // path uses.
    const requirements = deriveTurnModalityRequirements({
      inboundMediaSummary: { attachments: [{ kind: "pdf" }] },
    });
    expect(requirements).toEqual(["text"]);

    const run = vi.fn().mockResolvedValueOnce("ok");
    await runWithModelFallback({
      cfg: makeHydraCfg(),
      provider: "hydra",
      model: "claude-opus-4.6",
      fallbacksOverride: ["hydra/gpt-5.4"],
      turnModalityRequirements: requirements,
      run,
    });

    // Opus passes — `'text'` is universally covered.
    expect(run.mock.calls[0]?.slice(0, 2)).toEqual([
      "hydra",
      "claude-opus-4.6",
    ]);

    const appliedLine = modelFallbackOperatorLogTestBuffer.find((line) =>
      line.startsWith("[model-fallback] modality_filter applied"),
    );
    expect(appliedLine).toBeDefined();
    expect(appliedLine).toContain("required=text");
    expect(appliedLine).toContain("survivors=2");
    expect(appliedLine).toContain("dropped=0");
    // No fail-open noise on the document-mode pass-through path.
    expect(
      modelFallbackOperatorLogTestBuffer.some((line) =>
        line.includes("modality_filter fail_open"),
      ),
    ).toBe(false);
    // Exactly one `modality_filter` log line emitted (zero spam invariant).
    expect(
      modelFallbackOperatorLogTestBuffer.filter((line) =>
        line.includes("modality_filter"),
      ).length,
    ).toBe(1);
  });

  // -------------------------------------------------------------------------
  // CASE 5 — anonymous resolver / undefined inboundMediaSummary.
  // -------------------------------------------------------------------------
  it("CASE 5 (anonymous resolver): inboundMediaSummary=undefined → no requirements derivation supplied → byte-identical to today (opus first, zero filter logs)", async () => {
    // Anonymous-resolver path: caller cannot derive a structural inbound
    // summary (e.g. cron / followup-runner with no attachment plumbing yet).
    // Slice spec mandates: when no `turnModalityRequirements` field is
    // supplied, behaviour is byte-identical to pre-NEW-A. Acceptance fixture
    // proves it by asserting (a) opus first, (b) zero `modality_filter` log
    // lines.
    const run = vi.fn().mockResolvedValueOnce("ok");
    await runWithModelFallback({
      cfg: makeHydraCfg(),
      provider: "hydra",
      model: "claude-opus-4.6",
      fallbacksOverride: ["hydra/gpt-5.4"],
      // intentionally NOT setting turnModalityRequirements — anonymous path
      run,
    });

    expect(run.mock.calls[0]?.slice(0, 2)).toEqual([
      "hydra",
      "claude-opus-4.6",
    ]);
    expect(
      modelFallbackOperatorLogTestBuffer.filter((line) =>
        line.includes("modality_filter"),
      ),
    ).toEqual([]);
  });
});
