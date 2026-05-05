import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { requireNodeSqlite } from "../../memory/sqlite.js";
import { resolveConfigDir } from "../../utils.js";
import type { IdentityId } from "../identity/identity-id.js";

import { asTaskId, type TaskId } from "./task-id.js";
import type { TaskLedger, TaskNotFound } from "./task-ledger.js";
import {
  TaskCreateInputSchema,
  TaskListQuerySchema,
  TaskUpdatePatchSchema,
  isTaskTerminalStatus,
  isTaskTransitionAllowed,
  type TaskCreateInput,
  type TaskListQuery,
  type TaskListResult,
  type TaskRecord,
  type TaskStatus,
  type TaskUpdatePatch,
} from "./task-record.js";

/**
 * Phase-4 schema version. Bumping this requires a forward migration
 * gated on the `meta.schema_version` row. v1 is the initial cut and
 * matches slice E's `SqliteVecMemoryStore` discipline (PR-#160).
 */
export const SQLITE_TASK_LEDGER_SCHEMA_VERSION = 1 as const;

/**
 * Default DB path for the persistent task ledger. Resolves to
 * `<resolveConfigDir>/task/identity-task-ledger.sqlite` — co-located
 * with other state under the dev/prod profile root, but in its OWN
 * subdirectory so the slice F DB can be removed without touching
 * unrelated state (per sub-plan §6, "blast radius isolated" from the
 * slice E memory DB). Mirrors the helper shape established by
 * `defaultSqliteVecMemoryStorePath()` (slice E).
 */
export function defaultSqliteTaskLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveConfigDir(env), "task", "identity-task-ledger.sqlite");
}

/**
 * Minimal logger surface used by the ledger to surface degraded-mode
 * warnings + idempotency notices (e.g. complete-on-completed). Decoupled
 * from the project logger so tests can inject a capturing stub without
 * pulling the full logging infrastructure. Mirrors slice E's
 * `SqliteVecMemoryStoreLogger` shape, extended with `info` / `debug`
 * per sub-plan Phase 4 spec.
 */
export type SqliteTaskLedgerLogger = {
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
};

const NO_OP_LOGGER: SqliteTaskLedgerLogger = {
  warn() {
    /* swallow — production callers should inject a real logger */
  },
  info() {
    /* swallow */
  },
  debug() {
    /* swallow */
  },
};

/**
 * Construction options for `SqliteTaskLedger.open`. `dbPath` is
 * required; everything else is injectable for tests + slice
 * integration.
 */
export type SqliteTaskLedgerOpenOptions = {
  /**
   * Absolute path to the sqlite file. Use
   * `defaultSqliteTaskLedgerPath()` for the production location
   * `<resolveConfigDir>/task/identity-task-ledger.sqlite`.
   */
  readonly dbPath: string;
  /**
   * Override for the warning sink. Defaults to a no-op
   * (production callers wire `createSubsystemLogger("task")`); tests
   * pass a capturing logger.
   */
  readonly logger?: SqliteTaskLedgerLogger;
};

/**
 * Default `list` page size when the caller does not supply `limit`.
 * Aligns with slice E's `MemoryStore` default so query shapes are
 * consistent across persistent surfaces.
 */
const DEFAULT_LIMIT = 50;

/**
 * Schema (v1):
 *
 *   meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)
 *     - schema_version=<int>
 *
 *   tasks(
 *     id TEXT PRIMARY KEY,             -- TaskId (`task:<slug>`)
 *     identity_id TEXT NOT NULL,       -- IdentityId
 *     label TEXT NOT NULL,
 *     status TEXT NOT NULL,            -- one of TASK_STATUSES
 *     summary TEXT NOT NULL,
 *     source_effect_family TEXT,
 *     source_effect_id TEXT,
 *     result_json TEXT,                -- nullable JSON-encoded result string
 *     created_at INTEGER NOT NULL,     -- microseconds since epoch (insert order)
 *     updated_at INTEGER NOT NULL,     -- microseconds since epoch (last write)
 *     completed_at INTEGER             -- nullable; set ONLY on `complete`
 *   )
 *
 *   idx_tasks_identity_status_created
 *     ON tasks (identity_id, status, created_at DESC)
 *
 * Identity isolation: every read predicates on `identity_id = ?`. The
 * primary index is `(identity_id, status, created_at DESC)` so the
 * common `<active_tasks>`-block query (`statuses ∈ {open, in_progress}`,
 * newest-first) is index-covered. There is NO cross-identity index;
 * `TaskId` alone never crosses operators (invariant #16).
 */
