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
  defaultCutoverPolicy,
  type ExpectedDelta,
  type IntentContractorAdapter,
  type RuntimeAttestation,
} from "../commitment/index.js";
import type { EffectId, ISO8601 } from "../commitment/ids.js";
import type {
  OperationHint,
  SemanticIntent,
  TargetRef,
} from "../commitment/semantic-intent.js";
import type { WorldStateSnapshot } from "../commitment/world-state.js";
import type { CutoverGateTrace } from "./run-turn-decision.js";
import { runTurnDecision } from "./run-turn-decision.js";
import type { TaskClassifierAdapter, TaskContract } from "./task-classifier.js";

/**
 * Cutover-4 Phase 7 routing flip contract.
 *
 * Asserts that the four repo effects (`repo.branch_created`,
 * `repo.commit_landed`, `repo.merge_completed`, `repo.diff_observed`)
 * flip to kernel-derived `productionDecision` when the cutover-policy
 * allow-list is extended in-place (Phase 7) and runtime attests
 * `commitmentSatisfied=true`. Mirrors `run-turn-decision.cutover3.test.ts`
 * (cutover-3 artifact effects) shape with one parametrised it.each row
 * per repo effect.
 *
 * The shadow-builder rejects the repo family with `multiple_candidates`
 * when more than one affordance matches the (target, op) pair (e.g.
 * `commit_landed` + `merge_completed` both match
 * `target.kind=workspace` + `op.kind=update`). To exercise the
 * cutover-policy flip in isolation, each parametrised row uses a
 * fixture single-affordance registry — same posture as cutover-2's
 * out-of-pool regression test (`run-turn-decision.cutover2.test.ts:217`)
 * and cutover-3 Phase 7's parametrised matrix.
 *
 * Out of scope (separate test files / phases):
 *  - PolicyGate Stage 2-6 chain → `run-turn-decision.cutover4-policy-gate.test.ts` (Phase 6).
 *  - Per-effect runtime adapter wiring → `repo-runtime-adapter.test.ts` (Phase 5).
 *  - Done-predicate per-effect coverage → `done-predicate-repo-*.test.ts` (Phase 4).
 *  - Telegram acceptance fixture → Phase 8 (deferred).
 */

// `repo_operation.completed` is the cutover-4 placeholder family-effect
// id (NOT in `CUTOVER_2`). The four enumerated `repo.*` ids above are the
// only repo effects routed through the kernel.
const REPO_NOT_IN_FAMILY: EffectId = "repo_operation.completed" as EffectId;

const legacyContract: TaskContract = {
  primaryOutcome: "answer",
  requiredCapabilities: [],
  interactionMode: "respond_only",
  confidence: 0.9,
  ambiguities: [],
};

function cfg(overrides: { cutoverEnabled?: boolean } = {}): OpenClawConfig {
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
  } as OpenClawConfig;
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
    confidence: 0.9,
  };
}

function attestationWithRepo(params: {
  satisfied: boolean;
  repoOperationId: string;
  kind:
    | "branch_created"
    | "commit_landed"
    | "merge_completed"
    | "diff_observed";
  branchName?: string;
  commitSha?: string;
}): RuntimeAttestation {
  // Synthetic state-after carries the matching repo record so the
  // runtime adapter (Phase 5) shape is replayed without invoking it.
  // This test asserts the cutover-policy flip + decision routing only;
  // the actual write side is exercised in `repo-runtime-adapter.test.ts`.
  const stateAfter: WorldStateSnapshot = params.satisfied
    ? {
        repo: {
          records: [
            {
              repoOperationId: params.repoOperationId,
              kind: params.kind,
              ...(params.branchName ? { branchName: params.branchName } : {}),
              ...(params.commitSha ? { commitSha: params.commitSha } : {}),
              observedAt: "2026-05-06T12:00:00.000Z" as ISO8601,
            },
          ],
        },
      }
    : {};
  return {
    commitmentSatisfied: params.satisfied,
    terminalState: params.satisfied ? "action_completed" : "rejected",
    acceptanceReason: params.satisfied ? "commitment_satisfied" : "commitment_unsatisfied",
    stateBefore: {},
    stateAfter,
    satisfaction: params.satisfied
      ? { satisfied: true, evidence: [] }
      : { satisfied: false, missing: ["repo_record_missing"] },
  };
}

