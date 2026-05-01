import fs from "node:fs/promises";
import path from "node:path";
import { applyCliProfileEnv } from "../src/cli/profile.ts";
import { loadConfig } from "../src/config/config.js";
import { resolveGatewayConnection } from "../src/tui/gateway-chat.ts";
import { resolveGatewayConnectionAuth } from "../src/gateway/connection-auth.ts";
import { GatewayClient } from "../src/gateway/client.js";
import { GATEWAY_CLIENT_NAMES, GATEWAY_CLIENT_MODES } from "../src/utils/message-channel.js";
import { GATEWAY_CLIENT_CAPS } from "../src/gateway/protocol/client-info.js";
import { PROTOCOL_VERSION } from "../src/gateway/protocol/index.js";

async function main() {
  const scenario = process.argv[2];
  const outputPath = process.argv[3];
  const message = process.argv[4];
  if (!scenario || !outputPath || !message) {
    throw new Error("usage: node --import tsx scripts/tmp-live-gateway-smoke.mjs <scenario> <outputPath> <message>");
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const progressPath = `${outputPath}.progress.log`;
  const logProgress = async (line) => {
    await fs.appendFile(progressPath, `${new Date().toISOString()} ${line}\n`, "utf-8");
  };
  await logProgress(`start scenario=${scenario}`);

  const profile = (process.env.OPENCLAW_PROFILE ?? "dev").trim().toLowerCase() || "dev";
  applyCliProfileEnv({ profile });
  await logProgress(
    `profile=${profile} stateDir=${process.env.OPENCLAW_STATE_DIR ?? ""} configPath=${process.env.OPENCLAW_CONFIG_PATH ?? ""}`,
  );
  const cfg = loadConfig();
  const auth = await resolveGatewayConnectionAuth({
    config: cfg,
    env: process.env,
  });
  await logProgress(
    `resolved auth token=${auth.token ? "yes" : "no"} password=${auth.password ? "yes" : "no"} mode=${cfg.gateway?.auth?.mode ?? "auto"}`,
  );
  const conn = await resolveGatewayConnection({
    url: "ws://127.0.0.1:19001",
    ...(auth.token ? { token: auth.token } : {}),
    ...(auth.password ? { password: auth.password } : {}),
  });
  await logProgress(`resolved connection url=${conn.url}`);
  const events = [];
  let resolveHello;
  const hello = new Promise((resolve) => {
    resolveHello = resolve;
  });

  const client = new GatewayClient({
    url: conn.url,
    token: conn.token,
    password: conn.password,
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: "openclaw-smoke",
    clientVersion: "dev",
    platform: process.platform,
    mode: GATEWAY_CLIENT_MODES.UI,
    caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS],
    instanceId: `${scenario}-${Date.now()}`,
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    onHelloOk: () => resolveHello(),
    onEvent: (evt) => events.push(evt),
  });

  client.start();
  try {
    await hello;
    await logProgress("hello ok");
    const runId = `${scenario}-${Date.now()}`;
    const sessionKey = `smoke:${scenario}:${Date.now()}`;
    const start = await client.request("chat.send", {
      sessionKey,
      message,
      idempotencyKey: runId,
    });
    await logProgress(`chat.send ok runId=${runId} sessionKey=${sessionKey}`);
    const deadline = Date.now() + 150_000;
    let finalEvent = null;
    while (Date.now() < deadline) {
      finalEvent =
        events.find(
          (evt) => evt.event === "chat" && evt.payload?.state === "final" && evt.payload?.runId === runId,
        ) ?? null;
      if (finalEvent) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await logProgress(`final event ${finalEvent ? "present" : "missing"}`);
    const history = await client.request("chat.history", { sessionKey, limit: 12 });
    await logProgress("history ok");
    await fs.writeFile(
      outputPath,
      JSON.stringify(
        {
          scenario,
          runId,
          sessionKey,
          start,
          final: finalEvent?.payload ?? null,
          eventsSeen: events.length,
          history,
        },
        null,
        2,
      ),
      "utf-8",
    );
    await logProgress("result written");
  } finally {
    client.stop();
    await logProgress("client stopped");
  }
}

main().catch(async (err) => {
  const outputPath = process.argv[3];
  if (outputPath) {
    await fs.writeFile(
      outputPath,
      JSON.stringify(
        {
          error: String(err),
          stack: err instanceof Error ? err.stack : null,
        },
        null,
        2,
      ),
      "utf-8",
    );
  }
  console.error(err);
  process.exit(1);
});
