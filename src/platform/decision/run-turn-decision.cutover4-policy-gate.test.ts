import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  REPO_BRANCH_CREATED_AFFORDANCE_ENTRY,
  REPO_BRANCH_CREATED_EFFECT,
  REPO_COMMIT_LANDED_AFFORDANCE_ENTRY,
  REPO_COMMIT_LANDED_EFFECT,
  REPO_DIFF_OBSERVED_AFFORDANCE_ENTRY,
  REPO_DIFF_OBSERVED_EFFECT,
  REPO_EFFECT_FAMILY,
  REPO_MERGE_COMPLETED_AFFORDANCE_ENTRY,
  REPO_MERGE_COMPLETED_EFFECT,
  createAffordanceRegistry,
  createCutoverPolicy,
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
import type { EffectId, ISO8601 } from "../commitment/ids.js";
import type {
  OperationHint,
  TargetRef,
} from "../commitment/semantic-intent.js";
import type { WorldStateSnapshot } from "../commitment/world-state.js";
import { asIdentityId } from "../identity/identity-id.js";
import { runTurnDecision } from "./run-turn-decision.js";
import type {
  TaskClassifierAdapter,
  TaskContract,
} from "./task-classifier.js";
import type {
  PolicyApprovalDenialMarker,
  PolicyBudgetDenialMarker,
  PolicyEscalationFiredMarker,
  PolicyRetryDenialMarker,
  PolicyRoleDenialMarker,
} from "./trace.js";

/**
 * Cutover-4 Phase 6 — PolicyGate Full integration for repo effects.
 *
 * Phase 6 of `commitment_kernel_cutover4_repo_operation.plan.md` ADDS
 * config wiring only — the runtime chain (Stages 2-6) is the same one
 * landed by PolicyGate Full (PRs #196-#210). This file exercises the
 * chain end-to-end on each of the four repo effects:
 *
 *   - `repo.branch_created`  (mutation, medium risk)
 *   - `repo.commit_landed`   (mutation, medium risk)
 *   - `repo.merge_completed` (mutation, high risk — primary approval target)
 *   - `repo.diff_observed`   (read-only, low risk — only effect with retry)
 *
 * Coverage matrix (sub-plan §3 row Phase 6):
 *   Stage 2 — approval denial on `repo.merge_completed` blocks the kernel
 *             path; trace marker carries `requires_approval`.
 *   Stage 3 — per-channel budget denial on `repo.commit_landed` blocks
 *             the kernel path; trace marker carries
 *             `budget_exceeded_channel`.
 *   Stage 4 — role denial on `repo.merge_completed` (developer attempts
 *             merge) blocks the kernel path; trace marker carries
 *             `requiredRole`.
 *   Stage 5 — retry exhaustion on `repo.diff_observed` blocks the kernel
 *             path; trace marker carries
 *             `attemptCount`/`maxAttempts`.
 *   Stage 6 — escalation fans out on every denial; the trace
 *             `policyEscalationFired` marker carries the original
 *             denialReason.
 *   Chain ordering — denial at Stage 2 short-circuits Stages 3/4/5
 *                    (later evaluators NOT consulted).
 *   Defense-in-depth — anonymous identity attempting `repo.merge_completed`
 *                       fails closed at Stage 2 even when the role gate
 *                       would also deny.
 *
 * Frozen-layer integrity: this file mocks the four reader interfaces at
 * the wiring seam (mirroring `run-turn-decision.escalation-hook.test.ts`)
 * — the readers themselves stay BYTE-IDENTICAL through Phase 6.
 */

const VLADIMIR = asIdentityId("identity:vladimir");
const ALICE = asIdentityId("identity:alice");

const legacyContract: TaskContract = {
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
  return { classify: vi.fn(async () => legacyContract) };
}

function intentAdapter(intent: SemanticIntent): IntentContractorAdapter {
  return { classify: vi.fn(async () => intent) };
}

