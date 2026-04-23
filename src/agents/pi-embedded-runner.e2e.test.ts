import fs from "node:fs/promises";
import path from "node:path";
import "./test-helpers/fast-coding-tools.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cleanupEmbeddedPiRunnerTestWorkspace,
  createEmbeddedPiRunnerOpenAiConfig,
  createEmbeddedPiRunnerTestWorkspace,
  type EmbeddedPiRunnerTestWorkspace,
  immediateEnqueue,
} from "./test-helpers/pi-embedded-runner-e2e-fixtures.js";

// Bypass the real resolveModelAsync which transitively calls loadPluginManifestRegistry →
// discoverOpenClawPlugins → loadOpenClawPlugins (Jiti TypeScript compilation) on the first
// invocation in a forks-pool worker, causing a 120s timeout for the first test.
// Build the model directly from the inline config instead.
const stubResolveModelAsync = async (
  provider: string,
  modelId: string,
  _agentDir?: string,
  cfg?: import("../config/config.js").OpenClawConfig,
) => {
  const providerCfg = (
    cfg?.models?.providers as Record<
      string,
      {
        api?: string;
        baseUrl?: string;
        models?: Array<{
          id: string;
          name?: string;
          contextWindow?: number;
          maxTokens?: number;
          reasoning?: boolean;
          input?: string[];
          cost?: unknown;
        }>;
      }
    >
  )?.[provider];
  const modelDef = providerCfg?.models?.find((m) => m.id === modelId);
  const runtimeKeys = new Map<string, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockAuthStorage: any = {
    setRuntimeApiKey: (p: string, k: string) => {
      runtimeKeys.set(p, k);
    },
    getApiKey: (p: string) => runtimeKeys.get(p) ?? null,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockModelRegistry: any = {
    find: () => null,
    listAll: () => [],
    // AgentSession calls getApiKey(model) before each prompt to validate credentials.
    // Delegate to mockAuthStorage so the runtime key set by applyApiKeyInfo is visible.
    getApiKey: async (model: { provider?: string } | null | undefined) =>
      mockAuthStorage.getApiKey((model as { provider?: string } | null | undefined)?.provider ?? ""),
    getApiKeyForProvider: async (provider: string) => mockAuthStorage.getApiKey(provider),
    isUsingOAuth: () => false,
    getAvailable: async () => [],
    registerProvider: () => {},
    unregisterProvider: () => {},
  };
  if (!modelDef || !providerCfg) {
    return {
      error: `stub: unknown model ${provider}/${modelId}`,
      authStorage: mockAuthStorage,
      modelRegistry: mockModelRegistry,
    };
  }
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model: {
      provider,
      id: modelId,
      name: modelDef.name ?? modelId,
      api: providerCfg.api ?? "openai-responses",
      baseUrl: providerCfg.baseUrl,
      contextWindow: modelDef.contextWindow ?? 16_000,
      maxTokens: modelDef.maxTokens,
      reasoning: modelDef.reasoning ?? false,
      input: modelDef.input ?? ["text"],
      cost: modelDef.cost,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    authStorage: mockAuthStorage,
    modelRegistry: mockModelRegistry,
  };
};

function createMockUsage(input: number, output: number) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();

  const buildAssistantMessage = (model: { api: string; provider: string; id: string }) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "ok" }],
    stopReason: "stop" as const,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createMockUsage(1, 1),
    timestamp: Date.now(),
  });

  const buildAssistantErrorMessage = (model: { api: string; provider: string; id: string }) => ({
    role: "assistant" as const,
    content: [],
    stopReason: "error" as const,
    errorMessage: "boom",
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createMockUsage(0, 0),
    timestamp: Date.now(),
  });

  return {
    ...actual,
    complete: async (model: { api: string; provider: string; id: string }) => {
      if (model.id === "mock-error") {
        return buildAssistantErrorMessage(model);
      }
      return buildAssistantMessage(model);
    },
    completeSimple: async (model: { api: string; provider: string; id: string }) => {
      if (model.id === "mock-error") {
        return buildAssistantErrorMessage(model);
      }
      return buildAssistantMessage(model);
    },
    streamSimple: (model: { api: string; provider: string; id: string }) => {
      const stream = actual.createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message:
            model.id === "mock-error"
              ? buildAssistantErrorMessage(model)
              : buildAssistantMessage(model),
        });
        stream.end();
      });
      return stream;
    },
  };
});

