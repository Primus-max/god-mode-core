import { describe, expect, expectTypeOf, it } from "vitest";

import { asIdentityId } from "../../identity/identity-id.js";
import {
  BROKER_OVERFLOW_REASONS,
  BrokerCapacityConfigSchema,
  DEFAULT_FAIRNESS_MODE,
  DEFAULT_MAX_CONCURRENT_KEYS,
  DEFAULT_MAX_QUEUE_DEPTH_PER_KEY,
  DEFAULT_QUEUE_WAIT_TIMEOUT_MS,
  buildBrokerQueueKey,
  isBrokerQueueKey,
  resolveBrokerCapacityConfig,
  type BrokerCapacityConfig,
  type BrokerEntry,
  type BrokerOverflowReason,
  type BrokerQueueKey,
  type ResolvedBrokerCapacityConfig,
} from "../broker-types.js";

/**
 * Phase 2 — fail-first tests for the broker type surface.
 *
 * Pure-types module: schema decode + default-application + brand
 * discipline + helper format. NO impl in this phase (Phase 3 lands the
 * placement helper, Phase 4 lands the broker runtime, Phase 5 wires it
 * at `agent-runner-execution.ts`).
 */

describe("BrokerCapacityConfigSchema — round-trip", () => {
  it("accepts the empty config", () => {
    const parsed = BrokerCapacityConfigSchema.parse({});
    expect(parsed).toEqual({});
  });

  it("accepts a full valid config", () => {
    const config: BrokerCapacityConfig = {
      maxQueueDepthPerKey: 16,
      maxConcurrentKeys: 64,
      queueWaitTimeoutMs: 30_000,
      fairnessMode: "fifo_global",
    };
    const parsed = BrokerCapacityConfigSchema.parse(config);
    expect(parsed).toEqual(config);
  });

  it("accepts partial config (only maxQueueDepthPerKey)", () => {
    const parsed = BrokerCapacityConfigSchema.parse({ maxQueueDepthPerKey: 4 });
    expect(parsed.maxQueueDepthPerKey).toBe(4);
    expect(parsed.maxConcurrentKeys).toBeUndefined();
    expect(parsed.queueWaitTimeoutMs).toBeUndefined();
    expect(parsed.fairnessMode).toBeUndefined();
  });
});

describe("BrokerCapacityConfigSchema — rejections", () => {
  it("rejects negative maxQueueDepthPerKey", () => {
    expect(() =>
      BrokerCapacityConfigSchema.parse({ maxQueueDepthPerKey: -1 }),
    ).toThrow();
  });

  it("rejects zero maxConcurrentKeys", () => {
    expect(() =>
      BrokerCapacityConfigSchema.parse({ maxConcurrentKeys: 0 }),
    ).toThrow();
  });

  it("rejects fractional queueWaitTimeoutMs", () => {
    expect(() =>
      BrokerCapacityConfigSchema.parse({ queueWaitTimeoutMs: 1500.5 }),
    ).toThrow();
  });

  it("rejects unknown fairnessMode enum value", () => {
    expect(() =>
      BrokerCapacityConfigSchema.parse({ fairnessMode: "lifo_global" }),
    ).toThrow();
  });

  it("rejects unknown top-level keys (strict mode)", () => {
    expect(() =>
      BrokerCapacityConfigSchema.parse({
        maxQueueDepthPerKey: 8,
        maxQueueDepthPerKye: 9, // typo
      }),
    ).toThrow();
  });

  it("rejects non-object input", () => {
    expect(() => BrokerCapacityConfigSchema.parse(null)).toThrow();
    expect(() => BrokerCapacityConfigSchema.parse([])).toThrow();
    expect(() => BrokerCapacityConfigSchema.parse("queue")).toThrow();
    expect(() => BrokerCapacityConfigSchema.parse(42)).toThrow();
  });

  it("rejects negative queueWaitTimeoutMs", () => {
    expect(() =>
      BrokerCapacityConfigSchema.parse({ queueWaitTimeoutMs: -1 }),
    ).toThrow();
  });
});

