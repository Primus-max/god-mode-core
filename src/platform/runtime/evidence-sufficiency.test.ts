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
      expectations: {},
    };
    const receipts: PlatformRuntimeExecutionReceipt[] = [
      {
        kind: "tool",
        name: "pdf",
        status: "success",
        proof: "reported",
        summary: "pdf rendered",
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
});
