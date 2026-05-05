/**
 * Slice I Phase 6 — B5 acceptance fixture (replay of 2026-05-04 19:38–19:42
 * Telegram session leak: «Let me check memory for any context about
 * Vladimir's preferences for agents»).
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_reply_sanitizer.plan.md` (todo
 * `i-phase-6-acceptance-fixture`). This fixture pins the channel-keyed
 * sanitizer behaviour end-to-end:
 *
 *   - `channel=telegram` → English meta-text outside fenced code is STRIPPED;
 *     code-block content untouched; Russian content reaches the channel
 *     verbatim; `[outbound-sanitizer]` log records `english_meta_*` events.
 *   - `channel=slack`    → behaves like telegram in v1 (deferred policy ==
 *     strip until the slack adapter implements a sidebar).
 *   - `channel=webchat`  → English meta-text WRAPPED in
 *     `<thinking lang="en">…</thinking>` (JSON-tagged: `lang` attribute,
 *     content escaped if it contains `<`/`>`); code-block content untouched.
 *     Webchat is the `INTERNAL_MESSAGE_CHANNEL`; it does not flow through
 *     `deliverOutboundPayloads` (typed `OutboundChannel = DeliverableMessageChannel
 *     | "none"` excludes it), so the webchat assertion exercises the
 *     policy-aware sanitizer directly with `resolveReplySanitizerPolicy("webchat")`.
 *     The wiring at `deliver.ts:404` MUST still gate on `isReplySanitizerSurface(channel)`
 *     so that any future call site that does pass `webchat` hits the structured path.
 *
 * Test discipline:
 *   - Fail-first: every assertion below MUST fail against the current Phase-3
 *     `dev` HEAD. The B5 leak text matches `english_meta_let_me`, but on dev
 *     HEAD `deliverOutboundPayloads` ALSO strips it on telegram/slack — that
 *     part will pass even pre-impl. The fixture's webchat assertion (structured
 *     wrap) is the load-bearing fail-first probe; it fails because no code
 *     path on dev HEAD wraps in `<thinking lang="en">…</thinking>`.
 *   - No `vi.spyOn` on `sanitizeOutboundForExternalChannel` /
 *     `resolveReplySanitizerPolicy`. The deliver path uses real instances; the
 *     `logging/subsystem` module is mocked only to capture telemetry strings
 *     (same pattern as `deliver.outbound-sanitizer.test.ts`).
 *   - Stress test: a single turn with ≥3 of (Russian prose, English meta
 *     leading sentence, fenced code, inline code, quoted English starting
 *     with «Let me»). See "stress fixture" `it` below.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  slackOutbound,
  telegramOutbound,
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
const slackCfg: OpenClawConfig = { channels: { slack: {} as never } };

const emptyRegistry = createTestRegistry([]);
const integrationRegistry = createTestRegistry([
  {
    pluginId: "telegram",
    plugin: createOutboundTestPlugin({ id: "telegram", outbound: telegramOutbound }),
    source: "test",
  },
  {
    pluginId: "slack",
    plugin: createOutboundTestPlugin({ id: "slack", outbound: slackOutbound }),
    source: "test",
  },
]);

/**
 * The B5 fixture payload. Constructed per sub-plan §0 todo i-phase-6:
 *   - mixed Russian content (the user-facing reply)
 *   - English meta-text leading sentence (the leak)
 *   - a fenced ```bash``` code block whose first line happens to start with
 *     «Let me run …» (false-positive trap: this MUST survive untouched).
 */
const B5_FIXTURE_TEXT = [
  "Let me check memory for any context about Vladimir's preferences.",
  "",
  "Привет, Владимир! Вот что я нашёл в логах.",
  "",
  "Пример скрипта проверки:",
  "```bash",
  "Let me run a quick db query first",
  "echo done",
  "```",
  "",
  "Готово.",
].join("\n");

const B5_RUSSIAN_REPLY = "Привет, Владимир! Вот что я нашёл в логах.";
const B5_LEAK_LINE = "Let me check memory for any context about Vladimir's preferences.";
const B5_CODE_BLOCK_LINE = "Let me run a quick db query first";