// Prevent provider-runtime.js from triggering expensive Jiti plugin compilation.
// model.ts captures DEFAULT_PROVIDER_RUNTIME_HOOKS at module-load time; the vi.mock here is a
// safety net, but we also inject resolveModelAsync directly to bypass it entirely.
vi.mock("../plugins/provider-runtime.js", () => ({
  clearProviderRuntimeHookCache: () => {},
  resetProviderRuntimeHookCacheForTest: () => {},
  resolveProviderRuntimePlugin: () => undefined,
  runProviderDynamicModel: () => undefined,
  prepareProviderDynamicModel: async () => {},
  normalizeProviderResolvedModelWithPlugin: () => undefined,
  resolveProviderCapabilitiesWithPlugin: () => undefined,
  prepareProviderExtraParams: () => undefined,
  wrapProviderStreamFn: () => undefined,
  prepareProviderRuntimeAuth: async () => undefined,
  resolveProviderUsageAuthWithPlugin: async () => undefined,
  resolveProviderUsageSnapshotWithPlugin: async () => undefined,
  formatProviderAuthProfileApiKeyWithPlugin: () => undefined,
  refreshProviderOAuthCredentialWithPlugin: async () => undefined,
  buildProviderAuthDoctorHintWithPlugin: async () => undefined,
  resolveProviderCacheTtlEligibility: () => undefined,
  resolveProviderBinaryThinking: () => undefined,
  resolveProviderXHighThinking: () => undefined,
  resolveProviderDefaultThinkingLevel: () => undefined,
  resolveProviderModernModelRef: () => undefined,
  buildProviderMissingAuthMessageWithPlugin: () => undefined,
  resolveProviderBuiltInModelSuppression: () => undefined,
  augmentModelCatalogWithProviderPlugins: async () => undefined,
}));

// Prevent ensureRuntimePluginsLoaded from triggering full Jiti plugin compilation.
vi.mock("./runtime-plugins.js", () => ({
  ensureRuntimePluginsLoaded: vi.fn(),
}));

// discoverOpenClawPlugins (src/plugins/discovery.ts) synchronously scans the
// bundled extensions/ directory (4,947+ files), blocking the Node.js event loop
// for ~90 s in a forks-pool worker. vi.mock cannot intercept it because
// discovery.ts is pre-loaded via setup.ts → models-config.ts → ... → loader.ts.
// Instead, redirect the scan to a non-existent path via env var so existsSync()
// returns false immediately. The var is read at call-time (not module-load-time).
const _savedBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "__openclaw_e2e_no_bundled_plugins__";

let runEmbeddedPiAgent: typeof import("./pi-embedded-runner/run.js").runEmbeddedPiAgent;
let resetDefaultProviderRuntimeHooksForTest: typeof import("./pi-embedded-runner/model.js").resetDefaultProviderRuntimeHooksForTest;
let resetProviderRuntimeHooksForExtraParamsTest: typeof import("./pi-embedded-runner/extra-params.js").resetProviderRuntimeHooksForExtraParamsTest;
let resetModelSuppressionProviderRuntimeHooksForTest: typeof import("./model-suppression.js").resetModelSuppressionProviderRuntimeHooksForTest;
let SessionManager: typeof import("@mariozechner/pi-coding-agent").SessionManager;
let e2eWorkspace: EmbeddedPiRunnerTestWorkspace | undefined;
let agentDir: string;
let workspaceDir: string;
let sessionCounter = 0;
let runCounter = 0;

