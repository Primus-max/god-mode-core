import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { loadSqliteVecExtension } from "../../memory/sqlite-vec.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import { resolveConfigDir } from "../../utils.js";
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
 * Phase-3 schema version. Bumping this requires a forward migration
 * gated on the `meta.schema_version` row. v1 is the initial cut.
 */
export const SQLITE_VEC_MEMORY_STORE_SCHEMA_VERSION = 1 as const;

/**
 * Default for the persistent DB path when the caller does not supply
 * one. Resolves to `<resolveConfigDir>/memory/identity-memory.sqlite`
 * — co-located with other state under the dev/prod profile root, but
 * in its OWN subdirectory so the slice E DB can be removed without
 * touching unrelated state (per sub-plan §6).
 */
export function defaultSqliteVecMemoryStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveConfigDir(env), "memory", "identity-memory.sqlite");
}

/**
 * Minimal embedder seam — the store does NOT pick a provider; callers
 * (slice E Phase 4 / Phase 6) inject one. Reuses the existing
 * provider-agnostic embedding infrastructure under `src/memory/` via a
 * thin adapter (the adapter lives at the call site, not here, so this
 * module stays free of provider-specific imports).
 */
export type MemoryEmbedder = {
  embed(text: string): Promise<Float32Array>;
};

/**
 * Minimal logger surface used by the store to surface degraded-mode
 * warnings (chiefly `vector_unavailable`). Decoupled from the project
 * logger so tests can inject a capturing stub without pulling the full
 * logging infrastructure.
 */
export type SqliteVecMemoryStoreLogger = {
  warn(message: string): void;
};

/**
 * Result shape returned by `loadSqliteVecExtension`. Matches the
 * existing helper in `src/memory/sqlite-vec.ts` so the default and the
 * test stub use identical contracts.
 */
type LoadSqliteVecExtensionResult = {
  ok: boolean;
  extensionPath?: string;
  error?: string;
};

/**
 * Callable used by the store to load the sqlite-vec extension into the
 * underlying `DatabaseSync`. The default delegates to the existing
 * `loadSqliteVecExtension` helper; tests inject a stub that returns
 * `{ ok: false }` to exercise the fallback path.
 */
export type LoadSqliteVecExtensionFn = (params: {
  db: DatabaseSync;
  extensionPath?: string;
}) => Promise<LoadSqliteVecExtensionResult>;

/**
 * Construction options for `SqliteVecMemoryStore.open`. `dbPath` and
 * `embedder` are required; everything else is injectable for tests +
 * slice integration.
 */
export type SqliteVecMemoryStoreOpenOptions = {
  /**
   * Absolute path to the sqlite file. Use
   * `defaultSqliteVecMemoryStorePath()` for the production location
   * `<resolveConfigDir>/memory/identity-memory.sqlite`.
   */
  readonly dbPath: string;
  /**
   * Embedder used to vectorise content on `storeSemantic` and to
   * vectorise the query string on `recall`. Returns a `Float32Array`
   * of length `vectorDims`.
   */
  readonly embedder: MemoryEmbedder;
  /**
   * Embedding dimensionality. Must match what the embedder produces.
   * The vec0 virtual table is created with this width — changing it
   * across opens is unsupported and would require a v2 schema
   * migration.
   */
  readonly vectorDims: number;
  /**
   * Override for the sqlite-vec extension loader. Defaults to the
   * project-wide `loadSqliteVecExtension` helper. Tests pass a stub
   * to exercise the `vector_unavailable` fallback.
   */
  readonly loadExtension?: LoadSqliteVecExtensionFn;
  /**
   * Override for the warning sink. Defaults to a no-op
   * (production callers wire `createSubsystemLogger("memory")`); tests
   * pass a capturing logger.
   */
  readonly logger?: SqliteVecMemoryStoreLogger;
};

/**
 * Default `recall` / `list` page size when the caller does not supply
 * `limit`. Matches `InMemoryMemoryStore.DEFAULT_LIMIT` so the two
 * impls are observationally identical at typical query sizes.
 */