const CREATE_META = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`;

const CREATE_TASKS = `
  CREATE TABLE IF NOT EXISTS tasks (
    id                   TEXT PRIMARY KEY,
    identity_id          TEXT NOT NULL,
    label                TEXT NOT NULL,
    status               TEXT NOT NULL,
    summary              TEXT NOT NULL,
    source_effect_family TEXT,
    source_effect_id     TEXT,
    result_json          TEXT,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL,
    completed_at         INTEGER
  )
`;

const CREATE_TASKS_INDEX_IDENTITY_STATUS_CREATED = `
  CREATE INDEX IF NOT EXISTS idx_tasks_identity_status_created
    ON tasks (identity_id, status, created_at DESC)
`;

/**
 * Persistent `TaskLedger` impl backed by `node:sqlite`'s `DatabaseSync`.
 * Mirrors slice E `SqliteVecMemoryStore` storage discipline (PR-#160) —
 * idempotent schema migration, schema_version row, per-`IdentityId`
 * predicates on every read.
 *
 * The store is opened via the static `SqliteTaskLedger.open` async
 * factory because:
 * - migration must happen before any write returns to the caller, and
 *   the constructor cannot return a Promise;
 * - keeps the call shape symmetric with slice E so wiring code can
 *   `await Promise.all([SqliteVecMemoryStore.open(...),
 *   SqliteTaskLedger.open(...)])` interchangeably.
 *
 * Per slice-F invariant #8 this module imports ONLY from:
 * - `../../utils.js` (path resolution, stdlib-only)
 * - `../../memory/sqlite.js` (the existing node:sqlite shim)
 * - `../identity/identity-id.js` (the IdentityId brand)
 * - the Phase 2 task-module siblings.
 *
 * It does NOT import from `src/platform/decision/`, NOT from
 * `src/platform/commitment/`, and NOT from any agent-runner / channel
 * code. Per invariant #5/#6 it accepts ONLY structured types — never a
 * `RawUserTurn` / `UserPrompt` — and it never does string matching
 * against operator text on the way in.
 */
export class SqliteTaskLedger implements TaskLedger {
  private readonly db: DatabaseSync;
  private readonly logger: SqliteTaskLedgerLogger;
  private closed = false;

  private constructor(params: { db: DatabaseSync; logger: SqliteTaskLedgerLogger }) {
    this.db = params.db;
    this.logger = params.logger;
  }

  /**
   * Async factory. Opens (or creates) the sqlite file at `opts.dbPath`,
   * runs the v1 schema migration idempotently, and returns the
   * configured ledger. Rejects on:
   * - empty / whitespace-only `dbPath` (defensible failure mode per
   *   invariant #15);
   * - `node:sqlite` unavailable in the host runtime (delegated to
   *   `requireNodeSqlite`).
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  static async open(opts: SqliteTaskLedgerOpenOptions): Promise<SqliteTaskLedger> {
    if (!opts.dbPath || opts.dbPath.trim().length === 0) {
      throw new Error("SqliteTaskLedger.open: dbPath is required");
    }

    const dir = path.dirname(opts.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const { DatabaseSync: DatabaseSyncCtor } = requireNodeSqlite();
    const db = new DatabaseSyncCtor(opts.dbPath);
    // busy_timeout is per-connection; align with slice E + the rest of
    // the project so concurrent agent-turn writes retry instead of
    // failing immediately with SQLITE_BUSY.
    db.exec("PRAGMA busy_timeout = 5000");

    runSchemaMigration(db);

    const logger = opts.logger ?? NO_OP_LOGGER;

    return new SqliteTaskLedger({ db, logger });
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
  // matching slice E's `SqliteVecMemoryStore` contract.
  // eslint-disable-next-line @typescript-eslint/require-await
  async create(input: TaskCreateInput): Promise<TaskRecord> {
    this.assertOpen();
    // Validate at the boundary so the caller's static types alone
    // can't sneak a malformed payload past us.
    const parsed = TaskCreateInputSchema.parse(input);
    const id = mintTaskId();
    const nowIso = nowIsoString();
    const nowUs = nowMicros();
    const status: TaskStatus = "open";

    // Single-row insert wrapped in an explicit transaction. node:sqlite
    // DatabaseSync is single-threaded; the transaction is here for
    // atomicity-on-failure (e.g. disk full halfway through), not
    // multi-statement isolation.
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO tasks (id, identity_id, label, status, summary, source_effect_family, source_effect_id, result_json, created_at, updated_at, completed_at)\n` +
            `VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
        )
        .run(
          id,
          parsed.ownerIdentityId,
          parsed.label,
          status,
          parsed.summary,
          parsed.sourceEffectFamily ?? null,
          parsed.sourceEffectId ?? null,
          nowUs,
          nowUs,
        );
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    return {
      id,
      ownerIdentityId: parsed.ownerIdentityId,
      label: parsed.label,
      status,
      summary: parsed.summary,
      createdAt: nowIso,
      updatedAt: nowIso,
      ...(parsed.sourceEffectFamily !== undefined
        ? { sourceEffectFamily: parsed.sourceEffectFamily }
        : {}),
      ...(parsed.sourceEffectId !== undefined ? { sourceEffectId: parsed.sourceEffectId } : {}),
    };
  }

  list(query: TaskListQuery): Promise<TaskListResult> {
    this.assertOpen();
    const parsed = TaskListQuerySchema.parse(query);
    const limit = parsed.limit ?? DEFAULT_LIMIT;
    if (limit <= 0) {
      return Promise.resolve({ tasks: [] });
    }

    const statuses = parsed.statuses;
    const sinceUs = parsed.since !== undefined ? Date.parse(parsed.since) * 1000 : undefined;

    // Build the WHERE clause dynamically — sqlite parameter binding
    // does NOT support an array as a single placeholder, so we
    // materialise the IN-list with explicit `?` placeholders.
    const wheres: string[] = ["identity_id = ?"];
    const args: Array<string | number> = [parsed.ownerIdentityId];

    if (statuses && statuses.length > 0) {
      const placeholders = statuses.map(() => "?").join(", ");
      wheres.push(`status IN (${placeholders})`);
      args.push(...statuses);
    }
    if (sinceUs !== undefined && Number.isFinite(sinceUs)) {
      wheres.push("updated_at >= ?");
      args.push(sinceUs);
    }

    const whereSql = wheres.join(" AND ");
    const sql = `SELECT id, identity_id, label, status, summary,
                        source_effect_family, source_effect_id, result_json,
                        created_at, updated_at, completed_at
                   FROM tasks
                  WHERE ${whereSql}
                  ORDER BY created_at DESC, id ASC
                  LIMIT ?`;
    args.push(limit);

    const rows = this.db.prepare(sql).all(...args) as Array<TaskRow>;
    const tasks = rows.map(rowToRecord);
    return Promise.resolve({ tasks });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async get(ownerIdentityId: IdentityId, taskId: TaskId): Promise<TaskRecord | undefined> {
    this.assertOpen();
    return this.fetchByOwnerAndId(ownerIdentityId, taskId);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async update(
    ownerIdentityId: IdentityId,
    taskId: TaskId,
    patch: TaskUpdatePatch,
  ): Promise<TaskRecord | TaskNotFound> {
    this.assertOpen();
    const parsedPatch = TaskUpdatePatchSchema.parse(patch);

    const existing = this.fetchByOwnerAndId(ownerIdentityId, taskId);
    if (existing === undefined) {
      return { kind: "not_found" };
    }

    // Defense-in-depth state-machine guard at the impl boundary. The
    // schema-level refinement on TaskUpdatePatchSchema only fires when
    // the caller supplied BOTH currentStatus and status; here we read
    // the persisted status and re-check, regardless of what (if
    // anything) the caller carried on the patch.
    if (parsedPatch.status !== undefined && parsedPatch.status !== existing.status) {
      if (!isTaskTransitionAllowed(existing.status, parsedPatch.status)) {
        throw new Error(
          `Illegal task status transition: ${existing.status} -> ${parsedPatch.status} (see sub-plan §6 state-machine table)`,
        );
      }
    }

    return this.applyPatchPersisted(existing, parsedPatch);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async complete(
    ownerIdentityId: IdentityId,
    taskId: TaskId,
    result?: string,
  ): Promise<TaskRecord | TaskNotFound> {
    this.assertOpen();
    const existing = this.fetchByOwnerAndId(ownerIdentityId, taskId);
    if (existing === undefined) {
      return { kind: "not_found" };
    }

    if (existing.status === "completed") {
      // Idempotent terminal: no-op + warn. Returns the existing record
      // unchanged so the caller's happy-path branch works regardless
      // of whether this is the first or Nth call.
      this.logger.warn(
        `SqliteTaskLedger: complete on task ${existing.id} which is already completed; no-op`,
      );
      return existing;
    }

    // Any other state must be allowed to transition into `completed`.
    if (!isTaskTransitionAllowed(existing.status, "completed")) {
      throw new Error(
        `Illegal task status transition: ${existing.status} -> completed (see sub-plan §6 state-machine table)`,
      );
    }

    const patch: TaskUpdatePatch = {
      status: "completed",
      ...(result !== undefined && result.length > 0 ? { result } : {}),
    };
    return this.applyPatchPersisted(existing, patch);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async cancel(
    ownerIdentityId: IdentityId,
    taskId: TaskId,
    reason?: string,
  ): Promise<TaskRecord | TaskNotFound> {
    this.assertOpen();
    const existing = this.fetchByOwnerAndId(ownerIdentityId, taskId);
    if (existing === undefined) {
      return { kind: "not_found" };
    }

    if (existing.status === "cancelled") {
      this.logger.warn(
        `SqliteTaskLedger: cancel on task ${existing.id} which is already cancelled; no-op`,
      );
      return existing;
    }

    if (!isTaskTransitionAllowed(existing.status, "cancelled")) {
      throw new Error(
        `Illegal task status transition: ${existing.status} -> cancelled (see sub-plan §6 state-machine table)`,
      );
    }

    const patch: TaskUpdatePatch = {
      status: "cancelled",
      ...(reason !== undefined && reason.length > 0 ? { result: reason } : {}),
    };
    return this.applyPatchPersisted(existing, patch);
  }

  private fetchByOwnerAndId(
    ownerIdentityId: IdentityId,
    taskId: TaskId,
  ): TaskRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, identity_id, label, status, summary,
                source_effect_family, source_effect_id, result_json,
                created_at, updated_at, completed_at
           FROM tasks
          WHERE identity_id = ? AND id = ?
          LIMIT 1`,
      )
      .get(ownerIdentityId, taskId) as TaskRow | undefined;
    if (!row) {
      return undefined;
    }
    return rowToRecord(row);
  }

  private applyPatchPersisted(existing: TaskRecord, patch: TaskUpdatePatch): TaskRecord {
    const nextStatus: TaskStatus = patch.status ?? existing.status;
    const nextLabel = patch.label ?? existing.label;
    const nextSummary = patch.summary ?? existing.summary;
    // Result write semantics: when transitioning into a terminal state
    // we record the supplied result; when re-entering the same
    // terminal status (idempotent path) we already returned early in
    // complete/cancel. For non-terminal patches the result column
    // stays untouched unless the caller explicitly carries one.
    const nextResult: string | undefined = patch.result ?? existing.result;

    const nowIso = nowIsoString();
    const nowUs = nowMicros();
    const completedAtUs =
      nextStatus === "completed"
        ? existing.completedAt !== undefined
          ? Date.parse(existing.completedAt) * 1000
          : nowUs
        : existing.completedAt !== undefined
          ? Date.parse(existing.completedAt) * 1000
          : null;

    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `UPDATE tasks
              SET label = ?,
                  status = ?,
                  summary = ?,
                  result_json = ?,
                  updated_at = ?,
                  completed_at = ?
            WHERE identity_id = ? AND id = ?`,
        )
        .run(
          nextLabel,
          nextStatus,
          nextSummary,
          nextResult !== undefined ? JSON.stringify(nextResult) : null,
          nowUs,
          completedAtUs,
          existing.ownerIdentityId,
          existing.id,
        );
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    const updatedAtIso = nowIso;
    // For completedAt: existing if already terminal, else now-iso when
    // the transition lands in `completed`, else undefined. `cancelled`
    // is terminal but NOT a completion — completedAt stays unset
    // (sub-plan §6 / acceptance criterion 7).
    const completedAtIso =
      nextStatus === "completed"
        ? existing.completedAt ?? updatedAtIso
        : existing.completedAt;

    return {
      id: existing.id,
      ownerIdentityId: existing.ownerIdentityId,
      label: nextLabel,
      status: nextStatus,
      summary: nextSummary,
      createdAt: existing.createdAt,
      updatedAt: updatedAtIso,
      ...(completedAtIso !== undefined ? { completedAt: completedAtIso } : {}),
      ...(nextResult !== undefined ? { result: nextResult } : {}),
      ...(existing.sourceEffectFamily !== undefined
        ? { sourceEffectFamily: existing.sourceEffectFamily }
        : {}),
      ...(existing.sourceEffectId !== undefined
        ? { sourceEffectId: existing.sourceEffectId }
        : {}),
    };
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("SqliteTaskLedger is closed");
    }
  }
}

