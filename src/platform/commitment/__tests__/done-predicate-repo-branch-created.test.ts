import { describe, expect, it } from "vitest";
import { repoBranchCreatedPredicate } from "../done-predicate-repo-branch-created.js";
import type { DonePredicateCtx } from "../affordance.js";
import type { ExpectedDelta } from "../expected-delta.js";
import type { ISO8601 } from "../ids.js";
import type { RepoOperationRecord, WorldStateSnapshot } from "../world-state.js";

const ISO_NOW = "2026-05-07T11:00:00.000Z" as ISO8601;
const EMPTY_DELTA: ExpectedDelta = Object.freeze({});

function makeCtx(
  stateAfter: WorldStateSnapshot,
  expectedDelta: ExpectedDelta = EMPTY_DELTA,
): DonePredicateCtx {
  return {
    stateBefore: Object.freeze({}),
    stateAfter,
    expectedDelta,
    receipts: { entries: [] },
    trace: { steps: [] },
  };
}

function branchRecord(
  overrides: Partial<RepoOperationRecord> = {},
): RepoOperationRecord {
  return Object.freeze({
    repoOperationId: "repo-op-1",
    kind: "branch_created",
    branchName: "feature/cutover4-test",
    repoRoot: "/workspace",
    observedAt: ISO_NOW,
    ...overrides,
  });
}

// `expectedDelta.repo` is widened in Phase 5. The Phase 4 predicate accepts
// the future `added: readonly string[]` shape via a structural cast —
// predicates must NEVER throw on the empty shape (Cutover-3 P4 forward-compat
// shim precedent: `artifacts.delta_empty`).
function withDelta(addedRepoOperationIds: readonly string[]): ExpectedDelta {
  return Object.freeze({
    repo: Object.freeze({
      added: Object.freeze([...addedRepoOperationIds]),
    }),
  } as unknown as ExpectedDelta);
}

describe("repoBranchCreatedPredicate — cutover-4 Phase 4", () => {
  it("returns satisfied with one evidence fact when a matching branch_created record is present and listed in delta", () => {
    const ctx = makeCtx(
      Object.freeze({ repo: { records: Object.freeze([branchRecord()]) } }),
      withDelta(["repo-op-1"]),
    );
    const result = repoBranchCreatedPredicate(ctx);

    expect(result.satisfied).toBe(true);
    if (result.satisfied) {
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]?.kind).toBe("repo.completed");
      expect(
        (result.evidence[0]?.value as { kind: string; repoOperationId: string }).kind,
      ).toBe("branch_created");
      expect(
        (result.evidence[0]?.value as { repoOperationId: string }).repoOperationId,
      ).toBe("repo-op-1");
      expect(
        (result.evidence[0]?.value as { branchName?: string }).branchName,
      ).toBe("feature/cutover4-test");
    }
  });

  it("returns unsatisfied with `repo.slice_absent` when WorldStateSnapshot lacks the slice", () => {
    const ctx = makeCtx(Object.freeze({}), withDelta(["repo-op-1"]));
    const result = repoBranchCreatedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["repo.slice_absent"]);
    }
  });

  it("returns unsatisfied with `repo.records.empty` when slice has empty records list", () => {
    const ctx = makeCtx(
      Object.freeze({ repo: { records: Object.freeze([]) } }),
      withDelta(["repo-op-1"]),
    );
    const result = repoBranchCreatedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["repo.records.empty"]);
    }
  });

  it("returns unsatisfied with `repo.delta_empty` when delta carries no repo.added (Phase 4 forward-compat shim)", () => {
    const ctx = makeCtx(
      Object.freeze({ repo: { records: Object.freeze([branchRecord()]) } }),
      EMPTY_DELTA,
    );
    const result = repoBranchCreatedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["repo.delta_empty"]);
    }
  });

  it("returns unsatisfied with `repo_record_missing:<id>` when delta references an unknown repoOperationId", () => {
    const ctx = makeCtx(
      Object.freeze({ repo: { records: Object.freeze([branchRecord({ repoOperationId: "repo-op-1" })]) } }),
      withDelta(["repo-op-other"]),
    );
    const result = repoBranchCreatedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["repo_record_missing:repo-op-other"]);
    }
  });

  it("returns unsatisfied with `repo_record_kind_mismatch:<id>:<expected>:<actual>` when a different kind matches the id", () => {
    const ctx = makeCtx(
      Object.freeze({
        repo: {
          records: Object.freeze([
            branchRecord({ repoOperationId: "repo-op-1", kind: "commit_landed" }),
          ]),
        },
      }),
      withDelta(["repo-op-1"]),
    );
    const result = repoBranchCreatedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual([
        "repo_record_kind_mismatch:repo-op-1:branch_created:commit_landed",
      ]);
    }
  });

  it("selects the matching branch_created record from a heterogeneous record list (multiple records, only one matches)", () => {
    const ctx = makeCtx(
      Object.freeze({
        repo: {
          records: Object.freeze([
            branchRecord({ repoOperationId: "repo-commit-1", kind: "commit_landed" }),
            branchRecord({ repoOperationId: "repo-diff-1", kind: "diff_observed" }),
            branchRecord({ repoOperationId: "repo-op-1", branchName: "feature/correct" }),
          ]),
        },
      }),
      withDelta(["repo-op-1"]),
    );
    const result = repoBranchCreatedPredicate(ctx);

    expect(result.satisfied).toBe(true);
    if (result.satisfied) {
      expect((result.evidence[0]?.value as { branchName?: string }).branchName).toBe(
        "feature/correct",
      );
    }
  });

  it("does not throw on hostile / sentinel state-before access (invariant #9 sentinel-proxy)", () => {
    let touchedRawText = false;
    const sentinelStateBefore = new Proxy({}, {
      get(_target, prop) {
        if (prop === "rawUserTurn" || prop === "taskContract") {
          touchedRawText = true;
        }
        return undefined;
      },
    }) as WorldStateSnapshot;
    const ctx: DonePredicateCtx = {
      stateBefore: sentinelStateBefore,
      stateAfter: Object.freeze({ repo: { records: Object.freeze([branchRecord()]) } }),
      expectedDelta: withDelta(["repo-op-1"]),
      receipts: { entries: [] },
      trace: { steps: [] },
    };

    // Predicate must never throw and must not touch raw user text.
    expect(() => repoBranchCreatedPredicate(ctx)).not.toThrow();
    expect(touchedRawText).toBe(false);
  });
});
