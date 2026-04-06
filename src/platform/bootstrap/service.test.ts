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
    installMethod: "download",
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
        download: async ({ request }) => ({
          ok: true,
          capability: {
            ...request.catalogEntry.capability,
            trusted: true,
            sandboxed: true,
            installMethod: "download",
            status: "available",
          },
        }),
      },
      availableBins: ["playwright"],
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
    ).toEqual([
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
    ]);
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
        installMethod: "download" as const,
        status: "available" as const,
      },
    }));

    const first = await service.run({
      id: created.id,
      installers: {
        download: installer,
      },
      availableBins: ["playwright"],
      runHealthCheckCommand: async () => true,
    });
    const replay = await service.run({
      id: created.id,
      installers: {
        download: installer,
      },
      availableBins: ["playwright"],
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

  it("after approve, bootstrap continuation run dispatches blocked followup when blockedRunResume is set", async () => {
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
    getPlatformRuntimeCheckpointService().registerContinuationHandler("bootstrap_run", async (checkpoint) => {
      const id = checkpoint.target?.bootstrapRequestId ?? "";
      await service.run({
        id,
        installers: {
          download: async ({ request }) => ({
            ok: true,
            capability: {
              ...request.catalogEntry.capability,
              trusted: true,
              sandboxed: true,
              installMethod: "download",
              status: "available",
            },
          }),
        },
        availableBins: ["playwright"],
        runHealthCheckCommand: async () => true,
      });
    });
    const created = service.create(buildRequest({ blockedRunResume }));
    expect(created.state).toBe("pending");
    service.resolve(created.id, "approve");
    await expect
      .poll(() => getFollowupQueueDepth(queueKey), { timeout: 3_000, interval: 25 })
      .toBe(1);
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
        download: async ({ request }) => ({
          ok: true,
          capability: {
            ...request.catalogEntry.capability,
            trusted: true,
            sandboxed: true,
            installMethod: "download",
            status: "available",
          },
        }),
      },
      availableBins: ["playwright"],
      runHealthCheckCommand: async () => true,
    });
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
            download: async ({ request }) => ({
              ok: true,
              capability: {
                ...request.catalogEntry.capability,
                trusted: true,
                sandboxed: true,
                installMethod: "download",
                status: "available",
              },
            }),
          },
          availableBins: ["playwright"],
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
          download: async ({ request }) => ({
            ok: true,
            capability: {
              ...request.catalogEntry.capability,
              trusted: true,
              sandboxed: true,
              installMethod: "download",
              status: "available",
            },
          }),
        },
        availableBins: ["playwright"],
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
