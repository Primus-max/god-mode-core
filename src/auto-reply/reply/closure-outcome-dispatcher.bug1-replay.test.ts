import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TRUSTED_CAPABILITY_CATALOG,
  getPlatformBootstrapService,
  resetPlatformBootstrapService,
  type BootstrapRequest,
} from "../../platform/bootstrap/index.js";
import {
  getPlatformRuntimeCheckpointService,
  resetPlatformRuntimeCheckpointService,
} from "../../platform/runtime/index.js";
import { dispatchMessagingClosureOutcome } from "./closure-outcome-dispatcher.js";
import { clearSessionQueues, resetInMemoryFollowupQueuesForTests } from "./queue.js";

/**
 * Phase 8 Bug #1 — live-fixture replay test (per sub-plan §3 Phase 8).
 *
 * Reproduces the live-log sequence:
 *   1. `Capability "pdf-renderer" was installed and verified` (success, prior turn)
 *   2. follow-up turn arrives, contractor still requests bootstrap remediation
 *   3. dispatcher would historically emit `bootstrap_noop` and cancel the
 *      closure recovery checkpoint — false positive.
 *
 * Asserts NEW Phase 8 behaviour:
 *   - `[closure-outcome] event=bootstrap_skip_already_verified capability=pdf-renderer` line emitted.
 *   - `bootstrap_noop:` text NOT present in any log line.
 *   - The recovery checkpoint stays alive (not cancelled, no `recovery_checkpoint_terminal`).
 */

function buildRequestForCapability(capabilityId: string): BootstrapRequest {
  const catalogEntry = TRUSTED_CAPABILITY_CATALOG.find(
    (entry) => entry.capability.id === capabilityId,
  );
  if (!catalogEntry) {
    throw new Error(`approved catalog entry missing for ${capabilityId}`);
  }
  return {
    capabilityId,
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
      requiredCapabilities: [capabilityId],
      bootstrapRequiredCapabilities: [capabilityId],
      requireExplicitApproval: true,
      policyAutonomy: "assist",
    },
    approvalMode: "explicit",
    catalogEntry,
  };
}

describe("closure-outcome-dispatcher — bug #1 live-fixture replay (PolicyGate Full Phase 8)", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let logged: string[];

  beforeEach(() => {
    getPlatformRuntimeCheckpointService().registerContinuationHandler(
      "bootstrap_run",
      async () => {},
    );
    logged = [];
    consoleSpy = vi.spyOn(console, "log").mockImplementation((message: unknown) => {
      if (typeof message === "string") {
        logged.push(message);
      }
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    resetPlatformBootstrapService();
    resetPlatformRuntimeCheckpointService();
    resetInMemoryFollowupQueuesForTests();
    clearSessionQueues(["openclaw-bug1-replay"]);
  });

  it("verified resume — replay: bootstrap_skip_already_verified emitted, bootstrap_noop absent", async () => {
    // Phase 1: drive a real bootstrap to verified, mirroring
    // `Capability "pdf-renderer" was installed and verified`.
    const service = getPlatformBootstrapService();
    const created = service.create(buildRequestForCapability("pdf-renderer"));
    service.resolve(created.id, "approve");
    await service.run({
      id: created.id,
      installers: {
        node: async ({ request }) => ({
          ok: true,
          capability: {
            ...request.catalogEntry.capability,
            trusted: true,
            sandboxed: true,
            installMethod: "node" as const,
            status: "available" as const,
          },
        }),
      },
      availableBins: ["node"],
      runHealthCheckCommand: async () => true,
    });
    expect(service.get(created.id)?.state).toBe("available");

    // Phase 2: a follow-up turn arrives. Contractor still flags bootstrap
    // remediation. Dispatcher MUST NOT mark closure recovery cancelled.
    const runId = "run-bug1-replay-verified-resume";
    const checkpointId = `closure:${runId}:bootstrap:retry`;
    const runtimeCheckpointService = getPlatformRuntimeCheckpointService();
    runtimeCheckpointService.createCheckpoint({
      id: checkpointId,
      runId,
      sessionKey: "agent:main:main",
      boundary: "exec_approval",
      blockedReason: "verified resume bootstrap recheck",
      target: { approvalId: checkpointId, operation: "closure.recovery" },
      continuation: {
        kind: "closure_recovery",
        state: "idle",
        attempts: 0,
        input: {},
      },
    });

    const sourceRun = {
      prompt: "Сделай документ pdf",
      enqueuedAt: 0,
      automation: {
        source: "closure_recovery" as const,
        retryCount: 0,
        runtimeCheckpointId: checkpointId,
      },
      run: {
        agentId: "agent-replay",
        agentDir: "/tmp/agent-replay",
        sessionId: "sess-replay",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/sess-replay.jsonl",
        workspaceDir: "/tmp/ws-replay",
        config: {},
        provider: "test",
        model: "test-model",
        modelRoutePreflightDisabled: true,
        timeoutMs: 60_000,
        blockReplyBreak: "message_end" as const,
      },
    };

    const dispatched = dispatchMessagingClosureOutcome({
      queueKey: "openclaw-bug1-replay",
      sourceRun: sourceRun as never,
      settings: { mode: "followup" },
      acceptance: {
        action: "retry",
        remediation: "bootstrap",
        reasons: ["Run completed but contract demands platform_action."],
        runId,
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
          bootstrapRequestIds: [],
          pendingApprovalIds: [],
        },
      } as never,
      executionIntent: {
        runId,
        profileId: "builder",
        recipeId: "doc_ingest",
        intent: "document",
        bootstrapRequiredCapabilities: ["pdf-renderer"],
        expectations: { requiresOutput: true },
      },
    });

    // NEW Phase 8 behaviour expectations:
    expect(dispatched.bootstrapNoOp).toBeUndefined();
    expect(dispatched.bootstrapRequestIds).toBeUndefined();

    const skipLog = logged.find((line) =>
      line.includes("[closure-outcome] event=bootstrap_skip_already_verified"),
    );
    expect(skipLog).toBeDefined();
    expect(skipLog).toContain("capability=pdf-renderer");

    // Negative: no `bootstrap_noop:` text in logs.
    const noopLog = logged.find((line) => line.includes("bootstrap_noop:"));
    expect(noopLog).toBeUndefined();

    // Checkpoint stays alive — not cancelled, not failed.
    const checkpoint = runtimeCheckpointService.get(checkpointId);
    expect(checkpoint?.status).not.toBe("cancelled");
    expect(checkpoint?.continuation?.state).not.toBe("failed");
  });
});
