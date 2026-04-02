import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeSkill } from "./src/agents/skills.e2e-test-helpers.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "./src/config/config.js";
import { clearSessionStoreCacheForTest } from "./src/config/sessions/store.js";
import { captureEnv } from "./src/test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "./src/utils/message-channel.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getFreeGatewayPort,
} from "./src/gateway/test-helpers.e2e.js";
import { installOpenAiResponsesMock } from "./src/gateway/test-helpers.openai-mock.js";
import { buildMockOpenAiResponsesProvider } from "./src/gateway/test-openai-responses-model.js";
import { startGatewayServer } from "./src/gateway/server.js";

const envSnapshot = captureEnv([
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
]);

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-debug-"));
const workspaceDir = path.join(tempHome, "openclaw");
const configDir = path.join(tempHome, ".openclaw");
const configPath = path.join(configDir, "openclaw.json");
const token = `debug-token-${process.pid}`;

process.env.HOME = tempHome;
process.env.OPENCLAW_STATE_DIR = path.join(tempHome, ".openclaw");
delete process.env.OPENCLAW_CONFIG_PATH;
process.env.OPENCLAW_GATEWAY_TOKEN = token;
process.env.OPENCLAW_SKIP_CHANNELS = "1";
process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
process.env.OPENCLAW_SKIP_CRON = "1";
process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";

await fs.mkdir(workspaceDir, { recursive: true });
await fs.mkdir(configDir, { recursive: true });
console.log("workspace ready");

const skillDir = path.join(workspaceDir, "skills", "garden-journal");
await writeSkill({
  dir: skillDir,
  name: "garden-journal",
  description: "Track plants, watering, and seasonal garden notes.",
  body: "# Garden Journal\n",
});
console.log("skill written");

const mock = installOpenAiResponsesMock({
  resolveResponse: (request) => {
    console.log("mock request", request.requestIndex, request.lastUserText, request.instructions.length);
    return { type: "message", text: "4" };
  },
});
const mockProvider = buildMockOpenAiResponsesProvider(mock.baseUrl);
const cfg = {
  agents: {
    defaults: {
      workspace: workspaceDir,
      model: { primary: mockProvider.modelRef },
      models: {
        [mockProvider.modelRef]: {
          params: {
            transport: "sse",
            openaiWsWarmup: false,
          },
        },
      },
    },
  },
  models: {
    mode: "replace",
    providers: {
      [mockProvider.providerId]: mockProvider.config,
    },
  },
  gateway: { auth: { token } },
};

await fs.writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
process.env.OPENCLAW_CONFIG_PATH = configPath;
clearRuntimeConfigSnapshot();
clearConfigCache();
clearSessionStoreCacheForTest();
const port = await getFreeGatewayPort();
console.log("starting server", port);
const server = await startGatewayServer(port, {
  bind: "loopback",
  auth: { mode: "token", token },
  controlUiEnabled: false,
});
console.log("server started");

const cli = await connectGatewayClient({
  url: `ws://127.0.0.1:${port}`,
  token,
  clientName: GATEWAY_CLIENT_NAMES.CLI,
  clientDisplayName: "debug-cli",
  clientVersion: "1.0.0",
  platform: "test",
  mode: GATEWAY_CLIENT_MODES.CLI,
  onEvent: (evt) => {
    if (evt.event === "chat") {
      console.log("chat event", JSON.stringify(evt.payload));
    }
  },
});
console.log("cli connected");

const node = await connectGatewayClient({
  url: `ws://127.0.0.1:${port}`,
  token,
  clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
  clientDisplayName: "debug-node",
  clientVersion: "1.0.0",
  platform: "test",
  mode: GATEWAY_CLIENT_MODES.NODE,
  role: "node",
  scopes: [],
  caps: ["system"],
  commands: ["system.run"],
});
console.log("node connected");

for (let i = 0; i < 20; i += 1) {
  const list = await cli.request("node.list", {});
  console.log("node.list", JSON.stringify(list));
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const started = await cli.request(
  "agent",
  {
    sessionKey: "agent:dev:debug-skill-eval",
    idempotencyKey: `idem-${Date.now()}`,
    message: "What is 2 + 2?",
    deliver: false,
  },
  { expectFinal: true, timeoutMs: 20000 },
);
console.log("agent result", JSON.stringify(started));

await disconnectGatewayClient(node);
await disconnectGatewayClient(cli);
await server.close({ reason: "debug complete" });
await fs.rm(tempHome, { recursive: true, force: true });
mock.restore();
envSnapshot.restore();
console.log("done");
