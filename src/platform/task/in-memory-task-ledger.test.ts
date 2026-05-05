import { describe, expect, it } from "vitest";

import { asIdentityId, type IdentityId } from "../identity/identity-id.js";

import {
  InMemoryTaskLedger,
  type InMemoryTaskLedgerLogger,
} from "./in-memory-task-ledger.js";
import { isTaskId } from "./task-id.js";
import {
  type TaskCreateInput,
  type TaskRecord,
  type TaskUpdatePatch,
} from "./task-record.js";

const VLADIMIR: IdentityId = asIdentityId("identity:vladimir");
const ALICE: IdentityId = asIdentityId("identity:alice");

/**
 * Capturing logger seam. Mirrors `LlmExtractorMemoryStore` test helper
 * (slice E PR-#170) — tests inject this and assert
 * `warnings.length === N` to nail down "warn fired exactly once".
 */
type CapturingLogger = InMemoryTaskLedgerLogger & {
  readonly warnings: readonly string[];
  readonly debugs: readonly string[];
};

function createCapturingLogger(): CapturingLogger {
  const warnings: string[] = [];
  const debugs: string[] = [];
  return {
    warn(message: string) {
      warnings.push(message);
    },
    debug(message: string) {
      debugs.push(message);
    },
    get warnings() {
      return warnings;
    },
    get debugs() {
      return debugs;
    },
  };
}

function createInput(
  identity: IdentityId = VLADIMIR,
  label = "draft retro doc",
  summary = "summary text",
): TaskCreateInput {
  return {
    ownerIdentityId: identity,
    label,
    summary,
  };
}

/* ------------------------------------------------------------------ */
/* 1. Round-trip: create → get → update → complete                     */
/* ------------------------------------------------------------------ */

describe("InMemoryTaskLedger — round-trip create→get→update→complete", () => {
  it("create returns a TaskRecord with brand-typed id, status=open, timestamps", async () => {
    const ledger = new InMemoryTaskLedger();
    const created = await ledger.create(createInput());

    expect(isTaskId(created.id)).toBe(true);
    expect(created.ownerIdentityId).toBe(VLADIMIR);
    expect(created.label).toBe("draft retro doc");
    expect(created.summary).toBe("summary text");
    expect(created.status).toBe("open");
    expect(typeof created.createdAt).toBe("string");
    expect(typeof created.updatedAt).toBe("string");
    expect(created.completedAt).toBeUndefined();
    expect(created.result).toBeUndefined();
  });

  it("get under same owner returns the same record", async () => {
    const ledger = new InMemoryTaskLedger();
    const created = await ledger.create(createInput());

    const fetched = await ledger.get(VLADIMIR, created.id);
    expect(fetched).toEqual(created);
  });

  it("update transitions open → in_progress and bumps updatedAt", async () => {
    let now = 1_000_000_000_000;
    const ledger = new InMemoryTaskLedger({ now: () => new Date(now).toISOString() });
    const created = await ledger.create(createInput());

    now += 5_000;
    const patch: TaskUpdatePatch = { status: "in_progress" };
    const result = await ledger.update(VLADIMIR, created.id, patch);

    expect("kind" in result).toBe(false);
    const updated = result as TaskRecord;
    expect(updated.status).toBe("in_progress");
    expect(updated.updatedAt).not.toBe(created.updatedAt);
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
  });

  it("complete on in_progress returns the record with status=completed and completedAt set", async () => {
    const ledger = new InMemoryTaskLedger();
    const created = await ledger.create(createInput());
    await ledger.update(VLADIMIR, created.id, { status: "in_progress" });

    const result = await ledger.complete(VLADIMIR, created.id, "Posted to #eng-leads");
    expect("kind" in result).toBe(false);
    const completed = result as TaskRecord;
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBeDefined();
    expect(completed.result).toBe("Posted to #eng-leads");
  });

  it("end-to-end create → in_progress → complete sequence reflects in get", async () => {
    const ledger = new InMemoryTaskLedger();
    const created = await ledger.create(createInput());
    await ledger.update(VLADIMIR, created.id, { status: "in_progress" });
    await ledger.complete(VLADIMIR, created.id);

    const fetched = await ledger.get(VLADIMIR, created.id);
    expect(fetched).toBeDefined();
    expect(fetched?.status).toBe("completed");
  });
});

