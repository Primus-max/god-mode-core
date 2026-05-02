import { describe, expect, it } from "vitest";
import { webResearchSummarizedPredicate } from "../done-predicate-web-research-summarized.js";
import { WEB_RESEARCH_SUMMARIZED_EFFECT } from "../effect-family-registry.js";
import type { DonePredicateCtx } from "../affordance.js";
import type { ExpectedDelta } from "../expected-delta.js";
import type { EffectId, ISO8601 } from "../ids.js";
import type {
  DeliveryReceipt,
  WebEvidenceRecord,
  WorldStateSnapshot,
} from "../world-state.js";

const ISO_NOW = "2026-05-02T11:00:00.000Z" as ISO8601;
const CONTEXT_KEY = "telegram:chat-12345";
const ANSWER_DELIVERED_EFFECT = "answer.delivered" as EffectId;

const RECORD_A: WebEvidenceRecord = Object.freeze({
  url: "https://a.example.com",
  snippet: "first",
  capturedAt: ISO_NOW,
});
const RECORD_B: WebEvidenceRecord = Object.freeze({
  url: "https://b.example.com",
  snippet: "second",
  capturedAt: ISO_NOW,
});

function makeCtx(params: {
  readonly records?: readonly WebEvidenceRecord[];
  readonly receiptsByContext?: Readonly<Record<string, readonly DeliveryReceipt[]>>;
  readonly expectedKey?: string;
}): DonePredicateCtx {
  const stateAfter: WorldStateSnapshot = Object.freeze({
    ...(params.records !== undefined
      ? { webEvidence: { records: params.records } }
      : {}),
    ...(params.receiptsByContext !== undefined
      ? { deliveries: { receipts: params.receiptsByContext } }
      : {}),
  });
  const expectedDelta: ExpectedDelta = params.expectedKey
    ? {
        deliveries: {
          receipts: {
            added: Object.freeze([
              Object.freeze({ deliveryContextKey: params.expectedKey, kind: "answer" as const }),
            ]),
          },
        },
      }
    : Object.freeze({});
  return {
    stateBefore: Object.freeze({}),
    stateAfter,
    expectedDelta,
    receipts: { entries: [] },
    trace: { steps: [] },
  };
}

function composerReceipt(messageId: string, sentAt = 1_700_000_000_000): DeliveryReceipt {
  return Object.freeze({
    deliveryContextKey: CONTEXT_KEY,
    messageId,
    sentAt,
    effect: WEB_RESEARCH_SUMMARIZED_EFFECT,
    kind: "answer",
  });
}

