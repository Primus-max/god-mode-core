/**
 * Cron/Scheduler Phase 6 — production reminder-store bootstrap
 * (per-process singleton).
 *
 * Mirrors slice E's `memory-store-bootstrap.ts` discipline:
 * - Per-process singleton keyed on a STABLE SIGNATURE of the cfg fields
 *   the bootstrap actually reads (state-dir env). The per-turn cfg
 *   resolver deep-clones the config, so reference equality would force
 *   a rebuild on every turn.
 * - Defense-in-depth: failure to open the sqlite store is downgraded to
 *   `InMemoryReminderStore` so the gateway stays callable end-to-end
 *   (invariant #15 — the reminder layer is observability+persistence,
 *   it MUST NOT block the gateway boot).
 * - Rehydration: on first construction the bootstrap loads pending
 *   reminders and re-registers cron callbacks for each unfired
 *   `fireAt` (parity with `CronService.start()` rehydration). The
 *   rehydration call is dependency-injected so test cases can assert
 *   the registration list without a real `CronService`.
 *
 * Boundary discipline (invariant #8):
 * - Lives in `src/server/`, NOT in `src/platform/commitment/` and NOT
 *   in `src/platform/decision/`.
 * - Imports only from the platform reminder module + identity surface +
 *   the project logger.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  InMemoryReminderStore,
  type ReminderRecord,
  type ReminderStore,
} from "../platform/reminder/reminder-store.js";
import {
  SqliteReminderStore,
  defaultSqliteReminderStorePath,
  type SqliteReminderStoreLogger,
} from "../platform/reminder/sqlite-reminder-store.js";
import type { IdentityId } from "../platform/identity/identity-id.js";

const log = createSubsystemLogger("reminder");

/**
 * Public surface of the bootstrap. `reminderStore` is non-null — the
 * fallback path returns `InMemoryReminderStore` so callers never
 * branch on `undefined`.
 */
export type ReminderRuntime = {
  readonly reminderStore: ReminderStore;
  /**
   * Pending records discovered at construction time, returned to
   * callers so they can re-register cron callbacks (the bootstrap
   * itself does NOT touch the cron service — registration is the
   * caller's responsibility, mirroring the slice E
   * `MemoryRuntime` shape).
   */
  readonly rehydrated: readonly ReminderRecord[];
};

/**
 * Test-injection seam. Production omits everything; tests inject the
 * factory + logger.
 */
export type ReminderRuntimeDeps = {
  readonly openSqliteStore?: (params: {
    readonly dbPath: string;
    readonly logger: SqliteReminderStoreLogger;
  }) => Promise<ReminderStore>;
  readonly resolveDbPath?: () => string;
  readonly logger?: { warn(message: string): void; info?(message: string): void };
  /**
   * Test-only: skip the rehydration loop. Production callers always
   * rehydrate (the rehydration is the whole point).
   */
  readonly skipRehydration?: boolean;
  /**
   * Optional set of identities to rehydrate. Without this hint the
   * bootstrap cannot enumerate every identity (the SQL `list` requires
   * an `identityId`). Production wires the active `IdentityRegistry`'s
   * known ids so the rehydration covers every operator on cold start.
   */
  readonly rehydrateIdentities?: readonly IdentityId[];
};

const RUNTIME_KEY = Symbol.for("openclaw.cron-scheduler.reminder-runtime-singleton");

type Singleton = {
  signature: string;
  runtime: Promise<ReminderRuntime>;
};

function getStore(): { current?: Singleton } {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[RUNTIME_KEY]) {
    g[RUNTIME_KEY] = { current: undefined };
  }
  return g[RUNTIME_KEY] as { current?: Singleton };
}

/**
 * Stable signature for memoization. Captures only the inputs the
 * bootstrap actually reads — currently the resolved DB path (which
 * folds in OPENCLAW_STATE_DIR / HOME) and the supplied rehydrate-
 * identities hint. Any field NOT in the signature is memoization-
 * irrelevant.
 */
