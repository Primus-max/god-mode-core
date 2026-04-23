import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as agentEvents from "../../infra/agent-events.js";
import type { DeliverableSpec } from "../produce/registry.js";
import { IntentLedger } from "../session/intent-ledger.js";
import { computeIntentFingerprint } from "../session/intent-fingerprint.js";
import { buildLedgerPriorEvidence } from "./prior-evidence/ledger-probe.js";
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

  it("builds verified capability receipts from completed bootstrap checkpoints", () => {
    const service = createPlatformRuntimeCheckpointService();
    const checkpoint = service.createCheckpoint({
      id: "bootstrap-checkpoint-only",
      runId: "run-bootstrap-checkpoint",
      boundary: "bootstrap",
      target: {
        bootstrapRequestId: "bootstrap-checkpoint-request",
        operation: "bootstrap.run",
      },
      executionContext: {
        profileId: "builder",
        recipeId: "doc_ingest",
        bootstrapRequiredCapabilities: ["pdf-renderer"],
      },
    });
    service.updateCheckpoint(checkpoint.id, {
      status: "completed",
    });

    expect(
      service.buildExecutionReceipts({
        runId: "run-bootstrap-checkpoint",
        outcome: service.buildRunOutcome("run-bootstrap-checkpoint"),
      }),
    ).toEqual([
      expect.objectContaining({
        kind: "capability",
        name: "bootstrap.run",
        status: "success",
        proof: "verified",
        metadata: expect.objectContaining({
          checkpointId: "bootstrap-checkpoint-only",
          bootstrapRequestId: "bootstrap-checkpoint-request",
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
        status: "satisfied",
        action: "close",
        remediation: "none",
        reasonCode: "completed_with_output",
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

  it("does not close physical artifact requests from text-only confirmed delivery", () => {
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
        runId: "run-structured-artifact-required",
        recipeId: "doc_ingest",
        intent: "document",
        artifactKinds: ["document"],
        expectations: {},
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
    expect(verification.status).toBe("mismatch");
    expect(verification.reasons.join(" ")).toContain(
      "Structured artifact completion requires a matching successful tool receipt.",
    );

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
        status: "retryable",
        action: "retry",
        remediation: "semantic_retry",
        reasonCode: "contract_mismatch",
      }),
    );
  });

  it("accepts clarify follow-up turns without rewriting the original qualified contract", () => {
    const service = createPlatformRuntimeCheckpointService();
    const outcome: PlatformRuntimeRunOutcome = {
      runId: "run-clarify-followup",
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
    const contract = service.buildExecutionContract({
      runId: outcome.runId,
      outcome,
      executionIntent: {
        runId: outcome.runId,
        recipeId: "general_reasoning",
        intent: "publish",
        outcomeContract: "external_operation",
        executionContract: {
          requiresTools: true,
          requiresWorkspaceMutation: false,
          requiresLocalProcess: true,
          requiresArtifactEvidence: false,
          requiresDeliveryEvidence: false,
          mayNeedBootstrap: true,
        },
        requestedEvidence: ["tool_receipt", "capability_receipt"],
        lowConfidenceStrategy: "clarify",
        expectations: {},
      },
      evidence: {
        hasOutput: true,
      },
    });
    const verification = service.verifyExecutionContract({
      contract,
      outcome,
      evidence: {
        hasOutput: true,
        declaredIntent: "publish",
        declaredOutcomeContract: "external_operation",
        declaredExecutionContract: {
          requiresTools: true,
          requiresWorkspaceMutation: false,
          requiresLocalProcess: true,
          requiresArtifactEvidence: false,
          requiresDeliveryEvidence: false,
          mayNeedBootstrap: true,
        },
        declaredRequestedEvidence: ["tool_receipt", "capability_receipt"],
        declaredLowConfidenceStrategy: "clarify",
      },
    });
    expect(verification.status).toBe("verified");

    const evidence = service.buildAcceptanceEvidence({
      outcome,
      evidence: {
        hasOutput: true,
      },
      executionIntent: {
        runId: outcome.runId,
        recipeId: "general_reasoning",
        intent: "publish",
        outcomeContract: "external_operation",
        executionContract: {
          requiresTools: true,
          requiresWorkspaceMutation: false,
          requiresLocalProcess: true,
          requiresArtifactEvidence: false,
          requiresDeliveryEvidence: false,
          mayNeedBootstrap: true,
        },
        requestedEvidence: ["tool_receipt", "capability_receipt"],
        lowConfidenceStrategy: "clarify",
        expectations: {},
      },
      executionVerification: verification,
    });
    expect(evidence.declaredOutcomeContract).toBe("external_operation");
    expect(evidence.declaredLowConfidenceStrategy).toBe("clarify");

    const acceptance = service.evaluateAcceptance({
      runId: outcome.runId,
      outcome,
      evidence,
    });
    expect(acceptance).toEqual(
      expect.objectContaining({
        status: "satisfied",
        action: "close",
        remediation: "none",
        reasonCode: "completed_with_output",
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

  it("treats successful pdf and image tool receipts as output evidence for structured media runs", () => {
    const service = createPlatformRuntimeCheckpointService();
    const outcome: PlatformRuntimeRunOutcome = {
      runId: "run-structured-media-tools",
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
    const contract = service.buildExecutionContract({
      runId: "run-structured-media-tools",
      outcome,
      receipts: [
        {
          kind: "messaging_delivery",
          name: "delivery.telegram",
          status: "success",
          proof: "verified",
          summary: "confirmed by reply dispatcher",
        },
        {
          kind: "tool",
          name: "image_generate",
          status: "success",
          proof: "reported",
          producedArtifacts: [
            {
              kind: "image",
              format: "png",
              mimeType: "image/png",
              path: "/tmp/structured-media.png",
            },
          ],
        },
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
              path: "/tmp/structured-media.pdf",
            },
          ],
        },
      ],
      executionIntent: {
        runId: "run-structured-media-tools",
        recipeId: "media_production",
        intent: "document",
        artifactKinds: ["image", "document"],
        expectations: {},
      },
      evidence: {
        hasOutput: false,
        hasStructuredReplyPayload: false,
        deliveredReplyCount: 1,
        confirmedDeliveryCount: 1,
      },
    });
    const verification = service.verifyExecutionContract({
      contract,
      outcome,
      evidence: {
        hasOutput: false,
        hasStructuredReplyPayload: false,
        deliveredReplyCount: 1,
        confirmedDeliveryCount: 1,
        declaredIntent: "document",
        declaredRecipeId: "media_production",
        declaredArtifactKinds: ["image", "document"],
      },
    });
    expect(verification.status).toBe("verified");
    expect(verification.reasons.join(" ")).not.toContain("expected output");

    const evidence = service.buildAcceptanceEvidence({
      outcome,
      evidence: {
        hasOutput: false,
        hasStructuredReplyPayload: false,
        deliveredReplyCount: 1,
        confirmedDeliveryCount: 1,
      },
      executionIntent: {
        runId: "run-structured-media-tools",
        recipeId: "media_production",
        intent: "document",
        artifactKinds: ["image", "document"],
        expectations: {},
      },
      executionVerification: verification,
    });
    expect(evidence.hasOutput).toBe(true);

    const acceptance = service.evaluateAcceptance({
      runId: "run-structured-media-tools",
      outcome,
      evidence,
    });
    expect(acceptance).toEqual(
      expect.objectContaining({
        status: "satisfied",
        action: "close",
        remediation: "none",
      }),
    );
  });

  it("treats exec/write tool receipts as output evidence for structured site runs", () => {
    const service = createPlatformRuntimeCheckpointService();
    const outcome: PlatformRuntimeRunOutcome = {
      runId: "run-structured-site-tools",
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
    const contract = service.buildExecutionContract({
      runId: "run-structured-site-tools",
      outcome,
      receipts: [
        {
          kind: "messaging_delivery",
          name: "delivery.telegram",
          status: "success",
          proof: "verified",
          summary: "confirmed by reply dispatcher",
        },
        {
          kind: "tool",
          name: "exec",
          status: "success",
          proof: "reported",
        },
      ],
      executionIntent: {
        runId: "run-structured-site-tools",
        recipeId: "code_build_publish",
        intent: "code",
        artifactKinds: ["site"],
        expectations: {},
      },
      evidence: {
        hasOutput: false,
        hasStructuredReplyPayload: false,
        deliveredReplyCount: 1,
        confirmedDeliveryCount: 1,
      },
    });
    const verification = service.verifyExecutionContract({
      contract,
      outcome,
      evidence: {
        hasOutput: false,
        hasStructuredReplyPayload: false,
        deliveredReplyCount: 1,
        confirmedDeliveryCount: 1,
        declaredIntent: "code",
        declaredRecipeId: "code_build_publish",
        declaredArtifactKinds: ["site"],
      },
    });
    expect(verification.status).toBe("verified");
    expect(verification.reasons.join(" ")).not.toContain("expected output");
  });

  it("propagates intent-aware artifact evidence through buildRunClosure", () => {
    const service = createPlatformRuntimeCheckpointService();
    const closure = service.buildRunClosure({
      runId: "run-closure-structured-media",
      outcome: {
        runId: "run-closure-structured-media",
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
      receipts: [
        {
          kind: "messaging_delivery",
          name: "delivery.telegram",
          status: "success",
          proof: "verified",
          summary: "confirmed by reply dispatcher",
        },
        {
          kind: "tool",
          name: "image_generate",
          status: "success",
          proof: "reported",
          producedArtifacts: [
            {
              kind: "image",
              format: "png",
              mimeType: "image/png",
              path: "/tmp/closure-structured-media.png",
            },
          ],
        },
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
              path: "/tmp/closure-structured-media.pdf",
            },
          ],
        },
      ],
      executionIntent: {
        runId: "run-closure-structured-media",
        recipeId: "media_production",
        intent: "document",
        artifactKinds: ["image", "document"],
        expectations: {},
      },
      evidence: {
        hasOutput: false,
        hasStructuredReplyPayload: false,
        deliveredReplyCount: 1,
        confirmedDeliveryCount: 1,
      },
    });

    expect(closure.executionVerification).toEqual(
      expect.objectContaining({
        status: "verified",
      }),
    );
    expect(closure.acceptanceOutcome).toEqual(
      expect.objectContaining({
        status: "satisfied",
        action: "close",
        remediation: "none",
      }),
    );
  });

  it("does not treat completed bootstrap history as an active bootstrap requirement", () => {
    const service = createPlatformRuntimeCheckpointService();
    const acceptance = service.evaluateAcceptance({
      runId: "run-completed-bootstrap-history",
      outcome: {
        runId: "run-completed-bootstrap-history",
        status: "completed",
        checkpointIds: ["bootstrap-origin:1:run-completed-bootstrap-history"],
        blockedCheckpointIds: [],
        completedCheckpointIds: ["bootstrap-origin:1:run-completed-bootstrap-history"],
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
        confirmedDeliveryCount: 1,
        deliveredReplyCount: 1,
        verifiedExecution: true,
        verifiedExecutionReceiptCount: 2,
        executionContractMismatch: false,
        executionSurfaceStatus: "ready",
        declaredIntent: "document",
        declaredArtifactKinds: ["document"],
      },
    });

    expect(acceptance).toEqual(
      expect.objectContaining({
        status: "satisfied",
        action: "close",
      }),
    );
    expect(acceptance.reasonCode).not.toBe("bootstrap_required");
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

  // Iteration 6 — Live acceptance truth
  // These tests prove that evaluateAcceptance cannot close workspace_change or
  // interactive_local_result runs from text-only evidence: real tool receipts are required.

  it("blocks workspace_change completion from text-only evidence with no tool receipt", () => {
    const service = createPlatformRuntimeCheckpointService();
    const outcome: PlatformRuntimeRunOutcome = {
      runId: "run-workspace-text-only",
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
        hasOutput: true,
        declaredOutcomeContract: "workspace_change",
      },
      receipts: [],
    });
    expect(acceptance).toEqual(
      expect.objectContaining({
        status: "retryable",
        reasonCode: "completed_without_evidence",
      }),
    );
  });

  it("accepts workspace_change completion when a successful write receipt is provided", () => {
    const service = createPlatformRuntimeCheckpointService();
    const outcome: PlatformRuntimeRunOutcome = {
      runId: "run-workspace-with-write",
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
        hasOutput: true,
        declaredOutcomeContract: "workspace_change",
      },
      receipts: [
        { kind: "tool", name: "write", status: "success", proof: "reported", summary: "file written" },
      ],
    });
    expect(acceptance).toEqual(
      expect.objectContaining({
        status: "satisfied",
        action: "close",
      }),
    );
  });

  it("blocks interactive_local_result completion from text-only evidence with no exec or process receipt", () => {
    const service = createPlatformRuntimeCheckpointService();
    const outcome: PlatformRuntimeRunOutcome = {
      runId: "run-site-text-only",
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
        hasOutput: true,
        declaredArtifactKinds: ["site"],
      },
      receipts: [],
    });
    expect(acceptance).toEqual(
      expect.objectContaining({
        status: "retryable",
        reasonCode: "completed_without_evidence",
      }),
    );
  });

  it("stops retrying completed_without_evidence after the no-evidence cap is exhausted", () => {
    // Simulate the embedded-runner path: each call has a shared requestRunId
    // but starts fresh with no recoveryAttemptCount supplied by the caller.
    const service = createPlatformRuntimeCheckpointService();
    const sharedRequestRunId = "req-no-evidence-cap";
    const makeOutcome = (runId: string): PlatformRuntimeRunOutcome => ({
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
    });

    // Attempt 1: tracker at 0 → retryable (semantic_retry not exhausted yet)
    const closure1 = service.buildRunClosure({
      runId: "run-no-evidence-1",
      requestRunId: sharedRequestRunId,
      outcome: makeOutcome("run-no-evidence-1"),
      evidence: {
        hasOutput: true,
        declaredOutcomeContract: "structured_artifact",
        declaredArtifactKinds: ["document"],
      },
      receipts: [],
    });
    // buildRunClosure fires contract verification before the evidence gate;
    // the reported reason code is contract_mismatch (with semantic_retry remediation)
    expect(closure1.acceptanceOutcome).toMatchObject({
      status: "retryable",
      remediation: "semantic_retry",
    });
    expect(closure1.supervisorVerdict.action).toBe("retry");

    // Attempt 2: tracker now at 1 → budget exhausted → terminal stop
    const closure2 = service.buildRunClosure({
      runId: "run-no-evidence-2",
      requestRunId: sharedRequestRunId,
      outcome: makeOutcome("run-no-evidence-2"),
      evidence: {
        hasOutput: true,
        declaredOutcomeContract: "structured_artifact",
        declaredArtifactKinds: ["document"],
        // Caller still does NOT supply recoveryAttemptCount
      },
      receipts: [],
    });
    expect(closure2.acceptanceOutcome.status).toBe("retryable");
    expect(closure2.supervisorVerdict).toMatchObject({
      action: "stop",
      reasonCode: "recovery_budget_exhausted",
    });
  });

  it("resets the no-evidence cap counter when valid receipts arrive", () => {
    const service = createPlatformRuntimeCheckpointService();
    const sharedRequestRunId = "req-no-evidence-reset";
    const makeOutcome = (runId: string): PlatformRuntimeRunOutcome => ({
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
    });

    // Attempt 1: no evidence → retryable, counter becomes 1
    service.buildRunClosure({
      runId: "run-no-evidence-reset-1",
      requestRunId: sharedRequestRunId,
      outcome: makeOutcome("run-no-evidence-reset-1"),
      evidence: {
        hasOutput: true,
        declaredOutcomeContract: "structured_artifact",
        declaredArtifactKinds: ["document"],
      },
      receipts: [],
    });

    // Attempt 2: valid pdf tool receipt → clears the counter
    const closureWithReceipt = service.buildRunClosure({
      runId: "run-no-evidence-reset-2",
      requestRunId: sharedRequestRunId,
      outcome: makeOutcome("run-no-evidence-reset-2"),
      evidence: {
        hasOutput: true,
        declaredOutcomeContract: "structured_artifact",
        declaredArtifactKinds: ["document"],
        verifiedExecution: true,
        verifiedExecutionReceiptCount: 1,
      },
      receipts: [
        {
          kind: "tool",
          name: "pdf",
          status: "success",
          proof: "verified",
          summary: "PDF generated",
          producedArtifacts: [
            {
              kind: "document",
              format: "pdf",
              mimeType: "application/pdf",
              path: "/tmp/no-evidence-reset.pdf",
            },
          ],
        },
      ],
    });
    // Receipt present → acceptance should pass, counter cleared
    expect(closureWithReceipt.acceptanceOutcome.status).not.toBe("retryable");
    expect(closureWithReceipt.acceptanceOutcome.reasonCode).not.toBe(
      "completed_without_evidence",
    );

    // Attempt 3: no evidence again → back to retryable (counter was reset, not at cap)
    const closureAfterReset = service.buildRunClosure({
      runId: "run-no-evidence-reset-3",
      requestRunId: sharedRequestRunId,
      outcome: makeOutcome("run-no-evidence-reset-3"),
      evidence: {
        hasOutput: true,
        declaredOutcomeContract: "structured_artifact",
        declaredArtifactKinds: ["document"],
      },
      receipts: [],
    });
    expect(closureAfterReset.acceptanceOutcome).toMatchObject({
      status: "retryable",
      remediation: "semantic_retry",
    });
    expect(closureAfterReset.supervisorVerdict.action).toBe("retry");
  });

  it("stops site/interactive_local_result from endless timeout by capping no-evidence retries", () => {
    const service = createPlatformRuntimeCheckpointService();
    const sharedRequestRunId = "req-site-no-evidence-cap";
    const makeOutcome = (runId: string): PlatformRuntimeRunOutcome => ({
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
    });

    // Attempt 1: text-only reply for site request → retryable (semantic_retry)
    const closure1 = service.buildRunClosure({
      runId: "run-site-no-evidence-1",
      requestRunId: sharedRequestRunId,
      outcome: makeOutcome("run-site-no-evidence-1"),
      evidence: {
        hasOutput: true,
        declaredOutcomeContract: "interactive_local_result",
        declaredArtifactKinds: ["site"],
      },
      receipts: [],
    });
    expect(closure1.acceptanceOutcome).toMatchObject({
      status: "retryable",
      remediation: "semantic_retry",
    });
    expect(closure1.supervisorVerdict.action).toBe("retry");

    // Attempt 2: same text-only reply → terminal stop, not a second timeout
    const closure2 = service.buildRunClosure({
      runId: "run-site-no-evidence-2",
      requestRunId: sharedRequestRunId,
      outcome: makeOutcome("run-site-no-evidence-2"),
      evidence: {
        hasOutput: true,
        declaredOutcomeContract: "interactive_local_result",
        declaredArtifactKinds: ["site"],
      },
      receipts: [],
    });
    expect(closure2.supervisorVerdict).toMatchObject({
      action: "stop",
      reasonCode: "recovery_budget_exhausted",
    });
  });

  it("accepts interactive_local_result completion when exec receipt and confirmed action are present", () => {
    const service = createPlatformRuntimeCheckpointService();
    const outcome: PlatformRuntimeRunOutcome = {
      runId: "run-site-with-exec",
      status: "completed",
      checkpointIds: [],
      blockedCheckpointIds: [],
      completedCheckpointIds: [],
      deniedCheckpointIds: [],
      pendingApprovalIds: [],
      artifactIds: [],
      bootstrapRequestIds: [],
      actionIds: ["exec-action-1"],
      attemptedActionIds: ["exec-action-1"],
      confirmedActionIds: ["exec-action-1"],
      failedActionIds: [],
      boundaries: [],
    };
    const acceptance = service.evaluateAcceptance({
      runId: outcome.runId,
      outcome,
      evidence: {
        hasOutput: true,
        declaredArtifactKinds: ["site"],
        // confirmed action count explicitly set so processReceipt is satisfied
        confirmedActionCount: 1,
        // verifiedExecutionReceiptCount satisfies requiresVerifiedNonMessagingClosure gate
        verifiedExecution: true,
        verifiedExecutionReceiptCount: 1,
      },
      receipts: [
        { kind: "tool", name: "exec", status: "success", proof: "reported", summary: "dev server started" },
      ],
    });
    expect(acceptance).toEqual(
      expect.objectContaining({
        status: "satisfied",
        action: "close",
      }),
    );
  });

  it("does not require platform_action receipts for exec-only repo_operation contracts", () => {
    const service = createPlatformRuntimeCheckpointService();
    const outcome: PlatformRuntimeRunOutcome = {
      runId: "run-exec-only-repo-operation",
      status: "completed",
      checkpointIds: [],
      blockedCheckpointIds: [],
      completedCheckpointIds: [],
      deniedCheckpointIds: [],
      pendingApprovalIds: [],
      artifactIds: [],
      bootstrapRequestIds: [],
      actionIds: ["exec-action-1"],
      attemptedActionIds: ["exec-action-1"],
      confirmedActionIds: [],
      failedActionIds: [],
      boundaries: [],
    };
    const contract = service.buildExecutionContract({
      runId: outcome.runId,
      outcome,
      receipts: [
        {
          kind: "tool",
          name: "exec",
          status: "success",
          proof: "reported",
          summary: "dev server started",
          metadata: {
            exitCode: 0,
            pid: 4242,
            url: "http://127.0.0.1:3000",
          },
        },
      ],
      executionIntent: {
        runId: outcome.runId,
        recipeId: "ops_orchestration",
        intent: "code",
        artifactKinds: ["site"],
        requestedToolNames: ["exec"],
        deliverable: {
          kind: "repo_operation",
          acceptedFormats: ["exec"],
          preferredFormat: "exec",
          constraints: { operation: "run_command" },
        },
        outcomeContract: "interactive_local_result",
        executionContract: {
          requiresTools: true,
          requiresWorkspaceMutation: false,
          requiresLocalProcess: true,
          requiresArtifactEvidence: false,
          requiresDeliveryEvidence: false,
          mayNeedBootstrap: false,
        },
        requestedEvidence: ["tool_receipt", "process_receipt"],
        expectations: {},
      },
      evidence: {
        hasOutput: true,
      },
    });

    expect(contract.expectations).toEqual(
      expect.objectContaining({
        requiresOutput: true,
        requiresConfirmedAction: false,
        requireStructuredReceipts: false,
      }),
    );
    expect(contract.expectations?.requiredReceiptKinds).toBeUndefined();

    const verification = service.verifyExecutionContract({
      contract,
      outcome,
      evidence: {
        hasOutput: true,
        declaredIntent: "code",
        declaredArtifactKinds: ["site"],
        declaredOutcomeContract: "interactive_local_result",
        declaredExecutionContract: {
          requiresTools: true,
          requiresWorkspaceMutation: false,
          requiresLocalProcess: true,
          requiresArtifactEvidence: false,
          requiresDeliveryEvidence: false,
          mayNeedBootstrap: false,
        },
        declaredRequestedEvidence: ["tool_receipt", "process_receipt"],
      },
    });
    expect(verification.status).toBe("verified");

    const evidence = service.buildAcceptanceEvidence({
      outcome,
      evidence: {
        hasOutput: true,
      },
      executionIntent: {
        runId: outcome.runId,
        recipeId: "ops_orchestration",
        intent: "code",
        artifactKinds: ["site"],
        requestedToolNames: ["exec"],
        deliverable: {
          kind: "repo_operation",
          acceptedFormats: ["exec"],
          preferredFormat: "exec",
          constraints: { operation: "run_command" },
        },
        outcomeContract: "interactive_local_result",
        executionContract: {
          requiresTools: true,
          requiresWorkspaceMutation: false,
          requiresLocalProcess: true,
          requiresArtifactEvidence: false,
          requiresDeliveryEvidence: false,
          mayNeedBootstrap: false,
        },
        requestedEvidence: ["tool_receipt", "process_receipt"],
        expectations: {},
      },
      executionVerification: verification,
    });
    const acceptance = service.evaluateAcceptance({
      runId: outcome.runId,
      outcome,
      evidence,
      receipts: contract.receipts,
    });
    expect(acceptance).toEqual(
      expect.objectContaining({
        status: "satisfied",
        action: "close",
        remediation: "none",
      }),
    );
  });

  it("accepts exec-same-intent via ledger priorEvidence after five minutes without a new tool receipt", () => {
    let now = 10_000;
    const ledger = new IntentLedger({ now: () => now });
    const service = createPlatformRuntimeCheckpointService();
    const runId = "run-exec-same-intent-five-minutes";
    const deliverable: DeliverableSpec = {
      kind: "repo_operation",
      acceptedFormats: ["exec"],
      preferredFormat: "exec",
      constraints: {
        target_repo: "/tmp/god-mode-core",
        command_signature: "pnpm dev",
        operation: "run_command",
      },
    };
    const requiredCapabilities = ["needs_repo_execution", "needs_local_runtime"];
    const fingerprint = computeIntentFingerprint(deliverable, requiredCapabilities);

    expect(fingerprint).toBeTruthy();

    ledger.recordFromBotTurn({
      turnId: "turn-exec-original",
      sessionId: "session-exec-same-intent",
      channelId: "telegram",
      summary: "Уже сделано: dev server started",
      planOutput: {
        executionContract: { requiresTools: true },
        fingerprint,
      },
      runtimeReceipts: [
        {
          kind: "tool",
          name: "exec",
          status: "success",
          summary: "dev server started",
          metadata: {
            exitCode: 0,
            pid: 4242,
            url: "http://127.0.0.1:5173",
          },
        },
      ],
      createdAt: now,
    });

    now += 5 * 60 * 1000;

    const priorEvidence = [
      buildLedgerPriorEvidence({
        ledger,
        sessionId: "session-exec-same-intent",
        channelId: "telegram",
        fingerprint: fingerprint!,
      }),
    ];
    const outcome: PlatformRuntimeRunOutcome = {
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
    const closure = service.buildRunClosure({
      runId,
      outcome,
      receipts: [],
      evidence: {
        hasOutput: true,
      },
      executionIntent: {
        runId,
        recipeId: "ops_orchestration",
        intent: "code",
        artifactKinds: ["site"],
        requestedToolNames: ["exec"],
        deliverable,
        outcomeContract: "interactive_local_result",
        executionContract: {
          requiresTools: true,
          requiresWorkspaceMutation: false,
          requiresLocalProcess: true,
          requiresArtifactEvidence: false,
          requiresDeliveryEvidence: false,
          mayNeedBootstrap: false,
        },
        requestedEvidence: ["tool_receipt", "process_receipt"],
        requiredCapabilities,
        expectations: {},
      },
      priorEvidence,
    });

    expect(priorEvidence[0]?.receipts).toHaveLength(1);
    expect(closure.acceptanceOutcome).toEqual(
      expect.objectContaining({
        status: "satisfied",
        action: "close",
        reasonCode: "completed_with_output",
      }),
    );
    expect(closure.executionVerification.status).toBe("verified");
  });
});
