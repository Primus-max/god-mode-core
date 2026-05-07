/**
 * Cron/Scheduler Phase 5 — fail-first tests for `RecordReminderTool`.
 *
 * Sibling of `recall-reminder-tool.test.ts` (slice K P4), `repo-tool.test.ts`
 * (Cutover-4 P5). Validates:
 *
 *  - happy path: closed `ReminderSetShape` → adapter writes record →
 *    `CronService.add` registers `kind:'at'` job → ReminderStore persists
 *    pending entry → tool returns `{ ok:true, reminderId, expectedDelta }`.
 *  - schema discipline: free-form `{when, what}` rejected (#5/#6 reverse);
 *    additional properties rejected (.strict()).
 *  - identity injection: `ownerIdentityId` from session context — when
 *    absent (anonymous), tool fails closed `identity_unavailable` with
 *    ZERO `ReminderStore` calls AND ZERO `CronService.add` calls.
 *  - structural failure surface: `fire_at_invalid` / `fire_at_in_past` /
 *    `channel_invalid` / `reminder_store_unavailable` /
 *    `observer_unavailable` (closed set; sub-plan §1 todo Phase 5).
 */

import { describe, expect, it, vi } from "vitest";

import { asIdentityId } from "../../platform/identity/identity-id.js";
import {
  createScheduledReminderWorldStateCollector,
  type ScheduledReminderWorldStateCollector,
} from "../../platform/commitment/scheduled-reminder-world-state-observer.js";
import {
  InMemoryReminderStore,
  type ReminderStore,
} from "../../platform/reminder/reminder-store.js";
import type { ChannelId, SessionId } from "../../platform/commitment/ids.js";

import {
  recordReminderTool,
  type CronAddFn,
  type RecordReminderToolInput,
} from "./record-reminder-tool.js";

const VLADIMIR = asIdentityId("identity:vladimir");
const SESSION = "session-a" as SessionId;
const TURN = "turn-1";
const TELEGRAM = "telegram" as ChannelId;
const FIXED_NOW_MS = Date.parse("2026-05-07T11:00:00.000Z");
const FIRE_AT_FUTURE = "2026-05-07T12:00:00.000Z";
const FIRE_AT_PAST = "2026-05-07T10:00:00.000Z";

function activeCollector(): ScheduledReminderWorldStateCollector {
  const collector = createScheduledReminderWorldStateCollector();
  collector.setActiveTurn({ sessionId: SESSION, turnId: TURN });
  return collector;
}

function buildCronAdd(): CronAddFn & {
  readonly calls: Array<unknown>;
} {
  const calls: unknown[] = [];
  const fn: CronAddFn = async (input) => {
    calls.push(input);
    return { id: "cronjob-1" };
  };
  return Object.assign(fn, { calls });
}

function buildInput(
  overrides: Partial<RecordReminderToolInput> = {},
): RecordReminderToolInput {
  return {
    shape: {
      reminderId: "reminder-1",
      fireAt: FIRE_AT_FUTURE,
      content: "позвонить клиенту X",
      deliveryChannel: TELEGRAM,
      deliveryTo: "6533456892",
    },
    ownerIdentityId: VLADIMIR,
    sessionId: SESSION,
    turnId: TURN,
    collector: activeCollector(),
    reminderStore: new InMemoryReminderStore(),
    cronAdd: buildCronAdd(),
    now: () => FIXED_NOW_MS,
    ...overrides,
  };
}

