import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, PluginHookName } from "../plugins/types.js";
import {
  listCapturedDeveloperArtifacts,
  resetCapturedDeveloperArtifacts,
} from "./developer/index.js";
import { listCapturedDocumentArtifacts, resetCapturedDocumentArtifacts } from "./document/index.js";
import platformProfilePlugin, { registerPlatformProfilePlugin } from "./plugin.js";

describe("platform profile plugin", () => {
  it("captures structured document artifacts from llm_output for document recipes", () => {
    resetCapturedDocumentArtifacts();
    const on = vi.fn();
    const api = { on } as unknown as OpenClawPluginApi;

    registerPlatformProfilePlugin(api);

    const llmOutput = on.mock.calls.find((call) => call[0] === "llm_output")?.[1] as
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
    resetCapturedDeveloperArtifacts();
    const on = vi.fn();
    const api = { on } as unknown as OpenClawPluginApi;

    registerPlatformProfilePlugin(api);

    const llmOutput = on.mock.calls.find((call) => call[0] === "llm_output")?.[1] as
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
    const on = vi.fn();
    const api = { on } as unknown as OpenClawPluginApi;

    registerPlatformProfilePlugin(api);

    expect(on.mock.calls.map((call) => call[0] as PluginHookName)).toEqual([
      "before_agent_start",
      "before_model_resolve",
      "before_prompt_build",
      "llm_output",
    ]);
  });

  it("exports an OpenClaw plugin definition", () => {
    expect(platformProfilePlugin.id).toBe("platform-profile-foundation");
    expect(typeof platformProfilePlugin.register).toBe("function");
  });

  it("injects profile guidance into prompt-building hook", () => {
    const on = vi.fn();
    const api = { on } as unknown as OpenClawPluginApi;

    registerPlatformProfilePlugin(api);

    const beforePromptBuild = on.mock.calls.find(
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
});
