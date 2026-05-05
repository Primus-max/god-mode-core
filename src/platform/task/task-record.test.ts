import { describe, expect, it } from "vitest";

import { asIdentityId } from "../identity/identity-id.js";

import {
  TASK_STATUSES,
  TaskCreateInputSchema,
  TaskListQuerySchema,
  TaskListResultSchema,
  TaskRecordSchema,
  TaskUpdatePatchSchema,
  assertNeverTaskStatus,
  isTaskTerminalStatus,
  isTaskTransitionAllowed,
  type TaskRecord,
  type TaskStatus,
  type TaskUpdatePatch,
} from "./task-record.js";
import { asTaskId } from "./task-id.js";

const VLADIMIR = asIdentityId("identity:vladimir");
const TASK_42 = asTaskId("task:42");
const VALID_ISO = "2026-05-05T12:34:56.000Z";
const VALID_ISO_2 = "2026-05-05T12:35:00.000Z";

const VALID_RECORD: TaskRecord = {
  id: TASK_42,
  ownerIdentityId: VLADIMIR,
  label: "Draft Q3 retrospective",
  status: "open",
  summary: "Pull last quarter's incident notes and write a retrospective.",
  createdAt: VALID_ISO,
  updatedAt: VALID_ISO,
};

describe("TaskRecordSchema — round-trip", () => {
  it("accepts a minimal well-formed record (only required fields)", () => {
    const parsed = TaskRecordSchema.parse(VALID_RECORD);
    expect(parsed.id).toBe(TASK_42);
    expect(parsed.ownerIdentityId).toBe(VLADIMIR);
    expect(parsed.status).toBe("open");
  });

  it("accepts an extended record with all optional fields populated", () => {
    const extended: TaskRecord = {
      ...VALID_RECORD,
      status: "completed",
      completedAt: VALID_ISO_2,
      result: "Posted retrospective to #eng-leads",
      sourceEffectFamily: "task",
      sourceEffectId: "effect:abc",
    };
    const parsed = TaskRecordSchema.parse(extended);
    expect(parsed.completedAt).toBe(VALID_ISO_2);
    expect(parsed.result).toBe("Posted retrospective to #eng-leads");
    expect(parsed.sourceEffectFamily).toBe("task");
    expect(parsed.sourceEffectId).toBe("effect:abc");
  });

  it("rejects a record with an unknown status literal", () => {
    expect(() =>
      TaskRecordSchema.parse({ ...VALID_RECORD, status: "snoozed" }),
    ).toThrow();
  });

  it("rejects a record with a non-ISO createdAt", () => {
    expect(() =>
      TaskRecordSchema.parse({ ...VALID_RECORD, createdAt: "yesterday" }),
    ).toThrow();
  });

  it("rejects a record with an empty label", () => {
    expect(() => TaskRecordSchema.parse({ ...VALID_RECORD, label: "" })).toThrow();
  });

  it("rejects a record with a malformed taskId (no `task:` prefix)", () => {
    expect(() => TaskRecordSchema.parse({ ...VALID_RECORD, id: "42" })).toThrow();
  });

  it("rejects a record with a malformed ownerIdentityId (no `identity:` prefix)", () => {
    expect(() =>
      TaskRecordSchema.parse({ ...VALID_RECORD, ownerIdentityId: "vladimir" }),
    ).toThrow();
  });
});

describe("TaskCreateInputSchema — round-trip", () => {
  it("accepts a minimal well-formed create input", () => {
    const parsed = TaskCreateInputSchema.parse({
      ownerIdentityId: VLADIMIR,
      label: "Draft Q3 retrospective",
      summary: "Pull last quarter's incident notes.",
    });
    expect(parsed.ownerIdentityId).toBe(VLADIMIR);
    expect(parsed.label).toBe("Draft Q3 retrospective");
  });

  it("accepts an input with optional source effect linkage", () => {
    const parsed = TaskCreateInputSchema.parse({
      ownerIdentityId: VLADIMIR,
      label: "Draft Q3 retrospective",
      summary: "Pull last quarter's incident notes.",
      sourceEffectFamily: "task",
      sourceEffectId: "effect:abc",
    });
    expect(parsed.sourceEffectFamily).toBe("task");
    expect(parsed.sourceEffectId).toBe("effect:abc");
  });

  it("rejects a create input that carries an `id` (assigned by the ledger)", () => {
    expect(() =>
      TaskCreateInputSchema.parse({
        id: TASK_42,
        ownerIdentityId: VLADIMIR,
        label: "x",
        summary: "y",
      }),
    ).toThrow();
  });

  it("rejects a create input that carries a `status` (always starts at `open`)", () => {
    expect(() =>
      TaskCreateInputSchema.parse({
        ownerIdentityId: VLADIMIR,
        label: "x",
        summary: "y",
        status: "in_progress",
      }),
    ).toThrow();
  });

  it("rejects a create input with an empty label or summary", () => {
    expect(() =>
      TaskCreateInputSchema.parse({
        ownerIdentityId: VLADIMIR,
        label: "",
        summary: "y",
      }),
    ).toThrow();
    expect(() =>
      TaskCreateInputSchema.parse({
        ownerIdentityId: VLADIMIR,
        label: "x",
        summary: "",
      }),
    ).toThrow();
  });
});