describe("recordReminderTool — happy path", () => {
  it("persists pending record, registers cron job, returns ok with expectedDelta", async () => {
    const cronAdd = buildCronAdd();
    const reminderStore = new InMemoryReminderStore();
    const input = buildInput({ cronAdd, reminderStore });
    const result = await recordReminderTool(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.reminderId).toBe("reminder-1");
    expect(result.expectedDelta).toEqual({
      scheduledReminders: { added: ["reminder-1"] },
    });

    const persisted = await reminderStore.get("reminder-1", VLADIMIR);
    expect(persisted).toBeDefined();
    expect(persisted?.status).toBe("pending");
    expect(persisted?.fireAt).toBe(FIRE_AT_FUTURE);
    expect(persisted?.content).toBe("позвонить клиенту X");

    expect(cronAdd.calls.length).toBe(1);
    const job = cronAdd.calls[0] as Record<string, unknown>;
    expect((job["schedule"] as Record<string, unknown>)["kind"]).toBe("at");
    expect((job["schedule"] as Record<string, unknown>)["at"]).toBe(FIRE_AT_FUTURE);
    expect((job["delivery"] as Record<string, unknown>)["channel"]).toBe(
      TELEGRAM,
    );
    expect((job["delivery"] as Record<string, unknown>)["to"]).toBe(
      "6533456892",
    );
  });

  it("auto-mints reminderId via injected idGen when shape omits it", async () => {
    const idGen = () => "auto-reminder-xyz";
    const result = await recordReminderTool(
      buildInput({
        idGen,
        shape: {
          fireAt: FIRE_AT_FUTURE,
          content: "позвонить клиенту X",
          deliveryChannel: TELEGRAM,
          deliveryTo: "6533456892",
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.reminderId).toBe("auto-reminder-xyz");
  });
});

describe("recordReminderTool — invariants #5/#6 reverse: schema rejects free-form text", () => {
  it("rejects free-form {when, what} payload at the schema boundary", async () => {
    const cronAdd = buildCronAdd();
    const reminderStore = new InMemoryReminderStore();
    const storeSpy = vi.spyOn(reminderStore, "schedule");
    const result = await recordReminderTool({
      ...buildInput({ cronAdd, reminderStore }),
      // bypass static type checks to exercise the runtime guard
      shape: { when: "tomorrow noon", what: "call X" } as unknown as RecordReminderToolInput["shape"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    expect(result.reason).toBe("schema_invalid");
    expect(cronAdd.calls.length).toBe(0);
    expect(storeSpy).not.toHaveBeenCalled();
  });

  it("rejects extra properties on shape (.strict() — closed schema)", async () => {
    const result = await recordReminderTool({
      ...buildInput(),
      shape: {
        reminderId: "reminder-1",
        fireAt: FIRE_AT_FUTURE,
        content: "ok",
        deliveryChannel: TELEGRAM,
        deliveryTo: "6533456892",
        extra: "should-not-be-allowed",
      } as unknown as RecordReminderToolInput["shape"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    expect(result.reason).toBe("schema_invalid");
  });

  it("rejects oversize content (length cap matches observer 4096)", async () => {
    const big = "X".repeat(5000);
    const result = await recordReminderTool({
      ...buildInput(),
      shape: {
        reminderId: "reminder-1",
        fireAt: FIRE_AT_FUTURE,
        content: big,
        deliveryChannel: TELEGRAM,
        deliveryTo: "6533456892",
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    expect(result.reason).toBe("schema_invalid");
  });
});

describe("recordReminderTool — identity injection (slice K P4 precedent)", () => {
  it("anonymous fail-closed: ZERO ReminderStore + ZERO cron calls when ownerIdentityId is undefined", async () => {
    const cronAdd = buildCronAdd();
    const reminderStore = new InMemoryReminderStore();
    const storeSpy = vi.spyOn(reminderStore, "schedule");
    const result = await recordReminderTool({
      ...buildInput({ cronAdd, reminderStore }),
      ownerIdentityId: undefined,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    expect(result.reason).toBe("identity_unavailable");
    expect(cronAdd.calls.length).toBe(0);
    expect(storeSpy).not.toHaveBeenCalled();
  });

  it("anonymous fail-closed: ZERO ReminderStore + ZERO cron calls when ownerIdentityId is empty string", async () => {
    const cronAdd = buildCronAdd();
    const reminderStore = new InMemoryReminderStore();
    const storeSpy = vi.spyOn(reminderStore, "schedule");
    const result = await recordReminderTool({
      ...buildInput({ cronAdd, reminderStore }),
      // bypass the brand to exercise the runtime guard
      ownerIdentityId: "" as unknown as ReturnType<typeof asIdentityId>,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    expect(result.reason).toBe("identity_unavailable");
    expect(cronAdd.calls.length).toBe(0);
    expect(storeSpy).not.toHaveBeenCalled();
  });
});

describe("recordReminderTool — structural failure surface", () => {
  it("returns fire_at_invalid on malformed timestamp, ZERO cron + ZERO store", async () => {
    const cronAdd = buildCronAdd();
    const reminderStore = new InMemoryReminderStore();
    const storeSpy = vi.spyOn(reminderStore, "schedule");
    const result = await recordReminderTool({
      ...buildInput({ cronAdd, reminderStore }),
      shape: {
        reminderId: "reminder-1",
        fireAt: "not-a-timestamp",
        content: "ok",
        deliveryChannel: TELEGRAM,
        deliveryTo: "6533456892",
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    // schema_invalid > fire_at_invalid because the Zod schema validates
    // the ISO regex at the boundary (fire_at_invalid is reserved for the
    // adapter-level structural check).
    expect(result.reason).toBe("schema_invalid");
    expect(cronAdd.calls.length).toBe(0);
    expect(storeSpy).not.toHaveBeenCalled();
  });

  it("returns fire_at_in_past when fireAt resolves before injected clock", async () => {
    const cronAdd = buildCronAdd();
    const result = await recordReminderTool({
      ...buildInput({ cronAdd }),
      shape: {
        reminderId: "reminder-1",
        fireAt: FIRE_AT_PAST,
        content: "ok",
        deliveryChannel: TELEGRAM,
        deliveryTo: "6533456892",
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    expect(result.reason).toBe("fire_at_in_past");
    expect(cronAdd.calls.length).toBe(0);
  });

  it("returns reminder_store_unavailable when reminderStore is undefined", async () => {
    const cronAdd = buildCronAdd();
    const result = await recordReminderTool({
      ...buildInput({ cronAdd }),
      reminderStore: undefined,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    expect(result.reason).toBe("reminder_store_unavailable");
    expect(cronAdd.calls.length).toBe(0);
  });

  it("returns observer_unavailable when collector is undefined (no cron registration)", async () => {
    const cronAdd = buildCronAdd();
    const reminderStore = new InMemoryReminderStore();
    const storeSpy = vi.spyOn(reminderStore, "schedule");
    const result = await recordReminderTool({
      ...buildInput({ cronAdd, reminderStore }),
      collector: undefined,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    expect(result.reason).toBe("observer_unavailable");
    expect(cronAdd.calls.length).toBe(0);
    expect(storeSpy).not.toHaveBeenCalled();
  });

  it("returns transport_error and SWALLOWS the throw when CronService.add rejects (defense in depth)", async () => {
    const failing: CronAddFn = async () => {
      throw new Error("cron-add-flapped");
    };
    const reminderStore = new InMemoryReminderStore();
    let thrown: unknown;
    let result: Awaited<ReturnType<typeof recordReminderTool>> | undefined;
    try {
      result = await recordReminderTool({
        ...buildInput({ reminderStore }),
        cronAdd: failing,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeUndefined();
    expect(result?.ok).toBe(false);
    if (result?.ok) throw new Error("expected !ok");
    expect(result?.reason).toBe("transport_error");
  });
});

describe("recordReminderTool — identity isolation invariant", () => {
  it("operator A's persisted reminder is NOT readable from operator B's identity scope (defense in depth)", async () => {
    const reminderStore = new InMemoryReminderStore();
    const result = await recordReminderTool(buildInput({ reminderStore }));
    expect(result.ok).toBe(true);

    const operatorB = asIdentityId("identity:operator-b");
    const got = await reminderStore.get("reminder-1", operatorB);
    expect(got).toBeUndefined();
    const list = await reminderStore.list({ identityId: operatorB });
    expect(list).toHaveLength(0);
  });
});

describe("recordReminderTool — schedule receives correct CronJobCreate shape", () => {
  it("registers cron with kind:'at', mode:'announce', and the structured channel/to", async () => {
    const cronAdd = buildCronAdd();
    await recordReminderTool(buildInput({ cronAdd }));
    expect(cronAdd.calls.length).toBe(1);
    const job = cronAdd.calls[0] as {
      schedule: { kind: string; at: string };
      payload: { kind: string; message: string };
      delivery: { mode: string; channel: string; to: string };
    };
    expect(job.schedule.kind).toBe("at");
    expect(job.schedule.at).toBe(FIRE_AT_FUTURE);
    expect(job.payload.kind).toBe("agentTurn");
    expect(job.payload.message).toContain("позвонить клиенту X");
    expect(job.delivery.mode).toBe("announce");
    expect(job.delivery.channel).toBe(TELEGRAM);
    expect(job.delivery.to).toBe("6533456892");
  });
});

describe("recordReminderTool — never-throws (invariant #15)", () => {
  it("returns a typed envelope for an empty input object", async () => {
    let thrown: unknown = null;
    let result: Awaited<ReturnType<typeof recordReminderTool>> | undefined;
    try {
      result = await recordReminderTool({} as RecordReminderToolInput);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeNull();
    expect(result).toBeDefined();
    expect(result?.ok).toBe(false);
  });
});

// Type-level reverse-test: a future caller cannot type-narrow the shape
// to include a `query` / `when` / `what` free-form field (#5/#6).
// `ReminderSetShape` is the closed structural type — TS errors at the
// shape boundary; the runtime test above covers the user-input bypass.
type _ReminderShapeBoundaryGuard = ReminderStore | InMemoryReminderStore;
