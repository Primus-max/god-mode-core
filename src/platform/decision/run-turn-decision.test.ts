import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  PERSISTENT_SESSION_EFFECT_FAMILY,
  type IntentContractorAdapter,
} from "../commitment/index.js";
import type { SemanticIntent } from "../commitment/semantic-intent.js";
import { runTurnDecision } from "./run-turn-decision.js";
import type { TaskClassifierAdapter, TaskContract } from "./task-classifier.js";

const cfg = {
  agents: {
    defaults: {
      embeddedPi: {
        taskClassifier: { backend: "legacy-mock" },
        intentContractor: { backend: "intent-mock" },
      },
    },
  },
} as OpenClawConfig;

const legacyContract: TaskContract = {
  primaryOutcome: "answer",
  requiredCapabilities: [],
  interactionMode: "respond_only",
  confidence: 0.9,
  ambiguities: [],
};

describe("runTurnDecision", () => {
  it("returns raw legacy decision and routes shadow trace to productionDecision", async () => {
    const legacyAdapter: TaskClassifierAdapter = {
      classify: vi.fn(async () => legacyContract),
    };
    const intentAdapter: IntentContractorAdapter = {
      classify: vi.fn(async (): Promise<SemanticIntent> => ({
        desiredEffectFamily: PERSISTENT_SESSION_EFFECT_FAMILY,
        target: { kind: "session" },
        operation: { kind: "create" },
        constraints: { displayName: "Valera" },
        uncertainty: [],
        confidence: 0.9,
      })),
    };

    const result = await runTurnDecision({
      prompt: "create a persistent session",
      cfg,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter },
    });

    expect(result.legacyDecision.taskContract.primaryOutcome).toBe("answer");
    expect(result.productionDecision.taskContract.primaryOutcome).toBe("answer");
    expect(result.shadowCommitment.kind).toBe("commitment");
    expect(result.legacyDecision.plannerInput.decisionTrace?.shadowCommitment).toBeUndefined();
    expect(result.productionDecision.plannerInput.decisionTrace?.shadowCommitment).toEqual(
      result.shadowCommitment,
    );
    expect(result.kernelFallback).toBe(true);
    expect(result.fallbackReason).toBe("monitored_runtime_unavailable");
    expect(result.traceId).toMatch(/^decision_trace_/);
  });

  it("keeps legacy decision when shadow branch fails", async () => {
    const legacyAdapter: TaskClassifierAdapter = {
      classify: vi.fn(async () => legacyContract),
    };
    const intentAdapter: IntentContractorAdapter = {
      classify: vi.fn(async () => {
        throw new Error("shadow boom");
      }),
    };

    const result = await runTurnDecision({
      prompt: "hello",
      cfg,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter },
    });

    expect(result.legacyDecision.taskContract.primaryOutcome).toBe("answer");
    expect(result.shadowCommitment).toEqual({
      kind: "unsupported",
      reason: "low_confidence_intent",
    });
    expect(result.kernelFallback).toBe(true);
    expect(result.fallbackReason).toBe("low_confidence_intent");
  });
});