const DEFAULT_LIMIT = 50;

const NO_OP_LOGGER: SqliteVecMemoryStoreLogger = {
  warn() {
    /* swallow — production callers should inject a real logger */
  },
};

/**
 * Schema (v1):
 *
 *   meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)
 *     - schema_version=<int>
 *
 *   episodic_events(
 *     id TEXT PRIMARY KEY,           -- MemoryEntryId
 *     identity_id TEXT NOT NULL,     -- IdentityId
 *     effect_family TEXT NOT NULL,
 *     effect_id TEXT NOT NULL,
 *     payload_json TEXT NOT NULL,    -- JSON-encoded payload
 *     created_at INTEGER NOT NULL    -- monotonic write-time order
 *   )
 *
 *   semantic_entries(
 *     id TEXT PRIMARY KEY,           -- MemoryEntryId
 *     identity_id TEXT NOT NULL,     -- IdentityId
 *     content TEXT NOT NULL,
 *     metadata_json TEXT NOT NULL,   -- JSON-encoded metadata
 *     created_at INTEGER NOT NULL
 *   )
 *
 *   semantic_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[N])
 *     - parallel to semantic_entries, only created when sqlite-vec is
 *       available; rows are inserted only when the loader returns ok:true.
 *
 * Identity isolation: every read predicates on `identity_id = ?`. There
 * is NO cross-identity index. The vec0 table omits `identity_id` (vec0
 * only stores the keyed embedding), so vector recall always JOINs back
 * to `semantic_entries` and re-applies the `identity_id` filter — see
 * `recallVector`.
 */
const CREATE_META = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`;

const CREATE_EPISODIC = `
  CREATE TABLE IF NOT EXISTS episodic_events (
    id            TEXT PRIMARY KEY,
    identity_id   TEXT NOT NULL,
    effect_family TEXT NOT NULL,
    effect_id     TEXT NOT NULL,
    payload_json  TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  )
`;

const CREATE_EPISODIC_INDEX_IDENTITY = `
  CREATE INDEX IF NOT EXISTS episodic_events_identity_idx
    ON episodic_events(identity_id, created_at)
`;

const CREATE_EPISODIC_INDEX_FAMILY = `
  CREATE INDEX IF NOT EXISTS episodic_events_identity_family_idx
    ON episodic_events(identity_id, effect_family, created_at)
`;

const CREATE_SEMANTIC = `
  CREATE TABLE IF NOT EXISTS semantic_entries (
    id            TEXT PRIMARY KEY,
    identity_id   TEXT NOT NULL,
    content       TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  )
`;

const CREATE_SEMANTIC_INDEX_IDENTITY = `
  CREATE INDEX IF NOT EXISTS semantic_entries_identity_idx
    ON semantic_entries(identity_id, created_at)
