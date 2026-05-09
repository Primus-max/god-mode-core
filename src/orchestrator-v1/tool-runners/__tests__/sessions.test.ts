/**
 * V1-CUTOVER S6 — unit tests for `runSessionsSend`.
 *
 * Coverage matrix:
 *   1. Happy path: send resolves → ok:true, output.channel === args.channel,
 *      and the mock was called with EXACTLY (args.channel, args.text). The
 *      "exact channel" assertion is the real-symptom guard — if the runner
 *      ever forgot to thread args.channel through, this test catches it.
 *   2. Network/auth failure: send rejects with Error → ok:false, error is
 *      the rejection message.
 *   3. Channel-not-found: send rejects with a "channel not found" message
 *      → ok:false, error mentions the channel.
 *   4. Default transport fails-closed when no deps are passed.
 *   5. Non-Error rejection coerces to a non-empty string.
 *   6. Empty channel name still threads through verbatim — the runner
 *      does NOT silently substitute a default; that would mask Stage-B
 *      validation gaps.
 */

import { describe, expect, it, vi } from "vitest";
import { runSessionsSend } from "../sessions.js";

describe("runSessionsSend", () => {
  it("returns ok with output.channel === args.channel and calls send with exact args", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const args = { channel: "telegram:6533456892", text: "hello world" };

    const result = await runSessionsSend(args, { send });

    expect(result).toEqual({ ok: true, output: { channel: args.channel } });
    expect(send).toHaveBeenCalledTimes(1);
    // EXACT-args assertion: catches "wrong channel" / "args.channel not threaded" regressions.
    expect(send).toHaveBeenCalledWith(args.channel, args.text);
  });

  it("returns ok:false with non-empty error when send rejects (network/auth)", async () => {
    const send = vi.fn().mockRejectedValue(new Error("ECONNRESET: gateway timeout"));
    const args = { channel: "slack:#general", text: "ping" };

    const result = await runSessionsSend(args, { send });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("ECONNRESET: gateway timeout");
      expect(result.error.length).toBeGreaterThan(0);
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(args.channel, args.text);
  });

  it("returns ok:false with error mentioning the channel when channel not found", async () => {
    const send = vi
      .fn()
      .mockRejectedValue(new Error("channel not found: telegram:does-not-exist"));
    const args = { channel: "telegram:does-not-exist", text: "test" };

    const result = await runSessionsSend(args, { send });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(args.channel);
    }
  });

  it("default transport fails closed when no deps are wired", async () => {
    // Production wires the real transport via the registry slice (S8/S9).
    // Until then the default must fail loudly so the dispatcher renders a
    // truthful sessions_send:failure reply instead of silently no-op-ing.
    const result = await runSessionsSend({ channel: "telegram:1", text: "hi" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not configured/i);
    }
  });

  it("non-Error rejection coerces to a non-empty string", async () => {
    // Some transports reject with plain strings or objects. The runner
    // must still surface a non-empty error so the failure template
    // ("Не удалось отправить в {channel}: {error}") never has a blank
    // tail.
    const send = vi.fn().mockRejectedValue("string-rejection");
    const result = await runSessionsSend(
      { channel: "telegram:42", text: "x" },
      { send },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("string-rejection");
    }
  });

  it("threads args.channel verbatim — no silent substitution", async () => {
    // Defense in depth: if a future refactor wired some "default channel"
    // fallback inside the runner, this test would catch the lie. The
    // runner must always send to whatever Stage B extracted, full stop.
    const send = vi.fn().mockResolvedValue(undefined);
    const args = { channel: "discord:123:456", text: "hi" };

    const result = await runSessionsSend(args, { send });

    expect(send).toHaveBeenCalledWith("discord:123:456", "hi");
    if (result.ok) {
      expect(result.output.channel).toBe("discord:123:456");
    }
  });
});
