import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetInMemoryFollowupQueuesForTests } from "./queue.js";
import { dispatchMessagingClosureOutcome } from "./closure-outcome-dispatcher.js";
import {
  BootstrapBlockedRunResumeSchema,
  TRUSTED_CAPABILITY_CATALOG,
  createBootstrapRequestService,
  getPlatformBootstrapService,
  resetPlatformBootstrapService,
  type BootstrapRequest,
} from "../../platform/bootstrap/index.js";
import {
  getPlatformRuntimeCheckpointService,
  resetPlatformRuntimeCheckpointService,
} from "../../platform/runtime/index.js";

function buildBootstrapRequest(overrides: Partial<BootstrapRequest> = {}): BootstrapRequest {
  const catalogEntry = TRUSTED_CAPABILITY_CATALOG.find(
    (entry) => entry.capability.id === "pdf-renderer",
  );
  if (!catalogEntry) {
    throw new Error("pdf-renderer catalog entry unavailable");
  }
  return {
    capabilityId: "pdf-renderer",
    installMethod: catalogEntry.install?.method ?? "node",
    rollbackStrategy: "restore_previous",
    reason: "renderer_unavailable",
    sourceDomain: "document",
    sourceRecipeId: "doc_ingest",
    executionContext: {
      profileId: "builder",
      recipeId: "doc_ingest",
      taskOverlayId: "document_first",
      intent: "document",
      requiredCapabilities: ["pdf-renderer"],
      bootstrapRequiredCapabilities: ["pdf-renderer"],
      requireExplicitApproval: true,
      policyAutonomy: "assist",
    },
    approvalMode: "explicit",
    catalogEntry,
    ...overrides,
  };
}

function installBootstrapContinuationNoop() {
  getPlatformRuntimeCheckpointService().registerContinuationHandler("bootstrap_run", async () => {});
}

