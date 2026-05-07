/**
 * Cron/Scheduler Phase 6 — `ReminderStore` contract tests.
 *
 * Run against BOTH `InMemoryReminderStore` and `SqliteReminderStore`
 * via a `describe.each` table — slice E `MemoryStore` contract precedent
 * (PR-#160) + slice F `TaskLedger` contract precedent (PR-#171).
 *
 * Per sub-plan §1 todo Phase 6 (~12 cases):
 *   - Round-trip: schedule → list returns same record.
 *   - Identity isolation: operator A's `list()` NEVER returns operator
 *     B's records.
 *   - `fire_at` filter: `fireBefore: 'X'` returns only records where
 *     `fire_at < X`.
 *   - Status filter: `status: 'pending'` returns only pending.
 *   - Status-transition invariants: `markFired` after `cancel` rejects
 *     (and vice versa).
 *   - `pending → fired` works.
 *   - `pending → cancelled` works.
 *   - `fired → pending` illegal (SQL CHECK or app-layer guard).
 *   - Schema_version row written on init (sqlite-only — guarded).
 *   - Concurrent writes via parallel `Promise.all` (atomicity check).
 *   - DB path resolves to the default location (sqlite-only — guarded).
 *   - Config-driven path override works (sqlite-only — guarded).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { asIdentityId } from "../../identity/identity-id.js";

import {
  InMemoryReminderStore,
  type ReminderStore,
  type ScheduleReminderInput,
} from "../reminder-store.js";
import {
  SqliteReminderStore,
  defaultSqliteReminderStorePath,
} from "../sqlite-reminder-store.js";

const VLADIMIR = asIdentityId("identity:vladimir");
const ALICE = asIdentityId("identity:alice");

type StoreFactory = {
  readonly label: string;
  readonly create: () => Promise<{
    readonly store: ReminderStore;
    readonly cleanup: () => Promise<void>;
  }>;
};

const FACTORIES: readonly StoreFactory[] = [
  {
    label: "InMemoryReminderStore",
    create: async () => {
      const store = new InMemoryReminderStore();
      return { store, cleanup: async () => undefined };
    },
  },
  {
    label: "SqliteReminderStore",
    create: async () => {
      const tmp = mkdtempSync(
        path.join(tmpdir(), "openclaw-sqlite-reminder-contract-"),
      );
      const dbPath = path.join(tmp, "reminders.sqlite");
      const store = await SqliteReminderStore.open({ dbPath });
      return {
        store,
        cleanup: async () => {
          await store.close();
          try {
            rmSync(tmp, { recursive: true, force: true });
          } catch {
            // Windows transient handle hold — best-effort cleanup.
          }
        },
      };
    },
  },
];

function mkInput(
  reminderId: string,
  fireAt: string,
  identity = VLADIMIR,
  overrides: Partial<ScheduleReminderInput> = {},
): ScheduleReminderInput {
  return {
    reminderId,
    ownerIdentityId: identity,
    fireAt,
    content: "позвонить клиенту",
    deliveryChannel: "telegram",
    deliveryTo: "6533456892",
    ...overrides,
  };
}

describe.each(FACTORIES)("ReminderStore contract — $label", ({ create }) => {
  let store: ReminderStore;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const built = await create();
    store = built.store;
    cleanup = built.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  it("round-trip — schedule → list returns the same record (status='pending')", async () => {
    await store.schedule(
      mkInput("reminder-rt-1", "2026-05-08T12:00:00.000Z"),
    );
    const list = await store.list({ identityId: VLADIMIR });
    expect(list).toHaveLength(1);
    const [rec] = list;
    expect(rec?.reminderId).toBe("reminder-rt-1");
    expect(rec?.ownerIdentityId).toBe(VLADIMIR);
    expect(rec?.fireAt).toBe("2026-05-08T12:00:00.000Z");
    expect(rec?.content).toBe("позвонить клиенту");
    expect(rec?.deliveryChannel).toBe("telegram");
    expect(rec?.deliveryTo).toBe("6533456892");
    expect(rec?.status).toBe("pending");
    expect(typeof rec?.createdAt).toBe("string");
  });

  it("get with the right identity returns the record; cross-identity get returns undefined", async () => {
    await store.schedule(
      mkInput("reminder-cross-1", "2026-05-08T12:00:00.000Z", VLADIMIR),
    );
    expect(await store.get("reminder-cross-1", VLADIMIR)).toBeDefined();
    // Cross-identity read MUST NOT leak the row even though the id
    // exists. Defense in depth — sub-plan §6 acceptance.
    expect(await store.get("reminder-cross-1", ALICE)).toBeUndefined();
  });

  it("identity isolation — operator A's list NEVER returns operator B's records", async () => {
    await store.schedule(
      mkInput("v-1", "2026-05-08T12:00:00.000Z", VLADIMIR, {
        content: "v-task",
      }),
    );
    await store.schedule(
      mkInput("a-1", "2026-05-08T12:00:00.000Z", ALICE, {
        content: "a-task",
      }),
    );
    const vList = await store.list({ identityId: VLADIMIR });
    expect(vList).toHaveLength(1);
    expect(vList[0]?.reminderId).toBe("v-1");
    expect(vList[0]?.content).toBe("v-task");

    const aList = await store.list({ identityId: ALICE });
    expect(aList).toHaveLength(1);
    expect(aList[0]?.reminderId).toBe("a-1");
    expect(aList[0]?.content).toBe("a-task");
  });

  it("fireBefore filter — returns only records whose fire_at < threshold", async () => {
    await store.schedule(
      mkInput("early", "2026-05-08T08:00:00.000Z", VLADIMIR),
    );
    await store.schedule(
      mkInput("mid", "2026-05-08T12:00:00.000Z", VLADIMIR),
    );
    await store.schedule(
      mkInput("late", "2026-05-08T18:00:00.000Z", VLADIMIR),
    );

    const before12 = await store.list({
      identityId: VLADIMIR,
      fireBefore: "2026-05-08T12:00:00.000Z",
    });
    // Strictly less-than — `mid` is NOT included.
    expect(before12.map((r) => r.reminderId)).toEqual(["early"]);

    const before18 = await store.list({
      identityId: VLADIMIR,
      fireBefore: "2026-05-08T18:00:00.000Z",
    });
    expect(before18.map((r) => r.reminderId).toSorted()).toEqual(
      ["early", "mid"].toSorted(),
    );
  });

  it("status filter — returns only records with the matching status", async () => {
    await store.schedule(
      mkInput("p-1", "2026-05-08T08:00:00.000Z", VLADIMIR),
    );
    await store.schedule(
      mkInput("p-2", "2026-05-08T09:00:00.000Z", VLADIMIR),
    );
    await store.schedule(
      mkInput("f-1", "2026-05-08T10:00:00.000Z", VLADIMIR),
    );
    await store.markFired("f-1", VLADIMIR);
    await store.schedule(
      mkInput("c-1", "2026-05-08T11:00:00.000Z", VLADIMIR),
    );
    await store.cancel("c-1", VLADIMIR);

    const pendingOnly = await store.list({
      identityId: VLADIMIR,
      status: "pending",
    });
    expect(pendingOnly.map((r) => r.reminderId).toSorted()).toEqual(
      ["p-1", "p-2"].toSorted(),
    );

    const firedOnly = await store.list({
      identityId: VLADIMIR,
      status: "fired",
    });
    expect(firedOnly.map((r) => r.reminderId)).toEqual(["f-1"]);

    const cancelledOnly = await store.list({
      identityId: VLADIMIR,
      status: "cancelled",
    });
    expect(cancelledOnly.map((r) => r.reminderId)).toEqual(["c-1"]);
  });

  it("pending → fired transition works; idempotent on retry", async () => {
    await store.schedule(
      mkInput("trans-1", "2026-05-08T12:00:00.000Z", VLADIMIR),
    );
    await store.markFired("trans-1", VLADIMIR);
    let rec = await store.get("trans-1", VLADIMIR);
    expect(rec?.status).toBe("fired");

    // Idempotent on retry — markFired on already-fired is a no-op.
    await store.markFired("trans-1", VLADIMIR);
    rec = await store.get("trans-1", VLADIMIR);
    expect(rec?.status).toBe("fired");
  });

  it("pending → cancelled transition works; idempotent on retry", async () => {
    await store.schedule(
      mkInput("trans-2", "2026-05-08T12:00:00.000Z", VLADIMIR),
    );
    await store.cancel("trans-2", VLADIMIR);
    let rec = await store.get("trans-2", VLADIMIR);
    expect(rec?.status).toBe("cancelled");

    // Idempotent on retry — cancel on already-cancelled is a no-op.
    await store.cancel("trans-2", VLADIMIR);
    rec = await store.get("trans-2", VLADIMIR);
    expect(rec?.status).toBe("cancelled");
  });

  it("fired → cancelled is illegal (status-transition invariant)", async () => {
    await store.schedule(
      mkInput("trans-3", "2026-05-08T12:00:00.000Z", VLADIMIR),
    );
    await store.markFired("trans-3", VLADIMIR);
    await expect(
      store.cancel("trans-3", VLADIMIR),
    ).rejects.toThrow(/illegal transition/i);
  });

  it("cancelled → fired is illegal (status-transition invariant)", async () => {
    await store.schedule(
      mkInput("trans-4", "2026-05-08T12:00:00.000Z", VLADIMIR),
    );
    await store.cancel("trans-4", VLADIMIR);
    await expect(
      store.markFired("trans-4", VLADIMIR),
    ).rejects.toThrow(/illegal transition/i);
  });

  it("markFired / cancel under wrong identity REJECT (do not leak record)", async () => {
    await store.schedule(
      mkInput("xid-1", "2026-05-08T12:00:00.000Z", VLADIMIR),
    );
    await expect(
      store.markFired("xid-1", ALICE),
    ).rejects.toThrow(/not found|record not found/i);
    await expect(
      store.cancel("xid-1", ALICE),
    ).rejects.toThrow(/not found|record not found/i);

    // Vladimir's record is untouched — still pending.
    const rec = await store.get("xid-1", VLADIMIR);
    expect(rec?.status).toBe("pending");
  });

  it("schedule is idempotent on (reminderId, ownerIdentityId)", async () => {
    await store.schedule(
      mkInput("idem-1", "2026-05-08T12:00:00.000Z", VLADIMIR, {
        content: "first",
      }),
    );
    await store.schedule(
      mkInput("idem-1", "2026-05-09T13:00:00.000Z", VLADIMIR, {
        content: "second-write-IGNORED",
      }),
    );
    const rec = await store.get("idem-1", VLADIMIR);
    // First write wins — idempotent semantics.
    expect(rec?.content).toBe("first");
    expect(rec?.fireAt).toBe("2026-05-08T12:00:00.000Z");
  });

  it("concurrent schedule via Promise.all — all records persist", async () => {
    const inputs: ScheduleReminderInput[] = [];
    for (let i = 0; i < 10; i += 1) {
      inputs.push(
        mkInput(
          `concurrent-${i}`,
          `2026-05-08T${String(i).padStart(2, "0")}:00:00.000Z`,
          VLADIMIR,
        ),
      );
    }
    await Promise.all(inputs.map((input) => store.schedule(input)));
    const list = await store.list({ identityId: VLADIMIR });
    expect(list).toHaveLength(10);
    expect(list.map((r) => r.reminderId).toSorted()).toEqual(
      inputs.map((i) => i.reminderId).toSorted(),
    );
  });

  it("list returns records ordered oldest-first by fireAt", async () => {
    await store.schedule(
      mkInput("order-c", "2026-05-08T18:00:00.000Z", VLADIMIR),
    );
    await store.schedule(
      mkInput("order-a", "2026-05-08T08:00:00.000Z", VLADIMIR),
    );
    await store.schedule(
      mkInput("order-b", "2026-05-08T12:00:00.000Z", VLADIMIR),
    );
    const list = await store.list({ identityId: VLADIMIR });
    expect(list.map((r) => r.reminderId)).toEqual([
      "order-a",
      "order-b",
      "order-c",
    ]);
  });
});

/**
 * SQLite-only acceptance: schema_version row + path resolution. These
 * cases live outside the contract loop because the InMemory impl has
 * no on-disk schema.
 */
