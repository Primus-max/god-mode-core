import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as agentEvents from "../../infra/agent-events.js";
import {
  createPlatformRuntimeCheckpointService,
  resetPlatformRuntimeCheckpointService,
  type PlatformRuntimeRunOutcome,
} from "./index.js";

const tempDirs: string[] = [];

afterEach(() => {
  resetPlatformRuntimeCheckpointService();
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("platform runtime checkpoint service", () => {
  it("creates, updates, and persists checkpoints", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-checkpoints-"));
    tempDirs.push(stateDir);
    const service = createPlatformRuntimeCheckpointService({ stateDir });

    const blocked = service.createCheckpoint({
      id: "checkpoint-1",
      runId: "run-1",
      sessionKey: "session-1",
      boundary: "exec_approval",
      blockedReason: "approval required",
      nextActions: [
        { method: "exec.approval.resolve", label: "Resolve approval", phase: "approve" },
      ],
      target: { approvalId: "approval-1", operation: "system.run" },
    });
    expect(blocked.status).toBe("blocked");
    expect(service.findByApprovalId("approval-1")?.id).toBe("checkpoint-1");

    const approved = service.updateCheckpoint("checkpoint-1", {
      status: "approved",
      approvedAtMs: 123,
    });
    expect(approved?.status).toBe("approved");

    const next = createPlatformRuntimeCheckpointService({ stateDir });
    expect(next.rehydrate()).toBe(1);
    expect(next.get("checkpoint-1")).toEqual(
      expect.objectContaining({
        status: "approved",
        sessionKey: "session-1",
      }),
    );
  });

  it("dispatches checkpoint continuations and builds run outcomes", async () => {
    const telemetrySpy = vi.spyOn(agentEvents, "emitRuntimeRecoveryTelemetry");
    const service = createPlatformRuntimeCheckpointService();
    const dispatched: string[] = [];
    service.registerContinuationHandler("closure_recovery", async (checkpoint) => {
      dispatched.push(checkpoint.id);
      service.updateCheckpoint(checkpoint.id, {
        status: "completed",
        completedAtMs: 456,
      });
    });

    service.createCheckpoint({
      id: "checkpoint-dispatch",
      runId: "run-dispatch",
      boundary: "exec_approval",
      target: { approvalId: "approval-1", operation: "closure.recovery" },
      continuation: {
        kind: "closure_recovery",
        input: { queueKey: "queue-1" },
        state: "idle",
        attempts: 0,
      },
    });

    await service.dispatchContinuation("checkpoint-dispatch");

    expect(telemetrySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        milestone: "continuation_dispatch_start",
        checkpointId: "checkpoint-dispatch",
        continuationKind: "closure_recovery",
        runId: "run-dispatch",
      }),
    );
    expect(telemetrySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        milestone: "continuation_dispatch_handler_done",
        checkpointId: "checkpoint-dispatch",
        continuationKind: "closure_recovery",
      }),
    );
    telemetrySpy.mockRestore();

    expect(dispatched).toEqual(["checkpoint-dispatch"]);
    expect(service.get("checkpoint-dispatch")).toEqual(
      expect.objectContaining({
        status: "completed",
        continuation: expect.objectContaining({
          state: "completed",
          attempts: 1,
        }),
      }),
    );
    expect(service.buildRunOutcome("run-dispatch")).toEqual(
      expect.objectContaining({
        status: "completed",
        checkpointIds: ["checkpoint-dispatch"],
        completedCheckpointIds: ["checkpoint-dispatch"],
        pendingApprovalIds: [],
        actionIds: [],
        attemptedActionIds: [],
        confirmedActionIds: [],
        failedActionIds: [],
      }),
    );
    expect(service.list({ runId: "run-dispatch" })).toEqual([
      expect.objectContaining({
        id: "checkpoint-dispatch",
        continuation: expect.objectContaining({
          kind: "closure_recovery",
          state: "completed",
          attempts: 1,
        }),
      }),
    ]);
  });

  it("includes execution context in checkpoint summaries", () => {
    const service = createPlatformRuntimeCheckpointService();
    service.createCheckpoint({
      id: "checkpoint-execution-context",
      runId: "run-execution-context",
      sessionKey: "session-execution-context",
      boundary: "bootstrap",
      blockedReason: "table parser review pending",
      executionContext: {
        profileId: "builder",
        recipeId: "table_extract",
        providerOverride: "ollama",
        modelOverride: "qwen2.5-coder:7b",
        modelRouteTier: "local_eligible",
        fallbackModels: ["hydra/gpt-4o-mini"],
        requiredCapabilities: ["table-parser"],
      },
    });

    expect(service.list({ runId: "run-execution-context" })).toEqual([
      expect.objectContaining({
        id: "checkpoint-execution-context",
        executionContext: expect.objectContaining({
          profileId: "builder",
          recipeId: "table_extract",
          modelRouteTier: "local_eligible",
        }),
      }),
    ]);
  });

  it("persists action ledger entries and includes them in run outcomes", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-actions-"));
    tempDirs.push(stateDir);
    const service = createPlatformRuntimeCheckpointService({ stateDir });

    service.stageAction({
      actionId: "action-1",
      runId: "run-actions",
      sessionKey: "session-actions",
      kind: "bootstrap",
      boundary: "bootstrap",
      checkpointId: "checkpoint-actions",
      target: {
        bootstrapRequestId: "bootstrap-1",
        operation: "bootstrap.run",
      },
    });
    service.markActionAttempted("action-1", { retryable: true });
    service.markActionConfirmed("action-1", {
      receipt: {
        bootstrapRequestId: "bootstrap-1",
        capabilityId: "pdf-renderer",
        operation: "bootstrap.run",
        resultStatus: "bootstrapped",
      },
    });

    expect(service.getAction("action-1")).toEqual(
      expect.objectContaining({
        state: "confirmed",
        attemptCount: 1,
      }),
    );
    expect(service.listActions({ runId: "run-actions" })).toEqual([
      expect.objectContaining({
        actionId: "action-1",
        state: "confirmed",
      }),
    ]);
    expect(service.buildRunOutcome("run-actions")).toEqual(
      expect.objectContaining({
        actionIds: ["action-1"],
        attemptedActionIds: [],
        confirmedActionIds: ["action-1"],
        failedActionIds: [],
      }),
    );

    const next = createPlatformRuntimeCheckpointService({ stateDir });
    expect(next.rehydrate()).toBe(1);
    expect(next.getAction("action-1")).toEqual(
      expect.objectContaining({
        state: "confirmed",
      }),
    );
  });

  it("preserves run correlation when re-staging an existing action without run metadata", () => {
    const service = createPlatformRuntimeCheckpointService();
    service.stageAction({
      actionId: "action-preserve-run",
      runId: "run-preserve",
      sessionKey: "session-preserve",
      kind: "messaging_delivery",
      target: {
        operation: "deliver",
      },
    });
    service.markActionFailed("action-preserve-run", {
      lastError: "temporary network failure",
      retryable: true,
    });

    service.stageAction({
      actionId: "action-preserve-run",
      kind: "messaging_delivery",
      target: {
        operation: "deliver",
      },
    });

    expect(service.getAction("action-preserve-run")).toEqual(
      expect.objectContaining({
        runId: "run-preserve",
        sessionKey: "session-preserve",
      }),
    );
    expect(service.buildRunOutcome("run-preserve")).toEqual(
      expect.objectContaining({
        actionIds: ["action-preserve-run"],
      }),
    );
  });

  it("builds verified execution receipts from structured runtime actions", () => {
    const service = createPlatformRuntimeCheckpointService();
    service.stageAction({
      actionId: "bootstrap-action",
      runId: "run-execution-receipts",
      kind: "bootstrap",
      boundary: "bootstrap",
      checkpointId: "bootstrap-checkpoint",
      target: {
        bootstrapRequestId: "bootstrap-verified",
        operation: "bootstrap.run",
      },
    });
    service.markActionConfirmed("bootstrap-action", {
      receipt: {
        bootstrapRequestId: "bootstrap-verified",
        capabilityId: "pdf-renderer",
        operation: "bootstrap.run",
        resultStatus: "bootstrapped",
      },
    });

    expect(
      service.buildExecutionReceipts({
        runId: "run-execution-receipts",
        outcome: service.buildRunOutcome("run-execution-receipts"),
      }),
    ).toEqual([
      expect.objectContaining({
        kind: "capability",
        name: "bootstrap.run",
        status: "success",
        proof: "verified",
        metadata: expect.objectContaining({
          actionId: "bootstrap-action",
          capabilityId: "pdf-renderer",
        }),
      }),
    ]);
  });

  it("evaluates acceptance outcomes from runtime evidence", () => {
    const service = createPlatformRuntimeCheckpointService();
    const accepted = service.evaluateAcceptance({
      runId: "run-acceptance",
      outcome: {
        runId: "run-acceptance",
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
      },
      evidence: {
        hasOutput: true,
      },
    });
    expect(accepted).toEqual(
      expect.objectContaining({
        status: "satisfied",
        action: "close",
        remediation: "none",
        reasonCode: "completed_with_output",
      }),
    );

    const bootstrapPaused = service.evaluateAcceptance({
      runId: "run-bootstrap-paused",
      outcome: {
        runId: "run-bootstrap-paused",
        status: "completed",
        checkpointIds: ["bootstrap-checkpoint"],
        blockedCheckpointIds: [],
        completedCheckpointIds: ["bootstrap-checkpoint"],
        deniedCheckpointIds: [],
        pendingApprovalIds: [],
        artifactIds: [],
        bootstrapRequestIds: ["bootstrap-request-1"],
        actionIds: [],
        attemptedActionIds: [],
        confirmedActionIds: [],
        failedActionIds: [],
        boundaries: ["bootstrap"],
      },
      evidence: {
        hasOutput: true,
      },
    });
    expect(bootstrapPaused).toEqual(
      expect.objectContaining({
        status: "retryable",
        action: "retry",
        remediation: "bootstrap",
        reasonCode: "bootstrap_required",
      }),
    );

    const escalate = service.evaluateAcceptance({
      runId: "run-human",
      outcome: {
        runId: "run-human",
        status: "blocked",
        checkpointIds: ["checkpoint-human"],
        blockedCheckpointIds: ["checkpoint-human"],
        completedCheckpointIds: [],
        deniedCheckpointIds: [],
        pendingApprovalIds: ["approval-human"],
        artifactIds: [],
        bootstrapRequestIds: [],
        actionIds: [],
        attemptedActionIds: [],
        confirmedActionIds: [],
        failedActionIds: [],
        boundaries: ["exec_approval"],
      },
    });
    expect(escalate).toEqual(
      expect.objectContaining({
        status: "needs_human",
        action: "escalate",
        remediation: "needs_human",
        reasonCode: "pending_approval",
      }),
    );

    const confirmedDelivery = service.evaluateAcceptance({
      runId: "run-delivered",
      outcome: {
        runId: "run-delivered",
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
      },
      evidence: {
        attemptedDeliveryCount: 1,
        confirmedDeliveryCount: 1,
        deliveredReplyCount: 1,
      },
    });
    expect(confirmedDelivery).toEqual(
      expect.objectContaining({
        status: "satisfied",
        action: "close",
        remediation: "none",
        reasonCode: "completed_with_confirmed_delivery",
      }),
    );

    const failedDelivery = service.evaluateAcceptance({
      runId: "run-delivery-failed",
      outcome: {
        runId: "run-delivery-failed",
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
      },
      evidence: {
        stagedReplyCount: 1,
        attemptedDeliveryCount: 1,
        confirmedDeliveryCount: 0,
        failedDeliveryCount: 1,
      },
    });
    expect(failedDelivery).toEqual(
      expect.objectContaining({
        status: "retryable",
        action: "retry",
        remediation: "delivery_retry",
        recoveryPolicy: expect.objectContaining({
          recoveryClass: "delivery",
          cadence: "backoff",
          continuous: true,
          maxAttempts: 5,
          remainingAttempts: 5,
          exhausted: false,
          exhaustedAction: "stop",
        }),
        reasonCode: "delivery_failed",
      }),
    );
  });

  it("builds and persists durable run closures with declared execution intent", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-closures-"));
    tempDirs.push(stateDir);
    const service = createPlatformRuntimeCheckpointService({ stateDir });
    const outcome: PlatformRuntimeRunOutcome = {
      runId: "run-closure",
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
    const closure = service.buildRunClosure({
      runId: outcome.runId,
      requestRunId: "request-closure",
      parentRunId: "run-closure-parent",
      sessionKey: "session-closure",
      outcome,
      evidence: {
        hasOutput: true,
      },
      executionIntent: {
        runId: outcome.runId,
        profileId: "developer",
        recipeId: "code_build_publish",
        intent: "publish",
        artifactKinds: ["site"],
        expectations: {
          requiresOutput: true,
        },
      },
    });
    expect(closure).toEqual(
      expect.objectContaining({
        runId: "run-closure",
        requestRunId: "request-closure",
        parentRunId: "run-closure-parent",
        sessionKey: "session-closure",
        executionIntent: expect.objectContaining({
          recipeId: "code_build_publish",
          intent: "publish",
          artifactKinds: ["site"],
        }),
        acceptanceOutcome: expect.objectContaining({
          evidence: expect.objectContaining({
            declaredRecipeId: "code_build_publish",
            declaredIntent: "publish",
            declaredRequiresOutput: true,
          }),
        }),
      }),
    );

    service.recordRunClosure(closure);
    const next = createPlatformRuntimeCheckpointService({ stateDir });
    expect(next.rehydrate()).toBe(1);
    expect(next.getRunClosure("run-closure")).toEqual(
      expect.objectContaining({
        requestRunId: "request-closure",
        parentRunId: "run-closure-parent",
        sessionKey: "session-closure",
        executionIntent: expect.objectContaining({
          recipeId: "code_build_publish",
        }),
      }),
    );
    expect(next.listRunClosures({ requestRunId: "request-closure" })).toEqual([
      expect.objectContaining({
        runId: "run-closure",
        requestRunId: "request-closure",
      }),
    ]);
  });

  it("treats contract mismatches as retryable instead of closing the run", () => {
    const service = createPlatformRuntimeCheckpointService();
    const outcome: PlatformRuntimeRunOutcome = {
      runId: "run-contract-mismatch",
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
    const verification = service.verifyExecutionContract({
      contract: {
        runId: "run-contract-mismatch",
        receipts: [
          {
            kind: "tool",
            name: "write",
            status: "success",
            proof: "reported",
            summary: "tool returned ok",
          },
        ],
        expectations: {
          requiresOutput: true,
        },
      },
      outcome,
      evidence: {
        hasOutput: false,
      },
    });
    expect(verification.status).toBe("mismatch");
    const evidence = service.buildAcceptanceEvidence({
      outcome,
      evidence: { hasOutput: false },
      executionVerification: verification,
    });
    const acceptance = service.evaluateAcceptance({
      runId: "run-contract-mismatch",
      outcome,
      evidence,
    });
    expect(acceptance).toEqual(
      expect.objectContaining({
        status: "retryable",
        action: "retry",
        remediation: "semantic_retry",
        reasonCode: "contract_mismatch",
      }),
    );
    const verdict = service.evaluateSupervisorVerdict({
      runId: "run-contract-mismatch",
      acceptance,
      verification,
    });
    expect(verdict).toEqual(
      expect.objectContaining({
        status: "retryable",
        action: "retry",
        remediation: "semantic_retry",
        reasonCode: "contract_mismatch",
      }),
    );
  });

  it("accepts text-confirmed output for physical artifact requests", () => {
    const service = createPlatformRuntimeCheckpointService();
    const outcome: PlatformRuntimeRunOutcome = {
      runId: "run-structured-artifact-required",
      status: "completed",
      checkpointIds: [],
      blockedCheckpointIds: [],
      completedCheckpointIds: [],
      deniedCheckpointIds: [],
      pendingApprovalIds: [],
      artifactIds: [],
      bootstrapRequestIds: [],
      actionIds: ["messaging:artifact-delivery"],
      attemptedActionIds: [],
      confirmedActionIds: ["messaging:artifact-delivery"],
      failedActionIds: [],
      boundaries: [],
    };
    const contract = service.buildExecutionContract({
      runId: "run-structured-artifact-required",
      outcome,
      receipts: [
        {
          kind: "messaging_delivery",
          name: "delivery.telegram",
          status: "success",
          proof: "verified",
          summary: "runtime action confirmed",
        },
      ],
      executionIntent: {
        recipeId: "doc_ingest",
        intent: "document",
        artifactKinds: ["document"],
      },
      evidence: {
        hasOutput: true,
        hasStructuredReplyPayload: false,
        stagedReplyCount: 1,
        deliveredReplyCount: 1,
        confirmedDeliveryCount: 1,
      },
    });
    const verification = service.verifyExecutionContract({
      contract,
      outcome,
      evidence: {
        hasOutput: true,
        hasStructuredReplyPayload: false,
        stagedReplyCount: 1,
        deliveredReplyCount: 1,
        confirmedDeliveryCount: 1,
        declaredIntent: "document",
        declaredRecipeId: "doc_ingest",
        declaredArtifactKinds: ["document"],
      },
    });
    expect(verification.status).toBe("verified");
    expect(verification.reasons.join(" ")).not.toContain("expected output");

    const evidence = service.buildAcceptanceEvidence({
      outcome,
      evidence: {
        hasOutput: true,
        hasStructuredReplyPayload: false,
        stagedReplyCount: 1,
        deliveredReplyCount: 1,
        confirmedDeliveryCount: 1,
      },
      executionIntent: {
        runId: "run-structured-artifact-required",
        recipeId: "doc_ingest",
        intent: "document",
        artifactKinds: ["document"],
        expectations: {},
      },
      executionVerification: verification,
    });
    const acceptance = service.evaluateAcceptance({
      runId: "run-structured-artifact-required",
      outcome,
      evidence,
    });
    expect(acceptance).toEqual(
      expect.objectContaining({
        status: "satisfied",
        action: "close",
        remediation: "none",
        reasonCode: "completed_with_confirmed_delivery",
      }),
    );
  });

  it("does not close non-messaging runs without a verified structured receipt", () => {
    const service = createPlatformRuntimeCheckpointService();
    const outcome: PlatformRuntimeRunOutcome = {
      runId: "run-non-messaging-proof",
      status: "completed",
      checkpointIds: [],
      blockedCheckpointIds: [],
      completedCheckpointIds: [],
      deniedCheckpointIds: [],
      pendingApprovalIds: [],
      artifactIds: ["artifact-1"],
      bootstrapRequestIds: [],
      actionIds: ["artifact:artifact-1:publish"],
      attemptedActionIds: [],
      confirmedActionIds: ["artifact:artifact-1:publish"],
      failedActionIds: [],
      boundaries: ["artifact_publish"],
    };
    const verification = service.verifyExecutionContract({
      contract: {
        runId: "run-non-messaging-proof",
        receipts: [
          {
            kind: "platform_action",
            name: "artifact.publish",
            status: "warning",
            proof: "derived",
            reasons: ["runtime action completed without a structured receipt payload"],
          },
        ],
        expectations: {
          requireStructuredReceipts: true,
          minimumVerifiedReceiptCount: 1,
          requiredReceiptKinds: ["platform_action"],
          allowStandaloneEvidence: false,
        },
      },
      outcome,
      evidence: {
        artifactReceiptCount: 1,
      },
    });
    expect(verification).toEqual(
      expect.objectContaining({
        status: "mismatch",
        receiptProofCounts: expect.objectContaining({
          verified: 0,
          derived: 1,
        }),
        missingReceiptKinds: ["platform_action"],
      }),
    );
    const evidence = service.buildAcceptanceEvidence({
      outcome,
      evidence: { artifactReceiptCount: 1 },
      executionVerification: verification,
    });
    const acceptance = service.evaluateAcceptance({
      runId: "run-non-messaging-proof",
      outcome,
      evidence,
    });
    expect(acceptance).toEqual(
      expect.objectContaining({
        status: "retryable",
        action: "retry",
        remediation: "semantic_retry",
        reasonCode: "contract_mismatch",
      }),
    );
  });

  it("ignores superseded failed receipts when the same tool later succeeds", () => {
    const service = createPlatformRuntimeCheckpointService();
    const outcome: PlatformRuntimeRunOutcome = {
      runId: "run-superseded-failure",
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
    const verification = service.verifyExecutionContract({
      contract: {
        runId: "run-superseded-failure",
        receipts: [
          {
            kind: "tool",
            name: "image_generate",
            status: "failed",
            proof: "reported",
            reasons: ["provider fallback failed"],
          },
          {
            kind: "tool",
            name: "image_generate",
            status: "success",
            proof: "reported",
          },
        ],
        expectations: {
          requiresOutput: true,
        },
      },
      outcome,
      evidence: {
        hasOutput: true,
      },
    });
    expect(verification).toEqual(
      expect.objectContaining({
        status: "verified",
      }),
    );
  });

  it("turns no-progress execution receipts into a bounded supervisor retry", () => {
    const service = createPlatformRuntimeCheckpointService();
    const outcome: PlatformRuntimeRunOutcome = {
      runId: "run-no-progress",
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
    const verification = service.verifyExecutionContract({
      contract: {
        runId: "run-no-progress",
        receipts: [
          {
            kind: "tool",
            name: "process",
            status: "blocked",
            proof: "reported",
            reasons: ["tool reported no progress on a repeated poll path"],
            metadata: { noProgress: true },
          },
        ],
      },
      outcome,
    });
    expect(verification.status).toBe("no_progress");
    const evidence = service.buildAcceptanceEvidence({
      outcome,
      executionVerification: verification,
    });
    const acceptance = service.evaluateAcceptance({
      runId: "run-no-progress",
      outcome,
      evidence,
    });
    expect(acceptance.reasonCode).toBe("execution_no_progress");
    const verdict = service.evaluateSupervisorVerdict({
      runId: "run-no-progress",
      acceptance,
      verification,
    });
    expect(verdict).toEqual(
      expect.objectContaining({
        status: "retryable",
        action: "retry",
        remediation: "semantic_retry",
        recoveryPolicy: expect.objectContaining({
          recoveryClass: "semantic",
          exhausted: false,
          remainingAttempts: 1,
        }),
        reasonCode: "execution_no_progress",
      }),
    );
  });

  it("stops semantic recovery after the retry budget is exhausted", () => {
    const service = createPlatformRuntimeCheckpointService();
    const outcome: PlatformRuntimeRunOutcome = {
      runId: "run-semantic-budget",
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
    const acceptance = service.evaluateAcceptance({
      runId: outcome.runId,
      outcome,
      evidence: {
        executionContractMismatch: true,
        recoveryAttemptCount: 1,
        recoveryMaxAttempts: 1,
      },
    });
    expect(acceptance).toEqual(
      expect.objectContaining({
        action: "retry",
        remediation: "semantic_retry",
        recoveryPolicy: expect.objectContaining({
          recoveryClass: "semantic",
          attemptCount: 1,
          maxAttempts: 1,
          remainingAttempts: 0,
          exhausted: true,
          exhaustedAction: "stop",
        }),
      }),
    );
    const verdict = service.evaluateSupervisorVerdict({
      runId: outcome.runId,
      acceptance,
    });
    expect(verdict).toEqual(
      expect.objectContaining({
        status: "failed",
        action: "stop",
        remediation: "semantic_retry",
        reasonCode: "recovery_budget_exhausted",
        recoveryPolicy: expect.objectContaining({
          exhausted: true,
          exhaustedAction: "stop",
        }),
      }),
    );
  });

  it("selects bootstrap remediation when readiness shows bootstrap_required", () => {
    const service = createPlatformRuntimeCheckpointService();
    const outcome: PlatformRuntimeRunOutcome = {
      runId: "run-bootstrap-remediation",
      status: "completed",
      checkpointIds: [],
      blockedCheckpointIds: [],
      completedCheckpointIds: [],
      deniedCheckpointIds: [],
      pendingApprovalIds: [],
      artifactIds: [],
      bootstrapRequestIds: [],
      actionIds: ["bootstrap-action"],
      attemptedActionIds: ["bootstrap-action"],
      confirmedActionIds: [],
      failedActionIds: ["bootstrap-action"],
      boundaries: ["bootstrap"],
    };
    const acceptance = service.evaluateAcceptance({
      runId: outcome.runId,
      outcome,
      evidence: {
        executionContractMismatch: true,
        executionSurfaceStatus: "bootstrap_required",
        executionUnattendedBoundary: "bootstrap",
      },
    });
    expect(acceptance).toEqual(
      expect.objectContaining({
        action: "retry",
        remediation: "bootstrap",
        reasonCode: "bootstrap_required",
      }),
    );
    const verdict = service.evaluateSupervisorVerdict({
      runId: outcome.runId,
      acceptance,
      surface: {
        status: "bootstrap_required",
        ready: false,
        checkedAtMs: Date.now(),
        reasons: ["bootstrap still required"],
        unattendedBoundary: "bootstrap",
      },
    });
    expect(verdict).toEqual(
      expect.objectContaining({
        action: "retry",
        remediation: "bootstrap",
        reasonCode: "bootstrap_recovery",
      }),
    );
  });

  it("escalates bootstrap recovery after the manual budget is exhausted", () => {
    const service = createPlatformRuntimeCheckpointService();
    const outcome: PlatformRuntimeRunOutcome = {
      runId: "run-bootstrap-exhausted",
      status: "completed",
      checkpointIds: [],
      blockedCheckpointIds: [],
      completedCheckpointIds: [],
      deniedCheckpointIds: [],
      pendingApprovalIds: [],
      artifactIds: [],
      bootstrapRequestIds: [],
      actionIds: ["bootstrap-action"],
      attemptedActionIds: ["bootstrap-action"],
      confirmedActionIds: [],
      failedActionIds: ["bootstrap-action"],
      boundaries: ["bootstrap"],
    };
    const acceptance = service.evaluateAcceptance({
      runId: outcome.runId,
      outcome,
      evidence: {
        executionContractMismatch: true,
        executionSurfaceStatus: "bootstrap_required",
        executionUnattendedBoundary: "bootstrap",
        recoveryAttemptCount: 2,
        recoveryMaxAttempts: 2,
      },
    });
    expect(acceptance.recoveryPolicy).toEqual(
      expect.objectContaining({
        recoveryClass: "bootstrap",
        attemptCount: 2,
        maxAttempts: 2,
        remainingAttempts: 0,
        exhausted: true,
        exhaustedAction: "escalate",
      }),
    );
    const verdict = service.evaluateSupervisorVerdict({
      runId: outcome.runId,
      acceptance,
      surface: {
        status: "bootstrap_required",
        ready: false,
        checkedAtMs: Date.now(),
        reasons: ["bootstrap still required"],
        unattendedBoundary: "bootstrap",
      },
    });
    expect(verdict).toEqual(
      expect.objectContaining({
        status: "needs_human",
        action: "escalate",
        remediation: "bootstrap",
        reasonCode: "recovery_budget_exhausted",
        recoveryPolicy: expect.objectContaining({
          exhausted: true,
          exhaustedAction: "escalate",
        }),
      }),
    );
  });

  it("selects auth remediation when fallback evidence shows provider auth failure", () => {
    const service = createPlatformRuntimeCheckpointService();
    const outcome: PlatformRuntimeRunOutcome = {
      runId: "run-auth-remediation",
      status: "failed",
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
    const acceptance = service.evaluateAcceptance({
      runId: outcome.runId,
      outcome,
      evidence: {
        modelFallbackAttemptCount: 2,
        modelFallbackExhausted: true,
        modelFallbackFinalReason: "auth",
        providerAuthFailed: true,
      },
    });
    expect(acceptance).toEqual(
      expect.objectContaining({
        action: "stop",
        remediation: "auth_refresh",
        reasonCode: "provider_auth_required",
      }),
    );
    const verdict = service.evaluateSupervisorVerdict({
      runId: outcome.runId,
      acceptance,
    });
    expect(verdict).toEqual(
      expect.objectContaining({
        action: "stop",
        remediation: "auth_refresh",
        reasonCode: "auth_recovery",
      }),
    );
  });
});
