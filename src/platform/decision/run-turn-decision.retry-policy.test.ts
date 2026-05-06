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
import type { PolicyRetryDenialMarker } from "./trace.js";

/**
 * Phase 6 wiring test for `commitment_kernel_policy_gate_full.plan.md`
 * Stage 5 (Retry policies). Verifies that `runTurnDecision`:
 *   (a) consults the injected `retryPolicy` only on the kernel-derived
 *       production-decision path,
 *   (b) on `retry=false` overlays the production decision with
 *       `taskContract.primaryOutcome="answer"` +
 *       `interactionMode="respond_only"` and writes the
 *       `policyRetryDenial` trace marker carrying attempt + max,
 *   (c) on `retry=true` leaves the production decision untouched,
 *   (d) skips the retry gate when an upstream gate (approval / budget /
 *       role) already denied (avoid double-emit + clean trace),
 *   (e) is a no-op when `retryPolicy` is omitted (default-allow),
 *   (f) is not consulted on the legacy-fallback path.
 *
 * Log-line + episodic emission are tested in
 * `src/platform/commitment/__tests__/retry-policy.test.ts` — this file
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

function readRetryMarker(
  result: Awaited<ReturnType<typeof runTurnDecision>>,
): PolicyRetryDenialMarker | undefined {
  const trace = result.productionDecision.plannerInput.decisionTrace as
    | { readonly policyRetryDenial?: PolicyRetryDenialMarker }
    | undefined;
  return trace?.policyRetryDenial;
}

function denyingRetry(
  attemptCount = 3,
  maxAttempts = 3,
): {
  reader: RetryPolicyReader;
  evaluate: ReturnType<typeof vi.fn>;
} {
  const evaluate = vi.fn(
    async (_params: RetryPolicyEvaluateInput): Promise<RetryPolicyDecision> => ({
      retry: false,
      reason: "retry_limit_exceeded",
      attemptCount,
      maxAttempts,
    }),
  );
  return { reader: { evaluate }, evaluate };
}

function allowingRetry(backoffMs = 100): {
  reader: RetryPolicyReader;
  evaluate: ReturnType<typeof vi.fn>;
} {
  const evaluate = vi.fn(
    async (_params: RetryPolicyEvaluateInput): Promise<RetryPolicyDecision> => ({
      retry: true,
      backoffMs,
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

describe("runTurnDecision Phase 6 — Stage 5 Retry wiring", () => {
  it("(a)+(b) blocks the kernel-derived production decision on retry=false and attaches the policyRetryDenial marker", async () => {
    const { intent, delta } = persistentSessionFixtures();
    const sessionAffordances = createAffordanceRegistry([
      PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = { run: vi.fn(async () => attestation(true)) };
    const { reader, evaluate } = denyingRetry(3, 3);

    const result = await runTurnDecision({
      prompt: "spawn persistent",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(intent) },
      affordanceRegistry: sessionAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => delta,
      retryPolicy: reader,
    });

    // Kernel-derived path engaged.
    expect(result.kernelFallback).toBe(false);
    // Retry gate consulted exactly once with the kernel-derived
    // EffectId + identity + (caller-defaulted) sessionId.
    expect(evaluate).toHaveBeenCalledTimes(1);
    const call = evaluate.mock.calls[0]![0] as RetryPolicyEvaluateInput;
    expect(call.identityId).toBe(VLADIMIR);
    expect(typeof call.effectId).toBe("string");
    expect(typeof call.sessionId).toBe("string");
    expect(typeof call.attemptCount).toBe("number");

    // Production decision downgraded to answer/respond_only with marker.
    expect(result.productionDecision.taskContract.primaryOutcome).toBe("answer");
    expect(result.productionDecision.taskContract.interactionMode).toBe("respond_only");
    expect(result.productionDecision.plannerInput.lowConfidenceStrategy).toBeUndefined();
    const marker = readRetryMarker(result);
    expect(marker?.stage).toBe("retry");
    expect(marker?.reason).toBe("retry_limit_exceeded");
    expect(marker?.attemptCount).toBe(3);
    expect(marker?.maxAttempts).toBe(3);
  });

  it("(c) leaves the production decision untouched when retryPolicy returns retry=true", async () => {
    const { intent, delta } = persistentSessionFixtures();
    const sessionAffordances = createAffordanceRegistry([
      PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = { run: vi.fn(async () => attestation(true)) };
    const { reader, evaluate } = allowingRetry(100);

    const result = await runTurnDecision({
      prompt: "spawn persistent",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(intent) },
      affordanceRegistry: sessionAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => delta,
      retryPolicy: reader,
    });

    expect(result.kernelFallback).toBe(false);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(readRetryMarker(result)).toBeUndefined();
  });

  it("(d) does NOT consult retryPolicy when the upstream approval gate already denied", async () => {
    const { intent, delta } = persistentSessionFixtures();
    const sessionAffordances = createAffordanceRegistry([
      PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = { run: vi.fn(async () => attestation(true)) };
    const approvalReader = denyingApproval("approval-pre-deny");
    const { reader: retryReader, evaluate: retryEvaluate } = denyingRetry();

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
      retryPolicy: retryReader,
    });

    expect(result.kernelFallback).toBe(false);
    // Retry evaluator MUST NOT be called when approval already denied.
    expect(retryEvaluate).not.toHaveBeenCalled();
    expect(readRetryMarker(result)).toBeUndefined();
  });

  it("(d cont.) does NOT consult retryPolicy when the upstream budget gate already denied", async () => {
    const { intent, delta } = persistentSessionFixtures();
    const sessionAffordances = createAffordanceRegistry([
      PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = { run: vi.fn(async () => attestation(true)) };
    const budgetReader = denyingBudget("budget:user:vlad:0", 5, 4);
    const { reader: retryReader, evaluate: retryEvaluate } = denyingRetry();

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
      retryPolicy: retryReader,
    });

    expect(result.kernelFallback).toBe(false);
    expect(retryEvaluate).not.toHaveBeenCalled();
    expect(readRetryMarker(result)).toBeUndefined();
  });

  it("(d cont.) does NOT consult retryPolicy when the upstream role gate already denied", async () => {
    const { intent, delta } = persistentSessionFixtures();
    const sessionAffordances = createAffordanceRegistry([
      PERSISTENT_SESSION_CREATED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = { run: vi.fn(async () => attestation(true)) };
    const roleReader = denyingRole("admin");
    const { reader: retryReader, evaluate: retryEvaluate } = denyingRetry();

    const result = await runTurnDecision({
      prompt: "spawn persistent",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(intent) },
      affordanceRegistry: sessionAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => delta,
      rolePolicy: roleReader,
      retryPolicy: retryReader,
    });

    expect(result.kernelFallback).toBe(false);
    expect(retryEvaluate).not.toHaveBeenCalled();
    expect(readRetryMarker(result)).toBeUndefined();
  });

  it("(f) does NOT consult retryPolicy on the legacy-fallback path", async () => {
    const { reader, evaluate } = denyingRetry();
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
      retryPolicy: reader,
    });

    expect(result.kernelFallback).toBe(true);
    expect(evaluate).not.toHaveBeenCalled();
    expect(readRetryMarker(result)).toBeUndefined();
  });

  it("(e) is a no-op when retryPolicy is omitted (default-allow)", async () => {
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
    expect(readRetryMarker(result)).toBeUndefined();
  });
});
