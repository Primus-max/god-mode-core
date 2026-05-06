import type { IdentityId } from "../identity/identity-id.js";

import type { EffectFamilyId, EffectId } from "./ids.js";
import type { BudgetWindowId } from "./policy-gate-stages.js";

/**
 * Phase 4 — Stage 3 (Budgets) storage seam.
 *
 * `BudgetStore` is the persistence interface that
 * `createBudgetPolicy({cfg, budgetStore})` consults to read or
 * increment a budget window. The default production wiring binds this
 * interface to `SqliteBudgetStore` (sibling impl, slice E P3 pattern);
 * tests pass an in-memory fake.
 *
 * Architectural notes:
 *  1. **Per-`IdentityId` predicates.** Every read/write predicates on
 *     identity (when present) so cross-operator leakage is impossible
 *     at the SQL boundary, mirroring `SqliteVecMemoryStore` (slice E
 *     P3) and `SqliteTaskLedger` (slice F).
 *  2. **Window resolution is deterministic.** The store derives a
 *     `BudgetWindowId` from `(dimension, identityId?, channel?,
 *     effectFamily?, windowStart)`; the policy never mints ids
 *     directly. This keeps the SQL primary key stable across resets.
 *  3. **Atomic increments.** `increment` runs in a SQL transaction so
 *     concurrent turn-runners cannot race past the limit. The
 *     transaction also folds in the lazy-reset check (`Date.now() >
 *     windowEnd`) so a single round-trip handles both window roll
 *     and counter bump.
 *  4. **No cross-stage import.** This file imports only from sibling
 *     `commitment/` types and from `identity/`. It does NOT pull
 *     `decision/`, `runtime/`, or `infra/` — the storage seam stays
 *     orthogonal to the rest of the policy plumbing.
 */

/**
 * Three-axis dimension discriminator. Mirrors the orthogonal
 * `BUDGET_POLICY_REASONS = ['budget_exceeded_user',
 * 'budget_exceeded_channel', 'budget_exceeded_effect']` tuple
 * (Phase 2). The store uses this discriminator both to scope the
 * `WHERE` clause on read (a per-channel rule predicates on
 * `channel`, NOT on `identity_id`) and to mint the
 * `BudgetWindowId` deterministically.
 */
export type BudgetDimension = "user" | "channel" | "effect";

/**
 * Persistent budget window record.
 *
 * Field semantics:
 *  - `windowId` — branded id derived from `(dimension, identityId?,
 *    channel?, effectFamily?, windowStart)`. Stable across resets.
 *  - `dimension` — orthogonal axis (`'user' | 'channel' | 'effect'`).
 *  - `identityId` — populated only on `dimension === 'user'` rows.
 *    Other dimensions leave it `undefined` so a user-level reset does
 *    not collide with a per-channel row keyed on the same operator.
 *  - `channel` — populated on `dimension === 'channel'` rows
 *    (e.g. `'telegram'`); other dimensions leave it `undefined`.
 *  - `effectFamily` — populated on `dimension === 'effect'` rows
 *    (e.g. `'web_research'`); other dimensions leave it `undefined`.
 *  - `windowStart` / `windowEnd` — millisecond epoch boundaries. The
 *    store treats `Date.now() >= windowEnd` as a reset trigger
 *    (`used` is reset to 0 and the boundaries roll forward by
 *    `windowMs`).
 *  - `used` — count of charged invocations within the current window.
 *  - `limit` — configured maximum from `policy.budgets[]`. The
 *    `BudgetPolicyReader` denies when `used >= limit`.
 */
export type BudgetWindow = {
  readonly windowId: BudgetWindowId;
  readonly dimension: BudgetDimension;
  readonly identityId?: IdentityId;
  readonly channel?: string;
  readonly effectFamily?: EffectFamilyId;
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly used: number;
  readonly limit: number;
};

/**
 * Read query. Exactly one of `(identityId, channel, effectFamily)` is
 * populated per call — the store reads the row whose primary key
 * matches `(dimension, ...)`.
 */
export type BudgetReadQuery = {
  readonly dimension: BudgetDimension;
  readonly identityId?: IdentityId;
  readonly channel?: string;
  readonly effectFamily?: EffectFamilyId;
};

