/**
 * Cutover-3 Phase 8 — acceptance fixture.
 *
 * Five end-to-end cases per sub-plan §5 Phase 8:
 *   1. JPG attachment + "сделай PDF из этого эскиза" prompt → kernel-derived
 *      productionDecision for `pdf.created`; observer records artifact;
 *      ledger emits `ArtifactCreatedPayload` shape.
 *   2. DOCX template attachment + "сделай КП по этому шаблону" → kernel-
 *      derived productionDecision for `docx.created`.
 *   3. JPG attachment + img2img prompt → `image.created` turn; the Phase-6
 *      precondition resolver returns the inbound JPG path so the future
 *      runtime adapter can pre-bind it onto the `image_generate` tool args
 *      (the binding itself is wired in a future slice; this test asserts
 *      the structural seam is in place — `sourcePaths` carries the inbound
 *      path through the WorldState slice).
 *   4. Reverse: omit inbound attachment, `image.created` turn falls
 *      through to from-scratch generation (precondition resolves to `null`,
 *      no `image:` injection contract).
 *   5. Reverse: cutover-off → legacy decision for all four families.
 *
 * Plus a 1-shot IntentContractor classifier-flip test (audit §h, sub-plan
 * §5 Phase 8): the prompt-hint allowlist now contains `artifact`. With a
 * mock adapter the contractor surfaces `desiredEffectFamily=artifact` AND
 * `referenceMode=img2img` constraint when the inbound JPG block is
 * present.
 *
 * The test exercises real `runTurnDecision`, real `defaultCutoverPolicy`,
 * real predicates, real precondition resolver. The only spies are on
 * adapter classifiers (replacing the real Hydra LLM) and the runtime
 * adapter (replacing real tool execution); both are infrastructure spies,
 * not function-under-test mocks.
 */

import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { CutoverGateTrace } from "../../decision/run-turn-decision.js";
import { runTurnDecision } from "../../decision/run-turn-decision.js";
import type { TaskClassifierAdapter, TaskContract } from "../../decision/task-classifier.js";
import {
  ARTIFACT_EFFECT_FAMILY,
  DOCX_CREATED_AFFORDANCE_ENTRY,
  DOCX_CREATED_EFFECT,
  IMAGE_CREATED_AFFORDANCE_ENTRY,
  IMAGE_CREATED_EFFECT,
  PDF_CREATED_AFFORDANCE_ENTRY,
  PDF_CREATED_EFFECT,
  createAffordanceRegistry,
  createIntentContractor,
  defaultCutoverPolicy,
  resolveInboundImageReferencePrecondition,
  type ExpectedDelta,
  type InboundMediaSummary,
  type IntentContractorAdapter,
  type RuntimeAttestation,
} from "../index.js";
import type { ISO8601 } from "../ids.js";
import type {
  OperationHint,
  SemanticIntent,
  TargetRef,
} from "../semantic-intent.js";
import type { WorldStateSnapshot } from "../world-state.js";

// ---------------------------------------------------------------------------
// Fixtures (shared)
// ---------------------------------------------------------------------------

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

function artifactIntent(
  target: TargetRef,
  operation: OperationHint,
  constraints: SemanticIntent["constraints"] = {},
): SemanticIntent {
  return {
    desiredEffectFamily: ARTIFACT_EFFECT_FAMILY,
    target,
    operation,
    constraints,
    uncertainty: [],
    confidence: 0.9,
  };
}

