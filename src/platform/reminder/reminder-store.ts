/**
 * Cron/Scheduler Phase 5 (placeholder) / Phase 6 — `ReminderStore` interface
 * + `InMemoryReminderStore` test impl.
 *
 * Phase 5 introduces the interface shape so the runtime adapter and the
 * cron-fire callback can wire against a stable surface; Phase 6 ships
 * the production `SqliteReminderStore` against the same interface (sub-
 * plan §1 todo Phase 6 — schema discipline mirrors slice E P3 SqliteVec
 * + `src/cron/store.ts` migration). The in-memory impl below is a STUB
 * for tests + the Phase 5 fan-out wiring (production is wired with
 * `undefined` until Phase 6 drops in the sqlite impl).
 *
 * Boundary discipline (invariant #8):
 * - `src/platform/reminder/` imports ONLY from `src/platform/identity/`,
 *   the standard library, and re-exports from this file's own module.
 *   No `src/platform/commitment/` imports here — the module's contract
 *   is identity-keyed reminder persistence, NOT commitment internals.
 * - Every read predicates on `identity_id = ?` (sub-plan §1 todo Phase 6
 *   acceptance: «operator A's list NEVER returns operator B's»). The
 *   in-memory impl filters in code; the sqlite impl pushes the predicate
 *   into the SQL.
 * - `schedule(...)` / `markFired(...)` / `cancel(...)` / `list(...)` /
 *   `get(...)` form a CLOSED method set. The status-transition graph is
 *   one-way `pending → fired | cancelled`; `markFired` and `cancel` are
 *   monotonic.
 *
 * Slice K precedent — `src/platform/reminder/index.ts` exports the
 * `ReminderEntrySchema` / `ReminderQueryShapeSchema` for the recall path
 * (Phase 4 of slice K). Cron/Scheduler ADDITIVELY adds the write-side
 * surface here without touching the recall types.
 */

import type { IdentityId } from "../identity/identity-id.js";

/**
 * Closed three-value lifecycle for a reminder record. Mirrors the
 * `WorldStateSnapshot.scheduledReminders.records[*].status` slice — the
 * SQL store enforces the same enum via `CHECK` constraint (Phase 6).
 *
 * Transition graph (one-way):
 * - `pending` → `fired` (cron callback ran + delivery attempted)
 * - `pending` → `cancelled` (operator cancelled before fire — Phase 6
 *   ships the cancel surface; Phase 5 only needs `pending` and the
 *   cron-fire callback's `markFired` transition)
 *
 * Reverse transitions (`fired → pending`, `cancelled → pending`,
 * `fired → cancelled`) are STRUCTURALLY ILLEGAL — both impls reject.
 */
export type ReminderStatus = "pending" | "fired" | "cancelled";

/**
 * Persistent record shape stored by `ReminderStore`. Mirrors the
 * `WorldStateSnapshot.ScheduledReminderRecord` shape but lives outside
 * `src/platform/commitment/` so the store can be consumed by both the
 * runtime adapter (Phase 5) and the cron-fire callback (Phase 5)
 * without dragging the commitment-layer types into this module's
 * import surface.
 *
 * `ownerIdentityId` is the canonical identity scope — every read
 * predicates on this field (defense-in-depth; sub-plan §6 acceptance).
 */
export type ReminderRecord = {
  readonly reminderId: string;
  readonly ownerIdentityId: IdentityId;
  /** ISO-8601 timestamp when the cron callback should fire. */
  readonly fireAt: string;
  /** Operator-facing message body delivered on fire. */
  readonly content: string;
  readonly deliveryChannel: string;
  readonly deliveryTo: string;
  /** ISO-8601 timestamp when the record was first inserted. */
  readonly createdAt: string;
  readonly status: ReminderStatus;
};

/**
 * Input shape for `schedule(...)`. The store mints `createdAt` (ISO-8601
 * captured at insert time) so callers cannot smuggle a back-dated
 * record. `status` is implicit `pending`.
 */
export type ScheduleReminderInput = {
  readonly reminderId: string;
  readonly ownerIdentityId: IdentityId;
  readonly fireAt: string;
  readonly content: string;
  readonly deliveryChannel: string;
  readonly deliveryTo: string;
};

/**
 * Filter shape for `list(...)`. `identityId` is mandatory — there is no
 * cross-identity list operation by design (sub-plan §6 acceptance). The
 * impl applies optional `status` / `fireBefore` predicates after the
 * identity scope is fixed.
 */
export type ListRemindersFilter = {
  readonly identityId: IdentityId;
  readonly status?: ReminderStatus;
  /** ISO-8601 — return only records whose `fireAt < fireBefore`. */
  readonly fireBefore?: string;
};

/**
 * Closed-shape interface for reminder persistence. Phase 5 ships the
 * `InMemoryReminderStore` impl below; Phase 6 ships
 * `SqliteReminderStore` against the SAME interface. Production
 * code paths (the cron-fire callback + the runtime adapter) only ever
 * consume this contract — they never type-narrow to a specific impl.
 */
