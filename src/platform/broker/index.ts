/**
 * Slice "PR-MT concurrent broker" — Phase 2 barrel.
 *
 * Re-exports the Phase 2 type surface so callers (Phase 3 placement
 * helper, Phase 4 broker runtime, Phase 5 wiring at
 * `agent-runner-execution.ts`) can import from a single entrypoint:
 *
 *   import { buildBrokerQueueKey, type BrokerEntry } from "src/platform/broker/index.js";
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
