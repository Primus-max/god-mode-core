/**
 * Cron/Scheduler Phase 6 — bootstrap tests.
 *
 * Per sub-plan §1 todo Phase 6 (~3 cases):
 *   - Singleton instance reused across calls (memoization).
 *   - Idempotent re-initialization (double-call doesn't crash).
 *   - Rehydration registers cron callbacks for pending unfired
 *     reminders (the bootstrap returns the pending records; the caller
 *     re-registers cron callbacks — see acceptance test that wires the
 *     production caller).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { asIdentityId } from "../platform/identity/identity-id.js";
import {
  InMemoryReminderStore,
  type ReminderStore,
} from "../platform/reminder/reminder-store.js";
import { SqliteReminderStore } from "../platform/reminder/sqlite-reminder-store.js";

import {
  __resetReminderRuntimeForTests,
  getReminderRuntime,
  type ReminderRuntimeDeps,
} from "./reminder-store-bootstrap.js";

const VLADIMIR = asIdentityId("identity:vladimir");
const ALICE = asIdentityId("identity:alice");

describe("reminder-store-bootstrap — Phase 6 wiring", () => {
  let tmpDir: string;

  beforeEach(() => {
    __resetReminderRuntimeForTests();
    tmpDir = mkdtempSync(path.join(tmpdir(), "openclaw-reminder-bootstrap-"));
  });

  afterEach(() => {
    __resetReminderRuntimeForTests();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("singleton instance reused across calls with the same signature", async () => {
    const dbPath = path.join(tmpDir, "reminders.sqlite");
    const deps: ReminderRuntimeDeps = {
      resolveDbPath: () => dbPath,
      skipRehydration: true,
    };
    const a = await getReminderRuntime(deps);
    const b = await getReminderRuntime(deps);
    expect(b).toBe(a);
    expect(b.reminderStore).toBe(a.reminderStore);
  });

  it("idempotent re-initialization — calling getReminderRuntime twice does not crash", async () => {
    const dbPath = path.join(tmpDir, "reminders.sqlite");
    const deps: ReminderRuntimeDeps = {
      resolveDbPath: () => dbPath,
      skipRehydration: true,
    };
    await expect(getReminderRuntime(deps)).resolves.toBeDefined();
    await expect(getReminderRuntime(deps)).resolves.toBeDefined();
  });

  it("falls back to InMemoryReminderStore when sqlite open throws (defense-in-depth)", async () => {
    const warnings: string[] = [];
    const deps: ReminderRuntimeDeps = {
      openSqliteStore: async () => {
        throw new Error("simulated sqlite open failure");
      },
      logger: {
        warn: (m) => warnings.push(m),
        info: () => {
          /* swallow */
        },
      },
      skipRehydration: true,
    };
    const runtime = await getReminderRuntime(deps);
    expect(runtime.reminderStore).toBeInstanceOf(InMemoryReminderStore);
    expect(
      warnings.some((line) =>
        line.includes("SqliteReminderStore.open failed"),
      ),
    ).toBe(true);
  });

  it("rehydration returns pending records for the supplied identities", async () => {
    const dbPath = path.join(tmpDir, "reminders.sqlite");

    // Seed the DB FIRST so when the bootstrap opens it on the same
    // path, the records are already persisted.
    const seed = await SqliteReminderStore.open({ dbPath });
    await seed.schedule({
      reminderId: "v-pending-1",
      ownerIdentityId: VLADIMIR,
      fireAt: "2026-05-08T12:00:00.000Z",
      content: "ok",
      deliveryChannel: "telegram",
      deliveryTo: "111",
    });
    await seed.schedule({
      reminderId: "v-fired-1",
      ownerIdentityId: VLADIMIR,
      fireAt: "2026-05-08T13:00:00.000Z",
      content: "ok",
      deliveryChannel: "telegram",
      deliveryTo: "111",
    });
    await seed.markFired("v-fired-1", VLADIMIR);
    await seed.schedule({
      reminderId: "a-pending-1",
      ownerIdentityId: ALICE,
      fireAt: "2026-05-08T14:00:00.000Z",
      content: "ok",
      deliveryChannel: "telegram",
      deliveryTo: "222",
    });
    await seed.close();

    const deps: ReminderRuntimeDeps = {
      resolveDbPath: () => dbPath,
      rehydrateIdentities: [VLADIMIR, ALICE],
    };
    const runtime = await getReminderRuntime(deps);
    // Only `pending` records — the fired one is excluded.
    expect(
      runtime.rehydrated.map((r) => r.reminderId).toSorted(),
    ).toEqual(["a-pending-1", "v-pending-1"]);
    // Each rehydrated record carries identity + fireAt so the caller
    // can re-register the cron callback.
    for (const rec of runtime.rehydrated) {
      expect(typeof rec.fireAt).toBe("string");
      expect(typeof rec.ownerIdentityId).toBe("string");
      expect(rec.status).toBe("pending");
    }
  });

  it("rehydration with no identities returns empty list (cannot enumerate without hint)", async () => {
    const dbPath = path.join(tmpDir, "reminders.sqlite");
    const deps: ReminderRuntimeDeps = {
      resolveDbPath: () => dbPath,
    };
    const runtime = await getReminderRuntime(deps);
    expect(runtime.rehydrated).toEqual([]);
  });

  it("uses injected openSqliteStore factory — production wires this with SqliteReminderStore.open", async () => {
    const captured: Array<{ readonly dbPath: string }> = [];
    const sentinel: ReminderStore = new InMemoryReminderStore();
    const dbPath = path.join(tmpDir, "custom.sqlite");
    const deps: ReminderRuntimeDeps = {
      resolveDbPath: () => dbPath,
      openSqliteStore: async (params) => {
        captured.push({ dbPath: params.dbPath });
        return sentinel;
      },
      skipRehydration: true,
    };
    const runtime = await getReminderRuntime(deps);
    expect(runtime.reminderStore).toBe(sentinel);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.dbPath).toBe(dbPath);
  });
});
