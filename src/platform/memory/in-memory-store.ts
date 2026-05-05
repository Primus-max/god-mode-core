import type { IdentityId } from "../identity/identity-id.js";

import {
  EpisodicMemoryEventSchema,
  type EpisodicEffectFamily,
  type EpisodicMemoryEvent,
} from "./episodic-memory-event.js";
import { asMemoryEntryId, type MemoryEntryId } from "./memory-entry-id.js";
import type {
  EpisodicMemoryListing,
  MemoryListQuery,
  MemoryListResult,
  MemoryStore,
} from "./memory-store.js";
import {
  SemanticMemoryQuerySchema,
  SemanticMemoryWriteSchema,
  type MemoryRecallResult,
  type SemanticMemoryEntry,
  type SemanticMemoryMetadata,
  type SemanticMemoryQuery,
  type SemanticMemoryWrite,
} from "./semantic-memory.js";

/**
 * Default cap for `recall` and `list` when the caller does not supply
 * an explicit `limit`. Chosen high enough that early integration
 * (slices F / G / J) does not surprise callers with a small bound, but
 * still finite so tests and callers cannot accidentally pull an
 * unbounded snapshot of memory into memory.
 */
const DEFAULT_LIMIT = 50;

/**
 * Phase-2-only extension of `MemoryListQuery` that carries an opaque
 * `after` cursor. The slice-E Phase 1 interface (`MemoryListQuery`)
 * intentionally does NOT name a cursor — Phase 1 froze the interface
 * shape on dev. Phase 2 adds the cursor through a CLASS-LEVEL method
 * (`listPaginated`) rather than widening the frozen interface, so the
 * interface stays stable for slices F / G / J and the persistent
 * Phase-3 backend can adopt the same cursor convention later.
 *
 * `after` names the last `MemoryEntryId` the caller has already seen;
 * `listPaginated` returns entries strictly after it in stable
 * insertion order. An unknown cursor is treated as past-the-end and
 * returns an empty page (NOT an error) — pagination is forgiving.
 */
export type InMemoryListPaginatedQuery = {
  readonly identityId: IdentityId;
  readonly effectFamily?: EpisodicEffectFamily;
  readonly limit?: number;
  readonly after?: MemoryEntryId;
};

/**
 * Internal record for a stored episodic event — the assigned id plus
 * the event payload. Mirrors `EpisodicMemoryListing` exactly; the
 * separation is for future-proofing if the in-memory impl ever needs
 * to track storage-only metadata (e.g. a write-time monotonic counter
 * for stable ordering even when ids are random).
 */
type StoredEpisodic = {
  readonly id: MemoryEntryId;
  readonly event: EpisodicMemoryEvent;
};

/**
 * Internal record for a stored semantic entry. Carries everything a
 * `SemanticMemoryEntry` carries except `score`, which is computed at
 * recall time per query — the stored record holds no per-query state.
 */
type StoredSemantic = {
  readonly id: MemoryEntryId;
  readonly identityId: IdentityId;
  readonly content: string;
  readonly metadata: SemanticMemoryMetadata;
};

/**
 * Map-backed `MemoryStore` impl with NO I/O. Every read and write is
 * synchronous-in-spirit (the async signature is for interface
 * conformance + a future persistent backend; the in-memory impl
 * resolves immediately).
 *
 * Storage layout:
 * - `episodicByIdentity` — `Map<IdentityId, StoredEpisodic[]>` keeps
 *   episodic events in insertion order per identity. Arrays (not Sets)
 *   guarantee stable, paginatable ordering for `list`.
 * - `semanticByIdentity` — `Map<IdentityId, StoredSemantic[]>` mirrors
 *   the episodic layout for semantic entries.
 *
 * Identity isolation is enforced by keying both maps on `IdentityId` —
 * a query for one identity NEVER reads another identity's array. There
 * is no cross-identity index of any kind.
 *
 * Per slice-E invariant #5/#6: the store accepts ONLY structured types
 * (`EpisodicMemoryEvent`, `SemanticMemoryWrite`, `SemanticMemoryQuery`).
 * Inputs are re-validated via the Phase-1 Zod schemas at the call
 * site; a malformed event is a caller bug and is rejected synchronously
 * (the returned promise rejects with the underlying ZodError).
 *
 * Per slice-E invariant #8: this module imports only from
 * `src/platform/identity/`, the Phase-1 memory module, Node stdlib,
 * and Zod (transitively via the Phase-1 schemas). It does NOT import
 * from `src/platform/decision/` and does NOT touch the frozen
 * `src/platform/commitment/` layer.
 *
 * Per slice-E invariant #11/#16: the Phase-1 `MemoryStore` interface
 * is honoured exactly — `forget` returns `Promise<void>`, `list`
 * accepts `MemoryListQuery` only. Phase-2-only capabilities (boolean
 * forget result for idempotency assertions; cursor-based pagination)
 * live on the CLASS surface as `tryForget` and `listPaginated` — the
 * interface stays stable for downstream slices.
 *
 * Recall scoring (Phase 2 ONLY): a deliberately-trivial substring +
 * token-overlap heuristic — see `scoreContent`. Production recall is
 * Phase 3+ via embeddings; this scorer exists so tests + early
 * integration can exercise the ranking surface without an embedder
 * dep.
 */
