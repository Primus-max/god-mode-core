import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDefaultBootstrapHealthCheckCommand, verifyCapabilityHealth } from "./health-check.js";

describe("bootstrap health checks", () => {
  let tempRoot = "";

  afterEach(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      tempRoot = "";
    }
  });

  it("runs simple health check commands through the default runner", async () => {
    const result = await runDefaultBootstrapHealthCheckCommand({
      capability: {
        id: "node-runtime",
        label: "Node Runtime",
        status: "available",
        trusted: true,
        requiredBins: ["node"],
        healthCheckCommand: "node --version",
      },
      command: "node --version",
    });

    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("rejects complex health check commands without an injected runner", async () => {
    const result = await verifyCapabilityHealth({
      capability: {
        id: "node-runtime",
        label: "Node Runtime",
        status: "available",
        trusted: true,
        requiredBins: ["node"],
        healthCheckCommand: "node --version && echo nope",
      },
      availableBins: ["node"],
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain(
      "health check command requires an injected runner: node --version && echo nope",
    );
  });

  it("resolves required bins from PATH when no availableBins override is provided", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bootstrap-health-"));
    const binDir = path.join(tempRoot, "bin");
    await fs.mkdir(binDir, { recursive: true });
    const shimName = process.platform === "win32" ? "bootstrap-node-smoke.cmd" : "bootstrap-node-smoke";
    await fs.writeFile(path.join(binDir, shimName), process.platform === "win32" ? "@echo off\n" : "", "utf-8");
    const originalPath = process.env.PATH;
    process.env.PATH = [binDir, originalPath].filter(Boolean).join(path.delimiter);

    try {
      const result = await verifyCapabilityHealth({
        capability: {
          id: "node-smoke",
          label: "Node Smoke",
          status: "available",
          trusted: true,
          requiredBins: ["bootstrap-node-smoke"],
        },
      });

      expect(result.ok).toBe(true);
      expect(result.reasons).toEqual([]);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
