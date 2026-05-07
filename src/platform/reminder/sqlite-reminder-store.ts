/**
 * Cron/Scheduler Phase 6 — `SqliteReminderStore` persistent reminder
 * persistence.
 *
 * Production impl of the `ReminderStore` interface defined alongside
 * `InMemoryReminderStore` in `./reminder-store.ts`. Schema discipline
 * mirrors slice E `SqliteVecMemoryStore` (PR-#160) + slice F
 * `SqliteTaskLedger` (PR-#171): per-`IdentityId` predicate on every read,
 * `meta(schema_version)` row stamped on first open, idempotent migrations
 * via `CREATE … IF NOT EXISTS`. Default DB path is
 * `<resolveConfigDir>/reminder/reminders.sqlite` — co-located with other
 * persistent state but in its own subdirectory so the slice can be wiped
 * without touching unrelated state (sub-plan §1 todo Phase 6 acceptance:
 * "DB path: `~/.openclaw/reminders.sqlite` (configurable)").
 *
 * Boundary discipline (invariant #8):
 * - `src/platform/reminder/` imports ONLY from `src/platform/identity/`,
 *   `src/memory/sqlite.js` (the `requireNodeSqlite` shim), `src/utils.js`
 *   (path resolution, stdlib-only), and the standard library. NO imports
 *   from `src/platform/commitment/`, `src/platform/decision/`, or
 *   anything under `src/agents/`.
 * - Every read predicates on `identity_id = ?` (defense in depth — the
 *   reminderId column is `PRIMARY KEY`, so the row could in principle
 *   be fetched without the identity scope, but the impl REFUSES to
 *   return a row whose identity_id does not match the supplied
 *   identityId — sub-plan §6 acceptance: "operator A's `list()` NEVER
 *   returns operator B's records").
 * - Status-transition invariants enforced both at the schema level
 *   (`CHECK(status IN ('pending','fired','cancelled'))`) and at the
 *   application boundary (one-way `pending → fired`, `pending →
 *   cancelled`; reverse transitions REJECT — see `markFired` /
 *   `cancel`).
 *
 * The store is opened via the static `SqliteReminderStore.open` async
 * factory because:
 * - migration must happen before any write returns to the caller, and
 *   the constructor cannot return a Promise (slice F precedent);
 * - keeps the call shape symmetric with `SqliteTaskLedger.open` /
 *   `SqliteVecMemoryStore.open` so wiring code can `await Promise.all`
 *   them interchangeably.
 */

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { requireNodeSqlite } from "../../memory/sqlite.js";
import { resolveConfigDir } from "../../utils.js";
import type { IdentityId } from "../identity/identity-id.js";

import type {
  ListRemindersFilter,
  ReminderRecord,
  ReminderStatus,
  ReminderStore,
  ScheduleReminderInput,
} from "./reminder-store.js";

/**
 * Phase 6 schema version. Bumping this requires a forward migration
 * gated on the `meta.schema_version` row. v1 is the initial cut and
 * matches slice E + slice F's discipline (PR-#160 / PR-#171).
 */
export const SQLITE_REMINDER_STORE_SCHEMA_VERSION = 1 as const;

/**
 * Default DB path for the persistent reminder store. Resolves to
 * `<resolveConfigDir>/reminder/reminders.sqlite` — co-located with other
 * persistent state under the dev/prod profile root, but in its own
 * subdirectory so the slice can be removed without touching unrelated
 * state. Mirrors `defaultSqliteVecMemoryStorePath()` (slice E) +
 * `defaultSqliteTaskLedgerPath()` (slice F).
 */
export function defaultSqliteReminderStorePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveConfigDir(env), "reminder", "reminders.sqlite");
}

/**
 * Minimal logger surface used by the store to surface degraded-mode
 * warnings + idempotency notices. Decoupled from the project logger so
 * tests can inject a capturing stub without pulling the full logging
 * infrastructure. Mirrors slice E's `SqliteVecMemoryStoreLogger` shape.
 */
export type SqliteReminderStoreLogger = {
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
};

const NO_OP_LOGGER: SqliteReminderStoreLogger = {
  warn() {
    /* swallow */
  },
  info() {
    /* swallow */
  },
  debug() {
    /* swallow */
  },
};

/**
 * Construction options for `SqliteReminderStore.open`. `dbPath` is
 * required; everything else is injectable for tests + slice integration.
 */
