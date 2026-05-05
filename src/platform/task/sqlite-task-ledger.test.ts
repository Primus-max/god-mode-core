import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { asIdentityId } from "../identity/identity-id.js";

import { isTaskId } from "./task-id.js";
import type { TaskCreateInput, TaskRecord } from "./task-record.js";
import type { TaskLedger } from "./task-ledger.js";
import {
  SqliteTaskLedger,
  defaultSqliteTaskLedgerPath,
  type SqliteTaskLedgerLogger,
} from "./sqlite-task-ledger.js";

/**
 * Slice F Phase 4 — `SqliteTaskLedger` acceptance tests. Per sub-plan §5
 * + §6, these tests:
 *
 * - exercise a REAL `node:sqlite` `DatabaseSync` against a tmp-dir file
 *   (no mocking the store under test);
 * - inject ONLY infrastructure deps (logger) — never spy on the
 *   function under test;
 * - cover the negative paths: malformed input rejected, `update` on
 *   unknown id returns `{ kind: "not_found" }` (NOT throws), illegal
 *   state-machine transition rejected at the impl boundary;
 * - assert per-`IdentityId` isolation across two operators on the same
 *   DB file (invariant #16);
 * - stress-test 100 sequential `create` calls to verify transaction
 *   behaviour + index correctness.
 */

const VLADIMIR = asIdentityId("identity:vladimir");
const ALICE = asIdentityId("identity:alice");

type CapturingLogger = SqliteTaskLedgerLogger & {
  readonly warnings: readonly string[];
  readonly infos: readonly string[];
  readonly debugs: readonly string[];
};

function createCapturingLogger(): CapturingLogger {
  const warnings: string[] = [];
  const infos: string[] = [];
  const debugs: string[] = [];
  return {
    warn(message: string) {
      warnings.push(message);
    },
    info(message: string) {
      infos.push(message);
    },
    debug(message: string) {
      debugs.push(message);
    },
    get warnings() {
      return warnings;
    },
    get infos() {
      return infos;
    },
    get debugs() {
      return debugs;
    },
  };
}

function createInput(
  identity = VLADIMIR,
  overrides: Partial<TaskCreateInput> = {},
): TaskCreateInput {
  return {
    ownerIdentityId: identity,
    label: "draft retrospective",
    summary: "post quarterly retro to #eng-leads",
    ...overrides,
  };
}

