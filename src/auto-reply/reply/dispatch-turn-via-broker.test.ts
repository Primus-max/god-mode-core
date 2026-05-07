import { describe, expect, it } from "vitest";

import {
  buildBrokerQueueKey,
  createConcurrentTurnBroker,
  type BrokerEntry,
  type BrokerQueueKey,
  type BrokerSubmitResult,
  type ConcurrentTurnBroker,
} from "../../platform/broker/index.js";
import { asIdentityId } from "../../platform/identity/identity-id.js";

import { dispatchTurnViaBroker } from "./dispatch-turn-via-broker.js";

/**
 * Phase 5 — fail-first tests for `dispatchTurnViaBroker`.
 *
 * The wiring helper composes a `BrokerQueueKey` from `(identityId,
 * channelTuple)` and submits to the broker, OR (when broker is undefined)
 * invokes the supplied `runTurn` directly. The tests below are:
 *   1. broker=undefined: byte-identical to direct runTurn invocation
 *   2. same-(identity, channel) two-turn FIFO when broker present
 *   3. different-identity two-turn parallel dispatch when broker present
 *   4. identity-isolation reverse — A's runTurn never sees B's identity
 *   5. plugin.ts byte-identical (no broker integration in plugin.ts)
 *   6. broker=undefined regression — 5 sequential turns serialize cleanly
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_pr_mt_concurrent_broker.plan.md`
 * Phase 5. Audit: `extensions/AUDIT-pr-mt-concurrent-broker.md` §1.2 (plugin
 * out-of-scope) + §3.1 (channel tuple in scope).
 *
 * Invariants exercised:
 * - #8 — wiring helper imports only the broker barrel + identity brand.
 * - #11 — frozen contracts BYTE-IDENTICAL; no commitment/decision touch.
 * - #15 — broker rejection surfaces as structured envelope (never throws).
 * - #16 — `BrokerQueueKey` brand discipline preserved end-to-end.
 */

const IDENTITY_A = asIdentityId("identity:operator-a");
const IDENTITY_B = asIdentityId("identity:operator-b");

type ResolverHandle = {
  readonly promise: Promise<void>;
  resolve: () => void;
};

function makeResolver(): ResolverHandle {
  let resolveFn: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: resolveFn };
}

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

describe("dispatchTurnViaBroker — broker=undefined byte-identical baseline", () => {
  it("invokes runTurn directly and resolves to {kind:'completed'}", async () => {
    const sequence: string[] = [];

    const result = await dispatchTurnViaBroker({
      // broker omitted → undefined fallback path
      turnId: "t1",
      identityId: IDENTITY_A,
      originatingChannel: "telegram",
      originatingTo: "chat-1",
      originatingAccountId: "acct-1",
      originatingThreadId: undefined,
      runTurn: async () => {
        sequence.push("ran");
      },
    });

    expect(result).toEqual({ kind: "completed" });
    expect(sequence).toEqual(["ran"]);
  });

  it("propagates errors thrown inside runTurn (matches pre-broker baseline)", async () => {
    await expect(
      dispatchTurnViaBroker({
        turnId: "t1",
        identityId: IDENTITY_A,
        originatingChannel: "telegram",
        originatingTo: "chat-1",
        runTurn: async () => {
          throw new Error("downstream failure");
        },
      }),
    ).rejects.toThrow("downstream failure");
  });
});

