import { type DeliveryContext, deliveryContextKey } from "../utils/delivery-context.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function resolveControllerSessionKey(entry: SubagentRunRecord): string {
  return entry.controllerSessionKey?.trim() || entry.requesterSessionKey;
}

/**
 * Finds the latest active persistent-session subagent run with a matching
 * label and origin context.
 *
 * Idempotency guard for the `persistent_session.created` commitment effect:
 * a follow-up spawn with the same label in the same delivery origin should
 * reuse the existing live session rather than create a duplicate.
 *
 * @param runs - Read-only snapshot of the subagent runs registry.
 * @param label - Trimmed user-visible label requested by the spawn caller.
 * @param origin - Delivery context of the requester (channel/account/to/threadId).
 * @returns The latest active matching run, or undefined when no live session matches.
 *
 * @deprecated Use `findLivePersistentSessionByLabel`
 *   (`src/agents/subagent-persistent-session-query.ts`). The runs-based
 *   detection here filters on `endedAt === undefined`, which the real TG
 *   spawn flow toggles to a number after the LLM turn ends — even when the
 *   persistent session itself is still alive in the gateway store (Gap G3,
 *   `commitment_kernel_idempotency_fix.plan.md` §1). Kept during the PR-4
 *   migration window for legacy query tests; will be removed alongside the
 *   wrapper `findActiveSubagentByLabel` in the post-PR-4b cleanup PR.
 */
export function findActiveSubagentByLabelFromRuns(
  runs: Map<string, SubagentRunRecord>,
  label: string,
  origin: DeliveryContext | undefined,
): SubagentRunRecord | undefined {
  const trimmedLabel = label.trim();
  if (!trimmedLabel) {
    return undefined;
  }
  const targetOriginKey = deliveryContextKey(origin);
  let latest: SubagentRunRecord | undefined;
  for (const entry of runs.values()) {
    if (entry.label !== trimmedLabel) {
      continue;
    }
    if (entry.spawnMode !== "session") {
      continue;
    }
    if (typeof entry.endedAt === "number") {
      continue;
    }
    if (targetOriginKey !== undefined) {
      const entryOriginKey = deliveryContextKey(entry.requesterOrigin);
      if (entryOriginKey !== targetOriginKey) {
        continue;
      }
    }
    if (!latest || entry.createdAt > latest.createdAt) {
      latest = entry;
    }
  }
  return latest;
}

export function findRunIdsByChildSessionKeyFromRuns(
  runs: Map<string, SubagentRunRecord>,
  childSessionKey: string,
): string[] {
  const key = childSessionKey.trim();
  if (!key) {
    return [];
  }
  const runIds: string[] = [];
  for (const [runId, entry] of runs.entries()) {
    if (entry.childSessionKey === key) {
      runIds.push(runId);
    }
  }
  return runIds;
}

export function listRunsForRequesterFromRuns(
  runs: Map<string, SubagentRunRecord>,
  requesterSessionKey: string,
  options?: {
    requesterRunId?: string;
  },
): SubagentRunRecord[] {
  const key = requesterSessionKey.trim();
  if (!key) {
    return [];
  }

  const requesterRunId = options?.requesterRunId?.trim();
  const requesterRun = requesterRunId ? runs.get(requesterRunId) : undefined;
  const requesterRunMatchesScope =
    requesterRun && requesterRun.childSessionKey === key ? requesterRun : undefined;
  const lowerBound = requesterRunMatchesScope?.startedAt ?? requesterRunMatchesScope?.createdAt;
  const upperBound = requesterRunMatchesScope?.endedAt;

  return [...runs.values()].filter((entry) => {
    if (entry.requesterSessionKey !== key) {
      return false;
    }
    if (typeof lowerBound === "number" && entry.createdAt < lowerBound) {
      return false;
    }
    if (typeof upperBound === "number" && entry.createdAt > upperBound) {
      return false;
    }
    return true;
  });
}

export function listRunsForControllerFromRuns(
  runs: Map<string, SubagentRunRecord>,
  controllerSessionKey: string,
): SubagentRunRecord[] {
  const key = controllerSessionKey.trim();
  if (!key) {
    return [];
  }
  return [...runs.values()].filter((entry) => resolveControllerSessionKey(entry) === key);
}