`;

/**
 * Persistent `MemoryStore` impl backed by sqlite + sqlite-vec. The
 * store is opened via the static `SqliteVecMemoryStore.open` async
 * factory because:
 * - extension load is async (`loadSqliteVecExtension` returns a
 *   Promise);
 * - migration must happen before any write returns to the caller, and
 *   the constructor cannot return a Promise.
 *
 * Per slice-E invariant #8, this module imports ONLY from:
 * - `../../utils.js` (path resolution, stdlib-only)
 * - `../../memory/sqlite-vec.js` (the existing extension loader)
 * - `../../memory/sqlite.js` (the existing node:sqlite shim)
 * - `../identity/identity-id.js` (the IdentityId brand)
 * - the Phase-1 memory module siblings.
 *
 * It does NOT import from `src/platform/decision/`, NOT from
 * `src/platform/commitment/`, and NOT from any agent-runner / channel
 * code. Per invariant #5/#6 it accepts ONLY structured types — never a
 * `RawUserTurn` / `UserPrompt` — and it never does string matching
 * against operator text on the way in.
 */
export class SqliteVecMemoryStore implements MemoryStore {
  private readonly db: DatabaseSync;
  private readonly embedder: MemoryEmbedder;
  private readonly vectorDims: number;
  private readonly logger: SqliteVecMemoryStoreLogger;
  private readonly vectorAvailable: boolean;
  private closed = false;

  private constructor(params: {
    db: DatabaseSync;
    embedder: MemoryEmbedder;
    vectorDims: number;
    logger: SqliteVecMemoryStoreLogger;
    vectorAvailable: boolean;
  }) {
    this.db = params.db;
    this.embedder = params.embedder;
    this.vectorDims = params.vectorDims;
    this.logger = params.logger;
    this.vectorAvailable = params.vectorAvailable;
  }

  /**
   * Async factory. Opens (or creates) the sqlite file at `opts.dbPath`,
   * runs the v1 schema migration idempotently, attempts to load the
   * sqlite-vec extension, and constructs the vec0 virtual table when
   * the extension is available. When the extension load fails we keep
   * the base tables (so storeSemantic / storeEpisodic continue to
   * work) and fall back to LIKE-based recall — the failure is surfaced
   * as a `vector_unavailable` warning on `opts.logger`, exactly once.
   */
  static async open(opts: SqliteVecMemoryStoreOpenOptions): Promise<SqliteVecMemoryStore> {
    if (!opts.dbPath || opts.dbPath.trim().length === 0) {
      throw new Error("SqliteVecMemoryStore.open: dbPath is required");
    }
    if (!Number.isInteger(opts.vectorDims) || opts.vectorDims <= 0) {
      throw new Error(
        `SqliteVecMemoryStore.open: vectorDims must be a positive integer (got ${String(opts.vectorDims)})`,
      );
    }

    const dir = path.dirname(opts.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(opts.dbPath, { allowExtension: true });
    // busy_timeout is per-connection; align with `manager-sync-ops.ts`
    // so concurrent agent-turn writes retry instead of failing
    // immediately with SQLITE_BUSY.
    db.exec("PRAGMA busy_timeout = 5000");

    // Base-tables migration is unconditional; vec0 creation is gated on
    // a successful extension load below. Either path leaves the store
    // capable of serving storeEpisodic / storeSemantic / recall / list.
    runBaseSchemaMigration(db);

    const logger = opts.logger ?? NO_OP_LOGGER;
    const loader = opts.loadExtension ?? loadSqliteVecExtension;

    let vectorAvailable = false;
    try {
      const loaded = await loader({ db });
      if (loaded.ok) {
        // vec0 virtual tables can't add arbitrary columns alongside
        // the embedding — keep `identity_id` in the parent
        // `semantic_entries` table and JOIN at recall time.
        db.exec(
          `CREATE VIRTUAL TABLE IF NOT EXISTS semantic_vec USING vec0(\n` +
            `  id        TEXT PRIMARY KEY,\n` +
            `  embedding FLOAT[${opts.vectorDims}]\n` +
            `)`,
        );
        vectorAvailable = true;
      } else {
        logger.warn(
          `SqliteVecMemoryStore: vector_unavailable — sqlite-vec load failed: ${loaded.error ?? "unknown error"}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`SqliteVecMemoryStore: vector_unavailable — sqlite-vec load threw: ${message}`);
    }

    return new SqliteVecMemoryStore({
      db,
      embedder: opts.embedder,
      vectorDims: opts.vectorDims,
      logger,
      vectorAvailable,
    });
  }

  /**
   * Released the underlying `DatabaseSync` so callers can re-open the
   * file or remove it. Idempotent — calling `close()` twice is safe.
   */
  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      try {
        this.db.close();
      } catch {
        // best-effort — close failures are non-fatal in test cleanup
      }
    }
    return Promise.resolve();
  }

  /**
   * Whether sqlite-vec was loaded successfully on this store. False
   * means recall falls back to LIKE-based scoring.
   */
  isVectorAvailable(): boolean {
    return this.vectorAvailable;
  }

  /**
   * Returns the migrated schema version (1 in this slice). Used by
   * tests + future migration code to assert the on-disk shape matches
   * the in-process expectation.
   */
  getSchemaVersion(): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get("schema_version") as
      | { value: string }
      | undefined;
    if (!row) {
      return 0;
    }
    const parsed = Number.parseInt(row.value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  // Async so a Zod parse failure surfaces as a rejected promise,
  // matching the in-memory impl's contract (`rejects.toThrow` in tests).
  // eslint-disable-next-line @typescript-eslint/require-await
  async storeEpisodic(event: EpisodicMemoryEvent): Promise<MemoryEntryId> {
    this.assertOpen();
    // Validate at the boundary so the caller's static types alone
    // can't sneak a malformed payload past us — same guard as the
    // in-memory impl.
    const parsed = EpisodicMemoryEventSchema.parse(event);
    const id = mintMemoryEntryId();
    this.db
      .prepare(
        `INSERT INTO episodic_events (id, identity_id, effect_family, effect_id, payload_json, created_at)\n` +
          `VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        parsed.identityId,
        parsed.effectFamily,
        parsed.effectId,
        JSON.stringify(parsed.payload),
        nowMicros(),
      );
    return id;
  }

  async storeSemantic(write: SemanticMemoryWrite): Promise<MemoryEntryId> {
    this.assertOpen();
    const parsed = SemanticMemoryWriteSchema.parse(write);
    const id = mintMemoryEntryId();
    const metadata = parsed.metadata ?? {};

    this.db
      .prepare(
        `INSERT INTO semantic_entries (id, identity_id, content, metadata_json, created_at)\n` +
          `VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, parsed.identityId, parsed.content, JSON.stringify(metadata), nowMicros());

    if (this.vectorAvailable) {
      // Embedding failures are surfaced (the caller's promise
      // rejects), but the row is left in the base table — recall will
      // fall back to LIKE for that row. The Phase-5 commitment-runtime
      // hook catches these rejections without re-throwing.
      try {
        const embedding = await this.embedder.embed(parsed.content);
        if (embedding.length !== this.vectorDims) {
          this.logger.warn(
            `SqliteVecMemoryStore: vector_dim_mismatch — embedder returned length ${embedding.length}, expected ${this.vectorDims}; skipping vec0 insert for entry ${id}`,
          );
        } else {
          this.db
            .prepare("INSERT INTO semantic_vec (id, embedding) VALUES (?, ?)")
            .run(id, vectorToBlob(embedding));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `SqliteVecMemoryStore: embedder_error — failed to vectorise entry ${id}: ${message}`,
        );
      }
    }

    return id;
  }

  async recall(query: SemanticMemoryQuery): Promise<MemoryRecallResult> {
    this.assertOpen();
    const parsed = SemanticMemoryQuerySchema.parse(query);
    const limit = parsed.limit ?? DEFAULT_LIMIT;
    if (limit <= 0) {
      return { entries: [] };
    }

    if (this.vectorAvailable) {
      try {
        const queryVec = await this.embedder.embed(parsed.query);
        if (queryVec.length === this.vectorDims) {
          return this.recallVector(parsed.identityId, queryVec, limit);
        }
        this.logger.warn(
          `SqliteVecMemoryStore: vector_dim_mismatch — query embedding length ${queryVec.length} ≠ ${this.vectorDims}; falling back to LIKE recall`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `SqliteVecMemoryStore: embedder_error — failed to embed query, falling back to LIKE recall: ${message}`,
        );
      }
    }

    return this.recallLike(parsed.identityId, parsed.query, limit);
  }

  list(query: MemoryListQuery): Promise<MemoryListResult> {
    this.assertOpen();
    const limit = query.limit ?? DEFAULT_LIMIT;
    if (limit <= 0) {
      return Promise.resolve({ episodic: [], semantic: [] });
    }

    const episodic = listEpisodicRows(this.db, query.identityId, query.effectFamily, limit);
    const semantic = listSemanticRows(this.db, query.identityId, limit);

    return Promise.resolve({
      episodic,
      semantic,
    });
  }

  forget(id: MemoryEntryId): Promise<void> {
    this.assertOpen();
    // We do not key on identity here because `MemoryEntryId` is
    // already globally unique (`mem:<uuid>`); the brand alone is
    // sufficient. Both base tables are cleared; the vec0 row (when
    // present) is cleared by id as well so subsequent recall does not
    // surface a dangling vector hit pointing at a deleted base row.
    this.db.prepare("DELETE FROM episodic_events WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM semantic_entries WHERE id = ?").run(id);
    if (this.vectorAvailable) {
      try {
        this.db.prepare("DELETE FROM semantic_vec WHERE id = ?").run(id);
      } catch (err) {
        // Best-effort vec0 cleanup — base-table deletion already
        // happened, recall's JOIN will drop dangling vectors anyway.
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `SqliteVecMemoryStore: vec0_delete_error — best-effort cleanup failed for ${id}: ${message}`,
        );
      }
    }
    return Promise.resolve();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("SqliteVecMemoryStore is closed");
    }
  }

  private recallVector(
    identityId: IdentityId,
    queryVec: Float32Array,
    limit: number,
  ): MemoryRecallResult {
    // JOIN re-applies the identity_id filter from semantic_entries —
    // vec0 itself does not store identity, by design (vec0 keeps only
    // the keyed embedding column). This is the slice-E invariant #16
    // boundary: identity_id is the SOLE primary access key.
    const rows = this.db
      .prepare(
        `SELECT s.id, s.identity_id, s.content, s.metadata_json,\n` +
          `       vec_distance_cosine(v.embedding, ?) AS dist\n` +
          `  FROM semantic_vec v\n` +
          `  JOIN semantic_entries s ON s.id = v.id\n` +
          ` WHERE s.identity_id = ?\n` +
          ` ORDER BY dist ASC\n` +
          ` LIMIT ?`,
      )
      .all(vectorToBlob(queryVec), identityId, limit) as Array<{
      id: string;
      identity_id: string;
      content: string;
      metadata_json: string;
      dist: number;
    }>;

    const entries = rows.map((row) => semanticRowToEntry(row, 1 - row.dist));
    return { entries };
  }

  private recallLike(identityId: IdentityId, query: string, limit: number): MemoryRecallResult {
    // LIKE-fallback. We do NOT use `LIKE` directly on a `?`-bound
    // pattern with operator-supplied wildcard chars; we wrap with `%`
    // and do a case-insensitive compare via `LOWER(content) LIKE
    // LOWER(?)`. This is the same shape as the in-memory impl's
    // substring-presence pass so behaviour is consistent across
    // backends in degraded mode.
    const safePattern = `%${query.trim()}%`;
    const rows = this.db
      .prepare(
        `SELECT id, identity_id, content, metadata_json\n` +
          `  FROM semantic_entries\n` +
          ` WHERE identity_id = ?\n` +
          `   AND LOWER(content) LIKE LOWER(?)\n` +
          ` ORDER BY created_at ASC\n` +
          ` LIMIT ?`,
      )
      .all(identityId, safePattern, limit) as Array<{
      id: string;
      identity_id: string;
      content: string;
      metadata_json: string;
    }>;

    const entries = rows.map((row) => semanticRowToEntry(row, 1));
    return { entries };
  }
}