describe("dispatchTurnViaBroker — same-(identity, channel) two-turn FIFO", () => {
  it("serializes two turns sharing one queueKey through the broker", async () => {
    const broker = createConcurrentTurnBroker();
    const sequence: string[] = [];
    const r1 = makeResolver();
    const r2 = makeResolver();

    const p1 = dispatchTurnViaBroker({
      broker,
      turnId: "t1",
      identityId: IDENTITY_A,
      originatingChannel: "telegram",
      originatingTo: "chat-1",
      originatingAccountId: "acct-1",
      originatingThreadId: undefined,
      runTurn: async () => {
        sequence.push("start-1");
        await r1.promise;
        sequence.push("end-1");
      },
    });

    const p2 = dispatchTurnViaBroker({
      broker,
      turnId: "t2",
      identityId: IDENTITY_A,
      originatingChannel: "telegram",
      originatingTo: "chat-1",
      originatingAccountId: "acct-1",
      originatingThreadId: undefined,
      runTurn: async () => {
        sequence.push("start-2");
        await r2.promise;
        sequence.push("end-2");
      },
    });

    await flushMicrotasks();
    // Same-(identity, channel) → both submits land on one queueKey; only
    // turn-1 starts before turn-1 settles. FIFO is enforced by the
    // broker's per-key in-flight guard.
    expect(sequence).toEqual(["start-1"]);

    r1.resolve();
    await flushMicrotasks();
    expect(sequence).toEqual(["start-1", "end-1", "start-2"]);

    r2.resolve();
    const [res1, res2] = await Promise.all([p1, p2]);
    expect(res1).toEqual({ kind: "completed" });
    expect(res2).toEqual({ kind: "completed" });
    expect(sequence).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });
});

describe("dispatchTurnViaBroker — different-identity two-turn parallel", () => {
  it("two distinct identities → both runTurns start before either settles", async () => {
    const broker = createConcurrentTurnBroker();
    const sequence: string[] = [];
    const r1 = makeResolver();
    const r2 = makeResolver();

    const p1 = dispatchTurnViaBroker({
      broker,
      turnId: "t1",
      identityId: IDENTITY_A,
      originatingChannel: "telegram",
      originatingTo: "chat-1",
      runTurn: async () => {
        sequence.push("start-A");
        await r1.promise;
        sequence.push("end-A");
      },
    });

    const p2 = dispatchTurnViaBroker({
      broker,
      turnId: "t2",
      identityId: IDENTITY_B,
      originatingChannel: "telegram",
      originatingTo: "chat-2",
      runTurn: async () => {
        sequence.push("start-B");
        await r2.promise;
        sequence.push("end-B");
      },
    });

    await flushMicrotasks();
    // Distinct (identity, channel) → distinct BrokerQueueKey → broker
    // dispatches both concurrently. Ordering between start-A/start-B is
    // microtask-deterministic (submit order) but BOTH must precede either end.
    expect(sequence).toContain("start-A");
    expect(sequence).toContain("start-B");
    expect(sequence).not.toContain("end-A");
    expect(sequence).not.toContain("end-B");

    r1.resolve();
    r2.resolve();
    await Promise.all([p1, p2]);
    expect(sequence).toContain("end-A");
    expect(sequence).toContain("end-B");
  });
});

describe("dispatchTurnViaBroker — identity-isolation reverse", () => {
  it("turn from identity B never sees turn-A's queueKey", async () => {
    const broker = createConcurrentTurnBroker();

    // Capture the queueKey each runTurn is dispatched under by snooping
    // the broker submit interface. Wrap the broker with a recording proxy
    // that tags entries by their queueKey at submit time.
    const submittedKeys: BrokerQueueKey[] = [];
    const recordingBroker: ConcurrentTurnBroker = {
      submit: (entry: BrokerEntry): Promise<BrokerSubmitResult> => {
        submittedKeys.push(entry.queueKey);
        return broker.submit(entry);
      },
      getQueueDepth: (key) => broker.getQueueDepth(key),
      getActiveKeys: () => broker.getActiveKeys(),
      shutdown: () => broker.shutdown(),
    };

    await dispatchTurnViaBroker({
      broker: recordingBroker,
      turnId: "tA",
      identityId: IDENTITY_A,
      originatingChannel: "telegram",
      originatingTo: "chat-shared",
      runTurn: async () => undefined,
    });
    await dispatchTurnViaBroker({
      broker: recordingBroker,
      turnId: "tB",
      identityId: IDENTITY_B,
      originatingChannel: "telegram",
      originatingTo: "chat-shared",
      runTurn: async () => undefined,
    });

    expect(submittedKeys).toHaveLength(2);
    expect(submittedKeys[0]).not.toBe(submittedKeys[1]);
    // Structural identity prefix preserved — A's key carries identity-A
    // slug, B's key carries identity-B slug. Cross-bleed is impossible.
    expect(submittedKeys[0]).toContain("identity:operator-a::");
    expect(submittedKeys[1]).toContain("identity:operator-b::");
    // Even with identical channel tuple ("chat-shared"), keys differ.
    expect(submittedKeys[0]?.split("::")[1]).toBe(submittedKeys[1]?.split("::")[1]);
  });
});

