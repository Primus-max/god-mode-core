/**
 * Cron/Scheduler Phase 5 — fail-first tests for `reminder-fire-callback.ts`.
 *
 * The callback is invoked by the scheduler when a registered `at`-job
 * reaches its `fireAt`. Behavior:
 *  - load `ReminderRecord` from `ReminderStore` keyed on `reminderId` +
 *    `identityId`;
 *  - mark `status='fired'` (idempotent on retry);
 *  - construct delivery payload with `wrappedScopeIdentityId =
 *    record.ownerIdentityId` (slice K precedent — fired turn respects
 *    identity scope even from non-interactive context);
 *  - call the injected `deliveryDispatch` function (production wires
 *    `dispatchCronDelivery` from `delivery-dispatch.ts`; tests inject a
 *    capture spy).
 *
 * Tests pin the clock at the dependency-injection seam ONLY (sub-plan
 * §5 — no `vi.spyOn` on the function under test).
 */

import { describe, expect, it } from "vitest";

import { asIdentityId } from "../../platform/identity/identity-id.js";
import {
  InMemoryReminderStore,
  type ReminderStore,
  type ReminderRecord,
} from "../../platform/reminder/reminder-store.js";

import {
  fireReminder,
  type FireReminderInput,
  type DeliveryDispatchFn,
} from "./reminder-fire-callback.js";

const VLADIMIR = asIdentityId("identity:vladimir");
const FIRE_AT = "2026-05-07T12:00:00.000Z";

async function seededStore(): Promise<ReminderStore> {
  const store = new InMemoryReminderStore();
  await store.schedule({
    reminderId: "reminder-1",
    ownerIdentityId: VLADIMIR,
    fireAt: FIRE_AT,
    content: "позвонить клиенту X",
    deliveryChannel: "telegram",
    deliveryTo: "6533456892",
  });
  return store;
}

function captureDispatch(): DeliveryDispatchFn & {
  readonly calls: Array<unknown>;
} {
  const calls: unknown[] = [];
  const fn: DeliveryDispatchFn = async (payload) => {
    calls.push(payload);
    return { ok: true };
  };
  return Object.assign(fn, { calls });
}

function buildInput(
  overrides: Partial<FireReminderInput> = {},
): FireReminderInput {
  return {
    reminderId: "reminder-1",
    ownerIdentityId: VLADIMIR,
    reminderStore: undefined,
    deliveryDispatch: captureDispatch(),
    ...overrides,
  };
}

describe("fireReminder — happy path", () => {
  it("loads record, marks fired, dispatches delivery with wrappedScopeIdentityId", async () => {
    const store = await seededStore();
    const dispatch = captureDispatch();
    const result = await fireReminder(buildInput({
      reminderStore: store,
      deliveryDispatch: dispatch,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    const persisted = (await store.get("reminder-1", VLADIMIR)) as ReminderRecord;
    expect(persisted.status).toBe("fired");

    expect(dispatch.calls.length).toBe(1);
    const payload = dispatch.calls[0] as Record<string, unknown>;
    expect(payload["wrappedScopeIdentityId"]).toBe(VLADIMIR);
    expect(payload["reminderId"]).toBe("reminder-1");
    expect(payload["content"]).toBe("позвонить клиенту X");
    expect(payload["channel"]).toBe("telegram");
    expect(payload["to"]).toBe("6533456892");
  });

  it("emits a [reminder-fire-callback] log line carrying reminderId + wrappedScopeIdentityId", async () => {
    const store = await seededStore();
    const lines: string[] = [];
    await fireReminder(buildInput({
      reminderStore: store,
      logger: (line) => lines.push(line),
    }));
    expect(lines.length).toBeGreaterThan(0);
    const matched = lines.find((l) => l.startsWith("[reminder-fire-callback]"));
    expect(matched).toBeDefined();
    expect(matched).toContain("reminderId=reminder-1");
    expect(matched).toContain(`wrappedScopeIdentityId=${VLADIMIR}`);
  });
});

describe("fireReminder — closed failure set", () => {
  it("returns reminder_store_unavailable when store is undefined", async () => {
    const result = await fireReminder(buildInput({ reminderStore: undefined }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    expect(result.reason).toBe("reminder_store_unavailable");
  });

  it("returns record_missing when reminderId is not present in the store", async () => {
    const store = new InMemoryReminderStore();
    const result = await fireReminder(buildInput({
      reminderStore: store,
      reminderId: "does-not-exist",
    }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    expect(result.reason).toBe("record_missing");
  });

  it("returns identity_mismatch when reminderId belongs to a different identity (cross-identity defense)", async () => {
    const store = await seededStore();
    const operatorB = asIdentityId("identity:operator-b");
    const result = await fireReminder(buildInput({
      reminderStore: store,
      ownerIdentityId: operatorB,
    }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    // get(reminderId, identityB) returns undefined → record_missing
    expect(result.reason).toBe("record_missing");
  });

  it("returns dispatch_failed when deliveryDispatch rejects (record still marked fired — idempotent)", async () => {
    const store = await seededStore();
    const failing: DeliveryDispatchFn = async () => {
      throw new Error("transport-down");
    };
    const result = await fireReminder(buildInput({
      reminderStore: store,
      deliveryDispatch: failing,
    }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    expect(result.reason).toBe("dispatch_failed");
    // record is still flipped to `fired` so the cron driver does not
    // replay infinitely (idempotency invariant — sub-plan §6 acceptance).
    const persisted = (await store.get("reminder-1", VLADIMIR)) as ReminderRecord;
    expect(persisted.status).toBe("fired");
  });
});

describe("fireReminder — invariant #15 NEVER throws", () => {
  it("returns a typed envelope on empty input", async () => {
    let thrown: unknown = null;
    let result: Awaited<ReturnType<typeof fireReminder>> | undefined;
    try {
      result = await fireReminder({} as FireReminderInput);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeNull();
    expect(result?.ok).toBe(false);
  });
});
