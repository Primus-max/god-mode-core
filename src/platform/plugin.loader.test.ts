import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { clearPluginLoaderCache, loadOpenClawPlugins } from "../plugins/loader.js";
import { withEnv } from "../test-utils/env.js";
import { resetPlatformArtifactService } from "./artifacts/index.js";
import { resetPlatformBootstrapService } from "./bootstrap/index.js";
import { resetPlatformMachineControlService } from "./machine/index.js";

describe("platform bundled plugin wiring", () => {
  afterEach(() => {
    clearPluginLoaderCache();
    resetGlobalHookRunner();
    resetPlatformArtifactService();
    resetPlatformBootstrapService();
    resetPlatformMachineControlService();
  });

  it.skip("loads the bundled platform profile foundation plugin through the plugin loader", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-loader-"));
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

    try {
      const registry = withEnv(
        {
          OPENCLAW_TEST_FAST: "1",
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(repoRoot, "extensions"),
        },
        () =>
          loadOpenClawPlugins({
            cache: false,
            config: cfg,
            env: {
              ...process.env,
              VITEST: "1",
            },
            onlyPluginIds: ["platform-profile-foundation"],
            throwOnLoadError: true,
          }),
      );

      const plugin = registry.plugins.find((entry) => entry.id === "platform-profile-foundation");
      expect(plugin?.origin).toBe("bundled");
      expect(plugin?.status).toBe("loaded");
      expect(plugin?.hookCount).toBe(7);
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
          "llm_input",
          "before_tool_call",
          "llm_output",
        ]),
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
