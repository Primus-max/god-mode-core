import type { DonePredicate } from "./affordance.js";
import { evaluateRepoPredicate } from "./done-predicate-repo-branch-created.js";

/**
 * Verifies that the runtime adapter (Phase 5) recorded a `diff_observed`
 * repo operation whose `repoOperationId` was emitted via the commitment's
 * `expectedDelta.repo.added` list. Risk-tier `low` on this affordance —
 * read-only `git diff` invocation, the only repo affordance that permits a
 * single retry on transient failure (`defaultBudgets.maxRetries=1`).
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
export const repoDiffObservedPredicate: DonePredicate = (ctx) => {
  return evaluateRepoPredicate(ctx, "diff_observed");
};
