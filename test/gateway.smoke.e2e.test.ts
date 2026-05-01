import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { GatewayClient } from "../src/gateway/client.js";
import { connectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../src/utils/message-channel.js";
import {
  type ChatEventPayload,
  type GatewayInstance,
  connectNode,
  extractFirstTextBlock,
  postJson,
  spawnGatewayInstance,
  stopGatewayInstance,
  waitForChatFinalEvent,
  waitForNodeStatus,
} from "./helpers/gateway-e2e-harness.js";

const E2E_TIMEOUT_MS = 90_000;

describe("gateway smoke e2e", () => {
  const instances: GatewayInstance[] = [];
  const nodeClients: GatewayClient[] = [];
  const chatClients: GatewayClient[] = [];

  afterAll(async () => {
    for (const client of nodeClients) {
      client.stop();
    }
    for (const client of chatClients) {
      client.stop();
    }
    for (const inst of instances) {
      await stopGatewayInstance(inst);
    }
  });

  it(
    "boots one gateway and proves HTTP, node pairing, and chat roundtrip",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const gateway = await spawnGatewayInstance("smoke");
      instances.push(gateway);

      const hookRes = await postJson(
        `http://127.0.0.1:${gateway.port}/hooks/wake`,
        {
          text: "wake smoke",
          mode: "now",
        },
        { "x-openclaw-token": gateway.hookToken },
      );
      expect(hookRes.status).toBe(200);
      expect((hookRes.json as { ok?: boolean } | undefined)?.ok).toBe(true);

      const node = await connectNode(gateway, "node-smoke");
      nodeClients.push(node.client);
      await waitForNodeStatus(gateway, node.nodeId);

      const chatEvents: ChatEventPayload[] = [];
      const chatClient = await connectGatewayClient({
        url: `ws://127.0.0.1:${gateway.port}`,
        token: gateway.gatewayToken,
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        clientDisplayName: "chat-smoke-cli",
        clientVersion: "1.0.0",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.CLI,
        onEvent: (evt) => {
          if (evt.event === "chat" && evt.payload && typeof evt.payload === "object") {
            chatEvents.push(evt.payload as ChatEventPayload);
          }
        },
      });
      chatClients.push(chatClient);

      const sessionKey = "agent:main:telegram:direct:123456";
      const sendRes = await chatClient.request<{ runId?: string; status?: string }>("chat.send", {
        sessionKey,
        message: "/context list",
        idempotencyKey: `smoke-${randomUUID()}`,
      });
      expect(sendRes.status).toBe("started");
      expect(typeof sendRes.runId).toBe("string");

      const finalEvent = await waitForChatFinalEvent({
        events: chatEvents,
        runId: String(sendRes.runId),
        sessionKey,
        timeoutMs: 30_000,
      });
      const finalText = extractFirstTextBlock(finalEvent.message);
      expect(typeof finalText).toBe("string");
      expect(finalText?.length).toBeGreaterThan(0);
    },
  );
});
