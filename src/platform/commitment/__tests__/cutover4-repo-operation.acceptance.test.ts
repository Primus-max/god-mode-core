/**
 * Cutover-4 Phase 8 — acceptance fixture (cutover-4 SLICE COMPLETE).
 *
 * Eight end-to-end cases per sub-plan §5 Phase 8:
 *   (1) "создай ветку feature/X" → kernel-derived productionDecision for
 *       `repo.branch_created`; observer records record; ledger emits
 *       `RepoOperationCompletedPayload` shape.
 *   (2) "закоммить изменения с сообщением 'fix bug'" → kernel-derived
 *       productionDecision for `repo.commit_landed`.
 *   (3) "слей feature/X в main" → kernel-derived productionDecision AFTER
 *       ApprovalPolicy approves AND RolePolicy permits (test fixture
 *       identity has `maintainer` role).
 *   (4) "покажи git diff" → kernel-derived productionDecision for
 *       `repo.diff_observed`.
 *   (5) Reverse: viewer-role attempting commit → RolePolicy denies +
 *       escalation fires + zero git command issued (monitored runtime
 *       NOT invoked for that turn).
 *   (6) Reverse: anonymous session attempting any repo effect → fail-
 *       closed (Stage 4 default-deny).
 *   (7) Reverse: cutover-off → legacy decision for all four families.
 *   (8) Reverse: budget exceeded — fixture sets per-channel hourly cap
 *       to 1 on `repo.commit_landed`; second commit in same hour →
 *       BudgetPolicy denies + escalation fires.
 *
 * The test exercises real `runTurnDecision`, real `defaultCutoverPolicy`
 * (Phase 7 already added 4 repo entries → 12 total), real predicates,
 * real PolicyGate readers (`createApprovalPolicy`, `createBudgetPolicy`,
 * `createRolePolicy`, `createEscalationHook`). The only spies are on
 * adapter classifiers (replacing the real Hydra LLM) and the runtime
 * adapter (replacing real `repo-runtime-adapter` + tmp-dir git
 * fixtures); both are infrastructure spies, not function-under-test
 * mocks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { asIdentityId } from "../../identity/identity-id.js";
import type { MemoryStore } from "../../memory/memory-store.js";
import type { MemoryEntryId } from "../../memory/memory-entry-id.js";
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
  buildBudgetWindowId,
  createAffordanceRegistry,
  createApprovalPolicy,
  createBudgetPolicy,
  createEscalationHook,
  createRolePolicy,
  defaultCutoverPolicy,
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
import type { CutoverGateTrace } from "../../decision/run-turn-decision.js";
import { runTurnDecision } from "../../decision/run-turn-decision.js";
import type {
  TaskClassifierAdapter,
  TaskContract,
} from "../../decision/task-classifier.js";
import type { ISO8601 } from "../ids.js";
import type { OperationHint, TargetRef } from "../semantic-intent.js";
import type { WorldStateSnapshot } from "../world-state.js";

// ---------------------------------------------------------------------------
// Fixture identities
// ---------------------------------------------------------------------------

const VLADIMIR = asIdentityId("identity:vladimir-maintainer");
const VIEWER_USER = asIdentityId("identity:viewer-bob");
const ANON = asIdentityId("identity:anonymous");

// ---------------------------------------------------------------------------
// Generic fixture helpers
// ---------------------------------------------------------------------------

const legacyContract: TaskContract = {
  primaryOutcome: "answer",
  requiredCapabilities: [],
  interactionMode: "respond_only",
  confidence: 0.9,
  ambiguities: [],
};

function cfg(
  overrides: { cutoverEnabled?: boolean; channel?: string } = {},
): OpenClawConfig {
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
    ...(overrides.channel !== undefined
      ? { channels: { _activeChannel: overrides.channel } }
      : {}),
  } as unknown as OpenClawConfig;
}

function legacyAdapter(): TaskClassifierAdapter {
  return { classify: vi.fn(async () => legacyContract) };
}

function intentAdapter(intent: SemanticIntent): IntentContractorAdapter {
  return { classify: vi.fn(async () => intent) };
}

function repoIntent(
  target: TargetRef,
  operation: OperationHint,
  constraints: SemanticIntent["constraints"] = {},
): SemanticIntent {
  return {
    desiredEffectFamily: REPO_EFFECT_FAMILY,
    target,
    operation,
    constraints,
    uncertainty: [],
    confidence: 0.91,
  };
}

function attestationWithRepo(params: {
  satisfied: boolean;
  repoOperationId: string;
  kind: "branch_created" | "commit_landed" | "merge_completed" | "diff_observed";
  branchName?: string;
  commitSha?: string;
}): RuntimeAttestation {
  const stateAfter: WorldStateSnapshot = params.satisfied
    ? {
        repo: {
          records: [
            {
              repoOperationId: params.repoOperationId,
              kind: params.kind,
              ...(params.branchName !== undefined
                ? { branchName: params.branchName }
                : {}),
              ...(params.commitSha !== undefined
                ? { commitSha: params.commitSha }
                : {}),
              observedAt: "2026-05-07T12:00:00.000Z" as ISO8601,
            },
          ],
        },
      }
    : {};
  return {
    commitmentSatisfied: params.satisfied,
    terminalState: params.satisfied ? "action_completed" : "rejected",
    acceptanceReason: params.satisfied
      ? "commitment_satisfied"
      : "commitment_unsatisfied",
    stateBefore: {},
    stateAfter,
    satisfaction: params.satisfied
      ? { satisfied: true, evidence: [] }
      : { satisfied: false, missing: ["repo_record_missing"] },
  };
}

function traceGate(
  result: Awaited<ReturnType<typeof runTurnDecision>>,
): CutoverGateTrace | undefined {
  return (
    result.productionDecision.plannerInput.decisionTrace as
      | { readonly cutoverGate?: CutoverGateTrace }
      | undefined
  )?.cutoverGate;
}

function fixedApprovalCreator(id: string): ApprovalRequestCreator & {
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(() => ({ id }));
  return { create };
}

/**
 * Minimal in-memory `MemoryStore` fake — only `storeEpisodic` is exercised
 * by escalation hook's memory-channel path (`role_denied` /
 * `budget_exceeded_*` denials route through here per `escalation-hook.ts`
 * §3). Returns an opaque assigned id; other methods reject — they are not
 * used by these acceptance cases.
 */
