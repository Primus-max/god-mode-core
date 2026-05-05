/**
 * Slice I Phase 6 — B5 acceptance fixture (replay of 2026-05-04 19:38–19:42
 * Telegram session leak: «Let me check memory for any context about
 * Vladimir's preferences for agents»).
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_reply_sanitizer.plan.md`.
 *
 * Slice I rollback (2026-05-05) — architectural premise change:
 *   PR #162 added 7 `english_meta_*` regexes to strip leading-imperative
 *   English meta-thinking from assistant payloads. Master roadmap §3
 *   ("LLM-mediated, not regex") explicitly preferred the principled (a) path:
 *   the model wraps reasoning in `<thinking>` tags and the existing
 *   `stripThinkingTagsFromText` extraction-path strip in
 *   `src/agents/pi-embedded-utils.ts:280` removes them BEFORE the payload
 *   reaches `deliverOutboundPayloads`. The regex layer was the discouraged
 *   (b) path (false-positive on legitimate prose, false-negative on mid-line
 *   leaks); it has been reverted.
 *
 * This fixture now pins the post-rollback contract:
 *
 *   - `channel=telegram` / `channel=slack` (deferred == strip in v1):
 *     payload-text reaching `deliverOutboundPayloads` is already
 *     post-extraction (no `<thinking>` tags); the outbound sanitizer only
 *     applies its 16 diagnostic patterns; legitimate Russian content + code
 *     block content reach the channel verbatim. NO `english_meta_*` strip.
 *   - The `stripThinkingTagsFromText` helper (called inside
 *     `extractAssistantText`) is verified independently to remove
 *     `<thinking>` tag content end-to-end — that is the principled B5
 *     defense.
 *   - `channel=webchat`: deferred to a follow-up. Webchat is not a typed
 *     `OutboundChannel` and does not flow through `deliverOutboundPayloads`;
 *     the structured-wrap path will land when the strip-thinking-tags layer
 *     is moved into the sanitizer module (future slice).
 *
 * Test discipline:
 *   - No `vi.spyOn` on `sanitizeOutboundForExternalChannel` /
 *     `resolveReplySanitizerPolicy` / `stripThinkingTagsFromText` — all cases
 *     use real instances. The `logging/subsystem` module is mocked only to
 *     capture telemetry strings (same pattern as
 *     `deliver.outbound-sanitizer.test.ts`).
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
 * Post-extraction B5 fixture. The model emitted reasoning wrapped in
 * `<thinking>` tags (per Phase 4 prompt hint); the extraction path
 * (`extractAssistantText` → `stripThinkingTagsFromText`) has already removed
 * them before the payload reaches `deliverOutboundPayloads`. The remaining
 * payload should reach the channel verbatim — no `english_meta_*` regex
 * exists in the post-rollback sanitizer.
 */
const B5_POST_EXTRACTION_TEXT = [
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
const B5_CODE_BLOCK_LINE = "Let me run a quick db query first";

describe("deliverOutboundPayloads / B5 replay — telegram (post-rollback: tag-based defense)", () => {
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

  it("delivers post-extraction text verbatim — Russian content + code block reach channel; no english_meta_* strip exists", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "c1" });
    await deliverOutboundPayloads({
      cfg: telegramCfg,
      channel: "telegram",
      to: "123",
      payloads: [{ text: B5_POST_EXTRACTION_TEXT }],
      deps: { sendTelegram },
      session: { key: "tg:b5" },
    });

    expect(sendTelegram).toHaveBeenCalledTimes(1);
    const sentText = String(sendTelegram.mock.calls[0]?.[1] ?? "");

    // (a) Russian content reaches the channel verbatim:
    expect(sentText).toContain(B5_RUSSIAN_REPLY);
    expect(sentText).toContain("Готово.");
    // (b) Code block content untouched (telegram плагин может рендерить
    // markdown fence как HTML <pre><code>; важно что текст внутри сохраняется):
    expect(sentText).toContain(B5_CODE_BLOCK_LINE);
    expect(sentText).toContain("echo done");

    // (c) No `[outbound-sanitizer]` event for english_meta_* — the regex
    // family is gone post-rollback. This fixture also has no diagnostic
    // markers, so no telemetry should fire at all.
    const sanitizerLines = logMocks.warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("[outbound-sanitizer]"));
    expect(sanitizerLines).toHaveLength(0);
    for (const line of sanitizerLines) {
      expect(line).not.toContain("english_meta_");
    }
  });

  it("still strips diagnostic markers (regression: 16 existing patterns byte-identical)", async () => {
    const inputWithDiagnostic = [
      "Привет, Владимир!",
      "[planner] plan_built=true steps=3",
      "Готово.",
    ].join("\n");
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m2", chatId: "c2" });
    await deliverOutboundPayloads({
      cfg: telegramCfg,
      channel: "telegram",
      to: "123",
      payloads: [{ text: inputWithDiagnostic }],
      deps: { sendTelegram },
      session: { key: "tg:diag" },
    });
    const sent = String(sendTelegram.mock.calls[0]?.[1] ?? "");
    expect(sent).toContain("Привет, Владимир!");
    expect(sent).toContain("Готово.");
    expect(sent).not.toContain("[planner]");

    const sanitizerLines = logMocks.warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("[outbound-sanitizer]"));
    expect(sanitizerLines).toHaveLength(1);
    expect(sanitizerLines[0]).toContain("planner_marker");
    expect(sanitizerLines[0]).not.toContain("english_meta_");
  });
});

