import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getFollowupQueueDepth,
  resetInMemoryFollowupQueuesForTests,
} from "../../auto-reply/reply/queue.js";
import {
  getPlatformRuntimeCheckpointService,
  resetPlatformRuntimeCheckpointService,
} from "../runtime/index.js";
import { BootstrapBlockedRunResumeSchema, type BootstrapRequest } from "./contracts.js";
import { TRUSTED_CAPABILITY_CATALOG } from "./defaults.js";
import { createBootstrapRequestService } from "./service.js";

function buildRequest(overrides: Partial<BootstrapRequest> = {}): BootstrapRequest {
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
  getPlatformRuntimeCheckpointService().registerContinuationHandler(
    "bootstrap_run",
    async () => {},
  );
}

describe("bootstrap request service", () => {
  afterEach(() => {
    resetPlatformRuntimeCheckpointService();
    resetInMemoryFollowupQueuesForTests();
  });

  it("creates, lists, and resolves bootstrap requests", () => {
    const service = createBootstrapRequestService();
    installBootstrapContinuationNoop();
    const created = service.create(buildRequest());
    expect(getPlatformRuntimeCheckpointService().get(created.id)?.status).toBe("blocked");

    expect(service.list()).toEqual([
      expect.objectContaining({
        id: created.id,
        capabilityId: "pdf-renderer",
        state: "pending",
      }),
    ]);

    const approved = service.resolve(created.id, "approve");
    expect(approved?.state).toBe("approved");
    expect(getPlatformRuntimeCheckpointService().get(created.id)?.status).toBe("approved");
    expect(service.get(created.id)?.state).toBe("approved");
    expect(service.get(created.id)?.request.executionContext).toEqual(
      expect.objectContaining({
        profileId: "builder",
        recipeId: "doc_ingest",
      }),
    );
  });

  it("reuses an active request with the same signature", () => {
    const service = createBootstrapRequestService();
    installBootstrapContinuationNoop();
    const first = service.create(buildRequest());
    const second = service.create(buildRequest());

    expect(second.id).toBe(first.id);
    expect(service.list()).toHaveLength(1);
  });

  it("runs an approved request and stores the orchestration result", async () => {
    const service = createBootstrapRequestService();
    installBootstrapContinuationNoop();
    const created = service.create(buildRequest());
    service.resolve(created.id, "approve");

    const result = await service.run({
      id: created.id,
      installers: {
        node: async ({ request }) => ({
          ok: true,
          capability: {
            ...request.catalogEntry.capability,
            trusted: true,
            sandboxed: true,
            installMethod: "node",
            status: "available",
          },
        }),
      },
      availableBins: ["node"],
      runHealthCheckCommand: async () => true,
    });

    expect(result?.state).toBe("available");
    expect(result?.result?.status).toBe("bootstrapped");
    expect(result?.result?.lifecycle?.status).toBe("available");
    expect(getPlatformRuntimeCheckpointService().get(created.id)?.status).toBe("completed");
    expect(
      getPlatformRuntimeCheckpointService().buildExecutionReceipts({
        runId: created.id,
        outcome: getPlatformRuntimeCheckpointService().buildRunOutcome(created.id),
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "capability",
          name: "bootstrap.run",
          status: "success",
          proof: "verified",
          metadata: expect.objectContaining({
            bootstrapRequestId: created.id,
            capabilityId: "pdf-renderer",
          }),
        }),
      ]),
    );
  });

  it("does not execute a confirmed bootstrap continuation twice on replay", async () => {
    const service = createBootstrapRequestService();
    installBootstrapContinuationNoop();
    const created = service.create(buildRequest());
    service.resolve(created.id, "approve");
    const installer = vi.fn(async ({ request }: { request: BootstrapRequest }) => ({
      ok: true,
      capability: {
        ...request.catalogEntry.capability,
        trusted: true,
        sandboxed: true,
        installMethod: "node" as const,
        status: "available" as const,
      },
    }));

    const first = await service.run({
      id: created.id,
      installers: {
        node: installer,
      },
      availableBins: ["node"],
      runHealthCheckCommand: async () => true,
    });
    const replay = await service.run({
      id: created.id,
      installers: {
        node: installer,
      },
      availableBins: ["node"],
      runHealthCheckCommand: async () => true,
    });

    expect(installer).toHaveBeenCalledTimes(1);
    expect(first?.state).toBe("available");
    expect(replay?.state).toBe("available");
    expect(getPlatformRuntimeCheckpointService().getAction(`bootstrap:${created.id}:run`)).toEqual(
      expect.objectContaining({
        state: "confirmed",
      }),
    );
  });

  it("reruns a stale confirmed bootstrap action when the request is not terminal", async () => {
    const service = createBootstrapRequestService();
    installBootstrapContinuationNoop();
    const created = service.create(buildRequest());
    service.resolve(created.id, "approve");
    const actionId = `bootstrap:${created.id}:run`;
    const runtime = getPlatformRuntimeCheckpointService();
    runtime.stageAction({
      actionId,
      runId: created.id,
      kind: "bootstrap",
      boundary: "bootstrap",
      checkpointId: created.id,
      target: {
        bootstrapRequestId: created.id,
        operation: "bootstrap.run",
      },
    });
    runtime.markActionConfirmed(actionId, {
      receipt: {
        bootstrapRequestId: created.id,
        capabilityId: "pdf-renderer",
        operation: "bootstrap.run",
        resultStatus: "bootstrapped",
      },
    });

    const installer = vi.fn(async ({ request }: { request: BootstrapRequest }) => ({
      ok: true,
      capability: {
        ...request.catalogEntry.capability,
        trusted: true,
        sandboxed: true,
        installMethod: "node" as const,
        status: "available" as const,
      },
    }));

    const rerun = await service.run({
      id: created.id,
      installers: {
        node: installer,
      },
      availableBins: ["node"],
      runHealthCheckCommand: async () => true,
    });

    expect(installer).toHaveBeenCalledTimes(1);
    expect(rerun?.state).toBe("available");
    expect(rerun?.result?.status).toBe("bootstrapped");
    expect(getPlatformRuntimeCheckpointService().getAction(actionId)).toEqual(
      expect.objectContaining({
        state: "confirmed",
        attemptCount: 1,
      }),
    );
  });

  it("merges blockedRunResume when reusing the same pending bootstrap signature", () => {
    const queueKey = "openclaw-test-bootstrap-merge";
    const blockedRunResume = BootstrapBlockedRunResumeSchema.parse({
      blockedRunId: "run-merge-resume",
      queueKey,
      settings: { mode: "followup" },
      sourceRun: {
        prompt: "finish after merge",
        enqueuedAt: 0,
        run: {
          agentId: "agent-merge",
          agentDir: "/tmp/agent",
          sessionId: "sess-merge",
          sessionFile: "/tmp/sess-merge.jsonl",
          workspaceDir: "/tmp/ws-merge",
          config: {},
          provider: "test",
          model: "test-model",
          timeoutMs: 60_000,
          blockReplyBreak: "message_end",
        },
      },
    });
    const service = createBootstrapRequestService();
    installBootstrapContinuationNoop();
    const first = service.create(buildRequest());
    expect(first.request.blockedRunResume).toBeUndefined();
    const second = service.create(buildRequest({ blockedRunResume }));
    expect(second.id).toBe(first.id);
    expect(service.get(first.id)?.request.blockedRunResume).toEqual(
      expect.objectContaining({
        blockedRunId: "run-merge-resume",
        queueKey,
      }),
    );
    expect(getPlatformRuntimeCheckpointService().get(first.id)?.continuation?.input).toEqual(
      expect.objectContaining({
        blockedRunResume: true,
        blockedRunId: "run-merge-resume",
        queueKey,
      }),
    );
  });

  it("creates a fresh request when an active bootstrap belongs to another blocked run", () => {
    const firstResume = BootstrapBlockedRunResumeSchema.parse({
      blockedRunId: "run-first",
      queueKey: "queue-first",
      settings: { mode: "followup" },
      sourceRun: {
        prompt: "resume first run",
        enqueuedAt: 0,
        run: {
          agentId: "agent-first",
          agentDir: "/tmp/agent-first",
          sessionId: "sess-first",
          sessionFile: "/tmp/sess-first.jsonl",
          workspaceDir: "/tmp/ws-first",
          config: {},
          provider: "test",
          model: "test-model",
          timeoutMs: 60_000,
          blockReplyBreak: "message_end",
        },
      },
    });
    const secondResume = BootstrapBlockedRunResumeSchema.parse({
      blockedRunId: "run-second",
      queueKey: "queue-second",
      settings: { mode: "followup" },
      sourceRun: {
        prompt: "resume second run",
        enqueuedAt: 0,
        run: {
          agentId: "agent-second",
          agentDir: "/tmp/agent-second",
          sessionId: "sess-second",
          sessionFile: "/tmp/sess-second.jsonl",
          workspaceDir: "/tmp/ws-second",
          config: {},
          provider: "test",
          model: "test-model",
          timeoutMs: 60_000,
          blockReplyBreak: "message_end",
        },
      },
    });
    const service = createBootstrapRequestService();
    const first = service.create(buildRequest({ blockedRunResume: firstResume }));
    const second = service.create(buildRequest({ blockedRunResume: secondResume }));

    expect(second.id).not.toBe(first.id);
    expect(service.get(first.id)?.request.blockedRunResume).toEqual(firstResume);
    expect(service.get(second.id)?.request.blockedRunResume).toEqual(secondResume);
  });

  it("keeps explicit approvals idle until platform.bootstrap.run executes", async () => {
    const queueKey = "openclaw-test-bootstrap-approve-resume";
    const blockedRunResume = BootstrapBlockedRunResumeSchema.parse({
      blockedRunId: "run-approve-continuation",
      queueKey,
      settings: { mode: "followup" },
      sourceRun: {
        prompt: "finish the document task",
        enqueuedAt: 0,
        run: {
          agentId: "agent-resume",
          agentDir: "/tmp/agent",
          sessionId: "sess-resume",
          sessionFile: "/tmp/sess-resume.jsonl",
          workspaceDir: "/tmp/ws-resume",
          config: {},
          provider: "test",
          model: "test-model",
          timeoutMs: 60_000,
          blockReplyBreak: "message_end",
        },
      },
    });
    const service = createBootstrapRequestService();
    const created = service.create(buildRequest({ blockedRunResume }));
    expect(created.state).toBe("pending");
    const approved = service.resolve(created.id, "approve");
    expect(approved?.state).toBe("approved");
    expect(getFollowupQueueDepth(queueKey)).toBe(0);
  });

  it("enqueues blocked followup after successful bootstrap when blockedRunResume is present", async () => {
    const queueKey = "openclaw-test-bootstrap-resume";
    const blockedRunResume = BootstrapBlockedRunResumeSchema.parse({
      blockedRunId: "run-blocked-bootstrap-resume",
      queueKey,
      settings: { mode: "followup" },
      sourceRun: {
        prompt: "finish the document task",
        enqueuedAt: 0,
        run: {
          agentId: "agent-resume",
          agentDir: "/tmp/agent",
          sessionId: "sess-resume",
          sessionFile: "/tmp/sess-resume.jsonl",
          workspaceDir: "/tmp/ws-resume",
          config: {},
          provider: "test",
          model: "test-model",
          timeoutMs: 60_000,
          blockReplyBreak: "message_end",
        },
      },
    });
    const service = createBootstrapRequestService();
    installBootstrapContinuationNoop();
    const created = service.create(buildRequest({ blockedRunResume }));
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
            installMethod: "node",
            status: "available",
          },
        }),
      },
      availableBins: ["node"],
      runHealthCheckCommand: async () => true,
    });
    expect(getFollowupQueueDepth(queueKey)).toBe(1);
  });

  it("preserves blockedRunResume attached after bootstrap run starts", async () => {
    const queueKey = "openclaw-test-bootstrap-late-resume";
    const blockedRunResume = BootstrapBlockedRunResumeSchema.parse({
      blockedRunId: "run-late-bootstrap-resume",
      queueKey,
      settings: { mode: "followup" },
      sourceRun: {
        prompt: "finish after late attach",
        enqueuedAt: 0,
        run: {
          agentId: "agent-late-resume",
          agentDir: "/tmp/agent",
          sessionId: "sess-late-resume",
          sessionFile: "/tmp/sess-late-resume.jsonl",
          workspaceDir: "/tmp/ws-late-resume",
          config: {},
          provider: "test",
          model: "test-model",
          timeoutMs: 60_000,
          blockReplyBreak: "message_end",
        },
      },
    });
    const service = createBootstrapRequestService();
    installBootstrapContinuationNoop();
    const created = service.create(buildRequest());
    service.resolve(created.id, "approve");
    const runPromise = service.run({
      id: created.id,
      installers: {
        node: async () => {
          service.attachBlockedRunResume(created.id, blockedRunResume);
          return {
            ok: true,
            capability: {
              ...created.request.catalogEntry.capability,
              trusted: true,
              sandboxed: true,
              installMethod: "node",
              status: "available",
            },
          };
        },
      },
      availableBins: ["node"],
      runHealthCheckCommand: async () => true,
    });
    await runPromise;
    expect(service.get(created.id)?.request.blockedRunResume).toEqual(
      expect.objectContaining({
        blockedRunId: "run-late-bootstrap-resume",
        queueKey,
      }),
    );
    expect(getFollowupQueueDepth(queueKey)).toBe(1);
  });

  it("auto-approves and continues trusted unattended bootstrap lanes", async () => {
    const service = createBootstrapRequestService();
    getPlatformRuntimeCheckpointService().registerContinuationHandler(
      "bootstrap_run",
      async (checkpoint) => {
        await service.run({
          id: checkpoint.target?.bootstrapRequestId ?? checkpoint.id,
          installers: {
            node: async ({ request }) => ({
              ok: true,
              capability: {
                ...request.catalogEntry.capability,
                trusted: true,
                sandboxed: true,
                installMethod: "node",
                status: "available",
              },
            }),
          },
          availableBins: ["node"],
          runHealthCheckCommand: async () => true,
        });
      },
    );

    const created = service.create(
      buildRequest({
        installMethod: "builtin",
        executionContext: {
          profileId: "builder",
          recipeId: "doc_ingest",
          taskOverlayId: "document_first",
          intent: "document",
          requiredCapabilities: ["pdf-renderer"],
          bootstrapRequiredCapabilities: ["pdf-renderer"],
          requireExplicitApproval: false,
          policyAutonomy: "assist",
          readinessStatus: "bootstrap_required",
          unattendedBoundary: "bootstrap",
        },
      }),
    );

    expect(created.state).toBe("approved");
    await expect
      .poll(() => service.get(created.id)?.state, {
        timeout: 3_000,
        interval: 25,
      })
      .toBe("available");
    expect(getPlatformRuntimeCheckpointService().get(created.id)).toEqual(
      expect.objectContaining({
        status: "completed",
        continuation: expect.objectContaining({
          state: "completed",
        }),
      }),
    );
  });

  it("promotes an existing pending trusted bootstrap when a later unattended request reuses it", async () => {
    const service = createBootstrapRequestService();
    getPlatformRuntimeCheckpointService().registerContinuationHandler(
      "bootstrap_run",
      async (checkpoint) => {
        await service.run({
          id: checkpoint.target?.bootstrapRequestId ?? checkpoint.id,
          installers: {
            node: async ({ request }) => ({
              ok: true,
              capability: {
                ...request.catalogEntry.capability,
                trusted: true,
                sandboxed: true,
                installMethod: "node",
                status: "available",
              },
            }),
          },
          availableBins: ["node"],
          runHealthCheckCommand: async () => true,
        });
      },
    );

    const first = service.create(buildRequest());
    expect(first.state).toBe("pending");

    const resumed = service.create(
      buildRequest({
        executionContext: {
          profileId: "builder",
          recipeId: "doc_ingest",
          taskOverlayId: "document_first",
          intent: "document",
          requiredCapabilities: ["pdf-renderer"],
          bootstrapRequiredCapabilities: ["pdf-renderer"],
          requireExplicitApproval: false,
          policyAutonomy: "assist",
          readinessStatus: "bootstrap_required",
          unattendedBoundary: "bootstrap",
        },
      }),
    );

    expect(resumed.id).toBe(first.id);
    expect(resumed.state).toBe("approved");
    await expect
      .poll(() => service.get(first.id)?.state, {
        timeout: 3_000,
        interval: 25,
      })
      .toBe("available");
  });

  it("persists the bootstrap audit trail and rehydrates records after restart", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bootstrap-service-"));
    try {
      const service = createBootstrapRequestService({ stateDir });
      installBootstrapContinuationNoop();
      const created = service.create(buildRequest());
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
              installMethod: "node",
              status: "available",
            },
          }),
        },
        availableBins: ["node"],
        runHealthCheckCommand: async () => true,
      });

      expect(service.getAuditPath()).toMatch(/requests-audit\.jsonl$/);
      const next = createBootstrapRequestService({ stateDir });
      expect(next.rehydrate()).toBe(1);
      expect(next.get(created.id)).toEqual(
        expect.objectContaining({
          id: created.id,
          state: "available",
          result: expect.objectContaining({
            status: "bootstrapped",
          }),
        }),
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
