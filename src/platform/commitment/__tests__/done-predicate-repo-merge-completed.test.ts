import { describe, expect, it } from "vitest";
import { repoMergeCompletedPredicate } from "../done-predicate-repo-merge-completed.js";
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

function mergeRecord(
  overrides: Partial<RepoOperationRecord> = {},
): RepoOperationRecord {
  return Object.freeze({
    repoOperationId: "repo-merge-1",
    kind: "merge_completed",
    commitSha: "deadbee",
    mergeBaseSha: "1234567",
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

describe("repoMergeCompletedPredicate — cutover-4 Phase 4 (high-risk affordance)", () => {
  it("returns satisfied with one evidence fact when a matching merge_completed record is present and listed in delta", () => {
    const ctx = makeCtx(
      Object.freeze({ repo: { records: Object.freeze([mergeRecord()]) } }),
      withDelta(["repo-merge-1"]),
    );
    const result = repoMergeCompletedPredicate(ctx);

    expect(result.satisfied).toBe(true);
    if (result.satisfied) {
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]?.kind).toBe("repo.completed");
      expect(
        (result.evidence[0]?.value as { kind: string }).kind,
      ).toBe("merge_completed");
      expect(
        (result.evidence[0]?.value as { mergeBaseSha?: string }).mergeBaseSha,
      ).toBe("1234567");
    }
  });

  it("returns unsatisfied with `repo.slice_absent` when WorldStateSnapshot lacks the slice", () => {
    const ctx = makeCtx(Object.freeze({}), withDelta(["repo-merge-1"]));
    const result = repoMergeCompletedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["repo.slice_absent"]);
    }
  });

  it("returns unsatisfied with `repo.records.empty` when slice has empty records list", () => {
    const ctx = makeCtx(
      Object.freeze({ repo: { records: Object.freeze([]) } }),
      withDelta(["repo-merge-1"]),
    );
    const result = repoMergeCompletedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["repo.records.empty"]);
    }
  });

  it("returns unsatisfied with `repo.delta_empty` when delta carries no repo.added (Phase 4 forward-compat shim)", () => {
    const ctx = makeCtx(
      Object.freeze({ repo: { records: Object.freeze([mergeRecord()]) } }),
      EMPTY_DELTA,
    );
    const result = repoMergeCompletedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["repo.delta_empty"]);
    }
  });

  it("returns unsatisfied with `repo_record_missing:<id>` when delta references an unknown repoOperationId", () => {
    const ctx = makeCtx(
      Object.freeze({ repo: { records: Object.freeze([mergeRecord()]) } }),
      withDelta(["repo-merge-other"]),
    );
    const result = repoMergeCompletedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["repo_record_missing:repo-merge-other"]);
    }
  });

  it("returns unsatisfied with `repo_record_kind_mismatch:<id>:<expected>:<actual>` when a commit record matches the id", () => {
    const ctx = makeCtx(
      Object.freeze({
        repo: {
          records: Object.freeze([
            mergeRecord({ repoOperationId: "repo-merge-1", kind: "commit_landed" }),
          ]),
        },
      }),
      withDelta(["repo-merge-1"]),
    );
    const result = repoMergeCompletedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual([
        "repo_record_kind_mismatch:repo-merge-1:merge_completed:commit_landed",
      ]);
    }
  });

  it("rejects partial matches when any expected merge is absent", () => {
    const ctx = makeCtx(
      Object.freeze({
        repo: {
          records: Object.freeze([mergeRecord({ repoOperationId: "repo-merge-present" })]),
        },
      }),
      withDelta(["repo-merge-present", "repo-merge-missing"]),
    );
    const result = repoMergeCompletedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["repo_record_missing:repo-merge-missing"]);
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
      stateAfter: Object.freeze({ repo: { records: Object.freeze([mergeRecord()]) } }),
      expectedDelta: withDelta(["repo-merge-1"]),
      receipts: { entries: [] },
      trace: { steps: [] },
    };

    expect(() => repoMergeCompletedPredicate(ctx)).not.toThrow();
    expect(touchedRawText).toBe(false);
  });
});