/* ------------------------------------------------------------------ */
/* 2. Identity isolation — VLADIMIR vs ALICE on the SAME instance       */
/* ------------------------------------------------------------------ */

describe("InMemoryTaskLedger — identity isolation (same instance, different owners)", () => {
  it("tasks created under VLADIMIR are NOT visible from ALICE via list", async () => {
    const ledger = new InMemoryTaskLedger();
    await ledger.create(createInput(VLADIMIR, "v-task-1"));
    await ledger.create(createInput(VLADIMIR, "v-task-2"));

    const aliceList = await ledger.list({ ownerIdentityId: ALICE });
    expect(aliceList.tasks).toEqual([]);
  });

  it("tasks created under VLADIMIR are NOT fetchable from ALICE via get", async () => {
    const ledger = new InMemoryTaskLedger();
    const created = await ledger.create(createInput(VLADIMIR, "secret"));

    const fromAlice = await ledger.get(ALICE, created.id);
    expect(fromAlice).toBeUndefined();
  });

  it("update under wrong owner returns not_found, leaving the row untouched under the right owner", async () => {
    const ledger = new InMemoryTaskLedger();
    const created = await ledger.create(createInput(VLADIMIR, "v-task"));

    const result = await ledger.update(ALICE, created.id, { status: "in_progress" });
    expect(result).toEqual({ kind: "not_found" });

    const stillUnderVladimir = await ledger.get(VLADIMIR, created.id);
    expect(stillUnderVladimir?.status).toBe("open");
  });

  it("complete under wrong owner returns not_found", async () => {
    const ledger = new InMemoryTaskLedger();
    const created = await ledger.create(createInput(VLADIMIR));

    const result = await ledger.complete(ALICE, created.id);
    expect(result).toEqual({ kind: "not_found" });
  });

  it("cancel under wrong owner returns not_found", async () => {
    const ledger = new InMemoryTaskLedger();
    const created = await ledger.create(createInput(VLADIMIR));

    const result = await ledger.cancel(ALICE, created.id);
    expect(result).toEqual({ kind: "not_found" });
  });

  it("two operators on the same instance keep their list views separate", async () => {
    let now = 1_700_000_000_000;
    const ledger = new InMemoryTaskLedger({ now: () => new Date(now).toISOString() });
    await ledger.create(createInput(VLADIMIR, "v-1"));
    now += 1_000;
    await ledger.create(createInput(VLADIMIR, "v-2"));
    now += 1_000;
    await ledger.create(createInput(ALICE, "a-1"));

    const vlList = await ledger.list({ ownerIdentityId: VLADIMIR });
    const alList = await ledger.list({ ownerIdentityId: ALICE });

    expect(vlList.tasks.map((t) => t.label)).toEqual(["v-2", "v-1"]);
    expect(alList.tasks.map((t) => t.label)).toEqual(["a-1"]);
  });
});

/* ------------------------------------------------------------------ */
/* 3. list ordering, pagination, status + since filters                */
/* ------------------------------------------------------------------ */

