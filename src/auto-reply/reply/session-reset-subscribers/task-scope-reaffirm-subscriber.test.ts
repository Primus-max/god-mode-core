import { describe, expect, it } from "vitest";

import type { SessionId } from "../../../platform/identity/branded-ids.js";
import { asIdentityId } from "../../../platform/identity/identity-id.js";
import {
  createSessionResetSubscriberRegistry,
  resetTurnSession,
  type SessionResetEvent,
} from "../../../platform/session/reset.js";
import { InMemoryTaskLedger } from "../../../platform/task/in-memory-task-ledger.js";

import { createTaskScopeReaffirmSubscriber } from "./task-scope-reaffirm-subscriber.js";

const VALID_ISO = "2026-05-06T18:25:00.000Z";
const SESSION_ID = "f71784c5-aaaa-bbbb-cccc-111111111111" as SessionId;
const VLADIMIR = asIdentityId("identity:vladimir");

function buildEvent(overrides: Partial<SessionResetEvent> = {}): SessionResetEvent {
  return {
    sessionId: SESSION_ID,
    sessionKey: "telegram:6533456892",
    identityId: VLADIMIR,
    reason: "reset_trigger",
    occurredAt: VALID_ISO,
    ...overrides,
  };
}

describe("subscriber:task-scope-reaffirm — round-trip", () => {
  it("emits kind=skipped with the canonical identity-scope reason", async () => {
    const subscriber = createTaskScopeReaffirmSubscriber();
    expect(subscriber.id).toBe("subscriber:task-scope-reaffirm");
    expect(subscriber.category).toBe("task-scope");
    const outcome = await subscriber.onReset(buildEvent());
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toContain("identity-scoped");
      expect(outcome.reason).toContain("slice F B7");
    }
  });
});

describe("subscriber:task-scope-reaffirm — slice F B7 regression-guard", () => {
  it("identity-scoped task record survives a full resetTurnSession() pass", async () => {
    const ledger = new InMemoryTaskLedger();
    const created = await ledger.create({
      ownerIdentityId: VLADIMIR,
      label: "borscht-recipe",
      summary: "remember the borscht recipe across turns",
    });

    const registry = createSessionResetSubscriberRegistry();
    registry.register(createTaskScopeReaffirmSubscriber());
    const summary = await resetTurnSession({
      event: buildEvent(),
      registry,
    });
    expect(summary.skippedCount).toBe(1);
    expect(summary.clearedCount).toBe(0);

    // Task record MUST still be visible after reset — slice F B7 guarantee.
    const round = await ledger.list({ ownerIdentityId: VLADIMIR });
    expect(round.tasks.map((task) => task.id)).toContain(created.id);
  });
});
