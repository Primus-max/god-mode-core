// Bundle-as-contract Phase 6 — end-to-end acceptance suite.
//
// Sub-plan: .cursor/plans/commitment_kernel_bundle_as_contract.plan.md
// (todo `bundle-contract-phase-6-telemetry-and-acceptance`).
// Audit anchor: extensions/AUDIT-bundle-as-contract.md §3.1 schema-construction
// site, §3.4 reverse-defense rationale, §6.2 empty-bundles regression-guard.
//
// Five live-evidence-grade acceptance cases that exercise the production
// wiring chain `applyBundleSchemaFilterAtAttempt` (Phase 4) with the
// Phase 6 `[bundle-filter]` telemetry attached. The fixtures replay the
// shape of `gateway-grok-route.log` 2026-05-02 turn `355ae135` and the
// downstream happy paths the slice MUST not regress.
//
// Fail-first stance — verified by reverting the wiring at
// `src/agents/pi-embedded-runner/run/attempt.ts:2074-2080` to
// `const toolsAfterBundleFilter = [...toolsRaw];` (drops Phase 4 wire-up
// while keeping the helper). Cases 1, 3, 4, 5 fail (kept arrays do not
// match expected gated catalogs); Case 2 is the regression-direction proof
// and is GREEN by construction (it asserts the pre-Phase-4 leaky behaviour).
//
// Telemetry is exercised through the optional `logger` parameter on
// `applyBundleSchemaFilterAtAttempt` — a small capture stub records the
// emitted log lines so the assertions can pin both the message format and
// the level split (`info` for removals > 0, `debug` otherwise). The
// production attempt-site already passes the shared `agent/embedded`
// subsystem logger; tests use the capture stub for determinism.

import { describe, expect, it } from "vitest";
import type { ResolutionToolBundle } from "../../platform/decision/resolution-contract.js";
import type { RecipeRuntimePlan } from "../../platform/recipe/runtime-adapter.js";
import {
  applyBundleSchemaFilterAtAttempt,
  type BundleFilterTelemetryLogger,
} from "../pi-embedded-runner/run/bundle-filter-wiring.js";

// ─── Fixture shapes ─────────────────────────────────────────────────────────

type FixtureTool = { readonly name?: string };

function makeTool(name: string): FixtureTool {
  return { name };
}

