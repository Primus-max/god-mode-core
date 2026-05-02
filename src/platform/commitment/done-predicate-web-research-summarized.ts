import type { DonePredicate, EvidenceFact } from "./affordance.js";
import type { ExecutionCommitment } from "./execution-commitment.js";
import { WEB_RESEARCH_SUMMARIZED_EFFECT } from "./effect-family-registry.js";

/**
 * Search-Composer Phase 4b composer predicate.
 *
 * Verifies the composer-after-search affordance by reading two state-after
 * surfaces: `webEvidence.records` (Phase 3 slice — must carry ≥1 cited
 * record) and `deliveries.receipts` (Phase 4b composer adapter emits a
 * `DeliveryReceipt` with `effect=WEB_RESEARCH_SUMMARIZED_EFFECT` and
 * `kind=answer` after a successful composer run). Both pieces of evidence
 * are required: the slice proves a real search ran, and the receipt proves
 * the composer authored and delivered a response over that evidence.
 *
 * Reads only `ctx.stateAfter.webEvidence` and `ctx.stateAfter.deliveries`.
 * Raw user text, `TaskContract`, and task-classifier output remain
 * untouched (invariant #9). The predicate is deterministic — no
 * `Date.now()` or runtime-only state is consulted.
 *
 * The predicate scopes the receipt lookup by `deliveryContextKey` read
 * from `ExecutionCommitment.constraints` so concurrent turns on different
 * channels do not satisfy each other's commitments. When the constraint is
 * absent the predicate falls back to the first matching receipt across all
 * delivery contexts (single-channel deployments stay correct; multi-channel
 * deployments must populate the constraint).
 *
 * @param ctx - Predicate context with state snapshots, expected delta,
 *   receipts, and trace.
 * @returns Satisfied with two `EvidenceFact` entries (slice + receipt) when
 *   both pieces are present; otherwise `unsatisfied` with a closed-string
 *   missing key explaining the structural failure.
 */
export const webResearchSummarizedPredicate: DonePredicate = (ctx) => {
  const records = ctx.stateAfter.webEvidence?.records;
  if (records === undefined) {
    return {
      satisfied: false,
      missing: Object.freeze(["web_evidence.slice_absent"]),
    };
  }
  if (records.length === 0) {
    return {
      satisfied: false,
      missing: Object.freeze(["web_evidence.records.empty"]),
    };
  }

  const receiptsByContext = ctx.stateAfter.deliveries?.receipts ?? {};
  const expectedKey = readDeliveryContextKey(ctx);
  const receipt = findComposerReceipt(receiptsByContext, expectedKey);
  if (!receipt) {
    return {
      satisfied: false,
      missing: Object.freeze(["composer.delivery_receipt_missing"]),
    };
  }

  const evidence: readonly EvidenceFact[] = Object.freeze([
    {
      kind: "web_evidence.collected",
      value: Object.freeze({
        recordCount: records.length,
        firstUrl: records[0]?.url,
      }),
    },
    {
      kind: "web_research.summarized",
      value: Object.freeze({
        messageId: receipt.messageId,
        sentAt: receipt.sentAt,
        deliveryContextKey: receipt.deliveryContextKey,
      }),
    },
  ]);

  return { satisfied: true, evidence };
};

function readDeliveryContextKey(ctx: {
  readonly expectedDelta: { readonly deliveries?: { readonly receipts?: { readonly added?: readonly { readonly deliveryContextKey: string }[] } } };
}): string | undefined {
  return ctx.expectedDelta.deliveries?.receipts?.added?.[0]?.deliveryContextKey;
}

function findComposerReceipt(
  receiptsByContext: Readonly<Record<string, readonly { readonly effect: ExecutionCommitment["effect"]; readonly messageId: string; readonly sentAt: number; readonly deliveryContextKey: string; readonly kind: string }[]>>,
  expectedKey: string | undefined,
): { readonly messageId: string; readonly sentAt: number; readonly deliveryContextKey: string } | undefined {
  if (expectedKey !== undefined) {
    const bucket = receiptsByContext[expectedKey];
    if (bucket) {
      const match = bucket.find((entry) => entry.effect === WEB_RESEARCH_SUMMARIZED_EFFECT);
      if (match) {
        return match;
      }
    }
    return undefined;
  }
  for (const bucket of Object.values(receiptsByContext)) {
    const match = bucket.find((entry) => entry.effect === WEB_RESEARCH_SUMMARIZED_EFFECT);
    if (match) {
      return match;
    }
  }
  return undefined;
}
