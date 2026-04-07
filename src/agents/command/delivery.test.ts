import { afterEach, describe, expect, it, vi } from "vitest";
import * as deliverModule from "../../infra/outbound/deliver.js";
import {
  getPlatformRuntimeCheckpointService,
  resetPlatformRuntimeCheckpointService,
} from "../../platform/runtime/index.js";
import { deliverAgentCommandResult } from "./delivery.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetPlatformRuntimeCheckpointService();
});

describe("deliverAgentCommandResult", () => {
  it("correlates delivered replies with runtime actions and post-send closure truth", async () => {
    const runtimeService = getPlatformRuntimeCheckpointService();
    const deliverSpy = vi.spyOn(deliverModule, "deliverOutboundPayloads");
    deliverSpy.mockImplementation(async (params) => {
      runtimeService.stageAction({
        actionId: "messaging:test-delivery",
        runId: params.actionRunId,
        sessionKey: params.session?.key,
        kind: "messaging_delivery",
        target: {
          operation: "deliver",
        },
      });
      runtimeService.markActionAttempted("messaging:test-delivery", { retryable: true });
      runtimeService.markActionConfirmed("messaging:test-delivery", {
        receipt: {
          operation: "deliver",
          deliveryResults: [
            {
              channel: "telegram",
              chatId: "123",
              messageId: "m-1",
            },
          ],
        },
      });
      return [
        {
          channel: "telegram",
          chatId: "123",
          messageId: "m-1",
        },
      ] as never;
    });

    const result = await deliverAgentCommandResult({
      cfg: {} as never,
      deps: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as never,
      opts: {
        runId: "run-agent-delivery",
        deliver: true,
        channel: "telegram",
        to: "telegram:123",
      } as never,
      outboundSession: {
        key: "agent:main:main",
      } as never,
      sessionEntry: undefined,
      result: {
        meta: {
          completionOutcome: {
            runId: "run-agent-delivery",
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
      } as never,
      payloads: [{ text: "STAGE25_SMOKE_OK" }] as never,
    });

    expect(deliverSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        actionRunId: "run-agent-delivery",
      }),
    );
    expect(result.meta?.runClosure).toEqual(
      expect.objectContaining({
        runId: "run-agent-delivery",
        outcome: expect.objectContaining({
          actionIds: ["messaging:test-delivery"],
          confirmedActionIds: ["messaging:test-delivery"],
        }),
        executionVerification: expect.objectContaining({
          status: "verified",
          receipts: [
            expect.objectContaining({
              kind: "messaging_delivery",
              proof: "verified",
              status: "success",
            }),
          ],
        }),
      }),
    );
    expect(result.meta?.acceptanceOutcome).toEqual(
      expect.objectContaining({
        status: "satisfied",
      }),
    );
  });

  it("falls back to completion outcome run id when opts.runId is missing", async () => {
    const runtimeService = getPlatformRuntimeCheckpointService();
    const deliverSpy = vi.spyOn(deliverModule, "deliverOutboundPayloads");
    deliverSpy.mockImplementation(async (params) => {
      runtimeService.stageAction({
        actionId: "messaging:test-delivery-fallback",
        runId: params.actionRunId,
        sessionKey: params.session?.key,
        kind: "messaging_delivery",
        target: {
          operation: "deliver",
        },
      });
      runtimeService.markActionAttempted("messaging:test-delivery-fallback", { retryable: true });
      runtimeService.markActionConfirmed("messaging:test-delivery-fallback", {
        receipt: {
          operation: "deliver",
          deliveryResults: [
            {
              channel: "telegram",
              chatId: "123",
              messageId: "m-2",
            },
          ],
        },
      });
      return [
        {
          channel: "telegram",
          chatId: "123",
          messageId: "m-2",
        },
      ] as never;
    });

    const result = await deliverAgentCommandResult({
      cfg: {} as never,
      deps: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as never,
      opts: {
        deliver: true,
        channel: "telegram",
        to: "telegram:123",
      } as never,
      outboundSession: {
        key: "agent:main:telegram:direct:123",
      } as never,
      sessionEntry: undefined,
      result: {
        meta: {
          completionOutcome: {
            runId: "run-from-completion-outcome",
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
      } as never,
      payloads: [{ text: "STAGE86_TELEGRAM_DELIVERY_OK" }] as never,
    });

    expect(deliverSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        actionRunId: "run-from-completion-outcome",
      }),
    );
    expect(result.meta?.runClosure).toEqual(
      expect.objectContaining({
        runId: "run-from-completion-outcome",
        executionVerification: expect.objectContaining({
          status: "verified",
          receipts: [
            expect.objectContaining({
              kind: "messaging_delivery",
              proof: "verified",
            }),
          ],
        }),
      }),
    );
  });
});