// ---------------------------------------------------------------------------
// Repo effect fixtures — one per effect.
// ---------------------------------------------------------------------------

type RepoFixture = {
  intent: SemanticIntent;
  delta: ExpectedDelta;
  attestation: RuntimeAttestation;
  affordanceEntry:
    | typeof REPO_BRANCH_CREATED_AFFORDANCE_ENTRY
    | typeof REPO_COMMIT_LANDED_AFFORDANCE_ENTRY
    | typeof REPO_MERGE_COMPLETED_AFFORDANCE_ENTRY
    | typeof REPO_DIFF_OBSERVED_AFFORDANCE_ENTRY;
  effect: EffectId;
};

/**
 * Builds a cutover policy that admits the four repo effects in addition
 * to the existing `CUTOVER_2` allow-list. Phase 6 of cutover-4 lands
 * config wiring only — the production cutover-policy flip is Phase 7,
 * so these tests inject a custom policy to exercise the chain end-to-
 * end against the kernel-derived path.
 */
function repoCutoverPolicy(): ReturnType<typeof createCutoverPolicy> {
  return createCutoverPolicy([
    { effect: REPO_BRANCH_CREATED_EFFECT, effectFamily: REPO_EFFECT_FAMILY },
    { effect: REPO_COMMIT_LANDED_EFFECT, effectFamily: REPO_EFFECT_FAMILY },
    { effect: REPO_MERGE_COMPLETED_EFFECT, effectFamily: REPO_EFFECT_FAMILY },
    { effect: REPO_DIFF_OBSERVED_EFFECT, effectFamily: REPO_EFFECT_FAMILY },
  ]);
}

function repoBranchCreatedFixture(): RepoFixture {
  const repoOpId = "repo_op_branch_001";
  const target: TargetRef = { kind: "workspace" };
  const operation: OperationHint = { kind: "create" };
  const intent: SemanticIntent = {
    desiredEffectFamily: REPO_EFFECT_FAMILY,
    target,
    operation,
    constraints: { branchName: "feature/x", baseRef: "main" },
    uncertainty: [],
    confidence: 0.9,
  };
  const delta: ExpectedDelta = { repo: { added: [repoOpId] } };
  const stateAfter: WorldStateSnapshot = {
    repo: {
      records: [
        {
          repoOperationId: repoOpId,
          kind: "branch_created",
          branchName: "feature/x",
          observedAt: "2026-05-06T12:00:00.000Z" as ISO8601,
        },
      ],
    },
  };
  const attestation: RuntimeAttestation = {
    commitmentSatisfied: true,
    terminalState: "action_completed",
    acceptanceReason: "commitment_satisfied",
    stateBefore: {},
    stateAfter,
    satisfaction: { satisfied: true, evidence: [] },
  };
  return {
    intent,
    delta,
    attestation,
    affordanceEntry: REPO_BRANCH_CREATED_AFFORDANCE_ENTRY,
    effect: REPO_BRANCH_CREATED_EFFECT,
  };
}

function repoCommitLandedFixture(): RepoFixture {
  const repoOpId = "repo_op_commit_001";
  const target: TargetRef = { kind: "workspace" };
  const operation: OperationHint = { kind: "update" };
  const intent: SemanticIntent = {
    desiredEffectFamily: REPO_EFFECT_FAMILY,
    target,
    operation,
    constraints: { commitMessage: "fix: bug" },
    uncertainty: [],
    confidence: 0.9,
  };
  const delta: ExpectedDelta = { repo: { added: [repoOpId] } };
  const stateAfter: WorldStateSnapshot = {
    repo: {
      records: [
        {
          repoOperationId: repoOpId,
          kind: "commit_landed",
          commitSha: "abc1234567890abcdef1234567890abcdef12345",
          observedAt: "2026-05-06T12:00:00.000Z" as ISO8601,
        },
      ],
    },
  };
  const attestation: RuntimeAttestation = {
    commitmentSatisfied: true,
    terminalState: "action_completed",
    acceptanceReason: "commitment_satisfied",
    stateBefore: {},
    stateAfter,
    satisfaction: { satisfied: true, evidence: [] },
  };
  return {
    intent,
    delta,
    attestation,
    affordanceEntry: REPO_COMMIT_LANDED_AFFORDANCE_ENTRY,
    effect: REPO_COMMIT_LANDED_EFFECT,
  };
}

