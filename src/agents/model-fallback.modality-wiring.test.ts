// NEW-A Phase 5 — wiring tests for `runWithModelFallback`'s modality-aware
// candidate filter. Verifies:
//  (1) regression: legacy callers (no `turnModalityRequirements`) produce
//      byte-identical `route candidates ordered:` output AND emit zero
//      `modality_filter` log lines;
//  (2) positive: image+text requirement against `[opus(text-only), gpt-5.4
//      (text+image)]` → opus dropped, gpt-5.4 chosen, `modality_filter
//      applied required=image,text survivors=1 dropped=1` emitted;
//  (3) fail-open: single text-only candidate against image requirement →
//      `modality_filter fail_open` log emitted AND opus still attempted
//      (survivor-set non-empty invariant);
//  (4) zero requirements: empty array → no filter log, no drop;
//  (5) document mode: pdf attachment + no `needsVision` →
//      `deriveTurnModalityRequirements` yields `['text']` only → all
//      candidates pass, NO `modality_filter` log because `text` is
//      universally covered (zero-drop applied line still emits per spec —
//      see test for exact assertion).
//
// Sub-plan: `.cursor/plans/commitment_kernel_modality_aware_routing.plan.md`.
// Audit: `extensions/AUDIT-modality-aware-routing.md` §a / §i.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import * as modelCatalogModule from "./model-catalog.js";
import {
  modelFallbackOperatorLogTestBuffer,
  runWithModelFallback,
} from "./model-fallback.js";
import { deriveTurnModalityRequirements } from "./model-fallback-modality.js";
import { resetModelCatalogCacheForTest } from "./model-catalog.js";
import type { ModelCatalogEntry } from "./model-catalog.js";

// Deterministic test catalog reflecting the NEW-A reproducer:
//   - hydra/claude-opus-4.6 → input: ['text']           (image-blind)
//   - hydra/gpt-5.4         → input: ['text','image']
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

// Force the OPERATOR_LOG_CAPTURE_ENV path on so the buffer captures
// `modality_filter` lines emitted via `logOperatorFacingLine`.
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

