import type { DonePredicate } from "./affordance.js";

/**
 * Phase 2 stub for the `composer_after_search` affordance.
 *
 * Returns `unsatisfied` deterministically until Phase 3 introduces the
 * shared `WebEvidenceSlice` and Phase 4 wires the composer-side runtime
 * adapter (which will read both the slice and the existing
 * `deliveries.receipts` to confirm the artifact / text-response was
 * delivered). The stub avoids reading raw text or task-classifier
 * output, so invariant #9 holds while the runtime adapter is pending.
 *
 * @returns Predicate that always reports the canonical Phase 3/4 missing keys.
 */
export const webResearchSummarizedPredicate: DonePredicate = () => ({
  satisfied: false,
  missing: Object.freeze([
    "web_evidence.records.population_pending_phase_3",
    "composer.delivery_receipt_pending_phase_4",
  ]),
});
