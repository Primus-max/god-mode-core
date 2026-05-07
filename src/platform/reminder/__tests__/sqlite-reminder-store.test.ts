/**
 * Cron/Scheduler Phase 6 — `SqliteReminderStore` impl-specific tests.
 *
 * Per sub-plan §1 todo Phase 6 (~6 cases SQLite-specific):
 *   - Rehydration on restart: schedule → close DB → reopen → records persist.
 *   - Per-IdentityId predicates on every read (audit-grep on the source).
 *   - Schema migration baseline (version=1; future migrations gated).
 *   - Closed missing-record case: `get` on missing returns undefined.
 *   - SQL injection guard on `reminder_id` / `identity_id` (parameterized).
 *   - Index used: `EXPLAIN QUERY PLAN` shows `idx_reminders_identity_fire_at`.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { asIdentityId } from "../../identity/identity-id.js";

import {
  SQLITE_REMINDER_STORE_SCHEMA_VERSION,
  SqliteReminderStore,
  defaultSqliteReminderStorePath,
} from "../sqlite-reminder-store.js";

const VLADIMIR = asIdentityId("identity:vladimir");
const ALICE = asIdentityId("identity:alice");

describe("SqliteReminderStore — Phase 6 acceptance", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "openclaw-sqlite-reminder-"));
    dbPath = path.join(tmpDir, "reminders.sqlite");
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Windows transient handle hold — best-effort.
    }
  });

  it("rehydration on restart — records persist across close + reopen", async () => {
    const first = await SqliteReminderStore.open({ dbPath });
    await first.schedule({
      reminderId: "rehydrate-1",
      ownerIdentityId: VLADIMIR,
      fireAt: "2026-05-08T12:00:00.000Z",
      content: "позвонить клиенту",
      deliveryChannel: "telegram",
      deliveryTo: "6533456892",
    });
    await first.close();

    // Reopen on the SAME file — schema migration must be idempotent
    // and the persisted row must come back.
    const second = await SqliteReminderStore.open({ dbPath });
    const list = await second.list({ identityId: VLADIMIR });
    expect(list).toHaveLength(1);
    expect(list[0]?.reminderId).toBe("rehydrate-1");
    expect(list[0]?.status).toBe("pending");
    expect(list[0]?.content).toBe("позвонить клиенту");
    await second.close();
  });

  it("schema migration is idempotent across N opens; schema_version stable at 1", async () => {
    for (let i = 0; i < 3; i += 1) {
      const store = await SqliteReminderStore.open({ dbPath });
      expect(store.getSchemaVersion()).toBe(SQLITE_REMINDER_STORE_SCHEMA_VERSION);
      await store.close();
    }
  });

  it("schema_version constant equals 1 (forward-compat baseline)", () => {
    expect(SQLITE_REMINDER_STORE_SCHEMA_VERSION).toBe(1);
  });

  it("get on missing record returns undefined (closed missing-key set)", async () => {
    const store = await SqliteReminderStore.open({ dbPath });
    expect(await store.get("does-not-exist", VLADIMIR)).toBeUndefined();
    await store.close();
  });

  it("get with empty reminderId or empty identityId returns undefined (defensive)", async () => {
    const store = await SqliteReminderStore.open({ dbPath });
    expect(await store.get("", VLADIMIR)).toBeUndefined();
    expect(
      await store.get("anything", "" as unknown as typeof VLADIMIR),
    ).toBeUndefined();
    await store.close();
  });

  it("SQL injection guard — reminder_id with `'; DROP TABLE reminders --` does NOT drop the table", async () => {
    const store = await SqliteReminderStore.open({ dbPath });
    await store.schedule({
      reminderId: "real-1",
      ownerIdentityId: VLADIMIR,
      fireAt: "2026-05-08T12:00:00.000Z",
      content: "ok",
      deliveryChannel: "telegram",
      deliveryTo: "6533456892",
    });

    const evil = "'; DROP TABLE reminders; --";
    // get / markFired / cancel must treat the evil string as a literal
    // value, NOT a SQL fragment. The records table must survive.
    expect(await store.get(evil, VLADIMIR)).toBeUndefined();
    await expect(
      store.markFired(evil, VLADIMIR),
    ).rejects.toThrow(/not found/i);
    await expect(store.cancel(evil, VLADIMIR)).rejects.toThrow(/not found/i);

    // Real record still listable — table was NOT dropped.
    const list = await store.list({ identityId: VLADIMIR });
    expect(list).toHaveLength(1);
    expect(list[0]?.reminderId).toBe("real-1");
    await store.close();
  });

  it("SQL injection guard — identity_id with embedded quotes is bound, not interpolated", async () => {
    const store = await SqliteReminderStore.open({ dbPath });
    await store.schedule({
      reminderId: "real-2",
      ownerIdentityId: VLADIMIR,
      fireAt: "2026-05-08T12:00:00.000Z",
      content: "ok",
      deliveryChannel: "telegram",
      deliveryTo: "6533456892",
    });
    const evilIdentity = "' OR 1=1 --" as unknown as typeof VLADIMIR;
    // List under the evil identity returns ZERO rows — parameter
    // binding prevents the `OR 1=1` from matching every row.
    const list = await store.list({ identityId: evilIdentity });
    expect(list).toHaveLength(0);
    await store.close();
  });

  it("index used — EXPLAIN QUERY PLAN for list({identityId}) names idx_reminders_identity_fire_at", async () => {
    const store = await SqliteReminderStore.open({ dbPath });
    // Need at least one row so the planner has data to consider.
    await store.schedule({
      reminderId: "idx-1",
      ownerIdentityId: VLADIMIR,
      fireAt: "2026-05-08T12:00:00.000Z",
      content: "ok",
      deliveryChannel: "telegram",
      deliveryTo: "6533456892",
    });
    const plan = store.explainListQueryPlan({ identityId: VLADIMIR });
    const joined = plan.join(" | ");
    // The planner output mentions either the index name directly or
    // a SEARCH/USING line referencing it. Both shapes are accepted —
    // future SQLite versions tweak the wording but always include the
    // index name when it's used.
    expect(joined).toMatch(/idx_reminders_identity_fire_at/u);
    await store.close();
  });

  it("identity isolation enforced at SQL — every read is parameterized on identity_id", () => {
    // Audit-grep over the source: every public-facing read path must
    // pass `identity_id` through `wheres` array (parameterized) before
    // executing. This is a structural check (defense in depth — the
    // runtime tests above verify behaviour; this verifies the source
    // shape that produces the behaviour).
    const sourcePath = path.resolve(
      __dirname,
      "..",
      "sqlite-reminder-store.ts",
    );
    const source = readFileSync(sourcePath, "utf8");

    // 1. The dynamic-SQL builders (`list`, `explainListQueryPlan`) must
    //    seed the WHERE clause with `identity_id = ?` as the FIRST
    //    predicate. Both helpers share the `["identity_id = ?"]` shape.
    const seededWheres = source.match(/wheres:\s*string\[\]\s*=\s*\[\s*"identity_id\s*=\s*\?"\s*\]/gu);
    expect(seededWheres?.length ?? 0).toBeGreaterThanOrEqual(2);

    // 2. The static SELECT in `fetchRowForIdentity` (the per-record
    //    lookup) must literally include `identity_id = ?` in its WHERE.
    const fetchForIdentityBlock = source.match(
      /fetchRowForIdentity[\s\S]+?WHERE[\s\S]+?LIMIT\s+1/u,
    );
    expect(fetchForIdentityBlock?.[0]).toMatch(/identity_id\s*=\s*\?/u);

    // 3. The status-transition writer (`transition`) must scope its
    //    UPDATE by identity_id (no cross-identity status flips).
    const updateStatement = source.match(
      /UPDATE\s+reminders\s+SET\s+status[\s\S]+?WHERE[\s\S]+?reminder_id\s*=\s*\?/u,
    );
    expect(updateStatement?.[0]).toMatch(/identity_id\s*=\s*\?/u);
  });

  it("default DB path resolves to <state-dir>/reminder/reminders.sqlite", () => {
    const resolved = defaultSqliteReminderStorePath();
    expect(resolved.endsWith(path.join("reminder", "reminders.sqlite"))).toBe(
      true,
    );
  });

  it("cross-identity primary-key collision on schedule is rejected", async () => {
    const store = await SqliteReminderStore.open({ dbPath });
    await store.schedule({
      reminderId: "shared-id",
      ownerIdentityId: VLADIMIR,
      fireAt: "2026-05-08T12:00:00.000Z",
      content: "v",
      deliveryChannel: "telegram",
      deliveryTo: "111",
    });
    await expect(
      store.schedule({
        reminderId: "shared-id",
        ownerIdentityId: ALICE,
        fireAt: "2026-05-08T13:00:00.000Z",
        content: "a",
        deliveryChannel: "telegram",
        deliveryTo: "222",
      }),
    ).rejects.toThrow(/different identity/i);
    await store.close();
  });
});