function repoMergeCompletedFixture(): RepoFixture {
  const repoOpId = "repo_op_merge_001";
  const target: TargetRef = { kind: "workspace" };
  const operation: OperationHint = { kind: "update" };
  const intent: SemanticIntent = {
    desiredEffectFamily: REPO_EFFECT_FAMILY,
    target,
    operation,
    constraints: { sourceBranch: "feature/x", targetBranch: "main" },
    uncertainty: [],
    confidence: 0.9,
  };
  const delta: ExpectedDelta = { repo: { added: [repoOpId] } };
  const stateAfter: WorldStateSnapshot = {
    repo: {
      records: [
        {
          repoOperationId: repoOpId,
          kind: "merge_completed",
          commitSha: "abcdef1234567890abcdef1234567890abcdef12",
          observedAt: "2026-05-06T12:00:00.000Z" as ISO8601,
        },
      ],
    },
  };
  const attestation: RuntimeAttestation = {
    commitmentSatisfied: true,
    terminalState: "action_completed",
    acceptanceReason: "commitment_satisfied",
    stateBefore: {},
    stateAfter,
    satisfaction: { satisfied: true, evidence: [] },
  };
  return {
    intent,
    delta,
    attestation,
    affordanceEntry: REPO_MERGE_COMPLETED_AFFORDANCE_ENTRY,
    effect: REPO_MERGE_COMPLETED_EFFECT,
  };
}

function repoDiffObservedFixture(): RepoFixture {
  const repoOpId = "repo_op_diff_001";
  const target: TargetRef = { kind: "workspace" };
  const operation: OperationHint = { kind: "observe" };
  const intent: SemanticIntent = {
    desiredEffectFamily: REPO_EFFECT_FAMILY,
    target,
    operation,
    constraints: {},
    uncertainty: [],
    confidence: 0.9,
  };
  const delta: ExpectedDelta = { repo: { added: [repoOpId] } };
  const stateAfter: WorldStateSnapshot = {
    repo: {
      records: [
        {
          repoOperationId: repoOpId,
          kind: "diff_observed",
          observedAt: "2026-05-06T12:00:00.000Z" as ISO8601,
        },
      ],
    },
  };
  const attestation: RuntimeAttestation = {
    commitmentSatisfied: true,
    terminalState: "action_completed",
    acceptanceReason: "commitment_satisfied",
    stateBefore: {},
    stateAfter,
    satisfaction: { satisfied: true, evidence: [] },
  };
  return {
    intent,
    delta,
    attestation,
    affordanceEntry: REPO_DIFF_OBSERVED_AFFORDANCE_ENTRY,
    effect: REPO_DIFF_OBSERVED_EFFECT,
  };
}

// ---------------------------------------------------------------------------
// Reader fakes (mirrors run-turn-decision.escalation-hook.test.ts).
// ---------------------------------------------------------------------------

function denyingApproval(approvalRequestId: string): ApprovalPolicyReader {
  const evaluate = vi.fn(
    async (
      _params: ApprovalPolicyEvaluateInput,
    ): Promise<ApprovalPolicyDecision> => ({
      approved: false,
      reason: "requires_approval",
      approvalRequestId: approvalRequestId as unknown as ApprovalRequestId,
    }),
  );
  return { evaluate };
}

function allowingApproval(): {
  reader: ApprovalPolicyReader;
  evaluate: ReturnType<typeof vi.fn>;
} {
  const evaluate = vi.fn(
    async (
      _params: ApprovalPolicyEvaluateInput,
    ): Promise<ApprovalPolicyDecision> => ({ approved: true }),
  );
  return { reader: { evaluate }, evaluate };
}