function runBaseSchemaMigration(db: DatabaseSync): void {
  db.exec(CREATE_META);
  db.exec(CREATE_EPISODIC);
  db.exec(CREATE_EPISODIC_INDEX_IDENTITY);
  db.exec(CREATE_EPISODIC_INDEX_FAMILY);
  db.exec(CREATE_SEMANTIC);
  db.exec(CREATE_SEMANTIC_INDEX_IDENTITY);

  // Stamp schema_version on first open; preserve on subsequent opens.
  // INSERT OR IGNORE keeps the migration idempotent — re-running on a
  // populated DB is a no-op.
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)").run(
    String(SQLITE_VEC_MEMORY_STORE_SCHEMA_VERSION),
  );
}

function listEpisodicRows(
  db: DatabaseSync,
  identityId: IdentityId,
  effectFamily: EpisodicEffectFamily | undefined,
  limit: number,
): EpisodicMemoryListing[] {
  const rows = effectFamily
    ? (db
        .prepare(
          `SELECT id, identity_id, effect_family, effect_id, payload_json\n` +
            `  FROM episodic_events\n` +
            ` WHERE identity_id = ? AND effect_family = ?\n` +
            ` ORDER BY created_at ASC\n` +
            ` LIMIT ?`,
        )
        .all(identityId, effectFamily, limit) as Array<EpisodicRow>)
    : (db
        .prepare(
          `SELECT id, identity_id, effect_family, effect_id, payload_json\n` +
            `  FROM episodic_events\n` +
            ` WHERE identity_id = ?\n` +
            ` ORDER BY created_at ASC\n` +
            ` LIMIT ?`,
        )
        .all(identityId, limit) as Array<EpisodicRow>);

  return rows.map((row) => episodicRowToListing(row));
}

