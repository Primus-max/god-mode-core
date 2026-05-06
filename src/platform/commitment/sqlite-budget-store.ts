import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { requireNodeSqlite } from "../../memory/sqlite.js";
import { resolveConfigDir } from "../../utils.js";
import type { IdentityId } from "../identity/identity-id.js";

import type { EffectFamilyId } from "./ids.js";
import type { BudgetWindowId } from "./policy-gate-stages.js";
import {
  buildBudgetWindowId,
  type BudgetDimension,
  type BudgetIncrementInput,
  type BudgetReadQuery,
  type BudgetStore,
  type BudgetWindow,
} from "./budget-store.js";

/**
 * Phase 4 — Stage 3 (Budgets) `SqliteBudgetStore` impl.
 *
 * Sibling pattern: `SqliteVecMemoryStore` (slice E P3) +
 * `SqliteTaskLedger` (slice F). Same module-level discipline:
 *  - sync `node:sqlite` `DatabaseSync` opened via the existing
 *    `requireNodeSqlite` shim.
 *  - schema migration is idempotent on every `open(...)` (INSERT OR
 *    IGNORE on `meta.schema_version`).
 *  - `busy_timeout = 5000` so concurrent agent-turn writes retry
 *    instead of failing immediately with `SQLITE_BUSY`.
 *  - per-`IdentityId` predicates on every read.
 *  - atomic increment via `BEGIN IMMEDIATE; … ; COMMIT;` so two
 *    parallel `increment` calls cannot leak a charge past the limit.
 *
 * Schema (v1):
 *
 *   meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)
 *     - schema_version=1
 *
 *   budget_windows(
 *     window_id     TEXT PRIMARY KEY,
 *     dimension     TEXT NOT NULL,        -- 'user' | 'channel' | 'effect'
 *     identity_id   TEXT,                  -- non-null only when dimension='user'
 *     channel       TEXT,                  -- non-null only when dimension='channel'
 *     effect_family TEXT,                  -- non-null only when dimension='effect'
 *     window_start  INTEGER NOT NULL,      -- ms epoch
 *     window_end    INTEGER NOT NULL,      -- ms epoch
 *     used          INTEGER NOT NULL,
 *     limit_value   INTEGER NOT NULL
 *   )
 *
 *   -- secondary indices for the per-dimension lookups
 *   budget_windows_user_idx     (identity_id) WHERE dimension='user'
 *   budget_windows_channel_idx  (channel)     WHERE dimension='channel'
 *   budget_windows_effect_idx   (effect_family) WHERE dimension='effect'
 *
 * Per slice E invariant #8, this module imports ONLY from:
 *  - `../../utils.js` (path resolution)
 *  - `../../memory/sqlite.js` (existing node:sqlite shim)
 *  - `../identity/identity-id.js`
 *  - sibling `commitment/` types (`ids.ts`, `policy-gate-stages.ts`,
 *    `budget-store.ts`).
 *
 * It does NOT import from `src/platform/decision/`,
 * `src/platform/runtime/`, `src/agents/`, or any extension/channel
 * code. Per invariant #5/#6 it accepts ONLY structured types — never
 * a `RawUserTurn` / `UserPrompt` — and never does string matching
 * against operator text.
 */

/**
 * Phase-4 schema version. Bumping this requires a forward migration
 * gated on the `meta.schema_version` row. v1 is the initial cut.
 */
export const SQLITE_BUDGET_STORE_SCHEMA_VERSION = 1 as const;

/**
 * Default for the persistent DB path when the caller does not supply
 * one. Resolves to `<resolveConfigDir>/policy/budget.sqlite`
 * — co-located with other state under the dev/prod profile root, but
 * in its OWN subdirectory so the Phase-4 DB can be removed without
 * touching unrelated state (mirrors slice E memory + slice F task
 * ledger discipline).
 */
export function defaultSqliteBudgetStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveConfigDir(env), "policy", "budget.sqlite");
}

const CREATE_META = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`;

const CREATE_BUDGET = `
  CREATE TABLE IF NOT EXISTS budget_windows (
    window_id     TEXT PRIMARY KEY,
    dimension     TEXT NOT NULL,
    identity_id   TEXT,
    channel       TEXT,
    effect_family TEXT,
    window_start  INTEGER NOT NULL,
    window_end    INTEGER NOT NULL,
    used          INTEGER NOT NULL,
    limit_value   INTEGER NOT NULL
  )
