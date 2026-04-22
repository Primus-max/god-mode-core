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

type FakeTimers = {
  schedule: (cb: () => void, ms: number) => number;
  clear: (handle: unknown) => void;
  advance: (ms: number) => void;
  pendingCount: () => number;
};

function makeFakeTimers(initialClock: { value: number }): FakeTimers {
  let nextId = 1;
  const timers = new Map<number, { fireAt: number; cb: () => void }>();
  return {
    schedule(cb, ms) {
      const id = nextId++;
      timers.set(id, { fireAt: initialClock.value + Math.max(0, ms), cb });
      return id;
    },
    clear(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      initialClock.value += ms;
      const due = [...timers.entries()]
        .filter(([, t]) => t.fireAt <= initialClock.value)
        .sort((a, b) => a[1].fireAt - b[1].fireAt);
      for (const [id, t] of due) {
        timers.delete(id);
        t.cb();
      }
    },
    pendingCount() {
      return timers.size;
    },
  };
}

function makeLoggerSpy() {
  const info = vi.fn();
  const warn = vi.fn();
  return {
    logger: { info, warn },
    info,
    warn,
    infoMessages: () => info.mock.calls.map((c) => String(c[0])),
    warnMessages: () => warn.mock.calls.map((c) => String(c[0])),
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
    const clock = { value: 1000 };
    const timers = makeFakeTimers(clock);
    const { logger, infoMessages } = makeLoggerSpy();
    const handle = createTelegramProgressAdapter({
      bus,
      env: {},
      getApi: () => api,
      resolveTarget: () => ({ chatId: 42, messageThreadId: 7 }),
      now: () => clock.value,
      scheduleTimer: timers.schedule,
      clearTimer: timers.clear,
      logger,
    });

    bus.publish(makeFrame({ phase: "classifying", seq: 1, ts: clock.value }));
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith(
      42,
      expect.stringContaining("classifying"),
      expect.objectContaining({ message_thread_id: 7, disable_notification: true }),
    );

    clock.value += 500;
    bus.publish(makeFrame({ phase: "tool_call", seq: 2, ts: clock.value, detail: "shell" }));
    await vi.waitFor(() => expect(editMessageText).toHaveBeenCalledTimes(1));
    expect(editMessageText).toHaveBeenCalledWith(42, 77, expect.stringContaining("tool call"));

    clock.value += 500;
    bus.publish(makeFrame({ phase: "done", seq: 3, ts: clock.value }));
    await vi.waitFor(() => expect(editMessageText).toHaveBeenCalledTimes(2));
    expect(editMessageText).toHaveBeenLastCalledWith(42, 77, expect.stringContaining("done"));

    expect(infoMessages().some((m) => m.includes("[tg-progress] sent=1") && m.includes("reason=send_ok"))).toBe(true);
    expect(infoMessages().some((m) => m.includes("edited=1") && m.includes("reason=edit_ok"))).toBe(true);

    handle.unsubscribe();
  });

  it("send -> edit -> edit emits exactly one send and two edits across full phase chain", async () => {
    const bus = new ProgressBus();
    const sendMessage = vi.fn(async () => ({ message_id: 100 }));
    const editMessageText = vi.fn(async () => undefined);
    const api: TelegramProgressBotApi = { sendMessage, editMessageText };
    const clock = { value: 0 };
    const timers = makeFakeTimers(clock);
    const { logger } = makeLoggerSpy();
    const handle = createTelegramProgressAdapter({
      bus,
      env: {},
      getApi: () => api,
      resolveTarget: () => ({ chatId: 999 }),
      now: () => clock.value,
      scheduleTimer: timers.schedule,
      clearTimer: timers.clear,
      logger,
    });

    bus.publish(makeFrame({ phase: "classifying", seq: 1, ts: 0 }));
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    clock.value = 500;
    bus.publish(makeFrame({ phase: "planning", seq: 2, ts: 500 }));
    await vi.waitFor(() => expect(editMessageText).toHaveBeenCalledTimes(1));
    expect(editMessageText.mock.calls[0]?.[2]).toContain("planning");

    clock.value = 1000;
    bus.publish(makeFrame({ phase: "tool_call", seq: 3, ts: 1000, detail: "exec" }));
    await vi.waitFor(() => expect(editMessageText).toHaveBeenCalledTimes(2));
    expect(editMessageText.mock.calls[1]?.[2]).toContain("tool call");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(editMessageText).toHaveBeenCalledTimes(2);

    handle.unsubscribe();
  });

  it("throttles edits within MIN_EDIT_GAP_MS and drains the latest queued frame after the gap", async () => {
    const bus = new ProgressBus();
    const sendMessage = vi.fn(async () => ({ message_id: 555 }));
    const editMessageText = vi.fn(async () => undefined);
    const api: TelegramProgressBotApi = { sendMessage, editMessageText };
    const clock = { value: 1000 };
    const timers = makeFakeTimers(clock);
    const { logger, infoMessages } = makeLoggerSpy();
    const handle = createTelegramProgressAdapter({
      bus,
      env: {},
      getApi: () => api,
      resolveTarget: () => ({ chatId: 1 }),
      now: () => clock.value,
      scheduleTimer: timers.schedule,
      clearTimer: timers.clear,
      logger,
    });

    bus.publish(makeFrame({ phase: "classifying", seq: 1, ts: 1000 }));
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    clock.value = 1010;
    bus.publish(makeFrame({ phase: "planning", seq: 2, ts: 1010 }));
    await vi.waitFor(() =>
      expect(infoMessages().some((m) => m.includes("reason=throttled"))).toBe(true),
    );
    expect(editMessageText).not.toHaveBeenCalled();

    clock.value = 1050;
    bus.publish(makeFrame({ phase: "preflight", seq: 3, ts: 1050 }));

    timers.advance(200);
    await vi.waitFor(() => expect(editMessageText).toHaveBeenCalledTimes(1));
    expect(editMessageText.mock.calls[0]?.[2]).toContain("preflight");

    handle.unsubscribe();
  });

  it("falls back to sendMessage when editMessageText rejects", async () => {
    const bus = new ProgressBus();
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ message_id: 11 })
      .mockResolvedValueOnce({ message_id: 12 });
    const editMessageText = vi.fn(async () => {
      throw new Error("Bad Request: chat not found");
    });
    const api: TelegramProgressBotApi = { sendMessage, editMessageText };
    const clock = { value: 0 };
    const timers = makeFakeTimers(clock);
    const { logger, warnMessages, infoMessages } = makeLoggerSpy();
    const handle = createTelegramProgressAdapter({
      bus,
      env: {},
      getApi: () => api,
      resolveTarget: () => ({ chatId: 99 }),
      now: () => clock.value,
      scheduleTimer: timers.schedule,
      clearTimer: timers.clear,
      logger,
    });

    bus.publish(makeFrame({ phase: "classifying", seq: 1, ts: 0 }));
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    clock.value = 500;
    bus.publish(makeFrame({ phase: "planning", seq: 2, ts: 500 }));
    await vi.waitFor(() => expect(editMessageText).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));

    expect(sendMessage.mock.calls[1]?.[1]).toContain("planning");
    expect(warnMessages().some((m) => m.includes("edit failed, falling back to send"))).toBe(true);
    expect(infoMessages().some((m) => m.includes("reason=send_ok"))).toBe(true);

    handle.unsubscribe();
  });

  it("treats Telegram 'message is not modified' as a counted skip rather than a fallback send", async () => {
    const bus = new ProgressBus();
    const sendMessage = vi.fn(async () => ({ message_id: 22 }));
    const editMessageText = vi.fn(async () => {
      throw new Error("Bad Request: message is not modified");
    });
    const api: TelegramProgressBotApi = { sendMessage, editMessageText };
    const clock = { value: 0 };
    const timers = makeFakeTimers(clock);
    const { logger, infoMessages } = makeLoggerSpy();
    const handle = createTelegramProgressAdapter({
      bus,
      env: {},
      getApi: () => api,
      resolveTarget: () => ({ chatId: 7 }),
      now: () => clock.value,
      scheduleTimer: timers.schedule,
      clearTimer: timers.clear,
      logger,
    });

    bus.publish(makeFrame({ phase: "classifying", seq: 1, ts: 0 }));
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    clock.value = 1000;
    bus.publish(makeFrame({ phase: "planning", seq: 2, ts: 1000 }));
    await vi.waitFor(() => expect(editMessageText).toHaveBeenCalledTimes(1));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(infoMessages().some((m) => m.includes("reason=edit_not_modified"))).toBe(true);

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

  it("logs a no_target warning and skips broadcasts when resolveTarget returns null", async () => {
    const bus = new ProgressBus();
    const sendMessage = vi.fn(async () => ({ message_id: 1 }));
    const api: TelegramProgressBotApi = { sendMessage };
    const { logger, warnMessages } = makeLoggerSpy();
    const handle = createTelegramProgressAdapter({
      bus,
      env: {},
      getApi: () => api,
      resolveTarget: () => null,
      logger,
    });
    bus.publish(makeFrame());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(warnMessages().some((m) => m.includes("[tg-progress] no_target"))).toBe(true);
    handle.unsubscribe();
  });

  it("unsubscribing stops further deliveries and clears scheduled drain timers", async () => {
    const bus = new ProgressBus();
    const sendMessage = vi.fn(async () => ({ message_id: 42 }));
    const editMessageText = vi.fn(async () => undefined);
    const clock = { value: 1000 };
    const timers = makeFakeTimers(clock);
    const handle = createTelegramProgressAdapter({
      bus,
      env: {},
      getApi: () => ({ sendMessage, editMessageText }),
      resolveTarget: () => ({ chatId: 1 }),
      now: () => clock.value,
      scheduleTimer: timers.schedule,
      clearTimer: timers.clear,
    });

    bus.publish(makeFrame({ phase: "classifying", seq: 1, ts: 1000 }));
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    clock.value = 1010;
    bus.publish(makeFrame({ phase: "planning", seq: 2, ts: 1010 }));
    await vi.waitFor(() => expect(timers.pendingCount()).toBe(1));

    handle.unsubscribe();
    expect(timers.pendingCount()).toBe(0);
    timers.advance(500);
    bus.publish(makeFrame({ phase: "tool_call", seq: 3, ts: 1500 }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(editMessageText).not.toHaveBeenCalled();
  });

  it("collapses duplicate-text edits without making API calls", async () => {
    const bus = new ProgressBus();
    const sendMessage = vi.fn(async () => ({ message_id: 13 }));
    const editMessageText = vi.fn(async () => undefined);
    const clock = { value: 0 };
    const timers = makeFakeTimers(clock);
    const { logger, infoMessages } = makeLoggerSpy();
    const handle = createTelegramProgressAdapter({
      bus,
      env: {},
      getApi: () => ({ sendMessage, editMessageText }),
      resolveTarget: () => ({ chatId: 8 }),
      now: () => clock.value,
      scheduleTimer: timers.schedule,
      clearTimer: timers.clear,
      logger,
    });

    bus.publish(makeFrame({ phase: "classifying", seq: 1, ts: 0 }));
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    clock.value = 1000;
    bus.publish(makeFrame({ phase: "classifying", seq: 2, ts: 1000 }));
    await vi.waitFor(() =>
      expect(infoMessages().some((m) => m.includes("reason=duplicate_text"))).toBe(true),
    );
    expect(editMessageText).not.toHaveBeenCalled();

    handle.unsubscribe();
  });
});
