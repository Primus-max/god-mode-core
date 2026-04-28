import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  ANSWER_DELIVERED_AFFORDANCE_ENTRY,
  CLARIFICATION_REQUESTED_AFFORDANCE_ENTRY,
  COMMUNICATION_EFFECT_FAMILY,
  EXTERNAL_EFFECT_PERFORMED_AFFORDANCE_ENTRY,
  PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
  POLICY_GATE_REASONS,
  createAffordanceRegistry,
  createPolicyGate,
  createShadowBuilder,
  defaultAffordanceRegistry,
  type DeliveryReceiptKind,
  type ExpectedDelta,
  type IntentContractorAdapter,
  type RuntimeAttestation,
  type ShadowBuilderLogger,
} from "../commitment/index.js";
import type { ChannelId, EffectId } from "../commitment/ids.js";
import type { OperationHint, SemanticIntent, TargetRef } from "../commitment/semantic-intent.js";
import type { CutoverGateTrace } from "./run-turn-decision.js";
import { runTurnDecision } from "./run-turn-decision.js";
import type { TaskClassifierAdapter, TaskContract } from "./task-classifier.js";

/**
 * Cutover-2 routing flip contract for Wave B (PR-4b, sub-plan §5 row a).
 *
 * Asserts that `runTurnDecision` derives `productionDecision` from the
 * commitment kernel for the three chat-bound effects when policy + runtime
 * succeed, and that the affordance branching factor on the communication
 * family is greater than 1 (G6.a, sub-plan §5 row c).
 *
 * Effects outside the cutover-2 pool stay legacy (bit-identical contract,
 * sub-plan §5 row d) — the cutover gate continues to record `gate_out` with
 * the matching reason. Anti-checklist §5.1.5 forbids reintroducing routing
 * for `persistent_session.created` here; that route is owned by Wave A.
 */

const TG: ChannelId = "telegram" as ChannelId;
const ANSWER_DELIVERED: EffectId = "answer.delivered" as EffectId;
const CLARIFICATION_REQUESTED: EffectId = "clarification_requested" as EffectId;
const EXTERNAL_EFFECT_PERFORMED: EffectId = "external_effect.performed" as EffectId;
const ARTIFACT_CREATED: EffectId = "artifact.created" as EffectId;

const legacyContract: TaskContract = {
  primaryOutcome: "answer",
  requiredCapabilities: [],
  interactionMode: "respond_only",
  confidence: 0.9,
  ambiguities: [],
};

const DELIVERY_KEY = "telegram:chat:42";

function deliveryDelta(kind: DeliveryReceiptKind): ExpectedDelta {
  return {
    deliveries: {
      receipts: {
        added: [{ deliveryContextKey: DELIVERY_KEY, kind }],
      },
    },
  };
}

function cfg(overrides: { cutoverEnabled?: boolean; channels?: Record<string, unknown> } = {}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        embeddedPi: {
          taskClassifier: { backend: "legacy-mock" },
          intentContractor: { backend: "intent-mock" },
          commitment: { cutoverEnabled: overrides.cutoverEnabled ?? true },
        },
      },
    },
    ...(overrides.channels ? { channels: overrides.channels } : {}),
  } as OpenClawConfig;
}

function legacyAdapter(): TaskClassifierAdapter {
  return { classify: vi.fn(async () => legacyContract) };
}

function intentAdapter(intent: SemanticIntent): IntentContractorAdapter {
  return { classify: vi.fn(async () => intent) };
}

