import { describe, expect, it } from "vitest";
import { repoDiffObservedPredicate } from "../done-predicate-repo-diff-observed.js";
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

function diffRecord(
  overrides: Partial<RepoOperationRecord> = {},
): RepoOperationRecord {
  return Object.freeze({
    repoOperationId: "repo-diff-1",
    kind: "diff_observed",
    baseSha: "1111111",
    commitSha: "2222222",
    filesChanged: 3,
    insertions: 12,
    deletions: 4,
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

describe("repoDiffObservedPredicate — cutover-4 Phase 4 (read-only affordance)", () => {
  it("returns satisfied with one evidence fact when a matching diff_observed record is present and listed in delta", () => {
    const ctx = makeCtx(
      Object.freeze({ repo: { records: Object.freeze([diffRecord()]) } }),
      withDelta(["repo-diff-1"]),
    );
    const result = repoDiffObservedPredicate(ctx);

    expect(result.satisfied).toBe(true);
    if (result.satisfied) {
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]?.kind).toBe("repo.completed");
      expect(
        (result.evidence[0]?.value as { kind: string }).kind,
      ).toBe("diff_observed");
      expect(
        (result.evidence[0]?.value as { filesChanged?: number }).filesChanged,
      ).toBe(3);
      expect(
        (result.evidence[0]?.value as { insertions?: number }).insertions,
      ).toBe(12);
      expect(
        (result.evidence[0]?.value as { deletions?: number }).deletions,
      ).toBe(4);
    }
  });

  it("returns unsatisfied with `repo.slice_absent` when WorldStateSnapshot lacks the slice", () => {
    const ctx = makeCtx(Object.freeze({}), withDelta(["repo-diff-1"]));
    const result = repoDiffObservedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["repo.slice_absent"]);
    }
  });

  it("returns unsatisfied with `repo.records.empty` when slice has empty records list", () => {
    const ctx = makeCtx(
      Object.freeze({ repo: { records: Object.freeze([]) } }),
      withDelta(["repo-diff-1"]),
    );
    const result = repoDiffObservedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["repo.records.empty"]);
    }
  });

  it("returns unsatisfied with `repo.delta_empty` when delta carries no repo.added (Phase 4 forward-compat shim)", () => {
    const ctx = makeCtx(
      Object.freeze({ repo: { records: Object.freeze([diffRecord()]) } }),
      EMPTY_DELTA,
    );
    const result = repoDiffObservedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["repo.delta_empty"]);
    }
  });

  it("returns unsatisfied with `repo_record_missing:<id>` when delta references an unknown repoOperationId", () => {
    const ctx = makeCtx(
      Object.freeze({ repo: { records: Object.freeze([diffRecord()]) } }),
      withDelta(["repo-diff-other"]),
    );
    const result = repoDiffObservedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["repo_record_missing:repo-diff-other"]);
    }
  });

  it("returns unsatisfied with `repo_record_kind_mismatch:<id>:<expected>:<actual>` when a merge record matches the id", () => {
    const ctx = makeCtx(
      Object.freeze({
        repo: {
          records: Object.freeze([
            diffRecord({ repoOperationId: "repo-diff-1", kind: "merge_completed" }),
          ]),
        },
      }),
      withDelta(["repo-diff-1"]),
    );
    const result = repoDiffObservedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual([
        "repo_record_kind_mismatch:repo-diff-1:diff_observed:merge_completed",
      ]);
    }
  });

  it("selects the matching diff_observed record from a heterogeneous record list", () => {
    const ctx = makeCtx(
      Object.freeze({
        repo: {
          records: Object.freeze([
            diffRecord({ repoOperationId: "repo-branch-1", kind: "branch_created" }),
            diffRecord({ repoOperationId: "repo-merge-1", kind: "merge_completed" }),
            diffRecord({ repoOperationId: "repo-diff-1", filesChanged: 99 }),
          ]),
        },
      }),
      withDelta(["repo-diff-1"]),
    );
    const result = repoDiffObservedPredicate(ctx);

    expect(result.satisfied).toBe(true);
    if (result.satisfied) {
      expect((result.evidence[0]?.value as { filesChanged?: number }).filesChanged).toBe(99);
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
      stateAfter: Object.freeze({ repo: { records: Object.freeze([diffRecord()]) } }),
      expectedDelta: withDelta(["repo-diff-1"]),
      receipts: { entries: [] },
      trace: { steps: [] },
    };

    expect(() => repoDiffObservedPredicate(ctx)).not.toThrow();
    expect(touchedRawText).toBe(false);
  });
});