export class InMemoryMemoryStore implements MemoryStore {
  private readonly episodicByIdentity = new Map<IdentityId, StoredEpisodic[]>();
  private readonly semanticByIdentity = new Map<IdentityId, StoredSemantic[]>();
  /**
   * Monotonic counter for unique slug generation. Combined with the
   * brand validator in `asMemoryEntryId`, this guarantees every minted
   * id is well-formed AND distinct across the lifetime of the store
   * instance. Phase 3 will replace this with a UUID/ULID generator.
   */
  private nextSeq = 1;

  // eslint-disable-next-line @typescript-eslint/require-await
  async storeEpisodic(event: EpisodicMemoryEvent): Promise<MemoryEntryId> {
    // Re-validate at the call site — the type annotation alone does
    // not protect against unsafe-cast / unknown-typed callers, and
    // Phase-1 invariant testing proves this schema rejects every
    // malformed shape.
    const parsed = EpisodicMemoryEventSchema.parse(event);
    const id = this.mintId();
    const bucket = this.getOrCreate(this.episodicByIdentity, parsed.identityId);
    bucket.push({ id, event: parsed });
    return id;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async storeSemantic(write: SemanticMemoryWrite): Promise<MemoryEntryId> {
    const parsed = SemanticMemoryWriteSchema.parse(write);
    const id = this.mintId();
    const bucket = this.getOrCreate(this.semanticByIdentity, parsed.identityId);
    bucket.push({
      id,
      identityId: parsed.identityId,
      content: parsed.content,
      // metadata defaults to an empty object so the recall result
      // contract (metadata is always present) holds even when the
      // caller did not supply any metadata.
      metadata: parsed.metadata ?? {},
    });
    return id;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async recall(query: SemanticMemoryQuery): Promise<MemoryRecallResult> {
    const parsed = SemanticMemoryQuerySchema.parse(query);
    const bucket = this.semanticByIdentity.get(parsed.identityId);
    if (bucket === undefined || bucket.length === 0) {
      return { entries: [] };
    }

    const limit = parsed.limit ?? DEFAULT_LIMIT;
    if (limit <= 0) {
      return { entries: [] };
    }

    const scored: SemanticMemoryEntry[] = [];
    for (const stored of bucket) {
      const score = scoreContent(parsed.query, stored.content);
      if (score > 0) {
        scored.push({
          id: stored.id,
          identityId: stored.identityId,
          content: stored.content,
          metadata: stored.metadata,
          score,
        });
      }
    }

    // Sort highest-score-first; ties preserve insertion order via
    // `Array.prototype.sort` stability (Node 22+ stable sort).
    scored.sort((a, b) => b.score - a.score);
    return { entries: scored.slice(0, limit) };
  }

  /**
   * Phase-1 interface conformer: `list` takes only `MemoryListQuery`,
   * which has NO `after` cursor. The Phase-2 cursor surface lives on
   * `listPaginated`. This method delegates to `listPaginated` with
   * `after: undefined` so the impl is shared and the contract for the
   * `MemoryStore` interface is preserved.
   */
  list(query: MemoryListQuery): Promise<MemoryListResult> {
    return this.listPaginated({
      identityId: query.identityId,
      effectFamily: query.effectFamily,
      limit: query.limit,
    });
  }

  /**
   * Phase-2 cursor-based pagination. NOT part of the `MemoryStore`
   * interface — extra capability on the in-memory impl, useful for
   * tests + early integration. `listPaginated` returns at most `limit`
   * entries (default 50, zero/negative → empty page) starting strictly
   * after `after` in insertion order. An unknown `after` cursor
   * resolves to an empty page (NOT an error).
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async listPaginated(query: InMemoryListPaginatedQuery): Promise<MemoryListResult> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    if (limit <= 0) {
      return { episodic: [], semantic: [] };
    }

    const episodic = paginate(
      filterEpisodic(this.episodicByIdentity.get(query.identityId), query.effectFamily),
      query.after,
      limit,
    );

    const semantic = paginateSemantic(
      this.semanticByIdentity.get(query.identityId),
      query.after,
      limit,
    );

    return {
      episodic: episodic.map(toListing),
      semantic,
    };
  }

  /**
   * Phase-1 interface conformer: `forget` returns `Promise<void>`.
   * Idempotent — a miss is silently swallowed. Tests that need to
   * distinguish hit from miss should call `tryForget` instead.
   */
  async forget(id: MemoryEntryId): Promise<void> {
    await this.tryForget(id);
  }

  /**
   * Phase-2 boolean-result forget. NOT part of the `MemoryStore`
   * interface — extra capability on the in-memory impl, exposed so
   * tests can assert the idempotency invariant (first call → true,
   * second call on the same id → false).
   *
   * Walks both maps because the `MemoryEntryId` brand alone tells the
   * caller nothing about which surface (episodic vs semantic) owns it.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async tryForget(id: MemoryEntryId): Promise<boolean> {
    if (removeFromMap(this.episodicByIdentity, id)) {
      return true;
    }
    if (removeFromMap(this.semanticByIdentity, id)) {
      return true;
    }
    return false;
  }

  private mintId(): MemoryEntryId {
    const slug = `inmem-${String(this.nextSeq).padStart(8, "0")}`;
    this.nextSeq += 1;
    return asMemoryEntryId(`mem:${slug}`);
  }

  private getOrCreate<V>(map: Map<IdentityId, V[]>, key: IdentityId): V[] {
    const existing = map.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const fresh: V[] = [];
    map.set(key, fresh);
    return fresh;
  }
}

/**
 * Score `content` against `query`. Deterministic + obvious: an exact
 * substring match (case-insensitive, both sides trimmed) returns 1.0;
 * otherwise we fall back to a simple token-overlap ratio over
 * whitespace-separated tokens. No matches → 0; in that case the entry
 * is NOT returned in the recall result.
 *
 * This scorer is intentionally synthetic — Phase 3+ replaces it with
 * embedding cosine similarity. The contract for callers: higher means
 * more relevant; 0 means "do not surface".
 */
function scoreContent(query: string, content: string): number {
  const q = query.trim().toLowerCase();
  const c = content.trim().toLowerCase();
  if (q.length === 0) {
    return 0;
  }
  if (c.includes(q)) {
    return 1;
  }
  const queryTokens = tokenize(q);
  const contentTokens = new Set(tokenize(c));
  if (queryTokens.length === 0 || contentTokens.size === 0) {
    return 0;
  }
  let hits = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) {
      hits += 1;
    }
  }
  return hits / queryTokens.length;
}

function tokenize(text: string): string[] {
  return text.split(/\s+/u).filter((token) => token.length > 0);
}

/**
 * Apply the `effectFamily` filter (when set) to a stored episodic
 * bucket. Returns a fresh array — the stored array is never mutated
 * by callers, preserving insertion order for subsequent reads.
 */
function filterEpisodic(
  bucket: StoredEpisodic[] | undefined,
  effectFamily: EpisodicEffectFamily | undefined,
): StoredEpisodic[] {
  if (bucket === undefined) {
    return [];
  }
  if (effectFamily === undefined) {
    return [...bucket];
  }
  return bucket.filter((row) => row.event.effectFamily === effectFamily);
}

/**
 * Slice a stable-ordered array starting strictly after `after`,
 * capped at `limit`. When `after` is unknown to the store (no row
 * matches) the function returns an empty page — the cursor is opaque,
 * so an unknown cursor is treated as "past the end".
 */
function paginate(
  rows: StoredEpisodic[],
  after: MemoryEntryId | undefined,
  limit: number,
): StoredEpisodic[] {
  const startIndex = computeStartIndex(rows, after);
  if (startIndex < 0) {
    return [];
  }
  return rows.slice(startIndex, startIndex + limit);
}

function paginateSemantic(
  bucket: StoredSemantic[] | undefined,
  after: MemoryEntryId | undefined,
  limit: number,
): SemanticMemoryEntry[] {
  if (bucket === undefined) {
    return [];
  }
  const startIndex = computeStartIndex(bucket, after);
  if (startIndex < 0) {
    return [];
  }
  return bucket.slice(startIndex, startIndex + limit).map((stored) => ({
    id: stored.id,
    identityId: stored.identityId,
    content: stored.content,
    metadata: stored.metadata,
    // `list` returns a stored snapshot, NOT a recall — score is N/A
    // here. Phase-1 schema requires a finite number; 0 is the natural
    // sentinel for "not scored against any query".
    score: 0,
  }));
}

/**
 * Resolve the index immediately after the row whose id matches
 * `after`. Returns `0` when `after` is undefined (start of stream),
 * and `-1` when `after` is set but does not match any row (signal:
 * cursor past-the-end → empty page).
 */
function computeStartIndex<T extends { readonly id: MemoryEntryId }>(
  rows: readonly T[],
  after: MemoryEntryId | undefined,
): number {
  if (after === undefined) {
    return 0;
  }
  const idx = rows.findIndex((row) => row.id === after);
  if (idx < 0) {
    return -1;
  }
  return idx + 1;
}

function toListing(row: StoredEpisodic): EpisodicMemoryListing {
  return { id: row.id, event: row.event };
}

/**
 * Walk every bucket in `map` and remove the row whose id matches
 * `id`. Returns true on the first removal; mutates the bucket array
 * in-place so subsequent insertions keep their insertion-time order
 * relative to surviving rows.
 */
function removeFromMap(
  map: Map<IdentityId, { readonly id: MemoryEntryId }[]>,
  id: MemoryEntryId,
): boolean {
  for (const bucket of map.values()) {
    const idx = bucket.findIndex((row) => row.id === id);
    if (idx >= 0) {
      bucket.splice(idx, 1);
      return true;
    }
  }
  return false;
}