describe("deliverOutboundPayloads / B5 replay — telegram strip", () => {
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

  it("strips English meta-text outside code block, preserves Russian content + code block, fires telemetry", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "c1" });
    await deliverOutboundPayloads({
      cfg: telegramCfg,
      channel: "telegram",
      to: "123",
      payloads: [{ text: B5_FIXTURE_TEXT }],
      deps: { sendTelegram },
      session: { key: "tg:b5" },
    });

    expect(sendTelegram).toHaveBeenCalledTimes(1);
    const sentText = String(sendTelegram.mock.calls[0]?.[1] ?? "");

    // (a) Russian content reaches the channel verbatim:
    expect(sentText).toContain(B5_RUSSIAN_REPLY);
    expect(sentText).toContain("Готово.");
    // (b) English meta-text outside the code block is stripped:
    expect(sentText).not.toContain(B5_LEAK_LINE);
    // (c) Code block CONTENT untouched (telegram плагин может рендерить
    // markdown fence как HTML <pre><code>; важно что текст внутри сохраняется):
    expect(sentText).toContain(B5_CODE_BLOCK_LINE);
    expect(sentText).toContain("echo done");

    // (d) [outbound-sanitizer] log records english_meta_let_me*1:
    const sanitizerLines = logMocks.warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("[outbound-sanitizer]"));
    expect(sanitizerLines).toHaveLength(1);
    const line = sanitizerLines[0] ?? "";
    expect(line).toContain("event=stripped");
    expect(line).toContain("channel=telegram");
    expect(line).toContain("english_meta_let_me");
    expect(line).toContain("session=tg:b5");
  });

  it("[stress] mixed Russian + English meta + fenced code + inline code + quoted English", async () => {
    // Sub-plan §5 Phase 6: ≥3 of (Russian prose, English meta leading sentence,
    // fenced code, inline code, quoted English starting with «Let me»).
    const stressFixture = [
      "I'll search the registry first.", // english_meta_ill leak (line 1)
      "",
      "Привет! Вот что нашёл.", // Russian prose
      "",
      "Looking at logs around 19:38 — найдено совпадение.", // english_meta_looking_at leak (mid-paragraph: leading on its line)
      "",
      "Пример с inline кодом: `Let me check this` — внутри code span, не должно тронуть.", // inline code: protected
      "",
      "```python", // fenced code
      "Let me check the schema",
      "print('ok')",
      "```",
      "",
      'Цитирую коллегу: "Let me know later" — это не meta-thinking.', // quoted; not in verb whitelist
      "",
      "Конец.",
    ].join("\n");

    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m2", chatId: "c2" });
    await deliverOutboundPayloads({
      cfg: telegramCfg,
      channel: "telegram",
      to: "123",
      payloads: [{ text: stressFixture }],
      deps: { sendTelegram },
      session: { key: "tg:stress" },
    });
    const sent = String(sendTelegram.mock.calls[0]?.[1] ?? "");

    // Russian prose reaches verbatim:
    expect(sent).toContain("Привет! Вот что нашёл.");
    expect(sent).toContain("Конец.");
    // Outside-of-code English meta leaks stripped:
    expect(sent).not.toContain("I'll search the registry first.");
    expect(sent).not.toContain("Looking at logs around 19:38");
    // Inside fenced code: leak preserved verbatim:
    expect(sent).toContain("Let me check the schema");
    // Inside inline code: leak content preserved (плагин может обернуть
    // в <code>…</code> при HTML-рендере; смысл — текст не вырезан):
    expect(sent).toContain("Let me check this");
    // Quoted English not in verb whitelist: preserved (Let me know):
    expect(sent).toContain("Let me know later");

    // Telemetry: at least 2 english_meta_* events fired (ill + looking_at):
    const line = (logMocks.warn.mock.calls
      .map((call) => String(call[0]))
      .find((s) => s.startsWith("[outbound-sanitizer]")) ?? "");
    expect(line).toContain("english_meta_ill");
    expect(line).toContain("english_meta_looking_at");
  });
});

