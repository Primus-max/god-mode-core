import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionStore, resolveStorePath } from "../../config/sessions.js";
import { findLivePersistentSessionByLabel } from "../../agents/subagent-persistent-session-query.js";
import { snapshotSubagentRunsForObserver } from "../../agents/subagent-registry.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import type { ExecutionCommitment } from "./execution-commitment.js";
import type { ExpectedDelta, SessionExpectedDelta } from "./expected-delta.js";
import type { AgentId, SessionId } from "./ids.js";
import { createMonitoredRuntime, type MonitoredRuntime } from "./monitored-runtime.js";
import { createSessionWorldStateObserverFromSnapshotSource } from "./session-world-state-observer.js";

const PERSISTENT_SESSION_CREATED_EFFECT = "persistent_session.created";

export type DefaultExpectedDeltaResolverOptions = {
  /**
   * Delivery origin of the requester. When provided, idempotent re-spawns are
   * resolvable: the resolver looks up the existing persistent session by
   * `displayName` + origin and emits the matching `SessionExpectedDelta`.
   * When absent, the resolver returns `undefined` for every commitment,
   * which causes `runTurnDecision` to record `expected_delta_unavailable`
   * and fall back to the legacy classifier path (G1/G2 still satisfied —
   * the kernel was given the chance and the trace records the reason).
   */
  readonly requesterOrigin?: DeliveryContext;
  /**
   * Optional agentId scope passed to `findLivePersistentSessionByLabel`.
   * Required when the caller can narrow the lookup to a single agent's
   * session store; otherwise the lookup spans every agent reachable through
   * `loadSessionStore`.
   */
  readonly targetAgentId?: string;
  /**
   * Read-only store snapshot loader. Defaults to `loadSessionStore` against
   * the resolved store path for `targetAgentId`. Tests inject in-memory
   * fixtures here to avoid disk I/O.
   */
  readonly storeLoader?: () => Readonly<Record<string, SessionEntry>>;
};

/**
 * Builds the production `MonitoredRuntime` for the kernel cutover gate.
 *
 * Wires the registry-backed `SessionWorldStateObserver` into the kernel
 * runtime wrapper. Used by every production call-site of `runTurnDecision`
 * to satisfy the wiring contract recorded as audit gap G2.
 *
 * @returns Read-only monitored runtime backed by `snapshotSubagentRunsForObserver`.
 */
export function createDefaultMonitoredRuntime(): MonitoredRuntime {
  const sessionObserver = createSessionWorldStateObserverFromSnapshotSource(() =>
    snapshotSubagentRunsForObserver(),
  );
  return createMonitoredRuntime({ sessionObserver });
}

/**
 * Builds the production `expectedDeltaResolver` for `runTurnDecision`.
 *
 * Resolves an `ExpectedDelta` for the `persistent_session.created` effect by
 * locating an existing live persistent session that matches the commitment's
 * `displayName` constraint and the caller's delivery origin. When no match
 * is found (fresh spawn, missing origin, or non-session effect) the resolver
 * returns `undefined`, which routes the turn through the legacy classifier
 * with the matching `expected_delta_unavailable` fallback trace.
 *
 * @param options - Resolver dependencies (origin, agent scope, store loader).
 * @returns Resolver suitable for `RunTurnDecisionInput.expectedDeltaResolver`.
 */
export function createDefaultExpectedDeltaResolver(
  options: DefaultExpectedDeltaResolverOptions = {},
): (commitment: ExecutionCommitment) => ExpectedDelta | undefined {
  const requesterOrigin = options.requesterOrigin;
  const targetAgentId = options.targetAgentId;
  const storeLoader = options.storeLoader ?? defaultStoreLoader(targetAgentId);

  return (commitment: ExecutionCommitment): ExpectedDelta | undefined => {
    if (commitment.effect !== PERSISTENT_SESSION_CREATED_EFFECT) {
      return undefined;
    }
    if (!requesterOrigin) {
      return undefined;
    }
    const displayName = readDisplayNameConstraint(commitment.constraints);
    if (!displayName) {
      return undefined;
    }
    let store: Readonly<Record<string, SessionEntry>>;
    try {
      store = storeLoader();
    } catch {
      return undefined;
    }
    const match = findLivePersistentSessionByLabel({
      store,
      label: displayName,
      requesterOrigin,
      ...(targetAgentId ? { targetAgentId } : {}),
    });
    if (!match) {
      return undefined;
    }
    const expected: SessionExpectedDelta = {
      followupRegistry: {
        added: [
          {
            sessionId: match.key as SessionId,
            agentId: resolveAgentIdFromSessionKey(match.key) as AgentId,
          },
        ],
      },
    };
    return { sessions: expected };
  };
}

function readDisplayNameConstraint(
  constraints: ExecutionCommitment["constraints"],
): string | undefined {
  const value = (constraints as Record<string, unknown> | undefined)?.["displayName"];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function defaultStoreLoader(
  targetAgentId: string | undefined,
): () => Readonly<Record<string, SessionEntry>> {
  return () => {
    if (!targetAgentId) {
      return {};
    }
    const storePath = resolveStorePath(undefined, { agentId: targetAgentId });
    return loadSessionStore(storePath);
  };
}