function computeReminderRuntimeSignature(deps: ReminderRuntimeDeps): string {
  const dbPath = deps.resolveDbPath
    ? safelyResolve(deps.resolveDbPath)
    : safelyResolve(defaultSqliteReminderStorePath);
  const ids = deps.rehydrateIdentities ?? [];
  return JSON.stringify({
    dbPath,
    ids: [...ids].sort(),
    skipRehydration: deps.skipRehydration === true,
  });
}

function safelyResolve(fn: () => string): string {
  try {
    return fn();
  } catch {
    return "<unresolved>";
  }
}

/**
 * Resolve the per-process reminder runtime. Cached on a stable
 * signature so a per-turn cfg deep-clone does NOT trigger a rebuild.
 */
export async function getReminderRuntime(
  deps: ReminderRuntimeDeps = {},
): Promise<ReminderRuntime> {
  const store = getStore();
  const signature = computeReminderRuntimeSignature(deps);
  if (store.current && store.current.signature === signature) {
    return store.current.runtime;
  }
  const logger = deps.logger ?? log;
  if (store.current) {
    logger.info?.(
      "[reminder-store-bootstrap] rebuilding reminder runtime — signature changed",
    );
  }
  const runtime = buildReminderRuntime(deps);
  store.current = { signature, runtime };
  return runtime;
}

/**
 * Reset the per-process singleton. Test-only — production never calls
 * this.
 */
export function __resetReminderRuntimeForTests(): void {
  const store = getStore();
  store.current = undefined;
}

async function buildReminderRuntime(
  deps: ReminderRuntimeDeps,
): Promise<ReminderRuntime> {
  const logger = deps.logger ?? log;
  const reminderStore = await openStore(deps, logger);
  const rehydrated = deps.skipRehydration
    ? []
    : await rehydratePending(reminderStore, deps.rehydrateIdentities, logger);
  return { reminderStore, rehydrated };
}

async function openStore(
  deps: ReminderRuntimeDeps,
  logger: { warn(message: string): void; info?(message: string): void },
): Promise<ReminderStore> {
  const dbPath = deps.resolveDbPath
    ? deps.resolveDbPath()
    : defaultSqliteReminderStorePath();
  const open = deps.openSqliteStore ?? defaultOpenSqliteStore;
  try {
    const store = await open({
      dbPath,
      logger: {
        warn: (m) => logger.warn(m),
        info: (m) => logger.info?.(m),
        debug: () => {
          /* dropped at the production seam */
        },
      },
    });
    logger.info?.(
      `[reminder-store-bootstrap] opened SqliteReminderStore dbPath=${dbPath}`,
    );
    return store;
  } catch (err) {
    logger.warn(
      `[reminder-store-bootstrap] SqliteReminderStore.open failed (${describeError(err)}); using InMemoryReminderStore`,
    );
    return new InMemoryReminderStore();
  }
}

async function defaultOpenSqliteStore(params: {
  readonly dbPath: string;
  readonly logger: SqliteReminderStoreLogger;
}): Promise<ReminderStore> {
  return SqliteReminderStore.open(params);
}

/**
 * Rehydration helper. Walks each known identity, lists `pending`
 * records, and concatenates them so the caller can re-register cron
 * callbacks on top of the persisted source-of-truth. Failures inside
 * the loop are logged + skipped — one operator's broken row MUST NOT
 * block another operator's rehydration (defense in depth).
 */
async function rehydratePending(
  store: ReminderStore,
  identities: readonly IdentityId[] | undefined,
  logger: { warn(message: string): void; info?(message: string): void },
): Promise<readonly ReminderRecord[]> {
  if (!identities || identities.length === 0) {
    logger.info?.(
      "[reminder-store-bootstrap] rehydration skipped — no identities supplied",
    );
    return [];
  }
  const out: ReminderRecord[] = [];
  for (const identityId of identities) {
    try {
      const pending = await store.list({ identityId, status: "pending" });
      out.push(...pending);
    } catch (err) {
      logger.warn(
        `[reminder-store-bootstrap] rehydration list failed for identity=${identityId} (${describeError(err)})`,
      );
    }
  }
  logger.info?.(
    `[reminder-store-bootstrap] rehydrated pending count=${out.length} acrossIdentities=${identities.length}`,
  );
  return out;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