describe("dispatchMessagingClosureOutcome bootstrap resume merge", () => {
  afterEach(() => {
    resetPlatformBootstrapService();
    resetPlatformRuntimeCheckpointService();
    resetInMemoryFollowupQueuesForTests();
  });

  it("merges blockedRunResume into existing bootstrap requests referenced by the outcome", () => {
    installBootstrapContinuationNoop();
    const service = getPlatformBootstrapService();
    const created = service.create(buildBootstrapRequest());
    expect(service.get(created.id)?.request.blockedRunResume).toBeUndefined();

    const sourceRun = {
      prompt: "finish the document task",
      enqueuedAt: 0,
      run: {
        agentId: "agent-resume",
        agentDir: "/tmp/agent",
        sessionId: "sess-resume",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/sess-resume.jsonl",
        workspaceDir: "/tmp/ws-resume",
        config: {},
        provider: "test",
        model: "test-model",
        modelRoutePreflightDisabled: true,
        timeoutMs: 60_000,
        blockReplyBreak: "message_end",
      },
    };

    const expectedResume = BootstrapBlockedRunResumeSchema.parse({
      blockedRunId: "run-bootstrap-closure",
      sessionKey: "agent:main:main",
      queueKey: "openclaw-bootstrap-resume-merge",
      settings: { mode: "followup" },
      sourceRun,
    });

    const dispatched = dispatchMessagingClosureOutcome({
      queueKey: "openclaw-bootstrap-resume-merge",
      sourceRun: sourceRun as never,
      settings: { mode: "followup" },
      acceptance: {
        action: "close",
        remediation: "bootstrap",
        reasons: ["bootstrap is already pending"],
        runId: "run-bootstrap-closure",
        recoveryPolicy: {
          remediation: "bootstrap",
          recoveryClass: "bootstrap",
          cadence: "manual",
          continuous: false,
          attemptCount: 0,
          maxAttempts: 0,
          remainingAttempts: 0,
          exhausted: false,
          exhaustedAction: "stop",
        },
        outcome: {
          bootstrapRequestIds: [created.id],
          pendingApprovalIds: [],
        },
      } as never,
      executionIntent: {
        runId: "run-bootstrap-closure",
        profileId: "builder",
        recipeId: "doc_ingest",
        intent: "document",
        bootstrapRequiredCapabilities: ["pdf-renderer"],
        expectations: { requiresOutput: true },
      },
    });

    expect(dispatched.bootstrapRequestIds).toEqual([created.id]);
    expect(service.get(created.id)?.request.blockedRunResume).toEqual(expectedResume);
    expect(getPlatformRuntimeCheckpointService().get(created.id)?.continuation?.input).toEqual(
      expect.objectContaining({
        blockedRunResume: true,
        blockedRunId: "run-bootstrap-closure",
        queueKey: "openclaw-bootstrap-resume-merge",
      }),
    );
  });

  it("merges blockedRunResume for tool-origin bootstrap requests even without executionIntent capability hints", () => {
    installBootstrapContinuationNoop();
    const service = getPlatformBootstrapService();
    const created = service.create(
      buildBootstrapRequest({
        executionContext: {
          profileId: "builder",
          recipeId: "doc_ingest",
          intent: "document",
          policyAutonomy: "assist",
        },
      }),
    );

    const sourceRun = {
      prompt: "finish the document task",
      enqueuedAt: 0,
      run: {
        agentId: "agent-resume",
        agentDir: "/tmp/agent",
        sessionId: "sess-resume",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/sess-resume.jsonl",
        workspaceDir: "/tmp/ws-resume",
        config: {},
        provider: "test",
        model: "test-model",
        modelRoutePreflightDisabled: true,
        timeoutMs: 60_000,
        blockReplyBreak: "message_end",
      },
    };

    dispatchMessagingClosureOutcome({
      queueKey: "openclaw-bootstrap-tool-origin",
      sourceRun: sourceRun as never,
      settings: { mode: "followup" },
      acceptance: {
        action: "close",
        remediation: "bootstrap",
        reasons: ["bootstrap is already pending"],
        runId: "run-bootstrap-tool-origin",
        recoveryPolicy: {
          remediation: "bootstrap",
          recoveryClass: "bootstrap",
          cadence: "manual",
          continuous: false,
          attemptCount: 0,
          maxAttempts: 0,
          remainingAttempts: 0,
          exhausted: false,
          exhaustedAction: "stop",
        },
        outcome: {
          bootstrapRequestIds: [created.id],
          pendingApprovalIds: [],
        },
      } as never,
      executionIntent: {
        runId: "run-bootstrap-tool-origin",
        profileId: "builder",
        recipeId: "doc_ingest",
        intent: "document",
        expectations: { requiresOutput: true },
      },
    });

    expect(service.get(created.id)?.request.blockedRunResume).toEqual(
      expect.objectContaining({
        blockedRunId: "run-bootstrap-tool-origin",
        queueKey: "openclaw-bootstrap-tool-origin",
      }),
    );
  });

  it("persists blockedRunResume merges so rehydrate sees tool-origin resume metadata", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bootstrap-resume-"));
    try {
      installBootstrapContinuationNoop();
      const service = getPlatformBootstrapService({ stateDir });
      const created = service.create(
        buildBootstrapRequest({
          executionContext: {
            profileId: "builder",
            recipeId: "doc_ingest",
            intent: "document",
            policyAutonomy: "assist",
          },
        }),
      );

      const sourceRun = {
        prompt: "finish the document task",
        enqueuedAt: 0,
        run: {
          agentId: "agent-resume",
          agentDir: "/tmp/agent",
          sessionId: "sess-resume",
          sessionKey: "agent:main:main",
          sessionFile: "/tmp/sess-resume.jsonl",
          workspaceDir: "/tmp/ws-resume",
          config: {},
          provider: "test",
          model: "test-model",
          modelRoutePreflightDisabled: true,
          timeoutMs: 60_000,
          blockReplyBreak: "message_end",
        },
      };

      dispatchMessagingClosureOutcome({
        queueKey: "openclaw-bootstrap-tool-origin-persist",
        sourceRun: sourceRun as never,
        settings: { mode: "followup" },
        acceptance: {
          action: "close",
          remediation: "bootstrap",
          reasons: ["bootstrap is already pending"],
          runId: "run-bootstrap-tool-origin-persist",
          recoveryPolicy: {
            remediation: "bootstrap",
            recoveryClass: "bootstrap",
            cadence: "manual",
            continuous: false,
            attemptCount: 0,
            maxAttempts: 0,
            remainingAttempts: 0,
            exhausted: false,
            exhaustedAction: "stop",
          },
          outcome: {
            bootstrapRequestIds: [created.id],
            pendingApprovalIds: [],
          },
        } as never,
        executionIntent: {
          runId: "run-bootstrap-tool-origin-persist",
          profileId: "builder",
          recipeId: "doc_ingest",
          intent: "document",
          expectations: { requiresOutput: true },
        },
      });

      const rehydrated = createBootstrapRequestService({ stateDir });
      expect(rehydrated.rehydrate()).toBe(1);
      expect(rehydrated.get(created.id)?.request.blockedRunResume).toEqual(
        expect.objectContaining({
          blockedRunId: "run-bootstrap-tool-origin-persist",
          queueKey: "openclaw-bootstrap-tool-origin-persist",
        }),
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