function listSemanticRows(
  db: DatabaseSync,
  identityId: IdentityId,
  limit: number,
): SemanticMemoryEntry[] {
  const rows = db
    .prepare(
      `SELECT id, identity_id, content, metadata_json\n` +
        `  FROM semantic_entries\n` +
        ` WHERE identity_id = ?\n` +
        ` ORDER BY created_at ASC\n` +
        ` LIMIT ?`,
    )
    .all(identityId, limit) as Array<{
    id: string;
    identity_id: string;
    content: string;
    metadata_json: string;
  }>;
  return rows.map((row) => semanticRowToEntry(row, 0));
}

type EpisodicRow = {
  id: string;
  identity_id: string;
  effect_family: string;
  effect_id: string;
  payload_json: string;
};

function episodicRowToListing(row: EpisodicRow): EpisodicMemoryListing {
  // `EpisodicMemoryEventSchema.parse` re-validates on the way out so
  // a malformed on-disk row (e.g. from a future schema version that
  // wasn't migrated) is surfaced as a parse error rather than a
  // silently-broken event downstream.
  const event = EpisodicMemoryEventSchema.parse({
    identityId: row.identity_id,
    effectFamily: row.effect_family,
    effectId: row.effect_id,
    payload: JSON.parse(row.payload_json) as unknown,
  });
  return { id: asMemoryEntryId(row.id), event };
}