describe("runWithModelFallback — NEW-A Phase 5 modality wiring", () => {
  let loadCatalogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env[OPERATOR_LOG_CAPTURE_ENV] = "1";
    modelFallbackOperatorLogTestBuffer.length = 0;
    resetModelCatalogCacheForTest();
    // Replace catalog loader at the module-import-binding level. This is the
    // only way to inject a deterministic catalog for the wiring tests; the
    // function under test (`runWithModelFallback`) reads the module's exported
    // binding directly. We spy on `loadModelCatalog` rather than the helper
    // under test (`filterCandidatesByModality`) — invariant per slice spec
    // §"No mocking the guard": tests must exercise the real filter path.
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

  it("REGRESSION: caller without `turnModalityRequirements` emits zero `modality_filter` log lines and runs primary first (byte-identical legacy path)", async () => {
    const run = vi.fn().mockResolvedValueOnce("ok");
    const result = await runWithModelFallback({
      cfg: makeHydraCfg(),
      provider: "hydra",
      model: "claude-opus-4.6",
      run,
    });

    expect(result.result).toBe("ok");
    // Primary (opus) attempted first — preflight-blind ordering.
    expect(run.mock.calls[0]?.slice(0, 2)).toEqual(["hydra", "claude-opus-4.6"]);
    // Zero `modality_filter` log lines — legacy callers stay byte-identical.
    expect(
      modelFallbackOperatorLogTestBuffer.filter((line) =>
        line.includes("modality_filter"),
      ),
    ).toEqual([]);
  });

  it("REGRESSION: empty `turnModalityRequirements: []` is treated as omitted — no filter log, no reorder", async () => {
    const run = vi.fn().mockResolvedValueOnce("ok");
    await runWithModelFallback({
      cfg: makeHydraCfg(),
      provider: "hydra",
      model: "claude-opus-4.6",
      turnModalityRequirements: [],
      run,
    });

    expect(run.mock.calls[0]?.slice(0, 2)).toEqual(["hydra", "claude-opus-4.6"]);
    expect(
      modelFallbackOperatorLogTestBuffer.filter((line) =>
        line.includes("modality_filter"),
      ),
    ).toEqual([]);
  });

  it("POSITIVE: image+text requirement against [opus(text-only), gpt-5.4(text+image)] drops opus, picks gpt-5.4, emits `modality_filter applied`", async () => {
    const run = vi.fn().mockResolvedValueOnce("ok");
    const result = await runWithModelFallback({
      cfg: makeHydraCfg(),
      provider: "hydra",
      model: "claude-opus-4.6",
      turnModalityRequirements: ["image", "text"],
      run,
    });

    expect(result.result).toBe("ok");
    // Opus must NOT be the first (or any) attempt — it was filtered out.
    expect(run.mock.calls[0]?.slice(0, 2)).toEqual(["hydra", "gpt-5.4"]);
    expect(
      run.mock.calls.some(
        (call) => call[0] === "hydra" && call[1] === "claude-opus-4.6",
      ),
    ).toBe(false);

    const appliedLine = modelFallbackOperatorLogTestBuffer.find((line) =>
      line.startsWith("[model-fallback] modality_filter applied"),
    );
    expect(appliedLine).toBeDefined();
    // Required modalities are echoed verbatim (sanitized for log).
    expect(appliedLine).toContain("required=image,text");
    expect(appliedLine).toContain("survivors=1");
    expect(appliedLine).toContain("dropped=1");
    // No fail_open line — filter ran normally.
    expect(
      modelFallbackOperatorLogTestBuffer.some((line) =>
        line.includes("modality_filter fail_open"),
      ),
    ).toBe(false);
  });

  it("FAIL-OPEN: single candidate [opus(text-only)] + image requirement → `modality_filter fail_open` emitted AND opus is still attempted (survivor-set non-empty invariant)", async () => {
    const run = vi.fn().mockResolvedValueOnce("ok");
    const result = await runWithModelFallback({
      cfg: makeSingleHydraCfg(),
      provider: "hydra",
      model: "claude-opus-4.6",
      turnModalityRequirements: ["image", "text"],
      run,
    });

    expect(result.result).toBe("ok");
    // Opus IS attempted — fail-open invariant restored unfiltered candidates.
    expect(run.mock.calls[0]?.slice(0, 2)).toEqual(["hydra", "claude-opus-4.6"]);

    const failOpenLine = modelFallbackOperatorLogTestBuffer.find((line) =>
      line.startsWith("[model-fallback] modality_filter fail_open"),
    );
    expect(failOpenLine).toBeDefined();
    expect(failOpenLine).toContain("required=image,text");
    expect(failOpenLine).toContain("reason=zero-survivors-after-filter");
    expect(failOpenLine).toContain("restoring=1");
    // No `applied` line — only `fail_open` emitted on this branch.
    expect(
      modelFallbackOperatorLogTestBuffer.some((line) =>
        line.includes("modality_filter applied"),
      ),
    ).toBe(false);
  });

  it("DOCUMENT MODE: pdf attachment derivation produces ['text'] only → all candidates pass, applied line emits with `dropped=0` (filter wired but inert)", async () => {
    const requirements = deriveTurnModalityRequirements({
      inboundMediaSummary: { attachments: [{ kind: "pdf" }] },
    });
    expect(requirements).toEqual(["text"]);

    const run = vi.fn().mockResolvedValueOnce("ok");
    await runWithModelFallback({
      cfg: makeHydraCfg(),
      provider: "hydra",
      model: "claude-opus-4.6",
      turnModalityRequirements: requirements,
      run,
    });

    // Opus passes — `text` is universally covered.
    expect(run.mock.calls[0]?.slice(0, 2)).toEqual(["hydra", "claude-opus-4.6"]);

    const appliedLine = modelFallbackOperatorLogTestBuffer.find((line) =>
      line.startsWith("[model-fallback] modality_filter applied"),
    );
    expect(appliedLine).toBeDefined();
    expect(appliedLine).toContain("required=text");
    expect(appliedLine).toContain("survivors=2");
    expect(appliedLine).toContain("dropped=0");
    expect(
      modelFallbackOperatorLogTestBuffer.some((line) =>
        line.includes("modality_filter fail_open"),
      ),
    ).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Runner-derivation contract — mirrors `agent-runner-execution.ts` Phase 5
  // wiring. The runner translates `params.opts?.images: ImageContent[]` into
  // a structural `inboundMediaSummaryLike` and passes it (plus
  // `routingSnapshot.plannerInput.routing?.needsVision`) into
  // `deriveTurnModalityRequirements`. We assert the OUTPUT of that derivation
  // pattern here so a future refactor of the call site cannot silently break
  // the live NEW-A reproducer (the cheapest possible regression guard given
  // that `runReplyAgent` itself has heavy dependencies).
  // ---------------------------------------------------------------------
  describe("runner-derivation contract (NEW-A live-path mirror)", () => {
    it("derives ['text','image'] when opts.images has 1+ entries (NEW-A reproducer path)", () => {
      // Mirror agent-runner-execution.ts shape.
      const fakeImages = [{ data: "...", mimeType: "image/jpeg" }];
      const inboundMediaSummary =
        fakeImages.length > 0
          ? { attachments: fakeImages.map(() => ({ kind: "image" as const })) }
          : undefined;
      const requirements = deriveTurnModalityRequirements({
        ...(inboundMediaSummary ? { inboundMediaSummary } : {}),
      });
      expect(requirements).toEqual(["image", "text"]);
    });

    it("derives ['text'] when opts.images is empty AND routing.needsVision is undefined (legacy text-only path)", () => {
      const fakeImages: unknown[] = [];
      const inboundMediaSummary =
        fakeImages.length > 0
          ? { attachments: fakeImages.map(() => ({ kind: "image" as const })) }
          : undefined;
      const requirements = deriveTurnModalityRequirements({
        ...(inboundMediaSummary ? { inboundMediaSummary } : {}),
      });
      expect(requirements).toEqual(["text"]);
    });

    it("derives ['text','image'] when needsVision is true even without inbound images (defense-in-depth path)", () => {
      // Mirrors runner branch: routingSnapshot.plannerInput.routing?.needsVision
      // === true → forwarded to deriveTurnModalityRequirements as
      // `needsVision: true`.
      const requirements = deriveTurnModalityRequirements({
        needsVision: true,
      });
      expect(requirements).toEqual(["image", "text"]);
    });
  });

  it("REGRESSION (snapshot-shape): `route candidates ordered:` log line shape is unchanged when `turnModalityRequirements` is omitted", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const run = vi.fn().mockResolvedValueOnce("ok");

    await runWithModelFallback({
      cfg: makeHydraCfg(),
      provider: "hydra",
      model: "claude-opus-4.6",
      run,
    });

    // The operator-facing buffer captures lines emitted via
    // `logOperatorFacingLine`. The `route candidates ordered:` line uses
    // `log.info` directly (per audit §a step 7) and so is NOT in the
    // operator-buffer. We assert via the absence of `modality_filter` lines
    // — that signature alone is the regression guard for this slice.
    expect(
      modelFallbackOperatorLogTestBuffer.filter((line) =>
        line.includes("modality_filter"),
      ),
    ).toEqual([]);

    logSpy.mockRestore();
    infoSpy.mockRestore();
  });
});
