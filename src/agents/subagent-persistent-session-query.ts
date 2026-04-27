import type { SessionEntry } from "../config/sessions.js";
import {
  type DeliveryContext,
  deliveryContextFromSession,
  deliveryContextKey,
} from "../utils/delivery-context.js";

export type LivePersistentSessionMatch = {
  key: string;
  entry: SessionEntry;
};

/**
 * Parses a normalized subagent session key into its agentId and uuid parts.
 *
 * Subagent session keys carry the canonical shape `agent:<agentId>:subagent:<uuid>`
 * (see `subagent-spawn.ts`). Any other shape — main sessions, group keys, the
 * synthetic `global` / `unknown` keys — is rejected.
 *
 * @param key Raw session-store key (already lowercased by the store layer).
 * @returns `{ agentId, uuid }` on a valid subagent key, otherwise `undefined`.
 */
function parseSubagentKey(key: string): { agentId: string; uuid: string } | undefined {
  const parts = key.split(":");
  if (parts.length !== 4) {
    return undefined;
  }
  const [scheme, agentId, kind, uuid] = parts;
  if (scheme !== "agent" || kind !== "subagent") {
    return undefined;
  }
  if (!agentId || !uuid) {
    return undefined;
  }
  return { agentId, uuid };
}

/**
 * Finds a live persistent subagent session by user-visible label and origin.
 *
 * Idempotency guard for the `persistent_session.created` commitment effect:
 * a follow-up spawn with the same label in the same delivery origin must
 * reuse the existing persistent session rather than create a duplicate.
 *
 * Liveness detection (Variant A — see commitment_kernel_idempotency_fix.plan.md §2.1):
 *   1. Key shape — only `agent:<agentId>:subagent:<uuid>` entries qualify;
 *      main / group / global / unknown keys are excluded.
 *   2. Optional agentId scope — when `targetAgentId` is provided, only keys
 *      under that agent are inspected (lets the caller load a single
 *      per-agent store rather than a combined one).
 *   3. Trimmed label match — `entry.label?.trim() === label.trim()`.
 *   4. Origin match via `deliveryContextKey` — channel + to + accountId
 *      + threadId. The entry's origin is read through
 *      `deliveryContextFromSession` so both the canonical `deliveryContext`
 *      block and legacy `lastChannel/lastTo/...` fields are honored.
 *   5. "Live" = "entry physically present in the store snapshot". Run-mode
 *      subagents are removed from the store via `sessions.delete` after
 *      cleanup, so a surviving entry implies the session is persistent and
 *      still alive. Crucially, `endedAt` on the entry does NOT disqualify
 *      it — that was the source of the original idempotency bug (G3).
 *   6. Tie-break on label collision: latest `entry.updatedAt` wins.
 *
 * Pure function over the loaded store snapshot — performs no I/O.
 *
 * @param params Query parameters.
 * @param params.store Read-only snapshot of the gateway session store
 *   (`Record<sessionKey, SessionEntry>` as returned by `loadSessionStore`).
 * @param params.label User-visible label requested by the spawn caller.
 * @param params.requesterOrigin Delivery context of the requester
 *   (channel, to, accountId, threadId). Sessions are matched only when
 *   their normalized origin key equals the requester's.
 * @param params.targetAgentId Optional agentId scope. When provided, only
 *   keys whose agentId segment matches (case-insensitive) are inspected.
 * @returns Matching `{ key, entry }`, or `undefined` when no live persistent
 *   session matches the label + origin combination.
 */
export function findLivePersistentSessionByLabel(params: {
  store: Readonly<Record<string, SessionEntry>>;
  label: string;
  requesterOrigin: DeliveryContext | undefined;
  targetAgentId?: string;
}): LivePersistentSessionMatch | undefined {
  const trimmedLabel = params.label.trim();
  if (!trimmedLabel) {
    return undefined;
  }
  const targetOriginKey = deliveryContextKey(params.requesterOrigin);
  const agentScope = params.targetAgentId?.trim().toLowerCase();

  let best: LivePersistentSessionMatch | undefined;
  let bestUpdatedAt = Number.NEGATIVE_INFINITY;

  for (const [key, entry] of Object.entries(params.store)) {
    if (!entry) {
      continue;
    }
    const parsed = parseSubagentKey(key);
    if (!parsed) {
      continue;
    }
    if (agentScope && parsed.agentId.toLowerCase() !== agentScope) {
      continue;
    }
    if (entry.label?.trim() !== trimmedLabel) {
      continue;
    }
    const entryOriginKey = deliveryContextKey(deliveryContextFromSession(entry));
    if (entryOriginKey !== targetOriginKey) {
      continue;
    }
    const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : 0;
    if (!best || updatedAt > bestUpdatedAt) {
      best = { key, entry };
      bestUpdatedAt = updatedAt;
    }
  }
  return best;
}