export interface ReminderStore {
  /**
   * Inserts a new `pending` record. Idempotent on `reminderId`: a
   * second insert with the same id under the same identity is a no-op
   * (Phase 5 callers mint `reminderId` via `crypto.randomUUID()` so
   * collisions are vanishingly unlikely; the idempotency exists to
   * survive cron-rehydration replays — sub-plan §6 acceptance).
   */
  schedule(input: ScheduleReminderInput): Promise<void>;
  /**
   * Transitions `pending → fired`. No-op when the record is already
   * `fired` (idempotent on retry); rejects when the record is
   * `cancelled` (illegal `cancelled → fired` transition).
   */
  markFired(reminderId: string, identityId: IdentityId): Promise<void>;
  /**
   * Transitions `pending → cancelled`. Phase 5 does not expose a cancel
   * UX (sub-plan §0.4 out-of-scope); the method is on the interface so
   * Phase 6's sqlite impl can land it without widening the contract.
   */
  cancel(reminderId: string, identityId: IdentityId): Promise<void>;
  /**
   * Returns a single record by `(reminderId, identityId)`. Returns
   * `undefined` when no record matches (cross-identity reads return
   * `undefined` even when the id exists under a different identity —
   * defense-in-depth).
   */
  get(reminderId: string, identityId: IdentityId): Promise<ReminderRecord | undefined>;
  /**
   * Lists records for the supplied identity, optionally filtered by
   * `status` and/or `fireBefore`. Returns oldest-first by `fireAt`.
   */
  list(filter: ListRemindersFilter): Promise<readonly ReminderRecord[]>;
}

/**
 * In-memory test implementation of `ReminderStore`. Used by the Phase 5
 * tests and as the default `undefined` placeholder when no production
 * store is wired (Phase 6 supplies the sqlite impl). Survives the
 * lifetime of the process; does NOT survive restart.
 */
export class InMemoryReminderStore implements ReminderStore {
  readonly #records = new Map<string, ReminderRecord>();

  async schedule(input: ScheduleReminderInput): Promise<void> {
    const key = this.#key(input.reminderId, input.ownerIdentityId);
    const existing = this.#records.get(key);
    if (existing) {
      // Idempotent on (reminderId, identityId): second insert is a
      // no-op (cron-rehydration replay safe).
      return;
    }
    this.#records.set(
      key,
      Object.freeze({
        reminderId: input.reminderId,
        ownerIdentityId: input.ownerIdentityId,
        fireAt: input.fireAt,
        content: input.content,
        deliveryChannel: input.deliveryChannel,
        deliveryTo: input.deliveryTo,
        createdAt: new Date().toISOString(),
        status: "pending" as const,
      } satisfies ReminderRecord),
    );
  }

  async markFired(reminderId: string, identityId: IdentityId): Promise<void> {
    const key = this.#key(reminderId, identityId);
    const record = this.#records.get(key);
    if (!record) {
      throw new Error(
        `InMemoryReminderStore.markFired: record not found (reminderId=${reminderId})`,
      );
    }
    if (record.status === "fired") {
      // Idempotent retry — cron-fire callback may be replayed.
      return;
    }
    if (record.status === "cancelled") {
      throw new Error(
        `InMemoryReminderStore.markFired: illegal transition cancelled → fired (reminderId=${reminderId})`,
      );
    }
    this.#records.set(key, Object.freeze({ ...record, status: "fired" as const }));
  }

  async cancel(reminderId: string, identityId: IdentityId): Promise<void> {
    const key = this.#key(reminderId, identityId);
    const record = this.#records.get(key);
    if (!record) {
      throw new Error(
        `InMemoryReminderStore.cancel: record not found (reminderId=${reminderId})`,
      );
    }
    if (record.status === "cancelled") return;
    if (record.status === "fired") {
      throw new Error(
        `InMemoryReminderStore.cancel: illegal transition fired → cancelled (reminderId=${reminderId})`,
      );
    }
    this.#records.set(
      key,
      Object.freeze({ ...record, status: "cancelled" as const }),
    );
  }

  async get(
    reminderId: string,
    identityId: IdentityId,
  ): Promise<ReminderRecord | undefined> {
    return this.#records.get(this.#key(reminderId, identityId));
  }

  async list(filter: ListRemindersFilter): Promise<readonly ReminderRecord[]> {
    const out: ReminderRecord[] = [];
    for (const record of this.#records.values()) {
      if (record.ownerIdentityId !== filter.identityId) continue;
      if (filter.status !== undefined && record.status !== filter.status) continue;
      if (
        filter.fireBefore !== undefined &&
        !(record.fireAt < filter.fireBefore)
      ) {
        continue;
      }
      out.push(record);
    }
    out.sort((a, b) => (a.fireAt < b.fireAt ? -1 : a.fireAt > b.fireAt ? 1 : 0));
    return Object.freeze(out);
  }

  #key(reminderId: string, identityId: IdentityId): string {
    return `${identityId}${reminderId}`;
  }
}
