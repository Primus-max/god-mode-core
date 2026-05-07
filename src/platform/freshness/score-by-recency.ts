import {
  DECAY_FLOOR,
  type RecencyScored,
  type ResolvedFreshnessConfig,
} from "./freshness-config.js";

/**
 * Slice "intent-contractor freshness/recency" — Phase 3.
 *
 * Pure scoring helper. Given a list of items + a `getTimestamp`
 * extractor + a `nowMs` clock value + a `ResolvedFreshnessConfig`,
 * returns a NEW array of `RecencyScored<T>` envelopes sorted
 * descending by `recencyDecay` (freshest first). Stable on equal
 * decay — original order preserved for ties.
 *
 * Per invariants #5/#6 the helper never sees `RawUserTurn` /
 * `UserPrompt`. Per invariant #8 imports are limited to the sibling
 * Phase 2 types module + stdlib (no Zod, no logger, no clock).
 *
 * Per invariant #9/#10/#15 the helper is fail-soft and clock-injected:
 * - NO `Date.now()` inside — the caller passes `nowMs`.
 * - NO `throw` paths — NaN / negative / future timestamps degrade
 *   gracefully (negative ages clamped to 0, future stamps capped at
 *   `recencyDecay = 1.0`, `NaN` falls into the missing-timestamp
 *   branch dictated by `config.missingTimestampPolicy`).
 *
 * Audit: `extensions/AUDIT-intent-contractor-freshness.md` §c.3 + §d.
 * Sub-plan §6: clock-injection load-bearing; lock-step
 * `ResolvedFreshnessConfig` (resolved exactly once per `classify`).
 */

export type ScoreByRecencyDeps<T> = {
  readonly items: ReadonlyArray<T>;
  readonly getTimestamp: (item: T) => number | null | undefined;
  readonly nowMs: number;
  readonly config: ResolvedFreshnessConfig;
};

/**
 * Internal indexed envelope used to keep the sort stable: identical
 * `recencyDecay` values resolve in original index order rather than
 * relying on the (engine-dependent, post-V8 stable) `Array.sort`
 * contract. Stripped before returning.
 */
type IndexedScored<T> = RecencyScored<T> & { readonly __idx: number };

/**
 * Score one item — the Phase 3 contract per the sub-plan §6:
 *
 * 1. Resolve timestamp via `getTimestamp`.
 * 2. Missing/`null`/`undefined`/`NaN` → policy-driven branch:
 *      - `penalize_to_floor` → `ageMs = null`, `recencyDecay = DECAY_FLOOR`.
 *      - `treat_as_now`      → `ageMs = 0`,    `recencyDecay = 1.0`.
 * 3. Otherwise compute `ageMs = max(0, nowMs - tsMs)` (clock-skew
 *    futures clamp to age 0 so the cap below applies cleanly).
 * 4. `decay = 0.5 ^ (ageMs / decayHalfLifeMs)` — exponential
 *    half-life.
 * 5. Cap `decay` at 1.0; floor at `DECAY_FLOOR`.
 *
 * Pure: no side effects, no clock, no logger.
 */
function scoreOne<T>(
  item: T,
  getTimestamp: ScoreByRecencyDeps<T>["getTimestamp"],
  nowMs: number,
  config: ResolvedFreshnessConfig,
): RecencyScored<T> {
  const rawTs = getTimestamp(item);
  // `Number.isFinite` covers null/undefined/NaN/Infinity in one
  // predicate (typeof-coercion of null/undefined yields NaN/0
  // ambiguity; explicit `== null || NaN` would be equivalent but
  // noisier).
  const tsMissing =
    rawTs === null || rawTs === undefined || !Number.isFinite(rawTs);

  if (tsMissing) {
    if (config.missingTimestampPolicy === "treat_as_now") {
      return { item, recencyDecay: 1.0, ageMs: 0 };
    }
    // `penalize_to_floor` (default + only other branch in the
    // closed set).
    return { item, recencyDecay: DECAY_FLOOR, ageMs: null };
  }

  // `rawTs` is a finite number at this point — narrow for TS.
  const tsMs = rawTs as number;
  const rawAge = nowMs - tsMs;
  const ageMs = rawAge < 0 ? 0 : rawAge;

  const decayUncapped = Math.pow(0.5, ageMs / config.decayHalfLifeMs);
  // Cap at 1.0 first (zero-age yields exactly 1.0; future-stamped
  // entries clamped above), then floor at DECAY_FLOOR so any "older
  // than ~4.3 half-lives" tail still surfaces with non-zero weight.
  const capped = decayUncapped > 1.0 ? 1.0 : decayUncapped;
  const recencyDecay = capped < DECAY_FLOOR ? DECAY_FLOOR : capped;

  return { item, recencyDecay, ageMs };
}

/**
 * Pure scoring helper. See module docstring for the full contract.
 *
 * Returns a NEW readonly array sorted descending by `recencyDecay`.
 * Original `items` array is NOT mutated; original element order is
 * preserved as a stable tiebreaker on equal decay values.
 */
export function scoreByRecency<T>(
  deps: ScoreByRecencyDeps<T>,
): ReadonlyArray<RecencyScored<T>> {
  const { items, getTimestamp, nowMs, config } = deps;

  // Score every item, carrying the original index so the eventual
  // sort can break ties deterministically (and so this code is not
  // subject to engine `Array.sort` stability variance).
  const indexed: IndexedScored<T>[] = items.map((item, idx) => {
    const scored = scoreOne(item, getTimestamp, nowMs, config);
    return { ...scored, __idx: idx };
  });

  // Descending by recencyDecay; tie → ascending by original index.
  indexed.sort((a, b) => {
    if (b.recencyDecay !== a.recencyDecay) {
      return b.recencyDecay - a.recencyDecay;
    }
    return a.__idx - b.__idx;
  });

  // Strip the index before returning so the public envelope shape
  // matches `RecencyScored<T>` exactly.
  return indexed.map(({ item, recencyDecay, ageMs }) => ({
    item,
    recencyDecay,
    ageMs,
  }));
}
