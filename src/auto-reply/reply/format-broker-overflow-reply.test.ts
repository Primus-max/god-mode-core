import { describe, expect, it } from "vitest";

import {
  buildBrokerQueueKey,
  createConcurrentTurnBroker,
  type BrokerOverflowReason,
  type BrokerQueueKey,
  type ConcurrentTurnBroker,
} from "../../platform/broker/index.js";
import { asIdentityId } from "../../platform/identity/identity-id.js";

import {
  deriveBrokerRetryAfterMs,
  formatBrokerOverflowReply,
  MS_PER_QUEUED_TURN_ESTIMATE,
} from "./format-broker-overflow-reply.js";

/**
 * Slice "PR-MT concurrent broker" — Phase 6 (backpressure envelope).
 *
 * Fail-first tests for the user-facing reply formatter and the
 * deterministic retry-after derivation. The formatter receives a closed-
 * set `BrokerOverflowReason` and produces a Russian-locale operator
 * message; the derivation walks the broker's `getActiveKeys()` +
 * `getQueueDepth()` introspection and computes a deterministic
 * retry-after estimate without touching wall-clock or randomness.
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_pr_mt_concurrent_broker.plan.md`
 * Phase 6.
 *
 * Invariants exercised:
 * - #5/#6 — formatter operates on a closed reason discriminator only;
 *   never reads raw user text.
 * - #15 — every reason maps to a structured envelope (no throws, no
 *   silent drops). The formatter and derivation both return a defined
 *   value for every input combination.
 */

const IDENTITY = asIdentityId("identity:operator-a");
const KEY_A: BrokerQueueKey = buildBrokerQueueKey(IDENTITY, "telegram:1");
const KEY_B: BrokerQueueKey = buildBrokerQueueKey(IDENTITY, "telegram:2");

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

describe("formatBrokerOverflowReply — Russian-locale user reply", () => {
  it("queue_depth_exceeded → Russian overload message with retry hint", () => {
    const reply = formatBrokerOverflowReply("queue_depth_exceeded", 10_000);
    expect(reply).toContain("Перегрузка очереди");
    expect(reply).toContain("10");
    // Reverse: must NOT throw on this reason.
    expect(typeof reply).toBe("string");
    expect(reply.length).toBeGreaterThan(0);
  });

  it("wait_timeout → Russian timeout message", () => {
    const reply = formatBrokerOverflowReply("wait_timeout");
    expect(reply).toContain("превысил время ожидания");
  });

  it("broker_shutdown → Russian shutdown message with 30s hint", () => {
    const reply = formatBrokerOverflowReply("broker_shutdown");
    expect(reply).toContain("перезагружается");
    expect(reply).toContain("30");
  });

  it("queue_depth_exceeded with undefined retryAfterMs falls back to default", () => {
    const reply = formatBrokerOverflowReply("queue_depth_exceeded");
    // Default fallback is 10s (10_000 ms) per spec.
    expect(reply).toContain("Перегрузка очереди");
    expect(reply).toContain("10");
  });

  it("rounds retryAfterMs up to whole seconds (not raw ms)", () => {
    // 12_500ms should display as ~13s (not "12500мс" or fractional).
    const reply = formatBrokerOverflowReply("queue_depth_exceeded", 12_500);
    expect(reply).toContain("13");
    expect(reply).not.toContain("12500");
  });
});

