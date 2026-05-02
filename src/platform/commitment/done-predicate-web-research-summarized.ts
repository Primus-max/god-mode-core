import type { DonePredicate } from "./affordance.js";

/**
 * Phase 3 partial wiring for the `composer_after_search` affordance.
 *
 * The full predicate must verify (a) `WebEvidenceSlice` carries ≥1
 * cited record (now readable on `WorldStateSnapshot.webEvidence` per
 * Phase 3) and (b) a `deliveries.receipts` entry confirms the composer
 * artifact / text-response was delivered. Part (b) requires the Phase 4
 * runtime adapter to emit a delivery receipt keyed on the composer
 * affordance; until then this stub stays partial and returns
 * `unsatisfied` deterministically. Reads no `state` / `delta` /
 * `receipts` / `trace`, so invariant #9 holds while Phase 4 is pending.
 *
 * @returns Predicate that always reports the canonical Phase 4 missing key.
 */
export const webResearchSummarizedPredicate: DonePredicate = () => ({
  satisfied: false,
  missing: Object.freeze(["composer.runtime_adapter_pending_phase_4"]),
});
