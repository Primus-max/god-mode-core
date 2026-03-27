import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ReplyDispatcher } from "./reply/reply-dispatcher.js";
import { buildTestCtx } from "./reply/test-ctx.js";

const finalizeMessagingDeliveryClosureMock = vi.fn();
const dispatchReplyFromConfigMock = vi.fn();

vi.mock("./reply/agent-runner-helpers.js", async () => {
  const actual = await vi.importActual<typeof import("./reply/agent-runner-helpers.js")>(
    "./reply/agent-runner-helpers.js",
  );
  return {
    ...actual,
    finalizeMessagingDeliveryClosure: (params: unknown) =>
      finalizeMessagingDeliveryClosureMock(params),
  };
});
vi.mock("./reply/dispatch-from-config.js", () => ({
  dispatchReplyFromConfig: (params: unknown) => dispatchReplyFromConfigMock(params),
}));

describe("dispatchInboundMessage delivery closure", () => {
  it("finalizes messaging delivery closure after dispatcher receipts are available", async () => {
    finalizeMessagingDeliveryClosureMock.mockReset();
    dispatchReplyFromConfigMock.mockReset();
    vi.resetModules();
    dispatchReplyFromConfigMock.mockResolvedValue({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
      deliveryCandidate: {
        runResult: {
          meta: {
            completionOutcome: {
              runId: "run-dispatch-closure",
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
          },
        },
        sourceRun: {
          prompt: "finish",
          enqueuedAt: Date.now(),
          run: {
            agentId: "main",
            agentDir: "/tmp",
            sessionId: "session-1",
            sessionKey: "main",
            sessionFile: "/tmp/session.jsonl",
            workspaceDir: "/tmp",
            config: {},
            provider: "anthropic",
            model: "claude",
            timeoutMs: 1_000,
            blockReplyBreak: "message_end",
          },
        },
        queueKey: "main",
        settings: { mode: "followup", debounceMs: 0, cap: 20 },
      },
      routedDeliveryReceipt: {
        stagedReplyCount: 1,
        attemptedDeliveryCount: 0,
        confirmedDeliveryCount: 0,
        failedDeliveryCount: 0,
        partialDelivery: false,
      },
    });
    const dispatcher: ReplyDispatcher = {
      sendToolResult: () => true,
      sendBlockReply: () => true,
      sendFinalReply: () => true,
      getQueuedCounts: () => ({ tool: 0, block: 0, final: 1 }),
      getDeliveryStats: () => ({
        attemptedDeliveryCount: 1,
        confirmedDeliveryCount: 0,
        failedDeliveryCount: 1,
      }),
      markComplete: () => {},
      waitForIdle: async () => {},
    };

    const { dispatchInboundMessage } = await import("./dispatch.js");
    await dispatchInboundMessage({
      ctx: buildTestCtx(),
      cfg: {} as OpenClawConfig,
      dispatcher,
      replyResolver: async () => ({ text: "ok" }),
    });

    expect(finalizeMessagingDeliveryClosureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate: expect.objectContaining({
          queueKey: "main",
        }),
        deliveryReceipt: expect.objectContaining({
          attemptedDeliveryCount: 1,
          confirmedDeliveryCount: 0,
          failedDeliveryCount: 1,
        }),
      }),
    );
  });
});
