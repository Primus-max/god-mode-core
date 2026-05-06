import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { AgentId, SessionId } from "../commitment/ids.js";
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
  type RoleId,
  type RolePolicyDecision,
  type RolePolicyEvaluateInput,
  type RolePolicyReader,
  type RuntimeAttestation,
  type SemanticIntent,
} from "../commitment/index.js";
import { asIdentityId } from "../identity/identity-id.js";
import { runTurnDecision } from "./run-turn-decision.js";
import type { TaskClassifierAdapter, TaskContract } from "./task-classifier.js";
import type { PolicyRoleDenialMarker } from "./trace.js";

/**
 * Phase 5 wiring test for `commitment_kernel_policy_gate_full.plan.md`
 * Stage 4 (Role-based access). Verifies that `runTurnDecision`:
 *   (a) consults the injected `rolePolicy` only on the kernel-derived
 *       production-decision path,
 *   (b) on `allowed=false` overlays the production decision with
 *       `taskContract.primaryOutcome="answer"` +
 *       `interactionMode="respond_only"` and writes the
 *       `policyRoleDenial` trace marker carrying `requiredRole`,
 *   (c) on `allowed=true` leaves the production decision untouched,
 *   (d) skips the role gate when the upstream Approval gate already
 *       denied (avoid double-emit of episodic events for an effect
 *       that will not execute),
 *   (e) skips the role gate when the upstream Budget gate already
 *       denied (same rationale).
 *
 * Log-line + episodic emission are tested in
 * `src/platform/commitment/__tests__/role-policy.test.ts` — this file
 * scopes to the wiring seam itself.
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

function readRoleMarker(
  result: Awaited<ReturnType<typeof runTurnDecision>>,
): PolicyRoleDenialMarker | undefined {
  const trace = result.productionDecision.plannerInput.decisionTrace as
    | { readonly policyRoleDenial?: PolicyRoleDenialMarker }
    | undefined;
  return trace?.policyRoleDenial;
}

function denyingRole(requiredRole: string): {
  reader: RolePolicyReader;
  evaluate: ReturnType<typeof vi.fn>;
} {
  const evaluate = vi.fn(
    async (_params: RolePolicyEvaluateInput): Promise<RolePolicyDecision> => ({
      allowed: false,
      reason: "role_denied",
      requiredRole: requiredRole as unknown as RoleId,
    }),
  );
  return { reader: { evaluate }, evaluate };
}

function allowingRole(role: string): {
  reader: RolePolicyReader;
  evaluate: ReturnType<typeof vi.fn>;
} {
  const evaluate = vi.fn(
    async (_params: RolePolicyEvaluateInput): Promise<RolePolicyDecision> => ({
      allowed: true,
      role: role as unknown as RoleId,
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

function denyingBudget(windowId: string, used = 5, limit = 4): BudgetPolicyReader {
  const evaluate = vi.fn(
    async (_params: BudgetPolicyEvaluateInput): Promise<BudgetPolicyDecision> => ({
      within: false,
      reason: "budget_exceeded_user",
      windowId: windowId as unknown as BudgetWindowId,
      used,
      limit,
    }),
  );
  return { evaluate };
}

describe("runTurnDecision Phase 5 — Stage 4 Role-based wiring", () => {
  it("(a)+(b) blocks the kernel-derived production decision on role denial and attaches the policyRoleDenial marker", async () => {
    const { intent, delta } = persistentSessionFixtures();
    const sessionAffordances = createAffordanceRegistry([
      PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = { run: vi.fn(async () => attestation(true)) };
    const { reader, evaluate } = denyingRole("admin");

    const result = await runTurnDecision({
      prompt: "spawn persistent",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(intent) },
      affordanceRegistry: sessionAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => delta,
      rolePolicy: reader,
    });

    // Kernel-derived path engaged.
    expect(result.kernelFallback).toBe(false);
    // Role gate consulted exactly once with the kernel-derived
    // EffectId + identity.
    expect(evaluate).toHaveBeenCalledTimes(1);
    const call = evaluate.mock.calls[0]![0] as RolePolicyEvaluateInput;
    expect(call.identityId).toBe(VLADIMIR);
    expect(typeof call.effectId).toBe("string");

    // Production decision downgraded to answer/respond_only with marker.
    expect(result.productionDecision.taskContract.primaryOutcome).toBe("answer");
    expect(result.productionDecision.taskContract.interactionMode).toBe("respond_only");
    expect(result.productionDecision.plannerInput.lowConfidenceStrategy).toBeUndefined();
    const marker = readRoleMarker(result);
    expect(marker?.stage).toBe("role");
    expect(marker?.reason).toBe("role_denied");
    expect(marker?.requiredRole).toBe("admin");
  });

  it("(c) leaves the production decision untouched when rolePolicy returns allowed=true", async () => {
    const { intent, delta } = persistentSessionFixtures();
    const sessionAffordances = createAffordanceRegistry([
      PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = { run: vi.fn(async () => attestation(true)) };
    const { reader, evaluate } = allowingRole("user");

    const result = await runTurnDecision({
      prompt: "spawn persistent",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(intent) },
      affordanceRegistry: sessionAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => delta,
      rolePolicy: reader,
    });

    expect(result.kernelFallback).toBe(false);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(readRoleMarker(result)).toBeUndefined();
  });

  it("(d) does NOT consult rolePolicy when the upstream approval gate already denied", async () => {
    const { intent, delta } = persistentSessionFixtures();
    const sessionAffordances = createAffordanceRegistry([
      PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = { run: vi.fn(async () => attestation(true)) };
    const approvalReader = denyingApproval("approval-pre-deny");
    const { reader: roleReader, evaluate: roleEvaluate } = denyingRole("admin");

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
      rolePolicy: roleReader,
    });

    expect(result.kernelFallback).toBe(false);
    // Role evaluator MUST NOT be called when approval already denied.
    expect(roleEvaluate).not.toHaveBeenCalled();
    expect(readRoleMarker(result)).toBeUndefined();
  });

  it("(e) does NOT consult rolePolicy when the upstream budget gate already denied", async () => {
    const { intent, delta } = persistentSessionFixtures();
    const sessionAffordances = createAffordanceRegistry([
      PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = { run: vi.fn(async () => attestation(true)) };
    const budgetReader = denyingBudget("budget:user:vlad:0", 5, 4);
    const { reader: roleReader, evaluate: roleEvaluate } = denyingRole("admin");

    const result = await runTurnDecision({
      prompt: "spawn persistent",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(intent) },
      affordanceRegistry: sessionAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => delta,
      budgetPolicy: budgetReader,
      rolePolicy: roleReader,
    });

    expect(result.kernelFallback).toBe(false);
    // Role evaluator MUST NOT be called when budget already denied.
    expect(roleEvaluate).not.toHaveBeenCalled();
    expect(readRoleMarker(result)).toBeUndefined();
  });

  it("does NOT consult rolePolicy on the legacy-fallback path", async () => {
    const { reader, evaluate } = denyingRole("admin");
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
      rolePolicy: reader,
    });

    expect(result.kernelFallback).toBe(true);
    expect(evaluate).not.toHaveBeenCalled();
    expect(readRoleMarker(result)).toBeUndefined();
  });

  it("is a no-op when rolePolicy is omitted (default-allow)", async () => {
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
    expect(readRoleMarker(result)).toBeUndefined();
  });
});
