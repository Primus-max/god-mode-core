import { describe, expect, it } from "vitest";
import { runDefaultBootstrapHealthCheckCommand, verifyCapabilityHealth } from "./health-check.js";

describe("bootstrap health checks", () => {
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
});
