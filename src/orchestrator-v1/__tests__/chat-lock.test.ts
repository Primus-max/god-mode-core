/**
 * V1-CONTRACT-ONLY — Per-chat lock tests.
 *
 * Verify:
 *   - same-chat turns serialize (second waits for first)
 *   - different-chat turns run concurrently
 *   - exception in one turn doesn't deadlock subsequent turns
 *   - lock map is empty after all turns settle
 */

import { afterEach, describe, expect, it } from "vitest";
import { activeLockCount, clearAllLocksForTesting, withChatLock } from "../chat-lock.js";

afterEach(() => {
  clearAllLocksForTesting();
});

describe("V1-CONTRACT-ONLY chat-lock", () => {
  it("serializes same-chat turns", async () => {
    const order: string[] = [];
    const t1 = withChatLock("chat-A", async () => {
      order.push("t1-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("t1-end");
    });
    const t2 = withChatLock("chat-A", async () => {
      order.push("t2-start");
      await new Promise((r) => setTimeout(r, 5));
      order.push("t2-end");
    });
    await Promise.all([t1, t2]);
    expect(order).toEqual(["t1-start", "t1-end", "t2-start", "t2-end"]);
  });

  it("runs different-chat turns concurrently", async () => {
    const events: string[] = [];
    const tA = withChatLock("chat-A", async () => {
      events.push("A-start");
      await new Promise((r) => setTimeout(r, 30));
      events.push("A-end");
    });
    const tB = withChatLock("chat-B", async () => {
      events.push("B-start");
      await new Promise((r) => setTimeout(r, 5));
      events.push("B-end");
    });
    await Promise.all([tA, tB]);
    // B finishes before A because B's work is shorter — proves they run in parallel
    expect(events.indexOf("B-end")).toBeLessThan(events.indexOf("A-end"));
  });

  it("does not deadlock when one turn throws", async () => {
    const t1 = withChatLock("chat-A", async () => {
      throw new Error("boom");
    });
    await expect(t1).rejects.toThrow("boom");

    // subsequent turn should still proceed
    const result = await withChatLock("chat-A", async () => "ok");
    expect(result).toBe("ok");
  });

  it("clears lock map after all turns settle", async () => {
    await withChatLock("chat-A", async () => "x");
    await withChatLock("chat-B", async () => "y");
    expect(activeLockCount()).toBe(0);
  });
});
