import { describe, expect, expectTypeOf, it } from "vitest";

import {
  DECAY_FLOOR,
  DEFAULT_HALF_LIFE_MS,
  DEFAULT_WINDOW_MS,
  FreshnessConfigSchema,
  MISSING_TIMESTAMP_POLICIES,
  resolveFreshnessConfig,
  type FreshnessConfig,
  type RecencyScored,
  type ResolvedFreshnessConfig,
} from "../freshness-config.js";

/**
 * Phase 2 — fail-first tests for the freshness type surface.
 *
 * Pure-types module: schema decode + resolved-config defaults +
 * generic shape on `RecencyScored<T>`. NO impl in this phase
 * (Phase 3 lands `scoreByRecency`, Phase 4 wires the contractor).
 */

describe("FreshnessConfigSchema — round-trip on every field combination", () => {
  it("accepts the empty config", () => {
    const parsed = FreshnessConfigSchema.parse({});
    expect(parsed).toEqual({});
  });

  it("accepts a full config", () => {
    const config: FreshnessConfig = {
      decayHalfLifeMs: 3 * 24 * 60 * 60 * 1000,
      defaultWindowMs: 14 * 24 * 60 * 60 * 1000,
      missingTimestampPolicy: "treat_as_now",
    };
    const parsed = FreshnessConfigSchema.parse(config);
    expect(parsed).toEqual(config);
  });

  it("accepts partial config (only decayHalfLifeMs)", () => {
    const parsed = FreshnessConfigSchema.parse({
      decayHalfLifeMs: 60 * 60 * 1000,
    });
    expect(parsed.decayHalfLifeMs).toBe(60 * 60 * 1000);
    expect(parsed.defaultWindowMs).toBeUndefined();
    expect(parsed.missingTimestampPolicy).toBeUndefined();
  });

  it("accepts partial config (only missingTimestampPolicy)", () => {
    const parsed = FreshnessConfigSchema.parse({
      missingTimestampPolicy: "penalize_to_floor",
    });
    expect(parsed.missingTimestampPolicy).toBe("penalize_to_floor");
  });
});

