import { describe, expect, it, vi } from "vitest";

import type { OpenClawConfig } from "../../config/config.js";
import {
  PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
  createAffordanceRegistry,
  type ApprovalPolicyDecision,
  type ApprovalPolicyEvaluateInput,
  type ApprovalPolicyReader,
  type ApprovalRequestId,
  type ExpectedDelta,
  type IntentContractorAdapter,
  type RuntimeAttestation,
  type SemanticIntent,
} from "../commitment/index.js";
import type { AgentId, SessionId } from "../commitment/ids.js";
import { asIdentityId } from "../identity/identity-id.js";
import { runTurnDecision } from "./run-turn-decision.js";
import type { PolicyApprovalDenialMarker } from "./trace.js";
import type { TaskClassifierAdapter, TaskContract } from "./task-classifier.js";

/**
 * Phase 3 wiring test for `commitment_kernel_policy_gate_full.plan.md`
 * Stage 2 (Approvals). Verifies that `runTurnDecision`:
 *  (a) consults the injected `approvalPolicy` only on the
 *      kernel-derived production-decision path,
 *  (b) on `approved=false` overlays the production decision with
 *      `taskContract.primaryOutcome="answer"` +
 *      `interactionMode="respond_only"` and writes the
 *      `policyApprovalDenial` trace marker,
 *  (c) on `approved=true` leaves the production decision untouched.
 *
 * Log-line + episodic emission are tested in
 * `src/platform/commitment/__tests__/approval-policy.test.ts` — this
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

function readApprovalMarker(
  result: Awaited<ReturnType<typeof runTurnDecision>>,
): PolicyApprovalDenialMarker | undefined {
  const trace = result.productionDecision.plannerInput.decisionTrace as
    | { readonly policyApprovalDenial?: PolicyApprovalDenialMarker }
    | undefined;
  return trace?.policyApprovalDenial;
}

function denyingPolicy(approvalRequestId: string): {
  reader: ApprovalPolicyReader;
  evaluate: ReturnType<typeof vi.fn>;
} {
  const evaluate = vi.fn(
    async (_params: ApprovalPolicyEvaluateInput): Promise<ApprovalPolicyDecision> => ({
      approved: false,
      reason: "requires_approval",
      approvalRequestId: approvalRequestId as unknown as ApprovalRequestId,
    }),
  );
  return { reader: { evaluate }, evaluate };
}

function allowingPolicy(): {
  reader: ApprovalPolicyReader;
  evaluate: ReturnType<typeof vi.fn>;
} {
  const evaluate = vi.fn(
    async (_params: ApprovalPolicyEvaluateInput): Promise<ApprovalPolicyDecision> => ({
      approved: true,
    }),
  );
  return { reader: { evaluate }, evaluate };
}

describe("runTurnDecision Phase 3 — Stage 2 Approvals wiring", () => {
  it("blocks the kernel-derived production decision on approval denial and attaches the policyApprovalDenial marker", async () => {
    const { intent, delta } = persistentSessionFixtures();
    const sessionAffordances = createAffordanceRegistry([
      PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = { run: vi.fn(async () => attestation(true)) };
    const { reader, evaluate } = denyingPolicy("approval-wired-001");

    const result = await runTurnDecision({
      prompt: "spawn persistent",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(intent) },
      affordanceRegistry: sessionAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => delta,
      approvalPolicy: reader,
    });

    // Kernel-derived path engaged.
    expect(result.kernelFallback).toBe(false);
    // Approval gate consulted exactly once with the kernel-derived
    // EffectId + identity.
    expect(evaluate).toHaveBeenCalledTimes(1);
    const call = evaluate.mock.calls[0]![0] as ApprovalPolicyEvaluateInput;
    expect(call.identityId).toBe(VLADIMIR);
    expect(typeof call.effectId).toBe("string");

    // Production decision downgraded to answer/respond_only with marker.
    expect(result.productionDecision.taskContract.primaryOutcome).toBe("answer");
    expect(result.productionDecision.taskContract.interactionMode).toBe("respond_only");
    expect(result.productionDecision.plannerInput.lowConfidenceStrategy).toBeUndefined();
    const marker = readApprovalMarker(result);
    expect(marker?.stage).toBe("approval");
    expect(marker?.reason).toBe("requires_approval");
    expect(marker?.approvalRequestId).toBe("approval-wired-001");
  });

  it("leaves the production decision untouched when approvalPolicy returns approved=true", async () => {
    const { intent, delta } = persistentSessionFixtures();
    const sessionAffordances = createAffordanceRegistry([
      PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = { run: vi.fn(async () => attestation(true)) };
    const { reader, evaluate } = allowingPolicy();

    const result = await runTurnDecision({
      prompt: "spawn persistent",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(intent) },
      affordanceRegistry: sessionAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => delta,
      approvalPolicy: reader,
    });

    expect(result.kernelFallback).toBe(false);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(readApprovalMarker(result)).toBeUndefined();
    // Kernel-derived contract is preserved (not collapsed to fallback).
    expect(result.productionDecision.taskContract.primaryOutcome).not.toBe("clarification_needed");
  });

  it("does NOT consult approvalPolicy on the legacy-fallback path", async () => {
    // No monitoredRuntime + no expectedDeltaResolver → legacy fallback.
    const { reader, evaluate } = denyingPolicy("approval-not-called");
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
      approvalPolicy: reader,
    });

    expect(result.kernelFallback).toBe(true);
    expect(evaluate).not.toHaveBeenCalled();
    expect(readApprovalMarker(result)).toBeUndefined();
  });

  it("is a no-op when approvalPolicy is omitted (default-allow)", async () => {
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
    expect(readApprovalMarker(result)).toBeUndefined();
  });
});