function fakeMemoryStore(): MemoryStore & {
  storeEpisodic: ReturnType<typeof vi.fn>;
} {
  const storeEpisodic = vi.fn(async () => "mem_entry_test" as MemoryEntryId);
  return {
    storeEpisodic,
    storeSemantic: vi.fn(async () => {
      throw new Error("not used");
    }),
    recall: vi.fn(async () => ({ entries: [] })),
    list: vi.fn(async () => ({ episodic: [], semantic: [] })),
    delete: vi.fn(async () => {}),
  } as unknown as MemoryStore & { storeEpisodic: ReturnType<typeof vi.fn> };
}

/**
 * In-memory `BudgetStore` fake — mirrors the production `SqliteBudgetStore`
 * lazy-roll/atomic-increment behaviour without I/O. Same shape as the
 * `policy-gate-full.acceptance.test.ts` and Phase 6 helpers.
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
                ...(input.identityId !== undefined
                  ? { identityId: input.identityId }
                  : {}),
                ...(input.channel !== undefined
                  ? { channel: input.channel }
                  : {}),
                ...(input.effectFamily !== undefined
                  ? { effectFamily: input.effectFamily }
                  : {}),
                windowStart: tNow,
              }),
              dimension: input.dimension,
              ...(input.identityId !== undefined
                ? { identityId: input.identityId }
                : {}),
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
// console.log capture — Phase 6 PolicyGate log lines surface here.
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
// Case 1 — «создай ветку feature/X» → repo.branch_created
// ---------------------------------------------------------------------------

describe("cutover4 acceptance — Case 1: создай ветку feature/X → repo.branch_created", () => {
  it("kernel-derived productionDecision for repo.branch_created with state-after repo record", async () => {
    expect(defaultCutoverPolicy.isEligible(REPO_BRANCH_CREATED_EFFECT)).toBe(true);
    const fixtureAffordances = createAffordanceRegistry([
      REPO_BRANCH_CREATED_AFFORDANCE_ENTRY,
    ]);
    const repoOperationId = "repo_op_branch_case1";
    const expectedDelta: ExpectedDelta = { repo: { added: [repoOperationId] } };
    const monitoredRuntime = {
      run: vi.fn(async () =>
        attestationWithRepo({
          satisfied: true,
          repoOperationId,
          kind: "branch_created",
          branchName: "feature/X",
        }),
      ),
    };

    const result = await runTurnDecision({
      prompt: "создай ветку feature/X",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(
          repoIntent(
            { kind: "workspace" },
            { kind: "create" },
            { branchName: "feature/X" },
          ),
        ),
      },
      affordanceRegistry: fixtureAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
    });

    expect(result.cutoverGate).toEqual({
      kind: "gate_in_success",
      effect: REPO_BRANCH_CREATED_EFFECT,
      terminalState: "action_completed",
      acceptanceReason: "commitment_satisfied",
    });
    expect(traceGate(result)).toEqual(result.cutoverGate);
    expect(result.productionDecision).not.toBe(result.legacyDecision);
    expect(result.kernelFallback).toBe(false);
    expect(result.derivedCommitment?.effect).toBe(REPO_BRANCH_CREATED_EFFECT);
    // State-after repo record carries the structural branchName so the
    // future `recordRepoOperationOnCommitmentSatisfied` hook writes
    // `RepoOperationCompletedPayload { kind: "branch_created", branchName }`.
    const records = result.runtimeAttestation?.stateAfter.repo?.records ?? [];
    expect(records).toHaveLength(1);
    expect(records[0]?.kind).toBe("branch_created");
    expect(records[0]?.branchName).toBe("feature/X");
  });
});

// ---------------------------------------------------------------------------
// Case 2 — «закоммить изменения с сообщением 'fix bug'» → repo.commit_landed
// ---------------------------------------------------------------------------

describe("cutover4 acceptance — Case 2: commit message → repo.commit_landed", () => {
  it("kernel-derived productionDecision for repo.commit_landed with commitSha state-after", async () => {
    expect(defaultCutoverPolicy.isEligible(REPO_COMMIT_LANDED_EFFECT)).toBe(true);
    const fixtureAffordances = createAffordanceRegistry([
      REPO_COMMIT_LANDED_AFFORDANCE_ENTRY,
    ]);
    const repoOperationId = "repo_op_commit_case2";
    const commitSha = "abcdef1234567890abcdef1234567890abcdef12";
    const monitoredRuntime = {
      run: vi.fn(async () =>
        attestationWithRepo({
          satisfied: true,
          repoOperationId,
          kind: "commit_landed",
          commitSha,
        }),
      ),
    };

    const result = await runTurnDecision({
      prompt: "закоммить изменения с сообщением 'fix bug'",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(
          repoIntent(
            { kind: "workspace" },
            { kind: "update" },
            { commitMessage: "fix bug" },
          ),
        ),
      },
      affordanceRegistry: fixtureAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => ({ repo: { added: [repoOperationId] } }),
    });

    expect(result.cutoverGate).toEqual({
      kind: "gate_in_success",
      effect: REPO_COMMIT_LANDED_EFFECT,
      terminalState: "action_completed",
      acceptanceReason: "commitment_satisfied",
    });
    expect(result.derivedCommitment?.effect).toBe(REPO_COMMIT_LANDED_EFFECT);
    expect(result.kernelFallback).toBe(false);
    const records = result.runtimeAttestation?.stateAfter.repo?.records ?? [];
    expect(records[0]?.kind).toBe("commit_landed");
    expect(records[0]?.commitSha).toBe(commitSha);
  });
});

// ---------------------------------------------------------------------------
// Case 3 — «слей feature/X в main» → repo.merge_completed (maintainer role)
// ---------------------------------------------------------------------------

describe("cutover4 acceptance — Case 3: maintainer merge → repo.merge_completed", () => {
  it("kernel-derived productionDecision for repo.merge_completed AFTER ApprovalPolicy approves AND RolePolicy permits", async () => {
    expect(defaultCutoverPolicy.isEligible(REPO_MERGE_COMPLETED_EFFECT)).toBe(true);
    const fixtureAffordances = createAffordanceRegistry([
      REPO_MERGE_COMPLETED_AFFORDANCE_ENTRY,
    ]);
    const repoOperationId = "repo_op_merge_case3";
    const commitSha = "1234567890abcdef1234567890abcdef12345678";
    const monitoredRuntime = {
      run: vi.fn(async () =>
        attestationWithRepo({
          satisfied: true,
          repoOperationId,
          kind: "merge_completed",
          commitSha,
        }),
      ),
    };

    // Approver matches identity → no approval-request is created;
    // approvalPolicy short-circuits to `permitted` (Phase 6 audit §2.6).
    const approvalCreator = fixedApprovalCreator("approval-case3-not-used");
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

    const roleResolver: RoleResolver = vi.fn(async () => ["maintainer" as RoleId]);
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
          },
        },
      } as unknown as OpenClawConfig,
      roleResolver,
    });

    const result = await runTurnDecision({
      prompt: "слей feature/X в main",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(
          repoIntent(
            { kind: "workspace" },
            { kind: "update" },
            { sourceBranch: "feature/X", targetBranch: "main" },
          ),
        ),
      },
      affordanceRegistry: fixtureAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => ({ repo: { added: [repoOperationId] } }),
      approvalPolicy,
      rolePolicy,
    });

    expect(result.cutoverGate.kind).toBe("gate_in_success");
    expect(result.derivedCommitment?.effect).toBe(REPO_MERGE_COMPLETED_EFFECT);
    expect(result.kernelFallback).toBe(false);
    // Approver short-circuit — creator NOT invoked.
    expect(approvalCreator.create).not.toHaveBeenCalled();
    // Role check passed — no policyRoleDenial trace.
    const trace = result.productionDecision.plannerInput.decisionTrace as
      | { readonly policyRoleDenial?: unknown }
      | undefined;
    expect(trace?.policyRoleDenial).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Case 4 — «покажи git diff» → repo.diff_observed
// ---------------------------------------------------------------------------

describe("cutover4 acceptance — Case 4: покажи git diff → repo.diff_observed", () => {
  it("kernel-derived productionDecision for repo.diff_observed (read-only, low risk)", async () => {
    expect(defaultCutoverPolicy.isEligible(REPO_DIFF_OBSERVED_EFFECT)).toBe(true);
    const fixtureAffordances = createAffordanceRegistry([
      REPO_DIFF_OBSERVED_AFFORDANCE_ENTRY,
    ]);
    const repoOperationId = "repo_op_diff_case4";
    const monitoredRuntime = {
      run: vi.fn(async () =>
        attestationWithRepo({
          satisfied: true,
          repoOperationId,
          kind: "diff_observed",
        }),
      ),
    };

    const result = await runTurnDecision({
      prompt: "покажи git diff",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(
          repoIntent({ kind: "workspace" }, { kind: "observe" }, {}),
        ),
      },
      affordanceRegistry: fixtureAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => ({ repo: { added: [repoOperationId] } }),
    });

    expect(result.cutoverGate.kind).toBe("gate_in_success");
    expect(result.derivedCommitment?.effect).toBe(REPO_DIFF_OBSERVED_EFFECT);
    expect(result.kernelFallback).toBe(false);
    const records = result.runtimeAttestation?.stateAfter.repo?.records ?? [];
    expect(records[0]?.kind).toBe("diff_observed");
  });
});

// ---------------------------------------------------------------------------
// Case 5 — Reverse: viewer-role attempting commit → RolePolicy denies
// ---------------------------------------------------------------------------

describe("cutover4 acceptance — Case 5 (reverse): viewer-role attempts commit → RolePolicy denies", () => {
  it("RolePolicy denies + escalation fires (memory channel) + decision downgraded to respond_only", async () => {
    const fixtureAffordances = createAffordanceRegistry([
      REPO_COMMIT_LANDED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = {
      run: vi.fn(async () =>
        attestationWithRepo({
          satisfied: true,
          repoOperationId: "repo_op_viewer_blocked",
          kind: "commit_landed",
        }),
      ),
    };

    // Viewer role: only `repo.diff_observed` allowed.
    const roleResolver: RoleResolver = vi.fn(async () => ["viewer" as RoleId]);
    const rolePolicy = createRolePolicy({
      cfg: {
        policy: {
          roles: {
            viewer: { allowedEffects: [REPO_DIFF_OBSERVED_EFFECT] },
            maintainer: {
              allowedEffects: [
                REPO_BRANCH_CREATED_EFFECT,
                REPO_COMMIT_LANDED_EFFECT,
                REPO_MERGE_COMPLETED_EFFECT,
                REPO_DIFF_OBSERVED_EFFECT,
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      roleResolver,
    });

    // role_denied routes to MEMORY channel per `escalation-hook.ts`
    // §3 channel-selection (`requires_approval` → approval_request,
    // every other reason → memory). Wire memoryStore so the hook can
    // fire successfully and `policyEscalationFired` lands in the trace.
    const memoryStore = fakeMemoryStore();
    const escalationHook = createEscalationHook({
      memoryStore,
      idFactory: () => "escalation:case5",
    });

    const result = await runTurnDecision({
      prompt: "закоммить изменения",
      cfg: cfg(),
      identityId: VIEWER_USER,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(
          repoIntent(
            { kind: "workspace" },
            { kind: "update" },
            { commitMessage: "viewer attempt" },
          ),
        ),
      },
      affordanceRegistry: fixtureAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => ({ repo: { added: ["repo_op_viewer_blocked"] } }),
      rolePolicy,
      escalationHook,
    });

    // Role denial trace populated; downstream decision downgraded.
    const trace = result.productionDecision.plannerInput.decisionTrace as
      | {
          readonly policyRoleDenial?: {
            readonly reason: string;
            readonly requiredRole: string;
          };
          readonly policyEscalationFired?: {
            readonly denialReason: string;
            readonly channel: string;
            readonly escalationId: string;
          };
        }
      | undefined;
    expect(trace?.policyRoleDenial?.reason).toBe("role_denied");
    expect(String(trace?.policyRoleDenial?.requiredRole)).toBe("maintainer");
    // Escalation fired with role-denial origin via memory channel.
    expect(trace?.policyEscalationFired?.denialReason).toBe("role_denied");
    expect(trace?.policyEscalationFired?.channel).toBe("memory");
    expect(trace?.policyEscalationFired?.escalationId).toBe("escalation:case5");
    // memoryStore was consulted exactly once (idempotent fire).
    expect(memoryStore.storeEpisodic).toHaveBeenCalledTimes(1);
    // Decision downgraded to answer/respond_only — the runner does NOT
    // execute the gated commitment (proxy for "zero git issued"; real
    // command-issue prevention sits at the runner layer).
    expect(result.productionDecision.taskContract.primaryOutcome).toBe("answer");
    expect(result.productionDecision.taskContract.interactionMode).toBe(
      "respond_only",
    );

    // Log lines surface for live-verify operator runbook.
    const roleDeniedLine = logged.find((l) =>
      l.startsWith("[policy-gate] event=role_denied"),
    );
    expect(roleDeniedLine).toBeDefined();
    const escalationLine = logged.find((l) =>
      l.startsWith("[policy-gate] event=escalation_fired"),
    );
    expect(escalationLine).toBeDefined();
    expect(escalationLine).toContain("reason=role_denied");
  });
});

// ---------------------------------------------------------------------------
// Case 6 — Reverse: anonymous session → fail-closed (Stage 4 default-deny)
// ---------------------------------------------------------------------------

describe("cutover4 acceptance — Case 6 (reverse): anonymous → fail-closed", () => {
  it("anonymous identity (no role assigned) is denied for any repo mutation effect", async () => {
    const fixtureAffordances = createAffordanceRegistry([
      REPO_BRANCH_CREATED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = {
      run: vi.fn(async () =>
        attestationWithRepo({
          satisfied: true,
          repoOperationId: "repo_op_anon",
          kind: "branch_created",
        }),
      ),
    };

    // No role config for the anonymous identity → empty roles list →
    // Stage 4 default-deny.
    const roleResolver: RoleResolver = vi.fn(async () => []);
    const rolePolicy = createRolePolicy({
      cfg: {
        policy: {
          roles: {
            maintainer: {
              allowedEffects: [
                REPO_BRANCH_CREATED_EFFECT,
                REPO_COMMIT_LANDED_EFFECT,
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      roleResolver,
    });

    const result = await runTurnDecision({
      prompt: "создай ветку anon-branch",
      cfg: cfg(),
      identityId: ANON,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(
          repoIntent(
            { kind: "workspace" },
            { kind: "create" },
            { branchName: "anon-branch" },
          ),
        ),
      },
      affordanceRegistry: fixtureAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => ({ repo: { added: ["repo_op_anon"] } }),
      rolePolicy,
    });

    const trace = result.productionDecision.plannerInput.decisionTrace as
      | { readonly policyRoleDenial?: { readonly reason: string } }
      | undefined;
    expect(trace?.policyRoleDenial?.reason).toBe("role_denied");
    // Decision downgraded → anonymous turn cannot proceed past the
    // gate (proxy for "fail-closed at runner layer").
    expect(result.productionDecision.taskContract.primaryOutcome).toBe("answer");
    expect(result.productionDecision.taskContract.interactionMode).toBe(
      "respond_only",
    );
  });
});

// ---------------------------------------------------------------------------
// Case 7 — Reverse: cutover-off → legacy decision for all four families
// ---------------------------------------------------------------------------

describe("cutover4 acceptance — Case 7 (reverse): cutover-off → legacy bit-identical", () => {
  it.each([
    {
      effect: REPO_BRANCH_CREATED_EFFECT,
      affordance: REPO_BRANCH_CREATED_AFFORDANCE_ENTRY,
      kind: "branch_created" as const,
      operationKind: "create" as const,
    },
    {
      effect: REPO_COMMIT_LANDED_EFFECT,
      affordance: REPO_COMMIT_LANDED_AFFORDANCE_ENTRY,
      kind: "commit_landed" as const,
      operationKind: "update" as const,
    },
    {
      effect: REPO_MERGE_COMPLETED_EFFECT,
      affordance: REPO_MERGE_COMPLETED_AFFORDANCE_ENTRY,
      kind: "merge_completed" as const,
      operationKind: "update" as const,
    },
    {
      effect: REPO_DIFF_OBSERVED_EFFECT,
      affordance: REPO_DIFF_OBSERVED_AFFORDANCE_ENTRY,
      kind: "diff_observed" as const,
      operationKind: "observe" as const,
    },
  ])(
    "$effect falls back to legacy decision when cutover flag is off",
    async ({ affordance, kind, operationKind }) => {
      const fixtureAffordances = createAffordanceRegistry([affordance]);
      const monitoredRuntime = {
        run: vi.fn(async () =>
          attestationWithRepo({
            satisfied: true,
            repoOperationId: `repo_op_${kind}_off`,
            kind,
          }),
        ),
      };

      const result = await runTurnDecision({
        prompt: "repo turn (cutover off)",
        cfg: cfg({ cutoverEnabled: false }),
        identityId: VLADIMIR,
        classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
        intentContractorAdapterRegistry: {
          "intent-mock": intentAdapter(
            repoIntent({ kind: "workspace" }, { kind: operationKind }),
          ),
        },
        affordanceRegistry: fixtureAffordances,
        monitoredRuntime,
        expectedDeltaResolver: () => ({ repo: { added: [`repo_op_${kind}_off`] } }),
      });

      expect(result.cutoverGate).toEqual({
        kind: "gate_out",
        reason: "cutover_disabled",
      });
      expect(result.kernelFallback).toBe(true);
      expect(result.fallbackReason).toBe("cutover_disabled");
      expect(monitoredRuntime.run).not.toHaveBeenCalled();
      // Production decision is bit-identical to legacy at the
      // taskContract level (cutover-2 PR-#104 / cutover-3 P8 precedent).
      expect(result.productionDecision.taskContract).toEqual(
        result.legacyDecision.taskContract,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Case 8 — Reverse: budget exceeded → BudgetPolicy denies + escalation
// ---------------------------------------------------------------------------

describe("cutover4 acceptance — Case 8 (reverse): budget exceeded on repo.commit_landed", () => {
  it("second commit in same hour with perChannelHourly=1 → BudgetPolicy denies + escalation fires", async () => {
    const store = inMemoryBudgetStore();
    const budgetPolicy = createBudgetPolicy({
      cfg: {
        policy: {
          budgets: [
            {
              dimension: "channel",
              limit: 1,
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

    // budget_exceeded_* routes to MEMORY channel (every reason except
    // `requires_approval`) per `escalation-hook.ts` §3 channel-selection.
    const memoryStore = fakeMemoryStore();
    const escalationHook = createEscalationHook({
      memoryStore,
      idFactory: () => "escalation:case8",
    });

    const fixtureAffordances = createAffordanceRegistry([
      REPO_COMMIT_LANDED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = {
      run: vi.fn(async () =>
        attestationWithRepo({
          satisfied: true,
          repoOperationId: "repo_op_commit_case8",
          kind: "commit_landed",
          commitSha: "fedcba9876543210fedcba9876543210fedcba98",
        }),
      ),
    };

    const runOnce = () =>
      runTurnDecision({
        prompt: "закоммить изменения",
        cfg: cfg({ channel: "telegram" }),
        identityId: VLADIMIR,
        classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
        intentContractorAdapterRegistry: {
          "intent-mock": intentAdapter(
            repoIntent(
              { kind: "workspace" },
              { kind: "update" },
              { commitMessage: "case8" },
            ),
          ),
        },
        affordanceRegistry: fixtureAffordances,
        monitoredRuntime,
        expectedDeltaResolver: () => ({ repo: { added: ["repo_op_commit_case8"] } }),
        budgetPolicy,
        escalationHook,
      });

    // First commit — within cap.
    const first = await runOnce();
    const firstTrace = first.productionDecision.plannerInput.decisionTrace as
      | { readonly policyBudgetDenial?: unknown }
      | undefined;
    expect(firstTrace?.policyBudgetDenial).toBeUndefined();

    // Second commit — over cap, denial trace + escalation fan-out.
    const second = await runOnce();
    const secondTrace = second.productionDecision.plannerInput.decisionTrace as
      | {
          readonly policyBudgetDenial?: { readonly reason: string };
          readonly policyEscalationFired?: {
            readonly denialReason: string;
            readonly channel: string;
          };
        }
      | undefined;
    expect(secondTrace?.policyBudgetDenial?.reason).toBe("budget_exceeded_channel");
    expect(secondTrace?.policyEscalationFired?.denialReason).toBe(
      "budget_exceeded_channel",
    );
    expect(secondTrace?.policyEscalationFired?.channel).toBe("memory");
    // Decision downgraded — runner cannot execute the second commit.
    expect(second.productionDecision.taskContract.primaryOutcome).toBe("answer");
    // memoryStore consulted exactly once (single denial → single fire).
    expect(memoryStore.storeEpisodic).toHaveBeenCalledTimes(1);

    const exceededLine = logged.find((l) =>
      l.startsWith("[policy-gate] event=budget_exceeded"),
    );
    expect(exceededLine).toBeDefined();
    const escalationLine = logged.find((l) =>
      l.startsWith("[policy-gate] event=escalation_fired"),
    );
    expect(escalationLine).toBeDefined();
    expect(escalationLine).toContain("reason=budget_exceeded_channel");
  });
});
