/**
 * Slice "PR-MT concurrent broker" — Phase 2 + Phase 3 barrel.
 *
 * Re-exports the broker surface that Phase 4 broker runtime and Phase 5
 * wiring at `agent-runner-execution.ts` consume:
 *
 *   import {
 *     buildBrokerQueueKey,
 *     decideQueuePlacement,
 *     type BrokerEntry,
 *     type BrokerPlacement,
 *   } from "src/platform/broker/index.js";
 *
 * No impl lives at the barrel — it is a re-export only.
 */
export {
  BROKER_OVERFLOW_REASONS,
  BrokerCapacityConfigSchema,
  DEFAULT_FAIRNESS_MODE,
  DEFAULT_MAX_CONCURRENT_KEYS,
  DEFAULT_MAX_QUEUE_DEPTH_PER_KEY,
  DEFAULT_QUEUE_WAIT_TIMEOUT_MS,
  buildBrokerQueueKey,
  isBrokerQueueKey,
  resolveBrokerCapacityConfig,
} from "./broker-types.js";

export type {
  BrokerCapacityConfig,
  BrokerEntry,
  BrokerOverflowReason,
  BrokerQueueKey,
  ResolvedBrokerCapacityConfig,
} from "./broker-types.js";

export {
  decideNextDispatch,
  decideQueuePlacement,
} from "./decide-queue-placement.js";

export type {
  BrokerPlacement,
  BrokerState,
  DecideNextDispatchParams,
  DecideQueuePlacementParams,
  DispatchDecision,
} from "./decide-queue-placement.js";

export { createConcurrentTurnBroker } from "./concurrent-turn-broker.js";

export type {
  BrokerSubmitResult,
  ConcurrentTurnBroker,
  ConcurrentTurnBrokerDeps,
} from "./concurrent-turn-broker.js";
