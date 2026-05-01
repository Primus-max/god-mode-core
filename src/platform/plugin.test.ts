import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, PluginHookName } from "../plugins/types.js";
import { resetPlatformArtifactService } from "./artifacts/index.js";
import {
  listCapturedDeveloperArtifacts,
  resetCapturedDeveloperArtifacts,
} from "./developer/index.js";
import { listCapturedDocumentArtifacts, resetCapturedDocumentArtifacts } from "./document/index.js";
import {
  getPlatformMachineControlService,
  resetPlatformMachineControlService,
} from "./machine/index.js";
import platformProfilePlugin, { registerPlatformProfilePlugin } from "./plugin.js";

function createApiMock(): OpenClawPluginApi {
  return {
    id: "platform-profile-foundation",
    name: "Platform Profile Foundation",
    source: "test",
    registrationMode: "full",
    config: {
      plugins: {
        enabled: true,
        slots: { memory: "none" },
      },
    },
    runtime: {} as never,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    on: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerGatewayMethod: vi.fn(),
  } as unknown as OpenClawPluginApi;
}

describe("platform profile plugin", () => {
  const tempDirs: string[] = [];
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;

  afterEach(() => {
    resetCapturedDocumentArtifacts();
    resetCapturedDeveloperArtifacts();
    resetPlatformArtifactService();
    resetPlatformMachineControlService();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("captures structured document artifacts from llm_output for document recipes", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-platform-plugin-doc-"));
    tempDirs.push(stateDir);
    const api = createApiMock();
    api.config = {
      ...api.config,
      gateway: { port: 18789 },
    };
    process.env.OPENCLAW_STATE_DIR = stateDir;

    registerPlatformProfilePlugin(api);

    const llmOutput = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === "llm_output",
    )?.[1] as
      | ((
          event: { runId: string; sessionId: string; assistantTexts: string[] },
          ctx: unknown,
        ) => void)
      | undefined;

    llmOutput?.(
      {
        runId: "run-1",
        sessionId: "session-1",
        assistantTexts: ['{"type":"report","format":"markdown","content":"# Summary"}'],
      },
      {
        platformExecution: {
          profileId: "builder",
          recipeId: "doc_ingest",
        },
      },
    );

    expect(listCapturedDocumentArtifacts()).toHaveLength(1);
  });

  it("captures structured developer artifacts from llm_output for publish recipes", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-platform-plugin-dev-"));
    tempDirs.push(stateDir);
    const api = createApiMock();
    api.config = {
      ...api.config,
      gateway: { port: 18789 },
    };
    process.env.OPENCLAW_STATE_DIR = stateDir;

    registerPlatformProfilePlugin(api);

    const llmOutput = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === "llm_output",
    )?.[1] as
      | ((
          event: { runId: string; sessionId: string; assistantTexts: string[] },
          ctx: unknown,
        ) => void)
      | undefined;

    llmOutput?.(
      {
        runId: "run-2",
        sessionId: "session-2",
        assistantTexts: [
          '{"route":"code_build_publish","artifacts":[{"type":"preview","target":"vercel","url":"https://preview.example.com","summary":"Preview deployed"}]}',
        ],
      },
      {
        platformExecution: {
          profileId: "developer",
          recipeId: "code_build_publish",
        },
      },
    );

    expect(listCapturedDeveloperArtifacts()).toHaveLength(1);
  });

  it("registers the expected Stage 1 hooks", () => {
    const api = createApiMock();

    registerPlatformProfilePlugin(api);

    expect(
      (api.on as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as PluginHookName),
    ).toEqual([
      "before_agent_start",
      "before_model_resolve",
      "before_prompt_build",
      "gateway_start",
      "llm_input",
      "before_tool_call",
      "llm_output",
    ]);
    expect(api.registerHttpRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/platform/artifacts",
        match: "prefix",
      }),
    );
    expect(
      (api.registerGatewayMethod as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]),
    ).toEqual([
      "platform.artifacts.list",
      "platform.artifacts.get",
      "platform.artifacts.transition",
      "platform.bootstrap.list",
      "platform.bootstrap.get",
      "platform.bootstrap.resolve",
      "platform.bootstrap.run",
      "platform.recipes.list",
      "platform.recipes.get",
      "platform.capabilities.list",
      "platform.capabilities.get",
      "platform.runtime.actions.list",
      "platform.runtime.actions.get",
      "platform.runtime.checkpoints.list",
      "platform.runtime.checkpoints.get",
      "platform.runtime.checkpoints.dispatch",
      "platform.runtime.closures.list",
      "platform.runtime.closures.get",
      "platform.machine.status",
      "platform.machine.link",
      "platform.machine.unlink",
      "platform.machine.setKillSwitch",
      "platform.profile.resolve",
    ]);
  });

  it("exports an OpenClaw plugin definition", () => {
    expect(platformProfilePlugin.id).toBe("platform-profile-foundation");
    expect(typeof platformProfilePlugin.register).toBe("function");
  });

  it.skip("injects profile guidance into prompt-building hook", () => {
    const api = createApiMock();

    registerPlatformProfilePlugin(api);

    const beforePromptBuild = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === "before_prompt_build",
    )?.[1] as
      | ((event: {
          prompt: string;
          messages: unknown[];
        }) => { prependSystemContext?: string } | void)
      | undefined;

    const result = beforePromptBuild?.({
      prompt: "Fix the failing TypeScript tests",
      messages: [],
    });
    expect(result?.prependSystemContext).toContain("Active specialist profile");
    expect(result?.prependSystemContext).toContain("Execution recipe:");
    expect(result?.prependSystemContext).toContain("hidden permissions");
  });

  it.skip("reuses pre-resolved execution context in model and prompt hooks", () => {
    const api = createApiMock();

    registerPlatformProfilePlugin(api);

    const beforeModelResolve = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === "before_model_resolve",
    )?.[1] as
      | ((
          event: { prompt: string },
          ctx: {
            platformExecution?: {
              profileId: string;
              recipeId: string;
              providerOverride?: string;
              modelOverride?: string;
              requestedToolNames?: string[];
            };
          },
        ) => { providerOverride?: string; modelOverride?: string } | void)
      | undefined;
    const beforePromptBuild = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === "before_prompt_build",
    )?.[1] as
      | ((
          event: { prompt: string; messages: unknown[] },
          ctx: {
            platformExecution?: {
              profileId: string;
              recipeId: string;
              requestedToolNames?: string[];
              prependSystemContext?: string;
            };
          },
        ) => { prependSystemContext?: string } | void)
      | undefined;
    const beforeAgentStart = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === "before_agent_start",
    )?.[1] as
      | ((
          event: { prompt: string; messages?: unknown[] },
          ctx: {
            platformExecution?: {
              profileId: string;
              recipeId: string;
              prependContext?: string;
            };
          },
        ) => { prependContext?: string } | void)
      | undefined;

    expect(
      beforeModelResolve?.(
        { prompt: "Tell me a joke." },
        {
          platformExecution: {
            profileId: "developer",
            recipeId: "code_build_publish",
            providerOverride: "openai",
            modelOverride: "gpt-5.4",
          },
        },
      ),
    ).toEqual({
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
    });
    expect(
      beforePromptBuild?.(
        { prompt: "Tell me a joke.", messages: [] },
        {
          platformExecution: {
            profileId: "developer",
            recipeId: "code_build_publish",
            requestedToolNames: ["exec", "apply_patch"],
            prependSystemContext: "Execution recipe: code_build_publish.",
          },
        },
      )?.prependSystemContext,
    ).toContain("Execution recipe: code_build_publish.");
    expect(
      beforePromptBuild?.(
        { prompt: "Tell me a joke.", messages: [] },
        {
          platformExecution: {
            profileId: "developer",
            recipeId: "code_build_publish",
            requestedToolNames: ["exec", "apply_patch"],
            prependSystemContext: "Execution recipe: code_build_publish.",
          },
        },
      )?.prependSystemContext,
    ).toContain("Planned tools: exec, apply_patch.");
    expect(
      beforeAgentStart?.(
        { prompt: "Tell me a joke.", messages: [] },
        {
          platformExecution: {
            profileId: "developer",
            recipeId: "code_build_publish",
            prependContext: "Profile: Developer.\nPlanner reasoning: repo-first.",
          },
        },
      ),
    ).toEqual({
      prependContext: "Profile: Developer.\nPlanner reasoning: repo-first.",
    });
  });

  it.skip("records llm_input runs and blocks machine exec when kill switch is on", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-platform-plugin-machine-"));
    tempDirs.push(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const api = createApiMock();

    registerPlatformProfilePlugin(api);

    const llmInput = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === "llm_input",
    )?.[1] as
      | ((event: { runId: string; sessionId: string; prompt: string }, ctx: unknown) => void)
      | undefined;
    const beforeToolCall = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === "before_tool_call",
    )?.[1] as
      | ((
          event: { toolName: string; params: Record<string, unknown> },
          ctx: { runId?: string },
        ) => { block?: boolean; blockReason?: string } | void)
      | undefined;

    llmInput?.(
      {
        runId: "run-machine-1",
        sessionId: "session-machine-1",
        prompt: "Run a command on the linked machine",
      },
      {
        platformExecution: {
          profileId: "developer",
          recipeId: "general_reasoning",
        },
      },
    );
    getPlatformMachineControlService().setKillSwitch({ enabled: true, reason: "operator stop" });

    const result = beforeToolCall?.(
      {
        toolName: "exec",
        params: { host: "node", command: "echo hi" },
      },
      { runId: "run-machine-1" },
    );
    expect(result).toEqual(
      expect.objectContaining({
        block: true,
      }),
    );
    expect(result?.blockReason).toContain("kill switch");
  });
});