describe("deriveBrokerRetryAfterMs — deterministic derivation from broker stats", () => {
  it("returns a default 10_000 when broker has no active keys (queue_depth_exceeded)", () => {
    const broker = createConcurrentTurnBroker();
    const retryAfterMs = deriveBrokerRetryAfterMs(broker, "queue_depth_exceeded");
    expect(retryAfterMs).toBe(10_000);
  });

  it("returns 30_000 for broker_shutdown regardless of broker state", () => {
    const broker = createConcurrentTurnBroker();
    const retryAfterMs = deriveBrokerRetryAfterMs(broker, "broker_shutdown");
    expect(retryAfterMs).toBe(30_000);
  });

  it("returns undefined for wait_timeout (no deterministic retry hint)", () => {
    const broker = createConcurrentTurnBroker();
    const retryAfterMs = deriveBrokerRetryAfterMs(broker, "wait_timeout");
    expect(retryAfterMs).toBeUndefined();
  });

  it("scales retry-after by min queue depth across active keys (queue_depth_exceeded)", async () => {
    const broker = createConcurrentTurnBroker(
      { maxQueueDepthPerKey: 16 },
    );
    // Pump two distinct keys with different depths. Depth on KEY_A=2 (queued
    // behind one running entry); depth on KEY_B=1. min queueDepth is 1.
    let releaseA = (): void => undefined;
    let releaseB = (): void => undefined;
    const inflightA = new Promise<void>((r) => {
      releaseA = r;
    });
    const inflightB = new Promise<void>((r) => {
      releaseB = r;
    });

    const enqueuedAt = Date.now();
    void broker.submit({
      turnId: "a-1",
      queueKey: KEY_A,
      enqueuedAtMs: enqueuedAt,
      runTurn: async () => {
        await inflightA;
      },
    });
    void broker.submit({
      turnId: "a-2",
      queueKey: KEY_A,
      enqueuedAtMs: enqueuedAt,
      runTurn: async () => undefined,
    });
    void broker.submit({
      turnId: "a-3",
      queueKey: KEY_A,
      enqueuedAtMs: enqueuedAt,
      runTurn: async () => undefined,
    });
    void broker.submit({
      turnId: "b-1",
      queueKey: KEY_B,
      enqueuedAtMs: enqueuedAt,
      runTurn: async () => {
        await inflightB;
      },
    });
    void broker.submit({
      turnId: "b-2",
      queueKey: KEY_B,
      enqueuedAtMs: enqueuedAt,
      runTurn: async () => undefined,
    });

    await flushMicrotasks();

    // After dispatch tick: KEY_A inFlight (a-1 blocked on inflightA), queued
    // [a-2, a-3] depth=2. KEY_B inFlight (b-1 blocked on inflightB), queued
    // [b-2] depth=1. min depth = 1 → retry-after = 1 * MS_PER_QUEUED_TURN_ESTIMATE.
    const retryAfterMs = deriveBrokerRetryAfterMs(broker, "queue_depth_exceeded");
    expect(retryAfterMs).toBe(MS_PER_QUEUED_TURN_ESTIMATE);

    releaseA();
    releaseB();
    await broker.shutdown();
  });

  it("falls back to 10_000 when active keys exist but all queues are empty (only inFlight)", async () => {
    const broker = createConcurrentTurnBroker();
    let release = (): void => undefined;
    const inflight = new Promise<void>((r) => {
      release = r;
    });
    const submission = broker.submit({
      turnId: "only-inflight",
      queueKey: KEY_A,
      enqueuedAtMs: Date.now(),
      runTurn: async () => {
        await inflight;
      },
    });
    await flushMicrotasks();

    // Active key exists (inFlight), but its queue is empty (no backlog).
    // Derivation must clamp to default rather than 0.
    const retryAfterMs = deriveBrokerRetryAfterMs(broker, "queue_depth_exceeded");
    expect(retryAfterMs).toBe(10_000);

    release();
    await submission;
    await broker.shutdown();
  });
});

describe("formatBrokerOverflowReply + deriveBrokerRetryAfterMs — round-trip", () => {
  it("queue_depth_exceeded broker stats flow into the user reply text", async () => {
    const broker = createConcurrentTurnBroker();
    let release = (): void => undefined;
    const inflight = new Promise<void>((r) => {
      release = r;
    });
    const enqueuedAt = Date.now();
    void broker.submit({
      turnId: "rt-1",
      queueKey: KEY_A,
      enqueuedAtMs: enqueuedAt,
      runTurn: async () => {
        await inflight;
      },
    });
    void broker.submit({
      turnId: "rt-2",
      queueKey: KEY_A,
      enqueuedAtMs: enqueuedAt,
      runTurn: async () => undefined,
    });
    await flushMicrotasks();

    const retryAfterMs = deriveBrokerRetryAfterMs(broker, "queue_depth_exceeded");
    expect(retryAfterMs).toBe(MS_PER_QUEUED_TURN_ESTIMATE);
    const reply = formatBrokerOverflowReply("queue_depth_exceeded", retryAfterMs);
    expect(reply).toContain("Перегрузка очереди");
    // Math.ceil(MS_PER_QUEUED_TURN_ESTIMATE / 1000) seconds.
    const expectedSeconds = Math.ceil((retryAfterMs ?? 0) / 1000);
    expect(reply).toContain(String(expectedSeconds));

    release();
    await broker.shutdown();
  });
});