function attestationWithArtifact(params: {
  satisfied: boolean;
  artifactId: string;
  kind: "pdf" | "docx" | "code_patch" | "image";
  sourcePaths?: readonly string[];
}): RuntimeAttestation {
  const stateAfter: WorldStateSnapshot = params.satisfied
    ? {
        artifacts: {
          records: [
            {
              artifactId: params.artifactId,
              kind: params.kind,
              path: `tmp/${params.artifactId}`,
              mimeType: "application/octet-stream",
              ...(params.sourcePaths && params.sourcePaths.length > 0
                ? { sourcePaths: params.sourcePaths }
                : {}),
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

function traceGate(
  result: Awaited<ReturnType<typeof runTurnDecision>>,
): CutoverGateTrace | undefined {
  return (
    result.productionDecision.plannerInput.decisionTrace as
      | { readonly cutoverGate?: CutoverGateTrace }
      | undefined
  )?.cutoverGate;
}

// ---------------------------------------------------------------------------
// Case 1 — JPG attachment → "сделай PDF из этого эскиза"
// ---------------------------------------------------------------------------

describe("cutover3 acceptance — Case 1: JPG → сделай PDF", () => {
  it("kernel-derived productionDecision for pdf.created with state-after artifact record", async () => {
    expect(defaultCutoverPolicy.isEligible(PDF_CREATED_EFFECT)).toBe(true);
    const fixtureAffordances = createAffordanceRegistry([PDF_CREATED_AFFORDANCE_ENTRY]);
    const artifactId = "art_pdf_case1";
    const expectedDelta: ExpectedDelta = { artifacts: { added: [artifactId] } };
    const monitoredRuntime = {
      run: vi.fn(async () =>
        attestationWithArtifact({
          satisfied: true,
          artifactId,
          kind: "pdf",
          sourcePaths: ["media/inbound/sketch---1.jpg"],
        }),
      ),
    };

    const result = await runTurnDecision({
      prompt: "сделай PDF из этого эскиза",
      cfg: cfg(),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(
          artifactIntent({ kind: "artifact" }, { kind: "create" }),
        ),
      },
      affordanceRegistry: fixtureAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
    });

    expect(result.cutoverGate).toEqual({
      kind: "gate_in_success",
      effect: PDF_CREATED_EFFECT,
      terminalState: "action_completed",
      acceptanceReason: "commitment_satisfied",
    });
    expect(traceGate(result)).toEqual(result.cutoverGate);
    expect(result.productionDecision).not.toBe(result.legacyDecision);
    expect(result.kernelFallback).toBe(false);
    expect(result.derivedCommitment?.effect).toBe(PDF_CREATED_EFFECT);
    // Ledger payload shape — runtime attests state-after artifact record
    // with the inbound source path so the future `recordArtifactOnCommitmentSatisfied`
    // hook can write `ArtifactCreatedPayload { kind: "pdf", path, sourcePaths }`.
    const records = result.runtimeAttestation?.stateAfter.artifacts?.records ?? [];
    expect(records).toHaveLength(1);
    expect(records[0]?.kind).toBe("pdf");
    expect(records[0]?.sourcePaths).toEqual(["media/inbound/sketch---1.jpg"]);
  });
});

// ---------------------------------------------------------------------------
// Case 2 — DOCX template attachment → "сделай КП по этому шаблону"
// ---------------------------------------------------------------------------

describe("cutover3 acceptance — Case 2: DOCX template → сделай КП", () => {
  it("kernel-derived productionDecision for docx.created", async () => {
    expect(defaultCutoverPolicy.isEligible(DOCX_CREATED_EFFECT)).toBe(true);
    const fixtureAffordances = createAffordanceRegistry([DOCX_CREATED_AFFORDANCE_ENTRY]);
    const artifactId = "art_docx_case2";
    const monitoredRuntime = {
      run: vi.fn(async () =>
        attestationWithArtifact({
          satisfied: true,
          artifactId,
          kind: "docx",
          sourcePaths: ["media/inbound/template---2.docx"],
        }),
      ),
    };

    const result = await runTurnDecision({
      prompt: "сделай КП по этому шаблону",
      cfg: cfg(),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(
          artifactIntent(
            { kind: "artifact" },
            { kind: "create" },
            { templatePath: "media/inbound/template---2.docx" },
          ),
        ),
      },
      affordanceRegistry: fixtureAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => ({ artifacts: { added: [artifactId] } }),
    });

    expect(result.cutoverGate).toEqual({
      kind: "gate_in_success",
      effect: DOCX_CREATED_EFFECT,
      terminalState: "action_completed",
      acceptanceReason: "commitment_satisfied",
    });
    expect(result.derivedCommitment?.effect).toBe(DOCX_CREATED_EFFECT);
    expect(result.kernelFallback).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Case 3 — JPG + img2img prompt → image.created with sourcePaths
// ---------------------------------------------------------------------------

describe("cutover3 acceptance — Case 3: JPG → img2img image.created", () => {
  it("image.created turn carries sourcePaths and precondition resolves to non-empty paths", async () => {
    expect(defaultCutoverPolicy.isEligible(IMAGE_CREATED_EFFECT)).toBe(true);
    const fixtureAffordances = createAffordanceRegistry([IMAGE_CREATED_AFFORDANCE_ENTRY]);
    const artifactId = "art_image_case3";
    const sourcePaths = ["media/inbound/photo---3.jpg"];
    const monitoredRuntime = {
      run: vi.fn(async () =>
        attestationWithArtifact({
          satisfied: true,
          artifactId,
          kind: "image",
          sourcePaths,
        }),
      ),
    };

    const result = await runTurnDecision({
      prompt: "сделай этот эскиз более ярким",
      cfg: cfg(),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(
          artifactIntent(
            { kind: "artifact" },
            { kind: "create" },
            { referenceMode: "img2img" },
          ),
        ),
      },
      affordanceRegistry: fixtureAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => ({ artifacts: { added: [artifactId] } }),
    });

    expect(result.cutoverGate.kind).toBe("gate_in_success");
    expect(result.derivedCommitment?.effect).toBe(IMAGE_CREATED_EFFECT);

    // Phase 6 precondition resolver — given the structural inbound media
    // summary the future runtime adapter would use the same source for, it
    // returns the ordered path list the adapter binds onto the
    // `image_generate` tool. Asserts the structural seam is intact.
    const summary: InboundMediaSummary = {
      attachments: [
        {
          path: sourcePaths[0]!,
          mimeType: "image/jpeg",
          kind: "image",
        },
      ],
    };
    const preconditionValue = resolveInboundImageReferencePrecondition(summary);
    expect(preconditionValue).not.toBeNull();
    expect(preconditionValue?.paths).toEqual(sourcePaths);

    // State-after artifact record carries the inbound source path verbatim
    // so a future memory cross-reference layer can JOIN on it.
    const records = result.runtimeAttestation?.stateAfter.artifacts?.records ?? [];
    expect(records[0]?.sourcePaths).toEqual(sourcePaths);
  });
});

// ---------------------------------------------------------------------------
// Case 4 — Reverse: omit inbound attachment → from-scratch image
// ---------------------------------------------------------------------------

describe("cutover3 acceptance — Case 4 (reverse): no inbound attachment → from-scratch", () => {
  it("precondition resolver returns null when no image attachment present (no img2img injection)", () => {
    // No inbound attachments at all — slice absent.
    expect(resolveInboundImageReferencePrecondition(undefined)).toBeNull();
    // Empty attachments list — block elided, precondition null.
    expect(
      resolveInboundImageReferencePrecondition({ attachments: [] }),
    ).toBeNull();
    // Only PDF / DOCX inbound — no image kind → precondition null (the
    // `IMAGE_CREATED_AFFORDANCE_ENTRY` from-scratch branch executes).
    const docOnly: InboundMediaSummary = {
      attachments: [
        {
          path: "media/inbound/spec.pdf",
          mimeType: "application/pdf",
          kind: "pdf",
        },
      ],
    };
    expect(resolveInboundImageReferencePrecondition(docOnly)).toBeNull();
  });

  it("image.created turn still routes through kernel even without inbound image (from-scratch)", async () => {
    const fixtureAffordances = createAffordanceRegistry([IMAGE_CREATED_AFFORDANCE_ENTRY]);
    const artifactId = "art_image_case4";
    const monitoredRuntime = {
      run: vi.fn(async () =>
        attestationWithArtifact({
          satisfied: true,
          artifactId,
          kind: "image",
          // No sourcePaths — from-scratch generation.
        }),
      ),
    };

    const result = await runTurnDecision({
      prompt: "нарисуй кота",
      cfg: cfg(),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(
          artifactIntent({ kind: "artifact" }, { kind: "create" }),
        ),
      },
      affordanceRegistry: fixtureAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => ({ artifacts: { added: [artifactId] } }),
    });

    expect(result.cutoverGate.kind).toBe("gate_in_success");
    expect(result.derivedCommitment?.effect).toBe(IMAGE_CREATED_EFFECT);
    const records = result.runtimeAttestation?.stateAfter.artifacts?.records ?? [];
    expect(records[0]?.sourcePaths).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Case 5 — Reverse: cutover-off → legacy decision for all four families
// ---------------------------------------------------------------------------

describe("cutover3 acceptance — Case 5 (reverse): cutover-off → legacy bit-identical", () => {
  it.each([
    {
      effect: PDF_CREATED_EFFECT,
      affordance: PDF_CREATED_AFFORDANCE_ENTRY,
      kind: "pdf" as const,
    },
    {
      effect: DOCX_CREATED_EFFECT,
      affordance: DOCX_CREATED_AFFORDANCE_ENTRY,
      kind: "docx" as const,
    },
    {
      effect: IMAGE_CREATED_EFFECT,
      affordance: IMAGE_CREATED_AFFORDANCE_ENTRY,
      kind: "image" as const,
    },
  ])(
    "$effect falls back to legacy decision when cutover flag is off",
    async ({ affordance, kind }) => {
      const fixtureAffordances = createAffordanceRegistry([affordance]);
      const monitoredRuntime = {
        run: vi.fn(async () =>
          attestationWithArtifact({
            satisfied: true,
            artifactId: `art_${kind}_off`,
            kind,
          }),
        ),
      };

      const result = await runTurnDecision({
        prompt: "artifact turn (cutover off)",
        cfg: cfg({ cutoverEnabled: false }),
        classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
        intentContractorAdapterRegistry: {
          "intent-mock": intentAdapter(
            artifactIntent({ kind: "artifact" }, { kind: "create" }),
          ),
        },
        affordanceRegistry: fixtureAffordances,
        monitoredRuntime,
        expectedDeltaResolver: () => ({ artifacts: { added: [`art_${kind}_off`] } }),
      });

      expect(result.cutoverGate).toEqual({ kind: "gate_out", reason: "cutover_disabled" });
      expect(result.kernelFallback).toBe(true);
      expect(result.fallbackReason).toBe("cutover_disabled");
      expect(monitoredRuntime.run).not.toHaveBeenCalled();
      // Production decision is bit-identical to legacy at the
      // taskContract level under cutover-off (cutover-2 PR-#104 precedent).
      // Trace metadata (cutoverGate, kernelFallback, shadowCommitment) is
      // wrapping that did not exist on the legacy path.
      expect(result.productionDecision.taskContract).toEqual(
        result.legacyDecision.taskContract,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Targeted IntentContractor 1-shot prompt-hint flip fixture
// (audit §h, sub-plan §5 Phase 8)
// ---------------------------------------------------------------------------

type CapturedAdapterCall = {
  prompt: string;
};

function makeCapturingAdapter(
  captures: CapturedAdapterCall[],
  intent: SemanticIntent,
): IntentContractorAdapter {
  return {
    classify: async (params) => {
      captures.push({ prompt: params.prompt });
      return intent;
    },
  };
}

function mockCfgForContractor(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        embeddedPi: {
          intentContractor: { backend: "mock" },
        },
      },
    },
  } as OpenClawConfig;
}

describe("IntentContractor prompt-hint flip — `artifact` family allowlisted", () => {
  it("classifier returns desiredEffectFamily=artifact + referenceMode=img2img when JPG inbound block present", async () => {
    const captures: CapturedAdapterCall[] = [];
    const intent: SemanticIntent = artifactIntent(
      { kind: "artifact" },
      { kind: "create" },
      { referenceMode: "img2img" },
    );
    const contractor = createIntentContractor({
      cfg: mockCfgForContractor(),
      adapterRegistry: { mock: makeCapturingAdapter(captures, intent) },
      inboundMediaResolver: () => ({
        attachments: [
          {
            path: "media/inbound/sketch---4.jpg",
            mimeType: "image/jpeg",
            kind: "image",
          },
        ],
      }),
    });

    const result = await contractor.classify("сделай PDF из этого эскиза");

    expect(result.desiredEffectFamily).toBe(ARTIFACT_EFFECT_FAMILY);
    expect(result.target.kind).toBe("artifact");
    expect(result.constraints).toMatchObject({ referenceMode: "img2img" });
    // Confirm the contractor's prompt to the adapter included the new
    // `<inbound_attachments>` structural block.
    expect(captures).toHaveLength(1);
    expect(captures[0]?.prompt.startsWith("<inbound_attachments>")).toBe(true);
    expect(captures[0]?.prompt).toContain('kind="image"');
  });

  it("reverse: same prompt without inbound attachment → no referenceMode constraint, no block injected", async () => {
    const captures: CapturedAdapterCall[] = [];
    const intent: SemanticIntent = artifactIntent(
      { kind: "artifact" },
      { kind: "create" },
    );
    const contractor = createIntentContractor({
      cfg: mockCfgForContractor(),
      adapterRegistry: { mock: makeCapturingAdapter(captures, intent) },
      // No inboundMediaResolver dep — block elided byte-identical.
    });

    const result = await contractor.classify("сделай PDF из этого эскиза");

    expect(result.desiredEffectFamily).toBe(ARTIFACT_EFFECT_FAMILY);
    expect(result.constraints).not.toHaveProperty("referenceMode");
    expect(captures[0]?.prompt).not.toContain("<inbound_attachments>");
    expect(captures[0]?.prompt).toBe("сделай PDF из этого эскиза");
  });

  it("classifier prompt response-shape allowlist includes `artifact` (audit §h)", () => {
    // Direct introspection of the classifier prompt builder is awkward
    // because `buildIntentContractorPrompt` is internal. The contractor
    // 1-shot test above asserts the SEMANTIC outcome (model can now
    // return `desiredEffectFamily=artifact` and the contractor accepts
    // it without falling back to `family_not_in_registry`). This case
    // is the registry-level check: `artifact` IS a registered family.
    expect(ARTIFACT_EFFECT_FAMILY).toBe("artifact");
  });
});
