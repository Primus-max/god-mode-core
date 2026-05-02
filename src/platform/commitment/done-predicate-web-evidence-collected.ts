import type { DonePredicate } from "./affordance.js";

/**
 * Phase 2 stub for the `perplexity_search_specialist` affordance.
 *
 * Returns `unsatisfied` deterministically until Phase 3 introduces
 * `WebEvidenceSlice` on `WorldStateSnapshot` and Phase 4 wires the runtime
 * adapter that populates it from a sonar/sonar-pro reply. The stub does
 * not read raw user text, `TaskContract`, or task-classifier output, so
 * invariant #9 holds even while the slice has not yet been wired.
 *
 * @returns Predicate that always reports the canonical Phase 3 missing key.
 */
export const webEvidenceCollectedPredicate: DonePredicate = () => ({
  satisfied: false,
  missing: Object.freeze(["web_evidence.records.population_pending_phase_3"]),
});
