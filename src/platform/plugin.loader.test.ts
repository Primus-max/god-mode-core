import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { clearPluginLoaderCache, loadOpenClawPlugins } from "../plugins/loader.js";

describe("platform bundled plugin wiring", () => {
  afterEach(() => {
    clearPluginLoaderCache();
    resetGlobalHookRunner();
  });

  it("loads the bundled platform profile foundation plugin through the plugin loader", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const cfg: OpenClawConfig = {
      plugins: {
        enabled: true,
        slots: { memory: "none" },
        entries: {
          "platform-profile-foundation": {
            enabled: true,
          },
        },
      },
    };

    const registry = loadOpenClawPlugins({
      cache: false,
      config: cfg,
      env: {
        ...process.env,
        VITEST: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(repoRoot, "extensions"),
      },
      onlyPluginIds: ["platform-profile-foundation"],
      throwOnLoadError: true,
    });

    const plugin = registry.plugins.find((entry) => entry.id === "platform-profile-foundation");
    expect(plugin?.origin).toBe("bundled");
    expect(plugin?.status).toBe("loaded");
    expect(plugin?.hookCount).toBe(5);
    expect(
      registry.typedHooks
        .filter((entry) => entry.pluginId === "platform-profile-foundation")
        .map((entry) => entry.hookName),
    ).toEqual(
      expect.arrayContaining([
        "before_agent_start",
        "before_model_resolve",
        "before_prompt_build",
        "gateway_start",
        "llm_output",
      ]),
    );
  });
});
