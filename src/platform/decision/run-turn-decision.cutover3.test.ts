import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  ARTIFACT_EFFECT_FAMILY,
  CODE_PATCH_APPLIED_AFFORDANCE_ENTRY,
  CODE_PATCH_APPLIED_EFFECT,
  DOCX_CREATED_AFFORDANCE_ENTRY,
  DOCX_CREATED_EFFECT,
  IMAGE_CREATED_AFFORDANCE_ENTRY,
  IMAGE_CREATED_EFFECT,
  PDF_CREATED_AFFORDANCE_ENTRY,
  PDF_CREATED_EFFECT,
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
 * Cutover-3 Phase 7 routing flip contract.
 *
 * Asserts that the four artifact effects (`pdf.created`, `docx.created`,
 * `code_patch.applied`, `image.created`) flip to kernel-derived
 * `productionDecision` when the cutover-policy allow-list is extended
 * (Phase 7) and runtime attests `commitmentSatisfied=true`. Mirrors
 * `run-turn-decision.cutover2.test.ts` (Wave B chat effects) shape with
 * one parametrised it.each row per artifact effect.
 *
 * The shadow-builder rejects the artifact family with
 * `multiple_candidates` when more than one affordance matches the
 * (target, op) pair (e.g. PDF + DOCX + image all match
 * `target.kind=artifact` + `op.kind=create`). To exercise the
 * cutover-policy flip in isolation, each parametrised row uses a
 * fixture single-affordance registry — same shape as cutover-2's
 * out-of-pool regression test (`run-turn-decision.cutover2.test.ts:217`).
 *
 * Out of scope (separate test files / phases):
 *  - Per-effect runtime adapter wiring → Phase 5 (`artifact-runtime-adapter.test.ts`).
 *  - Img2img precondition binding → Phase 6 (`artifact-runtime-adapter-img2img.test.ts`).
 *  - Runner-side `setAmbientArtifactTurn` plumbing → Phase 8 (deferred per slice spec).
 */

const ARTIFACT_NOT_IN_FAMILY: EffectId = "artifact.created" as EffectId; // not in CUTOVER_2

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

function artifactIntent(target: TargetRef, operation: OperationHint): SemanticIntent {
  return {
    desiredEffectFamily: ARTIFACT_EFFECT_FAMILY,
    target,
    operation,
    constraints: {},
    uncertainty: [],
    confidence: 0.9,
  };
}

