/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderExecApprovalPrompt } from "./exec-approval.ts";

describe("exec approval view", () => {
  it("renders machine-control metadata for node approvals", async () => {
    const container = document.createElement("div");

    render(
      renderExecApprovalPrompt({
        execApprovalQueue: [
          {
            id: "approval-1",
            createdAtMs: Date.now(),
            expiresAtMs: Date.now() + 5_000,
            request: {
              command: "echo hi",
              host: "node",
              nodeId: "node-1",
              envKeys: ["A_VAR", "Z_VAR"],
              machineControl: {
                required: true,
                requestedByDeviceId: "dev-1",
                linkedAtMs: 1_700_000_000_000,
              },
            },
          },
        ],
        execApprovalBusy: false,
        execApprovalError: null,
        handleExecApprovalDecision: vi.fn(),
      } as never),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("machine control");
    expect(container.textContent).toContain("explicitly linked device");
    expect(container.textContent).toContain("dev-1");
    expect(container.textContent).toContain("node-1");
    expect(container.textContent).toContain("A_VAR, Z_VAR");
    expect(container.textContent).toContain("2023-11-14T22:13:20.000Z");
  });
});
