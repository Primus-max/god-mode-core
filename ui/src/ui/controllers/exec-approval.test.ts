import { describe, expect, it } from "vitest";
import { parseExecApprovalRequested } from "./exec-approval.ts";

describe("exec approval controller", () => {
  it("parses machine-control metadata for operator UI", () => {
    const parsed = parseExecApprovalRequested({
      id: "approval-1",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        command: "echo hi",
        host: "node",
        nodeId: "node-1",
        envKeys: ["A_VAR", "Z_VAR"],
        machineControl: {
          required: true,
          requestedByDeviceId: "dev-1",
          linkedAtMs: 3,
        },
      },
    });

    expect(parsed).toEqual({
      id: "approval-1",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        command: "echo hi",
        cwd: null,
        nodeId: "node-1",
        envKeys: ["A_VAR", "Z_VAR"],
        host: "node",
        security: null,
        ask: null,
        agentId: null,
        resolvedPath: null,
        sessionKey: null,
        runtimeRunId: null,
        runtimeCheckpointId: null,
        runtimeBoundary: null,
        blockedReason: null,
        machineControl: {
          required: true,
          requestedByDeviceId: "dev-1",
          linkedAtMs: 3,
        },
      },
    });
  });
});
