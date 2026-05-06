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
 * Bug #1 (audit AUDIT-policy-gate-full.md): the closure-outcome-dispatcher
 * fires `bootstrap_noop` and marks the closure recovery checkpoint cancelled
 * even when the requested capability is already verified. Live evidence:
 *   `Capability "<plugin>" was installed and verified` (bootstrap success)
 *   followed by `bootstrap_noop` from the same closure pass.
 *
 * Fix: `ensureBootstrapRequests` returns a discriminated union
 *   { kind: "requests_created" | "already_verified" | "no_capabilities_advertised" }
 * The dispatcher early-returns on `already_verified` BEFORE the bootstrap_noop
 * branch. A `[closure-outcome] event=bootstrap_skip_already_verified` line is
 * emitted for telemetry parity.
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

async function driveCapabilityToVerified(capabilityId: string): Promise<string> {
  const service = getPlatformBootstrapService();
  const created = service.create(buildRequestForCapability(capabilityId));
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
  const final = service.get(created.id);
  if (final?.state !== "available") {
    throw new Error(
      `expected verified bootstrap record, got state=${final?.state ?? "(none)"}`,
    );
  }
  return created.id;
}

function buildSourceRunWithCheckpoint(params: {
  runId: string;
  checkpointId: string;
  prompt?: string;
}) {
  return {
    prompt: params.prompt ?? "Сделай документ pdf",
    enqueuedAt: 0,
    automation: {
      source: "closure_recovery" as const,
      retryCount: 0,
      runtimeCheckpointId: params.checkpointId,
    },
    run: {
      agentId: "agent-bug1",
      agentDir: "/tmp/agent-bug1",
      sessionId: `sess-${params.runId}`,
      sessionKey: "agent:main:main",
      sessionFile: `/tmp/sess-${params.runId}.jsonl`,
      workspaceDir: "/tmp/ws-bug1",
      config: {},
      provider: "test",
      model: "test-model",
      modelRoutePreflightDisabled: true,
      timeoutMs: 60_000,
      blockReplyBreak: "message_end" as const,
    },
  };
}

function makeCheckpoint(params: { runId: string; sessionKey?: string }) {
  const id = `closure:${params.runId}:bootstrap:retry`;
  const runtimeCheckpointService = getPlatformRuntimeCheckpointService();
  runtimeCheckpointService.createCheckpoint({
    id,
    runId: params.runId,
    sessionKey: params.sessionKey ?? "agent:main:main",
    boundary: "exec_approval",
    blockedReason: "bootstrap noop check",
    target: { approvalId: id, operation: "closure.recovery" },
    continuation: {
      kind: "closure_recovery",
      state: "idle",
      attempts: 0,
      input: {},
    },
  });
  return id;
}

function buildBootstrapAcceptance(params: { runId: string }) {
  return {
    action: "retry" as const,
    remediation: "bootstrap" as const,
    reasons: ["Run completed but renderer was not available."],
    runId: params.runId,
    recoveryPolicy: {
      remediation: "bootstrap",
      recoveryClass: "bootstrap",
      cadence: "manual" as const,
      continuous: false,
      attemptCount: 0,
      maxAttempts: 0,
      remainingAttempts: 0,
      exhausted: false,
      exhaustedAction: "stop" as const,
    },
    outcome: {
      bootstrapRequestIds: [],
      pendingApprovalIds: [],
    },
  };
}

const ALREADY_VERIFIED_LOG_TAG = "[closure-outcome] event=bootstrap_skip_already_verified";