export type SqliteReminderStoreOpenOptions = {
  /**
   * Absolute path to the sqlite file. Use
   * `defaultSqliteReminderStorePath()` for the production location.
   */
  readonly dbPath: string;
  /**
   * Override for the warning sink. Defaults to a no-op (production
   * callers wire `createSubsystemLogger("reminder")`); tests pass a
   * capturing logger.
   */
  readonly logger?: SqliteReminderStoreLogger;
  /**
   * ISO-8601 clock seam for `createdAt`. Tests pin a deterministic
   * value; production omits this and the store uses
   * `new Date().toISOString()`.
   */
  readonly now?: () => string;
};

/**
 * Schema (v1):
 *
 *   meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)
 *     - schema_version=<int>
 *
 *   reminders(
 *     reminder_id      TEXT PRIMARY KEY,
 *     identity_id      TEXT NOT NULL,
 *     fire_at          TEXT NOT NULL,                         -- ISO-8601
 *     content          TEXT NOT NULL,
 *     delivery_channel TEXT NOT NULL,
 *     delivery_to      TEXT NOT NULL,
 *     status           TEXT NOT NULL
 *       CHECK(status IN ('pending','fired','cancelled')),
 *     created_at       TEXT NOT NULL                           -- ISO-8601
 *   )
 *
 *   idx_reminders_identity_fire_at
 *     ON reminders (identity_id, fire_at)
 *
 * Identity isolation: every read predicates on `identity_id = ?`. The
 * primary index is `(identity_id, fire_at)` so the common
 * "list pending reminders for identity X ordered by fireAt" query is
 * index-covered. There is NO cross-identity index; `reminderId` alone
 * never crosses operators (invariant #16 / sub-plan §6 acceptance).
 */
const CREATE_META = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`;

const CREATE_REMINDERS = `
  CREATE TABLE IF NOT EXISTS reminders (
    reminder_id      TEXT PRIMARY KEY,
    identity_id      TEXT NOT NULL,
    fire_at          TEXT NOT NULL,
    content          TEXT NOT NULL,
    delivery_channel TEXT NOT NULL,
    delivery_to      TEXT NOT NULL,
    status           TEXT NOT NULL CHECK(status IN ('pending','fired','cancelled')),
    created_at       TEXT NOT NULL
  )
`;

const CREATE_REMINDERS_INDEX_IDENTITY_FIRE_AT = `
  CREATE INDEX IF NOT EXISTS idx_reminders_identity_fire_at
    ON reminders (identity_id, fire_at)