describe("InMemoryTaskLedger — list ordering, pagination, filters", () => {
  it("list returns newest-first by createdAt across at least 3 entries", async () => {
    let now = 1_700_000_000_000;
    const clock = () => new Date(now).toISOString();
    const ledger = new InMemoryTaskLedger({ now: clock });

    const t1 = await ledger.create(createInput(VLADIMIR, "first"));
    now += 1_000;
    const t2 = await ledger.create(createInput(VLADIMIR, "second"));
    now += 1_000;
    const t3 = await ledger.create(createInput(VLADIMIR, "third"));

    const result = await ledger.list({ ownerIdentityId: VLADIMIR });
    expect(result.tasks.map((t) => t.id)).toEqual([t3.id, t2.id, t1.id]);
  });

  it("list breaks ties on createdAt by id descending (deterministic)", async () => {
    const fixed = "2026-05-05T12:00:00.000Z";
    const ledger = new InMemoryTaskLedger({ now: () => fixed });

    const a = await ledger.create(createInput(VLADIMIR, "a"));
    const b = await ledger.create(createInput(VLADIMIR, "b"));
    const c = await ledger.create(createInput(VLADIMIR, "c"));

    const result = await ledger.list({ ownerIdentityId: VLADIMIR });
    // All three share the same createdAt; tie-breaker on id keeps the
    // order stable so callers + the Phase-6 <active_tasks> block can
    // depend on a single canonical order.
    const ids = result.tasks.map((t) => t.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids)).toEqual(new Set([a.id, b.id, c.id]));
    // Verify monotonic by id (descending) under same-createdAt.
    const sorted = [...ids].sort().reverse();
    expect(ids).toEqual(sorted);
  });

  it("list paginates via limit", async () => {
    let now = 1_700_000_000_000;
    const ledger = new InMemoryTaskLedger({ now: () => new Date(now).toISOString() });

    for (let i = 0; i < 5; i += 1) {
      await ledger.create(createInput(VLADIMIR, `t-${i}`));
      now += 1_000;
    }

    const page = await ledger.list({ ownerIdentityId: VLADIMIR, limit: 2 });
    expect(page.tasks).toHaveLength(2);
    expect(page.tasks[0]?.label).toBe("t-4");
    expect(page.tasks[1]?.label).toBe("t-3");
  });

  it("list filters by statuses=[open,in_progress]", async () => {
    const ledger = new InMemoryTaskLedger();
    const t1 = await ledger.create(createInput(VLADIMIR, "open-task"));
    const t2 = await ledger.create(createInput(VLADIMIR, "in-progress-task"));
    const t3 = await ledger.create(createInput(VLADIMIR, "completed-task"));
    const t4 = await ledger.create(createInput(VLADIMIR, "cancelled-task"));

    await ledger.update(VLADIMIR, t2.id, { status: "in_progress" });
    await ledger.update(VLADIMIR, t3.id, { status: "in_progress" });
    await ledger.complete(VLADIMIR, t3.id);
    await ledger.cancel(VLADIMIR, t4.id);

    const result = await ledger.list({
      ownerIdentityId: VLADIMIR,
      statuses: ["open", "in_progress"],
    });
    const labels = result.tasks.map((t) => t.label).sort();
    expect(labels).toEqual(["in-progress-task", "open-task"]);
    expect(result.tasks.find((t) => t.id === t1.id)?.status).toBe("open");
    expect(result.tasks.find((t) => t.id === t2.id)?.status).toBe("in_progress");
  });

  it("list filters by since (only entries with updatedAt >= since)", async () => {
    let now = 1_700_000_000_000;
    const ledger = new InMemoryTaskLedger({ now: () => new Date(now).toISOString() });

    await ledger.create(createInput(VLADIMIR, "old"));
    now += 10_000;
    const cutoff = new Date(now).toISOString();
    now += 1_000;
    const newer = await ledger.create(createInput(VLADIMIR, "new"));

    const result = await ledger.list({ ownerIdentityId: VLADIMIR, since: cutoff });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.id).toBe(newer.id);
  });
});

/* ------------------------------------------------------------------ */
/* 4. State-machine guard at IMPL boundary                              */
/* ------------------------------------------------------------------ */