describe("SqliteReminderStore — schema + path discipline", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(
      path.join(tmpdir(), "openclaw-sqlite-reminder-schema-"),
    );
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("schema_version row is present and equals 1 after open", async () => {
    const dbPath = path.join(tmpDir, "reminders.sqlite");
    const store = await SqliteReminderStore.open({ dbPath });
    expect(store.getSchemaVersion()).toBe(1);
    await store.close();
  });

  it("default DB path resolves under the configured state dir", () => {
    const resolved = defaultSqliteReminderStorePath();
    // The default lives under <resolveConfigDir>/reminder/ — the
    // exact dir varies by host (HOME / OPENCLAW_STATE_DIR), but the
    // tail must be `reminder/reminders.sqlite`.
    expect(resolved).toMatch(/reminder[\\/]+reminders\.sqlite$/);
  });

  it("default DB path honours OPENCLAW_STATE_DIR override", () => {
    const override = path.join(tmpDir, "custom-state");
    const resolved = defaultSqliteReminderStorePath({
      OPENCLAW_STATE_DIR: override,
    } as unknown as NodeJS.ProcessEnv);
    expect(resolved.startsWith(override)).toBe(true);
    expect(resolved).toMatch(/reminder[\\/]+reminders\.sqlite$/);
  });
});