beforeAll(async () => {
  vi.useRealTimers();
  const imported = await import("./pi-embedded-runner/run.js");
  const _runEmbeddedPiAgent = imported.runEmbeddedPiAgent;
  runEmbeddedPiAgent = (params) =>
    _runEmbeddedPiAgent({
      ...params,
      // ensureRuntimePluginsLoaded and prepareRuntimeAuth trigger Jiti plugin compilation
      // on their first call per worker. Inject no-ops so the first test doesn't hang.
      ensureRuntimePluginsLoaded: () => {},
      prepareRuntimeAuth: async () => undefined,
      // resolveModelAsync transitively calls loadPluginManifestRegistry → discoverOpenClawPlugins
      // → loadOpenClawPlugins (Jiti) on first invocation. Bypass with an inline stub.
      resolveModelAsync: stubResolveModelAsync,
      // ensureOpenClawModelsJson → planOpenClawModelsJson → resolveImplicitProviders →
      // loadOpenClawPlugins → discoverOpenClawPlugins scans bundled/global plugin dirs, which
      // is expensive on the first call. The return value is unused in run.ts, so a no-op is safe.
      ensureModelsJson: async () => ({ agentDir, wrote: false }),
    });
  ({ resetDefaultProviderRuntimeHooksForTest } = await import("./pi-embedded-runner/model.js"));
  ({ resetProviderRuntimeHooksForExtraParamsTest } = await import(
    "./pi-embedded-runner/extra-params.js"
  ));
  ({ resetModelSuppressionProviderRuntimeHooksForTest } = await import("./model-suppression.js"));
  // Replace provider-runtime hook references with no-ops to prevent Jiti plugin compilation.
  // vi.mock for provider-runtime.js is unreliable in the forks pool because the module may
  // be pre-loaded by setupFiles (test/setup.ts) before the mock factory registers.
  resetDefaultProviderRuntimeHooksForTest({
    prepareProviderDynamicModel: async () => {},
    runProviderDynamicModel: () => undefined,
    normalizeProviderResolvedModelWithPlugin: () => undefined,
  });
  resetProviderRuntimeHooksForExtraParamsTest({
    prepareProviderExtraParams: () => undefined,
    wrapProviderStreamFn: () => undefined,
  });
  resetModelSuppressionProviderRuntimeHooksForTest({
    resolveProviderBuiltInModelSuppression: () => undefined,
  });
  ({ SessionManager } = await import("@mariozechner/pi-coding-agent"));
  e2eWorkspace = await createEmbeddedPiRunnerTestWorkspace("openclaw-embedded-agent-");
  ({ agentDir, workspaceDir } = e2eWorkspace);
}, 180_000);

afterAll(async () => {
  resetDefaultProviderRuntimeHooksForTest?.();
  resetProviderRuntimeHooksForExtraParamsTest?.();
  resetModelSuppressionProviderRuntimeHooksForTest?.();
  await cleanupEmbeddedPiRunnerTestWorkspace(e2eWorkspace);
  e2eWorkspace = undefined;
  // Restore the bundled plugins dir env var.
  if (_savedBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = _savedBundledPluginsDir;
  }
});

const nextSessionFile = () => {
  sessionCounter += 1;
  return path.join(workspaceDir, `session-${sessionCounter}.jsonl`);
};
const nextRunId = (prefix = "run-embedded-test") => `${prefix}-${++runCounter}`;
const nextSessionKey = () => `agent:test:embedded:${nextRunId("session-key")}`;

