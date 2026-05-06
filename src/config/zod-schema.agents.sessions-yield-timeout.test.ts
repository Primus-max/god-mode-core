/**
 * Phase 9 — bug #3 (PolicyGate Full audit) — config schema acceptance for
 * `agents.sessionsYieldAbortSettleTimeoutMs`.
 *
 * Backward-compat: existing configs without this field continue to validate.
 * Forward-compat: bounds match `[1000, 120000]` ms (mirroring the agent
 * timeout schema convention) and reject out-of-range overrides.
 */
import { describe, expect, it } from "vitest";
import { AgentsSchema } from "./zod-schema.agents.js";

describe("agents schema — sessionsYieldAbortSettleTimeoutMs (bug #3)", () => {
  it("accepts an empty agents object (backward-compat)", () => {
    expect(() => AgentsSchema.parse({})).not.toThrow();
  });

  it("accepts a config WITHOUT the new field (backward-compat)", () => {
    expect(() => AgentsSchema.parse({ requireAgentId: true })).not.toThrow();
  });

  it("accepts a config WITH the new field at the recommended value (60 000 ms)", () => {
    expect(() => AgentsSchema.parse({ sessionsYieldAbortSettleTimeoutMs: 60_000 })).not.toThrow();
  });

  it("accepts the upper bound (120 000 ms)", () => {
    expect(() => AgentsSchema.parse({ sessionsYieldAbortSettleTimeoutMs: 120_000 })).not.toThrow();
  });

  it("accepts the lower bound (1 000 ms)", () => {
    expect(() => AgentsSchema.parse({ sessionsYieldAbortSettleTimeoutMs: 1_000 })).not.toThrow();
  });

  it("rejects values above 120 000 ms", () => {
    expect(() => AgentsSchema.parse({ sessionsYieldAbortSettleTimeoutMs: 200_000 })).toThrow();
  });

  it("rejects values below 1 000 ms", () => {
    expect(() => AgentsSchema.parse({ sessionsYieldAbortSettleTimeoutMs: 500 })).toThrow();
  });

  it("rejects non-integer values", () => {
    expect(() => AgentsSchema.parse({ sessionsYieldAbortSettleTimeoutMs: 30_000.5 })).toThrow();
  });

  it("rejects negative values", () => {
    expect(() => AgentsSchema.parse({ sessionsYieldAbortSettleTimeoutMs: -100 })).toThrow();
  });
});
