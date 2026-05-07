import { z } from "zod";

/**
 * Slice "intent-contractor freshness/recency" — Phase 2 (types only).
 *
 * Pure-types module for the operator-facing freshness/recency
 * weighting that the `IntentContractor` will apply to recalled
 * `<memory>` entries (slice E P6) and `<active_tasks>` rows (slice F
 * P6). Phase 2 ships ONLY the `FreshnessConfig` shape, the
 * `RecencyScored<T>` envelope, the floor / window / half-life
 * constants, the Zod decode schema, and the `resolveFreshnessConfig`
 * default-application helper. NO scoring impl lives here — Phase 3
 * lands the pure `scoreByRecency<T>(...)` helper, Phase 4 wires the
 * contractor.
 *
 * Per invariant #8, this module imports ONLY Zod and the standard
 * library. It does NOT touch `src/platform/commitment/` (the
 * five-contract frozen layer per invariant #11), does NOT widen
 * `MemoryStore`, and does NOT register any new effect family.
 *
 * Per invariants #5/#6, this module never receives a `RawUserTurn`
 * / `UserPrompt`. The decay function reads numeric epoch ms +
 * ISO-8601 / scalar metadata only — no regex on raw text.
 *
 * Per invariant #15, decode failures degrade to typed Zod errors
 * (caller decides). The Phase 3 helper will be NaN-tolerant so that
 * malformed `recordedAt` values never throw at runtime.
 *
 * Audit: `extensions/AUDIT-intent-contractor-freshness.md` §c.3 +
 * §d. Sub-plan: `.cursor/plans/commitment_kernel_intent_contractor_freshness.plan.md`.
 */

/**
 * Floor on the multiplier produced by the Phase 3 decay helper.
 * Entries older than ~4.3 half-lives would otherwise contribute
 * vanishing weight; the floor ensures legacy entries WITHOUT a
 * timestamp (and very old entries) are still eligible to surface in
 * the prompt rather than being silently dropped. Sub-plan §6 + audit
 * §d. The Phase 3 helper applies this floor; the cap (`<= 1.0`) is
 * documented in the audit and enforced by the same helper.
 */
export const DECAY_FLOOR = 0.05;

/**
 * Default half-life for the exponential decay multiplier — 7 days.
 * Mirrors the Slice K reminder window precedent (sub-plan §3, todo
 * `freshness-phase-2-types`). At `ageMs = decayHalfLifeMs` the decay
 * multiplier is `0.5`; at two half-lives `0.25`; floored at
 * `DECAY_FLOOR`.
 */
export const DEFAULT_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Default operator-visible recall window — 30 days. Used by the
 * Phase 4 `<freshness_hints>` block to advertise the temporal frame
 * the LLM operates within. Independent of the decay half-life so
 * the two can be tuned separately.
 */
export const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Closed-set discriminator for how the Phase 3 helper treats an
 * entry whose timestamp is missing or unparseable.
 *
 * - `penalize_to_floor` — the slice DEFAULT. Entry survives the
 *   reorder at `recencyDecay = DECAY_FLOOR`, `ageMs = null`. Legacy
 *   memory entries written before the Phase 4 extractor edit fall
 *   through this branch.
 * - `treat_as_now` — entry treated as freshly recorded:
 *   `recencyDecay = 1.0`, `ageMs = 0`. Useful in unit tests and in
 *   deployments where the upstream guarantees a timestamp on every
 *   entry.
 */
export const MISSING_TIMESTAMP_POLICIES = Object.freeze([
  "penalize_to_floor",
  "treat_as_now",
] as const);

export type MissingTimestampPolicy = (typeof MISSING_TIMESTAMP_POLICIES)[number];

/**
 * Operator-tunable freshness weighting parameters. All fields
 * optional; the Phase 4 contractor calls `resolveFreshnessConfig`
 * to fill defaults. Validated at decode by `FreshnessConfigSchema`.
 *
 * Audit §d records the rationale for each default; sub-plan §6
 * names the precedents (Slice K reminder window for the half-life;
 * legacy-entry tolerance for the missing-timestamp policy).
 */
