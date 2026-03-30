import type { ChannelAccountSnapshot } from "../../channels/plugins/types.js";
import type { PlatformRuntimeExecutionSurface } from "../../platform/runtime/index.js";
import {
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  evaluateChannelHealth,
  type ChannelHealthPolicy,
  type ChannelHealthEvaluation,
} from "../channel-health-policy.js";
import type { ChannelManager } from "../server-channels.js";

export type ReadinessResult = {
  ready: boolean;
  failing: string[];
  uptimeMs: number;
  surface?: PlatformRuntimeExecutionSurface;
};

export type ReadinessChecker = () => ReadinessResult;

const DEFAULT_READINESS_CACHE_TTL_MS = 1_000;

function shouldIgnoreReadinessFailure(
  accountSnapshot: ChannelAccountSnapshot,
  health: ChannelHealthEvaluation,
): boolean {
  if (health.reason === "unmanaged" || health.reason === "stale-socket") {
    return true;
  }
  // Channel restarts spend time in backoff with running=false before the next
  // lifecycle re-enters startup grace. Keep readiness green during that handoff
  // window, but still surface hard failures once restart attempts are exhausted.
  return health.reason === "not-running" && accountSnapshot.restartPending === true;
}

function buildReadinessExecutionSurface(params: {
  ready: boolean;
  failing: string[];
  now: number;
  cacheTtlMs: number;
}): PlatformRuntimeExecutionSurface {
  return {
    status: params.ready ? "ready" : "degraded",
    ready: params.ready,
    checkedAtMs: params.now,
    cacheTtlMs: params.cacheTtlMs,
    reasons:
      params.failing.length > 0
        ? [`Channel readiness degraded: ${params.failing.join(", ")}.`]
        : ["Gateway readiness snapshot is healthy."],
    ...(params.failing.length > 0 ? { failingChannels: params.failing } : {}),
  };
}

export function createReadinessChecker(deps: {
  channelManager: ChannelManager;
  startedAt: number;
  cacheTtlMs?: number;
}): ReadinessChecker {
  const { channelManager, startedAt } = deps;
  const cacheTtlMs = Math.max(0, deps.cacheTtlMs ?? DEFAULT_READINESS_CACHE_TTL_MS);
  let cachedAt = 0;
  let cachedState: Omit<ReadinessResult, "uptimeMs"> | null = null;

  return (): ReadinessResult => {
    const now = Date.now();
    const uptimeMs = now - startedAt;
    if (cachedState && now - cachedAt < cacheTtlMs) {
      return { ...cachedState, uptimeMs };
    }

    const snapshot = channelManager.getRuntimeSnapshot();
    const failing: string[] = [];

    for (const [channelId, accounts] of Object.entries(snapshot.channelAccounts)) {
      if (!accounts) {
        continue;
      }
      for (const accountSnapshot of Object.values(accounts)) {
        if (!accountSnapshot) {
          continue;
        }
        const policy: ChannelHealthPolicy = {
          now,
          staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
          channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS,
          channelId,
        };
        const health = evaluateChannelHealth(accountSnapshot, policy);
        if (!health.healthy && !shouldIgnoreReadinessFailure(accountSnapshot, health)) {
          failing.push(channelId);
          break;
        }
      }
    }

    cachedAt = now;
    cachedState = {
      ready: failing.length === 0,
      failing,
      surface: buildReadinessExecutionSurface({
        ready: failing.length === 0,
        failing,
        now,
        cacheTtlMs,
      }),
    };
    return { ...cachedState, uptimeMs };
  };
}
