import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionStore, resolveStorePath } from "../../config/sessions.js";
import { findLivePersistentSessionByLabel } from "../../agents/subagent-persistent-session-query.js";
import { snapshotSubagentRunsForObserver } from "../../agents/subagent-registry.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  deliveryContextKey as computeDeliveryContextKey,
  type DeliveryContext,
} from "../../utils/delivery-context.js";
import {
  getProcessDeliveryReceiptRegistry,
  type DeliveryReceiptRegistry,
} from "./delivery-receipt-registry.js";
import { createDeliveryWorldStateObserver } from "./delivery-world-state-observer.js";
import type { ExecutionCommitment } from "./execution-commitment.js";
import type {
  DeliveryReceiptRef,
  ExpectedDelta,
  SessionExpectedDelta,
} from "./expected-delta.js";
import type { AgentId, EffectId, SessionId } from "./ids.js";
import { createMonitoredRuntime, type MonitoredRuntime } from "./monitored-runtime.js";
import { createSessionWorldStateObserverFromSnapshotSource } from "./session-world-state-observer.js";
import type { DeliveryReceiptKind } from "./world-state.js";

const PERSISTENT_SESSION_CREATED_EFFECT = "persistent_session.created";
const ANSWER_DELIVERED_EFFECT = "answer.delivered";
const CLARIFICATION_REQUESTED_EFFECT = "clarification_requested";
const EXTERNAL_EFFECT_PERFORMED_EFFECT = "external_effect.performed";

const RECEIPT_KIND_BY_EFFECT: Readonly<Record<string, DeliveryReceiptKind>> = Object.freeze({
  [ANSWER_DELIVERED_EFFECT]: "answer",
  [CLARIFICATION_REQUESTED_EFFECT]: "clarification",
  [EXTERNAL_EFFECT_PERFORMED_EFFECT]: "external_effect",
});

export type DefaultExpectedDeltaResolverOptions = {
  /**
   * Delivery origin of the requester. When provided, idempotent re-spawns are
   * resolvable: the resolver looks up the existing persistent session by
   * `displayName` + origin and emits the matching `SessionExpectedDelta`.
   * Wave B also uses this to compute the active `deliveryContextKey` for
   * chat-bound effects.
   *
   * When absent, the resolver returns `undefined` for every commitment, which
   * causes `runTurnDecision` to record `expected_delta_unavailable` and fall
   * back to the legacy classifier path (G1/G2 still satisfied — the kernel
   * was given the chance and the trace records the reason).
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
  /**
   * Wave B injection point: delivery receipt registry used by
   * chat-bound effects to detect prior receipts for the active delivery
   * context. Defaults to the process-scoped registry written by the
   * outbound pipeline.
   */
  readonly deliveryReceiptRegistry?: DeliveryReceiptRegistry;
};

/**
 * Builds the production `MonitoredRuntime` for the kernel cutover gate.
 *
 * Wires the registry-backed `SessionWorldStateObserver` (Wave A) and the
 * delivery `DeliveryWorldStateObserver` (Wave B) into the kernel runtime
 * wrapper. Used by every production call-site of `runTurnDecision` to
 * satisfy the wiring contract recorded as audit gaps G2 (Wave A) and the
 * deliveries observer requirement (Wave B sub-plan §4.3).
 *
 * @param options - Optional wiring overrides (delivery registry for tests).
 * @returns Read-only monitored runtime backed by registry observers.
 */
export function createDefaultMonitoredRuntime(options: {
  readonly deliveryReceiptRegistry?: DeliveryReceiptRegistry;
} = {}): MonitoredRuntime {
  const sessionObserver = createSessionWorldStateObserverFromSnapshotSource(() =>
    snapshotSubagentRunsForObserver(),
  );
  const registry = options.deliveryReceiptRegistry ?? getProcessDeliveryReceiptRegistry();
  const deliveryObserver = createDeliveryWorldStateObserver(registry);
  return createMonitoredRuntime({ sessionObserver, deliveryObserver });
}