describe("InMemoryTaskLedger — state-machine guard at impl boundary", () => {
  it("update with status=open on a completed task throws (defense-in-depth alongside Phase-2 schema refinement)", async () => {
    const ledger = new InMemoryTaskLedger();
    const created = await ledger.create(createInput());
    await ledger.update(VLADIMIR, created.id, { status: "in_progress" });
    await ledger.complete(VLADIMIR, created.id);

    // Caller does NOT supply currentStatus, so the schema's same-patch
    // refinement cannot decide; the impl is the sole authority on the
    // transition. completed → open is illegal per sub-plan §6 and the
    // ledger MUST reject — the contract on `TaskLedger.update`
    // (`task-ledger.ts:92-94`) says backend / state-machine violations
    // reject the promise rather than returning a structured error.
    await expect(
      ledger.update(VLADIMIR, created.id, { status: "open" }),
    ).rejects.toThrow(/illegal/i);
  });

  it("update from completed → in_progress also rejects (any out-of-terminal transition)", async () => {
    const ledger = new InMemoryTaskLedger();
    const created = await ledger.create(createInput());
    await ledger.update(VLADIMIR, created.id, { status: "in_progress" });
    await ledger.complete(VLADIMIR, created.id);

    await expect(
      ledger.update(VLADIMIR, created.id, { status: "in_progress" }),
    ).rejects.toThrow(/illegal/i);
  });

  it("update from open → completed is rejected (must transition through in_progress)", async () => {
    const ledger = new InMemoryTaskLedger();
    const created = await ledger.create(createInput());

    await expect(
      ledger.update(VLADIMIR, created.id, { status: "completed" }),
    ).rejects.toThrow(/illegal/i);
  });

  it("update with no mutable field is rejected by the Phase-2 schema (unchanged behaviour)", async () => {
    const ledger = new InMemoryTaskLedger();
    const created = await ledger.create(createInput());

    // Schema-level: the empty patch fails the "at least one mutable
    // field" refinement at decode time.
    await expect(
      ledger.update(VLADIMIR, created.id, {} as TaskUpdatePatch),
    ).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* 5. Idempotent cancel / complete on terminal-same-state               */
/* ------------------------------------------------------------------ */

describe("InMemoryTaskLedger — idempotent cancel / complete (no-op + warn exactly once)", () => {
  it("cancel on already-cancelled is a no-op + warn fired exactly once", async () => {
    const logger = createCapturingLogger();
    const ledger = new InMemoryTaskLedger({ logger });
    const created = await ledger.create(createInput());

    const first = await ledger.cancel(VLADIMIR, created.id, "user changed mind");
    expect("kind" in first).toBe(false);
    expect((first as TaskRecord).status).toBe("cancelled");
    expect(logger.warnings).toHaveLength(0);

    const second = await ledger.cancel(VLADIMIR, created.id);
    expect("kind" in second).toBe(false);
    expect((second as TaskRecord).status).toBe("cancelled");
    // Idempotent: row unchanged on second cancel.
    expect((second as TaskRecord).updatedAt).toBe((first as TaskRecord).updatedAt);

    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toMatch(/cancel.*already.*cancelled/i);
  });

  it("complete on already-completed is a no-op + warn fired exactly once", async () => {
    const logger = createCapturingLogger();
    const ledger = new InMemoryTaskLedger({ logger });
    const created = await ledger.create(createInput());
    await ledger.update(VLADIMIR, created.id, { status: "in_progress" });

    const first = await ledger.complete(VLADIMIR, created.id, "shipped");
    expect("kind" in first).toBe(false);
    expect((first as TaskRecord).status).toBe("completed");
    expect(logger.warnings).toHaveLength(0);

    const second = await ledger.complete(VLADIMIR, created.id);
    expect("kind" in second).toBe(false);
    expect((second as TaskRecord).status).toBe("completed");
    // Idempotent: row unchanged on second complete.
    expect((second as TaskRecord).updatedAt).toBe((first as TaskRecord).updatedAt);
    expect((second as TaskRecord).result).toBe("shipped");

    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toMatch(/complete.*already.*completed/i);
  });
});

/* ------------------------------------------------------------------ */
/* 6. not_found / undefined returns on unknown ids                      */
/* ------------------------------------------------------------------ */

describe("InMemoryTaskLedger — graceful-degradation contract on unknown ids", () => {
  it("get of unknown id returns undefined (does NOT throw)", async () => {
    const ledger = new InMemoryTaskLedger();
    const ledger2 = new InMemoryTaskLedger();
    const created = await ledger2.create(createInput());
    // `created.id` is a real TaskId but `ledger` does not own it.
    const result = await ledger.get(VLADIMIR, created.id);
    expect(result).toBeUndefined();
  });

  it("update of unknown id returns { kind: 'not_found' }", async () => {
    const ledger = new InMemoryTaskLedger();
    const ledger2 = new InMemoryTaskLedger();
    const created = await ledger2.create(createInput());

    const result = await ledger.update(VLADIMIR, created.id, { status: "in_progress" });
    expect(result).toEqual({ kind: "not_found" });
  });

  it("complete of unknown id returns { kind: 'not_found' }", async () => {
    const ledger = new InMemoryTaskLedger();
    const ledger2 = new InMemoryTaskLedger();
    const created = await ledger2.create(createInput());

    const result = await ledger.complete(VLADIMIR, created.id);
    expect(result).toEqual({ kind: "not_found" });
  });

  it("cancel of unknown id returns { kind: 'not_found' }", async () => {
    const ledger = new InMemoryTaskLedger();
    const ledger2 = new InMemoryTaskLedger();
    const created = await ledger2.create(createInput());

    const result = await ledger.cancel(VLADIMIR, created.id);
    expect(result).toEqual({ kind: "not_found" });
  });
});

/* ------------------------------------------------------------------ */
/* 7. Schema rejection on malformed inputs                              */
/* ------------------------------------------------------------------ */

describe("InMemoryTaskLedger — Zod parse error at API boundary on malformed input", () => {
  it("create with empty label rejects with a ZodError", async () => {
    const ledger = new InMemoryTaskLedger();
    const bad = {
      ownerIdentityId: VLADIMIR,
      label: "",
      summary: "ok",
    } as TaskCreateInput;

    await expect(ledger.create(bad)).rejects.toThrow();
  });

  it("create missing ownerIdentityId rejects with a ZodError", async () => {
    const ledger = new InMemoryTaskLedger();
    const bad = {
      label: "ok",
      summary: "ok",
    } as unknown as TaskCreateInput;

    await expect(ledger.create(bad)).rejects.toThrow();
  });

  it("create with non-IdentityId-shaped string rejects with a ZodError", async () => {
    const ledger = new InMemoryTaskLedger();
    const bad = {
      ownerIdentityId: "not-an-identity" as IdentityId,
      label: "ok",
      summary: "ok",
    } as TaskCreateInput;

    await expect(ledger.create(bad)).rejects.toThrow();
  });

  it("create with empty summary rejects with a ZodError", async () => {
    const ledger = new InMemoryTaskLedger();
    const bad = {
      ownerIdentityId: VLADIMIR,
      label: "ok",
      summary: "",
    } as TaskCreateInput;

    await expect(ledger.create(bad)).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* 8. Barrel export                                                     */
/* ------------------------------------------------------------------ */

describe("InMemoryTaskLedger — exported from barrel", () => {
  it("can be imported from src/platform/task barrel", async () => {
    const mod = await import("./index.js");
    expect(typeof mod.InMemoryTaskLedger).toBe("function");
    const ledger = new mod.InMemoryTaskLedger();
    const result = await ledger.list({ ownerIdentityId: VLADIMIR });
    expect(result.tasks).toEqual([]);
  });
});
