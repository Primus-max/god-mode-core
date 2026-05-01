import type { DonePredicate, EvidenceFact } from "./affordance.js";
import type { DeliveryReceipt, DeliveryReceiptKind } from "./world-state.js";

const EVIDENCE_KIND_BY_RECEIPT_KIND: Readonly<Record<DeliveryReceiptKind, string>> = Object.freeze({
  answer: "answer.delivered",
  clarification: "clarification.delivered",
  external_effect: "external_effect.observed",
});

/**
 * Builds a `DonePredicate` that verifies every expected delivery receipt of a
 * given kind is present in `stateAfter.deliveries`.
 *
 * The predicate ignores receipts in the `receipts` bundle (per master invariant
 * #9: state / delta / receipts / trace, observed state-after only governs
 * satisfaction). Raw user text is never inspected.
 *
 * @param kind - Receipt kind this affordance is responsible for.
 * @returns Predicate over observed deliveries.
 */
export function createDeliveryDonePredicate(kind: DeliveryReceiptKind): DonePredicate {
  const evidenceKind = EVIDENCE_KIND_BY_RECEIPT_KIND[kind];
  return (ctx) => {
    const expected = ctx.expectedDelta.deliveries?.receipts?.added ?? [];
    if (expected.length === 0) {
      return { satisfied: false, missing: ["expected_delta_empty"] };
    }
    const after = ctx.stateAfter.deliveries?.receipts ?? {};
    const missing: string[] = [];
    const evidence: EvidenceFact[] = [];
    for (const ref of expected) {
      if (ref.kind !== kind) {
        missing.push(`expected_kind_mismatch:${ref.deliveryContextKey}:${ref.kind}`);
        continue;
      }
      const bucket = after[ref.deliveryContextKey];
      const receipt = bucket?.find((entry) => entry.kind === kind);
      if (!receipt) {
        missing.push(`receipt_missing:${ref.deliveryContextKey}:${kind}`);
        continue;
      }
      evidence.push({
        kind: evidenceKind,
        value: serializeReceipt(receipt),
      });
    }
    return missing.length === 0
      ? { satisfied: true, evidence: Object.freeze(evidence) }
      : { satisfied: false, missing: Object.freeze(missing) };
  };
}

function serializeReceipt(receipt: DeliveryReceipt) {
  return Object.freeze({
    deliveryContextKey: receipt.deliveryContextKey,
    messageId: receipt.messageId,
    sentAt: receipt.sentAt,
    effect: receipt.effect,
    kind: receipt.kind,
  });
}

export const answerDeliveredPredicate: DonePredicate = createDeliveryDonePredicate("answer");
export const clarificationRequestedPredicate: DonePredicate =
  createDeliveryDonePredicate("clarification");
export const externalEffectPerformedPredicate: DonePredicate =
  createDeliveryDonePredicate("external_effect");
