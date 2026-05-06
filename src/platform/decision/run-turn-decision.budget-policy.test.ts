import { describe, expect, it, vi } from "vitest";

import type { OpenClawConfig } from "../../config/config.js";
import {
  PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
  createAffordanceRegistry,
  type ApprovalPolicyDecision,
  type ApprovalPolicyEvaluateInput,
  type ApprovalPolicyReader,
  type ApprovalRequestId,
  type BudgetPolicyDecision,
  type BudgetPolicyEvaluateInput,
  type BudgetPolicyReader,
  type BudgetWindowId,
  type ExpectedDelta,
  type IntentContractorAdapter,
  type RuntimeAttestation,
  type SemanticIntent,
} from "../commitment/index.js";
import type { AgentId, SessionId } from "../commitment/ids.js";
import { asIdentityId } from "../identity/identity-id.js";
import { runTurnDecision } from "./run-turn-decision.js";
import type { PolicyBudgetDenialMarker } from "./trace.js";
import type { TaskClassifierAdapter, TaskContract } from "./task-classifier.js";

/**
 * Phase 4 wiring test for `commitment_kernel_policy_gate_full.plan.md`
 * Stage 3 (Budgets). Verifies that `runTurnDecision`:
 *   (a) consults the injected `budgetPolicy` only on the
 *       kernel-derived production-decision path,
 *   (b) on `within=false` overlays the production decision with
 *       `taskContract.primaryOutcome="answer"` +
 *       `interactionMode="respond_only"` and writes the
 *       `policyBudgetDenial` trace marker carrying the windowId,
 *   (c) on `within=true` leaves the production decision untouched,
 *   (d) skips the budget gate when the upstream Approval gate
 *       already denied (so the per-user counter does not
 *       over-charge for an effect that will not execute).
 *
 * Log-line + episodic emission are tested in
 * `src/platform/commitment/__tests__/budget-policy.test.ts` — this
 * file scopes to the wiring seam itself.
 */

const VLADIMIR = asIdentityId("identity:vladimir");

const ANSWER_CONTRACT: TaskContract = {
  primaryOutcome: "answer",
  requiredCapabilities: [],
  interactionMode: "respond_only",
  confidence: 0.9,
  ambiguities: [],
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
  return { classify: vi.fn(async () => ANSWER_CONTRACT) };
}

