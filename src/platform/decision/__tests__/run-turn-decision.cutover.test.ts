import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  PERSISTENT_SESSION_EFFECT_FAMILY,
  type ExpectedDelta,
  type IntentContractorAdapter,
  type RuntimeAttestation,
} from "../../commitment/index.js";
import type { AgentId, SessionId } from "../../commitment/ids.js";
import type { SemanticIntent } from "../../commitment/semantic-intent.js";
import type { CutoverGateTrace } from "../run-turn-decision.js";
import { runTurnDecision } from "../run-turn-decision.js";
import type { TaskClassifierAdapter, TaskContract } from "../task-classifier.js";

const legacyContract: TaskContract = {
  primaryOutcome: "answer",
  requiredCapabilities: [],
  interactionMode: "respond_only",
  confidence: 0.9,
  ambiguities: [],
};

const expectedDelta: ExpectedDelta = {
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

function cfg(cutoverEnabled: boolean): OpenClawConfig {
  return {
    agents: {
      defaults: {
        embeddedPi: {
          taskClassifier: { backend: "legacy-mock" },
          intentContractor: { backend: "intent-mock" },
          commitment: { cutoverEnabled },
        },
      },
    },
  } as OpenClawConfig;
}

function legacyAdapter(): TaskClassifierAdapter {
  return {
    classify: vi.fn(async () => legacyContract),
  };
}

function intentAdapter(): IntentContractorAdapter {
  return {
    classify: vi.fn(async (): Promise<SemanticIntent> => ({
      desiredEffectFamily: PERSISTENT_SESSION_EFFECT_FAMILY,
      target: { kind: "session" },
      operation: { kind: "create" },
      constraints: { displayName: "Valera" },
      uncertainty: [],
      confidence: 0.9,
    })),
  };
}

function attestation(params: {
  commitmentSatisfied: boolean;
  terminalState: RuntimeAttestation["terminalState"];
  acceptanceReason: RuntimeAttestation["acceptanceReason"];
}): RuntimeAttestation {
  return {
    commitmentSatisfied: params.commitmentSatisfied,
    terminalState: params.terminalState,
    acceptanceReason: params.acceptanceReason,
    stateBefore: {},
    stateAfter: {},
    satisfaction: params.commitmentSatisfied
      ? { satisfied: true, evidence: [] }
      : { satisfied: false, missing: ["session_record_missing:agent:worker:main"] },
  };
}

function traceGate(result: Awaited<ReturnType<typeof runTurnDecision>>): CutoverGateTrace | undefined {
  return (
    result.productionDecision.plannerInput.decisionTrace as
      | { readonly cutoverGate?: CutoverGateTrace }
      | undefined
  )?.cutoverGate;
}

describe("runTurnDecision cutover gate", () => {
  it("records gate_out and keeps legacy production when cutover is disabled", async () => {
    const monitoredRuntime = {
      run: vi.fn(async () =>
        attestation({
          commitmentSatisfied: true,
          terminalState: "action_completed",
          acceptanceReason: "commitment_satisfied",
        }),
      ),
    };

    const result = await runTurnDecision({
      prompt: "create persistent session",
      cfg: cfg(false),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter() },
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
    });

    expect(result.cutoverGate).toEqual({ kind: "gate_out", reason: "cutover_disabled" });
    expect(traceGate(result)).toEqual(result.cutoverGate);
    expect(result.productionDecision.taskContract.primaryOutcome).toBe("answer");
    expect(monitoredRuntime.run).not.toHaveBeenCalled();
  });

  it("records gate_in_success when runtime attestation satisfies the commitment", async () => {
    const monitoredRuntime = {
      run: vi.fn(async () =>
        attestation({
          commitmentSatisfied: true,
          terminalState: "action_completed",
          acceptanceReason: "commitment_satisfied",
        }),
      ),
    };

    const result = await runTurnDecision({
      prompt: "create persistent session",
      cfg: cfg(true),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter() },
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
    });

    expect(result.cutoverGate).toEqual({
      kind: "gate_in_success",
      effect: "persistent_session.created",
      terminalState: "action_completed",
      acceptanceReason: "commitment_satisfied",
    });
    expect(traceGate(result)).toEqual(result.cutoverGate);
    expect(result.runtimeAttestation?.commitmentSatisfied).toBe(true);
    expect(monitoredRuntime.run).toHaveBeenCalledTimes(1);
  });

  it("records gate_in_fail when runtime attestation rejects satisfaction", async () => {
    const monitoredRuntime = {
      run: vi.fn(async () =>
        attestation({
          commitmentSatisfied: false,
          terminalState: "rejected",
          acceptanceReason: "commitment_unsatisfied",
        }),
      ),
    };

    const result = await runTurnDecision({
      prompt: "create persistent session",
      cfg: cfg(true),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter() },
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
    });

    expect(result.cutoverGate).toEqual({
      kind: "gate_in_fail",
      effect: "persistent_session.created",
      terminalState: "rejected",
      acceptanceReason: "commitment_unsatisfied",
    });
    expect(traceGate(result)).toEqual(result.cutoverGate);
    expect(result.runtimeAttestation?.commitmentSatisfied).toBe(false);
  });

  it("records gate_in_uncertain when cutover is enabled but runtime is unavailable", async () => {
    const result = await runTurnDecision({
      prompt: "create persistent session",
      cfg: cfg(true),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter() },
      expectedDeltaResolver: () => expectedDelta,
    });

    expect(result.cutoverGate).toEqual({
      kind: "gate_in_uncertain",
      reason: "monitored_runtime_unavailable",
      effect: "persistent_session.created",
    });
    expect(traceGate(result)).toEqual(result.cutoverGate);
    expect(result.runtimeAttestation).toBeUndefined();
  });
});
