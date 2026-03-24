import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, PluginHookName } from "../plugins/types.js";
import platformProfilePlugin, { registerPlatformProfilePlugin } from "./plugin.js";

describe("platform profile plugin", () => {
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
