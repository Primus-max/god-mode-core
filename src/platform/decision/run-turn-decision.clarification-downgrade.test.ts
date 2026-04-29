import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  COMMUNICATION_EFFECT_FAMILY,
  PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
  createAffordanceRegistry,
  type ExpectedDelta,
  type IntentContractorAdapter,
  type RuntimeAttestation,
} from "../commitment/index.js";
import type { AgentId, ChannelId, EffectFamilyId, SessionId } from "../commitment/ids.js";
import type { OperationHint, SemanticIntent, TargetRef } from "../commitment/semantic-intent.js";
import { runTurnDecision } from "./run-turn-decision.js";
import type { TaskClassifierAdapter, TaskContract } from "./task-classifier.js";

/**
 * Integration test for Stage 1 of `commitment_kernel_policy_gate_full.plan.md`
 * (Bug D — clarification over-blocking). Asserts that `runTurnDecision`
 * downgrades a legacy classifier `clarification_needed: publish target`
 * outcome to `answer` when the kernel-side `SemanticIntent` carries an
 * explicit local-deployment signal, and preserves clarify when no such signal
 * is present.
 *
 * The downgrade is observable through the production decision's `taskContract`
 * (`primaryOutcome="answer"`, `interactionMode="respond_only"`) and through
 * the trace marker `decisionTrace.clarificationPolicy.downgradeReason`.
 */

const TG: ChannelId = "telegram" as ChannelId;
const PUBLISH_FAMILY: EffectFamilyId = "publish" as EffectFamilyId;

const CLARIFY_CONTRACT: TaskContract = {
  primaryOutcome: "clarification_needed",
  requiredCapabilities: [],
  interactionMode: "clarify_first",
  confidence: 0.7,
  ambiguities: ["external operation is inferred without an explicit publish target"],
};

function cfg(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        embeddedPi: {
          taskClassifier: { backend: "legacy-mock" },
          intentContractor: { backend: "intent-mock" },
          commitment: { cutoverEnabled: true },
        },
      },
    },
  } as OpenClawConfig;
}

function legacyAdapter(): TaskClassifierAdapter {
  return { classify: vi.fn(async () => CLARIFY_CONTRACT) };
}

function intentAdapter(intent: SemanticIntent): IntentContractorAdapter {
  return { classify: vi.fn(async () => intent) };
}

function intent(target: TargetRef, operation: OperationHint, constraints: Record<string, unknown> = {}): SemanticIntent {
  return {
    desiredEffectFamily: PUBLISH_FAMILY,
    target,
    operation,
    constraints,
    uncertainty: [],
    confidence: 0.9,
  };
}

function attestation(satisfied: boolean): RuntimeAttestation {
  return {
    commitmentSatisfied: satisfied,
    terminalState: satisfied ? "action_completed" : "rejected",
    acceptanceReason: satisfied ? "commitment_satisfied" : "commitment_unsatisfied",
    stateBefore: {},
    stateAfter: {},
    satisfaction: satisfied
      ? { satisfied: true, evidence: [] }
      : { satisfied: false, missing: ["delivery_receipt_missing"] },
  };
}

type ClarificationTraceMarker = { readonly downgradeReason: "ambiguity_resolved_by_intent" };

function readClarificationMarker(
  result: Awaited<ReturnType<typeof runTurnDecision>>,
): ClarificationTraceMarker | undefined {
  return (
    result.productionDecision.plannerInput.decisionTrace as
      | { readonly clarificationPolicy?: ClarificationTraceMarker }
      | undefined
  )?.clarificationPolicy;
}

