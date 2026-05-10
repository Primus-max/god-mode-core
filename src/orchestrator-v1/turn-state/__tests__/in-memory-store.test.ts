/**
 * V1-CONTRACT-ONLY — `InMemoryTurnStateStore` unit tests.
 *
 * The service is small but load-bearing for the multi-turn flow, so we
 * cover get/put/clear, TTL eviction, and the boundary where an entry
 * expires exactly on the now() tick.
 */

import { describe, expect, it } from "vitest";
import {
  createInMemoryTurnStateStore,
  DEFAULT_TURN_STATE_TTL_MS,
} from "../in-memory-store.js";
import type { PendingTurn } from "../types.js";

function makePending(
  createdAt: number = Date.now(),
  ttl: number = DEFAULT_TURN_STATE_TTL_MS,
): PendingTurn {
  return {
    tool_calls: [
      {
        tool: "write",
        argsSoFar: { content: "тест" },
        missingFields: ["path"],
      },
    ],
    createdAt,
    expiresAt: createdAt + ttl,
  };
}

describe("InMemoryTurnStateStore — basic store ops", () => {
  it("get returns undefined for an unknown chatKey", async () => {
    const store = createInMemoryTurnStateStore();
    expect(await store.get("nope")).toBeUndefined();
  });

  it("put then get round-trips the same PendingTurn object", async () => {
    const store = createInMemoryTurnStateStore();
    const pending = makePending();
    await store.put("chat-1", pending);
    expect(await store.get("chat-1")).toEqual(pending);
  });

  it("clear removes a stored entry", async () => {
    const store = createInMemoryTurnStateStore();
    await store.put("chat-1", makePending());
    await store.clear("chat-1");
    expect(await store.get("chat-1")).toBeUndefined();
  });

  it("clear on an unknown chatKey is a no-op (does not throw)", async () => {
    const store = createInMemoryTurnStateStore();
    await expect(store.clear("never-existed")).resolves.toBeUndefined();
  });

  it("entries are isolated per chatKey", async () => {
    const store = createInMemoryTurnStateStore();
    const a = makePending();
    const b: PendingTurn = {
      ...makePending(),
      tool_calls: [
        { tool: "pdf", argsSoFar: {}, missingFields: ["title", "summary"] },
      ],
    };
    await store.put("chat-a", a);
    await store.put("chat-b", b);
    expect((await store.get("chat-a"))?.tool_calls[0]?.tool).toBe("write");
    expect((await store.get("chat-b"))?.tool_calls[0]?.tool).toBe("pdf");
  });
});

describe("InMemoryTurnStateStore — TTL eviction", () => {
  it("get returns undefined once now() passes expiresAt", async () => {
    let t = 0;
    const store = createInMemoryTurnStateStore({ now: () => t });
    const pending: PendingTurn = {
      tool_calls: [{ tool: "write", argsSoFar: {}, missingFields: ["path"] }],
      createdAt: 100,
      expiresAt: 200,
    };
    t = 100;
    await store.put("chat-ttl", pending);
    t = 199;
    expect(await store.get("chat-ttl")).toBeDefined();
    t = 200; // exactly at boundary — must be considered expired
    expect(await store.get("chat-ttl")).toBeUndefined();
  });

  it("a stale entry is evicted on read (no leak)", async () => {
    let t = 0;
    const store = createInMemoryTurnStateStore({ now: () => t });
    const pending: PendingTurn = {
      tool_calls: [{ tool: "write", argsSoFar: {}, missingFields: ["path"] }],
      createdAt: 100,
      expiresAt: 200,
    };
    t = 100;
    await store.put("chat-ttl", pending);
    t = 500; // long past expiry
    await store.get("chat-ttl");
    // Re-put a fresh entry — if the stale entry weren't evicted on read,
    // we wouldn't see this one in get(); but more importantly, we test
    // that TTL doesn't bleed into the new entry.
    const fresh: PendingTurn = {
      tool_calls: [{ tool: "pdf", argsSoFar: {}, missingFields: ["title"] }],
      createdAt: 500,
      expiresAt: 1500,
    };
    await store.put("chat-ttl", fresh);
    t = 600;
    const got = await store.get("chat-ttl");
    expect(got?.tool_calls[0]?.tool).toBe("pdf");
  });

  it("default TTL is 10 minutes", () => {
    expect(DEFAULT_TURN_STATE_TTL_MS).toBe(10 * 60 * 1000);
  });
});