function runSchemaMigration(db: DatabaseSync): void {
  db.exec(CREATE_META);
  db.exec(CREATE_TASKS);
  db.exec(CREATE_TASKS_INDEX_IDENTITY_STATUS_CREATED);

  // Stamp schema_version on first open; preserve on subsequent opens.
  // INSERT OR IGNORE keeps the migration idempotent — re-running on a
  // populated DB is a no-op. Same shape as slice E's PR-#160 migration.
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)").run(
    String(SQLITE_TASK_LEDGER_SCHEMA_VERSION),
  );
}

type TaskRow = {
  id: string;
  identity_id: string;
  label: string;
  status: string;
  summary: string;
  source_effect_family: string | null;
  source_effect_id: string | null;
  result_json: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

function rowToRecord(row: TaskRow): TaskRecord {
  const status = row.status as TaskStatus;
  if (!isKnownStatus(status)) {
    // Future-schema row appeared in a current binary — surface it
    // rather than silently coercing. Same posture as slice E's
    // EpisodicMemoryEventSchema.parse() on row read.
    throw new Error(`SqliteTaskLedger: unknown status on row id=${row.id}: ${row.status}`);
  }

  const result =
    row.result_json !== null && row.result_json !== undefined
      ? (JSON.parse(row.result_json) as string)
      : undefined;

  return {
    id: asTaskId(row.id),
    ownerIdentityId: row.identity_id as IdentityId,
    label: row.label,
    status,
    summary: row.summary,
    createdAt: microsToIso(row.created_at),
    updatedAt: microsToIso(row.updated_at),
    ...(row.completed_at !== null && row.completed_at !== undefined
      ? { completedAt: microsToIso(row.completed_at) }
      : {}),
    ...(result !== undefined ? { result } : {}),
    ...(row.source_effect_family !== null && row.source_effect_family !== undefined
      ? { sourceEffectFamily: row.source_effect_family }
      : {}),
    ...(row.source_effect_id !== null && row.source_effect_id !== undefined
      ? { sourceEffectId: row.source_effect_id }
      : {}),
  };
}

function isKnownStatus(value: string): value is TaskStatus {
  return (
    value === "open" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "cancelled" ||
    value === "failed"
  );
}

// `isTaskTerminalStatus` is re-exported via the impl shim for future
// consumers (Phase 5+); the unused-import lint is silenced here by
// referencing it indirectly. The state-machine guards above use
// `isTaskTransitionAllowed`; `isTaskTerminalStatus` is kept on the
// barrel for downstream use.
void isTaskTerminalStatus;

function nowMicros(): number {
  // Microsecond resolution to keep insertion order stable when two
  // writes land in the same millisecond. Same pattern as slice E.
  return Date.now() * 1000;
}

function nowIsoString(): string {
  return new Date().toISOString();
}

function microsToIso(us: number): string {
  return new Date(Math.floor(us / 1000)).toISOString();
}

function mintTaskId(): TaskId {
  return asTaskId(`task:${randomUUID()}`);
}