function traceGate(result: Awaited<ReturnType<typeof runTurnDecision>>): CutoverGateTrace | undefined {
  return (
    result.productionDecision.plannerInput.decisionTrace as
      | { readonly cutoverGate?: CutoverGateTrace }
      | undefined
  )?.cutoverGate;
}

describe("runTurnDecision cutover-4 (Phase 7 — repo effect routing flip)", () => {
  it.each([
    {
      effect: REPO_BRANCH_CREATED_EFFECT,
      kind: "branch_created" as const,
      target: { kind: "workspace" } satisfies TargetRef,
      operation: { kind: "create" } satisfies OperationHint,
      constraints: { branchName: "feature/x", baseRef: "main" },
      affordance: REPO_BRANCH_CREATED_AFFORDANCE_ENTRY,
      branchName: "feature/x" as string | undefined,
      commitSha: undefined as string | undefined,
    },
    {
      effect: REPO_COMMIT_LANDED_EFFECT,
      kind: "commit_landed" as const,
      target: { kind: "workspace" } satisfies TargetRef,
      operation: { kind: "update" } satisfies OperationHint,
      constraints: { commitMessage: "fix: bug" },
      affordance: REPO_COMMIT_LANDED_AFFORDANCE_ENTRY,
      branchName: undefined,
      commitSha: "abc1234567890abcdef1234567890abcdef12345" as string | undefined,
    },
    {
      effect: REPO_MERGE_COMPLETED_EFFECT,
      kind: "merge_completed" as const,
      target: { kind: "workspace" } satisfies TargetRef,
      operation: { kind: "update" } satisfies OperationHint,
      constraints: { sourceBranch: "feature/x", targetBranch: "main" },
      affordance: REPO_MERGE_COMPLETED_AFFORDANCE_ENTRY,
      branchName: undefined,
      commitSha: "abcdef1234567890abcdef1234567890abcdef12" as string | undefined,
    },
    {
      effect: REPO_DIFF_OBSERVED_EFFECT,
      kind: "diff_observed" as const,
      // Phase 4 affordance permits both `workspace` and `unspecified`
      // for diff_observed; the parametrised row uses `unspecified` to
      // exercise the wider target shape (regression guard for the
      // matchesRepoDiffObservedTarget branch).
      target: { kind: "unspecified" } satisfies TargetRef,
      operation: { kind: "observe" } satisfies OperationHint,
      constraints: {},
      affordance: REPO_DIFF_OBSERVED_AFFORDANCE_ENTRY,
      branchName: undefined,
      commitSha: undefined,
    },
  ])(
    "routes $effect through the kernel when policy + runtime succeed",
    async ({ effect, kind, target, operation, constraints, affordance, branchName, commitSha }) => {
      // Reverse-test guard: this assertion FAILS before Phase 7 lands.
      expect(defaultCutoverPolicy.isEligible(effect)).toBe(true);

      const fixtureAffordances = createAffordanceRegistry([affordance]);

      const repoOpId = `repo_op_${kind}_42`;
      const expectedDelta: ExpectedDelta = {
        repo: { added: [repoOpId] },
      };
      const monitoredRuntime = {
        run: vi.fn(async () =>
          attestationWithRepo({ satisfied: true, repoOperationId: repoOpId, kind, branchName, commitSha }),
        ),
      };

      const result = await runTurnDecision({
        prompt: "repo operation turn",
        cfg: cfg(),
        classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
        intentContractorAdapterRegistry: {
          "intent-mock": intentAdapter(repoIntent(target, operation, constraints)),
        },
        affordanceRegistry: fixtureAffordances,
        monitoredRuntime,
        expectedDeltaResolver: () => expectedDelta,
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

      expect(result.derivedCommitment).toBeDefined();
      expect(result.derivedCommitment?.effect).toBe(effect);
    },
  );

  it("falls back to legacy on commitmentSatisfied=false (repo effect, runtime rejects)", async () => {
    const fixtureAffordances = createAffordanceRegistry([
      REPO_BRANCH_CREATED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = {
      run: vi.fn(async () =>
        attestationWithRepo({
          satisfied: false,
          repoOperationId: "repo_op_branch_x",
          kind: "branch_created",
          branchName: "feature/x",
        }),
      ),
    };

    const result = await runTurnDecision({
      prompt: "repo operation turn (rejected)",
      cfg: cfg(),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(
          repoIntent({ kind: "workspace" }, { kind: "create" }, {
            branchName: "feature/x",
            baseRef: "main",
          }),
        ),
      },
      affordanceRegistry: fixtureAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => ({ repo: { added: ["repo_op_branch_x"] } }),
    });

    expect(result.cutoverGate.kind).toBe("gate_in_fail");
    expect(result.kernelFallback).toBe(true);
    expect(result.fallbackReason).toBe("commitment_unsatisfied");
    expect(result.derivedCommitment).toBeUndefined();
  });

  it("keeps non-cutover repo effects (e.g. ad-hoc `repo_operation.completed`) legacy-bit-identical (regression guard)", () => {
    // `repo_operation.completed` is the cutover-4 placeholder family-effect
    // id (not in CUTOVER_2 by default — only the four enumerated `repo.*`
    // ids are admitted). Phase 7 must NOT widen the policy to admit
    // arbitrary effects under the repo family — only the four explicit ids.
    expect(defaultCutoverPolicy.isEligible(REPO_NOT_IN_FAMILY)).toBe(false);
  });

  it("preserves cutover-2 + cutover-3 entries (regression guard for additive extension)", () => {
    // Cutover-2 chat effects + cutover-3 artifact effects MUST stay
    // eligible after Phase 7 widens the allow-list. Anti-checklist
    // §5.1.5 forbids dropping any cutover-2 / cutover-3 entry when
    // extending the list.
    expect(defaultCutoverPolicy.isEligible("answer.delivered" as EffectId)).toBe(true);
    expect(defaultCutoverPolicy.isEligible("clarification_requested" as EffectId)).toBe(true);
    expect(defaultCutoverPolicy.isEligible("external_effect.performed" as EffectId)).toBe(true);
    expect(defaultCutoverPolicy.isEligible("persistent_session.created" as EffectId)).toBe(true);
    expect(defaultCutoverPolicy.isEligible("pdf.created" as EffectId)).toBe(true);
    expect(defaultCutoverPolicy.isEligible("docx.created" as EffectId)).toBe(true);
    expect(defaultCutoverPolicy.isEligible("code_patch.applied" as EffectId)).toBe(true);
    expect(defaultCutoverPolicy.isEligible("image.created" as EffectId)).toBe(true);
  });

  it("emits gate_out (cutover_disabled) when cutover flag is off — bit-identical legacy fallback", async () => {
    const fixtureAffordances = createAffordanceRegistry([
      REPO_DIFF_OBSERVED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = {
      run: vi.fn(async () =>
        attestationWithRepo({
          satisfied: true,
          repoOperationId: "repo_op_diff_y",
          kind: "diff_observed",
        }),
      ),
    };

    const result = await runTurnDecision({
      prompt: "repo operation turn (cutover off)",
      cfg: cfg({ cutoverEnabled: false }),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(
          repoIntent({ kind: "unspecified" }, { kind: "observe" }),
        ),
      },
      affordanceRegistry: fixtureAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => ({ repo: { added: ["repo_op_diff_y"] } }),
    });

    expect(result.cutoverGate).toEqual({ kind: "gate_out", reason: "cutover_disabled" });
    expect(result.kernelFallback).toBe(true);
    expect(result.fallbackReason).toBe("cutover_disabled");
    expect(monitoredRuntime.run).not.toHaveBeenCalled();
    // Legacy bit-identity is asserted through the cutover gate trace +
    // `kernelFallback=true` + the runtime never being invoked. The
    // production decision wraps the legacy taskContract verbatim (not
    // ref-equal because `runTurnDecision` may decorate the planner
    // input with a `cutoverGate` trace marker; cutover-3 Phase 7's
    // analogue test makes the same coverage choice).
    expect(result.derivedCommitment).toBeUndefined();
  });
});
