import type { SubagentRunRecord } from "../../agents/subagent-registry.types.js";
import { getSubagentRunsSnapshotForRead } from "../../agents/subagent-registry-state.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { AgentId, ISO8601, SessionId, SessionKey } from "./ids.js";
import type { SessionRecord, SessionWorldState } from "./world-state.js";

export interface SessionWorldStateObserver {
  /**
   * Reads a deterministic snapshot of the persistent-session followup registry.
   *
   * @returns Read-only `SessionWorldState` derived from runtime-attested storage.
   */
  observe(): SessionWorldState;
}

export type SubagentRunsSnapshotSource = () => ReadonlyMap<string, SubagentRunRecord>;

/**
 * Maps subagent registry runs into pure SessionRecord values.
 *
 * @param runsSnapshot - Read-only snapshot from the subagent registry state.
 * @returns Frozen `SessionWorldState` with deterministic ordering by creation time.
 */
export function buildSessionWorldStateFromRuns(
  runsSnapshot: ReadonlyMap<string, SubagentRunRecord>,
): SessionWorldState {
  const records = [...runsSnapshot.values()]
    .map((run): SessionRecord => {
      const createdAtMs = run.sessionStartedAt ?? run.createdAt;
      return Object.freeze({
        sessionId: run.childSessionKey as SessionId,
        agentId: resolveAgentIdFromSessionKey(run.childSessionKey) as AgentId,
        parentSessionKey: run.requesterSessionKey as SessionKey,
        status: typeof run.endedAt === "number" ? "closed" : "active",
        createdAt: new Date(createdAtMs).toISOString() as ISO8601,
      });
    })
    .sort((left, right) => {
      const byCreatedAt = Date.parse(left.createdAt) - Date.parse(right.createdAt);
      if (byCreatedAt !== 0) {
        return byCreatedAt;
      }
      return left.sessionId.localeCompare(right.sessionId);
    });

  return Object.freeze({
    followupRegistry: Object.freeze(records),
  });
}

/**
 * Creates a read-only observer over the subagent registry state.
 *
 * @param inMemoryRuns - Runtime subagent runs map used as the authoritative in-process source.
 * @returns Observer that reads a fresh merged snapshot on every call.
 */
export function createSessionWorldStateObserver(
  inMemoryRuns: Map<string, SubagentRunRecord>,
): SessionWorldStateObserver {
  return createSessionWorldStateObserverFromSnapshotSource(() =>
    getSubagentRunsSnapshotForRead(inMemoryRuns),
  );
}

/**
 * Creates a read-only observer from an injectable snapshot source.
 *
 * @param snapshotSource - Function returning the current subagent runs snapshot.
 * @returns Observer that maps the snapshot into `SessionWorldState`.
 */
export function createSessionWorldStateObserverFromSnapshotSource(
  snapshotSource: SubagentRunsSnapshotSource,
): SessionWorldStateObserver {
  return Object.freeze({
    observe(): SessionWorldState {
      return buildSessionWorldStateFromRuns(snapshotSource());
    },
  });
}