describe("deliverOutboundPayloads / B5 replay — slack (deferred == strip in v1)", () => {
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

  it("matches telegram behaviour: post-extraction text reaches channel verbatim; no <thinking> wrap injected", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "sl1", channel: "C1" });
    await deliverOutboundPayloads({
      cfg: slackCfg,
      channel: "slack",
      to: "C1",
      payloads: [{ text: B5_POST_EXTRACTION_TEXT }],
      deps: { sendSlack },
      session: { key: "sl:b5" },
    });

    const sentText = String(sendSlack.mock.calls[0]?.[1] ?? "");
    // Russian content + code block preserved:
    expect(sentText).toContain(B5_RUSSIAN_REPLY);
    expect(sentText).toContain(B5_CODE_BLOCK_LINE);
    // No <thinking> wrap injected on slack (structured branch is a no-op
    // post-rollback; future slice will move strip-thinking-tags into the
    // sanitizer module to enable wrap):
    expect(sentText).not.toContain("<thinking");

    const sanitizerLines = logMocks.warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("[outbound-sanitizer]"));
    expect(sanitizerLines).toHaveLength(0);
    for (const line of sanitizerLines) {
      expect(line).not.toContain("english_meta_");
    }
  });
});

describe("B5 defense — extraction-path stripThinkingTagsFromText (principled path)", () => {
  // The principled B5 defense per master roadmap §3: the model wraps reasoning
  // in `<thinking>` tags (Phase 4 prompt hint), and `stripThinkingTagsFromText`
  // (called by `extractAssistantText` in `pi-embedded-utils.ts`) removes them
  // BEFORE the payload reaches `deliverOutboundPayloads`. Verify the helper
  // does what the architecture relies on.

  it("strips a leading <thinking>…</thinking> reasoning block, preserving the user-facing reply", async () => {
    const { stripThinkingTagsFromText } = await import(
      "../../agents/pi-embedded-utils.js"
    );
    const modelOutput = [
      "<thinking>",
      "Let me check memory for any context about Vladimir's preferences.",
      "</thinking>",
      "",
      "Привет, Владимир! Вот что я нашёл в логах.",
    ].join("\n");
    const stripped = stripThinkingTagsFromText(modelOutput);
    expect(stripped).not.toContain("<thinking");
    expect(stripped).not.toContain("</thinking>");
    expect(stripped).not.toContain(
      "Let me check memory for any context about Vladimir's preferences.",
    );
    expect(stripped).toContain("Привет, Владимир! Вот что я нашёл в логах.");
  });

  it("strips an inline <think>…</think> block (alternate tag form)", async () => {
    const { stripThinkingTagsFromText } = await import(
      "../../agents/pi-embedded-utils.js"
    );
    const modelOutput =
      "<think>I should verify this before responding.</think>\n\nГотово.";
    const stripped = stripThinkingTagsFromText(modelOutput);
    expect(stripped).not.toContain("<think");
    expect(stripped).not.toContain("</think");
    expect(stripped).not.toContain("I should verify this before responding.");
    expect(stripped).toContain("Готово.");
  });
});
