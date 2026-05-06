import { describe, expect, it } from "vitest";
import { repoCommitLandedPredicate } from "../done-predicate-repo-commit-landed.js";
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

function commitRecord(
  overrides: Partial<RepoOperationRecord> = {},
): RepoOperationRecord {
  return Object.freeze({
    repoOperationId: "repo-commit-1",
    kind: "commit_landed",
    commitSha: "abc1234",
    repoRoot: "/workspace",
    observedAt: ISO_NOW,
    ...overrides,
  });
}

function withDelta(addedRepoOperationIds: readonly string[]): ExpectedDelta {
  return Object.freeze({
    repo: Object.freeze({
      added: Object.freeze([...addedRepoOperationIds]),
    }),
  } as unknown as ExpectedDelta);
}

describe("repoCommitLandedPredicate — cutover-4 Phase 4", () => {
  it("returns satisfied with one evidence fact when a matching commit_landed record is present and listed in delta", () => {
    const ctx = makeCtx(
      Object.freeze({ repo: { records: Object.freeze([commitRecord()]) } }),
      withDelta(["repo-commit-1"]),
    );
    const result = repoCommitLandedPredicate(ctx);

    expect(result.satisfied).toBe(true);
    if (result.satisfied) {
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]?.kind).toBe("repo.completed");
      expect(
        (result.evidence[0]?.value as { kind: string }).kind,
      ).toBe("commit_landed");
      expect(
        (result.evidence[0]?.value as { commitSha?: string }).commitSha,
      ).toBe("abc1234");
    }
  });

  it("returns unsatisfied with `repo.slice_absent` when WorldStateSnapshot lacks the slice", () => {
    const ctx = makeCtx(Object.freeze({}), withDelta(["repo-commit-1"]));
    const result = repoCommitLandedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["repo.slice_absent"]);
    }
  });

  it("returns unsatisfied with `repo.records.empty` when slice has empty records list", () => {
    const ctx = makeCtx(
      Object.freeze({ repo: { records: Object.freeze([]) } }),
      withDelta(["repo-commit-1"]),
    );
    const result = repoCommitLandedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["repo.records.empty"]);
    }
  });

  it("returns unsatisfied with `repo.delta_empty` when delta carries no repo.added (Phase 4 forward-compat shim)", () => {
    const ctx = makeCtx(
      Object.freeze({ repo: { records: Object.freeze([commitRecord()]) } }),
      EMPTY_DELTA,
    );
    const result = repoCommitLandedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["repo.delta_empty"]);
    }
  });

  it("returns unsatisfied with `repo_record_missing:<id>` when delta references an unknown repoOperationId", () => {
    const ctx = makeCtx(
      Object.freeze({ repo: { records: Object.freeze([commitRecord()]) } }),
      withDelta(["repo-commit-other"]),
    );
    const result = repoCommitLandedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["repo_record_missing:repo-commit-other"]);
    }
  });

  it("returns unsatisfied with `repo_record_kind_mismatch:<id>:<expected>:<actual>` when a branch record matches the id", () => {
    const ctx = makeCtx(
      Object.freeze({
        repo: {
          records: Object.freeze([
            commitRecord({ repoOperationId: "repo-commit-1", kind: "branch_created" }),
          ]),
        },
      }),
      withDelta(["repo-commit-1"]),
    );
    const result = repoCommitLandedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual([
        "repo_record_kind_mismatch:repo-commit-1:commit_landed:branch_created",
      ]);
    }
  });

  it("aggregates partial-match failures across multiple delta entries (one missing, one mismatched, one good)", () => {
    const ctx = makeCtx(
      Object.freeze({
        repo: {
          records: Object.freeze([
            commitRecord({ repoOperationId: "repo-commit-good" }),
            commitRecord({ repoOperationId: "repo-commit-mismatch", kind: "diff_observed" }),
          ]),
        },
      }),
      withDelta(["repo-commit-good", "repo-commit-mismatch", "repo-commit-missing"]),
    );
    const result = repoCommitLandedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual([
        "repo_record_kind_mismatch:repo-commit-mismatch:commit_landed:diff_observed",
        "repo_record_missing:repo-commit-missing",
      ]);
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
      stateAfter: Object.freeze({ repo: { records: Object.freeze([commitRecord()]) } }),
      expectedDelta: withDelta(["repo-commit-1"]),
      receipts: { entries: [] },
      trace: { steps: [] },
    };

    expect(() => repoCommitLandedPredicate(ctx)).not.toThrow();
    expect(touchedRawText).toBe(false);
  });
});