function attestationWithArtifact(params: {
  satisfied: boolean;
  artifactId: string;
  kind: "pdf" | "docx" | "code_patch" | "image";
}): RuntimeAttestation {
  // Synthetic state-after carries the matching artifact record so the
  // runtime adapter (Phase 5) shape is replayed without invoking it. This
  // test asserts the cutover-policy flip + decision routing only; the
  // actual write side is exercised in artifact-runtime-adapter.test.ts.
  const stateAfter: WorldStateSnapshot = params.satisfied
    ? {
        artifacts: {
          records: [
            {
              artifactId: params.artifactId,
              kind: params.kind,
              path: `tmp/${params.artifactId}`,
              mimeType: "application/octet-stream",
              producedAt: "2026-05-06T12:00:00.000Z" as ISO8601,
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
      : { satisfied: false, missing: ["artifact_record_missing"] },
  };
}

function traceGate(result: Awaited<ReturnType<typeof runTurnDecision>>): CutoverGateTrace | undefined {
  return (
    result.productionDecision.plannerInput.decisionTrace as
      | { readonly cutoverGate?: CutoverGateTrace }
      | undefined
  )?.cutoverGate;
}

describe("runTurnDecision cutover-3 (Phase 7 — artifact effect routing flip)", () => {
  it.each([
    {
      effect: PDF_CREATED_EFFECT,
      kind: "pdf" as const,
      target: { kind: "artifact" } satisfies TargetRef,
      operation: { kind: "create" } satisfies OperationHint,
      affordance: PDF_CREATED_AFFORDANCE_ENTRY,
    },
    {
      effect: DOCX_CREATED_EFFECT,
      kind: "docx" as const,
      target: { kind: "artifact" } satisfies TargetRef,
      operation: { kind: "create" } satisfies OperationHint,
      affordance: DOCX_CREATED_AFFORDANCE_ENTRY,
    },
    {
      effect: CODE_PATCH_APPLIED_EFFECT,
      kind: "code_patch" as const,
      target: { kind: "workspace" } satisfies TargetRef,
      operation: { kind: "update" } satisfies OperationHint,
      affordance: CODE_PATCH_APPLIED_AFFORDANCE_ENTRY,
    },
    {
      effect: IMAGE_CREATED_EFFECT,
      kind: "image" as const,
      target: { kind: "artifact" } satisfies TargetRef,
      operation: { kind: "create" } satisfies OperationHint,
      affordance: IMAGE_CREATED_AFFORDANCE_ENTRY,
    },
  ])(
    "routes $effect through the kernel when policy + runtime succeed",
    async ({ effect, kind, target, operation, affordance }) => {
      // Reverse-test guard: this assertion FAILS before Phase 7 lands.
      expect(defaultCutoverPolicy.isEligible(effect)).toBe(true);

      const fixtureAffordances = createAffordanceRegistry([affordance]);

      const artifactId = `art_${kind}_42`;
      const expectedDelta: ExpectedDelta = {
        artifacts: { added: [artifactId] },
      };
      const monitoredRuntime = {
        run: vi.fn(async () =>
          attestationWithArtifact({ satisfied: true, artifactId, kind }),
        ),
      };

      const result = await runTurnDecision({
        prompt: "artifact authoring turn",
        cfg: cfg(),
        classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
        intentContractorAdapterRegistry: {
          "intent-mock": intentAdapter(artifactIntent(target, operation)),
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

  it("falls back to legacy on commitmentSatisfied=false (artifact effect, runtime rejects)", async () => {
    const fixtureAffordances = createAffordanceRegistry([
      PDF_CREATED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = {
      run: vi.fn(async () =>
        attestationWithArtifact({ satisfied: false, artifactId: "art_pdf_x", kind: "pdf" }),
      ),
    };

    const result = await runTurnDecision({
      prompt: "artifact authoring turn (rejected)",
      cfg: cfg(),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(
          artifactIntent({ kind: "artifact" }, { kind: "create" }),
        ),
      },
      affordanceRegistry: fixtureAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => ({ artifacts: { added: ["art_pdf_x"] } }),
    });

    expect(result.cutoverGate.kind).toBe("gate_in_fail");
    expect(result.kernelFallback).toBe(true);
    expect(result.fallbackReason).toBe("commitment_unsatisfied");
    expect(result.derivedCommitment).toBeUndefined();
  });

  it("keeps non-cutover artifact effects (e.g. ad-hoc `artifact.created`) legacy-bit-identical (regression guard)", () => {
    // `artifact.created` is the cutover-2 fixture-only effect (not in
    // CUTOVER_2 by default). Phase 7 must NOT widen the policy to admit
    // arbitrary effects under the artifact family — only the four
    // explicit ids.
    expect(defaultCutoverPolicy.isEligible(ARTIFACT_NOT_IN_FAMILY)).toBe(false);
  });

  it("preserves cutover-2 entries (regression guard for additive extension)", () => {
    // Cutover-2 chat effects MUST stay eligible after Phase 7 widens the
    // allow-list. Anti-checklist §5.1.5 forbids dropping any cutover-2
    // entry when extending the list.
    expect(defaultCutoverPolicy.isEligible("answer.delivered" as EffectId)).toBe(true);
    expect(defaultCutoverPolicy.isEligible("clarification_requested" as EffectId)).toBe(true);
    expect(defaultCutoverPolicy.isEligible("external_effect.performed" as EffectId)).toBe(true);
    expect(defaultCutoverPolicy.isEligible("persistent_session.created" as EffectId)).toBe(true);
  });

  it("emits gate_out (cutover_disabled) when cutover flag is off — bit-identical legacy fallback", async () => {
    const fixtureAffordances = createAffordanceRegistry([
      PDF_CREATED_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = {
      run: vi.fn(async () =>
        attestationWithArtifact({ satisfied: true, artifactId: "art_pdf_y", kind: "pdf" }),
      ),
    };

    const result = await runTurnDecision({
      prompt: "artifact authoring turn (cutover off)",
      cfg: cfg({ cutoverEnabled: false }),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(
          artifactIntent({ kind: "artifact" }, { kind: "create" }),
        ),
      },
      affordanceRegistry: fixtureAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => ({ artifacts: { added: ["art_pdf_y"] } }),
    });

    expect(result.cutoverGate).toEqual({ kind: "gate_out", reason: "cutover_disabled" });
    expect(result.kernelFallback).toBe(true);
    expect(result.fallbackReason).toBe("cutover_disabled");
    expect(monitoredRuntime.run).not.toHaveBeenCalled();
  });
});