describe("dispatchTurnViaBroker — channel-key composition is stable", () => {
  it("same (identity, channel-tuple) → identical queueKey across calls", async () => {
    const broker = createConcurrentTurnBroker();
    const submittedKeys: BrokerQueueKey[] = [];
    const recordingBroker: ConcurrentTurnBroker = {
      submit: (entry: BrokerEntry): Promise<BrokerSubmitResult> => {
        submittedKeys.push(entry.queueKey);
        return broker.submit(entry);
      },
      getQueueDepth: (key) => broker.getQueueDepth(key),
      getActiveKeys: () => broker.getActiveKeys(),
      shutdown: () => broker.shutdown(),
    };

    const args = {
      broker: recordingBroker,
      identityId: IDENTITY_A,
      originatingChannel: "telegram",
      originatingTo: "chat-1",
      originatingAccountId: "acct-1",
      originatingThreadId: "thread-7",
      runTurn: async () => undefined,
    };

    await dispatchTurnViaBroker({ ...args, turnId: "t1" });
    await dispatchTurnViaBroker({ ...args, turnId: "t2" });

    expect(submittedKeys).toHaveLength(2);
    expect(submittedKeys[0]).toBe(submittedKeys[1]);
    // The opaque channel-key half must be a JSON tuple of length 4 —
    // mirrors `buildRecentMessageIdKey` precedent (audit §2.6).
    const channelKeyHalf = submittedKeys[0]?.split("::")[1] ?? "";
    expect(channelKeyHalf.startsWith("[")).toBe(true);
    expect(channelKeyHalf.endsWith("]")).toBe(true);
    const parsed = JSON.parse(channelKeyHalf) as unknown[];
    expect(parsed).toEqual(["telegram", "chat-1", "acct-1", "thread-7"]);
  });

  it("undefined accountId/threadId collapse to null (length-stable tuple)", async () => {
    const broker = createConcurrentTurnBroker();
    const submittedKeys: BrokerQueueKey[] = [];
    const recordingBroker: ConcurrentTurnBroker = {
      submit: (entry: BrokerEntry): Promise<BrokerSubmitResult> => {
        submittedKeys.push(entry.queueKey);
        return broker.submit(entry);
      },
      getQueueDepth: (key) => broker.getQueueDepth(key),
      getActiveKeys: () => broker.getActiveKeys(),
      shutdown: () => broker.shutdown(),
    };

    await dispatchTurnViaBroker({
      broker: recordingBroker,
      turnId: "t1",
      identityId: IDENTITY_A,
      originatingChannel: "telegram",
      originatingTo: "chat-1",
      // accountId + threadId omitted
      runTurn: async () => undefined,
    });

    const channelKeyHalf = submittedKeys[0]?.split("::")[1] ?? "";
    const parsed = JSON.parse(channelKeyHalf) as unknown[];
    expect(parsed).toEqual(["telegram", "chat-1", null, null]);
  });
});

