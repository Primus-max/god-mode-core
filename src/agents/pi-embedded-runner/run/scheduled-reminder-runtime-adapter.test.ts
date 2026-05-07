/**
 * Cron/Scheduler Phase 5 — fail-first tests for the scheduled-reminder
 * runtime adapter (`scheduled-reminder-runtime-adapter.ts`).
 *
 * Sibling of `repo-runtime-adapter.test.ts` (Cutover-4 P5) and
 * `artifact-runtime-adapter.test.ts` (Cutover-3 P5). Validates:
 *
 * - happy path: `recordReminderScheduled(...)` appends a `pending`
 *   `ScheduledReminderRecord` to the injected collector AND returns
 *   `{ ok:true, reminderId, expectedDelta:{scheduledReminders:{added:[reminderId]}} }`;
 * - closed failure set (every reason exhaustively reachable);
 * - identity / fireAt structural fail-closed paths;
 * - fail-first reverse for the `fire_at_in_past` boundary against the
 *   injected clock;
 * - NEVER throws (invariant #15) — every malformed shape returns a
 *   typed result envelope.
 */

import { describe, expect, it } from "vitest";

import { asIdentityId } from "../../../platform/identity/identity-id.js";
import {
  createScheduledReminderWorldStateCollector,
  type ScheduledReminderWorldStateCollector,
} from "../../../platform/commitment/scheduled-reminder-world-state-observer.js";
import type { ChannelId, SessionId } from "../../../platform/commitment/ids.js";

import {
  recordReminderScheduled,
  type RecordReminderScheduledInput,
} from "./scheduled-reminder-runtime-adapter.js";

const VLADIMIR = asIdentityId("identity:vladimir");
const SESSION = "session-a" as SessionId;
const TURN = "turn-1";
const TELEGRAM = "telegram" as ChannelId;
const FIXED_NOW_MS = Date.parse("2026-05-07T11:00:00.000Z");
const FIRE_AT_FUTURE = "2026-05-07T12:00:00.000Z";
const FIRE_AT_PAST = "2026-05-07T10:00:00.000Z";

function fixedClock(): () => number {
  return () => FIXED_NOW_MS;
}

function activeCollector(): ScheduledReminderWorldStateCollector {
  const collector = createScheduledReminderWorldStateCollector();
  collector.setActiveTurn({ sessionId: SESSION, turnId: TURN });
  return collector;
}

function buildInput(
  overrides: Partial<RecordReminderScheduledInput> = {},
): RecordReminderScheduledInput {
  return {
    collector: activeCollector(),
    sessionId: SESSION,
    turnId: TURN,
    reminderId: "reminder-1",
    ownerIdentityId: VLADIMIR,
    fireAt: FIRE_AT_FUTURE,
    content: "позвонить клиенту X",
    deliveryChannel: TELEGRAM,
    deliveryTo: "6533456892",
    now: fixedClock(),
    ...overrides,
  };
}

describe("recordReminderScheduled — happy path", () => {
  it("appends a pending record to the collector and returns expectedDelta with the reminderId", () => {
    const input = buildInput();
    const result = recordReminderScheduled(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.reminderId).toBe("reminder-1");
    expect(result.expectedDelta).toEqual({
      scheduledReminders: { added: ["reminder-1"] },
    });
    const slice = input.collector.getActiveSlice();
    expect(slice).toBeDefined();
    expect(slice?.length).toBe(1);
    expect(slice?.[0]?.reminderId).toBe("reminder-1");
    expect(slice?.[0]?.status).toBe("pending");
    expect(slice?.[0]?.ownerIdentityId).toBe(VLADIMIR);
    expect(slice?.[0]?.fireAt).toBe(FIRE_AT_FUTURE);
    expect(slice?.[0]?.content).toBe("позвонить клиенту X");
    expect(slice?.[0]?.deliveryChannel).toBe(TELEGRAM);
    expect(slice?.[0]?.deliveryTo).toBe("6533456892");
  });

  it("emits a [scheduled-reminder-runtime-adapter] log line carrying reminderId / fireAt / identityId", () => {
    const lines: string[] = [];
    recordReminderScheduled(
      buildInput({ logger: (line) => lines.push(line) }),
    );
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const matched = lines.find((l) =>
      l.startsWith("[scheduled-reminder-runtime-adapter] recordReminderScheduled"),
    );
    expect(matched).toBeDefined();
    expect(matched).toContain("reminderId=reminder-1");
    expect(matched).toContain(`fireAt=${FIRE_AT_FUTURE}`);
    expect(matched).toContain(`identityId=${VLADIMIR}`);
  });
});

describe("recordReminderScheduled — closed failure set", () => {
  it("returns observer_unavailable when collector is missing", () => {
    const result = recordReminderScheduled(
      buildInput({ collector: undefined as unknown as ScheduledReminderWorldStateCollector }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    expect(result.reason).toBe("observer_unavailable");
  });

  it("returns identity_unavailable when ownerIdentityId is empty (anonymous fail-closed)", () => {
    const result = recordReminderScheduled(
      buildInput({ ownerIdentityId: "" as unknown as ReturnType<typeof asIdentityId> }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    expect(result.reason).toBe("identity_unavailable");
  });

  it("returns fire_at_invalid on malformed ISO-8601", () => {
    const result = recordReminderScheduled(
      buildInput({ fireAt: "not-a-timestamp" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    expect(result.reason).toBe("fire_at_invalid");
  });

  it("returns fire_at_in_past when fireAt < now", () => {
    const result = recordReminderScheduled(
      buildInput({ fireAt: FIRE_AT_PAST }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    expect(result.reason).toBe("fire_at_in_past");
  });

  it("returns channel_invalid on empty deliveryChannel", () => {
    const result = recordReminderScheduled(
      buildInput({ deliveryChannel: "" as unknown as ChannelId }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    expect(result.reason).toBe("channel_invalid");
  });

  it("returns channel_invalid on empty deliveryTo", () => {
    const result = recordReminderScheduled(buildInput({ deliveryTo: "" }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    expect(result.reason).toBe("channel_invalid");
  });

  it("returns transport_error on empty reminderId", () => {
    const result = recordReminderScheduled(buildInput({ reminderId: "" }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    expect(result.reason).toBe("transport_error");
  });

  it("returns transport_error when collector throws on record (Zod rejection)", () => {
    const failing: ScheduledReminderWorldStateCollector = {
      record: () => {
        throw new Error("zod-rejected");
      },
      resetForTurn: () => {},
      setActiveTurn: () => {},
      getActiveSlice: () => undefined,
    };
    const result = recordReminderScheduled(buildInput({ collector: failing }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    expect(result.reason).toBe("transport_error");
  });
});

describe("recordReminderScheduled — invariant #15 never throws", () => {
  it("returns a typed envelope even when given a frozen-but-unrelated input", () => {
    let thrown: unknown = null;
    let result: ReturnType<typeof recordReminderScheduled> | undefined;
    try {
      result = recordReminderScheduled({} as RecordReminderScheduledInput);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeNull();
    expect(result).toBeDefined();
    expect(result?.ok).toBe(false);
  });
});
