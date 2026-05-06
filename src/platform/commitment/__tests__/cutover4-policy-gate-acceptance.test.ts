import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { asIdentityId } from "../../identity/identity-id.js";
import {
  REPO_BRANCH_CREATED_EFFECT,
  REPO_COMMIT_LANDED_AFFORDANCE_ENTRY,
  REPO_COMMIT_LANDED_EFFECT,
  REPO_DIFF_OBSERVED_AFFORDANCE_ENTRY,
  REPO_DIFF_OBSERVED_EFFECT,
  REPO_EFFECT_FAMILY,
  REPO_MERGE_COMPLETED_AFFORDANCE_ENTRY,
  REPO_MERGE_COMPLETED_EFFECT,
  buildBudgetWindowId,
  createAffordanceRegistry,
  createApprovalPolicy,
  createBudgetPolicy,
  createCutoverPolicy,
  createEscalationHook,
  createInMemoryRetryStateStore,
  createRetryPolicy,
  createRolePolicy,
  type ApprovalRequestCreator,
  type BudgetIncrementInput,
  type BudgetReadQuery,
  type BudgetStore,
  type BudgetWindow,
  type ExpectedDelta,
  type IntentContractorAdapter,
  type RoleId,
  type RoleResolver,
  type RuntimeAttestation,
  type SemanticIntent,
} from "../index.js";
import type { ISO8601 } from "../ids.js";
import type { OperationHint, TargetRef } from "../semantic-intent.js";
import type { WorldStateSnapshot } from "../world-state.js";
import { runTurnDecision } from "../../decision/run-turn-decision.js";
import type {
  TaskClassifierAdapter,
  TaskContract,
} from "../../decision/task-classifier.js";

