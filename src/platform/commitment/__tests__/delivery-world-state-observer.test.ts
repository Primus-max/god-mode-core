import { describe, expect, it } from "vitest";
import {
  createDeliveryReceiptRegistry,
  createDeliveryWorldStateObserver,
} from "../index.js";
import type { EffectId } from "../ids.js";
import type { DeliveryReceipt } from "../world-state.js";

const ANSWER_DELIVERED: EffectId = "answer.delivered" as EffectId;

function receipt(overrides: Partial<DeliveryReceipt>): DeliveryReceipt {
  return {
    deliveryContextKey: "telegram:chat:42",
    messageId: "tg-msg-1",
    sentAt: 1_700_000_000_000,
    effect: ANSWER_DELIVERED,
    kind: "answer",
    ...overrides,
  };
}

describe("DeliveryWorldStateObserver (sub-plan §5 row 'Deliveries slice observer')", () => {
  it("observe() returns no receipts before any send", () => {
    const registry = createDeliveryReceiptRegistry();
    const observer = createDeliveryWorldStateObserver(registry);

    expect(observer.observe()).toEqual({ receipts: {} });
  });

  it("observe() reflects receipts recorded by the outbound pipeline", () => {
    const registry = createDeliveryReceiptRegistry();
    const observer = createDeliveryWorldStateObserver(registry);

    registry.record(receipt({ messageId: "tg-msg-1", kind: "answer" }));
    registry.record(
      receipt({ messageId: "tg-msg-2", kind: "clarification", deliveryContextKey: "telegram:chat:7" }),
    );

    const snapshot = observer.observe();
    expect(Object.keys(snapshot.receipts).sort()).toEqual([
      "telegram:chat:42",
      "telegram:chat:7",
    ]);
    expect(snapshot.receipts["telegram:chat:42"]?.[0]).toMatchObject({
      messageId: "tg-msg-1",
      kind: "answer",
    });
    expect(snapshot.receipts["telegram:chat:7"]?.[0]).toMatchObject({
      messageId: "tg-msg-2",
      kind: "clarification",
    });
  });

  it("returns frozen state slices safe to share with predicates", () => {
    const registry = createDeliveryReceiptRegistry();
    const observer = createDeliveryWorldStateObserver(registry);
    registry.record(receipt({}));

    const snapshot = observer.observe();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.receipts)).toBe(true);
  });

  it("dedupes by messageId so re-emitted receipts do not appear twice", () => {
    const registry = createDeliveryReceiptRegistry();
    const observer = createDeliveryWorldStateObserver(registry);
    registry.record(receipt({ messageId: "tg-msg-1", sentAt: 1 }));
    registry.record(receipt({ messageId: "tg-msg-1", sentAt: 2 }));

    const snapshot = observer.observe();
    const bucket = snapshot.receipts["telegram:chat:42"] ?? [];
    expect(bucket).toHaveLength(1);
    expect(bucket[0]?.sentAt).toBe(2);
  });
});