describe("FreshnessConfigSchema — strict rejections", () => {
  it("rejects negative decayHalfLifeMs", () => {
    const result = FreshnessConfigSchema.safeParse({ decayHalfLifeMs: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects zero decayHalfLifeMs (must be >= 1)", () => {
    const result = FreshnessConfigSchema.safeParse({ decayHalfLifeMs: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects fractional decayHalfLifeMs (integer required)", () => {
    const result = FreshnessConfigSchema.safeParse({ decayHalfLifeMs: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects zero defaultWindowMs (must be >= 1)", () => {
    const result = FreshnessConfigSchema.safeParse({ defaultWindowMs: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects negative defaultWindowMs", () => {
    const result = FreshnessConfigSchema.safeParse({ defaultWindowMs: -100 });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys (.strict() posture)", () => {
    // Untyped object: TypeScript would tighten via the Zod input type
    // and reject the unknown property at compile time. The decode
    // boundary itself ALSO rejects at runtime — that is what this
    // test asserts.
    const input: Record<string, unknown> = {
      decayHalfLifeMs: 1000,
      bogusField: "nope",
    };
    const result = FreshnessConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects bad missingTimestampPolicy enum value", () => {
    const result = FreshnessConfigSchema.safeParse({
      missingTimestampPolicy: "drop",
    });
    expect(result.success).toBe(false);
  });

  it("rejects null / array / non-object input", () => {
    expect(FreshnessConfigSchema.safeParse(null).success).toBe(false);
    expect(FreshnessConfigSchema.safeParse([]).success).toBe(false);
    expect(FreshnessConfigSchema.safeParse("oops").success).toBe(false);
  });
});

describe("FreshnessConfigSchema — closed-set discriminator", () => {
  it("accepts both sanctioned policies", () => {
    expect(
      FreshnessConfigSchema.safeParse({ missingTimestampPolicy: "penalize_to_floor" })
        .success,
    ).toBe(true);
    expect(
      FreshnessConfigSchema.safeParse({ missingTimestampPolicy: "treat_as_now" })
        .success,
    ).toBe(true);
  });

  it("exposes MISSING_TIMESTAMP_POLICIES tuple frozen", () => {
    expect(MISSING_TIMESTAMP_POLICIES).toEqual([
      "penalize_to_floor",
      "treat_as_now",
    ]);
    expect(Object.isFrozen(MISSING_TIMESTAMP_POLICIES)).toBe(true);
  });
});

describe("resolveFreshnessConfig — default application", () => {
  it("applies all defaults when input omitted", () => {
    const resolved = resolveFreshnessConfig(undefined);
    expect(resolved.decayHalfLifeMs).toBe(DEFAULT_HALF_LIFE_MS);
    expect(resolved.defaultWindowMs).toBe(DEFAULT_WINDOW_MS);
    expect(resolved.missingTimestampPolicy).toBe("penalize_to_floor");
  });

  it("applies all defaults when input is the empty object", () => {
    const resolved = resolveFreshnessConfig({});
    expect(resolved.decayHalfLifeMs).toBe(DEFAULT_HALF_LIFE_MS);
    expect(resolved.defaultWindowMs).toBe(DEFAULT_WINDOW_MS);
    expect(resolved.missingTimestampPolicy).toBe("penalize_to_floor");
  });

  it("preserves caller-supplied fields and fills the rest", () => {
    const resolved = resolveFreshnessConfig({ decayHalfLifeMs: 1234 });
    expect(resolved.decayHalfLifeMs).toBe(1234);
    expect(resolved.defaultWindowMs).toBe(DEFAULT_WINDOW_MS);
    expect(resolved.missingTimestampPolicy).toBe("penalize_to_floor");
  });

  it("preserves all caller-supplied fields when fully populated", () => {
    const resolved = resolveFreshnessConfig({
      decayHalfLifeMs: 100,
      defaultWindowMs: 200,
      missingTimestampPolicy: "treat_as_now",
    });
    expect(resolved).toEqual({
      decayHalfLifeMs: 100,
      defaultWindowMs: 200,
      missingTimestampPolicy: "treat_as_now",
    });
  });
});

describe("Constants — exact numeric values", () => {
  it("DECAY_FLOOR === 0.05", () => {
    expect(DECAY_FLOOR).toBe(0.05);
  });

  it("DEFAULT_HALF_LIFE_MS === 7d in milliseconds", () => {
    expect(DEFAULT_HALF_LIFE_MS).toBe(7 * 24 * 60 * 60 * 1000);
    // Self-check: 604_800_000 ms.
    expect(DEFAULT_HALF_LIFE_MS).toBe(604_800_000);
  });

  it("DEFAULT_WINDOW_MS === 30d in milliseconds", () => {
    expect(DEFAULT_WINDOW_MS).toBe(30 * 24 * 60 * 60 * 1000);
    // Self-check: 2_592_000_000 ms.
    expect(DEFAULT_WINDOW_MS).toBe(2_592_000_000);
  });
});

describe("RecencyScored<T> — generic shape discipline", () => {
  it("preserves the item type parameter", () => {
    type Memory = { readonly id: string; readonly content: string };
    const sample: RecencyScored<Memory> = {
      item: { id: "mem:001", content: "hello" },
      recencyDecay: 0.5,
      ageMs: 1000,
    };
    expectTypeOf(sample.item).toEqualTypeOf<Memory>();
    expectTypeOf(sample.recencyDecay).toEqualTypeOf<number>();
    expectTypeOf(sample.ageMs).toEqualTypeOf<number | null>();
  });

  it("admits null ageMs (penalize_to_floor / unparseable timestamp)", () => {
    const sample: RecencyScored<{ readonly v: number }> = {
      item: { v: 42 },
      recencyDecay: DECAY_FLOOR,
      ageMs: null,
    };
    expect(sample.ageMs).toBeNull();
    expect(sample.recencyDecay).toBe(DECAY_FLOOR);
  });

  it("ResolvedFreshnessConfig has all fields required (post-resolve)", () => {
    expectTypeOf<ResolvedFreshnessConfig>().toEqualTypeOf<{
      readonly decayHalfLifeMs: number;
      readonly defaultWindowMs: number;
      readonly missingTimestampPolicy: "penalize_to_floor" | "treat_as_now";
    }>();
  });
});