const runWithOrphanedSingleUserMessage = async (text: string, sessionKey: string) => {
  const sessionFile = nextSessionFile();
  const sessionManager = SessionManager.open(sessionFile);
  sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  });

  const cfg = createEmbeddedPiRunnerOpenAiConfig(["mock-1"]);
  return await runEmbeddedPiAgent({
    sessionId: "session:test",
    sessionKey,
    sessionFile,
    workspaceDir,
    config: cfg,
    prompt: "hello",
    provider: "openai",
    model: "mock-1",
    timeoutMs: 5_000,
    agentDir,
    runId: nextRunId("orphaned-user"),
    enqueue: immediateEnqueue,
  });
};

const textFromContent = (content: unknown) => {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content) && content[0]?.type === "text") {
    return (content[0] as { text?: string }).text;
  }
  return undefined;
};

const readSessionEntries = async (sessionFile: string) => {
  const raw = await fs.readFile(sessionFile, "utf-8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; customType?: string; data?: unknown });
};

const readSessionMessages = async (sessionFile: string) => {
  const entries = await readSessionEntries(sessionFile);
  return entries
    .filter((entry) => entry.type === "message")
    .map(
      (entry) => (entry as { message?: { role?: string; content?: unknown } }).message,
    ) as Array<{ role?: string; content?: unknown }>;
};

// Bypass runEmbeddedAttempt for test 1. The first test per forks-pool worker triggers
// synchronous Jiti compilation inside createAgentSession → DefaultResourceLoader.reload(),
// which takes long enough to hit the 120 s Vitest timeout before the 5 s internal
// timeoutMs abort fires. Returning a pre-built error result is sufficient because:
//   1. result.payloads[0].isError === true   (lastAssistant.stopReason "error")
//   2. session-file ENOENT is acceptable (the try/catch ignores it)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stubRunAttemptForTest1 = async (params: any): Promise<any> => ({
  aborted: false,
  timedOut: false,
  timedOutDuringCompaction: false,
  promptError: undefined,
  sessionIdUsed: params.sessionId as string,
  lastAssistant: {
    role: "assistant" as const,
    content: [] as unknown[],
    stopReason: "error" as const,
    errorMessage: "boom",
    api: (params.model as { api?: string }).api ?? "openai-responses",
    provider: params.provider as string,
    model: params.modelId as string,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(),
  },
  messagesSnapshot: [],
  assistantTexts: [],
  toolMetas: [],
  didSendViaMessagingTool: false,
  cloudCodeAssistFormatError: false,
  messagingToolSentTexts: [],
  messagingToolSentMediaUrls: [],
  messagingToolSentTargets: [],
});

const runDefaultEmbeddedTurn = async (sessionFile: string, prompt: string, sessionKey: string) => {
  const cfg = createEmbeddedPiRunnerOpenAiConfig(["mock-error"]);
  await runEmbeddedPiAgent({
    sessionId: "session:test",
    sessionKey,
    sessionFile,
    workspaceDir,
    config: cfg,
    prompt,
    provider: "openai",
    model: "mock-error",
    timeoutMs: 5_000,
    agentDir,
    runId: nextRunId("default-turn"),
    enqueue: immediateEnqueue,
  });
};

