import type { DonePredicate, EvidenceFact } from "./affordance.js";
import type { ExpectedDelta } from "./expected-delta.js";
import type { RepoOperationRecord } from "./world-state.js";

/**
 * Verifies that the runtime adapter (Phase 5) recorded a `branch_created`
 * repo operation whose `repoOperationId` was emitted via the commitment's
 * `expectedDelta.repo.added` list. The predicate observes only
 * `state`/`delta`/`receipts`/`trace` per invariant #9; raw user text and
 * `TaskContract` are NOT read.
 *
 * Phase 4 wiring: reads `ctx.stateAfter.repo?.records` only. Population of
 * the slice is a Phase 3 observer concern (`RepoWorldStateObserver`); emit
 * is a Phase 5 runtime-adapter concern (`repo-runtime-adapter.ts`); this
 * predicate is observation-only.
 *
 * `expectedDelta.repo.added` is widened in Phase 5 (Cutover-3 P4 forward-
 * compat shim precedent). For Phase 4 the predicate accepts the future
 * `added: readonly string[]` shape via a structural cast — predicates must
 * NEVER throw on the empty shape and emit a closed-string sentinel until
 * Phase 5 wiring.
 *
 * Closed missing-key set:
 *  - `repo.slice_absent` — `RepoWorldState` slice missing.
 *  - `repo.records.empty` — slice present but no records observed.
 *  - `repo.delta_empty` — `expectedDelta.repo.added` is absent or empty
 *    (Phase 5 runtime adapter populates this).
 *  - `repo_record_missing:<id>` — record with matching `repoOperationId`
 *    not found in observed slice.
 *  - `repo_record_kind_mismatch:<id>:<expected>:<actual>` — record found
 *    but kind differs from the affordance's expected kind.
 *
 * @param ctx - Predicate context with state snapshots, expected delta,
 *   receipts, and trace.
 * @returns Satisfied with one `repo.completed` evidence fact per matched
 *   record; otherwise `unsatisfied` with closed-string missing keys.
 */
export const repoBranchCreatedPredicate: DonePredicate = (ctx) => {
  return evaluateRepoPredicate(ctx, "branch_created");
};

type RepoExpectedDelta = {
  readonly added?: readonly string[];
};

/**
 * Reads the forward-compat `repo.added` slice from `ExpectedDelta` without
 * widening the frozen-layer type. Returns the closed list of repo operation
 * ids the runtime adapter (Phase 5) will emit, or `undefined` when the
 * caller supplied no shim payload.
 */
function readRepoExpectedDelta(
  expectedDelta: ExpectedDelta,
): RepoExpectedDelta | undefined {
  const repo = (expectedDelta as { repo?: RepoExpectedDelta }).repo;
  return repo;
}

/**
 * Shared evaluator for the four repo done-predicates. Each predicate fixes
 * the expected `kind` (branch_created / commit_landed / merge_completed /
 * diff_observed) and reuses the closed missing-key set defined above. Pulled
 * out so the four sibling files do not drift on sentinel strings.
 */
function evaluateRepoPredicate(
  ctx: Parameters<DonePredicate>[0],
  expectedKind: RepoOperationRecord["kind"],
): ReturnType<DonePredicate> {
  const records = ctx.stateAfter.repo?.records;
  if (records === undefined) {
    return {
      satisfied: false,
      missing: Object.freeze(["repo.slice_absent"]),
    };
  }
  if (records.length === 0) {
    return {
      satisfied: false,
      missing: Object.freeze(["repo.records.empty"]),
    };
  }

  const repoDelta = readRepoExpectedDelta(ctx.expectedDelta);
  const expectedAdded = repoDelta?.added ?? [];
  if (expectedAdded.length === 0) {
    return {
      satisfied: false,
      missing: Object.freeze(["repo.delta_empty"]),
    };
  }

  const recordsById = new Map<string, RepoOperationRecord>();
  for (const record of records) {
    if (record && typeof record.repoOperationId === "string") {
      recordsById.set(record.repoOperationId, record);
    }
  }

  const missing: string[] = [];
  const evidence: EvidenceFact[] = [];
  for (const repoOperationId of expectedAdded) {
    const record = recordsById.get(repoOperationId);
    if (!record) {
      missing.push(`repo_record_missing:${repoOperationId}`);
      continue;
    }
    if (record.kind !== expectedKind) {
      missing.push(
        `repo_record_kind_mismatch:${repoOperationId}:${expectedKind}:${record.kind}`,
      );
      continue;
    }
    evidence.push({
      kind: "repo.completed",
      value: Object.freeze({
        repoOperationId: record.repoOperationId,
        kind: record.kind,
        branchName: record.branchName,
        commitSha: record.commitSha,
        baseSha: record.baseSha,
        mergeBaseSha: record.mergeBaseSha,
        filesChanged: record.filesChanged,
        insertions: record.insertions,
        deletions: record.deletions,
        repoRoot: record.repoRoot,
        observedAt: record.observedAt,
      }),
    });
  }

  return missing.length === 0
    ? { satisfied: true, evidence: Object.freeze(evidence) }
    : { satisfied: false, missing: Object.freeze(missing) };
}

export { evaluateRepoPredicate };
