import type { IdentityId } from "../identity/identity-id.js";

import type { EpisodicEffectFamily, EpisodicMemoryEvent } from "./episodic-memory-event.js";
import type { MemoryEntryId } from "./memory-entry-id.js";
import type {
  MemoryRecallResult,
  SemanticMemoryEntry,
  SemanticMemoryQuery,
  SemanticMemoryWrite,
} from "./semantic-memory.js";

/**
 * Optional pagination + filter for `MemoryStore.list`. All fields are
 * optional. When omitted, the store returns every entry it has for the
 * given identity, in implementation-defined-but-stable order.
 *
 * `limit` caps the number of results. `effectFamily`, when set,
 * restricts to a single episodic family — useful for slice F's
 * "list reminders for this operator" surface in a later slice.
 *
 * Phase 1 ships only the type; Phase 2 (`InMemoryMemoryStore`)
 * implements stable ordering by insertion time.
 */
export type MemoryListQuery = {
  readonly identityId: IdentityId;
  readonly effectFamily?: EpisodicEffectFamily;
  readonly limit?: number;
};

/**
 * One row returned by `MemoryStore.list` for an episodic event.
 * Carries the assigned `MemoryEntryId` plus the event payload. The
 * `effectFamily` is repeated outside the event for cheap filtering at
 * the storage layer (Phase 3 indexes on it).
 */
export type EpisodicMemoryListing = {
  readonly id: MemoryEntryId;
  readonly event: EpisodicMemoryEvent;
};

/**
 * Result shape for `MemoryStore.list`. Two parallel arrays: one for
 * episodic listings, one for semantic entries. A consumer that only
 * cares about one surface can ignore the other.
 *
 * Both arrays are always present (never `undefined`); empty means "no
 * entries" — the same no-op contract as `MemoryRecallResult.entries`.
 */
export type MemoryListResult = {
  readonly episodic: readonly EpisodicMemoryListing[];
  readonly semantic: readonly SemanticMemoryEntry[];
};

/**
 * Memory store contract — the single seam through which every
 * commitment-kernel slice writes or reads persistent operator memory.
 *
 * Keys on `IdentityId` (slice D). The store NEVER receives a
 * `RawUserTurn` / `UserPrompt` / `SessionId` as a primary key — those
 * brands are out-of-scope by design (per invariant #16 they are
 * distinct types and the compiler enforces non-substitutability;
 * `memory-store.contract.test.ts` enforces this with `@ts-expect-error`).
 *
 * Implementations may be:
 * - in-memory (Phase 2 — Map-backed, zero I/O — for tests + early
 *   integration);
 * - sqlite-vec-backed (Phase 3 — persistent, vector-similarity recall);
 * - LLM-extracted on top of sqlite-vec (Phase 4 — mem0 wrapper or
 *   in-house extractor).
 *
 * All implementations MUST honour:
 * - `recall` returns `{ entries: [] }` (never throws) when nothing
 *   matches;
 * - missing `IdentityId` is a caller bug, not a store bug — the store
 *   is permitted to throw on a malformed brand, but every emit site
 *   in higher slices is responsible for skipping the call cleanly
 *   when no identity is resolved (invariant #5/#6 + acceptance #5);
 * - backend write failures are SURFACED (rejected promise) but DO NOT
 *   downgrade the calling commitment — slice E Phase 5's hook catches
 *   the rejection and logs it without re-throwing (acceptance #5).
 *
 * `forget` is required for compliance / opt-out paths in later slices;
 * the in-memory and sqlite-vec impls support it directly. Forgetting a
 * non-existent id is a no-op (resolves successfully) — NOT an error.
 *
 * Phase 1 ships ONLY this interface — no impl, no callers wire it in.
 * Phase 2 lands the in-memory impl; Phases 3-7 wire impl + call sites.
 */
export interface MemoryStore {
  /**
   * Append an episodic event to the operator's log. Returns the
   * assigned `MemoryEntryId` so the caller can correlate the write
   * with later observability (e.g. logging the id in the
   * commitment-runtime hook trace). Resolves the new id on success;
   * rejects on backend failure.
   */
  storeEpisodic(event: EpisodicMemoryEvent): Promise<MemoryEntryId>;

  /**
   * Add a semantic entry (free-form fact + metadata) to the
   * operator's memory. Returns the assigned `MemoryEntryId`. Same
   * failure semantics as `storeEpisodic`.
   */
  storeSemantic(write: SemanticMemoryWrite): Promise<MemoryEntryId>;

  /**
   * Recall semantic entries similar to `query.query`, scoped to
   * `query.identityId`. Returns at most `query.limit` entries (or the
   * store's default cap when omitted). Returns `{ entries: [] }` when
   * nothing matches — never throws on no-match.
   */
  recall(query: SemanticMemoryQuery): Promise<MemoryRecallResult>;

  /**
   * List every entry (episodic + semantic) for the given identity,
   * optionally filtered to a single episodic family. Result fields
   * are always arrays (possibly empty). Used by slice G (subagent
   * registry persistence) and slice F (task ledger) to enumerate
   * their stored events in later phases.
   */
  list(query: MemoryListQuery): Promise<MemoryListResult>;

  /**
   * Remove one entry by id. Resolves successfully (no-op) when the
   * id is unknown — `forget` is idempotent. Rejects only on backend
   * failure (e.g. sqlite I/O error).
   *
   * The id is brand-typed, so a caller cannot accidentally pass an
   * `IdentityId` / `SessionId` / `EffectId` here — invariant #16 is
   * enforced at compile time.
   */
  forget(id: MemoryEntryId): Promise<void>;
}
