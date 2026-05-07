import { describe, expect, it } from "vitest";

import { resolveFreshnessConfig } from "../../freshness/freshness-config.js";
import { asIdentityId, type IdentityId } from "../../identity/identity-id.js";
import { buildActiveTasksBlock } from "../active-tasks-block.js";
import { asTaskId } from "../task-id.js";
import type { TaskRecord, TaskStatus } from "../task-record.js";

/**
 * Slice "intent-contractor freshness/recency" — Phase 4 / Change 4.
 *
 * `buildActiveTasksBlock` accepts an optional freshness reorder
 * (`{ now, freshnessConfig }`) and sorts by `updatedAt ?? createdAt`
 * descending. Without the option, the existing `createdAt` DESC + `id`
 * DESC behaviour is preserved (regression guard for slice F P6
 * callers).
 */

const IDENTITY: IdentityId = asIdentityId("identity:vladimir");
const NOW_MS = 1_700_000_000_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function makeTask(params: {
  readonly idSlug: string;
  readonly label: string;
  readonly status: TaskStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}): TaskRecord {
  return {
    id: asTaskId(`task:${params.idSlug}`),
    ownerIdentityId: IDENTITY,
    label: params.label,
    status: params.status,
    summary: `summary-${params.idSlug}`,
    createdAt: params.createdAt,
    updatedAt: params.updatedAt,
  };
}

describe("buildActiveTasksBlock — freshness reorder (Phase 4 / Change 4)", () => {
  it("sorts by updatedAt DESC when freshness option is supplied", async () => {
    const recentISO = new Date(NOW_MS - 60 * 60 * 1000).toISOString();
    const oldISO = new Date(NOW_MS - 14 * ONE_DAY_MS).toISOString();
    const tasks: TaskRecord[] = [
      makeTask({
        idSlug: "00000001",
        label: "old-but-just-nudged",
        status: "open",
        createdAt: "2026-01-01T00:00:00.000Z", // OLDEST createdAt
        updatedAt: recentISO, // FRESH updatedAt → wins
      }),
      makeTask({
        idSlug: "00000002",
        label: "newer-but-stale",
        status: "open",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: oldISO,
      }),
    ];
    const block = buildActiveTasksBlock(tasks, {
      now: NOW_MS,
      freshnessConfig: resolveFreshnessConfig(undefined),
    });
    const inner = block.slice("<active_tasks>".length, -"</active_tasks>".length);
    const parsed = JSON.parse(inner) as { tasks: Array<{ label: string }> };
    expect(parsed.tasks.map((t) => t.label)).toEqual([
      "old-but-just-nudged",
      "newer-but-stale",
    ]);
  });

  it("falls back to createdAt when updatedAt is identical across tasks (stable secondary)", () => {
    const sameUpdatedISO = new Date(NOW_MS - 60 * 60 * 1000).toISOString();
    const tasks: TaskRecord[] = [
      makeTask({
        idSlug: "00000001",
        label: "older-created",
        status: "open",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: sameUpdatedISO,
      }),
      makeTask({
        idSlug: "00000002",
        label: "newer-created",
        status: "open",
        createdAt: "2026-05-04T00:00:00.000Z",
        updatedAt: sameUpdatedISO,
      }),
    ];
    const block = buildActiveTasksBlock(tasks, {
      now: NOW_MS,
      freshnessConfig: resolveFreshnessConfig(undefined),
    });
    const inner = block.slice("<active_tasks>".length, -"</active_tasks>".length);
    const parsed = JSON.parse(inner) as { tasks: Array<{ label: string }> };
    // With equal recencyDecay (equal updatedAt) the freshness reorder
    // is stable; the builder's internal createdAt-DESC fallback then
    // surfaces the newer createdAt first.
    expect(parsed.tasks.map((t) => t.label)).toEqual([
      "newer-created",
      "older-created",
    ]);
  });

  it("regression: NO freshness option → existing createdAt-DESC behaviour preserved (slice F P6)", () => {
    // Existing slice F P6 test re-stated: 5 entries newest-first by
    // createdAt. Phase 4 wiring must NOT alter behaviour when called
    // without the freshness option.
    const tasks: TaskRecord[] = [
      makeTask({
        idSlug: "00000001",
        label: "first",
        status: "open",
        createdAt: "2026-05-05T10:00:00.000Z",
        updatedAt: "2026-05-05T10:00:00.000Z",
      }),
      makeTask({
        idSlug: "00000002",
        label: "second",
        status: "open",
        createdAt: "2026-05-05T11:00:00.000Z",
        updatedAt: "2026-05-05T11:00:00.000Z",
      }),
      makeTask({
        idSlug: "00000003",
        label: "third",
        status: "open",
        createdAt: "2026-05-05T12:00:00.000Z",
        updatedAt: "2026-05-05T12:00:00.000Z",
      }),
    ];
    const block = buildActiveTasksBlock(tasks);
    const inner = block.slice("<active_tasks>".length, -"</active_tasks>".length);
    const parsed = JSON.parse(inner) as { tasks: Array<{ label: string }> };
    // Newest createdAt first — unchanged from Phase F P6.
    expect(parsed.tasks.map((t) => t.label)).toEqual([
      "third",
      "second",
      "first",
    ]);
  });
});