function semanticRowToEntry(
  row: {
    id: string;
    identity_id: string;
    content: string;
    metadata_json: string;
  },
  score: number,
): SemanticMemoryEntry {
  const metadata = JSON.parse(row.metadata_json) as SemanticMemoryMetadata;
  return {
    id: asMemoryEntryId(row.id),
    identityId: row.identity_id as IdentityId,
    content: row.content,
    metadata,
    score: Number.isFinite(score) ? score : 0,
  };
}

/**
 * Pack a Float32Array into a sqlite BLOB. sqlite-vec's vec0 expects
 * little-endian 32-bit floats; `Float32Array` already encodes that on
 * all supported runtimes. `Buffer.from(array.buffer)` does NOT copy —
 * it views the same backing buffer — so we slice via `Buffer.from(new
 * Float32Array(values).buffer)` to produce a fresh blob each call.
 */
function vectorToBlob(values: Float32Array): Buffer {
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

function nowMicros(): number {
  // Microsecond resolution to keep insertion order stable when two
  // writes land in the same millisecond. `Date.now()` would tie at
  // 1ms granularity; performance.now starts at process boot and is
  // monotonic but not directly comparable across processes — for a
  // single-process store the wall-clock millisecond plus a sub-ms
  // counter would be ideal, but `Date.now() * 1000` is already
  // distinct enough for the test loads we care about.
  return Date.now() * 1000;
}

function mintMemoryEntryId(): MemoryEntryId {
  return asMemoryEntryId(`mem:${randomUUID()}`);
}
