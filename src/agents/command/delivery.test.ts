import { afterEach, describe, expect, it, vi } from "vitest";
import * as agentDeliveryModule from "../../infra/outbound/agent-delivery.js";
import * as channelResolutionModule from "../../infra/outbound/channel-resolution.js";
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

  it("bootstraps known outbound channels before validating delivery", async () => {
    vi.spyOn(channelResolutionModule, "resolveOutboundChannelPlugin").mockReturnValue({} as never);
    vi.spyOn(agentDeliveryModule, "resolveAgentOutboundTarget").mockReturnValue({
      resolvedTarget: { ok: true, to: "123" } as never,
      resolvedTo: "123",
      targetMode: "explicit",
    });
    const deliverSpy = vi.spyOn(deliverModule, "deliverOutboundPayloads");
    deliverSpy.mockResolvedValue([
      {
        channel: "telegram",
        chatId: "123",
        messageId: "m-3",
      },
    ] as never);

    await expect(
      deliverAgentCommandResult({
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
            durationMs: 1,
          },
        } as never,
        payloads: [
          {
            text: "PDF ready",
            mediaUrl: "file:///tmp/report.pdf",
            mediaUrls: ["file:///tmp/report.pdf"],
          },
        ] as never,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        payloads: [
          expect.objectContaining({
            mediaUrl: "file:///tmp/report.pdf",
            mediaUrls: ["file:///tmp/report.pdf"],
          }),
        ],
      }),
    );

    expect(deliverSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "123",
        payloads: [
          expect.objectContaining({
            mediaUrls: ["file:///tmp/report.pdf"],
          }),
        ],
      }),
    );
  });

  it("uses the same action id for repeated delivery attempts of the same run payload", async () => {
    vi.spyOn(channelResolutionModule, "resolveOutboundChannelPlugin").mockReturnValue({} as never);
    vi.spyOn(agentDeliveryModule, "resolveAgentOutboundTarget").mockReturnValue({
      resolvedTarget: { ok: true, to: "123" } as never,
      resolvedTo: "123",
      targetMode: "explicit",
    });
    const deliverSpy = vi.spyOn(deliverModule, "deliverOutboundPayloads");
    deliverSpy.mockResolvedValue([
      {
        channel: "telegram",
        chatId: "123",
        messageId: "m-4",
      },
    ] as never);

    const params = {
      cfg: {} as never,
      deps: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as never,
      opts: {
        runId: "run-dedupe",
        deliver: true,
        channel: "telegram",
        to: "telegram:123",
      } as never,
      outboundSession: {
        key: "agent:main:telegram:direct:123",
      } as never,
      sessionEntry: undefined,
      result: {
        meta: {},
      } as never,
      payloads: [{ text: "same payload" }] as never,
    } as const;

    await deliverAgentCommandResult(params);
    await deliverAgentCommandResult(params);

    expect(deliverSpy).toHaveBeenCalledTimes(2);
    expect(deliverSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        actionId: expect.stringMatching(/^messaging:run-dedupe:/),
      }),
    );
    expect(deliverSpy.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        actionId: deliverSpy.mock.calls[0]?.[0]?.actionId,
      }),
    );
  });
});
