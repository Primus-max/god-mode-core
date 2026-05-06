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
  type EscalationHook,
  type EscalationHookDecision,
  type EscalationHookFireInput,
  type ExpectedDelta,
  type IntentContractorAdapter,
  type RetryPolicyDecision,
  type RetryPolicyEvaluateInput,
  type RetryPolicyReader,
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
import type {
  PolicyApprovalDenialMarker,
  PolicyBudgetDenialMarker,
  PolicyEscalationFiredMarker,
  PolicyRetryDenialMarker,
  PolicyRoleDenialMarker,
} from "./trace.js";

/**
 * Phase 7 wiring test for `commitment_kernel_policy_gate_full.plan.md`
 * Stage 6 (Escalation hooks). Verifies that `runTurnDecision`:
 *   (a) on `approvalDenied` → escalation fires with denialReason='requires_approval'.
 *   (b) on `budgetDenied`   → escalation fires with corresponding budget reason.
 *   (c) on `roleDenied`     → escalation fires with 'role_denied'.
 *   (d) on `retryDenied`    → escalation fires with 'retry_limit_exceeded'.
 *   (e) escalation failure  → production decision still downgrades; escalation
 *                              is observability, not gating.
 *   (f) omitted hook        → decision flows through cleanly.
 *
 * Log + episodic emission are tested in
 * `src/platform/commitment/__tests__/escalation-hook.test.ts` — this
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

function readEscalationMarker(
  result: Awaited<ReturnType<typeof runTurnDecision>>,
): PolicyEscalationFiredMarker | undefined {
  const trace = result.productionDecision.plannerInput.decisionTrace as
    | { readonly policyEscalationFired?: PolicyEscalationFiredMarker }
    | undefined;
  return trace?.policyEscalationFired;
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

function denyingBudget(windowId: string): BudgetPolicyReader {
  const evaluate = vi.fn(
    async (_params: BudgetPolicyEvaluateInput): Promise<BudgetPolicyDecision> => ({
      within: false,
      reason: "budget_exceeded_user",
      windowId: windowId as unknown as BudgetWindowId,
      used: 5,
      limit: 4,
    }),
  );
  return { evaluate };
}

function denyingRole(requiredRole: string): RolePolicyReader {
  const evaluate = vi.fn(
    async (_params: RolePolicyEvaluateInput): Promise<RolePolicyDecision> => ({
      allowed: false,
      reason: "role_denied",
      requiredRole: requiredRole as unknown as RoleId,
    }),
  );
  return { evaluate };
}

function denyingRetry(): RetryPolicyReader {
  const evaluate = vi.fn(
    async (_params: RetryPolicyEvaluateInput): Promise<RetryPolicyDecision> => ({
      retry: false,
      reason: "retry_limit_exceeded",
      attemptCount: 3,
      maxAttempts: 3,
    }),
  );
  return { evaluate };
}

function recordingHook(): {
  hook: EscalationHook;
  fire: ReturnType<typeof vi.fn>;
} {
  const fire = vi.fn(
    async (params: EscalationHookFireInput): Promise<EscalationHookDecision> => ({
      fired: true,
      escalationId: `escalation-${String(params.denialReason)}`,
    }),
  );
  return { hook: { fire }, fire };
}

function failingHook(message: string): {
  hook: EscalationHook;
  fire: ReturnType<typeof vi.fn>;
} {
  const fire = vi.fn(
    async (): Promise<EscalationHookDecision> => ({
      fired: false,
      reason: "escalation_failed",
      error: new Error(message),
    }),
  );
  return { hook: { fire }, fire };
}

describe("runTurnDecision Phase 7 — Stage 6 Escalation hook wiring", () => {
  it("(a) fires escalation with denialReason='requires_approval' on approval denial", async () => {
    const { intent, delta } = persistentSessionFixtures();
    const sessionAffordances = createAffordanceRegistry([
      PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = { run: vi.fn(async () => attestation(true)) };
    const { hook, fire } = recordingHook();

    const result = await runTurnDecision({
      prompt: "spawn persistent",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(intent) },
      affordanceRegistry: sessionAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => delta,
      approvalPolicy: denyingApproval("approval-001"),
      escalationHook: hook,
    });

    expect(result.kernelFallback).toBe(false);
    expect(fire).toHaveBeenCalledTimes(1);
    const params = fire.mock.calls[0]![0] as EscalationHookFireInput;
    expect(params.denialReason).toBe("requires_approval");
    expect(params.identityId).toBe(VLADIMIR);

    // Trace marker carries the fired escalation id + denial reason.
    const marker = readEscalationMarker(result);
    expect(marker).toBeDefined();
    expect(marker?.denialReason).toBe("requires_approval");
    expect(marker?.escalationId).toBe("escalation-requires_approval");
  });

  it("(b) fires escalation with budget reason on budget denial", async () => {
    const { intent, delta } = persistentSessionFixtures();
    const sessionAffordances = createAffordanceRegistry([
      PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = { run: vi.fn(async () => attestation(true)) };
    const { hook, fire } = recordingHook();

    const result = await runTurnDecision({
      prompt: "spawn persistent",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(intent) },
      affordanceRegistry: sessionAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => delta,
      budgetPolicy: denyingBudget("budget:user:vlad:0"),
      escalationHook: hook,
    });

    expect(result.kernelFallback).toBe(false);
    expect(fire).toHaveBeenCalledTimes(1);
    const params = fire.mock.calls[0]![0] as EscalationHookFireInput;
    expect(params.denialReason).toBe("budget_exceeded_user");

    const marker = readEscalationMarker(result);
    expect(marker?.denialReason).toBe("budget_exceeded_user");
  });

  it("(c) fires escalation with reason='role_denied' on role denial", async () => {
    const { intent, delta } = persistentSessionFixtures();
    const sessionAffordances = createAffordanceRegistry([
      PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = { run: vi.fn(async () => attestation(true)) };
    const { hook, fire } = recordingHook();

    const result = await runTurnDecision({
      prompt: "spawn persistent",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(intent) },
      affordanceRegistry: sessionAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => delta,
      rolePolicy: denyingRole("admin"),
      escalationHook: hook,
    });

    expect(result.kernelFallback).toBe(false);
    expect(fire).toHaveBeenCalledTimes(1);
    const params = fire.mock.calls[0]![0] as EscalationHookFireInput;
    expect(params.denialReason).toBe("role_denied");

    const marker = readEscalationMarker(result);
    expect(marker?.denialReason).toBe("role_denied");
  });

  it("(d) fires escalation with reason='retry_limit_exceeded' on retry denial", async () => {
    const { intent, delta } = persistentSessionFixtures();
    const sessionAffordances = createAffordanceRegistry([
      PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = { run: vi.fn(async () => attestation(true)) };
    const { hook, fire } = recordingHook();

    const result = await runTurnDecision({
      prompt: "spawn persistent",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(intent) },
      affordanceRegistry: sessionAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => delta,
      retryPolicy: denyingRetry(),
      escalationHook: hook,
    });

    expect(result.kernelFallback).toBe(false);
    expect(fire).toHaveBeenCalledTimes(1);
    const params = fire.mock.calls[0]![0] as EscalationHookFireInput;
    expect(params.denialReason).toBe("retry_limit_exceeded");

    const marker = readEscalationMarker(result);
    expect(marker?.denialReason).toBe("retry_limit_exceeded");
  });

  it("(e) escalation failure does NOT block the policy-denial downgrade", async () => {
    const { intent, delta } = persistentSessionFixtures();
    const sessionAffordances = createAffordanceRegistry([
      PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = { run: vi.fn(async () => attestation(true)) };
    const { hook, fire } = failingHook("transport_error: sqlite locked");

    const result = await runTurnDecision({
      prompt: "spawn persistent",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(intent) },
      affordanceRegistry: sessionAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => delta,
      rolePolicy: denyingRole("admin"),
      escalationHook: hook,
    });

    expect(fire).toHaveBeenCalledTimes(1);
    // Production decision still carries the role-denial downgrade.
    expect(result.productionDecision.taskContract.primaryOutcome).toBe("answer");
    expect(result.productionDecision.taskContract.interactionMode).toBe("respond_only");
    const trace = result.productionDecision.plannerInput.decisionTrace as
      | { readonly policyRoleDenial?: PolicyRoleDenialMarker }
      | undefined;
    expect(trace?.policyRoleDenial?.reason).toBe("role_denied");
    // No escalation marker on failed fire.
    expect(readEscalationMarker(result)).toBeUndefined();
  });

  it("(f) hook omitted → no escalation fires; production decision flows through unchanged", async () => {
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
      // No escalationHook
      rolePolicy: denyingRole("admin"),
    });

    // Role denial still flows through.
    const trace = result.productionDecision.plannerInput.decisionTrace as
      | { readonly policyRoleDenial?: PolicyRoleDenialMarker }
      | undefined;
    expect(trace?.policyRoleDenial?.reason).toBe("role_denied");
    expect(readEscalationMarker(result)).toBeUndefined();
  });

  it("does NOT call the hook when no policy denial occurred", async () => {
    const { intent, delta } = persistentSessionFixtures();
    const sessionAffordances = createAffordanceRegistry([
      PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = { run: vi.fn(async () => attestation(true)) };
    const { hook, fire } = recordingHook();

    const result = await runTurnDecision({
      prompt: "spawn persistent",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(intent) },
      affordanceRegistry: sessionAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => delta,
      escalationHook: hook,
    });

    expect(result.kernelFallback).toBe(false);
    expect(fire).not.toHaveBeenCalled();
    expect(readEscalationMarker(result)).toBeUndefined();
  });

  it("threads turnId through the fire input (using result.traceId as turn anchor)", async () => {
    const { intent, delta } = persistentSessionFixtures();
    const sessionAffordances = createAffordanceRegistry([
      PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = { run: vi.fn(async () => attestation(true)) };
    const { hook, fire } = recordingHook();

    const result = await runTurnDecision({
      prompt: "spawn persistent",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(intent) },
      affordanceRegistry: sessionAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => delta,
      budgetPolicy: denyingBudget("budget:user:vlad:0"),
      escalationHook: hook,
    });

    const params = fire.mock.calls[0]![0] as EscalationHookFireInput & { turnId?: string };
    expect(params.turnId).toBeDefined();
    // turnId === traceId so the runtime-decision-trace + escalation-event +
    // memory-event can all be joined on the same anchor.
    expect(params.turnId).toBe(String(result.traceId));
    void hook;
  });

  // Suppress unused-import lint for shared markers.
  void {} as unknown as PolicyApprovalDenialMarker;
  void {} as unknown as PolicyBudgetDenialMarker;
  void {} as unknown as PolicyRetryDenialMarker;
});