describe("runTurnDecision Stage 1 — clarification downgrade", () => {
  it("downgrades legacy clarify-first to answer/respond_only when intent.target=workspace", async () => {
    const result = await runTurnDecision({
      prompt: "Поправь код в репозитории и прогони нужные проверки локально перед завершением.",
      cfg: cfg(),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(intent({ kind: "workspace" }, { kind: "create" })),
      },
    });

    expect(result.legacyDecision.taskContract.primaryOutcome).toBe("clarification_needed");
    expect(result.legacyDecision.taskContract.interactionMode).toBe("clarify_first");

    expect(result.productionDecision.taskContract.primaryOutcome).toBe("answer");
    expect(result.productionDecision.taskContract.interactionMode).toBe("respond_only");
    expect(result.productionDecision.plannerInput.lowConfidenceStrategy).toBeUndefined();
    expect(readClarificationMarker(result)).toEqual({
      downgradeReason: "ambiguity_resolved_by_intent",
    });
  });

  it("downgrades when intent.constraints.hosting='local'", async () => {
    const result = await runTurnDecision({
      prompt: "Опубликуй это",
      cfg: cfg(),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(
          intent({ kind: "external_channel", channelId: TG }, { kind: "create" }, { hosting: "local" }),
        ),
      },
    });

    expect(result.productionDecision.taskContract.primaryOutcome).toBe("answer");
    expect(readClarificationMarker(result)?.downgradeReason).toBe("ambiguity_resolved_by_intent");
  });

  it("preserves legacy clarify when intent has no local signal", async () => {
    const result = await runTurnDecision({
      prompt: "Опубликуй это",
      cfg: cfg(),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(
          intent({ kind: "external_channel", channelId: TG }, { kind: "create" }),
        ),
      },
    });

    expect(result.productionDecision.taskContract.primaryOutcome).toBe("clarification_needed");
    expect(result.productionDecision.taskContract.interactionMode).toBe("clarify_first");
    expect(result.productionDecision.plannerInput.lowConfidenceStrategy).toBe("clarify");
    expect(readClarificationMarker(result)).toBeUndefined();
  });

  it("preserves legacy clarify when blocking reason is non-deployment (credentials/permissions)", async () => {
    const credentialsContract: TaskContract = {
      primaryOutcome: "clarification_needed",
      requiredCapabilities: [],
      interactionMode: "clarify_first",
      confidence: 0.7,
      ambiguities: ["credentials missing for external_delivery"],
    };
    const result = await runTurnDecision({
      prompt: "Опубликуй это локально",
      cfg: cfg(),
      classifierAdapterRegistry: { "legacy-mock": { classify: vi.fn(async () => credentialsContract) } },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(intent({ kind: "workspace" }, { kind: "create" })),
      },
    });

    expect(result.productionDecision.taskContract.primaryOutcome).toBe("clarification_needed");
    expect(readClarificationMarker(result)).toBeUndefined();
  });

  it("delegates to caller-supplied ClarificationPolicyReader override (DI surface)", async () => {
    const evaluate = vi.fn(async () => ({ shouldClarify: false as const, downgradeReason: "ambiguity_resolved_by_intent" as const }));
    const result = await runTurnDecision({
      prompt: "irrelevant",
      cfg: cfg(),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(
          intent({ kind: "external_channel", channelId: TG }, { kind: "create" }),
        ),
      },
      clarificationPolicy: { evaluate },
    });

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(result.productionDecision.taskContract.primaryOutcome).toBe("answer");
  });

  it("does not consult the gate when the legacy decision is not clarify-first", async () => {
    const answerContract: TaskContract = {
      primaryOutcome: "answer",
      requiredCapabilities: [],
      interactionMode: "respond_only",
      confidence: 0.9,
      ambiguities: [],
    };
    const evaluate = vi.fn(async () => ({ shouldClarify: false as const, downgradeReason: "ambiguity_resolved_by_intent" as const }));

    const result = await runTurnDecision({
      prompt: "Hello",
      cfg: cfg(),
      classifierAdapterRegistry: { "legacy-mock": { classify: vi.fn(async () => answerContract) } },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(intent({ kind: "workspace" }, { kind: "create" })),
      },
      clarificationPolicy: { evaluate },
    });

    expect(evaluate).not.toHaveBeenCalled();
    expect(result.productionDecision.taskContract.primaryOutcome).toBe("answer");
    expect(readClarificationMarker(result)).toBeUndefined();
  });

  it("never overrides a kernel-derived production decision (invariant #3 priority)", async () => {
    // Kernel-derived path: persistent_session.created with successful runtime attestation.
    // The production decision is kernel-source-of-truth; clarification gate must not run.
    const sessionAffordances = createAffordanceRegistry([PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY]);
    const sessionIntent: SemanticIntent = {
      desiredEffectFamily: PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY.effectFamily,
      target: { kind: "session" },
      operation: { kind: "create" },
      constraints: { displayName: "Валера" },
      uncertainty: [],
      confidence: 0.9,
    };
    const sessionDelta: ExpectedDelta = {
      sessions: {
        followupRegistry: {
          added: [{ sessionId: "session-abc" as SessionId, agentId: "agent-abc" as AgentId }],
        },
      },
    };

    const evaluate = vi.fn(async () => ({ shouldClarify: false as const, downgradeReason: "ambiguity_resolved_by_intent" as const }));
    const monitoredRuntime = { run: vi.fn(async () => attestation(true)) };

    const result = await runTurnDecision({
      prompt: "spawn persistent",
      cfg: cfg(),
      classifierAdapterRegistry: {
        "legacy-mock": { classify: vi.fn(async () => CLARIFY_CONTRACT) },
      },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(sessionIntent) },
      affordanceRegistry: sessionAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => sessionDelta,
      clarificationPolicy: { evaluate },
    });

    expect(result.kernelFallback).toBe(false);
    expect(evaluate).not.toHaveBeenCalled();
    expect(readClarificationMarker(result)).toBeUndefined();
  });

  it("preserves bit-identical legacy contract when clarification gate does not engage", async () => {
    const noLocalIntent = intent(
      { kind: "external_channel", channelId: TG },
      { kind: "create" },
      { deploymentTarget: "remote" },
    );
    const result = await runTurnDecision({
      prompt: "Опубликуй на удалённый сервер",
      cfg: cfg(),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(noLocalIntent) },
    });

    expect(result.productionDecision.taskContract).toEqual(result.legacyDecision.taskContract);
    expect(result.productionDecision.plannerInput.lowConfidenceStrategy).toBe(
      result.legacyDecision.plannerInput.lowConfidenceStrategy,
    );
  });
});