describe("TaskUpdatePatchSchema — round-trip", () => {
  it("accepts a status-only patch", () => {
    const patch: TaskUpdatePatch = { status: "in_progress" };
    expect(TaskUpdatePatchSchema.parse(patch).status).toBe("in_progress");
  });

  it("accepts a label-only patch", () => {
    const patch: TaskUpdatePatch = { label: "Renamed task" };
    expect(TaskUpdatePatchSchema.parse(patch).label).toBe("Renamed task");
  });

  it("accepts a summary-only patch", () => {
    const patch: TaskUpdatePatch = { summary: "Updated summary." };
    expect(TaskUpdatePatchSchema.parse(patch).summary).toBe("Updated summary.");
  });

  it("rejects an empty patch (no field provided)", () => {
    expect(() => TaskUpdatePatchSchema.parse({})).toThrow();
  });

  it("rejects a patch with unknown extra fields", () => {
    expect(() =>
      TaskUpdatePatchSchema.parse({
        status: "completed",
        // Not part of the patch surface — must be rejected by `.strict()`.
        bogus: 1,
      }),
    ).toThrow();
  });

  it("rejects a patch that tries to set `id`", () => {
    expect(() =>
      TaskUpdatePatchSchema.parse({ id: TASK_42, status: "in_progress" }),
    ).toThrow();
  });
});

describe("Status state-machine — 5×5 transition matrix (25 cells)", () => {
  // Canonical legal transitions per sub-plan §6 implementation notes:
  //   open → in_progress, open → cancelled
  //   in_progress → completed, in_progress → cancelled, in_progress → failed
  // Everything else (including same-status no-ops and any transition out
  // of a terminal state) is REJECTED.

  const ALLOWED: ReadonlyArray<readonly [TaskStatus, TaskStatus]> = [
    ["open", "in_progress"],
    ["open", "cancelled"],
    ["in_progress", "completed"],
    ["in_progress", "cancelled"],
    ["in_progress", "failed"],
  ];

  const allowedSet = new Set(ALLOWED.map(([a, b]) => `${a}->${b}`));

  it("isTaskTransitionAllowed covers exactly 5 of the 25 (current,next) cells", () => {
    let allowedCount = 0;
    let rejectedCount = 0;
    for (const current of TASK_STATUSES) {
      for (const next of TASK_STATUSES) {
        const key = `${current}->${next}`;
        const expected = allowedSet.has(key);
        const actual = isTaskTransitionAllowed(current, next);
        expect(actual).toBe(expected);
        if (actual) {
          allowedCount += 1;
        } else {
          rejectedCount += 1;
        }
      }
    }
    expect(allowedCount).toBe(5);
    expect(rejectedCount).toBe(20);
    expect(allowedCount + rejectedCount).toBe(25);
  });

  it("rejects every same-status transition (5 self-loop cells)", () => {
    for (const status of TASK_STATUSES) {
      expect(isTaskTransitionAllowed(status, status)).toBe(false);
    }
  });

  it("rejects every transition OUT of a terminal status (3 terminal × 5 = 15 cells)", () => {
    const terminals: ReadonlyArray<TaskStatus> = ["completed", "cancelled", "failed"];
    for (const terminal of terminals) {
      for (const next of TASK_STATUSES) {
        expect(isTaskTransitionAllowed(terminal, next)).toBe(false);
      }
    }
  });

  it("isTaskTerminalStatus marks completed / cancelled / failed as terminal and the rest as not", () => {
    expect(isTaskTerminalStatus("open")).toBe(false);
    expect(isTaskTerminalStatus("in_progress")).toBe(false);
    expect(isTaskTerminalStatus("completed")).toBe(true);
    expect(isTaskTerminalStatus("cancelled")).toBe(true);
    expect(isTaskTerminalStatus("failed")).toBe(true);
  });
});

