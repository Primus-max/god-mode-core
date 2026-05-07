import { afterEach, describe, expect, it } from "vitest";

import {
  __resetConcurrentTurnBrokerBootstrapForTests,
  bindProcessConcurrentTurnBroker,
  getProcessConcurrentTurnBroker,
} from "./concurrent-turn-broker-bootstrap.js";

/**
 * Slice "PR-MT concurrent broker" — Phase 6 (production bootstrap binder).
 *
 * Fail-first tests for the process-scoped bootstrap that binds the
 * default `ConcurrentTurnBroker` at gateway startup. Mirrors the
 * `persistent-worker-push-bootstrap` discipline: idempotent first-call
 * binds, second-call returns `'alreadyBound'`, no production-wired
 * gateway-startup module under `src/server/` ever throws.
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_pr_mt_concurrent_broker.plan.md`
 * Phase 6.
 *
 * Invariants exercised:
 * - #8 — bootstrap module lives in `src/server/`, not in
 *   `src/platform/commitment/` or `src/platform/decision/`.
 * - #11 — frozen contracts BYTE-IDENTICAL.
 * - #15 — bootstrap returns a structured `{kind: 'bound' | 'alreadyBound'}`
 *   envelope; never throws.
 */

afterEach(() => {
  __resetConcurrentTurnBrokerBootstrapForTests();
});

describe("bindProcessConcurrentTurnBroker — first call binds", () => {
  it("first call returns {kind:'bound'} and getProcessConcurrentTurnBroker() returns the broker", () => {
    expect(getProcessConcurrentTurnBroker()).toBeUndefined();

    const result = bindProcessConcurrentTurnBroker({
      logger: { log: () => undefined },
    });

    expect(result.kind).toBe("bound");
    const broker = getProcessConcurrentTurnBroker();
    expect(broker).toBeDefined();
    // Public surface sanity: broker exposes the four documented helpers.
    expect(typeof broker?.submit).toBe("function");
    expect(typeof broker?.getQueueDepth).toBe("function");
    expect(typeof broker?.getActiveKeys).toBe("function");
    expect(typeof broker?.shutdown).toBe("function");
  });
});

describe("bindProcessConcurrentTurnBroker — idempotent second call", () => {
  it("second call returns {kind:'alreadyBound'} and broker instance is preserved", () => {
    const r1 = bindProcessConcurrentTurnBroker({
      logger: { log: () => undefined },
    });
    expect(r1.kind).toBe("bound");
    const broker1 = getProcessConcurrentTurnBroker();
    expect(broker1).toBeDefined();

    const r2 = bindProcessConcurrentTurnBroker({
      logger: { log: () => undefined },
    });
    expect(r2.kind).toBe("alreadyBound");

    const broker2 = getProcessConcurrentTurnBroker();
    // Same reference — second call did NOT replace the broker.
    expect(broker2).toBe(broker1);
  });
});

describe("bindProcessConcurrentTurnBroker — capacity config respected", () => {
  it("capacity config flows into the broker construction (rejection threshold)", async () => {
    const result = bindProcessConcurrentTurnBroker({
      logger: { log: () => undefined },
      capacityConfig: { maxQueueDepthPerKey: 1 },
    });
    expect(result.kind).toBe("bound");
    const broker = getProcessConcurrentTurnBroker();
    expect(broker).toBeDefined();

    // With maxQueueDepthPerKey=1 the second submit on the same queueKey
    // must be rejected. We use the broker's submit surface directly so
    // there's no mocking of the unit under test.
    const { asIdentityId } = await import("../platform/identity/identity-id.js");
    const { buildBrokerQueueKey } = await import("../platform/broker/index.js");
    const identity = asIdentityId("identity:operator-a");
    const queueKey = buildBrokerQueueKey(identity, "telegram:1");

    let release = (): void => undefined;
    const inflight = new Promise<void>((r) => {
      release = r;
    });

    const p1 = broker!.submit({
      turnId: "t1",
      queueKey,
      enqueuedAtMs: Date.now(),
      runTurn: async () => {
        await inflight;
      },
    });

    // Wait for p1 to enter inFlight so the next submit's queue depth = 1.
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }

    const p2 = broker!.submit({
      turnId: "t2",
      queueKey,
      enqueuedAtMs: Date.now(),
      runTurn: async () => undefined,
    });

    // Wait for p2 to enter the queue (depth=1). Now a third submit must be
    // rejected because adding it would put depth at 2 > cap=1.
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }

    const p3Result = await broker!.submit({
      turnId: "t3",
      queueKey,
      enqueuedAtMs: Date.now(),
      runTurn: async () => undefined,
    });

    expect(p3Result.kind).toBe("rejected");
    if (p3Result.kind === "rejected") {
      expect(p3Result.reason).toBe("queue_depth_exceeded");
    }

    release();
    await Promise.all([p1, p2]);
  });
});

describe("bindProcessConcurrentTurnBroker — logger respected", () => {
  it("logger is invoked during broker submit telemetry", async () => {
    const lines: string[] = [];
    const result = bindProcessConcurrentTurnBroker({
      logger: { log: (m) => lines.push(m) },
    });
    expect(result.kind).toBe("bound");
    const broker = getProcessConcurrentTurnBroker();
    expect(broker).toBeDefined();

    const { asIdentityId } = await import("../platform/identity/identity-id.js");
    const { buildBrokerQueueKey } = await import("../platform/broker/index.js");
    const identity = asIdentityId("identity:operator-a");
    const queueKey = buildBrokerQueueKey(identity, "telegram:1");

    await broker!.submit({
      turnId: "log-1",
      queueKey,
      enqueuedAtMs: Date.now(),
      runTurn: async () => undefined,
    });

    // Broker emits at minimum [broker] dispatch + [broker] complete on the
    // happy path. `[broker] enqueued` is a debug line (level may be filtered
    // depending on logger threshold); we only assert dispatch+complete.
    const matched = lines.filter((l) => l.startsWith("[broker]"));
    expect(
      matched.length,
      `expected at least one [broker] line but lines were: ${JSON.stringify(lines)}`,
    ).toBeGreaterThan(0);
    expect(
      lines.some((l) => l.includes("dispatch")),
      `expected a dispatch line but lines were: ${JSON.stringify(lines)}`,
    ).toBe(true);
    expect(lines.some((l) => l.includes("complete"))).toBe(true);
  });
});

describe("getProcessConcurrentTurnBroker — pre-bootstrap returns undefined", () => {
  it("returns undefined when bootstrap has not been called (reverse defense)", () => {
    // After the afterEach reset, the binding must be cleared.
    expect(getProcessConcurrentTurnBroker()).toBeUndefined();
  });
});
