import { describe, expect, it } from "vitest";

import { asIdentityId, type IdentityId } from "../identity/identity-id.js";

import { buildActiveTasksBlock } from "./active-tasks-block.js";
import { asTaskId } from "./task-id.js";
import type { TaskRecord, TaskStatus } from "./task-record.js";

const IDENTITY: IdentityId = asIdentityId("identity:vladimir");

function makeTask(params: {
  readonly idSlug: string;
  readonly label: string;
  readonly status: TaskStatus;
  readonly createdAt: string;
  readonly summary?: string;
  readonly result?: string;
}): TaskRecord {
  return {
    id: asTaskId(`task:${params.idSlug}`),
    ownerIdentityId: IDENTITY,
    label: params.label,
    status: params.status,
    summary: params.summary ?? `summary-${params.idSlug}`,
    createdAt: params.createdAt,
    updatedAt: params.createdAt,
    ...(params.result !== undefined ? { result: params.result } : {}),
  };
}

describe("buildActiveTasksBlock — slice F Phase 6 formatter", () => {
  it("returns empty string for empty input (no whitespace pollution)", () => {
    expect(buildActiveTasksBlock([])).toBe("");
  });

  it("returns empty string when all tasks are in terminal states (filtered out)", () => {
    const tasks: ReadonlyArray<TaskRecord> = [
      makeTask({
        idSlug: "00000001",
        label: "ship-rfc",
        status: "completed",
        createdAt: "2026-05-05T10:00:00.000Z",
        result: "shipped",
      }),
      makeTask({
        idSlug: "00000002",
        label: "review-pr",
        status: "cancelled",
        createdAt: "2026-05-05T11:00:00.000Z",
        result: "stale",
      }),
      makeTask({
        idSlug: "00000003",
        label: "fix-bug",
        status: "failed",
        createdAt: "2026-05-05T12:00:00.000Z",
        result: "infra outage",
      }),
    ];
    expect(buildActiveTasksBlock(tasks)).toBe("");
  });

  it("emits a block with one entry for a single open task", () => {
    const tasks: ReadonlyArray<TaskRecord> = [
      makeTask({
        idSlug: "00000001",
        label: "ship-rfc",
        status: "open",
        createdAt: "2026-05-05T10:00:00.000Z",
      }),
    ];
    const block = buildActiveTasksBlock(tasks);
    expect(block.startsWith("<active_tasks>")).toBe(true);
    expect(block.endsWith("</active_tasks>")).toBe(true);
    const inner = block.slice("<active_tasks>".length, -"</active_tasks>".length);
    const parsed = JSON.parse(inner) as { tasks: Array<Record<string, unknown>> };
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0]).toEqual({
      id: "task:00000001",
      label: "ship-rfc",
      status: "open",
    });
  });

  it("emits 5 entries newest-first by createdAt for 5 open tasks", () => {
    const tasks: ReadonlyArray<TaskRecord> = [
      makeTask({
        idSlug: "00000001",
        label: "first",
        status: "open",
        createdAt: "2026-05-05T10:00:00.000Z",
      }),
      makeTask({
        idSlug: "00000002",
        label: "second",
        status: "open",
        createdAt: "2026-05-05T11:00:00.000Z",
      }),
      makeTask({
        idSlug: "00000003",
        label: "third",
        status: "open",
        createdAt: "2026-05-05T12:00:00.000Z",
      }),
      makeTask({
        idSlug: "00000004",
        label: "fourth",
        status: "open",
        createdAt: "2026-05-05T13:00:00.000Z",
      }),
      makeTask({
        idSlug: "00000005",
        label: "fifth",
        status: "open",
        createdAt: "2026-05-05T14:00:00.000Z",
      }),
    ];
    const block = buildActiveTasksBlock(tasks);
    const inner = block.slice("<active_tasks>".length, -"</active_tasks>".length);
    const parsed = JSON.parse(inner) as { tasks: Array<{ id: string; label: string; status: string }> };
    expect(parsed.tasks).toHaveLength(5);
    expect(parsed.tasks.map((t) => t.label)).toEqual([
      "fifth",
      "fourth",
      "third",
      "second",
      "first",
    ]);
  });

  it("filters mixed statuses to only open + in_progress (drops completed/cancelled/failed)", () => {
    const tasks: ReadonlyArray<TaskRecord> = [
      makeTask({
        idSlug: "00000001",
        label: "label-open",
        status: "open",
        createdAt: "2026-05-05T10:00:00.000Z",
      }),
      makeTask({
        idSlug: "00000002",
        label: "label-in-progress",
        status: "in_progress",
        createdAt: "2026-05-05T11:00:00.000Z",
      }),
      makeTask({
        idSlug: "00000003",
        label: "label-completed",
        status: "completed",
        createdAt: "2026-05-05T12:00:00.000Z",
      }),
      makeTask({
        idSlug: "00000004",
        label: "label-cancelled",
        status: "cancelled",
        createdAt: "2026-05-05T13:00:00.000Z",
      }),
      makeTask({
        idSlug: "00000005",
        label: "label-failed",
        status: "failed",
        createdAt: "2026-05-05T14:00:00.000Z",
      }),
    ];
    const block = buildActiveTasksBlock(tasks);
    const inner = block.slice("<active_tasks>".length, -"</active_tasks>".length);
    const parsed = JSON.parse(inner) as { tasks: Array<{ id: string; label: string; status: string }> };
    // Only the two non-terminal entries survive; sorted newest-first.
    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.tasks.map((t) => t.status)).toEqual(["in_progress", "open"]);
    expect(parsed.tasks.map((t) => t.label)).toEqual([
      "label-in-progress",
      "label-open",
    ]);
    // Strict assertion that no terminal label leaked.
    expect(block).not.toContain("label-completed");
    expect(block).not.toContain("label-cancelled");
    expect(block).not.toContain("label-failed");
  });

  it("applies id-desc tie-breaker when createdAt collides", () => {
    const tied = "2026-05-05T10:00:00.000Z";
    const tasks: ReadonlyArray<TaskRecord> = [
      makeTask({ idSlug: "00000001", label: "alpha", status: "open", createdAt: tied }),
      makeTask({ idSlug: "00000002", label: "beta", status: "open", createdAt: tied }),
      makeTask({ idSlug: "00000003", label: "gamma", status: "open", createdAt: tied }),
    ];
    const block = buildActiveTasksBlock(tasks);
    const inner = block.slice("<active_tasks>".length, -"</active_tasks>".length);
    const parsed = JSON.parse(inner) as { tasks: Array<{ id: string }> };
    expect(parsed.tasks.map((t) => t.id)).toEqual([
      "task:00000003",
      "task:00000002",
      "task:00000001",
    ]);
  });

  it("emits ONLY id/label/status per entry (NOT summary, result, updatedAt, etc.)", () => {
    const tasks: ReadonlyArray<TaskRecord> = [
      makeTask({
        idSlug: "00000001",
        label: "the-label",
        status: "in_progress",
        createdAt: "2026-05-05T10:00:00.000Z",
        summary: "VERY-DETAILED-SUMMARY-DO-NOT-LEAK",
        result: "NOT-DONE-RESULT-DO-NOT-LEAK",
      }),
    ];
    const block = buildActiveTasksBlock(tasks);
    const inner = block.slice("<active_tasks>".length, -"</active_tasks>".length);
    const parsed = JSON.parse(inner) as { tasks: Array<Record<string, unknown>> };
    const entry = parsed.tasks[0]!;
    expect(Object.keys(entry).sort()).toEqual(["id", "label", "status"]);
    expect(block).not.toContain("VERY-DETAILED-SUMMARY-DO-NOT-LEAK");
    expect(block).not.toContain("NOT-DONE-RESULT-DO-NOT-LEAK");
    expect(block).not.toContain("updatedAt");
    expect(block).not.toContain("createdAt");
    expect(block).not.toContain("ownerIdentityId");
  });

  it("JSON-encodes a label containing the closing tag so the wrapper stays well-formed", () => {
    // Adversarial label that would naively break the wrapper if not
    // JSON-escaped. JSON.stringify escapes nothing for plain `<` chars,
    // so the closing-tag sequence appears verbatim INSIDE the JSON
    // string. The wrapper remains parseable because we extract using
    // literal tag slices anchored at the start (`<active_tasks>`) and
    // the LAST occurrence of `</active_tasks>` — the test below
    // verifies the round-trip.
    const adversarial = "label with </active_tasks> sneaky bits";
    const tasks: ReadonlyArray<TaskRecord> = [
      makeTask({
        idSlug: "00000001",
        label: adversarial,
        status: "open",
        createdAt: "2026-05-05T10:00:00.000Z",
      }),
    ];
    const block = buildActiveTasksBlock(tasks);
    expect(block.startsWith("<active_tasks>")).toBe(true);
    expect(block.endsWith("</active_tasks>")).toBe(true);
    // The inner JSON parses cleanly when extracted via literal tag slices
    // anchored at the LAST occurrence of the closing tag.
    const inner = block.slice(
      "<active_tasks>".length,
      block.lastIndexOf("</active_tasks>"),
    );
    const parsed = JSON.parse(inner) as { tasks: Array<{ label: string }> };
    expect(parsed.tasks[0]!.label).toBe(adversarial);
  });

  it("inner JSON round-trips for the documented shape", () => {
    const tasks: ReadonlyArray<TaskRecord> = [
      makeTask({
        idSlug: "00000001",
        label: "pay-bills",
        status: "open",
        createdAt: "2026-05-05T10:00:00.000Z",
      }),
      makeTask({
        idSlug: "00000002",
        label: "draft-rfc",
        status: "in_progress",
        createdAt: "2026-05-05T11:00:00.000Z",
      }),
    ];
    const block = buildActiveTasksBlock(tasks);
    const inner = block.replace("<active_tasks>", "").replace("</active_tasks>", "");
    const parsed = JSON.parse(inner) as { tasks: Array<{ id: string; label: string; status: string }> };
    expect(parsed).toEqual({
      tasks: [
        { id: "task:00000002", label: "draft-rfc", status: "in_progress" },
        { id: "task:00000001", label: "pay-bills", status: "open" },
      ],
    });
  });
});
