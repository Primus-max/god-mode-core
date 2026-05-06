/**
 * NEW-D Phase 5 — locale-aware sanitizer acceptance fixture.
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_locale_aware_sanitizer.plan.md`
 * §4 / §5 phase 5 todo + audit deliverable
 * `extensions/AUDIT-locale-aware-sanitizer.md`.
 *
 * Replay fixture mirroring the slice I `deliver.b5-replay.test.ts` shape — pins
 * the post-NEW-D-Phase-4 contract via the L2392 reproduction:
 *
 *   gateway log L2392 (`C:/tmp/openclaw/openclaw-2026-05-06.log`):
 *     `[assistant-reply] runId=4407441e lang=en cyr=0 head="ALERT: Vladimir
 *     is waiting f..."` reached telegram channel with audience locale=ru.
 *
 * The 3 cases below close NEW-D's regression and lock in backward-compat:
 *
 *   (1) L2392 regression closed — the literal head sample
 *       `"ALERT: Vladimir is waiting for confirmation"` on telegram (audience
 *       locale=ru) is empty-substituted with
 *       `EMPTY_AFTER_SANITIZATION_FALLBACK_TEXT` (`"Запрос не удалось
 *       выполнить."`); telemetry contains `[outbound-sanitizer] locale_filter
 *       applied locale=en blocked=true reason=no_cyrillic channel=telegram`.
 *
 *   (2) Russian content unchanged — `"Готово"`-class payload on the same
 *       channel reaches telegram verbatim; zero locale-filter telemetry.
 *
 *   (3) Diagnostic regression — payload with a `[planner]` diagnostic on
 *       channel-locale=ru: the existing 16-pattern strip fires first (text
 *       becomes empty before locale check) and the locale gate is inert —
 *       telemetry shows the pattern-strip event NOT a locale_filter event.
 *
 * Test discipline (per slice I P5+P6 precedent and sub-plan §5):
 *   - No `vi.spyOn` on `sanitizeOutboundForExternalChannel` /
 *     `resolveReplySanitizerPolicyWithLocale` /
 *     `__detectPredominantLocaleForTests` — all cases use real instances.
 *   - The `logging/subsystem` module is mocked only to capture telemetry
 *     strings (same pattern as `deliver.outbound-sanitizer.test.ts`).
 *
 * NEW-D SLICE COMPLETE marker: when this fixture is green AND the live-verify
 * operator runbook (this PR's body) confirms zero new `[assistant-reply] ...
 * lang=en cyr=0` followed by an outbound payload reaching telegram, the slice
 * is closed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramOutbound } from "../../../test/channel-outbounds.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";

const mocks = vi.hoisted(() => ({
  appendAssistantMessageToSessionTranscript: vi.fn(async () => ({ ok: true, sessionFile: "x" })),
}));
const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runMessageSent: vi.fn(async () => {}),
  },
}));
const internalHookMocks = vi.hoisted(() => ({
  createInternalHookEvent: vi.fn(),
  triggerInternalHook: vi.fn(async () => {}),
}));
const queueMocks = vi.hoisted(() => ({
  enqueueDelivery: vi.fn(async () => "mock-queue-id"),
  ackDelivery: vi.fn(async () => {}),
  failDelivery: vi.fn(async () => {}),
}));
const logMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
  };
});
vi.mock("../../config/sessions/transcript.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/transcript.js")>(
    "../../config/sessions/transcript.js",
  );
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
  };
});
vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));
vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: internalHookMocks.createInternalHookEvent,
  triggerInternalHook: internalHookMocks.triggerInternalHook,
}));
vi.mock("./delivery-queue.js", () => ({
  enqueueDelivery: queueMocks.enqueueDelivery,
  ackDelivery: queueMocks.ackDelivery,
  failDelivery: queueMocks.failDelivery,
}));
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => {
    const makeLogger = () => ({
      warn: logMocks.warn,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(() => makeLogger()),
    });
    return makeLogger();
  },
}));

type DeliverModule = typeof import("./deliver.js");

let deliverOutboundPayloads: DeliverModule["deliverOutboundPayloads"];

const telegramCfg: OpenClawConfig = {
  channels: { telegram: { botToken: "tok-1", textChunkLimit: 10_000 } },
};

const emptyRegistry = createTestRegistry([]);
const integrationRegistry = createTestRegistry([
  {
    pluginId: "telegram",
    plugin: createOutboundTestPlugin({ id: "telegram", outbound: telegramOutbound }),
    source: "test",
  },
]);

/**
 * Literal L2392 head sample. Per gateway log
 * `C:/tmp/openclaw/openclaw-2026-05-06.log`:
 *   `[assistant-reply] runId=4407441e lang=en cyr=0
 *    head="ALERT: Vladimir is waiting f..."`
 * This payload reached telegram (audience locale=ru) before NEW-D landed.
 */
const L2392_ALERT_PAYLOAD = "ALERT: Vladimir is waiting for confirmation";