describe("TaskUpdatePatchSchema — state-machine guard at the schema boundary", () => {
  // The schema's refinement REJECTS the patch when both `currentStatus`
  // and `nextStatus` are provided AND the transition is illegal. When
  // only one (or neither) is provided, the schema cannot decide
  // — that case is the impl-layer guard's job (Phase 3).
  //
  // The 5 ALLOWED cells must be accepted; the other 20 must be rejected.

  const ALL_CELLS: ReadonlyArray<readonly [TaskStatus, TaskStatus, boolean]> = [
    // open
    ["open", "open", false],
    ["open", "in_progress", true],
    ["open", "completed", false],
    ["open", "cancelled", true],
    ["open", "failed", false],
    // in_progress
    ["in_progress", "open", false],
    ["in_progress", "in_progress", false],
    ["in_progress", "completed", true],
    ["in_progress", "cancelled", true],
    ["in_progress", "failed", true],
    // completed (terminal)
    ["completed", "open", false],
    ["completed", "in_progress", false],
    ["completed", "completed", false],
    ["completed", "cancelled", false],
    ["completed", "failed", false],
    // cancelled (terminal)
    ["cancelled", "open", false],
    ["cancelled", "in_progress", false],
    ["cancelled", "completed", false],
    ["cancelled", "cancelled", false],
    ["cancelled", "failed", false],
    // failed (terminal)
    ["failed", "open", false],
    ["failed", "in_progress", false],
    ["failed", "completed", false],
    ["failed", "cancelled", false],
    ["failed", "failed", false],
  ];

  it("the cell list spans exactly 25 transitions", () => {
    expect(ALL_CELLS.length).toBe(25);
  });

  it("the schema accepts the 5 allowed transitions (when both currentStatus + nextStatus are supplied)", () => {
    let allowedCount = 0;
    for (const [current, next, allowed] of ALL_CELLS) {
      if (!allowed) {
        continue;
      }
      const parsed = TaskUpdatePatchSchema.parse({
        currentStatus: current,
        status: next,
      });
      expect(parsed.status).toBe(next);
      allowedCount += 1;
    }
    expect(allowedCount).toBe(5);
  });

  it("the schema rejects the 20 illegal transitions (when both currentStatus + nextStatus are supplied)", () => {
    let rejectedCount = 0;
    for (const [current, next, allowed] of ALL_CELLS) {
      if (allowed) {
        continue;
      }
      expect(() =>
        TaskUpdatePatchSchema.parse({
          currentStatus: current,
          status: next,
        }),
      ).toThrow();
      rejectedCount += 1;
    }
    expect(rejectedCount).toBe(20);
  });
});

describe("TaskListQuerySchema — round-trip + filters", () => {
  it("accepts a minimal query (just identity)", () => {
    const parsed = TaskListQuerySchema.parse({ ownerIdentityId: VLADIMIR });
    expect(parsed.ownerIdentityId).toBe(VLADIMIR);
  });

  it("accepts a query with status filter", () => {
    const parsed = TaskListQuerySchema.parse({
      ownerIdentityId: VLADIMIR,
      statuses: ["open", "in_progress"],
    });
    expect(parsed.statuses).toEqual(["open", "in_progress"]);
  });

  it("rejects a status filter with an unknown literal", () => {
    expect(() =>
      TaskListQuerySchema.parse({
        ownerIdentityId: VLADIMIR,
        statuses: ["open", "snoozed"],
      }),
    ).toThrow();
  });

  it("rejects a non-positive limit", () => {
    expect(() =>
      TaskListQuerySchema.parse({ ownerIdentityId: VLADIMIR, limit: 0 }),
    ).toThrow();
    expect(() =>
      TaskListQuerySchema.parse({ ownerIdentityId: VLADIMIR, limit: -1 }),
    ).toThrow();
  });

  it("rejects a non-ISO since timestamp", () => {
    expect(() =>
      TaskListQuerySchema.parse({
        ownerIdentityId: VLADIMIR,
        since: "yesterday",
      }),
    ).toThrow();
  });

  it("accepts a limit and an ISO since", () => {
    const parsed = TaskListQuerySchema.parse({
      ownerIdentityId: VLADIMIR,
      limit: 25,
      since: VALID_ISO,
    });
    expect(parsed.limit).toBe(25);
    expect(parsed.since).toBe(VALID_ISO);
  });
});

describe("TaskListResultSchema — round-trip", () => {
  it("accepts an empty result (no tasks)", () => {
    const parsed = TaskListResultSchema.parse({ tasks: [] });
    expect(parsed.tasks).toEqual([]);
  });

  it("accepts a result with one task", () => {
    const parsed = TaskListResultSchema.parse({ tasks: [VALID_RECORD] });
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0]?.id).toBe(TASK_42);
  });

  it("rejects a result whose task carries an unknown status", () => {
    expect(() =>
      TaskListResultSchema.parse({
        tasks: [{ ...VALID_RECORD, status: "snoozed" }],
      }),
    ).toThrow();
  });
});

describe("TaskStatus — discriminated-union exhaustiveness compile-check", () => {
  // If a future contributor adds a 6th status without extending this
  // switch, `assertNeverTaskStatus(value)` becomes a compile error —
  // which is the strongest signal possible.
  function classify(status: TaskStatus): string {
    switch (status) {
      case "open":
        return "open";
      case "in_progress":
        return "in_progress";
      case "completed":
        return "completed";
      case "cancelled":
        return "cancelled";
      case "failed":
        return "failed";
      default:
        return assertNeverTaskStatus(status);
    }
  }

  it("classifier covers every member of TASK_STATUSES", () => {
    expect(TASK_STATUSES.length).toBe(5);
    for (const status of TASK_STATUSES) {
      expect(classify(status)).toBe(status);
    }
  });

  it("assertNeverTaskStatus throws at runtime when fed an impossible value (defensive)", () => {
    const bogus = "snoozed" as unknown as never;
    expect(() => assertNeverTaskStatus(bogus)).toThrow();
  });
});