describe("deliverOutboundPayloads / B5 replay — slack deferred (== strip in v1)", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
    setActivePluginRegistry(integrationRegistry);
    logMocks.warn.mockClear();
    queueMocks.enqueueDelivery.mockClear();
    queueMocks.enqueueDelivery.mockResolvedValue("mock-queue-id");
    internalHookMocks.createInternalHookEvent.mockClear();
    internalHookMocks.createInternalHookEvent.mockImplementation(createInternalHookEventPayload);
  });
  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("matches telegram strip behaviour: leak gone, Russian + code preserved, telemetry fired", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "sl1", channel: "C1" });
    await deliverOutboundPayloads({
      cfg: slackCfg,
      channel: "slack",
      to: "C1",
      payloads: [{ text: B5_FIXTURE_TEXT }],
      deps: { sendSlack },
      session: { key: "sl:b5" },
    });

    const sentText = String(sendSlack.mock.calls[0]?.[1] ?? "");
    // Russian content + code block preserved:
    expect(sentText).toContain(B5_RUSSIAN_REPLY);
    expect(sentText).toContain(B5_CODE_BLOCK_LINE);
    // English meta leak stripped (deferred == strip in v1):
    expect(sentText).not.toContain(B5_LEAK_LINE);
    // No <thinking> wrap injected on slack:
    expect(sentText).not.toContain("<thinking");

    const sanitizerLines = logMocks.warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("[outbound-sanitizer]"));
    expect(sanitizerLines).toHaveLength(1);
    expect(sanitizerLines[0]).toContain("channel=slack");
    expect(sanitizerLines[0]).toContain("english_meta_let_me");
  });
});

describe("sanitizer / B5 replay — webchat structured wrap (sanitizer-direct)", () => {
  // Webchat is INTERNAL_MESSAGE_CHANNEL and is NOT a typed `OutboundChannel`,
  // so it does not flow through `deliverOutboundPayloads`. The slice spec
  // requires the sanitizer to wrap english_meta_* leaks in
  // `<thinking lang="en">…</thinking>` for the webchat policy. Exercise the
  // policy-aware sanitizer directly with the resolved policy.
  it("wraps English meta-text in <thinking lang=\"en\">…</thinking>; preserves Russian + code block", async () => {
    const { sanitizeOutboundForExternalChannel } = await import("./outbound-sanitizer.js");
    const { resolveReplySanitizerPolicy } = await import("./reply-sanitizer-policy.js");
    const policy = resolveReplySanitizerPolicy("webchat");
    expect(policy.reasoning).toBe("structured");

    const result = sanitizeOutboundForExternalChannel(B5_FIXTURE_TEXT, policy);

    // (a) Russian content survives verbatim:
    expect(result.text).toContain(B5_RUSSIAN_REPLY);
    expect(result.text).toContain("Готово.");
    // (b) English meta-text wrapped (NOT stripped):
    expect(result.text).toContain('<thinking lang="en">');
    expect(result.text).toContain("</thinking>");
    expect(result.text).toContain(B5_LEAK_LINE);
    // The wrap must contain the leak line as its inner content:
    expect(result.text).toMatch(
      /<thinking lang="en">Let me check memory for any context about Vladimir's preferences\.<\/thinking>/u,
    );
    // (c) Code block content untouched:
    expect(result.text).toContain("```bash");
    expect(result.text).toContain(B5_CODE_BLOCK_LINE);
    expect(result.text).toContain("echo done");

    // The leak inside the code block was NOT wrapped (only one wrap injected,
    // for the leading line outside the fence):
    const wrapCount = (result.text.match(/<thinking lang="en">/g) ?? []).length;
    expect(wrapCount).toBe(1);

    // Telemetry still fires — pattern matched, just rendered as wrap:
    const event = result.stripped.find((e) => e.patternId === "english_meta_let_me");
    expect(event?.count).toBe(1);
  });

  it("isReplySanitizerSurface(\"webchat\") === true — wiring gate accepts webchat", async () => {
    // Reverse-test on the deliver-side gate. Phase 5 expands the gate from
    // `isExternalDeliverySurface` (no webchat) to `isReplySanitizerSurface`
    // (yes webchat). The deliver pipeline does not deliver to webchat today,
    // but the gate must still admit it so that any future caller routing
    // through deliver-equivalent pathways will hit the structured branch.
    const { isReplySanitizerSurface } = await import("./reply-sanitizer-policy.js");
    expect(isReplySanitizerSurface("webchat")).toBe(true);
    expect(isReplySanitizerSurface("telegram")).toBe(true);
    expect(isReplySanitizerSurface("slack")).toBe(true);
    expect(isReplySanitizerSurface("unknown_channel_xyz")).toBe(false);
  });
});