describe("webResearchSummarizedPredicate — Search-Composer Phase 4b", () => {
  it("returns satisfied with two evidence facts when slice + receipt are both present (scoped by deliveryContextKey)", () => {
    const ctx = makeCtx({
      records: [RECORD_A, RECORD_B],
      receiptsByContext: { [CONTEXT_KEY]: [composerReceipt("msg-1", 1_700_000_000_000)] },
      expectedKey: CONTEXT_KEY,
    });
    const result = webResearchSummarizedPredicate(ctx);

    expect(result.satisfied).toBe(true);
    if (result.satisfied) {
      expect(result.evidence).toHaveLength(2);
      expect(result.evidence[0]?.kind).toBe("web_evidence.collected");
      expect(result.evidence[0]?.value).toMatchObject({
        recordCount: 2,
        firstUrl: "https://a.example.com",
      });
      expect(result.evidence[1]?.kind).toBe("web_research.summarized");
      expect(result.evidence[1]?.value).toMatchObject({
        messageId: "msg-1",
        sentAt: 1_700_000_000_000,
        deliveryContextKey: CONTEXT_KEY,
      });
    }
  });

  it("returns unsatisfied with web_evidence.slice_absent when slice is missing", () => {
    const ctx = makeCtx({
      receiptsByContext: { [CONTEXT_KEY]: [composerReceipt("msg-1")] },
      expectedKey: CONTEXT_KEY,
    });
    const result = webResearchSummarizedPredicate(ctx);
    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["web_evidence.slice_absent"]);
    }
  });

  it("returns unsatisfied with web_evidence.records.empty when slice is empty", () => {
    const ctx = makeCtx({
      records: [],
      receiptsByContext: { [CONTEXT_KEY]: [composerReceipt("msg-1")] },
      expectedKey: CONTEXT_KEY,
    });
    const result = webResearchSummarizedPredicate(ctx);
    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["web_evidence.records.empty"]);
    }
  });

  it("returns unsatisfied with composer.delivery_receipt_missing when no matching receipt for the expected context", () => {
    const ctx = makeCtx({
      records: [RECORD_A],
      receiptsByContext: { "other:context": [composerReceipt("msg-1")] },
      expectedKey: CONTEXT_KEY,
    });
    const result = webResearchSummarizedPredicate(ctx);
    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["composer.delivery_receipt_missing"]);
    }
  });

  it("returns unsatisfied when the receipt for the expected context has the wrong effect (e.g. answer.delivered)", () => {
    const wrongEffectReceipt: DeliveryReceipt = Object.freeze({
      deliveryContextKey: CONTEXT_KEY,
      messageId: "msg-1",
      sentAt: 1_700_000_000_000,
      effect: ANSWER_DELIVERED_EFFECT,
      kind: "answer",
    });
    const ctx = makeCtx({
      records: [RECORD_A],
      receiptsByContext: { [CONTEXT_KEY]: [wrongEffectReceipt] },
      expectedKey: CONTEXT_KEY,
    });
    const result = webResearchSummarizedPredicate(ctx);
    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["composer.delivery_receipt_missing"]);
    }
  });

  it("falls back to any-context lookup when expectedDelta does not specify a deliveryContextKey (single-channel)", () => {
    const ctx = makeCtx({
      records: [RECORD_A],
      receiptsByContext: { [CONTEXT_KEY]: [composerReceipt("msg-1")] },
    });
    const result = webResearchSummarizedPredicate(ctx);
    expect(result.satisfied).toBe(true);
  });

  it("does not read raw user text, TaskContract, or task-classifier output (invariant #9 sentinel-proxy)", () => {
    let touchedDisallowed = false;
    const allowed = new Set(["webEvidence", "deliveries"]);
    const sentinelStateAfter = new Proxy(
      {
        webEvidence: { records: [RECORD_A] },
        deliveries: { receipts: { [CONTEXT_KEY]: [composerReceipt("msg-1")] } },
      },
      {
        get(target, prop, receiver) {
          if (typeof prop === "string" && !allowed.has(prop)) {
            touchedDisallowed = true;
          }
          return Reflect.get(target, prop, receiver);
        },
      },
    ) as unknown as WorldStateSnapshot;
    const ctx: DonePredicateCtx = {
      stateBefore: Object.freeze({}),
      stateAfter: sentinelStateAfter,
      expectedDelta: {
        deliveries: {
          receipts: {
            added: [Object.freeze({ deliveryContextKey: CONTEXT_KEY, kind: "answer" as const })],
          },
        },
      },
      receipts: { entries: [] },
      trace: { steps: [] },
    };
    const result = webResearchSummarizedPredicate(ctx);
    expect(result.satisfied).toBe(true);
    expect(touchedDisallowed).toBe(false);
  });

  it("scopes by deliveryContextKey — does not satisfy when the receipt sits in a different context bucket", () => {
    const ctx = makeCtx({
      records: [RECORD_A],
      receiptsByContext: {
        "other:context": [composerReceipt("msg-other")],
        [CONTEXT_KEY]: [],
      },
      expectedKey: CONTEXT_KEY,
    });
    const result = webResearchSummarizedPredicate(ctx);
    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["composer.delivery_receipt_missing"]);
    }
  });
});
