import { describe, expect, it } from "vitest";
import type { SubagentRunRecord } from "../../../agents/subagent-registry.types.js";
import {
  buildSessionWorldStateFromRuns,
  createSessionWorldStateObserverFromSnapshotSource,
} from "../session-world-state-observer.js";

function makeRun(overrides: Partial<SubagentRunRecord>): SubagentRunRecord {
  return {
    runId: overrides.runId ?? "run-1",
    childSessionKey: overrides.childSessionKey ?? "agent:worker:main",
    requesterSessionKey: overrides.requesterSessionKey ?? "agent:main:main",
    requesterDisplayKey: overrides.requesterDisplayKey ?? "main",
    task: overrides.task ?? "spawn worker",
    cleanup: overrides.cleanup ?? "keep",
    createdAt: overrides.createdAt ?? Date.UTC(2026, 3, 27, 8, 0, 0),
    ...overrides,
  };
}

describe("session world state observer", () => {
  it("maps subagent runs into deterministic followup registry records", () => {
    const runs = new Map<string, SubagentRunRecord>([
      [
        "run-later",
        makeRun({
          runId: "run-later",
          childSessionKey: "agent:reviewer:main",
          requesterSessionKey: "agent:main:main",
          createdAt: Date.UTC(2026, 3, 27, 8, 2, 0),
          endedAt: Date.UTC(2026, 3, 27, 8, 12, 0),
        }),
      ],
      [
        "run-earlier",
        makeRun({
          runId: "run-earlier",
          childSessionKey: "agent:builder:main",
          requesterSessionKey: "agent:main:thread:abc",
          createdAt: Date.UTC(2026, 3, 27, 8, 1, 0),
        }),
      ],
    ]);

    expect(buildSessionWorldStateFromRuns(runs)).toEqual({
      followupRegistry: [
        {
          sessionId: "agent:builder:main",
          agentId: "builder",
          parentSessionKey: "agent:main:thread:abc",
          status: "active",
          createdAt: "2026-04-27T08:01:00.000Z",
        },
        {
          sessionId: "agent:reviewer:main",
          agentId: "reviewer",
          parentSessionKey: "agent:main:main",
          status: "closed",
          createdAt: "2026-04-27T08:02:00.000Z",
        },
      ],
    });
  });

  it("uses sessionStartedAt as the stable session creation time when present", () => {
    const runs = new Map<string, SubagentRunRecord>([
      [
        "run-retry",
        makeRun({
          runId: "run-retry",
          childSessionKey: "agent:retry:main",
          createdAt: Date.UTC(2026, 3, 27, 8, 10, 0),
          sessionStartedAt: Date.UTC(2026, 3, 27, 8, 0, 0),
        }),
      ],
    ]);

    expect(buildSessionWorldStateFromRuns(runs).followupRegistry[0]?.createdAt).toBe(
      "2026-04-27T08:00:00.000Z",
    );
  });

  it("reads a fresh snapshot from the injected source on every observe call", () => {
    const runs = new Map<string, SubagentRunRecord>();
    const observer = createSessionWorldStateObserverFromSnapshotSource(() => new Map(runs));

    expect(observer.observe().followupRegistry).toEqual([]);

    runs.set(
      "run-added",
      makeRun({
        runId: "run-added",
        childSessionKey: "agent:added:main",
        createdAt: Date.UTC(2026, 3, 27, 8, 3, 0),
      }),
    );

    expect(observer.observe().followupRegistry).toEqual([
      {
        sessionId: "agent:added:main",
        agentId: "added",
        parentSessionKey: "agent:main:main",
        status: "active",
        createdAt: "2026-04-27T08:03:00.000Z",
      },
    ]);
  });
});