describe("resolveBrokerCapacityConfig — default application", () => {
  it("applies all defaults when input is undefined", () => {
    const resolved = resolveBrokerCapacityConfig(undefined);
    expect(resolved).toEqual({
      maxQueueDepthPerKey: DEFAULT_MAX_QUEUE_DEPTH_PER_KEY,
      maxConcurrentKeys: DEFAULT_MAX_CONCURRENT_KEYS,
      queueWaitTimeoutMs: DEFAULT_QUEUE_WAIT_TIMEOUT_MS,
      fairnessMode: DEFAULT_FAIRNESS_MODE,
    });
  });

  it("applies all defaults when input is empty object", () => {
    const resolved = resolveBrokerCapacityConfig({});
    expect(resolved.maxQueueDepthPerKey).toBe(DEFAULT_MAX_QUEUE_DEPTH_PER_KEY);
    expect(resolved.maxConcurrentKeys).toBe(DEFAULT_MAX_CONCURRENT_KEYS);
    expect(resolved.queueWaitTimeoutMs).toBe(DEFAULT_QUEUE_WAIT_TIMEOUT_MS);
    expect(resolved.fairnessMode).toBe(DEFAULT_FAIRNESS_MODE);
  });

  it("preserves caller-supplied values verbatim and fills the rest with defaults", () => {
    const resolved = resolveBrokerCapacityConfig({
      maxQueueDepthPerKey: 4,
      fairnessMode: "fifo_global",
    });
    expect(resolved.maxQueueDepthPerKey).toBe(4);
    expect(resolved.fairnessMode).toBe("fifo_global");
    expect(resolved.maxConcurrentKeys).toBe(DEFAULT_MAX_CONCURRENT_KEYS);
    expect(resolved.queueWaitTimeoutMs).toBe(DEFAULT_QUEUE_WAIT_TIMEOUT_MS);
  });

  it("returns a ResolvedBrokerCapacityConfig (every field present)", () => {
    const resolved = resolveBrokerCapacityConfig();
    expectTypeOf(resolved).toEqualTypeOf<ResolvedBrokerCapacityConfig>();
  });
});

describe("buildBrokerQueueKey + isBrokerQueueKey", () => {
  const identity = asIdentityId("identity:operator-a");

  it("produces the documented `<identityId>::<channelKey>` shape", () => {
    const key = buildBrokerQueueKey(identity, "telegram:6533456892");
    expect(key).toBe("identity:operator-a::telegram:6533456892");
  });

  it("is byte-stable across calls with the same inputs", () => {
    const a = buildBrokerQueueKey(identity, "telegram:1");
    const b = buildBrokerQueueKey(identity, "telegram:1");
    expect(a).toBe(b);
  });

  it("differs when the identity differs", () => {
    const otherIdentity = asIdentityId("identity:operator-b");
    const a = buildBrokerQueueKey(identity, "telegram:1");
    const b = buildBrokerQueueKey(otherIdentity, "telegram:1");
    expect(a).not.toBe(b);
  });

  it("differs when the channel key differs", () => {
    const a = buildBrokerQueueKey(identity, "telegram:1");
    const b = buildBrokerQueueKey(identity, "telegram:2");
    expect(a).not.toBe(b);
  });

  it("isBrokerQueueKey accepts a freshly-built key", () => {
    const key = buildBrokerQueueKey(identity, "telegram:6533456892");
    expect(isBrokerQueueKey(key)).toBe(true);
  });

  it("isBrokerQueueKey rejects malformed strings and non-strings", () => {
    expect(isBrokerQueueKey("identity:operator-a")).toBe(false); // no delimiter
    expect(isBrokerQueueKey("::telegram:1")).toBe(false); // empty identity half
    expect(isBrokerQueueKey("identity:operator-a::")).toBe(false); // empty channel half
    expect(isBrokerQueueKey("operator-a::telegram:1")).toBe(false); // missing identity prefix
    expect(isBrokerQueueKey("")).toBe(false);
    expect(isBrokerQueueKey(undefined)).toBe(false);
    expect(isBrokerQueueKey(null)).toBe(false);
    expect(isBrokerQueueKey(42)).toBe(false);
    expect(isBrokerQueueKey({})).toBe(false);
  });
});

describe("BrokerQueueKey brand discipline", () => {
  it("rejects assignment from raw string at the type level", () => {
    // @ts-expect-error — raw string is not a BrokerQueueKey; require buildBrokerQueueKey.
    const _wrong: BrokerQueueKey = "identity:foo::bar";
    void _wrong;
  });

  it("accepts assignment from buildBrokerQueueKey output at the type level", () => {
    const key: BrokerQueueKey = buildBrokerQueueKey(
      asIdentityId("identity:op"),
      "telegram:1",
    );
    expectTypeOf(key).toEqualTypeOf<BrokerQueueKey>();
  });
});

describe("BrokerEntry shape", () => {
  it("compiles with the documented field set", () => {
    const entry: BrokerEntry = {
      turnId: "turn-1",
      queueKey: buildBrokerQueueKey(
        asIdentityId("identity:op"),
        "telegram:1",
      ),
      enqueuedAtMs: 1_700_000_000_000,
      runTurn: async () => {
        // Phase 2 entries are inert envelopes; Phase 4 invokes runTurn.
      },
    };
    expectTypeOf(entry).toEqualTypeOf<BrokerEntry>();
    expect(typeof entry.runTurn).toBe("function");
  });
});

describe("BrokerOverflowReason closed set", () => {
  it("contains exactly the documented reasons", () => {
    expect([...BROKER_OVERFLOW_REASONS]).toEqual([
      "queue_depth_exceeded",
      "wait_timeout",
      "broker_shutdown",
    ]);
  });

  it("BrokerOverflowReason is the union of the closed set", () => {
    expectTypeOf<BrokerOverflowReason>().toEqualTypeOf<
      "queue_depth_exceeded" | "wait_timeout" | "broker_shutdown"
    >();
  });
});