/**
 * Builds the production `expectedDeltaResolver` for `runTurnDecision`.
 *
 * Wave A: resolves an `ExpectedDelta` for `persistent_session.created` by
 * locating an existing live persistent session that matches the commitment's
 * `displayName` constraint and the caller's delivery origin. When no match
 * is found (fresh spawn, missing origin, or non-session effect) the resolver
 * returns `undefined`, which routes the turn through the legacy classifier
 * with the matching `expected_delta_unavailable` fallback trace.
 *
 * Wave B: resolves an `ExpectedDelta` for chat-bound effects
 * (`answer.delivered`, `clarification_requested`, `external_effect.performed`)
 * by computing the active `deliveryContextKey` from `requesterOrigin` and
 * checking the delivery receipt registry for prior receipts of the matching
 * kind. When the dialog has prior receipts of the requested kind, the
 * resolver emits an idempotency-style `DeliveryExpectedDelta`; first-ever
 * deliveries fall back to legacy.
 *
 * @param options - Resolver dependencies (origin, agent scope, registries).
 * @returns Resolver suitable for `RunTurnDecisionInput.expectedDeltaResolver`.
 */
export function createDefaultExpectedDeltaResolver(
  options: DefaultExpectedDeltaResolverOptions = {},
): (commitment: ExecutionCommitment) => ExpectedDelta | undefined {
  const requesterOrigin = options.requesterOrigin;
  const targetAgentId = options.targetAgentId;
  const storeLoader = options.storeLoader ?? defaultStoreLoader(targetAgentId);
  const deliveryRegistry =
    options.deliveryReceiptRegistry ?? getProcessDeliveryReceiptRegistry();

  return (commitment: ExecutionCommitment): ExpectedDelta | undefined => {
    if (commitment.effect === (PERSISTENT_SESSION_CREATED_EFFECT as EffectId)) {
      return resolveSessionDelta({
        commitment,
        requesterOrigin,
        targetAgentId,
        storeLoader,
      });
    }
    const receiptKind = RECEIPT_KIND_BY_EFFECT[commitment.effect];
    if (receiptKind) {
      return resolveDeliveryDelta({
        commitment,
        requesterOrigin,
        registry: deliveryRegistry,
        receiptKind,
      });
    }
    return undefined;
  };
}

function resolveSessionDelta(params: {
  readonly commitment: ExecutionCommitment;
  readonly requesterOrigin: DeliveryContext | undefined;
  readonly targetAgentId: string | undefined;
  readonly storeLoader: () => Readonly<Record<string, SessionEntry>>;
}): ExpectedDelta | undefined {
  if (!params.requesterOrigin) {
    return undefined;
  }
  const displayName = readDisplayNameConstraint(params.commitment.constraints);
  if (!displayName) {
    return undefined;
  }
  let store: Readonly<Record<string, SessionEntry>>;
  try {
    store = params.storeLoader();
  } catch {
    return undefined;
  }
  const match = findLivePersistentSessionByLabel({
    store,
    label: displayName,
    requesterOrigin: params.requesterOrigin,
    ...(params.targetAgentId ? { targetAgentId: params.targetAgentId } : {}),
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
}

function resolveDeliveryDelta(params: {
  readonly commitment: ExecutionCommitment;
  readonly requesterOrigin: DeliveryContext | undefined;
  readonly registry: DeliveryReceiptRegistry;
  readonly receiptKind: DeliveryReceiptKind;
}): ExpectedDelta | undefined {
  const contextKey =
    readDeliveryContextKeyConstraint(params.commitment.constraints) ??
    computeDeliveryContextKey(params.requesterOrigin);
  if (!contextKey) {
    return undefined;
  }
  const priorReceipts = params.registry.list(contextKey);
  const match = priorReceipts.find((receipt) => receipt.kind === params.receiptKind);
  if (!match) {
    return undefined;
  }
  const ref: DeliveryReceiptRef = Object.freeze({
    deliveryContextKey: contextKey,
    kind: params.receiptKind,
  });
  return {
    deliveries: {
      receipts: {
        added: Object.freeze([ref]),
      },
    },
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

function readDeliveryContextKeyConstraint(
  constraints: ExecutionCommitment["constraints"],
): string | undefined {
  const value = (constraints as Record<string, unknown> | undefined)?.["deliveryContextKey"];
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
