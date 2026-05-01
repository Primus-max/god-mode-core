import { describe, expect, it } from "vitest";
import {
  computeQualificationConfidence,
  inferQualificationAmbiguityReasons,
  resolveLowConfidenceStrategy,
} from "./qualification-confidence.js";

describe("qualification confidence", () => {
  it("stays high for clear document-render requests", () => {
    const ambiguityReasons = inferQualificationAmbiguityReasons({
      outcomeContract: "structured_artifact",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: true,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: true,
      },
      candidateFamilies: ["document_render", "analysis_transform"],
      intent: "document",
      artifactKinds: ["document", "report"],
      requestedTools: ["pdf"],
      publishTargets: [],
    });
    const confidence = computeQualificationConfidence({
      outcomeContract: "structured_artifact",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: true,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: true,
      },
      candidateFamilies: ["document_render", "analysis_transform"],
      ambiguityReasons,
      intent: "document",
      artifactKinds: ["document", "report"],
      requestedTools: ["pdf"],
      publishTargets: [],
    });

    expect(ambiguityReasons).toEqual([]);
    expect(confidence).toBe("high");
    expect(
      resolveLowConfidenceStrategy({
        outcomeContract: "structured_artifact",
        executionContract: {
          requiresTools: true,
          requiresWorkspaceMutation: false,
          requiresLocalProcess: false,
          requiresArtifactEvidence: true,
          requiresDeliveryEvidence: false,
          mayNeedBootstrap: true,
        },
        candidateFamilies: ["document_render", "analysis_transform"],
        ambiguityReasons,
        confidence,
        intent: "document",
        artifactKinds: ["document", "report"],
        requestedTools: ["pdf"],
        publishTargets: [],
      }),
    ).toBeUndefined();
  });

  it("records mixed-surface ambiguity and keeps the fallback bounded", () => {
    const ambiguityReasons = inferQualificationAmbiguityReasons({
      outcomeContract: "structured_artifact",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: true,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: true,
      },
      candidateFamilies: ["media_generation", "document_render"],
      artifactKinds: ["image", "document"],
      requestedTools: ["image_generate", "pdf"],
      publishTargets: [],
    });
    const confidence = computeQualificationConfidence({
      outcomeContract: "structured_artifact",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: true,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: true,
      },
      candidateFamilies: ["media_generation", "document_render"],
      ambiguityReasons,
      artifactKinds: ["image", "document"],
      requestedTools: ["image_generate", "pdf"],
      publishTargets: [],
    });

    expect(ambiguityReasons).toEqual(
      expect.arrayContaining([
        "multiple candidate families remain without an explicit intent anchor (media_generation, document_render)",
      ]),
    );
    expect(confidence).toBe("medium");
    expect(
      resolveLowConfidenceStrategy({
        outcomeContract: "structured_artifact",
        executionContract: {
          requiresTools: true,
          requiresWorkspaceMutation: false,
          requiresLocalProcess: false,
          requiresArtifactEvidence: true,
          requiresDeliveryEvidence: false,
          mayNeedBootstrap: true,
        },
        candidateFamilies: ["media_generation", "document_render"],
        ambiguityReasons,
        confidence,
        artifactKinds: ["image", "document"],
        requestedTools: ["image_generate", "pdf"],
        publishTargets: [],
      }),
    ).toBe("bounded_attempt_with_strict_verification");
  });

  it("does not treat pdf authoring with supporting images as mixed-surface ambiguity", () => {
    const ambiguityReasons = inferQualificationAmbiguityReasons({
      outcomeContract: "structured_artifact",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: true,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: true,
      },
      candidateFamilies: ["document_render", "media_generation"],
      intent: "document",
      artifactKinds: ["document", "image"],
      requestedTools: ["pdf", "image_generate"],
      publishTargets: [],
    });
    const confidence = computeQualificationConfidence({
      outcomeContract: "structured_artifact",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: true,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: true,
      },
      candidateFamilies: ["document_render", "media_generation"],
      ambiguityReasons,
      intent: "document",
      artifactKinds: ["document", "image"],
      requestedTools: ["pdf", "image_generate"],
      publishTargets: [],
    });

    expect(ambiguityReasons).toEqual([]);
    expect(confidence).toBe("high");
    expect(
      resolveLowConfidenceStrategy({
        outcomeContract: "structured_artifact",
        executionContract: {
          requiresTools: true,
          requiresWorkspaceMutation: false,
          requiresLocalProcess: false,
          requiresArtifactEvidence: true,
          requiresDeliveryEvidence: false,
          mayNeedBootstrap: true,
        },
        candidateFamilies: ["document_render", "media_generation"],
        ambiguityReasons,
        confidence,
        intent: "document",
        artifactKinds: ["document", "image"],
        requestedTools: ["pdf", "image_generate"],
        publishTargets: [],
      }),
    ).toBeUndefined();
  });

  it("uses clarify for underspecified external operations", () => {
    const ambiguityReasons = inferQualificationAmbiguityReasons({
      outcomeContract: "external_operation",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: true,
        requiresArtifactEvidence: false,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: true,
      },
      candidateFamilies: ["ops_execution"],
      intent: "publish",
      requestedTools: ["exec", "apply_patch", "process"],
      publishTargets: [],
    });
    const confidence = computeQualificationConfidence({
      outcomeContract: "external_operation",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: true,
        requiresArtifactEvidence: false,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: true,
      },
      candidateFamilies: ["ops_execution"],
      ambiguityReasons,
      intent: "publish",
      requestedTools: ["exec", "apply_patch", "process"],
      publishTargets: [],
    });

    expect(ambiguityReasons).toEqual(["external operation is inferred without an explicit publish target"]);
    expect(confidence).toBe("medium");
    expect(
      resolveLowConfidenceStrategy({
        outcomeContract: "external_operation",
        executionContract: {
          requiresTools: true,
          requiresWorkspaceMutation: false,
          requiresLocalProcess: true,
          requiresArtifactEvidence: false,
          requiresDeliveryEvidence: false,
          mayNeedBootstrap: true,
        },
        candidateFamilies: ["ops_execution"],
        ambiguityReasons,
        confidence,
        intent: "publish",
        requestedTools: ["exec", "apply_patch", "process"],
        publishTargets: [],
      }),
    ).toBe("clarify");
  });

  it("does not clarify on low confidence when no blocking ambiguity exists", () => {
    expect(
      resolveLowConfidenceStrategy({
        outcomeContract: "text_response",
        executionContract: {
          requiresTools: false,
          requiresWorkspaceMutation: false,
          requiresLocalProcess: false,
          requiresArtifactEvidence: false,
          requiresDeliveryEvidence: false,
          mayNeedBootstrap: false,
        },
        candidateFamilies: ["general_assistant"],
        ambiguityReasons: [],
        confidence: "low",
      }),
    ).toBeUndefined();
  });

  it("uses safe broad execution for preference ambiguities instead of clarify", () => {
    expect(
      resolveLowConfidenceStrategy({
        outcomeContract: "structured_artifact",
        executionContract: {
          requiresTools: false,
          requiresWorkspaceMutation: false,
          requiresLocalProcess: false,
          requiresArtifactEvidence: false,
          requiresDeliveryEvidence: false,
          mayNeedBootstrap: false,
        },
        candidateFamilies: ["document_render", "analysis_transform"],
        ambiguityReasons: ["preference: exact report style not specified"],
        confidence: "medium",
      }),
    ).toBe("safe_broad_family_execution");
  });
});
