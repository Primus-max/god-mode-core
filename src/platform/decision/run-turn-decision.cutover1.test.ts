import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  PERSISTENT_SESSION_EFFECT_FAMILY,
  type ExpectedDelta,
  type IntentContractorAdapter,
  type RuntimeAttestation,
} from "../commitment/index.js";
import type { AgentId, SessionId } from "../commitment/ids.js";
import type { SemanticIntent } from "../commitment/semantic-intent.js";
import type { CutoverGateTrace } from "./run-turn-decision.js";
import { runTurnDecision } from "./run-turn-decision.js";
import type { TaskClassifierAdapter, TaskContract } from "./task-classifier.js";

/**
 * Cutover-1 routing flip contract for Wave A (PR-4a).
 *
 * Closes audit gaps G1+G2 (master plan §0.5.3) by asserting that
 * `runTurnDecision` actually routes through the kernel-derived
 * `productionDecision` for `persistent_session.created` when:
 *   - cutover is enabled (or default Phase B treats missing flag as enabled),
 *   - the effect is in the cutover-1 pool,
 *   - a `MonitoredRuntime` returns successful attestation.
 *
 * Conversely, on any legacy fallback path (cutover disabled, runtime
 * unavailable, attestation rejected) production must mirror legacy
 * via `kernelFallback=true` plus a typed `fallbackReason`. Anti-checklist
 * §5.1.3 forbids asserting `productionDecision !== legacyDecision`
 * outside of cutover-eligible turns with successful attestation.
 *
 * Path matches PR-4 sub-plan §5 row "runTurnDecision routes correctly
 * (cutover-1)" — `src/platform/decision/run-turn-decision.cutover1.test.ts`.
 */

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

function legacyTraceGate(result: Awaited<ReturnType<typeof runTurnDecision>>): CutoverGateTrace | undefined {
  return (
    result.legacyDecision.plannerInput.decisionTrace as
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

  it("[PR-4a contract] productionDecision diverges from legacyDecision on kernel-derived success", async () => {
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

    expect(result.kernelFallback).toBe(false);
    expect(result.fallbackReason).toBeUndefined();
    expect(result.productionDecision).not.toBe(result.legacyDecision);
    expect(legacyTraceGate(result)).toBeUndefined();
    expect(traceGate(result)?.kind).toBe("gate_in_success");
    const productionTrace = result.productionDecision.plannerInput.decisionTrace as
      | {
          readonly kernelDerived?: { readonly sourceOfTruth: "kernel"; readonly effect: string };
          readonly kernelFallback?: boolean;
        }
      | undefined;
    expect(productionTrace?.kernelDerived?.sourceOfTruth).toBe("kernel");
    expect(productionTrace?.kernelDerived?.effect).toBe("persistent_session.created");
    expect(productionTrace?.kernelFallback).toBe(false);
  });

  it("[PR-4a contract] productionDecision falls back with kernelFallback=true when commitment is unsatisfied", async () => {
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

    expect(result.kernelFallback).toBe(true);
    expect(result.fallbackReason).toBe("commitment_unsatisfied");
    expect(result.productionDecision).not.toBe(result.legacyDecision);
    const productionTrace = result.productionDecision.plannerInput.decisionTrace as
      | { readonly kernelFallback?: boolean; readonly fallbackReason?: string }
      | undefined;
    expect(productionTrace?.kernelFallback).toBe(true);
    expect(productionTrace?.fallbackReason).toBe("commitment_unsatisfied");
  });

  it("[PR-4a contract] productionDecision falls back with reason=monitored_runtime_unavailable when runtime is missing", async () => {
    const result = await runTurnDecision({
      prompt: "create persistent session",
      cfg: cfg(true),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter() },
      expectedDeltaResolver: () => expectedDelta,
    });

    expect(result.kernelFallback).toBe(true);
    expect(result.fallbackReason).toBe("monitored_runtime_unavailable");
    const productionTrace = result.productionDecision.plannerInput.decisionTrace as
      | { readonly fallbackReason?: string }
      | undefined;
    expect(productionTrace?.fallbackReason).toBe("monitored_runtime_unavailable");
  });

  it("treats missing cutoverEnabled flag as enabled (Phase B default)", async () => {
    const monitoredRuntime = {
      run: vi.fn(async () =>
        attestation({
          commitmentSatisfied: true,
          terminalState: "action_completed",
          acceptanceReason: "commitment_satisfied",
        }),
      ),
    };

    const cfgWithoutFlag = {
      agents: {
        defaults: {
          embeddedPi: {
            taskClassifier: { backend: "legacy-mock" },
            intentContractor: { backend: "intent-mock" },
          },
        },
      },
    } as OpenClawConfig;

    const result = await runTurnDecision({
      prompt: "create persistent session",
      cfg: cfgWithoutFlag,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter() },
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
    });

    expect(result.cutoverGate.kind).toBe("gate_in_success");
    expect(monitoredRuntime.run).toHaveBeenCalledTimes(1);
  });
});