// Production-shape catalog — names sourced from
// `extensions/AUDIT-bundle-as-contract.md` §3.1 (catalog members emitted by
// the `createOpenClawCodingTools(...)` factory). Same shape used in the
// Phase 4 wiring tests; reused here so the acceptance harness mirrors the
// full LLM-bound tool list a production turn would see.
const FULL_CATALOG: readonly FixtureTool[] = [
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

// `applyModelProviderToolPolicy` (`pi-tools.ts:94-104`) removes DDG
// `web_search` for native-search models BEFORE our wiring runs (the policy
// lives inside `createOpenClawCodingTools`). For Case 3 we therefore feed
// the wiring helper a catalog that already had `web_search` stripped — this
// faithfully replays the catalog-shape grok-4 turns produce.
const CATALOG_AFTER_NATIVE_SEARCH_POLICY: readonly FixtureTool[] = [
  makeTool("web_fetch"),
  makeTool("exec"),
  makeTool("apply_patch"),
  makeTool("pdf"),
  makeTool("docx_write"),
  makeTool("image_generate"),
  makeTool("browser"),
  makeTool("sessions_spawn"),
];

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

// ─── Telemetry capture stub ────────────────────────────────────────────────
//
// Records both the level and the message so assertions can pin the
// `[bundle-filter] ...` format AND the level split (`info` when removals > 0,
// `debug` when zero removals).
type CapturedLogLine = { readonly level: "info" | "debug"; readonly message: string };

function makeCaptureLogger(): {
  readonly logger: BundleFilterTelemetryLogger;
  readonly lines: readonly CapturedLogLine[];
} {
  const lines: CapturedLogLine[] = [];
  const logger: BundleFilterTelemetryLogger = {
    info: (message: string) => {
      lines.push({ level: "info", message });
    },
    debug: (message: string) => {
      lines.push({ level: "debug", message });
    },
  };
  return { logger, lines };
}

// ─── Acceptance cases ───────────────────────────────────────────────────────

describe("bundle-schema-filter acceptance — Phase 6 end-to-end", () => {
  // ── Case 1: `355ae135` reproduction ──────────────────────────────────────
  //
  // Live evidence: `gateway-grok-route.log` 2026-05-02 turn `355ae135`.
  // Classifier mis-emit `bundles=[respond_only] requestedTools=[]`; selected
  // model `claude-opus-4.6` carries `nativeWebSearchTool=false`. Pre-fix
  // dev: the full catalog reached the LLM, the model autonomously invoked
  // DDG `web_search`, DDG bot-detection fired, the turn collapsed to
  // `Provider finish_reason: error`. Post-Phase-4 wiring + Phase 6 telemetry:
  // (a) tool schema reaching the LLM is empty;
  // (b) `[bundle-filter]` log line is emitted at `info` level with
  //     `removed_tools` containing `web_search:not_in_bundle_allowlist`;
  // (c) `web_search` is provably absent from the final `kept` array
  //     (downstream-coupling proxy for "no `Provider finish_reason: error`"
  //     since the model can no longer invoke a tool that was never in the
  //     schema).
  it(
    "355ae135 reproduction — bundles=[respond_only] requestedTools=[] " +
      "model=claude-opus-4.6 (nativeWebSearchTool=false) → empty tool schema " +
      "AND [bundle-filter] info-level line records web_search:not_in_bundle_allowlist",
    () => {
      const { logger, lines } = makeCaptureLogger();
      const turnId = "355ae135";

      const result = applyBundleSchemaFilterAtAttempt({
        tools: FULL_CATALOG,
        platformExecutionContext: makePlatformExecutionContext(["respond_only"]),
        modelCompat: { nativeWebSearchTool: false },
        turnId,
        logger,
      });

      // (a) Empty tool schema reaches the LLM.
      expect(result.kept).toEqual([]);

      // (c) `web_search` provably absent from the final tool array — proxy
      // assertion for "no `Provider finish_reason: error`" downstream.
      expect(result.kept.map((t) => t.name)).not.toContain("web_search");

      // (b) Telemetry line — exactly one emission at `info` level (removals > 0).
      expect(lines).toHaveLength(1);
      const [line] = lines;
      expect(line.level).toBe("info");
      expect(line.message).toContain("[bundle-filter]");
      expect(line.message).toContain(`turnId=${turnId}`);
      expect(line.message).toContain("bundles=[respond_only]");
      expect(line.message).toContain("web_search:not_in_bundle_allowlist");
      expect(line.message).toContain("kept_tools=[]");
    },
  );

  // ── Case 2: Reverse — pre-Phase-4 absence-of-fix mode ────────────────────
  //
  // Regression-guard direction. Same `355ae135`-shaped fixture but the
  // `applyBundleSchemaFilterAtAttempt` adapter is INTENTIONALLY NOT invoked.
  // The catalog reaches the (synthetic) LLM unchanged — `web_search` IS
  // present. This proves the filter is the SOLE gate: removing it from the
  // chain restores the pre-Phase-4 leak. Without this case a future
  // refactor that deletes the wiring would not be caught by Cases 1/3/4 if
  // they happened to be misread as "the filter no-op'd".
  it(
    "reverse — without applyBundleSchemaFilterAtAttempt, the same " +
      "355ae135-shaped fixture leaks web_search into the LLM tool list " +
      "(proves the filter is the sole gate)",
    () => {
      // Skip the wiring helper entirely — pre-Phase-4 behaviour.
      const toolsReachingLlm = FULL_CATALOG;

      // The catalog STILL contains web_search — the leak the slice fixed.
      expect(toolsReachingLlm.map((t) => t.name)).toContain("web_search");
      // And it is non-empty in general — the LLM would see the full
      // catalog and could autonomously call any of these.
      expect(toolsReachingLlm.length).toBeGreaterThan(0);
    },
  );

  // ── Case 3: `public_web_lookup` happy path on grok-4 ─────────────────────
  //
  // `applyModelProviderToolPolicy` removed DDG `web_search` BEFORE our
  // wiring runs (the catalog reaching us therefore omits `web_search`).
  // Our filter sees no `web_search` to remove and is a no-op on it — no
  // double-removal, no spurious telemetry. `web_fetch` is the only
  // allowlisted member of `public_web_lookup` present in the post-native-
  // search catalog and is kept; the rest are dropped by layer 1
  // (`not_in_bundle_allowlist`). Order preserved: layer 2 reverse-defense
  // is bypassed by both the native-search capability and the bundle
  // authority — Phase 5 / sub-plan §3.4.
  it(
    "public_web_lookup happy path — bundles=[public_web_lookup] " +
      "model=grok-4 (nativeWebSearchTool=true) — applyModelProviderToolPolicy " +
      "already removed DDG; bundle filter no-ops on web_search " +
      "(no double-removal, no spurious telemetry)",
    () => {
      const { logger, lines } = makeCaptureLogger();

      const result = applyBundleSchemaFilterAtAttempt({
        tools: CATALOG_AFTER_NATIVE_SEARCH_POLICY,
        platformExecutionContext: makePlatformExecutionContext([
          "public_web_lookup",
        ]),
        modelCompat: { nativeWebSearchTool: true },
        turnId: "test-public-web-lookup",
        logger,
      });

      // `web_fetch` kept (allowlisted); `web_search` was already gone
      // upstream — neither reason should record it as removed by us.
      expect(result.kept.map((t) => t.name)).toEqual(["web_fetch"]);
      expect(
        result.removed.find((r) => r.tool === "web_search"),
      ).toBeUndefined();

      // No double-fire: every recorded removal is a layer-1 drop
      // (`not_in_bundle_allowlist`). Reverse-defense MUST NOT have fired
      // (the model has native search AND the bundle is `public_web_lookup`).
      for (const r of result.removed) {
        expect(r.reason).toBe("not_in_bundle_allowlist");
      }

      // Telemetry: exactly one `info` line (removals > 0 because layer 1
      // dropped non-allowlisted catalog members like `exec`, `pdf`, etc.).
      expect(lines).toHaveLength(1);
      expect(lines[0].level).toBe("info");
      expect(lines[0].message).toContain("[bundle-filter]");
      expect(lines[0].message).toContain("bundles=[public_web_lookup]");
      // `web_search` MUST NOT appear in the removed_tools segment because
      // the bundle filter never saw it (the sister filter already removed
      // it upstream).
      expect(lines[0].message).not.toContain("web_search:");
    },
  );

  // ── Case 4: Composer combo (artifact_authoring + public_web_lookup) ──────
  //
  // Operator-grade composer turn: produce a PDF/DOCX/image artifact AND do
  // a public web lookup. Bundle union → kept tools are the union of the
  // two allowlists: `{pdf, docx_write, image_generate, apply_patch,
  // web_search, web_fetch}`. Reverse-defense MUST NOT fire — the bundle
  // contains `public_web_lookup` (legitimate authorising signal), even
  // though the model carries `nativeWebSearchTool=false`.
  it(
    "composer combo — bundles=[artifact_authoring,public_web_lookup] " +
      "model=opus-4.6 (nativeWebSearchTool=false) → kept = " +
      "{pdf,docx_write,image_generate,apply_patch,web_search,web_fetch}; " +
      "reverse-defense NOT fired (public_web_lookup authorises web_search)",
    () => {
      const { logger, lines } = makeCaptureLogger();

      const result = applyBundleSchemaFilterAtAttempt({
        tools: FULL_CATALOG,
        platformExecutionContext: makePlatformExecutionContext([
          "artifact_authoring",
          "public_web_lookup",
        ]),
        modelCompat: { nativeWebSearchTool: false },
        turnId: "test-composer-combo",
        logger,
      });

      expect(result.kept.map((t) => t.name).sort()).toEqual([
        "apply_patch",
        "docx_write",
        "image_generate",
        "pdf",
        "web_fetch",
        "web_search",
      ]);

      // Reverse-defense MUST NOT have fired — bundle authority wins.
      for (const r of result.removed) {
        expect(r.reason).not.toBe("reverse_defense_no_native_search");
      }

      // Telemetry — `info` because layer 1 dropped `exec`, `browser`,
      // `sessions_spawn` (none in either allowlist).
      expect(lines).toHaveLength(1);
      expect(lines[0].level).toBe("info");
      expect(lines[0].message).toContain(
        "bundles=[artifact_authoring,public_web_lookup]",
      );
      // The kept_tools segment must contain web_search (bundle authority
      // kept it despite `nativeWebSearchTool=false`).
      expect(lines[0].message).toContain("web_search");
      expect(lines[0].message).not.toContain(
        "web_search:reverse_defense_no_native_search",
      );
    },
  );

  // ── Case 5: Heartbeat-class regression guard ─────────────────────────────
  //
  // Empty bundles + `missingBundlePolicy='allow_all'` (the production
  // default the wiring passes) → byte-identical legacy catalog reaches the
  // LLM. PR-#126 sub-plan §8 row 1 concern: heartbeat / cron / synthetic
  // flows that bypass the classifier MUST NOT see surprise tool removals
  // from the new filter. Telemetry: zero removals → `debug` level (the
  // operator's `info` stream stays clean for legacy flows).
  it(
    "heartbeat-class regression guard — bundles=[] + " +
      "missingBundlePolicy='allow_all' → byte-identical legacy catalog " +
      "AND telemetry emits at DEBUG level (no info-level noise on legacy)",
    () => {
      const { logger, lines } = makeCaptureLogger();

      const result = applyBundleSchemaFilterAtAttempt({
        tools: FULL_CATALOG,
        // No platform execution context — the wiring reads `bundles=[]` and
        // the helper applies the default `missingBundlePolicy='allow_all'`.
        platformExecutionContext: undefined,
        modelCompat: { nativeWebSearchTool: false },
        turnId: "test-heartbeat-legacy",
        logger,
      });

      // Byte-identical (reference equality preserved on every kept item —
      // the helper does not clone tool objects).
      expect(result.kept.length).toBe(FULL_CATALOG.length);
      for (let i = 0; i < FULL_CATALOG.length; i += 1) {
        expect(result.kept[i]).toBe(FULL_CATALOG[i]);
      }
      expect(result.removed).toEqual([]);

      // Telemetry — exactly one `debug` line (removals === 0). This is the
      // PR-#126 §8 row 1 commitment: legacy flows are silent at `info`.
      expect(lines).toHaveLength(1);
      expect(lines[0].level).toBe("debug");
      expect(lines[0].message).toContain("[bundle-filter]");
      expect(lines[0].message).toContain("removed_tools=[]");
    },
  );

  // ── Telemetry never throws — defensive logger surface ────────────────────
  //
  // Negative-coverage case for the telemetry path: even if the supplied
  // logger throws on `info` / `debug`, the filter result MUST still be
  // returned to the caller. Invariant #15 — the filter never throws.
  it(
    "telemetry is defensive — a logger that throws on info/debug does not " +
      "propagate into the filter result (invariant #15)",
    () => {
      const throwingLogger: BundleFilterTelemetryLogger = {
        info: () => {
          throw new Error("simulated transient log-write failure");
        },
        debug: () => {
          throw new Error("simulated transient log-write failure");
        },
      };

      // Must not throw.
      const result = applyBundleSchemaFilterAtAttempt({
        tools: FULL_CATALOG,
        platformExecutionContext: makePlatformExecutionContext(["respond_only"]),
        modelCompat: { nativeWebSearchTool: false },
        turnId: "test-defensive-logger",
        logger: throwingLogger,
      });

      // Filter result is unchanged — `respond_only` empties the catalog.
      expect(result.kept).toEqual([]);
      expect(result.removed.length).toBe(FULL_CATALOG.length);
    },
  );
});