/** Fallback text the locale gate substitutes after blocking the chunk. */
const EMPTY_FALLBACK = "Запрос не удалось выполнить.";

describe("NEW-D Phase 5 — locale-aware sanitizer acceptance (L2392 replay)", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
    setActivePluginRegistry(integrationRegistry);
    mocks.appendAssistantMessageToSessionTranscript.mockClear();
    hookMocks.runner.hasHooks.mockClear();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runMessageSent.mockClear();
    internalHookMocks.createInternalHookEvent.mockClear();
    internalHookMocks.createInternalHookEvent.mockImplementation(createInternalHookEventPayload);
    internalHookMocks.triggerInternalHook.mockClear();
    queueMocks.enqueueDelivery.mockClear();
    queueMocks.enqueueDelivery.mockResolvedValue("mock-queue-id");
    queueMocks.ackDelivery.mockClear();
    queueMocks.failDelivery.mockClear();
    logMocks.warn.mockClear();
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("(1) L2392 regression closed: ALERT-style English on telegram (locale=ru) → fallback + locale_filter telemetry", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m-l2392", chatId: "c-l2392" });
    await deliverOutboundPayloads({
      cfg: telegramCfg,
      channel: "telegram",
      to: "123",
      payloads: [{ text: L2392_ALERT_PAYLOAD }],
      deps: { sendTelegram },
      session: { key: "tg:l2392" },
    });

    // (a) Telegram receives the fallback, NOT the original English ALERT.
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    const sentText = String(sendTelegram.mock.calls[0]?.[1] ?? "");
    expect(sentText).toBe(EMPTY_FALLBACK);
    expect(sentText).not.toContain("ALERT");
    expect(sentText).not.toContain("Vladimir");
    expect(sentText).not.toContain("waiting");

    // (b) Sanitizer telemetry contains the locale_filter line per sub-plan §5.
    const sanitizerLines = logMocks.warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("[outbound-sanitizer]"));
    const localeLine = sanitizerLines.find((line) => line.includes("locale_filter applied"));
    expect(localeLine).toBeDefined();
    expect(localeLine).toContain("locale=en");
    expect(localeLine).toContain("blocked=true");
    expect(localeLine).toContain("reason=no_cyrillic");
    expect(localeLine).toContain("channel=telegram");
  });

  it("(2) Russian content unchanged: 'Готово' on telegram (locale=ru) → verbatim passthrough, no locale telemetry", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m-ru", chatId: "c-ru" });
    await deliverOutboundPayloads({
      cfg: telegramCfg,
      channel: "telegram",
      to: "123",
      payloads: [{ text: "Готово" }],
      deps: { sendTelegram },
      session: { key: "tg:ru" },
    });

    expect(sendTelegram).toHaveBeenCalledTimes(1);
    const sentText = String(sendTelegram.mock.calls[0]?.[1] ?? "");
    // (a) Verbatim — Russian content reaches the channel unchanged.
    expect(sentText).toBe("Готово");

    // (b) Zero sanitizer telemetry — neither locale_filter nor any of the 16
    // diagnostic patterns fire on clean Russian text.
    const sanitizerLines = logMocks.warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("[outbound-sanitizer]"));
    expect(sanitizerLines).toHaveLength(0);
  });

  it("(3) diagnostic regression: [planner] line on telegram (locale=ru) → 16-pattern strip fires first, locale gate inert", async () => {
    // Bare `[planner] ...` line: the planner_marker pattern strips it,
    // post-strip text is empty, and the Phase 3 locale gate skips the verdict
    // (sub-plan §3 case (f): «text becomes empty before locale check»).
    // Telemetry shows planner_marker NOT locale_filter — proves ordering.
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m-diag", chatId: "c-diag" });
    await deliverOutboundPayloads({
      cfg: telegramCfg,
      channel: "telegram",
      to: "123",
      payloads: [{ text: "[planner] route=internal step=1 plan_built=true" }],
      deps: { sendTelegram },
      session: { key: "tg:diag" },
    });

    expect(sendTelegram).toHaveBeenCalledTimes(1);
    const sentText = String(sendTelegram.mock.calls[0]?.[1] ?? "");
    // Empty-substituted with the existing fallback (caller path; see
    // `deliver.ts:431` `finalText || EMPTY_AFTER_SANITIZATION_FALLBACK_TEXT`).
    expect(sentText).toBe(EMPTY_FALLBACK);
    expect(sentText).not.toContain("[planner]");

    const sanitizerLines = logMocks.warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("[outbound-sanitizer]"));
    // Exactly one line — the 16-pattern strip event. NO locale_filter line:
    // the gate is inert because the post-strip text is empty.
    expect(sanitizerLines).toHaveLength(1);
    expect(sanitizerLines[0]).toContain("planner_marker");
    expect(sanitizerLines[0]).not.toContain("locale_filter");
    const localeLine = sanitizerLines.find((line) => line.includes("locale_filter applied"));
    expect(localeLine).toBeUndefined();
  });
});