describe("SqliteTaskLedger — Phase 4 acceptance", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "openclaw-sqlite-task-ledger-"));
    dbPath = path.join(tmpDir, "identity-task-ledger.sqlite");
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — Windows sometimes holds an open DB
      // handle for a beat after `close()`. Same posture as slice E
      // PR-#160 — CI's tmpdir is wiped between jobs.
    }
  });

  it("a freshly-opened SqliteTaskLedger is assignable to the TaskLedger interface", async () => {
    const ledger: TaskLedger = await SqliteTaskLedger.open({ dbPath });
    expect(ledger).toBeInstanceOf(SqliteTaskLedger);
    await (ledger as SqliteTaskLedger).close();
  });

  it("schema_version row is present and equals 1 after open", async () => {
    const ledger = await SqliteTaskLedger.open({ dbPath });
    expect(ledger.getSchemaVersion()).toBe(1);
    await ledger.close();
  });

  it("create round-trip persists across close + reopen on the same file", async () => {
    const first = await SqliteTaskLedger.open({ dbPath });
    const created = await first.create(createInput());
    expect(isTaskId(created.id)).toBe(true);
    expect(created.status).toBe("open");
    expect(created.ownerIdentityId).toBe(VLADIMIR);
    await first.close();

    // Reopen on the SAME file — schema migration must be idempotent.
    const second = await SqliteTaskLedger.open({ dbPath });
    const list = await second.list({ ownerIdentityId: VLADIMIR });
    expect(list.tasks).toHaveLength(1);
    const [persisted] = list.tasks;
    expect(persisted?.id).toBe(created.id);
    expect(persisted?.label).toBe("draft retrospective");
    expect(persisted?.summary).toBe("post quarterly retro to #eng-leads");
    expect(persisted?.status).toBe("open");
    await second.close();
  });

  it("schema migration is idempotent — three sequential opens on the same file do not throw", async () => {
    const first = await SqliteTaskLedger.open({ dbPath });
    expect(first.getSchemaVersion()).toBe(1);
    await first.close();

    const second = await SqliteTaskLedger.open({ dbPath });
    expect(second.getSchemaVersion()).toBe(1);
    await second.close();

    const third = await SqliteTaskLedger.open({ dbPath });
    expect(third.getSchemaVersion()).toBe(1);
    await third.close();
  });

  it("identity isolation — two operators on the SAME DB file do not see each other's tasks", async () => {
    const ledger = await SqliteTaskLedger.open({ dbPath });

    const v = await ledger.create(createInput(VLADIMIR, { label: "v-task" }));
    const a = await ledger.create(createInput(ALICE, { label: "a-task" }));

    const vladimirList = await ledger.list({ ownerIdentityId: VLADIMIR });
    expect(vladimirList.tasks).toHaveLength(1);
    expect(vladimirList.tasks[0]?.id).toBe(v.id);
    expect(vladimirList.tasks[0]?.label).toBe("v-task");

    const aliceList = await ledger.list({ ownerIdentityId: ALICE });
    expect(aliceList.tasks).toHaveLength(1);
    expect(aliceList.tasks[0]?.id).toBe(a.id);
    expect(aliceList.tasks[0]?.label).toBe("a-task");

    // get under the wrong owner returns undefined — TaskId alone never
    // crosses operators (invariant #16).
    expect(await ledger.get(VLADIMIR, a.id)).toBeUndefined();
    expect(await ledger.get(ALICE, v.id)).toBeUndefined();

    // update under the wrong owner returns not_found — NOT throw.
    const wrongOwner = await ledger.update(VLADIMIR, a.id, { status: "in_progress" });
    expect(wrongOwner).toEqual({ kind: "not_found" });

    await ledger.close();
  });

  it("list with status filter returns only the matching statuses", async () => {
    const ledger = await SqliteTaskLedger.open({ dbPath });

    const open1 = await ledger.create(createInput(VLADIMIR, { label: "open-1" }));
    const open2 = await ledger.create(createInput(VLADIMIR, { label: "open-2" }));
    const wip = await ledger.create(createInput(VLADIMIR, { label: "wip" }));
    await ledger.update(VLADIMIR, wip.id, { status: "in_progress", currentStatus: "open" });
    const done = await ledger.create(createInput(VLADIMIR, { label: "done" }));
    await ledger.update(VLADIMIR, done.id, { status: "in_progress", currentStatus: "open" });
    await ledger.complete(VLADIMIR, done.id, "shipped");

    const openOnly = await ledger.list({
      ownerIdentityId: VLADIMIR,
      statuses: ["open"],
    });
    expect(openOnly.tasks.map((t) => t.id).toSorted()).toEqual(
      [open1.id, open2.id].toSorted(),
    );

    const activeOnly = await ledger.list({
      ownerIdentityId: VLADIMIR,
      statuses: ["open", "in_progress"],
    });
    expect(activeOnly.tasks).toHaveLength(3);
    expect(activeOnly.tasks.map((t) => t.id).toSorted()).toEqual(
      [open1.id, open2.id, wip.id].toSorted(),
    );

    await ledger.close();
  });

  it("list respects the limit cap (pagination)", async () => {
    const ledger = await SqliteTaskLedger.open({ dbPath });
    for (let i = 0; i < 5; i += 1) {
      await ledger.create(createInput(VLADIMIR, { label: `task-${i}` }));
    }
    const limited = await ledger.list({ ownerIdentityId: VLADIMIR, limit: 2 });
    expect(limited.tasks).toHaveLength(2);
    await ledger.close();
  });

  it("update on an unknown TaskId returns { kind: 'not_found' } and does NOT throw", async () => {
    const ledger = await SqliteTaskLedger.open({ dbPath });
    // The brand factory enforces format; "task:does-not-exist" is a
    // valid-shape TaskId that is simply not present in the DB.
    // We cast through `unknown` to construct the brand without going
    // through `asTaskId` (the runtime lookup is the assertion under test).
    const result = await ledger.update(
      VLADIMIR,
      "task:does-not-exist" as unknown as TaskRecord["id"],
      { status: "in_progress" },
    );
    expect(result).toEqual({ kind: "not_found" });
    await ledger.close();
  });

  it("complete on an unknown TaskId returns { kind: 'not_found' }", async () => {
    const ledger = await SqliteTaskLedger.open({ dbPath });
    const result = await ledger.complete(
      VLADIMIR,
      "task:does-not-exist" as unknown as TaskRecord["id"],
    );
    expect(result).toEqual({ kind: "not_found" });
    await ledger.close();
  });

  it("cancel on an unknown TaskId returns { kind: 'not_found' }", async () => {
    const ledger = await SqliteTaskLedger.open({ dbPath });
    const result = await ledger.cancel(
      VLADIMIR,
      "task:does-not-exist" as unknown as TaskRecord["id"],
    );
    expect(result).toEqual({ kind: "not_found" });
    await ledger.close();
  });

  it("malformed create input is rejected by the Phase 2 Zod schema", async () => {
    const ledger = await SqliteTaskLedger.open({ dbPath });
    await expect(
      ledger.create({
        ownerIdentityId: VLADIMIR,
        label: "",
        summary: "y",
      }),
    ).rejects.toThrow();
    await ledger.close();
  });

  it("state-machine guard at the impl boundary rejects illegal transitions", async () => {
    const ledger = await SqliteTaskLedger.open({ dbPath });
    const created = await ledger.create(createInput());
    // open -> in_progress is allowed
    const wip = (await ledger.update(VLADIMIR, created.id, {
      status: "in_progress",
      currentStatus: "open",
    })) as TaskRecord;
    expect(wip.status).toBe("in_progress");

    // Now mark it completed.
    const completed = (await ledger.complete(VLADIMIR, created.id, "shipped")) as TaskRecord;
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBeDefined();

    // completed -> open is illegal — even WITHOUT currentStatus on the
    // patch (the impl guard reads the persisted status). Phase 4 must
    // reject at the impl boundary.
    await expect(
      ledger.update(VLADIMIR, created.id, { status: "open" }),
    ).rejects.toThrow();

    await ledger.close();
  });

  it("complete sets completedAt; cancel does NOT set completedAt", async () => {
    const ledger = await SqliteTaskLedger.open({ dbPath });

    const a = await ledger.create(createInput(VLADIMIR, { label: "to-complete" }));
    await ledger.update(VLADIMIR, a.id, { status: "in_progress", currentStatus: "open" });
    const completed = (await ledger.complete(VLADIMIR, a.id, "done")) as TaskRecord;
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBeDefined();
    expect(completed.result).toBe("done");

    const b = await ledger.create(createInput(VLADIMIR, { label: "to-cancel" }));
    const cancelled = (await ledger.cancel(VLADIMIR, b.id, "user changed mind")) as TaskRecord;
    expect(cancelled.status).toBe("cancelled");
    // cancelled is terminal but NOT a completion — completedAt MUST be undefined.
    expect(cancelled.completedAt).toBeUndefined();
    expect(cancelled.result).toBe("user changed mind");

    await ledger.close();
  });

  it("complete on already-completed is idempotent (no-op + warn) and does NOT throw", async () => {
    const logger = createCapturingLogger();
    const ledger = await SqliteTaskLedger.open({ dbPath, logger });
    const created = await ledger.create(createInput());
    await ledger.update(VLADIMIR, created.id, {
      status: "in_progress",
      currentStatus: "open",
    });
    await ledger.complete(VLADIMIR, created.id, "first");
    const second = (await ledger.complete(VLADIMIR, created.id, "second")) as TaskRecord;
    expect(second.status).toBe("completed");
    // The original result is preserved on idempotent completion.
    expect(second.result).toBe("first");
    expect(logger.warnings.some((w) => w.includes("already completed"))).toBe(true);
    await ledger.close();
  });

  it("cancel on already-cancelled is idempotent (no-op + warn) and does NOT throw", async () => {
    const logger = createCapturingLogger();
    const ledger = await SqliteTaskLedger.open({ dbPath, logger });
    const created = await ledger.create(createInput());
    await ledger.cancel(VLADIMIR, created.id, "first reason");
    const second = (await ledger.cancel(VLADIMIR, created.id, "second reason")) as TaskRecord;
    expect(second.status).toBe("cancelled");
    expect(second.result).toBe("first reason");
    expect(logger.warnings.some((w) => w.includes("already cancelled"))).toBe(true);
    await ledger.close();
  });

  it("get under the same owner returns the persisted record", async () => {
    const ledger = await SqliteTaskLedger.open({ dbPath });
    const created = await ledger.create(
      createInput(VLADIMIR, {
        sourceEffectFamily: "task",
        sourceEffectId: "effect-task-1",
      }),
    );
    const fetched = await ledger.get(VLADIMIR, created.id);
    expect(fetched).toBeDefined();
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.sourceEffectFamily).toBe("task");
    expect(fetched?.sourceEffectId).toBe("effect-task-1");
    await ledger.close();
  });

  it("stress: 100 sequential create calls all land and are readable via list", async () => {
    const ledger = await SqliteTaskLedger.open({ dbPath });
    const ids: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      const created = await ledger.create(createInput(VLADIMIR, { label: `stress-${i}` }));
      ids.push(created.id);
    }
    // Default DEFAULT_LIMIT is 50 — pass an explicit higher limit.
    const all = await ledger.list({ ownerIdentityId: VLADIMIR, limit: 200 });
    expect(all.tasks).toHaveLength(100);
    expect(new Set(all.tasks.map((t) => t.id)).size).toBe(100);
    expect(new Set(ids).size).toBe(100);
    await ledger.close();
  });

  it("defaultSqliteTaskLedgerPath returns a path under the resolved config dir, in a `task` subdir, named `identity-task-ledger.sqlite`", () => {
    const env = {
      OPENCLAW_STATE_DIR: tmpDir,
    } as NodeJS.ProcessEnv;
    const resolved = defaultSqliteTaskLedgerPath(env);
    expect(resolved.endsWith(path.join("task", "identity-task-ledger.sqlite"))).toBe(true);
    expect(resolved.startsWith(tmpDir)).toBe(true);
  });

  it("open rejects on an empty dbPath (invariant #15 — defensible failure mode)", async () => {
    await expect(SqliteTaskLedger.open({ dbPath: "" })).rejects.toThrow();
    await expect(SqliteTaskLedger.open({ dbPath: "   " })).rejects.toThrow();
  });

  it("close is idempotent — calling close twice is safe", async () => {
    const ledger = await SqliteTaskLedger.open({ dbPath });
    await ledger.close();
    await expect(ledger.close()).resolves.toBeUndefined();
  });

  it("list with `since` filter narrows to entries updated at or after the cutoff", async () => {
    const ledger = await SqliteTaskLedger.open({ dbPath });
    const a = await ledger.create(createInput(VLADIMIR, { label: "old" }));
    // Sleep a hair to advance the clock past `a.updatedAt`.
    await new Promise((r) => setTimeout(r, 10));
    const cutoff = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 10));
    const b = await ledger.create(createInput(VLADIMIR, { label: "new" }));

    const recent = await ledger.list({
      ownerIdentityId: VLADIMIR,
      since: cutoff,
    });
    const ids = recent.tasks.map((t) => t.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(a.id);

    await ledger.close();
  });

  it("rejects ops issued after close (invariant #15 — defensible failure mode)", async () => {
    const ledger = await SqliteTaskLedger.open({ dbPath });
    await ledger.close();
    await expect(ledger.create(createInput())).rejects.toThrow();
  });
});
