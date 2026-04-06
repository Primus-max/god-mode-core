import { describe, expect, it } from "vitest";
import type { RuntimeCheckpointSummary } from "../types.ts";
import { resolveBootstrapCheckpointUiPhase } from "./runtime-inspector.ts";

function baseCheckpoint(
  overrides: Partial<RuntimeCheckpointSummary>,
): RuntimeCheckpointSummary {
  return {
    id: "cp-1",
    runId: "run-1",
    boundary: "bootstrap",
    status: "blocked",
    createdAtMs: 1,
    updatedAtMs: 2,
    ...overrides,
  };
}

describe("resolveBootstrapCheckpointUiPhase", () => {
  it("returns null for non-bootstrap boundaries", () => {
    expect(
      resolveBootstrapCheckpointUiPhase(
        baseCheckpoint({ boundary: "exec_approval", status: "blocked" }),
      ),
    ).toBeNull();
  });

  it("maps blocked + bootstrap resolve to pending approval", () => {
    expect(
      resolveBootstrapCheckpointUiPhase(
        baseCheckpoint({
          status: "blocked",
          nextActions: [
            {
              method: "platform.bootstrap.resolve",
              label: "Approve",
              phase: "approve",
            },
          ],
        }),
      ),
    ).toBe("pending_approval");
  });

  it("maps approved + bootstrap run to pending run", () => {
    expect(
      resolveBootstrapCheckpointUiPhase(
        baseCheckpoint({
          status: "approved",
          nextActions: [
            {
              method: "platform.bootstrap.run",
              label: "Run",
              phase: "resume",
            },
          ],
        }),
      ),
    ).toBe("pending_run");
  });

  it("maps resumed + closure_recovery idle to resume dispatch", () => {
    expect(
      resolveBootstrapCheckpointUiPhase(
        baseCheckpoint({
          status: "resumed",
          continuation: { kind: "closure_recovery", state: "idle" },
        }),
      ),
    ).toBe("resume_dispatch");
  });

  it("maps resumed + closure_recovery completed to resume complete", () => {
    expect(
      resolveBootstrapCheckpointUiPhase(
        baseCheckpoint({
          status: "resumed",
          continuation: { kind: "closure_recovery", state: "completed" },
        }),
      ),
    ).toBe("resume_complete");
  });
});
