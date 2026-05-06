import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  signalOutbound,
  slackOutbound,
  telegramOutbound,
  whatsappOutbound,
} from "../../../test/channel-outbounds.js";
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
const whatsappCfg: OpenClawConfig = { channels: { whatsapp: { textChunkLimit: 10_000 } } };
const slackCfg: OpenClawConfig = { channels: { slack: {} as never } };
const signalCfg: OpenClawConfig = { channels: { signal: {} as never } };

const emptyRegistry = createTestRegistry([]);
const integrationRegistry = createTestRegistry([
  {
    pluginId: "telegram",
    plugin: createOutboundTestPlugin({ id: "telegram", outbound: telegramOutbound }),
    source: "test",
  },
  {
    pluginId: "signal",
    plugin: createOutboundTestPlugin({ id: "signal", outbound: signalOutbound }),
    source: "test",
  },
  {
    pluginId: "whatsapp",
    plugin: createOutboundTestPlugin({ id: "whatsapp", outbound: whatsappOutbound }),
    source: "test",
  },
  {
    pluginId: "slack",
    plugin: createOutboundTestPlugin({ id: "slack", outbound: slackOutbound }),
    source: "test",
  },
]);

describe("deliverOutboundPayloads / outbound sanitizer integration", () => {
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

  it("strips [tools] failed marker on telegram and emits sanitizer telemetry", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "c1" });
    await deliverOutboundPayloads({
      cfg: telegramCfg,
      channel: "telegram",
      to: "123",
      payloads: [
        {
          text: "Не удалось.\n[tools] cron failed: Reminder scheduling cannot target another session.\nПопробуй ещё раз.",
        },
      ],
      deps: { sendTelegram },
      session: { key: "tg:42" },
    });

    expect(sendTelegram).toHaveBeenCalledTimes(1);
    const sentText = sendTelegram.mock.calls[0]?.[1];
    expect(sentText).toContain("Не удалось.");
    expect(sentText).toContain("Попробуй ещё раз.");
    expect(sentText).not.toContain("[tools]");
    const telemetry = logMocks.warn.mock.calls.map((call) => String(call[0]));
    const sanitizerLines = telemetry.filter((line) => line.startsWith("[outbound-sanitizer]"));
    expect(sanitizerLines).toHaveLength(1);
    expect(sanitizerLines[0]).toContain("channel=telegram");
    expect(sanitizerLines[0]).toContain("session=tg:42");
    expect(sanitizerLines[0]).toContain("tool_error_marker");
  });

  it("replaces tool-error JSON envelope on whatsapp and runs after HTML strip", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });
    await deliverOutboundPayloads({
      cfg: whatsappCfg,
      channel: "whatsapp",
      to: "+1555",
      payloads: [
        {
          text: '<b>Search</b> result: {"status":"error","tool":"web_search","error":"DuckDuckGo returned a bot-detection challenge."}',
        },
      ],
      deps: { sendWhatsApp },
    });

    expect(sendWhatsApp).toHaveBeenCalledTimes(1);
    const sentText = sendWhatsApp.mock.calls[0]?.[1];
    expect(sentText).not.toContain("<b>");
    expect(sentText).not.toContain('"status":"error"');
    expect(sentText).toContain("(внутренняя ошибка инструмента; обработана)");
  });

  it("substitutes fallback text when payload becomes empty after sanitization", async () => {
    const sendSignal = vi.fn().mockResolvedValue({ messageId: "s1" });
    await deliverOutboundPayloads({
      cfg: signalCfg,
      channel: "signal",
      to: "+1555",
      payloads: [
        {
          text: "[tools] cron failed: x\n[task-classifier] decision=internal\n[planner] step=1",
        },
      ],
      deps: { sendSignal },
    });

    expect(sendSignal).toHaveBeenCalledTimes(1);
    const sentText = sendSignal.mock.calls[0]?.[1];
    expect(sentText).toBe("Запрос не удалось выполнить.");
  });

  it("does not modify clean text on slack and emits no sanitizer telemetry", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "sl1", channel: "C1" });
    await deliverOutboundPayloads({
      cfg: slackCfg,
      channel: "slack",
      to: "C1",
      payloads: [{ text: "Привет! Всё ок, никаких маркеров." }],
      deps: { sendSlack },
    });

    expect(sendSlack).toHaveBeenCalledTimes(1);
    const sentText = sendSlack.mock.calls[0]?.[1];
    expect(sentText).toBe("Привет! Всё ок, никаких маркеров.");
    const sanitizerLines = logMocks.warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("[outbound-sanitizer]"));
    expect(sanitizerLines).toHaveLength(0);
  });

  it("scrubs both classifier and planner markers in a single pass", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m2", chatId: "c2" });
    await deliverOutboundPayloads({
      cfg: telegramCfg,
      channel: "telegram",
      to: "123",
      payloads: [
        {
          text: "Готово.\n[task-classifier] decision=internal\n[planner] step=42\nДеталей не будет.",
        },
      ],
      deps: { sendTelegram },
      session: { key: "tg:multi" },
    });

    const sentText = sendTelegram.mock.calls[0]?.[1];
    expect(sentText).toContain("Готово.");
    expect(sentText).toContain("Деталей не будет.");
    expect(sentText).not.toContain("[task-classifier]");
    expect(sentText).not.toContain("[planner]");
    const sanitizerLine = logMocks.warn.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.startsWith("[outbound-sanitizer]"));
    expect(sanitizerLine).toBeDefined();
    expect(sanitizerLine).toContain("task_classifier_marker");
    expect(sanitizerLine).toContain("planner_marker");
  });

  it("preserves replyToId/threadId metadata while sanitizing payload text", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m3", chatId: "c3" });
    await deliverOutboundPayloads({
      cfg: telegramCfg,
      channel: "telegram",
      to: "123",
      payloads: [
        {
          text: "OK.\n[DEBUG agent.run] elapsed=42ms",
          replyToId: "555",
        },
      ],
      deps: { sendTelegram },
    });

    expect(sendTelegram).toHaveBeenCalledTimes(1);
    const sentText = sendTelegram.mock.calls[0]?.[1];
    expect(sentText).toContain("OK.");
    expect(sentText).not.toContain("[DEBUG");
    const overrides = sendTelegram.mock.calls[0]?.[2];
    expect(overrides).toEqual(expect.objectContaining({ replyToMessageId: 555 }));
  });

  // NEW-D Phase 4 — locale gate wired through deliver.ts. Sub-plan:
  // `.cursor/plans/commitment_kernel_locale_aware_sanitizer.plan.md` §5 / phase
  // 4 todo. Live evidence L2392 in
  // `C:/tmp/openclaw/openclaw-2026-05-06.log` —
  // `[assistant-reply] runId=4407441e lang=en cyr=0 head="ALERT: Vladimir is
  // waiting f..."` reached telegram (audience locale=ru). The four cases
  // below close the regression and lock in backward-compat for channels
  // without an entry in `CHANNEL_LOCALE_DEFAULTS`.

  it(
    "blocks ALERT-style English payload on telegram (locale=ru) and emits locale_filter telemetry",
    async () => {
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m4", chatId: "c4" });
      await deliverOutboundPayloads({
        cfg: telegramCfg,
        channel: "telegram",
        to: "123",
        payloads: [
          {
            text: "ALERT: Vladimir is waiting for confirmation",
          },
        ],
        deps: { sendTelegram },
        session: { key: "tg:alert" },
      });

      expect(sendTelegram).toHaveBeenCalledTimes(1);
      const sentText = sendTelegram.mock.calls[0]?.[1];
      // Empty-substituted with the existing fallback (block path).
      expect(sentText).toBe("Запрос не удалось выполнить.");
      const sanitizerLines = logMocks.warn.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith("[outbound-sanitizer]"));
      // Locale-filter telemetry must appear (separate from the existing
      // `event=stripped` line). Shape per sub-plan §5.
      const localeLine = sanitizerLines.find((line) => line.includes("locale_filter applied"));
      expect(localeLine).toBeDefined();
      expect(localeLine).toContain("locale=en");
      expect(localeLine).toContain("blocked=true");
      expect(localeLine).toContain("reason=no_cyrillic");
      expect(localeLine).toContain("channel=telegram");
    },
  );

  it("does not modify Russian payload on telegram (locale=ru) and emits no locale telemetry", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m5", chatId: "c5" });
    await deliverOutboundPayloads({
      cfg: telegramCfg,
      channel: "telegram",
      to: "123",
      payloads: [{ text: "Готово, всё выполнено успешно." }],
      deps: { sendTelegram },
    });

    expect(sendTelegram).toHaveBeenCalledTimes(1);
    const sentText = sendTelegram.mock.calls[0]?.[1];
    expect(sentText).toBe("Готово, всё выполнено успешно.");
    const sanitizerLines = logMocks.warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("[outbound-sanitizer]"));
    expect(sanitizerLines).toHaveLength(0);
  });

  it("does not enforce locale on slack (no entry in CHANNEL_LOCALE_DEFAULTS) for Russian payload", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "sl2", channel: "C2" });
    await deliverOutboundPayloads({
      cfg: slackCfg,
      channel: "slack",
      to: "C2",
      payloads: [{ text: "Готово, всё выполнено успешно." }],
      deps: { sendSlack },
    });

    expect(sendSlack).toHaveBeenCalledTimes(1);
    const sentText = sendSlack.mock.calls[0]?.[1];
    // Slack absent from CHANNEL_LOCALE_DEFAULTS v1 → policy.localeFilter
    // undefined → Phase 3 branch skipped → byte-identical passthrough.
    expect(sentText).toBe("Готово, всё выполнено успешно.");
    const sanitizerLines = logMocks.warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("[outbound-sanitizer]"));
    expect(sanitizerLines).toHaveLength(0);
  });

  it("preserves pre-Phase-4 behavior on signal (no locale default) for English payload", async () => {
    // Regression: signal is in REPLY_SANITIZER_SURFACES (sanitizer runs) but
    // NOT in CHANNEL_LOCALE_DEFAULTS (no locale gate). English text without
    // any diagnostic markers must pass byte-identical, with no locale
    // telemetry — pre-Phase-4 behavior preserved.
    const sendSignal = vi.fn().mockResolvedValue({ messageId: "sg1" });
    await deliverOutboundPayloads({
      cfg: signalCfg,
      channel: "signal",
      to: "+1555",
      payloads: [{ text: "Hello, this is a clean English reply with no markers." }],
      deps: { sendSignal },
    });

    expect(sendSignal).toHaveBeenCalledTimes(1);
    const sentText = sendSignal.mock.calls[0]?.[1];
    expect(sentText).toBe("Hello, this is a clean English reply with no markers.");
    const sanitizerLines = logMocks.warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("[outbound-sanitizer]"));
    expect(sanitizerLines).toHaveLength(0);
  });
});