`;

const CREATE_BUDGET_USER_IDX = `
  CREATE INDEX IF NOT EXISTS budget_windows_user_idx
    ON budget_windows(identity_id) WHERE dimension = 'user'
`;

const CREATE_BUDGET_CHANNEL_IDX = `
  CREATE INDEX IF NOT EXISTS budget_windows_channel_idx
    ON budget_windows(channel) WHERE dimension = 'channel'
`;

const CREATE_BUDGET_EFFECT_IDX = `
  CREATE INDEX IF NOT EXISTS budget_windows_effect_idx
    ON budget_windows(effect_family) WHERE dimension = 'effect'
`;

/**
 * Construction options for `SqliteBudgetStore.open`.
 *
 * - `dbPath` — optional; defaults to `defaultSqliteBudgetStorePath()`.
 * - `now` — optional clock injector; tests pass a fixed-time fake to
 *   exercise window-roll and `resetExpired` deterministically. The
 *   default is `Date.now`.
 */
export type SqliteBudgetStoreOpenOptions = {
  readonly dbPath?: string;
  readonly now?: () => number;
};

type BudgetRow = {
  window_id: string;
  dimension: string;
  identity_id: string | null;
  channel: string | null;
  effect_family: string | null;
  window_start: number;
  window_end: number;
  used: number;
  limit_value: number;
};

/**
 * Persistent budget store backed by sqlite. Open via the static
 * async `SqliteBudgetStore.open` factory; the constructor is
 * private because schema migration must complete before any
 * `read` / `increment` returns.
 */
export class SqliteBudgetStore implements BudgetStore {
  private readonly db: DatabaseSync;
  private readonly nowFn: () => number;
  private closed = false;

  private constructor(params: { db: DatabaseSync; now: () => number }) {
    this.db = params.db;
    this.nowFn = params.now;
  }

  /**
   * Async factory. Opens (or creates) the sqlite file at the
   * resolved path, runs the v1 schema migration idempotently,
   * applies `busy_timeout = 5000`, and returns a ready-to-use
   * `BudgetStore`.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  static async open(opts: SqliteBudgetStoreOpenOptions = {}): Promise<SqliteBudgetStore> {
    // The body is async-decorated so that synchronous throws (e.g.
    // `dbPath is required` below) surface as rejected promises —
    // mirrors slice E `SqliteVecMemoryStore.open` discipline so
    // callers can `await` then `expect(..).rejects.toThrow(...)` in
    // tests without juggling the sync-throw shape.
    const dbPath = opts.dbPath ?? defaultSqliteBudgetStorePath();
    if (!dbPath || dbPath.trim().length === 0) {
      throw new Error("SqliteBudgetStore.open: dbPath is required");
    }
    const dir = path.dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(dbPath, { allowExtension: false });
    // Per-connection busy_timeout aligns with `SqliteVecMemoryStore`
    // (slice E) so concurrent agent-turn writes retry instead of
    // failing immediately with SQLITE_BUSY.
    db.exec("PRAGMA busy_timeout = 5000");
    runBaseSchemaMigration(db);

    return new SqliteBudgetStore({
      db,
      now: opts.now ?? Date.now,
    });
  }

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
   * Returns the migrated schema version. Used by tests + future
   * migration code.
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

  // eslint-disable-next-line @typescript-eslint/require-await
  async read(query: BudgetReadQuery): Promise<BudgetWindow | null> {
    this.assertOpen();
    const row = this.selectByDimension(query);
    if (!row) {
      return null;
    }
    const now = this.nowFn();
    if (now >= row.window_end) {
      // Lazy reset: roll the window forward by its original duration
      // (`windowEnd - windowStart`) and zero `used`. Wrap the roll
      // in a transaction so concurrent reads see the same post-roll
      // state.
      const windowMs = row.window_end - row.window_start;
      const rolled = this.rollWindowTransaction(row, now, windowMs);
      return rowToWindow(rolled);
    }
    return rowToWindow(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async increment(input: BudgetIncrementInput): Promise<BudgetWindow> {
    this.assertOpen();
    if (!Number.isFinite(input.limit) || input.limit < 0) {
      throw new Error(
        `SqliteBudgetStore.increment: limit must be a non-negative number (got ${String(input.limit)})`,
      );
    }
    if (!Number.isFinite(input.windowMs) || input.windowMs <= 0) {
      throw new Error(
        `SqliteBudgetStore.increment: windowMs must be a positive number (got ${String(input.windowMs)})`,
      );
    }
    const now = this.nowFn();
    return rowToWindow(this.incrementTransaction(input, now));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async resetExpired(now: number): Promise<number> {
    this.assertOpen();
    if (!Number.isFinite(now)) {
      throw new Error(`SqliteBudgetStore.resetExpired: now must be finite (got ${String(now)})`);
    }
    // Roll every expired row forward in a single transaction. The
    // count returned is the number of rows touched. We compute the
    // new windowStart as the largest `windowStart + k*windowMs`
    // less-or-equal `now` so a long-idle row jumps to the current
    // window rather than firing once per missed period.
    let rolled = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const expired = this.db
        .prepare(
          `SELECT window_id, window_start, window_end\n` +
            `  FROM budget_windows\n` +
            ` WHERE window_end <= ?`,
        )
        .all(now) as Array<{ window_id: string; window_start: number; window_end: number }>;
      for (const row of expired) {
        const windowMs = row.window_end - row.window_start;
        if (windowMs <= 0) {
          continue;
        }
        const newStart = computeRolledStart(row.window_start, windowMs, now);
        const newEnd = newStart + windowMs;
        const newId = computeWindowIdFromRow({
          windowId: row.window_id,
          windowStart: newStart,
        });
        this.db
          .prepare(
            `UPDATE budget_windows\n` +
              `   SET window_id = ?, window_start = ?, window_end = ?, used = 0\n` +
              ` WHERE window_id = ?`,
          )
          .run(newId, newStart, newEnd, row.window_id);
        rolled += 1;
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return rolled;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("SqliteBudgetStore is closed");
    }
  }

  private selectByDimension(query: BudgetReadQuery): BudgetRow | undefined {
    if (query.dimension === "user") {
      return this.db
        .prepare(
          `SELECT * FROM budget_windows\n` +
            ` WHERE dimension = 'user' AND identity_id = ?\n` +
            ` LIMIT 1`,
        )
        .get(String(query.identityId ?? "")) as BudgetRow | undefined;
    }
    if (query.dimension === "channel") {
      return this.db
        .prepare(
          `SELECT * FROM budget_windows\n` +
            ` WHERE dimension = 'channel' AND channel = ?\n` +
            ` LIMIT 1`,
        )
        .get(String(query.channel ?? "")) as BudgetRow | undefined;
    }
    return this.db
      .prepare(
        `SELECT * FROM budget_windows\n` +
          ` WHERE dimension = 'effect' AND effect_family = ?\n` +
          ` LIMIT 1`,
      )
      .get(String(query.effectFamily ?? "")) as BudgetRow | undefined;
  }

  /**
   * Atomic `(read | create) + roll-if-expired + increment` in one
   * transaction. Returns the post-increment row.
   */
  private incrementTransaction(input: BudgetIncrementInput, now: number): BudgetRow {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let row = this.selectByDimension(input);
      if (row && now >= row.window_end) {
        const windowMs = row.window_end - row.window_start;
        row = this.rollWindowTransactionInner(row, now, windowMs > 0 ? windowMs : input.windowMs);
      }
      if (!row) {
        // Create a fresh window aligned to `now` with the configured
        // `windowMs`. `windowStart=now` is the simple choice — the
        // first charge "starts the clock". Slice K may later switch
        // to calendar-aligned windows; v1 keeps it simple.
        const windowStart = now;
        const windowEnd = windowStart + input.windowMs;
        const windowId = buildBudgetWindowId({
          dimension: input.dimension,
          identityId: input.identityId,
          channel: input.channel,
          effectFamily: input.effectFamily,
          windowStart,
        });
        this.db
          .prepare(
            `INSERT INTO budget_windows\n` +
              `  (window_id, dimension, identity_id, channel, effect_family,\n` +
              `   window_start, window_end, used, limit_value)\n` +
              `VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
          )
          .run(
            String(windowId),
            input.dimension,
            input.dimension === "user" ? String(input.identityId ?? "") : null,
            input.dimension === "channel" ? String(input.channel ?? "") : null,
            input.dimension === "effect" ? String(input.effectFamily ?? "") : null,
            windowStart,
            windowEnd,
            input.limit,
          );
        row = this.selectByDimension(input);
      }
      if (!row) {
        // Defensive — INSERT just ran, the row must exist. Throw
        // inside the transaction so ROLLBACK fires.
        throw new Error("SqliteBudgetStore.increment: row missing after insert");
      }
      const updated: BudgetRow = {
        ...row,
        used: row.used + 1,
        limit_value: input.limit,
      };
      this.db
        .prepare(`UPDATE budget_windows SET used = ?, limit_value = ? WHERE window_id = ?`)
        .run(updated.used, updated.limit_value, row.window_id);
      this.db.exec("COMMIT");
      return updated;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Roll a single expired window in its own transaction. Used by
   * the read path; the increment path uses
   * `rollWindowTransactionInner` because it is already inside a
   * transaction.
   */
  private rollWindowTransaction(row: BudgetRow, now: number, windowMs: number): BudgetRow {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rolled = this.rollWindowTransactionInner(row, now, windowMs);
      this.db.exec("COMMIT");
      return rolled;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private rollWindowTransactionInner(row: BudgetRow, now: number, windowMs: number): BudgetRow {
    // Re-read inside the transaction in case another writer rolled
    // the window first (busy_timeout backs off, then we observe the
    // already-rolled state).
    const fresh = this.db
      .prepare(`SELECT * FROM budget_windows WHERE window_id = ? LIMIT 1`)
      .get(row.window_id) as BudgetRow | undefined;
    if (!fresh) {
      // Another transaction deleted the row. Treat as missing.
      throw new Error("SqliteBudgetStore: budget window vanished mid-roll");
    }
    if (now < fresh.window_end) {
      // Another writer already rolled. Return the fresh row.
      return fresh;
    }
    const newStart = computeRolledStart(fresh.window_start, windowMs, now);
    const newEnd = newStart + windowMs;
    const newId = computeWindowIdFromRow({
      windowId: fresh.window_id,
      windowStart: newStart,
    });
    this.db
      .prepare(
        `UPDATE budget_windows\n` +
          `   SET window_id = ?, window_start = ?, window_end = ?, used = 0\n` +
          ` WHERE window_id = ?`,
      )
      .run(newId, newStart, newEnd, fresh.window_id);
    return {
      ...fresh,
      window_id: newId,
      window_start: newStart,
      window_end: newEnd,
      used: 0,
    };
  }
}