`;

/**
 * Persistent `ReminderStore` impl backed by `node:sqlite`'s
 * `DatabaseSync`. Mirrors slice E + slice F storage discipline —
 * idempotent schema migration, schema_version row, per-`IdentityId`
 * predicates on every read.
 */
export class SqliteReminderStore implements ReminderStore {
  private readonly db: DatabaseSync;
  private readonly logger: SqliteReminderStoreLogger;
  private readonly nowIso: () => string;
  private closed = false;

  private constructor(params: {
    db: DatabaseSync;
    logger: SqliteReminderStoreLogger;
    nowIso: () => string;
  }) {
    this.db = params.db;
    this.logger = params.logger;
    this.nowIso = params.nowIso;
  }

  /**
   * Async factory. Opens (or creates) the sqlite file at `opts.dbPath`,
   * runs the v1 schema migration idempotently, and returns the
   * configured store. Rejects on:
   * - empty / whitespace-only `dbPath` (defensible failure mode per
   *   invariant #15);
   * - `node:sqlite` unavailable in the host runtime (delegated to
   *   `requireNodeSqlite`).
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  static async open(
    opts: SqliteReminderStoreOpenOptions,
  ): Promise<SqliteReminderStore> {
    if (!opts.dbPath || opts.dbPath.trim().length === 0) {
      throw new Error("SqliteReminderStore.open: dbPath is required");
    }

    const dir = path.dirname(opts.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const { DatabaseSync: DatabaseSyncCtor } = requireNodeSqlite();
    const db = new DatabaseSyncCtor(opts.dbPath);
    // busy_timeout is per-connection; align with slice E + slice F so
    // concurrent agent-turn writes retry instead of failing immediately
    // with SQLITE_BUSY.
    db.exec("PRAGMA busy_timeout = 5000");

    runSchemaMigration(db);

    const logger = opts.logger ?? NO_OP_LOGGER;
    const nowIso = opts.now ?? (() => new Date().toISOString());

    return new SqliteReminderStore({ db, logger, nowIso });
  }

  /**
   * Releases the underlying `DatabaseSync` so callers can re-open the
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
   * Returns the migrated schema version (1 in this slice). Used by
   * tests + future migration code to assert the on-disk shape matches
   * the in-process expectation.
   */
  getSchemaVersion(): number {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get("schema_version") as { value: string } | undefined;
    if (!row) {
      return 0;
    }
    const parsed = Number.parseInt(row.value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async schedule(input: ScheduleReminderInput): Promise<void> {
    this.assertOpen();
    this.assertNonEmpty("reminderId", input.reminderId);
    this.assertNonEmpty("ownerIdentityId", input.ownerIdentityId);

    // Idempotency: a second insert under the same `(reminderId,
    // ownerIdentityId)` is a no-op (cron-rehydration replay safe).
    // Cross-identity collision on `reminderId` is rejected — the
    // primary key on `reminder_id` would surface a UNIQUE violation,
    // and we surface that as a typed error so callers can react.
    const existing = this.fetchRow(input.reminderId);
    if (existing) {
      if (existing.identity_id !== input.ownerIdentityId) {
        throw new Error(
          `SqliteReminderStore.schedule: reminderId ${input.reminderId} already owned by a different identity`,
        );
      }
      // Same identity — idempotent no-op (sub-plan §6 acceptance).
      return;
    }

    const createdAt = this.nowIso();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO reminders (reminder_id, identity_id, fire_at, content, delivery_channel, delivery_to, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(
          input.reminderId,
          input.ownerIdentityId,
          input.fireAt,
          input.content,
          input.deliveryChannel,
          input.deliveryTo,
          createdAt,
        );
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async markFired(reminderId: string, identityId: IdentityId): Promise<void> {
    this.assertOpen();
    this.assertNonEmpty("reminderId", reminderId);
    this.assertNonEmpty("identityId", identityId);

    const row = this.fetchRowForIdentity(reminderId, identityId);
    if (!row) {
      throw new Error(
        `SqliteReminderStore.markFired: record not found (reminderId=${reminderId})`,
      );
    }
    if (row.status === "fired") {
      // Idempotent retry — cron-fire callback may be replayed.
      return;
    }
    if (row.status === "cancelled") {
      throw new Error(
        `SqliteReminderStore.markFired: illegal transition cancelled → fired (reminderId=${reminderId})`,
      );
    }

    this.transition(reminderId, identityId, "fired");
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async cancel(reminderId: string, identityId: IdentityId): Promise<void> {
    this.assertOpen();
    this.assertNonEmpty("reminderId", reminderId);
    this.assertNonEmpty("identityId", identityId);

    const row = this.fetchRowForIdentity(reminderId, identityId);
    if (!row) {
      throw new Error(
        `SqliteReminderStore.cancel: record not found (reminderId=${reminderId})`,
      );
    }
    if (row.status === "cancelled") {
      return;
    }
    if (row.status === "fired") {
      throw new Error(
        `SqliteReminderStore.cancel: illegal transition fired → cancelled (reminderId=${reminderId})`,
      );
    }

    this.transition(reminderId, identityId, "cancelled");
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async get(
    reminderId: string,
    identityId: IdentityId,
  ): Promise<ReminderRecord | undefined> {
    this.assertOpen();
    if (
      typeof reminderId !== "string" ||
      reminderId.length === 0 ||
      typeof identityId !== "string" ||
      identityId.length === 0
    ) {
      return undefined;
    }
    const row = this.fetchRowForIdentity(reminderId, identityId);
    return row ? rowToRecord(row) : undefined;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async list(filter: ListRemindersFilter): Promise<readonly ReminderRecord[]> {
    this.assertOpen();
    this.assertNonEmpty("filter.identityId", filter.identityId);

    const wheres: string[] = ["identity_id = ?"];
    const args: Array<string> = [filter.identityId];
    if (filter.status !== undefined) {
      wheres.push("status = ?");
      args.push(filter.status);
    }
    if (filter.fireBefore !== undefined) {
      wheres.push("fire_at < ?");
      args.push(filter.fireBefore);
    }

    const sql = `SELECT reminder_id, identity_id, fire_at, content,
                        delivery_channel, delivery_to, status, created_at
                   FROM reminders
                  WHERE ${wheres.join(" AND ")}
                  ORDER BY fire_at ASC, reminder_id ASC`;

    const rows = this.db.prepare(sql).all(...args) as Array<ReminderRow>;
    return Object.freeze(rows.map(rowToRecord));
  }

  /**
   * Test/observability seam. Returns the SQL string EXPLAIN QUERY PLAN
   * uses for `list({identityId})` so the index-coverage acceptance
   * test (sub-plan §6 line 24) can assert that
   * `idx_reminders_identity_fire_at` is the chosen access path.
   */
  explainListQueryPlan(filter: ListRemindersFilter): readonly string[] {
    this.assertOpen();
    const wheres: string[] = ["identity_id = ?"];
    const args: Array<string> = [filter.identityId];
    if (filter.status !== undefined) {
      wheres.push("status = ?");
      args.push(filter.status);
    }
    if (filter.fireBefore !== undefined) {
      wheres.push("fire_at < ?");
      args.push(filter.fireBefore);
    }
    const sql = `EXPLAIN QUERY PLAN
                 SELECT reminder_id FROM reminders
                  WHERE ${wheres.join(" AND ")}
                  ORDER BY fire_at ASC`;
    const rows = this.db.prepare(sql).all(...args) as Array<{
      detail: string;
    }>;
    return rows.map((r) => r.detail);
  }

  private fetchRow(reminderId: string): ReminderRow | undefined {
    return this.db
      .prepare(
        `SELECT reminder_id, identity_id, fire_at, content,
                delivery_channel, delivery_to, status, created_at
           FROM reminders
          WHERE reminder_id = ?
          LIMIT 1`,
      )
      .get(reminderId) as ReminderRow | undefined;
  }

  private fetchRowForIdentity(
    reminderId: string,
    identityId: IdentityId,
  ): ReminderRow | undefined {
    return this.db
      .prepare(
        `SELECT reminder_id, identity_id, fire_at, content,
                delivery_channel, delivery_to, status, created_at
           FROM reminders
          WHERE identity_id = ? AND reminder_id = ?
          LIMIT 1`,
      )
      .get(identityId, reminderId) as ReminderRow | undefined;
  }

  private transition(
    reminderId: string,
    identityId: IdentityId,
    nextStatus: ReminderStatus,
  ): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `UPDATE reminders SET status = ?
            WHERE identity_id = ? AND reminder_id = ?`,
        )
        .run(nextStatus, identityId, reminderId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("SqliteReminderStore is closed");
    }
  }

  private assertNonEmpty(field: string, value: string): void {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `SqliteReminderStore: ${field} must be a non-empty string`,
      );
    }
  }
}