function findLatestRunForChildSession(
  runs: Map<string, SubagentRunRecord>,
  childSessionKey: string,
): SubagentRunRecord | undefined {
  const key = childSessionKey.trim();
  if (!key) {
    return undefined;
  }
  let latest: SubagentRunRecord | undefined;
  for (const entry of runs.values()) {
    if (entry.childSessionKey !== key) {
      continue;
    }
    if (!latest || entry.createdAt > latest.createdAt) {
      latest = entry;
    }
  }
  return latest;
}

export function resolveRequesterForChildSessionFromRuns(
  runs: Map<string, SubagentRunRecord>,
  childSessionKey: string,
): {
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
} | null {
  const latest = findLatestRunForChildSession(runs, childSessionKey);
  if (!latest) {
    return null;
  }
  return {
    requesterSessionKey: latest.requesterSessionKey,
    requesterOrigin: latest.requesterOrigin,
  };
}

export function shouldIgnorePostCompletionAnnounceForSessionFromRuns(
  runs: Map<string, SubagentRunRecord>,
  childSessionKey: string,
): boolean {
  const latest = findLatestRunForChildSession(runs, childSessionKey);
  return Boolean(
    latest &&
    latest.spawnMode !== "session" &&
    typeof latest.endedAt === "number" &&
    typeof latest.cleanupCompletedAt === "number" &&
    latest.cleanupCompletedAt >= latest.endedAt,
  );
}

export function countActiveRunsForSessionFromRuns(
  runs: Map<string, SubagentRunRecord>,
  controllerSessionKey: string,
): number {
  const key = controllerSessionKey.trim();
  if (!key) {
    return 0;
  }

  const pendingDescendantCache = new Map<string, number>();
  const pendingDescendantCount = (sessionKey: string) => {
    if (pendingDescendantCache.has(sessionKey)) {
      return pendingDescendantCache.get(sessionKey) ?? 0;
    }
    const pending = countPendingDescendantRunsInternal(runs, sessionKey);
    pendingDescendantCache.set(sessionKey, pending);
    return pending;
  };

  let count = 0;
  for (const entry of runs.values()) {
    if (resolveControllerSessionKey(entry) !== key) {
      continue;
    }
    if (typeof entry.endedAt !== "number") {
      count += 1;
      continue;
    }
    if (pendingDescendantCount(entry.childSessionKey) > 0) {
      count += 1;
    }
  }
  return count;
}

function forEachDescendantRun(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
  visitor: (runId: string, entry: SubagentRunRecord) => void,
): boolean {
  const root = rootSessionKey.trim();
  if (!root) {
    return false;
  }
  const pending = [root];
  const visited = new Set<string>([root]);
  for (let index = 0; index < pending.length; index += 1) {
    const requester = pending[index];
    if (!requester) {
      continue;
    }
    for (const [runId, entry] of runs.entries()) {
      if (entry.requesterSessionKey !== requester) {
        continue;
      }
      visitor(runId, entry);
      const childKey = entry.childSessionKey.trim();
      if (!childKey || visited.has(childKey)) {
        continue;
      }
      visited.add(childKey);
      pending.push(childKey);
    }
  }
  return true;
}

export function countActiveDescendantRunsFromRuns(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
): number {
  let count = 0;
  if (
    !forEachDescendantRun(runs, rootSessionKey, (_runId, entry) => {
      if (typeof entry.endedAt !== "number") {
        count += 1;
      }
    })
  ) {
    return 0;
  }
  return count;
}

function countPendingDescendantRunsInternal(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
  excludeRunId?: string,
): number {
  const excludedRunId = excludeRunId?.trim();
  let count = 0;
  if (
    !forEachDescendantRun(runs, rootSessionKey, (runId, entry) => {
      const runEnded = typeof entry.endedAt === "number";
      const cleanupCompleted = typeof entry.cleanupCompletedAt === "number";
      if ((!runEnded || !cleanupCompleted) && runId !== excludedRunId) {
        count += 1;
      }
    })
  ) {
    return 0;
  }
  return count;
}

export function countPendingDescendantRunsFromRuns(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
): number {
  return countPendingDescendantRunsInternal(runs, rootSessionKey);
}

export function countPendingDescendantRunsExcludingRunFromRuns(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
  excludeRunId: string,
): number {
  return countPendingDescendantRunsInternal(runs, rootSessionKey, excludeRunId);
}

export function listDescendantRunsForRequesterFromRuns(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
): SubagentRunRecord[] {
  const descendants: SubagentRunRecord[] = [];
  if (
    !forEachDescendantRun(runs, rootSessionKey, (_runId, entry) => {
      descendants.push(entry);
    })
  ) {
    return [];
  }
  return descendants;
}
