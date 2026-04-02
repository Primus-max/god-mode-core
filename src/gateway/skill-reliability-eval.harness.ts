import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store.js";
import { captureEnv } from "../test-utils/env.js";
import { connectGatewayClient, disconnectGatewayClient, getFreeGatewayPort } from "./test-helpers.e2e.js";
import {
  type MockOpenAiResponsesDecision,
  type MockOpenAiResponsesRequest,
  installOpenAiResponsesMock,
} from "./test-helpers.openai-mock.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";
import { startGatewayServer } from "./server.js";

/** Final JSON payload from `agent` RPC after `expectFinal: true` (second respond frame). */
export type SkillEvalAgentFinalPayload = {
  status?: string;
  summary?: string;
  runId?: string;
  result?: {
    payloads?: Array<{ text?: string }>;
  };
};

export type SkillEvalRunResult<TContext> = {
  context: TContext;
  finalPayload: SkillEvalAgentFinalPayload;
  requests: MockOpenAiResponsesRequest[];
};

export type SkillEvalMultiTurnResult<TContext> = {
  context: TContext;
  finalPayloads: SkillEvalAgentFinalPayload[];
  requests: MockOpenAiResponsesRequest[];
};

let skillEvalSeq = 0;

function nextSkillEvalId(prefix: string) {
  return `${prefix}-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}-${skillEvalSeq++}`;
}

async function rmTempHomeWithRetry(dir: string): Promise<void> {
  const maxAttempts = 8;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === "EBUSY" || code === "EPERM") && attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

export function skillEvalAssistantText(payload: SkillEvalAgentFinalPayload): string {
  const parts =
    payload.result?.payloads?.map((p) => p.text?.trim() ?? "").filter(Boolean) ?? [];
  return parts.join("\n\n").trim();
}

async function runAgentEvalOnce(params: {
  client: Awaited<ReturnType<typeof connectGatewayClient>>;
  sessionKey: string;
  message: string;
  timeoutMs: number;
}): Promise<SkillEvalAgentFinalPayload> {
  const finalPayload = await params.client.request<SkillEvalAgentFinalPayload>(
    "agent",
    {
      sessionKey: params.sessionKey,
      idempotencyKey: `idem-${nextSkillEvalId("skill-agent")}`,
      message: params.message,
      deliver: false,
    },
    { expectFinal: true, timeoutMs: params.timeoutMs },
  );
  if (finalPayload.status !== "ok") {
    throw new Error(
      `skill eval agent failed: status=${String(finalPayload.status)} summary=${String(finalPayload.summary)}`,
    );
  }
  return finalPayload;
}

/**
 * One user message through real gateway `agent` RPC + embedded loop with a mocked OpenAI `/responses` stream.
 */
export async function runSkillEval<TContext>(params: {
  message: string;
  timeoutMs?: number;
  setupWorkspace: (workspaceDir: string) => Promise<TContext>;
  resolveResponse: (
    request: MockOpenAiResponsesRequest,
    context: TContext,
  ) => MockOpenAiResponsesDecision | Promise<MockOpenAiResponsesDecision>;
}): Promise<SkillEvalRunResult<TContext>> {
  const timeoutMs = params.timeoutMs ?? 20_000;
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
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-eval-home-"));
  const workspaceDir = path.join(tempHome, "openclaw");
  const configDir = path.join(tempHome, ".openclaw");
  const configPath = path.join(configDir, "openclaw.json");
  const token = nextSkillEvalId("skill-token");

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

  const context = await params.setupWorkspace(workspaceDir);
  const { baseUrl: openaiBaseUrl, requests, restore } = installOpenAiResponsesMock({
    resolveResponse: (request) => params.resolveResponse(request, context),
  });
  const mockProvider = buildMockOpenAiResponsesProvider(openaiBaseUrl);
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
  const server = await startGatewayServer(port, {
    bind: "loopback",
    auth: { mode: "token", token },
    controlUiEnabled: false,
  });
  const client = await connectGatewayClient({
    url: `ws://127.0.0.1:${port}`,
    token,
    clientDisplayName: "vitest-skill-evals",
    disableTickWatch: true,
  });

  try {
    const sessionKey = "agent:dev:skill-reliability-eval";
    const finalPayload = await runAgentEvalOnce({
      client,
      sessionKey,
      message: params.message,
      timeoutMs,
    });
    return { context, finalPayload, requests };
  } finally {
    await disconnectGatewayClient(client);
    await server.close({ reason: "skill eval test complete" });
    await rmTempHomeWithRetry(tempHome);
    restore();
    envSnapshot.restore();
  }
}

/**
 * Sequential `agent` turns on one session (history must reach the mock via `allInputText` / `lastUserText`).
 */
export async function runSkillEvalTurns<TContext>(params: {
  turns: readonly string[];
  timeoutMs?: number;
  setupWorkspace: (workspaceDir: string) => Promise<TContext>;
  resolveResponse: (
    request: MockOpenAiResponsesRequest,
    context: TContext,
  ) => MockOpenAiResponsesDecision | Promise<MockOpenAiResponsesDecision>;
}): Promise<SkillEvalMultiTurnResult<TContext>> {
  const timeoutMs = params.timeoutMs ?? 20_000;
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
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-eval-mturn-"));
  const workspaceDir = path.join(tempHome, "openclaw");
  const configDir = path.join(tempHome, ".openclaw");
  const configPath = path.join(configDir, "openclaw.json");
  const token = nextSkillEvalId("skill-mturn-token");

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

  const context = await params.setupWorkspace(workspaceDir);
  const { baseUrl: openaiBaseUrl, requests, restore } = installOpenAiResponsesMock({
    resolveResponse: (request) => params.resolveResponse(request, context),
  });
  const mockProvider = buildMockOpenAiResponsesProvider(openaiBaseUrl);
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
  const server = await startGatewayServer(port, {
    bind: "loopback",
    auth: { mode: "token", token },
    controlUiEnabled: false,
  });
  const client = await connectGatewayClient({
    url: `ws://127.0.0.1:${port}`,
    token,
    clientDisplayName: "vitest-skill-evals-mturn",
    disableTickWatch: true,
  });

  const finalPayloads: SkillEvalAgentFinalPayload[] = [];
  const sessionKey = "agent:dev:skill-reliability-eval-mturn";

  try {
    for (const message of params.turns) {
      const finalPayload = await runAgentEvalOnce({
        client,
        sessionKey,
        message,
        timeoutMs,
      });
      finalPayloads.push(finalPayload);
    }
    return { context, finalPayloads, requests };
  } finally {
    await disconnectGatewayClient(client);
    await server.close({ reason: "skill eval multi-turn complete" });
    await rmTempHomeWithRetry(tempHome);
    restore();
    envSnapshot.restore();
  }
}