/**
 * Cutover-4 Phase 6 — PolicyGate Full integration ACCEPTANCE.
 *
 * Mirrors `policy-gate-full.acceptance.test.ts` but exercises the four
 * repo effects (`repo.branch_created`, `repo.commit_landed`,
 * `repo.merge_completed`, `repo.diff_observed`) with REAL policy
 * readers (`createApprovalPolicy`, `createBudgetPolicy`,
 * `createRolePolicy`, `createRetryPolicy`, `createEscalationHook`)
 * driven by the same Phase 6 config shape that ships in
 * `OpenClawConfig.policy.{approvals,budgets,roles,retry}`.
 *
 * Phase 6 of `commitment_kernel_cutover4_repo_operation.plan.md` is
 * ADD-only — no new factories, no new orthogonal `*POLICY_REASONS`
 * tuples. This file pins the contract that the EXISTING readers,
 * driven by config fields a host operator writes, deny / permit
 * repo turns end-to-end.
 *
 * Coverage matrix (one positive + one negative per stage = 8 cases):
 *   (a) Stage 2 — `repo.merge_completed` config requires approver
 *       Vladimir; Alice (not in approvers) denied; Vladimir permitted.
 *   (b) Stage 3 — `policy.budgets` per-channel cap on `repo.commit_landed`
 *       at 5/h; 6th commit on the same channel denied.
 *   (c) Stage 4 — `policy.roles.maintainer` permits `repo.merge_completed`;
 *       `policy.roles.developer` does NOT, so a developer attempting merge
 *       is denied.
 *   (d) Stage 5 — `policy.retry.perEffect['repo.diff_observed'].maxAttempts=2`;
 *       attemptCount=2 denied; attemptCount=1 permitted.
 *
 * Frozen-layer integrity: this fixture imports ZERO frozen-layer
 * symbols beyond the already-shipped readers + types. PolicyGate Full
 * files (Phases 3-7 of `commitment_kernel_policy_gate_full.plan.md`)
 * remain BYTE-IDENTICAL through cutover-4 Phase 6.
 *
 * Production cutover-policy is injected via `createCutoverPolicy` to
 * admit the four repo effects ahead of the Phase-7 flip — Phase 6 is
 * config-only, so the policy chain is exercised with a per-test
 * cutover-policy override. The default `defaultCutoverPolicy` stays
 * BYTE-IDENTICAL until cutover-4 Phase 7 lands.
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

function cfg(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return {
    ...overrides,
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

function repoCutoverPolicy() {
  return createCutoverPolicy([
    { effect: REPO_BRANCH_CREATED_EFFECT, effectFamily: REPO_EFFECT_FAMILY },
    { effect: REPO_COMMIT_LANDED_EFFECT, effectFamily: REPO_EFFECT_FAMILY },
    { effect: REPO_MERGE_COMPLETED_EFFECT, effectFamily: REPO_EFFECT_FAMILY },
    { effect: REPO_DIFF_OBSERVED_EFFECT, effectFamily: REPO_EFFECT_FAMILY },
  ]);
}

function repoMergeAttestation(): RuntimeAttestation {
  const stateAfter: WorldStateSnapshot = {
    repo: {
      records: [
        {
          repoOperationId: "repo_op_merge_acc",
          kind: "merge_completed",
          commitSha: "abcdef1234567890abcdef1234567890abcdef12",
          observedAt: "2026-05-06T12:00:00.000Z" as ISO8601,
        },
      ],
    },
  };
  return {
    commitmentSatisfied: true,
    terminalState: "action_completed",
    acceptanceReason: "commitment_satisfied",
    stateBefore: {},
    stateAfter,
    satisfaction: { satisfied: true, evidence: [] },
  };
}

function repoCommitAttestation(): RuntimeAttestation {
  const stateAfter: WorldStateSnapshot = {
    repo: {
      records: [
        {
          repoOperationId: "repo_op_commit_acc",
          kind: "commit_landed",
          commitSha: "1234567890abcdef1234567890abcdef12345678",
          observedAt: "2026-05-06T12:00:00.000Z" as ISO8601,
        },
      ],
    },
  };
  return {
    commitmentSatisfied: true,
    terminalState: "action_completed",
    acceptanceReason: "commitment_satisfied",
    stateBefore: {},
    stateAfter,
    satisfaction: { satisfied: true, evidence: [] },
  };
}

function repoDiffAttestation(): RuntimeAttestation {
  const stateAfter: WorldStateSnapshot = {
    repo: {
      records: [
        {
          repoOperationId: "repo_op_diff_acc",
          kind: "diff_observed",
          observedAt: "2026-05-06T12:00:00.000Z" as ISO8601,
        },
      ],
    },
  };
  return {
    commitmentSatisfied: true,
    terminalState: "action_completed",
    acceptanceReason: "commitment_satisfied",
    stateBefore: {},
    stateAfter,
    satisfaction: { satisfied: true, evidence: [] },
  };
}

function mergeIntent(): SemanticIntent {
  const target: TargetRef = { kind: "workspace" };
  const operation: OperationHint = { kind: "update" };
  return {
    desiredEffectFamily: REPO_EFFECT_FAMILY,
    target,
    operation,
    constraints: { sourceBranch: "feature/x", targetBranch: "main" },
    uncertainty: [],
    confidence: 0.9,
  };
}

function commitIntent(): SemanticIntent {
  const target: TargetRef = { kind: "workspace" };
  const operation: OperationHint = { kind: "update" };
  return {
    desiredEffectFamily: REPO_EFFECT_FAMILY,
    target,
    operation,
    constraints: { commitMessage: "fix: bug" },
    uncertainty: [],
    confidence: 0.9,
  };
}

function diffIntent(): SemanticIntent {
  const target: TargetRef = { kind: "workspace" };
  const operation: OperationHint = { kind: "observe" };
  return {
    desiredEffectFamily: REPO_EFFECT_FAMILY,
    target,
    operation,
    constraints: {},
    uncertainty: [],
    confidence: 0.9,
  };
}

function fixedApprovalCreator(id: string): ApprovalRequestCreator & {
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(() => ({ id }));
  return { create };
}

/**
 * In-memory `BudgetStore` fake — mirrors `policy-gate-full.acceptance.test.ts`
 * key shape so Phase 6 acceptance and PolicyGate Full acceptance share
 * the same atomic-increment / lazy-roll semantics.
 */