/**
 * Increment input. Carries the configured `limit` + `windowMs` so a
 * missing window can be created in the same transaction — the
 * `BudgetPolicyReader` does not need a separate `create` call.
 *
 * Field semantics:
 *  - `limit` — configured maximum (from `policy.budgets[].limit`).
 *  - `windowMs` — configured window duration (from
 *    `policy.budgets[].windowMs`). Used both to set
 *    `windowEnd = windowStart + windowMs` on creation and to roll
 *    a window forward when `Date.now() >= windowEnd` at read time.
 *  - `effectId` — optional. When present and `dimension === 'effect'`
 *    the store records the effectId on the row for telemetry (it
 *    does NOT extend the primary key — a single per-`effectFamily`
 *    row is shared across all `effectId` invocations within the
 *    family, keeping the registry consistent with the
 *    `EFFECT_FAMILY_REGISTRY` discipline).
 */
export type BudgetIncrementInput = BudgetReadQuery & {
  readonly limit: number;
  readonly windowMs: number;
  readonly effectId?: EffectId;
};

/**
 * Persistent budget store. Phase 4 ships two impls:
 *  - `SqliteBudgetStore` — production, sibling to slice E
 *    `SqliteVecMemoryStore`.
 *  - `InMemoryBudgetStore` — test fake, used by the policy tests so
 *    real SQLite I/O does not hit disk on every run.
 *
 * Both impls satisfy the same contract: per-identity isolation on
 * `dimension === 'user'` rows; atomic increment; lazy reset on
 * `Date.now() >= windowEnd`.
 */
export interface BudgetStore {
  /**
   * Reads the current window for the given `(dimension, key)`.
   * Returns `null` when the window has not yet been created (the
   * caller is expected to call `increment` to create it on first
   * charge).
   *
   * Lazy reset: when the on-disk `windowEnd` is already in the past
   * (`Date.now() >= windowEnd`), the store rolls the window forward
   * by `windowMs` (preserving `limit`) and returns the rolled
   * `BudgetWindow` with `used: 0`. The roll is itself transactional
   * — concurrent reads see the same post-roll state.
   */
  read(query: BudgetReadQuery): Promise<BudgetWindow | null>;

  /**
   * Atomically increments the `used` counter for the given
   * `(dimension, key)`. Creates the window when missing, rolls it
   * when expired, and bumps `used` by 1 in a single SQL
   * transaction. Returns the post-increment `BudgetWindow` so the
   * caller can compare `used` against `limit` without a follow-up
   * read.
   */
  increment(input: BudgetIncrementInput): Promise<BudgetWindow>;

  /**
   * Resets all windows whose `windowEnd <= now`. Returns the count
   * of windows reset (used for telemetry + cron-driven cleanup).
   * Safe to call concurrently with `read` / `increment` — both ops
   * are wrapped in their own transactions and the reset only
   * touches expired rows.
   */
  resetExpired(now: number): Promise<number>;
}

/**
 * Branded helper that mints a deterministic `BudgetWindowId` from
 * `(dimension, key, windowStart)`. The format is intentionally
 * pipe-delimited so the id is human-readable in logs (helpful for
 * sub-plan §3 acceptance — `event=budget_exceeded window_id=…`).
 *
 * The function is exported so both the policy reader and the store
 * (and tests) can produce the same id without a round-trip through
 * SQL — this matters for the wiring path where the policy reader
 * surfaces `windowId` on the decision payload before the store
 * write completes (the decision must remain stable even if the
 * store write fails per invariant #15 — observability MUST NOT gate
 * the calling commitment turn).
 */
export function buildBudgetWindowId(params: {
  readonly dimension: BudgetDimension;
  readonly identityId?: IdentityId;
  readonly channel?: string;
  readonly effectFamily?: EffectFamilyId;
  readonly windowStart: number;
}): BudgetWindowId {
  // Build a single canonical string. Empty key parts collapse to
  // empty strings (the dimension already disambiguates). The
  // `windowStart` ms epoch keeps the id stable for the duration of
  // the current window and rolls forward on reset.
  const key =
    params.dimension === "user"
      ? String(params.identityId ?? "")
      : params.dimension === "channel"
        ? String(params.channel ?? "")
        : String(params.effectFamily ?? "");
  return `budget:${params.dimension}:${key}:${params.windowStart}` as BudgetWindowId;
}
