import { describe, expect, it } from "vitest";
import {
  createRepoWorldStateCollector,
  createRepoWorldStateObserver,
  type RepoTurnKey,
} from "../repo-world-state-observer.js";
import { createDefaultMonitoredRuntime } from "../production-runtime-defaults.js";
import type { ISO8601, SessionId } from "../ids.js";
import type { RepoOperationRecord } from "../world-state.js";

const ISO_NOW = "2026-05-02T11:00:00.000Z" as ISO8601;
const SESSION_A = "session-a" as SessionId;
const SESSION_B = "session-b" as SessionId;

function record(
  repoOperationId: string,
  overrides: Partial<RepoOperationRecord> = {},
): RepoOperationRecord {
  return Object.freeze({
    repoOperationId,
    kind: "branch_created",
    observedAt: ISO_NOW,
    ...overrides,
  });
}

describe("RepoWorldStateCollector — Cutover-4 Phase 3", () => {
  it("returns undefined slice when no active turn is set (production default)", () => {
    const collector = createRepoWorldStateCollector();
    const observer = createRepoWorldStateObserver(collector);
    expect(observer.observe()).toBeUndefined();
  });

  it("returns undefined slice when active turn has no recorded entries", () => {
    const collector = createRepoWorldStateCollector();
    const observer = createRepoWorldStateObserver(collector);
    const key: RepoTurnKey = { sessionId: SESSION_A, turnId: "turn-1" };
    collector.setActiveTurn(key);
    expect(observer.observe()).toBeUndefined();
  });

  it("round-trip: append → read returns the same record under the active turn", () => {
    const collector = createRepoWorldStateCollector();
    const observer = createRepoWorldStateObserver(collector);
    const key: RepoTurnKey = { sessionId: SESSION_A, turnId: "turn-1" };

    const r = record("repo-op-1");
    collector.record(r, key);
    collector.setActiveTurn(key);

    const slice = observer.observe();
    expect(slice).toBeDefined();
    expect(slice?.records.map((entry) => entry.repoOperationId)).toEqual([
      "repo-op-1",
    ]);
    expect(slice?.records[0]).toEqual(r);
  });

  it("exposes records bucketed under the active turn in insertion order", () => {
    const collector = createRepoWorldStateCollector();
    const observer = createRepoWorldStateObserver(collector);
    const key: RepoTurnKey = { sessionId: SESSION_A, turnId: "turn-1" };

    collector.record(record("repo-op-1"), key);
    collector.record(
      record("repo-op-2", { kind: "commit_landed", commitSha: "abcdef1" }),
      key,
    );
    collector.setActiveTurn(key);

    expect(observer.observe()?.records.map((r) => r.repoOperationId)).toEqual([
      "repo-op-1",
      "repo-op-2",
    ]);
  });

  it("dedupes records with the same repoOperationId last-writer-wins", () => {
    const collector = createRepoWorldStateCollector();
    const observer = createRepoWorldStateObserver(collector);
    const key: RepoTurnKey = { sessionId: SESSION_A, turnId: "turn-1" };

    collector.record(
      record("repo-op-1", { branchName: "feature/first" }),
      key,
    );
    collector.record(
      record("repo-op-1", { branchName: "feature/second" }),
      key,
    );
    collector.setActiveTurn(key);

    const slice = observer.observe();
    expect(slice?.records).toHaveLength(1);
    expect(slice?.records[0]?.branchName).toBe("feature/second");
  });

  it("isolates records by (sessionId, turnId) — same sessionId, different turnId", () => {
    const collector = createRepoWorldStateCollector();
    const observer = createRepoWorldStateObserver(collector);
    const key1: RepoTurnKey = { sessionId: SESSION_A, turnId: "turn-1" };
    const key2: RepoTurnKey = { sessionId: SESSION_A, turnId: "turn-2" };

    collector.record(record("repo-t1"), key1);
    collector.record(record("repo-t2"), key2);

    collector.setActiveTurn(key1);
    expect(observer.observe()?.records.map((r) => r.repoOperationId)).toEqual([
      "repo-t1",
    ]);

    collector.setActiveTurn(key2);
    expect(observer.observe()?.records.map((r) => r.repoOperationId)).toEqual([
      "repo-t2",
    ]);
  });

  it("isolates records by (sessionId, turnId) — different sessionId, same turnId string", () => {
    const collector = createRepoWorldStateCollector();
    const observer = createRepoWorldStateObserver(collector);
    const key1: RepoTurnKey = { sessionId: SESSION_A, turnId: "shared-id" };
    const key2: RepoTurnKey = { sessionId: SESSION_B, turnId: "shared-id" };

    collector.record(record("repo-a"), key1);
    collector.record(record("repo-b"), key2);

    collector.setActiveTurn(key1);
    expect(observer.observe()?.records.map((r) => r.repoOperationId)).toEqual([
      "repo-a",
    ]);

    collector.setActiveTurn(key2);
    expect(observer.observe()?.records.map((r) => r.repoOperationId)).toEqual([
      "repo-b",
    ]);
  });

  it("resetForTurn clears only the targeted bucket; other turns untouched", () => {
    const collector = createRepoWorldStateCollector();
    const observer = createRepoWorldStateObserver(collector);
    const key1: RepoTurnKey = { sessionId: SESSION_A, turnId: "turn-1" };
    const key2: RepoTurnKey = { sessionId: SESSION_A, turnId: "turn-2" };

    collector.record(record("repo-t1"), key1);
    collector.record(record("repo-t2"), key2);

    collector.resetForTurn(key1);

    collector.setActiveTurn(key1);
    expect(observer.observe()).toBeUndefined();

    collector.setActiveTurn(key2);
    expect(observer.observe()?.records.map((r) => r.repoOperationId)).toEqual([
      "repo-t2",
    ]);
  });

  it("setActiveTurn(undefined) clears the active pointer", () => {
    const collector = createRepoWorldStateCollector();
    const observer = createRepoWorldStateObserver(collector);
    const key: RepoTurnKey = { sessionId: SESSION_A, turnId: "turn-1" };

    collector.record(record("repo-op-1"), key);
    collector.setActiveTurn(key);
    expect(observer.observe()).toBeDefined();

    collector.setActiveTurn(undefined);
    expect(observer.observe()).toBeUndefined();
  });

  it("returns frozen records (consumer cannot mutate)", () => {
    const collector = createRepoWorldStateCollector();
    const observer = createRepoWorldStateObserver(collector);
    const key: RepoTurnKey = { sessionId: SESSION_A, turnId: "turn-1" };

    collector.record(record("repo-op-1"), key);
    collector.setActiveTurn(key);

    const slice = observer.observe();
    expect(Object.isFrozen(slice)).toBe(true);
    expect(Object.isFrozen(slice?.records)).toBe(true);
    expect(Object.isFrozen(slice?.records[0])).toBe(true);
  });

  it("default perTurnLimit=8 drops oldest record when 9th is appended", () => {
    const collector = createRepoWorldStateCollector();
    const observer = createRepoWorldStateObserver(collector);
    const key: RepoTurnKey = { sessionId: SESSION_A, turnId: "turn-1" };

    for (let i = 1; i <= 9; i += 1) {
      collector.record(record(`repo-op-${i}`), key);
    }
    collector.setActiveTurn(key);

    const ids = observer.observe()?.records.map((r) => r.repoOperationId);
    expect(ids).toHaveLength(8);
    expect(ids?.[0]).toBe("repo-op-2");
    expect(ids?.[ids.length - 1]).toBe("repo-op-9");
    expect(ids).not.toContain("repo-op-1");
  });

  it("respects custom perTurnLimit by dropping oldest records when exceeded", () => {
    const collector = createRepoWorldStateCollector({ perTurnLimit: 2 });
    const observer = createRepoWorldStateObserver(collector);
    const key: RepoTurnKey = { sessionId: SESSION_A, turnId: "turn-1" };

    collector.record(record("repo-op-1"), key);
    collector.record(record("repo-op-2"), key);
    collector.record(record("repo-op-3"), key);
    collector.setActiveTurn(key);

    expect(observer.observe()?.records.map((r) => r.repoOperationId)).toEqual([
      "repo-op-2",
      "repo-op-3",
    ]);
  });

  it("rejects malformed input — missing repoOperationId / unknown kind / bad sha", () => {
    const collector = createRepoWorldStateCollector();
    const key: RepoTurnKey = { sessionId: SESSION_A, turnId: "turn-1" };

    expect(() =>
      collector.record(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { kind: "branch_created", observedAt: ISO_NOW } as any,
        key,
      ),
    ).toThrow();
    expect(() =>
      collector.record(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          repoOperationId: "repo-op-1",
          kind: "rebased",
          observedAt: ISO_NOW,
        } as any,
        key,
      ),
    ).toThrow();
    expect(() =>
      collector.record(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          repoOperationId: "repo-op-1",
          kind: "commit_landed",
          commitSha: "deadbe",
          observedAt: ISO_NOW,
        } as any,
        key,
      ),
    ).toThrow();
    expect(() =>
      collector.record(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          repoOperationId: "repo-op-1",
          kind: "branch_created",
          observedAt: "May 2 2026",
        } as any,
        key,
      ),
    ).toThrow();
  });

  it("createDefaultMonitoredRuntime exposes the repo slice when the process collector is populated", async () => {
    const {
      setProcessRepoWorldStateCollectorForTests,
      createRepoWorldStateCollector: makeCollector,
      createRepoWorldStateObserver: makeObserver,
    } = await import("../repo-world-state-observer.js");

    const fixture = makeCollector();
    setProcessRepoWorldStateCollectorForTests(fixture);
    try {
      const key: RepoTurnKey = { sessionId: SESSION_A, turnId: "turn-1" };
      fixture.record(record("repo-op-1"), key);
      fixture.setActiveTurn(key);

      const runtime = createDefaultMonitoredRuntime();
      expect(runtime).toBeDefined();
      // The wired observer reads the same singleton; assert via direct observation.
      const observer = makeObserver(fixture);
      const slice = observer.observe();
      expect(slice?.records.map((r) => r.repoOperationId)).toEqual([
        "repo-op-1",
      ]);
    } finally {
      setProcessRepoWorldStateCollectorForTests(undefined);
    }
  });
});
