import type { DonePredicate } from "./affordance.js";
import { evaluateRepoPredicate } from "./done-predicate-repo-branch-created.js";

/**
 * Verifies that the runtime adapter (Phase 5) recorded a `merge_completed`
 * repo operation whose `repoOperationId` was emitted via the commitment's
 * `expectedDelta.repo.added` list. Risk-tier `high` on this affordance —
 * Phase 6 PolicyGate Stage 4 enforces the `maintainer` role on protected
 * branches before this predicate ever runs.
 *
 * Mirrors `repoBranchCreatedPredicate` (slice cutover-4 Phase 4) — see that
 * file for the closed missing-key set rationale and forward-compat shim
 * documentation.
 *
 * @param ctx - Predicate context with state snapshots, expected delta,
 *   receipts, and trace.
 * @returns Satisfied with one `repo.completed` evidence fact per matched
 *   record; otherwise `unsatisfied` with closed-string missing keys.
 */
export const repoMergeCompletedPredicate: DonePredicate = (ctx) => {
  return evaluateRepoPredicate(ctx, "merge_completed");
};
