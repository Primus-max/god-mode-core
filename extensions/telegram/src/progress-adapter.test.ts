import { describe, it, expect, vi } from "vitest";
import { ProgressBus, type ProgressFrame } from "openclaw/plugin-sdk/progress";
import {
  createTelegramProgressAdapter,
  isTelegramProgressEnabled,
  type TelegramProgressBotApi,
} from "./progress-adapter.js";

function makeFrame(overrides: Partial<ProgressFrame> = {}): ProgressFrame {
  return {
    sessionId: "s1",
    channelId: "telegram",
    turnId: "t1",
    seq: 1,
    phase: "classifying",
    ts: 1000,
    ...overrides,
  };
}

describe("isTelegramProgressEnabled", () => {
  it("defaults to enabled when env var is unset", () => {
    expect(isTelegramProgressEnabled({})).toBe(true);
    expect(isTelegramProgressEnabled({ OPENCLAW_PROGRESS_TELEGRAM: "" })).toBe(true);
    expect(isTelegramProgressEnabled({ OPENCLAW_PROGRESS_TELEGRAM: "1" })).toBe(true);
    expect(isTelegramProgressEnabled({ OPENCLAW_PROGRESS_TELEGRAM: "true" })).toBe(true);
  });

  it("is disabled when env var is 0/false/off", () => {
    expect(isTelegramProgressEnabled({ OPENCLAW_PROGRESS_TELEGRAM: "0" })).toBe(false);
    expect(isTelegramProgressEnabled({ OPENCLAW_PROGRESS_TELEGRAM: "false" })).toBe(false);
    expect(isTelegramProgressEnabled({ OPENCLAW_PROGRESS_TELEGRAM: "off" })).toBe(false);
    expect(isTelegramProgressEnabled({ OPENCLAW_PROGRESS_TELEGRAM: "no" })).toBe(false);
    expect(isTelegramProgressEnabled({ OPENCLAW_PROGRESS_TELEGRAM: "OFF" })).toBe(false);
  });
});

describe("createTelegramProgressAdapter", () => {
  it("is a no-op when disabled via feature flag", () => {
    const bus = new ProgressBus();
    const sendMessage = vi.fn(async () => ({ message_id: 10 }));
    const api: TelegramProgressBotApi = { sendMessage };
    const handle = createTelegramProgressAdapter({
      bus,
      env: { OPENCLAW_PROGRESS_TELEGRAM: "0" },
      getApi: () => api,
      resolveTarget: () => ({ chatId: 123 }),
    });
    expect(handle.enabled).toBe(false);
    bus.publish(makeFrame());
    expect(sendMessage).not.toHaveBeenCalled();
    handle.unsubscribe();
  });

  it("sends initial status via sendMessage and then edits it", async () => {
    const bus = new ProgressBus();
    const sendMessage = vi.fn(async () => ({ message_id: 77 }));
    const editMessageText = vi.fn(async () => undefined);
    const api: TelegramProgressBotApi = { sendMessage, editMessageText };
    let clock = 1000;
    const handle = createTelegramProgressAdapter({
      bus,
      env: {},
      getApi: () => api,
      resolveTarget: () => ({ chatId: 42, messageThreadId: 7 }),
      now: () => clock,
    });

    bus.publish(makeFrame({ phase: "classifying", seq: 1, ts: clock }));
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith(
      42,
      expect.stringContaining("classifying"),
      expect.objectContaining({ message_thread_id: 7, disable_notification: true }),
    );

    clock += 500;
    bus.publish(makeFrame({ phase: "tool_call", seq: 2, ts: clock, detail: "shell" }));
    await vi.waitFor(() => expect(editMessageText).toHaveBeenCalledTimes(1));
    expect(editMessageText).toHaveBeenCalledWith(
      42,
      77,
      expect.stringContaining("tool call"),
    );

    clock += 500;
    bus.publish(makeFrame({ phase: "done", seq: 3, ts: clock }));
    await vi.waitFor(() => expect(editMessageText).toHaveBeenCalledTimes(2));
    expect(editMessageText).toHaveBeenLastCalledWith(42, 77, expect.stringContaining("done"));

    handle.unsubscribe();
  });

  it("falls back to sendMessage when editMessageText is unavailable", async () => {
    const bus = new ProgressBus();
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ message_id: 11 })
      .mockResolvedValueOnce({ message_id: 12 });
    const api: TelegramProgressBotApi = { sendMessage };
    const handle = createTelegramProgressAdapter({
      bus,
      env: {},
      getApi: () => api,
      resolveTarget: () => ({ chatId: 55 }),
      now: () => 1000,
    });
    bus.publish(makeFrame({ phase: "classifying", seq: 1, ts: 1000 }));
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    bus.publish(makeFrame({ phase: "done", seq: 2, ts: 2000 }));
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    handle.unsubscribe();
  });

  it("skips broadcasts when resolveTarget returns null", async () => {
    const bus = new ProgressBus();
    const sendMessage = vi.fn(async () => ({ message_id: 1 }));
    const api: TelegramProgressBotApi = { sendMessage };
    const handle = createTelegramProgressAdapter({
      bus,
      env: {},
      getApi: () => api,
      resolveTarget: () => null,
    });
    bus.publish(makeFrame());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sendMessage).not.toHaveBeenCalled();
    handle.unsubscribe();
  });

  it("unsubscribing stops further deliveries", async () => {
    const bus = new ProgressBus();
    const sendMessage = vi.fn(async () => ({ message_id: 42 }));
    const editMessageText = vi.fn(async () => undefined);
    const handle = createTelegramProgressAdapter({
      bus,
      env: {},
      getApi: () => ({ sendMessage, editMessageText }),
      resolveTarget: () => ({ chatId: 1 }),
      now: () => 1000,
    });
    handle.unsubscribe();
    bus.publish(makeFrame({ phase: "classifying", ts: 1000 }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(editMessageText).not.toHaveBeenCalled();
  });
});
