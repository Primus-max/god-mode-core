import { describe, expect, it } from "vitest";
import type {
  PlatformRuntimeExecutionIntent,
  PlatformRuntimeExecutionReceipt,
  PlatformRuntimeRunOutcome,
} from "./contracts.js";
import { isCompletionEvidenceSufficient } from "./evidence-sufficiency.js";

function buildCompletedOutcome(runId: string): PlatformRuntimeRunOutcome {
  return {
    runId,
    status: "completed",
    checkpointIds: [],
    blockedCheckpointIds: [],
    completedCheckpointIds: [],
    deniedCheckpointIds: [],
    pendingApprovalIds: [],
    artifactIds: [],
    bootstrapRequestIds: [],
    actionIds: [],
    attemptedActionIds: [],
    confirmedActionIds: [],
    failedActionIds: [],
    boundaries: [],
  };
}

describe("runtime evidence sufficiency", () => {
  it("rejects write/exec as sufficient toolReceipt for document artifact kind (requires pdf tool)", () => {
    // Regression: write + verifiedExecution + hasOutput must NOT satisfy toolReceipt for document artifacts.
    // Previously the verifiedExecution shortcut fired here, allowing fake-success.
    const executionIntent: PlatformRuntimeExecutionIntent = {
      runId: "doc-via-write-only",
      intent: "document",
      artifactKinds: ["document"],
      expectations: {},
    };
    const receipts: PlatformRuntimeExecutionReceipt[] = [
      {
        kind: "tool",
        name: "write",
        status: "success",
        proof: "reported",
        summary: "wrote output.md",
      },
    ];

    const sufficiency = isCompletionEvidenceSufficient({
      executionIntent,
      receipts,
      evidence: {
        hasOutput: true,
        verifiedExecution: true,
        verifiedExecutionReceiptCount: 1,
      },
      outcome: buildCompletedOutcome("doc-via-write-only"),
    });

    expect(sufficiency.sufficient).toBe(false);
    expect(sufficiency.missingEvidence).toContain("tool_receipt");
    expect(sufficiency.missingEvidence).toContain("artifact_descriptor");
  });

  it("rejects exec as sufficient toolReceipt for image artifact kind (requires image_generate tool)", () => {
    const executionIntent: PlatformRuntimeExecutionIntent = {
      runId: "image-via-exec-only",
      intent: "general",
      artifactKinds: ["image"],
      expectations: {},
    };
    const receipts: PlatformRuntimeExecutionReceipt[] = [
      {
        kind: "tool",
        name: "exec",
        status: "success",
        proof: "reported",
        summary: "ran script.py",
      },
    ];

    const sufficiency = isCompletionEvidenceSufficient({
      executionIntent,
      receipts,
      evidence: {
        hasOutput: true,
        verifiedExecution: true,
        verifiedExecutionReceiptCount: 1,
      },
      outcome: buildCompletedOutcome("image-via-exec-only"),
    });

    expect(sufficiency.sufficient).toBe(false);
    expect(sufficiency.missingEvidence).toContain("tool_receipt");
  });

  it("accepts verifiedExecution shortcut for structured_artifact when no specific artifact kinds are set", () => {
    // When no artifact kind is declared, the system cannot require a specific tool.
    // The verifiedExecution shortcut is the only signal available and must still work.
    const executionIntent: PlatformRuntimeExecutionIntent = {
      runId: "generic-structured-artifact",
      outcomeContract: "structured_artifact",
      expectations: {},
    };

    const sufficiency = isCompletionEvidenceSufficient({
      executionIntent,
      receipts: [],
      evidence: {
        hasOutput: true,
        verifiedExecution: true,
        verifiedExecutionReceiptCount: 1,
      },
      outcome: buildCompletedOutcome("generic-structured-artifact"),
    });

    expect(sufficiency.sufficient).toBe(true);
    expect(sufficiency.missingEvidence).toEqual([]);
  });

  it("accepts archive-producing tool receipts when they emit a producedArtifact of kind archive", () => {
    // New contract-first behavior: tool name does not matter — the producedArtifact does.
    const executionIntent: PlatformRuntimeExecutionIntent = {
      runId: "archive-via-exec",
      intent: "code",
      artifactKinds: ["archive"],
      expectations: {},
    };
    const receipts: PlatformRuntimeExecutionReceipt[] = [
      {
        kind: "tool",
        name: "exec",
        status: "success",
        proof: "reported",
        summary: "built archive.zip",
        producedArtifacts: [
          {
            kind: "archive",
            format: "zip",
            mimeType: "application/zip",
            path: "/tmp/archive.zip",
          },
        ],
      },
    ];

    const sufficiency = isCompletionEvidenceSufficient({
      executionIntent,
      receipts,
      evidence: { hasOutput: true },
      outcome: buildCompletedOutcome("archive-via-exec"),
    });

    expect(sufficiency.sufficient).toBe(true);
    expect(sufficiency.missingEvidence).toEqual([]);
  });

  it("rejects text-only confirmed delivery for structured artifacts", () => {
    const executionIntent: PlatformRuntimeExecutionIntent = {
      runId: "artifact-delivery-only",
      intent: "document",
      artifactKinds: ["document"],
      expectations: {},
    };
    const receipts: PlatformRuntimeExecutionReceipt[] = [
      {
        kind: "messaging_delivery",
        name: "delivery.telegram",
        status: "success",
        proof: "verified",
        summary: "confirmed by reply dispatcher",
      },
    ];

    const sufficiency = isCompletionEvidenceSufficient({
      executionIntent,
      receipts,
      evidence: {
        hasOutput: true,
        hasStructuredReplyPayload: false,
        confirmedDeliveryCount: 1,
      },
      outcome: buildCompletedOutcome("artifact-delivery-only"),
    });

    expect(sufficiency.sufficient).toBe(false);
    expect(sufficiency.missingEvidence).toEqual(["tool_receipt", "artifact_descriptor"]);
  });

  it("accepts tool-backed structured artifact evidence", () => {
    const executionIntent: PlatformRuntimeExecutionIntent = {
      runId: "artifact-with-pdf",
      intent: "document",
      artifactKinds: ["document"],
      deliverable: {
        kind: "document",
        acceptedFormats: ["pdf"],
      },
      expectations: {},
    };
    const receipts: PlatformRuntimeExecutionReceipt[] = [
      {
        kind: "tool",
        name: "pdf",
        status: "success",
        proof: "reported",
        summary: "pdf rendered",
        producedArtifacts: [
          {
            kind: "document",
            format: "pdf",
            mimeType: "application/pdf",
            path: "/tmp/out.pdf",
          },
        ],
      },
    ];

    const sufficiency = isCompletionEvidenceSufficient({
      executionIntent,
      receipts,
      evidence: {
        hasOutput: false,
        hasStructuredReplyPayload: false,
      },
      outcome: buildCompletedOutcome("artifact-with-pdf"),
    });

    expect(sufficiency.sufficient).toBe(true);
    expect(sufficiency.missingEvidence).toEqual([]);
  });

  it("accepts document artifacts produced by any tool when the producedArtifact matches the deliverable", () => {
    const executionIntent: PlatformRuntimeExecutionIntent = {
      runId: "artifact-with-docx",
      intent: "document",
      artifactKinds: ["document"],
      deliverable: {
        kind: "document",
        acceptedFormats: ["docx"],
      },
      expectations: {},
    };
    const receipts: PlatformRuntimeExecutionReceipt[] = [
      {
        kind: "tool",
        name: "docx_write",
        status: "success",
        proof: "reported",
        summary: "wrote banana-life.docx",
        producedArtifacts: [
          {
            kind: "document",
            format: "docx",
            mimeType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            path: "/tmp/banana-life.docx",
          },
        ],
      },
    ];

    const sufficiency = isCompletionEvidenceSufficient({
      executionIntent,
      receipts,
      evidence: {
        hasOutput: true,
        hasStructuredReplyPayload: true,
      },
      outcome: buildCompletedOutcome("artifact-with-write"),
    });

    expect(sufficiency.sufficient).toBe(true);
    expect(sufficiency.missingEvidence).toEqual([]);
  });

  it("rejects mixed document-plus-image runs when only image_generate succeeded", () => {
    const executionIntent: PlatformRuntimeExecutionIntent = {
      runId: "document-with-supporting-images-only",
      intent: "document",
      artifactKinds: ["document", "image"],
      expectations: {},
    };
    const receipts: PlatformRuntimeExecutionReceipt[] = [
      {
        kind: "tool",
        name: "image_generate",
        status: "success",
        proof: "reported",
        summary: "generated supporting infographic image",
      },
    ];

    const sufficiency = isCompletionEvidenceSufficient({
      executionIntent,
      receipts,
      evidence: {
        hasOutput: true,
        hasStructuredReplyPayload: true,
      },
      outcome: buildCompletedOutcome("document-with-supporting-images-only"),
    });

    expect(sufficiency.sufficient).toBe(false);
    expect(sufficiency.missingEvidence).toContain("tool_receipt");
  });

  it("accepts process-backed interactive local results", () => {
    const executionIntent: PlatformRuntimeExecutionIntent = {
      runId: "interactive-site-preview",
      intent: "code",
      artifactKinds: ["site"],
      expectations: {},
    };
    const receipts: PlatformRuntimeExecutionReceipt[] = [
      {
        kind: "tool",
        name: "exec",
        status: "success",
        proof: "reported",
        summary: "dev server started",
      },
    ];
    const outcome = buildCompletedOutcome("interactive-site-preview");
    outcome.confirmedActionIds = ["process:preview"];

    const sufficiency = isCompletionEvidenceSufficient({
      executionIntent,
      receipts,
      evidence: {
        confirmedActionCount: 1,
      },
      outcome,
    });

    expect(sufficiency.sufficient).toBe(true);
    expect(sufficiency.requirements.outcomeContract).toBe("interactive_local_result");
    expect(sufficiency.missingEvidence).toEqual([]);
  });

  it("does not require capability_receipt for successful document artifacts when no bootstrap capability was declared", () => {
    const executionIntent: PlatformRuntimeExecutionIntent = {
      runId: "pdf-with-images-no-bootstrap",
      intent: "document",
      artifactKinds: ["document", "image"],
      outcomeContract: "structured_artifact",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: true,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: true,
      },
      requestedEvidence: ["tool_receipt", "artifact_descriptor", "capability_receipt"],
      expectations: {},
    };
    const receipts: PlatformRuntimeExecutionReceipt[] = [
      {
        kind: "tool",
        name: "image_generate",
        status: "success",
        proof: "reported",
        summary: "generated supporting image",
        producedArtifacts: [
          {
            kind: "image",
            format: "png",
            mimeType: "image/png",
            path: "/tmp/support.png",
          },
        ],
      },
      {
        kind: "tool",
        name: "pdf",
        status: "success",
        proof: "reported",
        summary: "rendered infographic_city_cat_life.pdf",
        producedArtifacts: [
          {
            kind: "document",
            format: "pdf",
            mimeType: "application/pdf",
            path: "/tmp/infographic.pdf",
          },
        ],
      },
    ];

    const sufficiency = isCompletionEvidenceSufficient({
      executionIntent,
      receipts,
      evidence: {
        hasOutput: true,
        hasStructuredReplyPayload: true,
      },
      outcome: buildCompletedOutcome("pdf-with-images-no-bootstrap"),
    });

    expect(sufficiency.sufficient).toBe(true);
    expect(sufficiency.missingEvidence).toEqual([]);
  });

  it("accepts a docx producedArtifact for a document deliverable regardless of tool name (universal)", () => {
    // Universality check: docx is a newly-registered producer. With contract-first evidence,
    // the same acceptance logic works without any tool-name whitelist update.
    const executionIntent: PlatformRuntimeExecutionIntent = {
      runId: "docx-universal",
      intent: "document",
      artifactKinds: ["document"],
      deliverable: {
        kind: "document",
        acceptedFormats: ["docx", "pdf"],
        preferredFormat: "docx",
      },
      expectations: {},
    };
    const receipts: PlatformRuntimeExecutionReceipt[] = [
      {
        kind: "tool",
        name: "docx_write",
        status: "success",
        proof: "reported",
        producedArtifacts: [
          {
            kind: "document",
            format: "docx",
            mimeType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            path: "/tmp/banana.docx",
          },
        ],
      },
    ];
    const sufficiency = isCompletionEvidenceSufficient({
      executionIntent,
      receipts,
      evidence: { hasOutput: true },
      outcome: buildCompletedOutcome("docx-universal"),
    });
    expect(sufficiency.sufficient).toBe(true);
    expect(sufficiency.missingEvidence).toEqual([]);
  });

  it("rejects a docx deliverable when only pdf was produced (acceptedFormats mismatch)", () => {
    const executionIntent: PlatformRuntimeExecutionIntent = {
      runId: "docx-missing",
      intent: "document",
      artifactKinds: ["document"],
      deliverable: {
        kind: "document",
        acceptedFormats: ["docx"],
      },
      expectations: {},
    };
    const receipts: PlatformRuntimeExecutionReceipt[] = [
      {
        kind: "tool",
        name: "pdf",
        status: "success",
        proof: "reported",
        producedArtifacts: [
          {
            kind: "document",
            format: "pdf",
            mimeType: "application/pdf",
            path: "/tmp/wrong.pdf",
          },
        ],
      },
    ];
    const sufficiency = isCompletionEvidenceSufficient({
      executionIntent,
      receipts,
      evidence: { hasOutput: true },
      outcome: buildCompletedOutcome("docx-missing"),
    });
    expect(sufficiency.sufficient).toBe(false);
    expect(sufficiency.missingEvidence).toContain("tool_receipt");
  });
});