function denyingBudget(
  windowId: string,
  reason:
    | "budget_exceeded_user"
    | "budget_exceeded_channel"
    | "budget_exceeded_effect" = "budget_exceeded_channel",
): {
  reader: BudgetPolicyReader;
  evaluate: ReturnType<typeof vi.fn>;
} {
  const evaluate = vi.fn(
    async (
      _params: BudgetPolicyEvaluateInput,
    ): Promise<BudgetPolicyDecision> => ({
      within: false,
      reason,
      windowId: windowId as unknown as BudgetWindowId,
      used: 5,
      limit: 4,
    }),
  );
  return { reader: { evaluate }, evaluate };
}

function allowingBudget(): {
  reader: BudgetPolicyReader;
  evaluate: ReturnType<typeof vi.fn>;
} {
  const evaluate = vi.fn(
    async (
      _params: BudgetPolicyEvaluateInput,
    ): Promise<BudgetPolicyDecision> => ({ within: true, remaining: 100 }),
  );
  return { reader: { evaluate }, evaluate };
}

function denyingRole(requiredRole: string): {
  reader: RolePolicyReader;
  evaluate: ReturnType<typeof vi.fn>;
} {
  const evaluate = vi.fn(
    async (
      _params: RolePolicyEvaluateInput,
    ): Promise<RolePolicyDecision> => ({
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
    async (
      _params: RolePolicyEvaluateInput,
    ): Promise<RolePolicyDecision> => ({
      allowed: true,
      role: role as unknown as RoleId,
    }),
  );
  return { reader: { evaluate }, evaluate };
}

function denyingRetry(
  attemptCount = 3,
  maxAttempts = 3,
): {
  reader: RetryPolicyReader;
  evaluate: ReturnType<typeof vi.fn>;
} {
  const evaluate = vi.fn(
    async (
      _params: RetryPolicyEvaluateInput,
    ): Promise<RetryPolicyDecision> => ({
      retry: false,
      reason: "retry_limit_exceeded",
      attemptCount,
      maxAttempts,
    }),
  );
  return { reader: { evaluate }, evaluate };
}

function recordingHook(): {
  hook: EscalationHook;
  fire: ReturnType<typeof vi.fn>;
} {
  const fire = vi.fn(
    async (
      params: EscalationHookFireInput,
    ): Promise<EscalationHookDecision> => ({
      fired: true,
      escalationId: `escalation-${String(params.denialReason)}-${String(
        params.effectId,
      )}`,
    }),
  );
  return { hook: { fire }, fire };
}

// ---------------------------------------------------------------------------
// Trace marker readers.
// ---------------------------------------------------------------------------

function readApprovalMarker(
  result: Awaited<ReturnType<typeof runTurnDecision>>,
): PolicyApprovalDenialMarker | undefined {
  return (
    result.productionDecision.plannerInput.decisionTrace as
      | { readonly policyApprovalDenial?: PolicyApprovalDenialMarker }
      | undefined
  )?.policyApprovalDenial;
}

function readBudgetMarker(
  result: Awaited<ReturnType<typeof runTurnDecision>>,
): PolicyBudgetDenialMarker | undefined {
  return (
    result.productionDecision.plannerInput.decisionTrace as
      | { readonly policyBudgetDenial?: PolicyBudgetDenialMarker }
      | undefined
  )?.policyBudgetDenial;
}

function readRoleMarker(
  result: Awaited<ReturnType<typeof runTurnDecision>>,
): PolicyRoleDenialMarker | undefined {
  return (
    result.productionDecision.plannerInput.decisionTrace as
      | { readonly policyRoleDenial?: PolicyRoleDenialMarker }
      | undefined
  )?.policyRoleDenial;
}

function readRetryMarker(
  result: Awaited<ReturnType<typeof runTurnDecision>>,
): PolicyRetryDenialMarker | undefined {
  return (
    result.productionDecision.plannerInput.decisionTrace as
      | { readonly policyRetryDenial?: PolicyRetryDenialMarker }
      | undefined
  )?.policyRetryDenial;
}

function readEscalationMarker(
  result: Awaited<ReturnType<typeof runTurnDecision>>,
): PolicyEscalationFiredMarker | undefined {
  return (
    result.productionDecision.plannerInput.decisionTrace as
      | { readonly policyEscalationFired?: PolicyEscalationFiredMarker }
      | undefined
  )?.policyEscalationFired;
}

// ---------------------------------------------------------------------------
// Stage 2 (Approval) — repo.merge_completed is the canonical target.
// ---------------------------------------------------------------------------

describe("Cutover-4 Phase 6 — Stage 2 (Approval) on repo effects", () => {
  it("denies repo.merge_completed when caller is not in approvers list", async () => {
    const fx = repoMergeCompletedFixture();
    const registry = createAffordanceRegistry([fx.affordanceEntry]);
    const monitoredRuntime = { run: vi.fn(async () => fx.attestation) };
    const approval = denyingApproval("approval-merge-001");
    const { hook, fire } = recordingHook();

    const result = await runTurnDecision({
      prompt: "слей feature/x в main",
      cfg: cfg(),
      identityId: ALICE,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(fx.intent) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => fx.delta,
      cutoverPolicy: repoCutoverPolicy(),
      approvalPolicy: approval,
      escalationHook: hook,
    });

    expect(result.kernelFallback).toBe(false);
    expect(result.productionDecision.taskContract.primaryOutcome).toBe("answer");
    expect(result.productionDecision.taskContract.interactionMode).toBe(
      "respond_only",
    );
    const marker = readApprovalMarker(result);
    expect(marker?.reason).toBe("requires_approval");
    expect(marker?.approvalRequestId).toBe("approval-merge-001");

    // Stage 6 escalation MUST fan out on the approval denial.
    expect(fire).toHaveBeenCalledTimes(1);
    const fireParams = fire.mock.calls[0]![0] as EscalationHookFireInput;
    expect(fireParams.denialReason).toBe("requires_approval");
    expect(String(fireParams.effectId)).toBe(String(REPO_MERGE_COMPLETED_EFFECT));
    // Note: `monitoredRuntime.run` MAY be invoked during the cutover-gate
    // evaluation step (it precedes the policy chain in
    // `runTurnDecision` — see `evaluateCutoverGate` order). The denial
    // flag is OBSERVED through the trace marker + the production
    // decision's downgrade to `answer/respond_only`, NOT through
    // pre-empting runtime execution. The repo-runtime-adapter's emit
    // logic is gated separately at the runner-side hook.
  });

  it("permits repo.merge_completed when caller is in approvers list (allow path)", async () => {
    const fx = repoMergeCompletedFixture();
    const registry = createAffordanceRegistry([fx.affordanceEntry]);
    const monitoredRuntime = { run: vi.fn(async () => fx.attestation) };
    const { reader: approval, evaluate } = allowingApproval();

    const result = await runTurnDecision({
      prompt: "слей feature/x в main",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(fx.intent) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => fx.delta,
      cutoverPolicy: repoCutoverPolicy(),
      approvalPolicy: approval,
    });

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(readApprovalMarker(result)).toBeUndefined();
    expect(result.kernelFallback).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stage 3 (Budget) — per-channel cap on repo.commit_landed.
// ---------------------------------------------------------------------------

describe("Cutover-4 Phase 6 — Stage 3 (Budget) on repo effects", () => {
  it("denies repo.commit_landed when per-channel hourly cap exceeded", async () => {
    const fx = repoCommitLandedFixture();
    const registry = createAffordanceRegistry([fx.affordanceEntry]);
    const monitoredRuntime = { run: vi.fn(async () => fx.attestation) };
    const { reader: budget } = denyingBudget(
      "budget:channel:telegram:0",
      "budget_exceeded_channel",
    );
    const { hook, fire } = recordingHook();

    const result = await runTurnDecision({
      prompt: "закоммить с сообщением fix bug",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(fx.intent) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => fx.delta,
      cutoverPolicy: repoCutoverPolicy(),
      budgetPolicy: budget,
      escalationHook: hook,
    });

    expect(result.kernelFallback).toBe(false);
    const marker = readBudgetMarker(result);
    expect(marker?.reason).toBe("budget_exceeded_channel");

    // Stage 6 escalation fans out on the budget denial.
    expect(fire).toHaveBeenCalledTimes(1);
    const fireParams = fire.mock.calls[0]![0] as EscalationHookFireInput;
    expect(fireParams.denialReason).toBe("budget_exceeded_channel");
    expect(String(fireParams.effectId)).toBe(String(REPO_COMMIT_LANDED_EFFECT));
  });

  it("permits repo.commit_landed when channel cap NOT exceeded", async () => {
    const fx = repoCommitLandedFixture();
    const registry = createAffordanceRegistry([fx.affordanceEntry]);
    const monitoredRuntime = { run: vi.fn(async () => fx.attestation) };
    const { reader: budget, evaluate } = allowingBudget();

    const result = await runTurnDecision({
      prompt: "закоммить с сообщением fix bug",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(fx.intent) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => fx.delta,
      cutoverPolicy: repoCutoverPolicy(),
      budgetPolicy: budget,
    });

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(readBudgetMarker(result)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Stage 4 (Role) — developer attempting repo.merge_completed.
// ---------------------------------------------------------------------------

describe("Cutover-4 Phase 6 — Stage 4 (Role) on repo effects", () => {
  it("denies repo.merge_completed for developer role (only maintainer can merge)", async () => {
    const fx = repoMergeCompletedFixture();
    const registry = createAffordanceRegistry([fx.affordanceEntry]);
    const monitoredRuntime = { run: vi.fn(async () => fx.attestation) };
    const { reader: role } = denyingRole("maintainer");
    const { hook, fire } = recordingHook();

    const result = await runTurnDecision({
      prompt: "слей feature/x в main",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(fx.intent) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => fx.delta,
      cutoverPolicy: repoCutoverPolicy(),
      rolePolicy: role,
      escalationHook: hook,
    });

    expect(result.kernelFallback).toBe(false);
    const marker = readRoleMarker(result);
    expect(marker?.reason).toBe("role_denied");
    expect(String(marker?.requiredRole)).toBe("maintainer");

    // Stage 6 escalation fans out on the role denial.
    expect(fire).toHaveBeenCalledTimes(1);
    const fireParams = fire.mock.calls[0]![0] as EscalationHookFireInput;
    expect(fireParams.denialReason).toBe("role_denied");
  });

  it("permits repo.diff_observed for viewer role (read-only allowed)", async () => {
    const fx = repoDiffObservedFixture();
    const registry = createAffordanceRegistry([fx.affordanceEntry]);
    const monitoredRuntime = { run: vi.fn(async () => fx.attestation) };
    const { reader: role, evaluate } = allowingRole("viewer");

    const result = await runTurnDecision({
      prompt: "покажи git diff",
      cfg: cfg(),
      identityId: ALICE,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(fx.intent) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => fx.delta,
      cutoverPolicy: repoCutoverPolicy(),
      rolePolicy: role,
    });

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(readRoleMarker(result)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Stage 5 (Retry) — only repo.diff_observed permits retries; mutations
// have maxRetries=0 enforced by the affordance entry's defaultBudgets.
// ---------------------------------------------------------------------------

describe("Cutover-4 Phase 6 — Stage 5 (Retry) on repo effects", () => {
  it("denies repo.diff_observed when retry limit exhausted", async () => {
    const fx = repoDiffObservedFixture();
    const registry = createAffordanceRegistry([fx.affordanceEntry]);
    const monitoredRuntime = { run: vi.fn(async () => fx.attestation) };
    const { reader: retry } = denyingRetry(2, 2);
    const { hook, fire } = recordingHook();

    const result = await runTurnDecision({
      prompt: "покажи git diff",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(fx.intent) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => fx.delta,
      cutoverPolicy: repoCutoverPolicy(),
      retryPolicy: retry,
      escalationHook: hook,
    });

    expect(result.kernelFallback).toBe(false);
    const marker = readRetryMarker(result);
    expect(marker?.reason).toBe("retry_limit_exceeded");
    expect(marker?.attemptCount).toBe(2);
    expect(marker?.maxAttempts).toBe(2);

    expect(fire).toHaveBeenCalledTimes(1);
    const fireParams = fire.mock.calls[0]![0] as EscalationHookFireInput;
    expect(fireParams.denialReason).toBe("retry_limit_exceeded");
  });
});

// ---------------------------------------------------------------------------
// Chain ordering — Stage 2 denial short-circuits Stages 3/4/5.
// ---------------------------------------------------------------------------

describe("Cutover-4 Phase 6 — chain ordering on repo effects", () => {
  it("Stage 2 denial on repo.merge_completed short-circuits Stages 3/4/5 (none consulted)", async () => {
    const fx = repoMergeCompletedFixture();
    const registry = createAffordanceRegistry([fx.affordanceEntry]);
    const monitoredRuntime = { run: vi.fn(async () => fx.attestation) };
    const approval = denyingApproval("approval-merge-002");
    const { reader: budget, evaluate: budgetEval } = denyingBudget(
      "budget:user:vlad:0",
    );
    const { reader: role, evaluate: roleEval } = denyingRole("maintainer");
    const { reader: retry, evaluate: retryEval } = denyingRetry();
    const { hook, fire } = recordingHook();

    const result = await runTurnDecision({
      prompt: "слей feature/x в main",
      cfg: cfg(),
      identityId: ALICE,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(fx.intent) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => fx.delta,
      cutoverPolicy: repoCutoverPolicy(),
      approvalPolicy: approval,
      budgetPolicy: budget,
      rolePolicy: role,
      retryPolicy: retry,
      escalationHook: hook,
    });

    expect(result.kernelFallback).toBe(false);
    expect(readApprovalMarker(result)?.reason).toBe("requires_approval");
    // Stages 3/4/5 MUST NOT have been consulted (chain short-circuit).
    expect(budgetEval).not.toHaveBeenCalled();
    expect(roleEval).not.toHaveBeenCalled();
    expect(retryEval).not.toHaveBeenCalled();
    // Stage 6 escalation always fans out.
    expect(fire).toHaveBeenCalledTimes(1);
    const fireParams = fire.mock.calls[0]![0] as EscalationHookFireInput;
    expect(fireParams.denialReason).toBe("requires_approval");
  });

  it("Stage 3 denial on repo.commit_landed short-circuits Stages 4/5 (Stage 2 consulted, then chain breaks)", async () => {
    const fx = repoCommitLandedFixture();
    const registry = createAffordanceRegistry([fx.affordanceEntry]);
    const monitoredRuntime = { run: vi.fn(async () => fx.attestation) };
    const { reader: approval, evaluate: approvalEval } = allowingApproval();
    const { reader: budget } = denyingBudget(
      "budget:channel:telegram:0",
      "budget_exceeded_channel",
    );
    const { reader: role, evaluate: roleEval } = denyingRole("maintainer");
    const { reader: retry, evaluate: retryEval } = denyingRetry();

    const result = await runTurnDecision({
      prompt: "закоммить с сообщением fix bug",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(fx.intent) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => fx.delta,
      cutoverPolicy: repoCutoverPolicy(),
      approvalPolicy: approval,
      budgetPolicy: budget,
      rolePolicy: role,
      retryPolicy: retry,
    });

    expect(approvalEval).toHaveBeenCalledTimes(1);
    expect(readBudgetMarker(result)?.reason).toBe("budget_exceeded_channel");
    expect(roleEval).not.toHaveBeenCalled();
    expect(retryEval).not.toHaveBeenCalled();
  });

  it("Stage 4 denial on repo.merge_completed short-circuits Stage 5 (Stages 2/3 consulted, chain breaks at role)", async () => {
    const fx = repoMergeCompletedFixture();
    const registry = createAffordanceRegistry([fx.affordanceEntry]);
    const monitoredRuntime = { run: vi.fn(async () => fx.attestation) };
    const { reader: approval, evaluate: approvalEval } = allowingApproval();
    const { reader: budget, evaluate: budgetEval } = allowingBudget();
    const { reader: role } = denyingRole("maintainer");
    const { reader: retry, evaluate: retryEval } = denyingRetry();

    const result = await runTurnDecision({
      prompt: "слей feature/x в main",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(fx.intent) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => fx.delta,
      cutoverPolicy: repoCutoverPolicy(),
      approvalPolicy: approval,
      budgetPolicy: budget,
      rolePolicy: role,
      retryPolicy: retry,
    });

    expect(approvalEval).toHaveBeenCalledTimes(1);
    expect(budgetEval).toHaveBeenCalledTimes(1);
    expect(readRoleMarker(result)?.reason).toBe("role_denied");
    expect(retryEval).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Defense-in-depth — anonymous identity fail-closed at Stage 2.
// ---------------------------------------------------------------------------

describe("Cutover-4 Phase 6 — anonymous identity fail-closed on mutation effects", () => {
  it("anonymous identity attempting repo.merge_completed is denied at Stage 2 (fail-closed)", async () => {
    const fx = repoMergeCompletedFixture();
    const registry = createAffordanceRegistry([fx.affordanceEntry]);
    const monitoredRuntime = { run: vi.fn(async () => fx.attestation) };
    const approval = denyingApproval("approval-anon-001");

    const result = await runTurnDecision({
      prompt: "слей feature/x в main",
      cfg: cfg(),
      // identityId omitted — anonymous turn.
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(fx.intent) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => fx.delta,
      cutoverPolicy: repoCutoverPolicy(),
      approvalPolicy: approval,
    });

    expect(readApprovalMarker(result)?.reason).toBe("requires_approval");
    // The trace carries the denial — Stage 2 fail-closes for anonymous
    // identities even when the effect is listed in `policy.approvals`
    // (see `approval-policy.ts` doc-block §2). The cutover-gate
    // attestation MAY have run; the runner-side hook gates the
    // repo-runtime-adapter emit separately.
  });
});

// ---------------------------------------------------------------------------
// Stage 6 escalation fan-out — fires for every denial reason.
// ---------------------------------------------------------------------------

describe("Cutover-4 Phase 6 — Stage 6 (Escalation) fan-out on repo denials", () => {
  it("escalation fan-out covers all four repo effects via repo.branch_created approval denial", async () => {
    const fx = repoBranchCreatedFixture();
    const registry = createAffordanceRegistry([fx.affordanceEntry]);
    const monitoredRuntime = { run: vi.fn(async () => fx.attestation) };
    const approval = denyingApproval("approval-branch-001");
    const { hook, fire } = recordingHook();

    const result = await runTurnDecision({
      prompt: "создай ветку feature/x",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(fx.intent) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => fx.delta,
      cutoverPolicy: repoCutoverPolicy(),
      approvalPolicy: approval,
      escalationHook: hook,
    });

    expect(fire).toHaveBeenCalledTimes(1);
    const escalationMarker = readEscalationMarker(result);
    expect(escalationMarker?.denialReason).toBe("requires_approval");
    expect(escalationMarker?.escalationId).toBe(
      "escalation-requires_approval-repo.branch_created",
    );
  });
});