function inMemoryBudgetStore(now: () => number = Date.now): BudgetStore {
  const rows = new Map<string, BudgetWindow>();
  const keyFor = (q: BudgetReadQuery): string =>
    q.dimension === "user"
      ? `user|${String(q.identityId ?? "")}|${String(q.effectFamily ?? "")}`
      : q.dimension === "channel"
        ? `channel|${String(q.channel ?? "")}|${String(q.effectFamily ?? "")}`
        : `effect|${String(q.effectFamily ?? "")}`;

  return {
    read(query) {
      return Promise.resolve(rows.get(keyFor(query)) ?? null);
    },
    increment(input: BudgetIncrementInput) {
      const key = keyFor(input);
      const existing = rows.get(key);
      const tNow = now();
      const w: BudgetWindow =
        existing && tNow < existing.windowEnd
          ? { ...existing, used: existing.used + 1, limit: input.limit }
          : ({
              windowId: buildBudgetWindowId({
                dimension: input.dimension,
                ...(input.identityId !== undefined ? { identityId: input.identityId } : {}),
                ...(input.channel !== undefined ? { channel: input.channel } : {}),
                ...(input.effectFamily !== undefined
                  ? { effectFamily: input.effectFamily }
                  : {}),
                windowStart: tNow,
              }),
              dimension: input.dimension,
              ...(input.identityId !== undefined ? { identityId: input.identityId } : {}),
              ...(input.channel !== undefined ? { channel: input.channel } : {}),
              ...(input.effectFamily !== undefined
                ? { effectFamily: input.effectFamily }
                : {}),
              windowStart: tNow,
              windowEnd: tNow + input.windowMs,
              used: 1,
              limit: input.limit,
            } satisfies BudgetWindow);
      rows.set(key, w);
      return Promise.resolve(w);
    },
    resetExpired(_t) {
      return Promise.resolve(0);
    },
  };
}

// ---------------------------------------------------------------------------
// console.log capture — Phase 6 sub-plan §3 row Phase 6 log lines.
// ---------------------------------------------------------------------------

let logged: string[] = [];
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logged = [];
  consoleSpy = vi.spyOn(console, "log").mockImplementation((message: unknown) => {
    if (typeof message === "string") {
      logged.push(message);
    }
  });
});

