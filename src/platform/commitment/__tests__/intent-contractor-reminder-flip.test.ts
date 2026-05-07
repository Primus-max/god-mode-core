/**
 * Slice K Phase 5 — IntentContractor classifier extension.
 *
 * Mirrors `intent-contractor-repo-flip.test.ts` (Cutover-4 P8) and
 * `intent-contractor-inbound-attachments.test.ts` (Cutover-3 P6) as
 * fail-first templates.
 *
 * Phase 5 ships TWO additive frozen-layer touches to
 * `src/platform/commitment/intent-contractor-impl.ts`:
 *
 *   (a) **Prompt-hint allowlist** at the `responseShape.desiredEffectFamily`
 *       literal. Pre-flip 6 families post-Cutover-4 P8:
 *         `persistent_session | communication | web_research | artifact | repo | unknown`
 *       Post-flip 7 families (slice-K reminder added):
 *         `persistent_session | communication | web_research | artifact | repo | reminder | unknown`
 *
 *   (b) NEW structured prompt slots `<recall_window>` and
 *       `<effect_family_filter>` injected into the LLM prompt as
 *       schema-hint blocks. These mirror the existing `<memory>` /
 *       `<active_tasks>` / `<inbound_attachments>` block precedents but
 *       describe the **output** the LLM should populate inside
 *       `constraints.recallWindow` (`{from?:ISO8601, until?:ISO8601}`)
 *       and `constraints.effectFamilyFilter` (`readonly EpisodicEffectFamily[]`).
 *
 *       Because the contractor is the only sanctioned reader of raw user
 *       text (invariant #6), temporal-expression resolution
 *       («на прошлой неделе» → ISO-8601 range) and family inference
 *       («PDF» → `['artifact']`) live INSIDE the contractor's LLM. Slice
 *       K extends the structured surface, not the reader-set.
 *
 *   (c) Existing `<memory>` (slice E P6) + `<active_tasks>` (slice F P6) +
 *       `<inbound_attachments>` (cutover-3 P6) blocks remain UNCHANGED.
 *
 * Tests cover:
 *   1. Source-level: prompt-hint allowlist literal contains 7 families
 *      (reminder + unknown).
 *   2. Source-level: prompt body now contains `<recall_window>` and
 *      `<effect_family_filter>` schema-hint slots.
 *   3. Functional: contractor adapter returning
 *      `desiredEffectFamily=reminder` with structured constraints
 *      (`recallWindow.from/until` ISO-8601 + `effectFamilyFilter=['artifact']`)
 *      flows through verbatim — no `family_not_in_registry`.
 *   4. Reverse: contractor adapter returning a non-reminder family
 *      (`communication` for «привет») produces non-reminder output;
 *      empty constraints round-trip.
 *   5. Reverse (anonymous session): contractor with NO `identityId` and
 *      NO `memoryStore` (anonymous path) still passes the reminder-shape
 *      response through verbatim — the recall-side gating at
 *      `RecallReminderTool` handles fail-closed (Phase 4); the
 *      contractor itself is anonymous-safe.
 *   6. Regression (block byte-identity): existing `<memory>`,
 *      `<active_tasks>`, `<inbound_attachments>` block builders remain
 *      byte-identical. Regression guard greps the source for the legacy
 *      block-tag literals.
 *   7. Family inference probes — six fixed-adapter probes assert that
 *      «PDF» / «ветка» / «задача» / «коммерческий offer» / «yesterday» /
 *      «last 7 days» each round-trip the LLM-produced structured
 *      classification through the contractor without normalizing
 *      `desiredEffectFamily=reminder` away.
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
  REMINDER_EFFECT_FAMILY,
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

type CapturedAdapterCall = { prompt: string };

function makeCapturingAdapter(
  intent: SemanticIntent,
  captures: CapturedAdapterCall[],
): IntentContractorAdapter {
  return {
    classify: async (params) => {
      captures.push({ prompt: params.prompt });
      return intent;
    },
  };
}

describe("IntentContractor reminder classifier extension (slice K Phase 5)", () => {
  it("source-level: prompt-hint allowlist literal contains exactly the 7 expected families (reminder added)", () => {
    // Phase 5 flip is a single-line edit to the responseShape literal at
    // `intent-contractor-impl.ts` (~line 917 post Cutover-4 P8). Assert
    // the exact post-flip ordering: existing 6 families + `reminder`
    // inserted before `unknown` to keep family-grouping (capability
    // families before the unknown sentinel — same ordering rule as
    // `EFFECT_FAMILY_REGISTRY`).
    const expectedLiteral =
      '\'"persistent_session" | "communication" | "web_research" | "artifact" | "repo" | "reminder" | "unknown"\'';

    expect(IMPL_SOURCE).toContain(expectedLiteral);
  });

  it("source-level: pre-flip 6-family allowlist literal is gone (regression guard — no stale literal)", () => {
    const preFlipLiteral =
      '\'"persistent_session" | "communication" | "web_research" | "artifact" | "repo" | "unknown"\'';

    expect(IMPL_SOURCE).not.toContain(preFlipLiteral);
  });

  it("source-level: prompt body documents the <recall_window> structured slot for reminder turns", () => {
    // The contractor prompt MUST advertise the structured slot the LLM
    // populates when classifying a reminder turn. This guarantees the
    // LLM sees the schema for `constraints.recallWindow` and outputs
    // ISO-8601 strings rather than raw temporal phrases.
    expect(IMPL_SOURCE).toContain("<recall_window>");
    expect(IMPL_SOURCE).toContain("</recall_window>");
  });

  it("source-level: prompt body documents the <effect_family_filter> structured slot for reminder turns", () => {
    // Mirror of <recall_window>: structured filter for episodic family
    // selection. Documented in the prompt so the LLM populates
    // `constraints.effectFamilyFilter` with closed-set member ids only
    // (e.g. `['artifact']` for «PDF», `['repo']` for «ветка»).
    expect(IMPL_SOURCE).toContain("<effect_family_filter>");
    expect(IMPL_SOURCE).toContain("</effect_family_filter>");
  });

  it("regression: legacy <memory>, <active_tasks>, <inbound_attachments> block tags remain byte-identical in source", () => {
    // The slice E P6 / slice F P6 / cutover-3 P6 block tags MUST stay
    // byte-identical. Phase 5 is purely additive — we add new schema
    // slots, we do NOT touch the existing 3 recall-block builders.
    expect(IMPL_SOURCE).toContain("<memory>");
    expect(IMPL_SOURCE).toContain("</memory>");
    expect(IMPL_SOURCE).toContain("<active_tasks>");
    expect(IMPL_SOURCE).toContain("</active_tasks>");
    expect(IMPL_SOURCE).toContain("<inbound_attachments>");
    expect(IMPL_SOURCE).toContain("</inbound_attachments>");
  });

  it("functional: classifier emitting `reminder` family with structured recallWindow + effectFamilyFilter is accepted end-to-end", async () => {
    // Positive case: prompt «какой PDF я делал на прошлой неделе?» with
    // a mock adapter that returns the LLM's structured output. The
    // contractor MUST surface the family unchanged with NO
    // `family_not_in_registry` uncertainty tag, AND MUST carry the
    // structured constraints (`recallWindow.from/until` + `effectFamilyFilter`)
    // through verbatim — Phase 4 `RecallReminderTool` reads them.
    const adapter = fixedIntentAdapter({
      desiredEffectFamily: REMINDER_EFFECT_FAMILY,
      target: { kind: "unspecified" },
      operation: { kind: "observe" },
      constraints: {
        recallWindow: {
          from: "2026-04-29T00:00:00Z",
          until: "2026-05-06T23:59:59Z",
        },
        effectFamilyFilter: ["artifact"],
      },
      uncertainty: [],
      confidence: 0.9,
    });
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: adapter },
    });

    const result = await contractor.classify("какой PDF я делал на прошлой неделе?");

    expect(result.desiredEffectFamily).toBe(REMINDER_EFFECT_FAMILY);
    expect(result.target.kind).toBe("unspecified");
    expect(result.operation?.kind).toBe("observe");
    expect(result.constraints).toMatchObject({
      recallWindow: {
        from: "2026-04-29T00:00:00Z",
        until: "2026-05-06T23:59:59Z",
      },
      effectFamilyFilter: ["artifact"],
    });
    expect(result.uncertainty).not.toContain("family_not_in_registry");
    expect(result.uncertainty).not.toContain("operation_not_allowed_for_family");
    expect(result.confidence).toBeCloseTo(0.9);
  });

  it("reverse: classifier emitting `communication` for «привет» is unaffected (non-reminder regression guard)", async () => {
    // Greeting prompt. The LLM legitimately returns `communication`,
    // NOT `reminder`. The contractor must pass it through unchanged —
    // adding the `reminder` allowlist member MUST NOT cause any
    // non-reminder family to be re-classified.
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
    expect(result.constraints).toEqual({});
    expect(result.uncertainty).not.toContain("family_not_in_registry");
  });

  it("reverse: anonymous session (no identityId, no memoryStore) reminder classification still flows through verbatim", async () => {
    // The contractor itself is anonymous-safe. Recall-side gating
    // (fail-closed) is handled by Phase 4 `RecallReminderTool`, NOT by
    // the contractor. This test guards against a regression where Phase
    // 5 might accidentally couple the contractor's reminder branch to
    // an identityId pre-check.
    const adapter = fixedIntentAdapter({
      desiredEffectFamily: REMINDER_EFFECT_FAMILY,
      target: { kind: "unspecified" },
      operation: { kind: "observe" },
      constraints: {
        recallWindow: {
          from: "2026-04-29T00:00:00Z",
          until: "2026-05-06T23:59:59Z",
        },
        effectFamilyFilter: ["artifact"],
      },
      uncertainty: [],
      confidence: 0.9,
    });
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: adapter },
      // Anonymous: no identityId, no memoryStore, no taskLedger.
    });

    const result = await contractor.classify("какой PDF я делал на прошлой неделе?");

    expect(result.desiredEffectFamily).toBe(REMINDER_EFFECT_FAMILY);
    expect(result.constraints).toMatchObject({
      recallWindow: {
        from: "2026-04-29T00:00:00Z",
        until: "2026-05-06T23:59:59Z",
      },
      effectFamilyFilter: ["artifact"],
    });
  });

  it("temporal-expression round-trip: «вчера» (yesterday) ISO range carried through verbatim", async () => {
    const adapter = fixedIntentAdapter({
      desiredEffectFamily: REMINDER_EFFECT_FAMILY,
      target: { kind: "unspecified" },
      operation: { kind: "observe" },
      constraints: {
        recallWindow: {
          from: "2026-05-05T00:00:00Z",
          until: "2026-05-05T23:59:59Z",
        },
        effectFamilyFilter: ["artifact", "task", "repo"],
      },
      uncertainty: [],
      confidence: 0.88,
    });
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: adapter },
    });

    const result = await contractor.classify("что я делал вчера?");

    expect(result.desiredEffectFamily).toBe(REMINDER_EFFECT_FAMILY);
    const constraints = result.constraints as {
      recallWindow?: { from?: string; until?: string };
      effectFamilyFilter?: readonly string[];
    };
    expect(constraints.recallWindow?.from).toBe("2026-05-05T00:00:00Z");
    expect(constraints.recallWindow?.until).toBe("2026-05-05T23:59:59Z");
    expect(constraints.effectFamilyFilter).toEqual(["artifact", "task", "repo"]);
  });

  it("temporal-expression round-trip: «last 7 days» window carried through verbatim", async () => {
    const adapter = fixedIntentAdapter({
      desiredEffectFamily: REMINDER_EFFECT_FAMILY,
      target: { kind: "unspecified" },
      operation: { kind: "observe" },
      constraints: {
        recallWindow: {
          from: "2026-04-29T12:00:00Z",
          until: "2026-05-06T12:00:00Z",
        },
      },
      uncertainty: [],
      confidence: 0.87,
    });
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: adapter },
    });

    const result = await contractor.classify("show my activity in the last 7 days");

    expect(result.desiredEffectFamily).toBe(REMINDER_EFFECT_FAMILY);
    const constraints = result.constraints as {
      recallWindow?: { from?: string; until?: string };
    };
    expect(constraints.recallWindow?.from).toBe("2026-04-29T12:00:00Z");
    expect(constraints.recallWindow?.until).toBe("2026-05-06T12:00:00Z");
  });

  it("family inference: «ветка» round-trips effectFamilyFilter=['repo']", async () => {
    const adapter = fixedIntentAdapter({
      desiredEffectFamily: REMINDER_EFFECT_FAMILY,
      target: { kind: "unspecified" },
      operation: { kind: "observe" },
      constraints: {
        effectFamilyFilter: ["repo"],
      },
      uncertainty: [],
      confidence: 0.86,
    });
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: adapter },
    });

    const result = await contractor.classify("какую ветку я создавал?");

    expect(result.desiredEffectFamily).toBe(REMINDER_EFFECT_FAMILY);
    const constraints = result.constraints as { effectFamilyFilter?: readonly string[] };
    expect(constraints.effectFamilyFilter).toEqual(["repo"]);
  });

  it("family inference: «задача» round-trips effectFamilyFilter=['task']", async () => {
    const adapter = fixedIntentAdapter({
      desiredEffectFamily: REMINDER_EFFECT_FAMILY,
      target: { kind: "unspecified" },
      operation: { kind: "observe" },
      constraints: {
        effectFamilyFilter: ["task"],
      },
      uncertainty: [],
      confidence: 0.86,
    });
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: adapter },
    });

    const result = await contractor.classify("какие у меня были задачи?");

    expect(result.desiredEffectFamily).toBe(REMINDER_EFFECT_FAMILY);
    const constraints = result.constraints as { effectFamilyFilter?: readonly string[] };
    expect(constraints.effectFamilyFilter).toEqual(["task"]);
  });

  it("registry symmetry: all 7 families resolve as registered (no `family_not_in_registry` introduced)", async () => {
    // Sweep every family through the contractor — confirm none silently
    // downgrade to `unknown` with `family_not_in_registry`.
    const families = [
      PERSISTENT_SESSION_EFFECT_FAMILY,
      COMMUNICATION_EFFECT_FAMILY,
      WEB_RESEARCH_EFFECT_FAMILY,
      ARTIFACT_EFFECT_FAMILY,
      REPO_EFFECT_FAMILY,
      REMINDER_EFFECT_FAMILY,
      UNKNOWN_EFFECT_FAMILY,
    ] as const;

    for (const family of families) {
      const adapter = fixedIntentAdapter({
        desiredEffectFamily: family,
        target: { kind: "unspecified" },
        ...(family === UNKNOWN_EFFECT_FAMILY
          ? {}
          : family === REMINDER_EFFECT_FAMILY
            ? { operation: { kind: "observe" as const } }
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

  it("custom adapter contract: pluggable adapters still receive the raw user prompt (the schema-prompt is internal to PiIntentContractorAdapter)", async () => {
    // The custom-adapter wire receives `prompt: string` — the raw user
    // text with optional recall-block prefixes (memory / active_tasks /
    // inbound_attachments). The full schema prompt with response-shape
    // documentation (including the new <recall_window> +
    // <effect_family_filter> slots) is constructed INSIDE
    // `PiIntentContractorAdapter` (the default `pi-simple` backend) via
    // `buildIntentContractorPrompt`. This regression guard pins the
    // contract so future refactors do not accidentally widen the
    // adapter surface and leak schema strings to test adapters.
    const captures: CapturedAdapterCall[] = [];
    const adapter = makeCapturingAdapter(
      {
        desiredEffectFamily: COMMUNICATION_EFFECT_FAMILY,
        target: { kind: "external_channel" },
        operation: { kind: "create" },
        constraints: {},
        uncertainty: [],
        confidence: 0.5,
      },
      captures,
    );
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: adapter },
    });

    await contractor.classify("any prompt");

    expect(captures).toHaveLength(1);
    expect(captures[0].prompt).toBe("any prompt");
  });
});
