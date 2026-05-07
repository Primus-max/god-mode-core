import { describe, expect, it } from "vitest";

import {
  DECAY_FLOOR,
  DEFAULT_HALF_LIFE_MS,
  resolveFreshnessConfig,
  type ResolvedFreshnessConfig,
} from "../freshness-config.js";
import { scoreByRecency } from "../score-by-recency.js";

/**
 * Phase 3 — fail-first tests for `scoreByRecency<T>(...)`.
 *
 * The helper is pure: clock injected via `nowMs`, no I/O, no
 * logger. Tests inject deterministic `nowMs` + a fully-resolved
 * `ResolvedFreshnessConfig` so every assertion is reproducible.
 */

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

const NOW_MS = 1_700_000_000_000; // 2023-11-14T22:13:20Z — deterministic
const PENALIZE: ResolvedFreshnessConfig = resolveFreshnessConfig(undefined);
const TREAT_AS_NOW: ResolvedFreshnessConfig = resolveFreshnessConfig({
  missingTimestampPolicy: "treat_as_now",
});

describe("scoreByRecency — empty + degenerate inputs", () => {
  it("returns an empty array on empty input", () => {
    const out = scoreByRecency({
      items: [],
      getTimestamp: () => 0,
      nowMs: NOW_MS,
      config: PENALIZE,
    });
    expect(out).toEqual([]);
    expect(out.length).toBe(0);
  });
});

