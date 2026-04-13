import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePlatformBootstrapNodeCapabilityInstallDir } from "../bootstrap/index.js";
import { resolvePdfPlaywrightModuleUrl } from "./pdf-materializer.js";

describe("resolvePdfPlaywrightModuleUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers the managed pdf-renderer install when present", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pdf-renderer-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const installDir = resolvePlatformBootstrapNodeCapabilityInstallDir({
      capabilityId: "pdf-renderer",
      stateDir,
    });
    await fs.mkdir(installDir, { recursive: true });
    await fs.writeFile(
      path.join(installDir, "package.json"),
      JSON.stringify({
        name: "playwright-core",
        version: "1.58.2",
        exports: {
          ".": {
            import: "./index.mjs",
          },
        },
      }),
      "utf8",
    );
    await fs.writeFile(path.join(installDir, "index.mjs"), "export const chromium = {};\n", "utf8");
    await fs.writeFile(
      path.join(installDir, ".openclaw-bootstrap-healthcheck.cjs"),
      "process.stdout.write('ok\\n');\n",
      "utf8",
    );

    try {
      const resolved = resolvePdfPlaywrightModuleUrl();
      expect(fileURLToPath(resolved)).toBe(path.join(installDir, "index.mjs"));
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("falls back to the workspace playwright-core package when no managed install exists", () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(os.tmpdir(), "openclaw-pdf-renderer-missing"));
    const resolved = resolvePdfPlaywrightModuleUrl();
    expect(fileURLToPath(resolved)).toMatch(
      /node_modules[\\/]+playwright-core[\\/]+index\.(?:mjs|js)$/u,
    );
  });
});
