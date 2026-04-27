import type {
  Affordance,
  ReceiptsBundle,
  SatisfactionResult,
  ShadowTrace,
} from "./affordance.js";
import type { ExecutionCommitment } from "./execution-commitment.js";
import type { ExpectedDelta } from "./expected-delta.js";
import type { SessionWorldStateObserver } from "./session-world-state-observer.js";
import type { WorldStateSnapshot } from "./world-state.js";

export type RuntimeTerminalState = "action_completed" | "rejected" | "unsupported";

export type RuntimeAcceptanceReason =
  | "commitment_satisfied"
  | "commitment_unsatisfied"
  | "observer_unavailable";

export type RuntimeAttestation = {
  readonly terminalState: RuntimeTerminalState;
  readonly acceptanceReason: RuntimeAcceptanceReason;
  readonly commitmentSatisfied: boolean;
  readonly stateBefore: WorldStateSnapshot;
  readonly stateAfter: WorldStateSnapshot;
  readonly satisfaction: SatisfactionResult;
};

export type MonitoredRuntimeRunParams = {
  readonly commitment: ExecutionCommitment;
  readonly affordance: Affordance;
  readonly expectedDelta: ExpectedDelta;
  readonly execute?: () => void | Promise<void>;
  readonly receipts?: ReceiptsBundle;
  readonly trace?: ShadowTrace;
};

export interface MonitoredRuntime {
  /**
   * Observes state around an existing execution path and verifies the commitment.
   *
   * @param params - Commitment, affordance, expected delta, and optional execution callback.
   * @returns Runtime attestation with terminal state separated from acceptance reason.
   */
  run(params: MonitoredRuntimeRunParams): Promise<RuntimeAttestation>;
}

/**
 * Creates the cutover-1 monitored runtime wrapper.
 *
 * @param deps - Runtime-attested session observer dependency.
 * @returns Runtime wrapper that verifies affordance predicates against observed state.
 */
export function createMonitoredRuntime(deps: {
  readonly sessionObserver: SessionWorldStateObserver;
}): MonitoredRuntime {
  return Object.freeze({
    async run(params: MonitoredRuntimeRunParams): Promise<RuntimeAttestation> {
      let stateBefore: WorldStateSnapshot;
      let stateAfter: WorldStateSnapshot;

      try {
        stateBefore = Object.freeze({ sessions: deps.sessionObserver.observe() });
        await params.execute?.();
        stateAfter = Object.freeze({ sessions: deps.sessionObserver.observe() });
      } catch {
        return observerUnavailableAttestation();
      }

      const satisfaction = params.affordance.donePredicate({
        stateBefore,
        stateAfter,
        expectedDelta: params.expectedDelta,
        receipts: params.receipts ?? EMPTY_RECEIPTS,
        trace: params.trace ?? emptyTrace(),
      });

      if (satisfaction.satisfied) {
        return Object.freeze({
          terminalState: "action_completed",
          acceptanceReason: "commitment_satisfied",
          commitmentSatisfied: true,
          stateBefore,
          stateAfter,
          satisfaction,
        });
      }

      return Object.freeze({
        terminalState: params.commitment.terminalPolicy.onUnsatisfiedSuccess,
        acceptanceReason: "commitment_unsatisfied",
        commitmentSatisfied: false,
        stateBefore,
        stateAfter,
        satisfaction,
      });
    },
  });
}

const EMPTY_RECEIPTS: ReceiptsBundle = Object.freeze({
  entries: Object.freeze([]),
});

/**
 * Creates an empty shadow trace for predicate contexts that do not need trace facts.
 *
 * @returns Empty trace with no user text or classifier output.
 */
function emptyTrace(): ShadowTrace {
  return Object.freeze({
    steps: Object.freeze([]),
  });
}

/**
 * Builds a deterministic attestation for observer failures.
 *
 * @returns Runtime attestation that cannot be treated as a satisfied commitment.
 */
function observerUnavailableAttestation(): RuntimeAttestation {
  const state = Object.freeze({});
  return Object.freeze({
    terminalState: "unsupported",
    acceptanceReason: "observer_unavailable",
    commitmentSatisfied: false,
    stateBefore: state,
    stateAfter: state,
    satisfaction: Object.freeze({
      satisfied: false,
      missing: Object.freeze(["observer_unavailable"]),
    }),
  });
}