describe("dispatchTurnViaBroker — broker rejection surfaces structured envelope", () => {
  it("queue_depth_exceeded → {kind:'rejected', reason, queueKey}", async () => {
    // Capacity-1 broker: turn-1 admits and is dispatched (queue empties,
    // moves into in-flight). turn-2 admits (queue depth 0 → 1, sits behind
    // turn-1). turn-3 hits the depth cap because the per-key queue already
    // holds 1 entry. The helper MUST translate the rejection into a
    // structured envelope (never throw).
    const broker = createConcurrentTurnBroker({ maxQueueDepthPerKey: 1 });
    const r1 = makeResolver();
    const r2 = makeResolver();
    const sequence: string[] = [];

    const p1 = dispatchTurnViaBroker({
      broker,
      turnId: "t1",
      identityId: IDENTITY_A,
      originatingChannel: "telegram",
      originatingTo: "chat-1",
      runTurn: async () => {
        sequence.push("start-1");
        await r1.promise;
        sequence.push("end-1");
      },
    });

    await flushMicrotasks();

    // turn-2 admits — queue length becomes 1, waits behind in-flight turn-1.
    const p2 = dispatchTurnViaBroker({
      broker,
      turnId: "t2",
      identityId: IDENTITY_A,
      originatingChannel: "telegram",
      originatingTo: "chat-1",
      runTurn: async () => {
        sequence.push("start-2");
        await r2.promise;
        sequence.push("end-2");
      },
    });

    await flushMicrotasks();

    // turn-3 should reject — per-key queue already at capacity (1).
    const p3 = dispatchTurnViaBroker({
      broker,
      turnId: "t3",
      identityId: IDENTITY_A,
      originatingChannel: "telegram",
      originatingTo: "chat-1",
      runTurn: async () => {
        sequence.push("start-3");
      },
    });

    const res3 = await p3;
    expect(res3.kind).toBe("rejected");
    if (res3.kind === "rejected") {
      expect(res3.reason).toBe("queue_depth_exceeded");
      expect(res3.queueKey).toContain("identity:operator-a::");
    }
    expect(sequence).not.toContain("start-3");

    r1.resolve();
    r2.resolve();
    await Promise.all([p1, p2]);
  });
});

describe("dispatchTurnViaBroker — broker disabled regression (5 sequential turns)", () => {
  it("broker=undefined → 5 turns invoke runTurn in submission order, byte-identical to direct dispatch", async () => {
    const sequence: number[] = [];
    const results: Array<{ readonly kind: string }> = [];

    for (let i = 0; i < 5; i += 1) {
      const turnIdx = i;
      const result = await dispatchTurnViaBroker({
        // broker undefined throughout
        turnId: `t${turnIdx}`,
        identityId: IDENTITY_A,
        originatingChannel: "telegram",
        originatingTo: "chat-1",
        runTurn: async () => {
          sequence.push(turnIdx);
        },
      });
      results.push(result);
    }

    expect(sequence).toEqual([0, 1, 2, 3, 4]);
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.kind).toBe("completed");
    }
  });
});

describe("dispatchTurnViaBroker — plugin.ts byte-identical (audit §1.2 deferred)", () => {
  it("plugin.ts callers MUST NOT route through dispatchTurnViaBroker (no broker integration)", async () => {
    // Static structural assertion: `src/platform/plugin.ts` must NOT import
    // `dispatch-turn-via-broker`. Audit §1.2 + §8.4 deferred plugin
    // callers (`plugin.ts:80` + `:340`) to v2 because they lack
    // (sessionId, channelId) lifecycle context. Phase 5 wiring is
    // deliberately scoped out of plugin.ts; this test guards against
    // accidental coupling.
    //
    // Read source bytes via fs.readFile (no top-level import — keep this
    // module's deps minimal). The file MAY exist or not depending on
    // the runtime layout; if it exists, assert no import line references
    // `dispatch-turn-via-broker`.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const moduleDir = path.dirname(url.fileURLToPath(import.meta.url));
    // `dispatch-turn-via-broker.test.ts` lives at src/auto-reply/reply/.
    // plugin.ts lives at src/platform/plugin.ts → ../../platform/plugin.ts.
    const pluginPath = path.resolve(moduleDir, "../../platform/plugin.ts");
    if (!fs.existsSync(pluginPath)) {
      // Plugin file missing in this checkout; skip silently. The lint-guard
      // at audit §7 will catch any future bypass.
      return;
    }
    const src = fs.readFileSync(pluginPath, "utf8");
    expect(src).not.toMatch(/dispatch-turn-via-broker/);
    expect(src).not.toMatch(/dispatchTurnViaBroker/);
  });
});