function runSchemaMigration(db: DatabaseSync): void {
  db.exec(CREATE_META);
  db.exec(CREATE_REMINDERS);
  db.exec(CREATE_REMINDERS_INDEX_IDENTITY_FIRE_AT);

  // Stamp schema_version on first open; preserve on subsequent opens.
  // INSERT OR IGNORE keeps the migration idempotent — re-running on a
  // populated DB is a no-op. Same shape as slice E PR-#160 / slice F
  // PR-#171 migration.
  db.prepare(
    "INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)",
  ).run(String(SQLITE_REMINDER_STORE_SCHEMA_VERSION));
}

type ReminderRow = {
  reminder_id: string;
  identity_id: string;
  fire_at: string;
  content: string;
  delivery_channel: string;
  delivery_to: string;
  status: string;
  created_at: string;
};

function rowToRecord(row: ReminderRow): ReminderRecord {
  if (!isKnownStatus(row.status)) {
    // Future-schema row appeared in a current binary — surface it
    // rather than silently coercing. Same posture as slice E's
    // EpisodicMemoryEventSchema.parse() on row read.
    throw new Error(
      `SqliteReminderStore: unknown status on row reminder_id=${row.reminder_id}: ${row.status}`,
    );
  }
  return Object.freeze({
    reminderId: row.reminder_id,
    ownerIdentityId: row.identity_id as IdentityId,
    fireAt: row.fire_at,
    content: row.content,
    deliveryChannel: row.delivery_channel,
    deliveryTo: row.delivery_to,
    status: row.status,
    createdAt: row.created_at,
  });
}

function isKnownStatus(value: string): value is ReminderStatus {
  return value === "pending" || value === "fired" || value === "cancelled";
}