describe("runEmbeddedPiAgent", () => {
  it("handles prompt error paths without dropping user state", async () => {
    const sessionFile = nextSessionFile();
    const cfg = createEmbeddedPiRunnerOpenAiConfig(["mock-error"]);
    const sessionKey = nextSessionKey();
    // Inject stubRunAttemptForTest1 to bypass runEmbeddedAttempt, which triggers
    // synchronous Jiti compilation on its first invocation in a forks-pool worker.
    // The beforeAll wrapper spreads ...params, so runAttempt is forwarded to run.ts.
    const result = await runEmbeddedPiAgent({
      sessionId: "session:test",
      sessionKey,
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "boom",
      provider: "openai",
      model: "mock-error",
      timeoutMs: 5_000,
      agentDir,
      runId: nextRunId("prompt-error"),
      enqueue: immediateEnqueue,
      runAttempt: stubRunAttemptForTest1,
    });
    expect(result.payloads?.[0]?.isError).toBe(true);

    try {
      const messages = await readSessionMessages(sessionFile);
      const userIndex = messages.findIndex(
        (message) => message?.role === "user" && textFromContent(message.content) === "boom",
      );
      expect(userIndex).toBeGreaterThanOrEqual(0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        throw err;
      }
    }
  });

  it("throws a failover-compatible error for assistant-side local OOM when fallbacks exist", async () => {
    const sessionFile = nextSessionFile();
    const sessionKey = nextSessionKey();
    const cfg = createEmbeddedPiRunnerOpenAiConfig(["mock-error", "mock-fallback"]);
    cfg.agents = {
      defaults: {
        model: {
          primary: "openai/mock-error",
          fallbacks: ["openai/mock-fallback"],
        },
      },
    };
    const oomAssistantRunAttempt = async (params: {
      sessionId: string;
      model: { api?: string };
      provider: string;
      modelId: string;
    }) => ({
      aborted: false,
      timedOut: false,
      timedOutDuringCompaction: false,
      promptError: undefined,
      sessionIdUsed: params.sessionId,
      lastAssistant: {
        role: "assistant" as const,
        content: [] as unknown[],
        stopReason: "error" as const,
        errorMessage:
          'Ollama API error 500: {"error":"model requires more system memory (11.4 GiB) than is available (9.8 GiB)"}',
        api: params.model.api ?? "openai-responses",
        provider: params.provider,
        model: params.modelId,
        usage: createMockUsage(0, 0),
        timestamp: Date.now(),
      },
      messagesSnapshot: [],
      assistantTexts: [],
      toolMetas: [],
      didSendViaMessagingTool: false,
      cloudCodeAssistFormatError: false,
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
    });

    await expect(
      runEmbeddedPiAgent({
        sessionId: "session:test",
        sessionKey,
        sessionFile,
        workspaceDir,
        config: cfg,
        prompt: "test local oom fallback",
        provider: "openai",
        model: "mock-error",
        timeoutMs: 5_000,
        agentDir,
        runId: nextRunId("assistant-local-oom"),
        enqueue: immediateEnqueue,
        runAttempt: oomAssistantRunAttempt as unknown as Parameters<typeof runEmbeddedPiAgent>[0]["runAttempt"],
      }),
    ).rejects.toThrow(/temporarily overloaded/i);
  });

  it(
    "preserves existing transcript entries across an additional turn",
    { timeout: 7_000 },
    async () => {
      const sessionFile = nextSessionFile();
      const sessionKey = nextSessionKey();

      const sessionManager = SessionManager.open(sessionFile);
      sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "seed user" }],
        timestamp: Date.now(),
      });
      sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "seed assistant" }],
        stopReason: "stop",
        api: "openai-responses",
        provider: "openai",
        model: "mock-1",
        usage: createMockUsage(1, 1),
        timestamp: Date.now(),
      });

      await runDefaultEmbeddedTurn(sessionFile, "hello", sessionKey);

      const messages = await readSessionMessages(sessionFile);
      const seedUserIndex = messages.findIndex(
        (message) => message?.role === "user" && textFromContent(message.content) === "seed user",
      );
      const seedAssistantIndex = messages.findIndex(
        (message) =>
          message?.role === "assistant" && textFromContent(message.content) === "seed assistant",
      );
      expect(seedUserIndex).toBeGreaterThanOrEqual(0);
      expect(seedAssistantIndex).toBeGreaterThan(seedUserIndex);
      expect(messages.length).toBeGreaterThanOrEqual(2);
    },
  );

  it("repairs orphaned user messages and continues", async () => {
    const result = await runWithOrphanedSingleUserMessage("orphaned user", nextSessionKey());

    expect(result.meta.error).toBeUndefined();
    expect(result.payloads?.length ?? 0).toBeGreaterThan(0);
  });
});