function intent(target: TargetRef, operation: OperationHint): SemanticIntent {
  return {
    desiredEffectFamily: COMMUNICATION_EFFECT_FAMILY,
    target,
    operation,
    constraints: { deliveryContextKey: DELIVERY_KEY, channelId: TG },
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

function traceGate(result: Awaited<ReturnType<typeof runTurnDecision>>): CutoverGateTrace | undefined {
  return (
    result.productionDecision.plannerInput.decisionTrace as
      | { readonly cutoverGate?: CutoverGateTrace }
      | undefined
  )?.cutoverGate;
}

describe("runTurnDecision cutover-2 (Wave B chat effects)", () => {
  it.each([
    {
      effect: ANSWER_DELIVERED,
      semantic: intent({ kind: "external_channel", channelId: TG }, { kind: "create" }),
      kind: "answer" as DeliveryReceiptKind,
    },
    {
      effect: CLARIFICATION_REQUESTED,
      semantic: intent({ kind: "unspecified" }, { kind: "create" }),
      kind: "clarification" as DeliveryReceiptKind,
    },
    {
      effect: EXTERNAL_EFFECT_PERFORMED,
      semantic: intent({ kind: "external_channel", channelId: TG }, { kind: "observe" }),
      kind: "external_effect" as DeliveryReceiptKind,
    },
  ])(
    "routes $effect through the kernel when policy + runtime succeed",
    async ({ effect, semantic, kind }) => {
      const monitoredRuntime = {
        run: vi.fn(async () => attestation(true)),
      };

      const result = await runTurnDecision({
        prompt: "chat-bound delivery turn",
        cfg: cfg({ channels: { telegram: { enabled: true, botToken: "tg-bot-token" } } }),
        classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
        intentContractorAdapterRegistry: { "intent-mock": intentAdapter(semantic) },
        monitoredRuntime,
        expectedDeltaResolver: () => deliveryDelta(kind),
      });

      expect(result.cutoverGate).toEqual({
        kind: "gate_in_success",
        effect,
        terminalState: "action_completed",
        acceptanceReason: "commitment_satisfied",
      });
      expect(traceGate(result)).toEqual(result.cutoverGate);
      expect(result.kernelFallback).toBe(false);
      expect(result.fallbackReason).toBeUndefined();
      expect(result.productionDecision).not.toBe(result.legacyDecision);
      expect(monitoredRuntime.run).toHaveBeenCalledTimes(1);

      const productionTrace = result.productionDecision.plannerInput.decisionTrace as
        | { readonly kernelDerived?: { readonly sourceOfTruth: "kernel"; readonly effect: string } }
        | undefined;
      expect(productionTrace?.kernelDerived?.sourceOfTruth).toBe("kernel");
      expect(productionTrace?.kernelDerived?.effect).toBe(effect);
    },
  );

  it("falls back to legacy when the PolicyGate denies (e.g. channel_disabled)", async () => {
    const monitoredRuntime = {
      run: vi.fn(async () => attestation(true)),
    };
    const semantic = intent({ kind: "external_channel", channelId: TG }, { kind: "create" });

    const result = await runTurnDecision({
      prompt: "chat-bound delivery turn",
      cfg: cfg({ channels: { telegram: { enabled: false, botToken: "tg-bot-token" } } }),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(semantic) },
      monitoredRuntime,
      expectedDeltaResolver: () => deliveryDelta("answer"),
    });

    expect(result.cutoverGate.kind).toBe("gate_out");
    expect(result.kernelFallback).toBe(true);
    expect(result.fallbackReason).toBe("policy_blocked");
    expect(monitoredRuntime.run).not.toHaveBeenCalled();
  });

  it("keeps effects outside the cutover-2 pool legacy-bit-identical (sub-plan §5 row d)", async () => {
    const monitoredRuntime = {
      run: vi.fn(async () => attestation(true)),
    };

    const fixtureAffordances = createAffordanceRegistry([
      {
        ...PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
        effect: ARTIFACT_CREATED,
      },
    ]);

    const semantic: SemanticIntent = {
      desiredEffectFamily: PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY.effectFamily,
      target: { kind: "session" },
      operation: { kind: "create" },
      constraints: { displayName: "Out of pool" },
      uncertainty: [],
      confidence: 0.9,
    };

    const result = await runTurnDecision({
      prompt: "out-of-pool effect",
      cfg: cfg(),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(semantic) },
      affordanceRegistry: fixtureAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => deliveryDelta("answer"),
    });

    expect(result.cutoverGate).toEqual({
      kind: "gate_out",
      reason: "effect_not_eligible",
      effect: ARTIFACT_CREATED,
    });
    expect(result.kernelFallback).toBe(true);
    expect(result.productionDecision.taskContract).toEqual(result.legacyDecision.taskContract);
    expect(monitoredRuntime.run).not.toHaveBeenCalled();
  });
});

describe("affordance branching factor on the communication family (sub-plan §5 row c)", () => {
  it("logs branching_factor > 1 when the shadow builder resolves a chat-bound intent", async () => {
    const traceMessages: { message: string; fields?: Readonly<Record<string, unknown>> }[] = [];
    const logger: ShadowBuilderLogger = {
      trace: (message, fields) => {
        traceMessages.push({ message, ...(fields ? { fields } : {}) });
      },
    };

    const builder = createShadowBuilder({
      affordances: defaultAffordanceRegistry,
      policy: createPolicyGate({
        cfg: { channels: { telegram: { enabled: true, botToken: "tg-bot-token" } } } as OpenClawConfig,
      }),
      logger,
      confidenceThreshold: 0.5,
    });

    const result = await builder.build({
      desiredEffectFamily: COMMUNICATION_EFFECT_FAMILY,
      target: { kind: "external_channel", channelId: TG },
      constraints: { channelId: TG },
      uncertainty: [],
      confidence: 0.9,
    });

    expect(result.kind).toBe("unsupported");
    const traceEntry = traceMessages.find((m) => m.message === "commitment.shadow_builder");
    expect(traceEntry?.fields).toEqual({ affordance_branching_factor: 2 });
  });

  it("registry exposes three affordances under the communication family (G6.a structural canary)", () => {
    const ids = defaultAffordanceRegistry
      .all()
      .filter((entry) => entry.effectFamily === COMMUNICATION_EFFECT_FAMILY)
      .map((entry) => entry.id);
    expect(ids).toEqual([
      ANSWER_DELIVERED_AFFORDANCE_ENTRY.id,
      CLARIFICATION_REQUESTED_AFFORDANCE_ENTRY.id,
      EXTERNAL_EFFECT_PERFORMED_AFFORDANCE_ENTRY.id,
    ]);
    expect(ids.length).toBeGreaterThan(1);
  });
});

describe("PolicyGate scope discipline (sub-plan §5 row e — covers reverse-test from outside)", () => {
  it("never produces a fallbackReason outside the closed reason set when policy denies", async () => {
    const semantic = intent({ kind: "external_channel", channelId: TG }, { kind: "create" });
    const monitoredRuntime = {
      run: vi.fn(async () => attestation(true)),
    };

    const result = await runTurnDecision({
      prompt: "chat-bound delivery turn",
      cfg: cfg({ channels: { telegram: { enabled: false } } }),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(semantic) },
      monitoredRuntime,
      expectedDeltaResolver: () => deliveryDelta("answer"),
    });

    expect(result.kernelFallback).toBe(true);
    expect(result.fallbackReason).toBe("policy_blocked");
    expect(POLICY_GATE_REASONS).toContain("channel_disabled");
    expect(POLICY_GATE_REASONS).toContain("no_credentials");
    expect(POLICY_GATE_REASONS).toHaveLength(2);
  });
});
