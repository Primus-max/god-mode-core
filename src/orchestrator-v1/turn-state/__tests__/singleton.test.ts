/**
 * V1-CONTRACT-ONLY — `getProcessTurnStateStore` singleton accessor tests.
 *
 * The singleton is the wiring glue that activates the multi-turn state
 * machine landed in PR #349. Without it, each of the 3 dispatch sites
 * (Telegram / plugin-sdk inbound / agent-command ingress) would build
 * its own Map and a follow-up message routed through a different surface
 * would not see the pending plan stashed by the prior turn.
 *
 * Symptoms these tests guard:
 *   1. The accessor returns the SAME instance on repeated calls so the 3
 *      dispatch sites observe each other's writes.
 *   2. The instance exposes the full `TurnStateStore` contract (`get`,
 *      `put`, `clear`) so the orchestrator can use it as-is.
 *   3. Test-only setter resets to lazy-init when passed `undefined`.
 *   4. State written through the singleton is visible on the next read,
 *      proving the underlying store is genuinely shared (not re-created).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  createInMemoryTurnStateStore,
  getProcessTurnStateStore,
  setProcessTurnStateStoreForTesting,
  type PendingTurn,
  type TurnStateStore,
} from "../index.js";

afterEach(() => {
  // Always release the test override so other test files do not see
  // pinned state.
  setProcessTurnStateStoreForTesting(undefined);
});

describe("getProcessTurnStateStore", () => {
  it("returns the SAME instance on repeated calls (idempotent)", () => {
    const a = getProcessTurnStateStore();
    const b = getProcessTurnStateStore();
    expect(a).toBe(b);
  });

  it("instance exposes the full TurnStateStore contract (get/put/clear)", () => {
    const store: TurnStateStore = getProcessTurnStateStore();
    expect(typeof store.get).toBe("function");
    expect(typeof store.put).toBe("function");
    expect(typeof store.clear).toBe("function");
  });

  it("setProcessTurnStateStoreForTesting(undefined) resets to lazy-init on next read", () => {
    const first = getProcessTurnStateStore();
    setProcessTurnStateStoreForTesting(undefined);
    const second = getProcessTurnStateStore();
    // Lazy-init produced a fresh instance — distinct from the first.
    expect(second).not.toBe(first);
  });

  it("pinned override is returned by subsequent get calls until cleared", () => {
    const pinned = createInMemoryTurnStateStore();
    setProcessTurnStateStoreForTesting(pinned);
    expect(getProcessTurnStateStore()).toBe(pinned);
    expect(getProcessTurnStateStore()).toBe(pinned);
  });

  it("state written through the singleton is visible on the NEXT read (proves sharing)", async () => {
    // Pin a fresh store so the test does not collide with whatever the
    // ambient process state contains at this point.
    const pinned = createInMemoryTurnStateStore();
    setProcessTurnStateStoreForTesting(pinned);

    const writer = getProcessTurnStateStore();
    const reader = getProcessTurnStateStore();
    expect(reader).toBe(writer);

    const now = Date.now();
    const entry: PendingTurn = {
      tool_calls: [
        { tool: "write" as never, argsSoFar: { path: "/tmp/foo.txt" }, missingFields: ["text"] },
      ],
      createdAt: now,
      expiresAt: now + 60_000,
    };

    await writer.put("test:chat:1", entry);
    const observed = await reader.get("test:chat:1");
    expect(observed).toEqual(entry);
  });
});
