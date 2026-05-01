import { describe, expect, it, vi } from "vitest";
import type { Affordance } from "../affordance.js";
import { persistentSessionCreatedPredicate } from "../done-predicate-persistent-session.js";
import type { ExecutionCommitment } from "../execution-commitment.js";
import type { ExpectedDelta } from "../expected-delta.js";
import type {
  AffordanceId,
  AgentId,
  CommitmentId,
  EffectId,
  ISO8601,
  SessionId,
  SessionKey,
} from "../ids.js";
import { createMonitoredRuntime } from "../monitored-runtime.js";
import type { SessionWorldStateObserver } from "../session-world-state-observer.js";
import type { SessionWorldState } from "../world-state.js";

function commitment(): ExecutionCommitment {
  return {
    id: "commitment-test" as CommitmentId,
    effect: "persistent_session.created" as EffectId,
    target: { kind: "session" },
    constraints: {},
    budgets: {
      maxLatencyMs: 30_000,
      maxRetries: 0,
    },
    requiredEvidence: [{ kind: "session_record.created", mandatory: true }],
    terminalPolicy: {
      onTimeout: "unsupported",
      onPolicyDenial: "rejected",
      onUnsatisfiedSuccess: "rejected",
    },
  };
}

function affordance(): Affordance {
  return {
    id: "persistent_session.created" as AffordanceId,
    effect: "persistent_session.created" as EffectId,
    target: () => true,
    requiredPreconditions: [],
    requiredEvidence: [{ kind: "session_record.created", mandatory: true }],
    allowedConstraintKeys: [],
    riskTier: "low",
    defaultBudgets: {
      maxLatencyMs: 30_000,
      maxRetries: 0,
    },
    observerHandle: { id: "session_world_state" },
    donePredicate: persistentSessionCreatedPredicate,
  };
}

function expectedDelta(): ExpectedDelta {
  return {
    sessions: {
      followupRegistry: {
        added: [
          {
            sessionId: "agent:worker:main" as SessionId,
            agentId: "worker" as AgentId,
          },
        ],
      },
    },
  };
}

function worldState(sessionIds: readonly string[]): SessionWorldState {
  return {
    followupRegistry: sessionIds.map((sessionId) => ({
      sessionId: sessionId as SessionId,
      agentId: "worker" as AgentId,
      parentSessionKey: "agent:main:main" as SessionKey,
      status: "active",
      createdAt: "2026-04-27T08:00:00.000Z" as ISO8601,
    })),
  };
}

function queuedObserver(states: readonly SessionWorldState[]): SessionWorldStateObserver {
  let index = 0;
  return {
    observe: () => states[Math.min(index++, states.length - 1)] ?? worldState([]),
  };
}

describe("monitored runtime", () => {
  it("returns runtime-attested success when the post-execution state satisfies the commitment", async () => {
    const execute = vi.fn();
    const runtime = createMonitoredRuntime({
      sessionObserver: queuedObserver([worldState([]), worldState(["agent:worker:main"])]),
    });

    await expect(
      runtime.run({
        commitment: commitment(),
        affordance: affordance(),
        expectedDelta: expectedDelta(),
        execute,
      }),
    ).resolves.toMatchObject({
      terminalState: "action_completed",
      acceptanceReason: "commitment_satisfied",
      commitmentSatisfied: true,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keeps terminal state orthogonal to acceptance reason when unsatisfied", async () => {
    const runtime = createMonitoredRuntime({
      sessionObserver: queuedObserver([worldState([]), worldState([])]),
    });

    await expect(
      runtime.run({
        commitment: commitment(),
        affordance: affordance(),
        expectedDelta: expectedDelta(),
      }),
    ).resolves.toMatchObject({
      terminalState: "rejected",
      acceptanceReason: "commitment_unsatisfied",
      commitmentSatisfied: false,
      satisfaction: {
        satisfied: false,
        missing: ["session_record_missing:agent:worker:main"],
      },
    });
  });

  it("does not report satisfaction when observation fails", async () => {
    const runtime = createMonitoredRuntime({
      sessionObserver: {
        observe: () => {
          throw new Error("observer failed");
        },
      },
    });

    await expect(
      runtime.run({
        commitment: commitment(),
        affordance: affordance(),
        expectedDelta: expectedDelta(),
      }),
    ).resolves.toMatchObject({
      terminalState: "unsupported",
      acceptanceReason: "observer_unavailable",
      commitmentSatisfied: false,
    });
  });
});