function runBaseSchemaMigration(db: DatabaseSync): void {
  db.exec(CREATE_META);
  db.exec(CREATE_BUDGET);
  db.exec(CREATE_BUDGET_USER_IDX);
  db.exec(CREATE_BUDGET_CHANNEL_IDX);
  db.exec(CREATE_BUDGET_EFFECT_IDX);
  db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)`).run(
    String(SQLITE_BUDGET_STORE_SCHEMA_VERSION),
  );
}

function rowToWindow(row: BudgetRow): BudgetWindow {
  const dimension = row.dimension as BudgetDimension;
  const base = {
    windowId: row.window_id as BudgetWindowId,
    dimension,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    used: row.used,
    limit: row.limit_value,
  };
  if (dimension === "user") {
    return {
      ...base,
      identityId: (row.identity_id ?? undefined) as IdentityId | undefined,
    };
  }
  if (dimension === "channel") {
    return {
      ...base,
      channel: row.channel ?? undefined,
    };
  }
  return {
    ...base,
    effectFamily: (row.effect_family ?? undefined) as EffectFamilyId | undefined,
  };
}

/**
 * Computes the new window-start when rolling an expired window
 * forward. Picks the largest `windowStart + k*windowMs <= now` so a
 * long-idle window jumps to the *current* period rather than firing
 * once per missed period (catch-up resets).
 */
function computeRolledStart(oldStart: number, windowMs: number, now: number): number {
  if (windowMs <= 0) {
    return now;
  }
  const elapsed = now - oldStart;
  if (elapsed <= 0) {
    return oldStart;
  }
  const periods = Math.floor(elapsed / windowMs);
  return oldStart + periods * windowMs;
}

/**
 * Re-derives the `BudgetWindowId` from an existing row + a new
 * `windowStart`. The dimension/key portion of the existing id is
 * preserved (everything before the trailing `:<windowStart>`); only
 * the trailing timestamp is rewritten. Falls back to a regenerated
 * id when the input is malformed.
 */
function computeWindowIdFromRow(params: {
  readonly windowId: string;
  readonly windowStart: number;
}): string {
  const lastColon = params.windowId.lastIndexOf(":");
  if (lastColon <= 0) {
    return params.windowId;
  }
  return `${params.windowId.slice(0, lastColon)}:${params.windowStart}`;
}