describe("closure-outcome-dispatcher bug #1 (capability-verified false-positive)", () => {
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
    clearSessionQueues([
      "openclaw-bug1-already-verified",
      "openclaw-bug1-no-caps",
      "openclaw-bug1-mixed",
      "openclaw-bug1-reverse",
      "openclaw-bug1-idempotency",
      "openclaw-bug1-brand",
    ]);
  });

  it("fix: capability already verified — no bootstrap_noop, no markCheckpointFailed, log emitted", async () => {
    await driveCapabilityToVerified("pdf-renderer");

    const runId = "run-bug1-already-verified";
    const checkpointId = makeCheckpoint({ runId });
    const sourceRun = buildSourceRunWithCheckpoint({ runId, checkpointId });

    const dispatched = dispatchMessagingClosureOutcome({
      queueKey: "openclaw-bug1-already-verified",
      sourceRun: sourceRun as never,
      settings: { mode: "followup" },
      acceptance: buildBootstrapAcceptance({ runId }) as never,
      executionIntent: {
        runId,
        profileId: "builder",
        recipeId: "doc_ingest",
        intent: "document",
        bootstrapRequiredCapabilities: ["pdf-renderer"],
        expectations: { requiresOutput: true },
      },
    });

    // The bug fix: bootstrap_noop must NOT fire when the capability is verified.
    expect(dispatched.bootstrapNoOp).toBeUndefined();

    // The checkpoint must NOT be marked cancelled (recovery flow still alive).
    const checkpoint = getPlatformRuntimeCheckpointService().get(checkpointId);
    expect(checkpoint?.status).not.toBe("cancelled");
    expect(checkpoint?.continuation?.state).not.toBe("failed");
    expect(checkpoint?.continuation?.lastError ?? "").not.toMatch(/bootstrap_noop/);

    // The new telemetry log line must be present.
    const matches = logged.filter((line) => line.includes(ALREADY_VERIFIED_LOG_TAG));
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]).toContain("capability=pdf-renderer");
  });

  it("regression: no capabilities advertised — bootstrap_noop preserved (Path A unchanged)", () => {
    const runId = "run-bug1-no-caps";
    const checkpointId = makeCheckpoint({ runId });
    const sourceRun = buildSourceRunWithCheckpoint({ runId, checkpointId });

    const dispatched = dispatchMessagingClosureOutcome({
      queueKey: "openclaw-bug1-no-caps",
      sourceRun: sourceRun as never,
      settings: { mode: "followup" },
      acceptance: buildBootstrapAcceptance({ runId }) as never,
      executionIntent: {
        runId,
        profileId: "builder",
        recipeId: "doc_authoring",
        intent: "document",
        bootstrapRequiredCapabilities: [],
        expectations: { requiresOutput: true },
      },
    });

    expect(dispatched.bootstrapNoOp).toBe(true);
    const closed = getPlatformRuntimeCheckpointService().get(checkpointId);
    expect(closed?.status).toBe("cancelled");
    expect(closed?.continuation?.state).toBe("failed");
    expect(closed?.continuation?.lastError ?? "").toMatch(/bootstrap_noop/);
    // The skip log MUST NOT fire on Path A.
    const matches = logged.filter((line) => line.includes(ALREADY_VERIFIED_LOG_TAG));
    expect(matches).toHaveLength(0);
  });

  it("mixed: at least one verified + at least one missing — only unverified produces a request, verified emits skip log", async () => {
    // Pre-verify pdf-renderer; pdf-parser remains unbootstrapped.
    await driveCapabilityToVerified("pdf-renderer");

    const runId = "run-bug1-mixed";
    const checkpointId = makeCheckpoint({ runId });
    const sourceRun = buildSourceRunWithCheckpoint({ runId, checkpointId });

    const dispatched = dispatchMessagingClosureOutcome({
      queueKey: "openclaw-bug1-mixed",
      sourceRun: sourceRun as never,
      settings: { mode: "followup" },
      acceptance: buildBootstrapAcceptance({ runId }) as never,
      executionIntent: {
        runId,
        profileId: "builder",
        recipeId: "doc_ingest",
        intent: "document",
        bootstrapRequiredCapabilities: ["pdf-renderer", "pdf-parser"],
        expectations: { requiresOutput: true },
      },
    });

    // At least one unverified capability → at least one new request → bootstrap_noop must NOT fire.
    expect(dispatched.bootstrapNoOp).toBeUndefined();
    expect((dispatched.bootstrapRequestIds ?? []).length).toBeGreaterThan(0);

    // The skip log fires for the verified pdf-renderer (we observed it as verified).
    const skipMatches = logged.filter((line) => line.includes(ALREADY_VERIFIED_LOG_TAG));
    expect(skipMatches.some((line) => line.includes("capability=pdf-renderer"))).toBe(true);

    // The verified capability MUST NOT have a fresh request created for it.
    const service = getPlatformBootstrapService();
    const allRecords = service.list();
    const pdfRendererRecords = allRecords.filter((r) => r.capabilityId === "pdf-renderer");
    // Only the pre-verified record (state: 'available'); no new pending one.
    expect(pdfRendererRecords.filter((r) => r.state === "pending")).toHaveLength(0);
  });

  it("reverse: capability-verified path does NOT emit recovery_checkpoint_terminal telemetry", async () => {
    await driveCapabilityToVerified("pdf-renderer");

    const runId = "run-bug1-reverse";
    const checkpointId = makeCheckpoint({ runId });
    const sourceRun = buildSourceRunWithCheckpoint({ runId, checkpointId });

    const before = getPlatformRuntimeCheckpointService().get(checkpointId);
    const beforeStatus = before?.status;

    dispatchMessagingClosureOutcome({
      queueKey: "openclaw-bug1-reverse",
      sourceRun: sourceRun as never,
      settings: { mode: "followup" },
      acceptance: buildBootstrapAcceptance({ runId }) as never,
      executionIntent: {
        runId,
        profileId: "builder",
        recipeId: "doc_ingest",
        intent: "document",
        bootstrapRequiredCapabilities: ["pdf-renderer"],
        expectations: { requiresOutput: true },
      },
    });

    // No transition to cancelled implies no `recovery_checkpoint_terminal`
    // emission from `markClosureRecoveryCheckpointFailed` for this pass.
    const after = getPlatformRuntimeCheckpointService().get(checkpointId);
    expect(after?.status).toBe(beforeStatus);
    expect(after?.continuation?.state).not.toBe("failed");
  });

  it("idempotency: repeated dispatch within same turn keeps already-verified suppression", async () => {
    await driveCapabilityToVerified("pdf-renderer");

    const runId = "run-bug1-idempotency";
    const checkpointId = makeCheckpoint({ runId });
    const sourceRun = buildSourceRunWithCheckpoint({ runId, checkpointId });

    const callTwice = () =>
      dispatchMessagingClosureOutcome({
        queueKey: "openclaw-bug1-idempotency",
        sourceRun: sourceRun as never,
        settings: { mode: "followup" },
        acceptance: buildBootstrapAcceptance({ runId }) as never,
        executionIntent: {
          runId,
          profileId: "builder",
          recipeId: "doc_ingest",
          intent: "document",
          bootstrapRequiredCapabilities: ["pdf-renderer"],
          expectations: { requiresOutput: true },
        },
      });

    const first = callTwice();
    const second = callTwice();

    expect(first.bootstrapNoOp).toBeUndefined();
    expect(second.bootstrapNoOp).toBeUndefined();
    const closed = getPlatformRuntimeCheckpointService().get(checkpointId);
    expect(closed?.status).not.toBe("cancelled");
    // At least 2 emissions of the skip log line (one per dispatch pass).
    const matches = logged.filter((line) => line.includes(ALREADY_VERIFIED_LOG_TAG));
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("brand discipline: capability id is preserved as plain string in the skip log without leaking BootstrapRequest internals", async () => {
    await driveCapabilityToVerified("pdf-renderer");

    const runId = "run-bug1-brand";
    const checkpointId = makeCheckpoint({ runId });
    const sourceRun = buildSourceRunWithCheckpoint({ runId, checkpointId });

    dispatchMessagingClosureOutcome({
      queueKey: "openclaw-bug1-brand",
      sourceRun: sourceRun as never,
      settings: { mode: "followup" },
      acceptance: buildBootstrapAcceptance({ runId }) as never,
      executionIntent: {
        runId,
        profileId: "builder",
        recipeId: "doc_ingest",
        intent: "document",
        bootstrapRequiredCapabilities: ["pdf-renderer"],
        expectations: { requiresOutput: true },
      },
    });

    const matches = logged.filter((line) => line.includes(ALREADY_VERIFIED_LOG_TAG));
    expect(matches.length).toBeGreaterThan(0);
    // The log line is a plain string, not a serialized request record.
    expect(matches[0]).toMatch(/^\[closure-outcome\] event=bootstrap_skip_already_verified capability=pdf-renderer$/);
    // Must not leak BootstrapRequest internals into the line.
    expect(matches[0]).not.toContain("catalogEntry");
    expect(matches[0]).not.toContain("approvalMode");
    expect(matches[0]).not.toContain("blockedRunResume");
  });
});
