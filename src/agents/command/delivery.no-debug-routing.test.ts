import { afterEach, describe, expect, it, vi } from "vitest";
import * as agentDeliveryModule from "../../infra/outbound/agent-delivery.js";
import * as channelResolutionModule from "../../infra/outbound/channel-resolution.js";
import * as deliverModule from "../../infra/outbound/deliver.js";
import { resetPlatformRuntimeCheckpointService } from "../../platform/runtime/index.js";
import { deliverAgentCommandResult } from "./delivery.js";

/**
 * G5 closure proof for PR-4a (Wave A) — see PR-4 sub-plan §5 row
 * "DEBUG ROUTING absent from reply" and anti-checklist §5.1.2:
 *
 *   "Snapshot-test одного reply-payload без `[DEBUG ROUTING]` достаточно
 *    для G5 closure только если он ассертит **отсутствие** подстроки и
 *    проходит на двух independent contexts (TG + Discord или dummy
 *    channel)."
 *
 * Этот файл специально выделен из общего `delivery.test.ts`, чтобы
 * закрытие G5 имело dedicated artifact и в CI и в audit log master plan
 * §0.5.3 (G5 closed by PR-4a <SHA>).
 */

afterEach(() => {
  vi.restoreAllMocks();
  resetPlatformRuntimeCheckpointService();
});

type DeliveryContextFixture = {
  readonly description: string;
  readonly channel: "telegram" | "discord";
  readonly to: string;
  readonly outboundSessionKey: string;
  readonly messageId: string;
  readonly payloadText: string;
};

const FIXTURES: readonly DeliveryContextFixture[] = [
  {
    description: "telegram",
    channel: "telegram",
    to: "telegram:123",
    outboundSessionKey: "agent:main:telegram:direct:123",
    messageId: "tg-no-debug-routing",
    payloadText: "TG answer payload",
  },
  {
    description: "discord",
    channel: "discord",
    to: "discord:guild:42:channel:777",
    outboundSessionKey: "agent:main:discord:guild:42:channel:777",
    messageId: "discord-no-debug-routing",
    payloadText: "Discord answer payload",
  },
];

describe("deliverAgentCommandResult — DEBUG ROUTING absence (G5)", () => {
  for (const fx of FIXTURES) {
    it(`does not include [DEBUG ROUTING] in ${fx.description} reply payload`, async () => {
      vi.spyOn(channelResolutionModule, "resolveOutboundChannelPlugin").mockReturnValue(
        {} as never,
      );
      vi.spyOn(agentDeliveryModule, "resolveAgentOutboundTarget").mockReturnValue({
        resolvedTarget: { ok: true, to: fx.to } as never,
        resolvedTo: fx.to,
        targetMode: "explicit",
      });
      const deliverSpy = vi.spyOn(deliverModule, "deliverOutboundPayloads");
      deliverSpy.mockResolvedValue([
        {
          channel: fx.channel,
          chatId: fx.to,
          messageId: fx.messageId,
        },
      ] as never);

      const result = await deliverAgentCommandResult({
        cfg: {} as never,
        deps: {} as never,
        runtime: {
          log: vi.fn(),
          error: vi.fn(),
        } as never,
        opts: {
          deliver: true,
          channel: fx.channel,
          to: fx.to,
        } as never,
        outboundSession: {
          key: fx.outboundSessionKey,
        } as never,
        sessionEntry: undefined,
        result: {
          meta: {
            agentMeta: {
              provider: "openai",
              model: "gpt-test",
            },
            modelFallback: {
              attempts: [
                {
                  provider: "openai",
                  model: "gpt-test",
                },
              ],
            },
          },
        } as never,
        payloads: [{ text: fx.payloadText }] as never,
      });

      const deliveredText = deliverSpy.mock.calls[0]?.[0]?.payloads?.[0]?.text;
      expect(deliveredText).toBe(fx.payloadText);
      expect(deliveredText).not.toContain("[DEBUG ROUTING]");
      expect(result.payloads[0]?.text).not.toContain("[DEBUG ROUTING]");
    });
  }
});
