import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getPlatformRuntimeCheckpointService,
  resetPlatformRuntimeCheckpointService,
} from "../../platform/runtime/index.js";
import {
  loadRunOverflowCompactionHarness,
  mockedEnsureRuntimePluginsLoaded,
  mockedRunEmbeddedAttempt,
} from "./run.overflow-compaction.harness.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

describe("runEmbeddedPiAgent usage reporting", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    mockedEnsureRuntimePluginsLoaded.mockReset();
    mockedRunEmbeddedAttempt.mockReset();
  });

  afterEach(() => {
    resetPlatformRuntimeCheckpointService();
  });

  it("bootstraps runtime plugins with the resolved workspace before running", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce({
      aborted: false,
      promptError: null,
      timedOut: false,
      sessionIdUsed: "test-session",
      assistantTexts: ["Response 1"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-plugin-bootstrap",
    });

    expect(mockedEnsureRuntimePluginsLoaded).toHaveBeenCalledWith({
      config: undefined,
      workspaceDir: "/tmp/workspace",
    });
  });

  it("forwards gateway subagent binding opt-in to runtime plugin bootstrap", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce({
      aborted: false,
      promptError: null,
      timedOut: false,
      sessionIdUsed: "test-session",
      assistantTexts: ["Response 1"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-gateway-bind",
      allowGatewaySubagentBinding: true,
    });

    expect(mockedEnsureRuntimePluginsLoaded).toHaveBeenCalledWith({
      config: undefined,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        allowGatewaySubagentBinding: true,
      }),
    );
  });

  it("forwards sender identity fields into embedded attempts", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce({
      aborted: false,
      promptError: null,
      timedOut: false,
      sessionIdUsed: "test-session",
      assistantTexts: ["Response 1"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-sender-forwarding",
      senderId: "user-123",
      senderName: "Josh Lehman",
      senderUsername: "josh",
      senderE164: "+15551234567",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        senderId: "user-123",
        senderName: "Josh Lehman",
        senderUsername: "josh",
        senderE164: "+15551234567",
      }),
    );
  });

  it("forwards memory flush write paths into memory-triggered attempts", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce({
      aborted: false,
      promptError: null,
      timedOut: false,
      sessionIdUsed: "test-session",
      assistantTexts: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "flush",
      timeoutMs: 30000,
      runId: "run-memory-forwarding",
      trigger: "memory",
      memoryFlushWritePath: "memory/2026-03-10.md",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "memory",
        memoryFlushWritePath: "memory/2026-03-10.md",
      }),
    );
  });

  it("reports total usage from the last turn instead of accumulated total", async () => {
    // Simulate a multi-turn run result.
    // Turn 1: Input 100, Output 50. Total 150.
    // Turn 2: Input 150, Output 50. Total 200.

    // The accumulated usage (attemptUsage) will be the sum:
    // Input: 100 + 150 = 250 (Note: runEmbeddedAttempt actually returns accumulated usage)
    // Output: 50 + 50 = 100
    // Total: 150 + 200 = 350

    // The last assistant usage (lastAssistant.usage) will be Turn 2:
    // Input: 150, Output 50, Total 200.

    // We expect result.meta.agentMeta.usage.total to be 200 (last turn total).
    // The bug causes it to be 350 (accumulated total).

    mockedRunEmbeddedAttempt.mockResolvedValueOnce({
      aborted: false,
      promptError: null,
      timedOut: false,
      sessionIdUsed: "test-session",
      assistantTexts: ["Response 1", "Response 2"],
      lastAssistant: {
        usage: { input: 150, output: 50, total: 200 },
        stopReason: "end_turn",
      },
      attemptUsage: { input: 250, output: 100, total: 350 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const result = await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-1",
    });

    // Check usage in meta
    const usage = result.meta.agentMeta?.usage;
    expect(usage).toBeDefined();

    // Check if total matches the last turn's total (200)
    // If the bug exists, it will likely be 350
    expect(usage?.total).toBe(200);
  });

  it("attaches machine-checkable completion outcome from runtime checkpoints", async () => {
    getPlatformRuntimeCheckpointService().createCheckpoint({
      id: "checkpoint-run-outcome",
      runId: "run-outcome",
      boundary: "exec_approval",
      target: { approvalId: "approval-run-outcome", operation: "system.run" },
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce({
      aborted: false,
      promptError: null,
      timedOut: false,
      sessionIdUsed: "test-session",
      assistantTexts: ["Response 1"],
      didSendDeterministicApprovalPrompt: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const result = await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-outcome",
    });

    expect(result.meta.completionOutcome).toEqual(
      expect.objectContaining({
        status: "blocked",
        checkpointIds: ["checkpoint-run-outcome"],
        pendingApprovalIds: ["approval-run-outcome"],
        deterministicApprovalPromptSent: true,
      }),
    );
    expect(result.meta.acceptanceOutcome).toEqual(
      expect.objectContaining({
        status: "needs_human",
        action: "escalate",
        reasonCode: "pending_approval",
      }),
    );
  });
});
