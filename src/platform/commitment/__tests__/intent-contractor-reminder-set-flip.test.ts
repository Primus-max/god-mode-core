/**
 * Cron/Scheduler Phase 7 — IntentContractor classifier extension for the
 * reminder-set (write-side) path.
 *
 * Mirrors `intent-contractor-reminder-flip.test.ts` (Slice K Phase 5,
 * recall-side / observe operationKind) but exercises the WRITE-side
 * `operation.kind=create` path for the same `reminder` effect family.
 *
 * Phase 7 ships TWO additive frozen-layer touches to
 * `src/platform/commitment/intent-contractor-impl.ts`:
 *
 *   (a) **Prompt instruction extension**: a new sentence describing
 *       the `<reminder_set_intent>` slot the LLM populates inside
 *       `constraints.reminderSet` when the turn is a reminder-set
 *       request («напомни мне через 30 минут позвонить клиенту X»).
 *       The pre-existing instruction sentence for `<recall_window>` /
 *       `<effect_family_filter>` (slice K P5) stays BYTE-IDENTICAL.
 *
 *   (b) NEW structured prompt slot `<reminder_set_intent>` injected
 *       into the LLM prompt as a schema-hint block. Mirrors the
 *       existing `<recall_window>` / `<effect_family_filter>`
 *       precedents but describes the **output** the LLM should
 *       populate inside `constraints.reminderSet` (`{fireAt:ISO8601,
 *       content:string, deliveryChannel?:ChannelId,
 *       deliveryTo?:string}`).
 *
 *   (c) NEW `examples` entry exemplifying a relative-temporal
 *       reminder-set turn («напомни мне через 30 минут позвонить
 *       клиенту X»). Pre-existing examples (greeting, intent_unclear,
 *       reminder query) stay BYTE-IDENTICAL.
 *
 *   (d) Existing `<memory>` (slice E P6) + `<active_tasks>` (slice F P6) +
 *       `<inbound_attachments>` (cutover-3 P6) + `<recall_window>` +
 *       `<effect_family_filter>` (slice K P5) blocks remain UNCHANGED.
 *
 * Per invariants #5/#6 the LLM (inside this contractor) is the SOLE
 * sanctioned reader of raw user text. Temporal-expression resolution
 * («через 30 минут» → ISO-8601 absolute timestamp) and content
 * extraction («позвонить клиенту X») happen INSIDE the contractor; no
 * downstream module (Phase 5 `RecordReminderTool`, Phase 3
 * `ScheduledReminderObserver`, Phase 6 `ReminderStore`) ever
 * regex-matches against `RawUserTurn`.
 *
 * Tests cover:
 *   1. Source-level: prompt body now contains `<reminder_set_intent>`,
 *      `<fireAt>`, `<content>`, `<deliveryChannel>`, `<deliveryTo>`.
 *   2. Source-level: prompt instruction documents the
 *      `constraints.reminderSet` slot with `operation.kind=create`.
 *   3. Functional: contractor adapter returning
 *      `desiredEffectFamily=reminder` + `operation.kind=create` +
 *      structured `constraints.reminderSet={fireAt,content,...}` flows
 *      through verbatim — no `family_not_in_registry` /
 *      `operation_not_allowed_for_family` uncertainty tags. The
 *      effect-family allowlist already widened to
 *      `['observe','create']` at Phase 2.
 *   4. Reverse: contractor with `operation.kind=observe` for the same
 *      reminder family STILL works (slice K P5 path unaffected).
 *   5. Reverse: contractor returning `communication` for «привет» is
 *      unaffected (non-reminder regression guard).
 *   6. Reverse (anonymous session): contractor with NO `identityId` and
 *      NO `memoryStore` (anonymous path) still passes the reminder-set
 *      shape response through verbatim — fail-closed gating happens
 *      downstream at the `RecordReminderTool` adapter (Phase 5
 *      `identity_unavailable` failure code), NEVER inside the
 *      contractor itself.
 *   7. Regression (block byte-identity): existing `<memory>`,
 *      `<active_tasks>`, `<inbound_attachments>`, `<recall_window>`,
 *      `<effect_family_filter>` block builders remain byte-identical.
 *      Regression guard greps the source for the legacy block-tag
 *      literals.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { OpenClawConfig } from "../../../config/config.js";
import {
  COMMUNICATION_EFFECT_FAMILY,
  REMINDER_EFFECT_FAMILY,
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

describe("IntentContractor reminder-set classifier extension (Cron/Scheduler Phase 7)", () => {
  it("source-level: prompt body documents the <reminder_set_intent> structured slot for reminder-set turns", () => {
    // The contractor prompt MUST advertise the structured slot the LLM
    // populates when classifying a reminder-set turn. This guarantees
    // the LLM sees the schema for `constraints.reminderSet` and outputs
    // ISO-8601 strings rather than raw temporal phrases for `fireAt`,
    // and a structured `content` field rather than echoing raw user
    // text downstream.
    expect(IMPL_SOURCE).toContain("<reminder_set_intent>");
    expect(IMPL_SOURCE).toContain("</reminder_set_intent>");
  });

  it("source-level: <reminder_set_intent> block carries closed structured fields (fireAt + content + deliveryChannel + deliveryTo)", () => {
    // The Zod-validated `ReminderSetShape` at Phase 5 is exactly these
    // four fields plus `ownerIdentityId` (never LLM-generated — injected
    // from session context). Documenting them in the prompt's block
    // builder is the defense-in-depth that keeps the LLM from
    // hallucinating extra fields the closed-shape downstream rejects.
    expect(IMPL_SOURCE).toContain("<fireAt>");
    expect(IMPL_SOURCE).toContain("</fireAt>");
    expect(IMPL_SOURCE).toContain("<content>");
    expect(IMPL_SOURCE).toContain("</content>");
    expect(IMPL_SOURCE).toContain("<deliveryChannel>");
    expect(IMPL_SOURCE).toContain("</deliveryChannel>");
    expect(IMPL_SOURCE).toContain("<deliveryTo>");
    expect(IMPL_SOURCE).toContain("</deliveryTo>");
  });

  it("source-level: prompt instruction documents `constraints.reminderSet` with `operation.kind=create`", () => {
    // The instruction sentence must explicitly name the slot AND the
    // operation kind so the LLM disambiguates the create write-side
    // path from the observe recall-side path on the same family.
    expect(IMPL_SOURCE).toContain("constraints.reminderSet");
    expect(IMPL_SOURCE).toMatch(/operation\.kind=create/);
  });

  it("source-level: examples block carries a reminder-set exemplar for «через 30 минут» / «in 2 hours» / «через неделю»", () => {
    // The exemplar anchors the LLM on the relative-temporal-expression
    // resolution behaviour. Live evidence from sub-plan §5 expects a
    // turn like «напомни мне через 30 минут позвонить клиенту X» to
    // produce `desiredEffectFamily=reminder operationKind=create
    // constraints.fireAt=<+30min ISO-8601> constraints.content=...`
    // (sub-plan §1 todo for Phase 7).
    expect(IMPL_SOURCE).toMatch(/через 30 минут|in 2 hours|через неделю/);
    expect(IMPL_SOURCE).toMatch(/operation:\s*\{\s*kind:\s*"create"/);
  });

  it("regression: legacy <memory>, <active_tasks>, <inbound_attachments>, <recall_window>, <effect_family_filter> block tags remain byte-identical in source", () => {
    // The slice E P6 / slice F P6 / cutover-3 P6 / slice K P5 block
    // tags MUST stay byte-identical. Phase 7 is purely additive — we
    // add a new schema slot, we do NOT touch the existing 5 recall /
    // structured-block builders.
    expect(IMPL_SOURCE).toContain("<memory>");
    expect(IMPL_SOURCE).toContain("</memory>");
    expect(IMPL_SOURCE).toContain("<active_tasks>");
    expect(IMPL_SOURCE).toContain("</active_tasks>");
    expect(IMPL_SOURCE).toContain("<inbound_attachments>");
    expect(IMPL_SOURCE).toContain("</inbound_attachments>");
    expect(IMPL_SOURCE).toContain("<recall_window>");
    expect(IMPL_SOURCE).toContain("</recall_window>");
    expect(IMPL_SOURCE).toContain("<effect_family_filter>");
    expect(IMPL_SOURCE).toContain("</effect_family_filter>");
  });

  it("functional: classifier emitting `reminder` family + `create` operation + structured reminderSet flows through verbatim — no `family_not_in_registry` or `operation_not_allowed_for_family`", () => {
    return (async () => {
      // Positive case: prompt «напомни мне через 30 минут позвонить
      // клиенту X» with a mock adapter that returns the LLM's structured
      // output. The contractor MUST surface the family + operation
      // unchanged with NO uncertainty tags, AND MUST carry the
      // structured constraints (`reminderSet.fireAt/content/...`)
      // through verbatim — Phase 5 `RecordReminderTool` reads them.
      const adapter = fixedIntentAdapter({
        desiredEffectFamily: REMINDER_EFFECT_FAMILY,
        target: { kind: "unspecified" },
        operation: { kind: "create" },
        constraints: {
          reminderSet: {
            fireAt: "2026-05-07T12:30:00Z",
            content: "позвонить клиенту X",
            deliveryChannel: "telegram",
            deliveryTo: "6533456892",
          },
        },
        uncertainty: [],
        confidence: 0.9,
      });
      const contractor = createIntentContractor({
        cfg: mockCfg(),
        adapterRegistry: { mock: adapter },
      });

      const result = await contractor.classify(
        "напомни мне через 30 минут позвонить клиенту X",
      );

      expect(result.desiredEffectFamily).toBe(REMINDER_EFFECT_FAMILY);
      expect(result.target.kind).toBe("unspecified");
      expect(result.operation?.kind).toBe("create");
      expect(result.constraints).toMatchObject({
        reminderSet: {
          fireAt: "2026-05-07T12:30:00Z",
          content: "позвонить клиенту X",
          deliveryChannel: "telegram",
          deliveryTo: "6533456892",
        },
      });
      expect(result.uncertainty).not.toContain("family_not_in_registry");
      expect(result.uncertainty).not.toContain("operation_not_allowed_for_family");
      expect(result.confidence).toBeCloseTo(0.9);
    })();
  });

  it("functional: long-horizon reminder («через неделю отправь Y предложение») round-trips verbatim with fireAt = +7 days ISO", async () => {
    // Sub-plan §8 acceptance #2 — second live-verify exemplar. The LLM
    // resolves «через неделю» to an ISO-8601 absolute timestamp 7 days
    // forward from the server clock. Test pins the round-trip; the
    // resolution itself is the LLM's responsibility (the contractor
    // never validates the relative semantics — invariant #6).
    const adapter = fixedIntentAdapter({
      desiredEffectFamily: REMINDER_EFFECT_FAMILY,
      target: { kind: "unspecified" },
      operation: { kind: "create" },
      constraints: {
        reminderSet: {
          fireAt: "2026-05-14T12:00:00Z",
          content: "отправь Y предложение",
        },
      },
      uncertainty: [],
      confidence: 0.85,
    });
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: adapter },
    });

    const result = await contractor.classify("через неделю отправь Y предложение");

    expect(result.desiredEffectFamily).toBe(REMINDER_EFFECT_FAMILY);
    expect(result.operation?.kind).toBe("create");
    expect(result.constraints).toMatchObject({
      reminderSet: {
        fireAt: "2026-05-14T12:00:00Z",
        content: "отправь Y предложение",
      },
    });
    expect(result.uncertainty).not.toContain("operation_not_allowed_for_family");
  });

  it("regression: classifier emitting `reminder` family + `observe` (slice K P5 recall path) still flows through verbatim", async () => {
    // The Phase 7 prompt-extension MUST NOT regress the slice K P5
    // observe path. Both operation kinds coexist on the `reminder`
    // family — branching factor=2 at Phase 4 affordance level.
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
      confidence: 0.85,
    });
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: adapter },
    });

    const result = await contractor.classify("какие у меня запланированы напоминания?");

    expect(result.desiredEffectFamily).toBe(REMINDER_EFFECT_FAMILY);
    expect(result.operation?.kind).toBe("observe");
    expect(result.constraints).toMatchObject({
      recallWindow: {
        from: "2026-04-29T00:00:00Z",
        until: "2026-05-06T23:59:59Z",
      },
      effectFamilyFilter: ["artifact"],
    });
    expect(result.uncertainty).not.toContain("operation_not_allowed_for_family");
  });

  it("reverse: classifier emitting `communication` for «привет» is unaffected (non-reminder regression guard)", async () => {
    // Greeting prompt. The LLM legitimately returns `communication`,
    // NOT `reminder`. The contractor must pass it through unchanged —
    // adding the reminder-set structured slot MUST NOT cause any
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

  it("reverse: anonymous session (no identityId, no memoryStore) reminder-set classification still flows through verbatim", async () => {
    // The contractor itself is anonymous-safe. Write-side gating
    // (fail-closed `identity_unavailable`) is handled by Phase 5
    // `RecordReminderTool` adapter, NOT by the contractor. This test
    // guards against a regression where Phase 7 might accidentally
    // couple the contractor's reminder-set branch to an identityId
    // pre-check.
    const adapter = fixedIntentAdapter({
      desiredEffectFamily: REMINDER_EFFECT_FAMILY,
      target: { kind: "unspecified" },
      operation: { kind: "create" },
      constraints: {
        reminderSet: {
          fireAt: "2026-05-07T12:30:00Z",
          content: "позвонить клиенту X",
        },
      },
      uncertainty: [],
      confidence: 0.9,
    });
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: adapter },
      // Anonymous: no identityId, no memoryStore, no taskLedger.
    });

    const result = await contractor.classify(
      "напомни мне через 30 минут позвонить клиенту X",
    );

    expect(result.desiredEffectFamily).toBe(REMINDER_EFFECT_FAMILY);
    expect(result.operation?.kind).toBe("create");
    expect(result.constraints).toMatchObject({
      reminderSet: {
        fireAt: "2026-05-07T12:30:00Z",
        content: "позвонить клиенту X",
      },
    });
    expect(result.uncertainty).not.toContain("operation_not_allowed_for_family");
  });
});