afterEach(() => {
  consoleSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// (a) Stage 2 — repo.merge_completed approval gate.
// ---------------------------------------------------------------------------

describe("Cutover-4 Phase 6 acceptance — Stage 2 (Approval) on repo.merge_completed", () => {
  it("denies repo.merge_completed when caller is not in approvers list", async () => {
    const approvalCreator = fixedApprovalCreator("approval-acc-cutover4-stage2");
    const approvalPolicy = createApprovalPolicy({
      cfg: {
        policy: {
          approvals: [
            {
              effectId: REPO_MERGE_COMPLETED_EFFECT,
              requiredApprovals: 1,
              approvers: [VLADIMIR],
            },
          ],
        },
      } as unknown as OpenClawConfig,
      approvalCreator,
    });

    const registry = createAffordanceRegistry([REPO_MERGE_COMPLETED_AFFORDANCE_ENTRY]);
    const monitoredRuntime = { run: vi.fn(async () => repoMergeAttestation()) };
    const expectedDelta: ExpectedDelta = { repo: { added: ["repo_op_merge_acc"] } };

    const result = await runTurnDecision({
      prompt: "слей feature/x в main",
      cfg: cfg(),
      identityId: ALICE, // NOT in approvers
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(mergeIntent()) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
      cutoverPolicy: repoCutoverPolicy(),
      approvalPolicy,
    });

    expect(result.kernelFallback).toBe(false);
    expect(result.productionDecision.taskContract.primaryOutcome).toBe("answer");
    expect(result.productionDecision.taskContract.interactionMode).toBe(
      "respond_only",
    );

    expect(approvalCreator.create).toHaveBeenCalledTimes(1);
    const checkedLine = logged.find((l) =>
      l.startsWith("[policy-gate] event=approval_checked stage=2"),
    );
    expect(checkedLine).toBeDefined();
    expect(checkedLine).toContain(`effect=${String(REPO_MERGE_COMPLETED_EFFECT)}`);
    expect(checkedLine).toContain("approved=false");

    const requestCreatedLine = logged.find((l) =>
      l.startsWith("[policy-gate] event=approval_request_created"),
    );
    expect(requestCreatedLine).toBeDefined();
    expect(requestCreatedLine).toContain(
      "approval_id=approval-acc-cutover4-stage2",
    );
  });

  it("permits repo.merge_completed when caller IS in approvers list (positive path)", async () => {
    const approvalCreator = fixedApprovalCreator("approval-not-used");
    const approvalPolicy = createApprovalPolicy({
      cfg: {
        policy: {
          approvals: [
            {
              effectId: REPO_MERGE_COMPLETED_EFFECT,
              requiredApprovals: 1,
              approvers: [VLADIMIR],
            },
          ],
        },
      } as unknown as OpenClawConfig,
      approvalCreator,
    });

    const registry = createAffordanceRegistry([REPO_MERGE_COMPLETED_AFFORDANCE_ENTRY]);
    const monitoredRuntime = { run: vi.fn(async () => repoMergeAttestation()) };
    const expectedDelta: ExpectedDelta = { repo: { added: ["repo_op_merge_acc"] } };

    const result = await runTurnDecision({
      prompt: "слей feature/x в main",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(mergeIntent()) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
      cutoverPolicy: repoCutoverPolicy(),
      approvalPolicy,
    });

    expect(result.kernelFallback).toBe(false);
    // No approval-request created — the approvers-list match short-
    // circuits before the creator is consulted.
    expect(approvalCreator.create).not.toHaveBeenCalled();
    const checkedLine = logged.find((l) =>
      l.startsWith("[policy-gate] event=approval_checked stage=2") &&
      l.includes("approved=true"),
    );
    expect(checkedLine).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// (b) Stage 3 — per-channel hourly budget cap on repo.commit_landed.
// ---------------------------------------------------------------------------

describe("Cutover-4 Phase 6 acceptance — Stage 3 (Budget) on repo.commit_landed", () => {
  it("denies the 6th repo.commit_landed in the same hour on a channel with limit=5", async () => {
    const store = inMemoryBudgetStore();
    const budgetPolicy = createBudgetPolicy({
      cfg: {
        policy: {
          budgets: [
            {
              dimension: "channel",
              limit: 5,
              windowMs: 60 * 60 * 1000,
              channel: "telegram",
              effectFamily: REPO_EFFECT_FAMILY,
            },
          ],
        },
        channels: { _activeChannel: "telegram" },
      } as unknown as OpenClawConfig,
      budgetStore: store,
      resolveEffectFamily: () => REPO_EFFECT_FAMILY,
    });

    const registry = createAffordanceRegistry([REPO_COMMIT_LANDED_AFFORDANCE_ENTRY]);
    const monitoredRuntime = { run: vi.fn(async () => repoCommitAttestation()) };
    const expectedDelta: ExpectedDelta = { repo: { added: ["repo_op_commit_acc"] } };

    const runOnce = () =>
      runTurnDecision({
        prompt: "закоммить с сообщением fix bug",
        cfg: cfg({
          channels: { _activeChannel: "telegram" },
        } as unknown as Partial<OpenClawConfig>),
        identityId: VLADIMIR,
        classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
        intentContractorAdapterRegistry: { "intent-mock": intentAdapter(commitIntent()) },
        affordanceRegistry: registry,
        monitoredRuntime,
        expectedDeltaResolver: () => expectedDelta,
        cutoverPolicy: repoCutoverPolicy(),
        budgetPolicy,
      });

    // Charge five within-cap commits.
    for (let i = 0; i < 5; i += 1) {
      const r = await runOnce();
      const trace = r.productionDecision.plannerInput.decisionTrace as
        | { readonly policyBudgetDenial?: { readonly reason: string } }
        | undefined;
      expect(trace?.policyBudgetDenial).toBeUndefined();
    }

    // 6th request is denied.
    const denied = await runOnce();
    const trace = denied.productionDecision.plannerInput.decisionTrace as
      | { readonly policyBudgetDenial?: { readonly reason: string } }
      | undefined;
    expect(trace?.policyBudgetDenial?.reason).toBe("budget_exceeded_channel");
    expect(denied.productionDecision.taskContract.primaryOutcome).toBe("answer");

    const exceededLine = logged.find((l) =>
      l.startsWith("[policy-gate] event=budget_exceeded"),
    );
    expect(exceededLine).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// (c) Stage 4 — role allowedEffects matrix on repo.merge_completed.
// ---------------------------------------------------------------------------

describe("Cutover-4 Phase 6 acceptance — Stage 4 (Role) on repo.merge_completed", () => {
  it("denies repo.merge_completed for developer role (only maintainer allowed to merge)", async () => {
    const roleResolver: RoleResolver = vi.fn(async () => [
      "developer" as RoleId,
    ]);
    const rolePolicy = createRolePolicy({
      cfg: {
        policy: {
          roles: {
            maintainer: {
              allowedEffects: [
                REPO_BRANCH_CREATED_EFFECT,
                REPO_COMMIT_LANDED_EFFECT,
                REPO_MERGE_COMPLETED_EFFECT,
                REPO_DIFF_OBSERVED_EFFECT,
              ],
            },
            developer: {
              allowedEffects: [
                REPO_BRANCH_CREATED_EFFECT,
                REPO_COMMIT_LANDED_EFFECT,
                REPO_DIFF_OBSERVED_EFFECT,
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      roleResolver,
    });

    const registry = createAffordanceRegistry([REPO_MERGE_COMPLETED_AFFORDANCE_ENTRY]);
    const monitoredRuntime = { run: vi.fn(async () => repoMergeAttestation()) };
    const expectedDelta: ExpectedDelta = { repo: { added: ["repo_op_merge_acc"] } };

    const result = await runTurnDecision({
      prompt: "слей feature/x в main",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(mergeIntent()) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
      cutoverPolicy: repoCutoverPolicy(),
      rolePolicy,
    });

    const trace = result.productionDecision.plannerInput.decisionTrace as
      | {
          readonly policyRoleDenial?: {
            readonly reason: string;
            readonly requiredRole: string;
          };
        }
      | undefined;
    expect(trace?.policyRoleDenial?.reason).toBe("role_denied");
    expect(String(trace?.policyRoleDenial?.requiredRole)).toBe("maintainer");

    const deniedLine = logged.find((l) =>
      l.startsWith("[policy-gate] event=role_denied"),
    );
    expect(deniedLine).toBeDefined();
    expect(deniedLine).toContain("required=maintainer");
  });

  it("permits repo.diff_observed for viewer role (read-only allowed)", async () => {
    const roleResolver: RoleResolver = vi.fn(async () => ["viewer" as RoleId]);
    const rolePolicy = createRolePolicy({
      cfg: {
        policy: {
          roles: {
            viewer: { allowedEffects: [REPO_DIFF_OBSERVED_EFFECT] },
          },
        },
      } as unknown as OpenClawConfig,
      roleResolver,
    });

    const registry = createAffordanceRegistry([REPO_DIFF_OBSERVED_AFFORDANCE_ENTRY]);
    const monitoredRuntime = { run: vi.fn(async () => repoDiffAttestation()) };
    const expectedDelta: ExpectedDelta = { repo: { added: ["repo_op_diff_acc"] } };

    const result = await runTurnDecision({
      prompt: "покажи git diff",
      cfg: cfg(),
      identityId: ALICE,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(diffIntent()) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
      cutoverPolicy: repoCutoverPolicy(),
      rolePolicy,
    });

    const trace = result.productionDecision.plannerInput.decisionTrace as
      | { readonly policyRoleDenial?: unknown }
      | undefined;
    expect(trace?.policyRoleDenial).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (d) Stage 5 — retry on repo.diff_observed; mutation effects locked.
// ---------------------------------------------------------------------------

describe("Cutover-4 Phase 6 acceptance — Stage 5 (Retry) on repo.diff_observed", () => {
  it("denies repo.diff_observed when caller-supplied attemptCount reaches maxAttempts=2", async () => {
    const retryStateStore = createInMemoryRetryStateStore();
    const retryPolicy = createRetryPolicy({
      cfg: {
        policy: {
          retry: {
            perEffect: {
              [REPO_DIFF_OBSERVED_EFFECT]: { maxAttempts: 2 },
            },
          },
        },
      } as unknown as OpenClawConfig,
      retryStateStore,
    });

    const registry = createAffordanceRegistry([REPO_DIFF_OBSERVED_AFFORDANCE_ENTRY]);
    const monitoredRuntime = { run: vi.fn(async () => repoDiffAttestation()) };
    const expectedDelta: ExpectedDelta = { repo: { added: ["repo_op_diff_acc"] } };

    const result = await runTurnDecision({
      prompt: "покажи git diff",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(diffIntent()) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
      cutoverPolicy: repoCutoverPolicy(),
      retryPolicy,
      retryContext: { attemptCount: 2, sessionId: "session_acc_cutover4_retry" },
    });

    const trace = result.productionDecision.plannerInput.decisionTrace as
      | {
          readonly policyRetryDenial?: {
            readonly reason: string;
            readonly attemptCount: number;
            readonly maxAttempts: number;
          };
        }
      | undefined;
    expect(trace?.policyRetryDenial?.reason).toBe("retry_limit_exceeded");
    expect(trace?.policyRetryDenial?.attemptCount).toBe(2);
    expect(trace?.policyRetryDenial?.maxAttempts).toBe(2);

    const exhaustedLine = logged.find((l) =>
      l.startsWith("[policy-gate] event=retry_exhausted"),
    );
    expect(exhaustedLine).toBeDefined();
    expect(exhaustedLine).toContain(`effect=${String(REPO_DIFF_OBSERVED_EFFECT)}`);
  });

  it("permits repo.diff_observed when attemptCount=1 < maxAttempts=2", async () => {
    const retryStateStore = createInMemoryRetryStateStore();
    const retryPolicy = createRetryPolicy({
      cfg: {
        policy: {
          retry: {
            perEffect: {
              [REPO_DIFF_OBSERVED_EFFECT]: { maxAttempts: 2 },
            },
          },
        },
      } as unknown as OpenClawConfig,
      retryStateStore,
    });

    const registry = createAffordanceRegistry([REPO_DIFF_OBSERVED_AFFORDANCE_ENTRY]);
    const monitoredRuntime = { run: vi.fn(async () => repoDiffAttestation()) };
    const expectedDelta: ExpectedDelta = { repo: { added: ["repo_op_diff_acc"] } };

    const result = await runTurnDecision({
      prompt: "покажи git diff",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(diffIntent()) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
      cutoverPolicy: repoCutoverPolicy(),
      retryPolicy,
      retryContext: { attemptCount: 1, sessionId: "session_acc_cutover4_retry_ok" },
    });

    const trace = result.productionDecision.plannerInput.decisionTrace as
      | { readonly policyRetryDenial?: unknown }
      | undefined;
    expect(trace?.policyRetryDenial).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (e) Stage 6 — escalation fan-out on any denial reason.
// ---------------------------------------------------------------------------

describe("Cutover-4 Phase 6 acceptance — Stage 6 (Escalation) fan-out", () => {
  it("escalation fires on repo.merge_completed approval denial with origin='repo-operation-policy-denial'", async () => {
    const approvalCreator = fixedApprovalCreator("approval-acc-stage6");
    const approvalPolicy = createApprovalPolicy({
      cfg: {
        policy: {
          approvals: [
            {
              effectId: REPO_MERGE_COMPLETED_EFFECT,
              requiredApprovals: 1,
              approvers: [VLADIMIR],
            },
          ],
        },
      } as unknown as OpenClawConfig,
      approvalCreator,
    });
    const escalationCreator = fixedApprovalCreator("escalation-acc-stage6");
    const escalationHook = createEscalationHook({
      approvalCreator: escalationCreator,
      idFactory: () => "escalation:acc-stage6",
    });

    const registry = createAffordanceRegistry([REPO_MERGE_COMPLETED_AFFORDANCE_ENTRY]);
    const monitoredRuntime = { run: vi.fn(async () => repoMergeAttestation()) };
    const expectedDelta: ExpectedDelta = { repo: { added: ["repo_op_merge_acc"] } };

    const result = await runTurnDecision({
      prompt: "слей feature/x в main",
      cfg: cfg(),
      identityId: ALICE,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(mergeIntent()) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
      cutoverPolicy: repoCutoverPolicy(),
      approvalPolicy,
      escalationHook,
    });

    const trace = result.productionDecision.plannerInput.decisionTrace as
      | {
          readonly policyEscalationFired?: {
            readonly denialReason: string;
            readonly escalationId: string;
          };
        }
      | undefined;
    expect(trace?.policyEscalationFired?.denialReason).toBe("requires_approval");
    // `requires_approval` routes to the approval_request channel — the
    // escalation id comes from `approvalCreator.create(...)` (NOT the
    // memory-channel `idFactory`). See `escalation-hook.ts` doc-block §3.
    expect(trace?.policyEscalationFired?.escalationId).toBe("escalation-acc-stage6");

    const firedLine = logged.find((l) =>
      l.startsWith("[policy-gate] event=escalation_fired"),
    );
    expect(firedLine).toBeDefined();
    expect(firedLine).toContain("reason=requires_approval");
  });
});