function intentAdapter(intent: SemanticIntent): IntentContractorAdapter {
  return { classify: vi.fn(async () => intent) };
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

function persistentSessionFixtures(): {
  intent: SemanticIntent;
  delta: ExpectedDelta;
} {
  return {
    intent: {
      desiredEffectFamily: PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY.effectFamily,
      target: { kind: "session" },
      operation: { kind: "create" },
      constraints: { displayName: "Vlad" },
      uncertainty: [],
      confidence: 0.9,
    },
    delta: {
      sessions: {
        followupRegistry: {
          added: [{ sessionId: "session-abc" as SessionId, agentId: "agent-abc" as AgentId }],
        },
      },
    },
  };
}

function readBudgetMarker(
  result: Awaited<ReturnType<typeof runTurnDecision>>,
): PolicyBudgetDenialMarker | undefined {
  const trace = result.productionDecision.plannerInput.decisionTrace as
    | { readonly policyBudgetDenial?: PolicyBudgetDenialMarker }
    | undefined;
  return trace?.policyBudgetDenial;
}

function denyingBudget(windowId: string, used = 5, limit = 4): {
  reader: BudgetPolicyReader;
  evaluate: ReturnType<typeof vi.fn>;
} {
  const evaluate = vi.fn(
    async (_params: BudgetPolicyEvaluateInput): Promise<BudgetPolicyDecision> => ({
      within: false,
      reason: "budget_exceeded_user",
      windowId: windowId as unknown as BudgetWindowId,
      used,
      limit,
    }),
  );
  return { reader: { evaluate }, evaluate };
}

function allowingBudget(): {
  reader: BudgetPolicyReader;
  evaluate: ReturnType<typeof vi.fn>;
} {
  const evaluate = vi.fn(
    async (_params: BudgetPolicyEvaluateInput): Promise<BudgetPolicyDecision> => ({
      within: true,
      remaining: 10,
    }),
  );
  return { reader: { evaluate }, evaluate };
}

function denyingApproval(approvalRequestId: string): ApprovalPolicyReader {
  const evaluate = vi.fn(
    async (_params: ApprovalPolicyEvaluateInput): Promise<ApprovalPolicyDecision> => ({
      approved: false,
      reason: "requires_approval",
      approvalRequestId: approvalRequestId as unknown as ApprovalRequestId,
    }),
  );
  return { evaluate };
}

describe("runTurnDecision Phase 4 — Stage 3 Budgets wiring", () => {
  it("(a)+(b) blocks the kernel-derived production decision on budget denial and attaches the policyBudgetDenial marker", async () => {
    const { intent, delta } = persistentSessionFixtures();
    const sessionAffordances = createAffordanceRegistry([
      PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = { run: vi.fn(async () => attestation(true)) };
    const { reader, evaluate } = denyingBudget("budget:user:identity:vladimir:1700000000", 6, 5);

    const result = await runTurnDecision({
      prompt: "spawn persistent",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(intent) },
      affordanceRegistry: sessionAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => delta,
      budgetPolicy: reader,
    });

    // Kernel-derived path engaged.
    expect(result.kernelFallback).toBe(false);
    // Budget gate consulted exactly once with the kernel-derived
    // EffectId + identity + channel.
    expect(evaluate).toHaveBeenCalledTimes(1);
    const call = evaluate.mock.calls[0]![0] as BudgetPolicyEvaluateInput;
    expect(call.identityId).toBe(VLADIMIR);
    expect(typeof call.effectId).toBe("string");
    expect(typeof call.channel).toBe("string");

    // Production decision downgraded to answer/respond_only with marker.
    expect(result.productionDecision.taskContract.primaryOutcome).toBe("answer");
    expect(result.productionDecision.taskContract.interactionMode).toBe("respond_only");
    expect(result.productionDecision.plannerInput.lowConfidenceStrategy).toBeUndefined();
    const marker = readBudgetMarker(result);
    expect(marker?.stage).toBe("budget");
    expect(marker?.reason).toBe("budget_exceeded_user");
    expect(marker?.windowId).toBe("budget:user:identity:vladimir:1700000000");
    expect(marker?.used).toBe(6);
    expect(marker?.limit).toBe(5);
  });

  it("(c) leaves the production decision untouched when budgetPolicy returns within=true", async () => {
    const { intent, delta } = persistentSessionFixtures();
    const sessionAffordances = createAffordanceRegistry([
      PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = { run: vi.fn(async () => attestation(true)) };
    const { reader, evaluate } = allowingBudget();

    const result = await runTurnDecision({
      prompt: "spawn persistent",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(intent) },
      affordanceRegistry: sessionAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => delta,
      budgetPolicy: reader,
    });

    expect(result.kernelFallback).toBe(false);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(readBudgetMarker(result)).toBeUndefined();
  });

  it("(d) does NOT consult budgetPolicy when the upstream approval gate already denied", async () => {
    const { intent, delta } = persistentSessionFixtures();
    const sessionAffordances = createAffordanceRegistry([
      PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = { run: vi.fn(async () => attestation(true)) };
    const approvalReader = denyingApproval("approval-pre-deny");
    const { reader: budgetReader, evaluate: budgetEvaluate } = denyingBudget(
      "budget:user:vlad:0",
    );

    const result = await runTurnDecision({
      prompt: "spawn persistent",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(intent) },
      affordanceRegistry: sessionAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => delta,
      approvalPolicy: approvalReader,
      budgetPolicy: budgetReader,
    });

    expect(result.kernelFallback).toBe(false);
    // Budget evaluator MUST NOT be called when approval already denied.
    expect(budgetEvaluate).not.toHaveBeenCalled();
    // Budget marker absent; approval marker present (chain order).
    expect(readBudgetMarker(result)).toBeUndefined();
  });

  it("does NOT consult budgetPolicy on the legacy-fallback path", async () => {
    const { reader, evaluate } = denyingBudget("budget:user:vlad:0");
    const result = await runTurnDecision({
      prompt: "Hello",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter({
          desiredEffectFamily: PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY.effectFamily,
          target: { kind: "workspace" },
          operation: { kind: "create" },
          constraints: {},
          uncertainty: [],
          confidence: 0.9,
        }),
      },
      budgetPolicy: reader,
    });

    expect(result.kernelFallback).toBe(true);
    expect(evaluate).not.toHaveBeenCalled();
    expect(readBudgetMarker(result)).toBeUndefined();
  });

  it("is a no-op when budgetPolicy is omitted (default-allow)", async () => {
    const { intent, delta } = persistentSessionFixtures();
    const sessionAffordances = createAffordanceRegistry([
      PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = { run: vi.fn(async () => attestation(true)) };

    const result = await runTurnDecision({
      prompt: "spawn persistent",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(intent) },
      affordanceRegistry: sessionAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => delta,
    });

    expect(result.kernelFallback).toBe(false);
    expect(readBudgetMarker(result)).toBeUndefined();
  });
});