export type FreshnessConfig = {
  /**
   * Half-life of the exponential decay multiplier in milliseconds.
   * Default `DEFAULT_HALF_LIFE_MS` (7 days). Must be a positive
   * integer (>= 1) at the decode boundary.
   */
  readonly decayHalfLifeMs?: number;
  /**
   * Operator-visible recall window in milliseconds; surfaces in the
   * Phase 4 `<freshness_hints>` block. Default `DEFAULT_WINDOW_MS`
   * (30 days). Must be a positive integer (>= 1) at decode.
   */
  readonly defaultWindowMs?: number;
  /**
   * How the Phase 3 helper handles entries with missing /
   * unparseable timestamps. Default `'penalize_to_floor'`.
   */
  readonly missingTimestampPolicy?: MissingTimestampPolicy;
};

/**
 * Same shape as `FreshnessConfig` but with every field REQUIRED —
 * the post-default-resolution form. The Phase 3 helper accepts
 * `ResolvedFreshnessConfig`; the Phase 4 contractor resolves the
 * caller-supplied `FreshnessConfig` exactly once per `classify`
 * call so all reorder paths see the same parameters (lock-step
 * consistency, audit §c.3).
 */
export type ResolvedFreshnessConfig = {
  readonly decayHalfLifeMs: number;
  readonly defaultWindowMs: number;
  readonly missingTimestampPolicy: MissingTimestampPolicy;
};

/**
 * Envelope returned by the Phase 3 `scoreByRecency<T>` helper. The
 * generic parameter `T` carries the original payload (a
 * `SemanticMemoryEntry` for `<memory>`, a `TaskRecord` for
 * `<active_tasks>`) — the helper never mutates the item.
 *
 * - `recencyDecay` is floored at `DECAY_FLOOR` and capped at `1.0`
 *   (audit §d cap covers clock-skew / future-stamped entries).
 * - `ageMs` is `null` when the entry has no parseable timestamp AND
 *   the resolved policy is `'penalize_to_floor'`. When the policy
 *   is `'treat_as_now'` the helper reports `ageMs = 0`. Negative
 *   ageMs (clock skew) is preserved verbatim so downstream
 *   telemetry can detect the skew without the cap silently masking
 *   it.
 */
export type RecencyScored<T> = {
  readonly item: T;
  readonly recencyDecay: number;
  readonly ageMs: number | null;
};

/**
 * Inline positive-integer constraint reused for both numeric
 * fields. Zod `.int()` rejects fractional values; `.min(1)` rejects
 * zero and negative values in one refinement.
 */
const PositiveIntegerSchema = z.number().int().min(1);

/**
 * Zod schema for `FreshnessConfig`. Strict posture: any unknown key
 * is rejected at decode (sub-plan acceptance for Phase 2). Each
 * field is independently optional; the empty object decodes
 * successfully and `resolveFreshnessConfig` is responsible for
 * applying defaults.
 *
 * Decode rejections covered:
 * - `decayHalfLifeMs <= 0` or fractional
 * - `defaultWindowMs <= 0` or fractional
 * - `missingTimestampPolicy` outside the closed set
 * - any unknown top-level key
 * - non-object input (null, array, string, number)
 */
export const FreshnessConfigSchema = z
  .object({
    decayHalfLifeMs: PositiveIntegerSchema.optional(),
    defaultWindowMs: PositiveIntegerSchema.optional(),
    missingTimestampPolicy: z
      .enum(MISSING_TIMESTAMP_POLICIES)
      .optional(),
  })
  .strict();

/**
 * Apply Phase 2 defaults to a caller-supplied `FreshnessConfig`,
 * returning a fully-populated `ResolvedFreshnessConfig`.
 *
 * Pure function — no clock, no logger, no mutation. The Phase 4
 * contractor calls this exactly once per `classify` call (sub-plan
 * §6, audit §c.3). Phase 3 tests inject the resolved config
 * directly to keep the helper deterministic.
 */
export function resolveFreshnessConfig(
  input: FreshnessConfig | undefined,
): ResolvedFreshnessConfig {
  return {
    decayHalfLifeMs: input?.decayHalfLifeMs ?? DEFAULT_HALF_LIFE_MS,
    defaultWindowMs: input?.defaultWindowMs ?? DEFAULT_WINDOW_MS,
    missingTimestampPolicy: input?.missingTimestampPolicy ?? "penalize_to_floor",
  };
}