describe("scoreByRecency — single-item math", () => {
  it("score = 1.0 when ageMs = 0 (timestamp == nowMs)", () => {
    const out = scoreByRecency({
      items: [{ id: "a", ts: NOW_MS }],
      getTimestamp: (it) => it.ts,
      nowMs: NOW_MS,
      config: PENALIZE,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.item.id).toBe("a");
    expect(out[0]!.recencyDecay).toBe(1.0);
    expect(out[0]!.ageMs).toBe(0);
  });

  it("score ≈ 0.5 at exactly one half-life of age", () => {
    // Default half-life is 7d.
    const out = scoreByRecency({
      items: [{ id: "halflife", ts: NOW_MS - DEFAULT_HALF_LIFE_MS }],
      getTimestamp: (it) => it.ts,
      nowMs: NOW_MS,
      config: PENALIZE,
    });
    expect(out).toHaveLength(1);
    // Math.pow(0.5, 1) === exactly 0.5 (no floating-point fuzz at
    // exponent=1) — assert the strict equality so any future
    // accidental rounding regresses the test.
    expect(out[0]!.recencyDecay).toBe(0.5);
    expect(out[0]!.ageMs).toBe(DEFAULT_HALF_LIFE_MS);
  });
});

describe("scoreByRecency — missing-timestamp policy branches", () => {
  it("penalize_to_floor: missing timestamp → ageMs=null, decay=DECAY_FLOOR", () => {
    const out = scoreByRecency({
      items: [{ id: "ghost" }],
      getTimestamp: () => null, // simulates legacy entry without recordedAt
      nowMs: NOW_MS,
      config: PENALIZE,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.ageMs).toBeNull();
    expect(out[0]!.recencyDecay).toBe(DECAY_FLOOR);
  });

  it("treat_as_now: missing timestamp → ageMs=0, decay=1.0", () => {
    const out = scoreByRecency({
      items: [{ id: "ghost" }],
      getTimestamp: () => undefined,
      nowMs: NOW_MS,
      config: TREAT_AS_NOW,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.ageMs).toBe(0);
    expect(out[0]!.recencyDecay).toBe(1.0);
  });
});

describe("scoreByRecency — ordering", () => {
  it("two items different ages: fresher one sorted first", () => {
    const fresh = { id: "fresh", ts: NOW_MS - ONE_HOUR_MS };
    const stale = { id: "stale", ts: NOW_MS - 6 * ONE_DAY_MS };
    // Pass STALE first to force the helper to actually reorder.
    const out = scoreByRecency({
      items: [stale, fresh],
      getTimestamp: (it) => it.ts,
      nowMs: NOW_MS,
      config: PENALIZE,
    });
    expect(out.map((s) => s.item.id)).toEqual(["fresh", "stale"]);
    expect(out[0]!.recencyDecay).toBeGreaterThan(out[1]!.recencyDecay);
  });

  it("stable sort: identical timestamps preserve original order", () => {
    // Three items, ALL at exactly NOW_MS - ONE_HOUR_MS, distinct ids.
    const tsCommon = NOW_MS - ONE_HOUR_MS;
    const items = [
      { id: "first", ts: tsCommon },
      { id: "second", ts: tsCommon },
      { id: "third", ts: tsCommon },
    ];
    const out = scoreByRecency({
      items,
      getTimestamp: (it) => it.ts,
      nowMs: NOW_MS,
      config: PENALIZE,
    });
    expect(out.map((s) => s.item.id)).toEqual(["first", "second", "third"]);
    // All three should have identical decay so the tiebreaker is the
    // ONLY thing keeping the ordering deterministic.
    expect(out[0]!.recencyDecay).toBe(out[1]!.recencyDecay);
    expect(out[1]!.recencyDecay).toBe(out[2]!.recencyDecay);
  });
});

describe("scoreByRecency — clock-skew / extreme age boundaries", () => {
  it("future-stamped entry (negative raw age) → recencyDecay capped at 1.0", () => {
    // Clock-skew vector: extractor host clock ahead of contractor host.
    const future = { id: "future", ts: NOW_MS + 5 * ONE_DAY_MS };
    const out = scoreByRecency({
      items: [future],
      getTimestamp: (it) => it.ts,
      nowMs: NOW_MS,
      config: PENALIZE,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.recencyDecay).toBe(1.0);
    // Age clamped to 0 — invariant #15 fail-soft: future-stamped
    // entry must not produce a >1.0 multiplier or a negative
    // ageMs leak.
    expect(out[0]!.ageMs).toBe(0);
  });

  it("very old entry (10× half-life) → recencyDecay floored at DECAY_FLOOR", () => {
    const ancient = {
      id: "ancient",
      ts: NOW_MS - 10 * DEFAULT_HALF_LIFE_MS,
    };
    const out = scoreByRecency({
      items: [ancient],
      getTimestamp: (it) => it.ts,
      nowMs: NOW_MS,
      config: PENALIZE,
    });
    expect(out).toHaveLength(1);
    // Math.pow(0.5, 10) = 0.0009765625, which is below DECAY_FLOOR
    // (0.05) — assert the floor wins.
    expect(out[0]!.recencyDecay).toBe(DECAY_FLOOR);
    expect(out[0]!.ageMs).toBe(10 * DEFAULT_HALF_LIFE_MS);
  });
});

describe("scoreByRecency — configurable half-life", () => {
  it("1h half-life with 1h-old entry yields exactly 0.5", () => {
    const config: ResolvedFreshnessConfig = resolveFreshnessConfig({
      decayHalfLifeMs: ONE_HOUR_MS,
    });
    const out = scoreByRecency({
      items: [{ id: "h", ts: NOW_MS - ONE_HOUR_MS }],
      getTimestamp: (it) => it.ts,
      nowMs: NOW_MS,
      config,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.recencyDecay).toBe(0.5);
    expect(out[0]!.ageMs).toBe(ONE_HOUR_MS);
  });
});

describe("scoreByRecency — generic over T", () => {
  it("works on {id, ts} payloads (memory-style)", () => {
    type Mem = { readonly id: string; readonly ts: number };
    const items: Mem[] = [
      { id: "m1", ts: NOW_MS - ONE_HOUR_MS },
      { id: "m2", ts: NOW_MS - 5 * ONE_HOUR_MS },
    ];
    const out = scoreByRecency<Mem>({
      items,
      getTimestamp: (it) => it.ts,
      nowMs: NOW_MS,
      config: PENALIZE,
    });
    expect(out.map((s) => s.item.id)).toEqual(["m1", "m2"]);
    // Item shape preserved verbatim — generic identity.
    expect(out[0]!.item).toBe(items[0]);
  });

  it("works on {name, recordedAt} payloads (task-style)", () => {
    type Task = { readonly name: string; readonly recordedAt: number };
    const items: Task[] = [
      { name: "old", recordedAt: NOW_MS - 3 * ONE_DAY_MS },
      { name: "new", recordedAt: NOW_MS - 30 * 60 * 1000 }, // 30 min ago
    ];
    const out = scoreByRecency<Task>({
      items,
      getTimestamp: (it) => it.recordedAt,
      nowMs: NOW_MS,
      config: PENALIZE,
    });
    expect(out.map((s) => s.item.name)).toEqual(["new", "old"]);
  });
});

describe("scoreByRecency — purity / non-mutation", () => {
  it("does NOT mutate the input array (length, order, identity)", () => {
    const original = [
      { id: "stale", ts: NOW_MS - 30 * ONE_DAY_MS },
      { id: "fresh", ts: NOW_MS - ONE_HOUR_MS },
      { id: "mid", ts: NOW_MS - 3 * ONE_DAY_MS },
    ];
    const snapshot = original.map((x) => x); // shallow snapshot
    const out = scoreByRecency({
      items: original,
      getTimestamp: (it) => it.ts,
      nowMs: NOW_MS,
      config: PENALIZE,
    });
    // Output reordered fresh→mid→stale; input untouched.
    expect(out.map((s) => s.item.id)).toEqual(["fresh", "mid", "stale"]);
    expect(original).toEqual(snapshot);
    // Object identity preserved per slot in the input.
    expect(original[0]).toBe(snapshot[0]);
    expect(original[1]).toBe(snapshot[1]);
    expect(original[2]).toBe(snapshot[2]);
  });

  it("does NOT mutate item objects (decay/ageMs not attached to source)", () => {
    const item = { id: "x", ts: NOW_MS - ONE_HOUR_MS };
    const out = scoreByRecency({
      items: [item],
      getTimestamp: (it) => it.ts,
      nowMs: NOW_MS,
      config: PENALIZE,
    });
    expect(out).toHaveLength(1);
    // The envelope item is the SAME reference (no clone), so no
    // accidental copy cost; but the source object MUST NOT have
    // gained the decay/ageMs fields.
    expect(out[0]!.item).toBe(item);
    expect(Object.keys(item).sort()).toEqual(["id", "ts"]);
  });
});

describe("scoreByRecency — NaN / non-finite tolerance (#15 fail-soft)", () => {
  it("NaN timestamp falls into missing-timestamp branch (penalize_to_floor)", () => {
    // Phase 4 contractor will use Date.parse() on metadata.recordedAt,
    // which can return NaN for unparseable strings. The helper must
    // treat NaN as missing — this is the load-bearing fail-soft path.
    const out = scoreByRecency({
      items: [{ id: "bad", raw: "not-an-iso" }],
      getTimestamp: () => Number.NaN,
      nowMs: NOW_MS,
      config: PENALIZE,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.ageMs).toBeNull();
    expect(out[0]!.recencyDecay).toBe(DECAY_FLOOR);
  });
});
