import { describe, expect, it } from "vitest";
import type { PlatformRuntimeCheckpointSummary } from "./contracts.js";
import { deriveRecoveryOperatorHint } from "./recovery-operator-hint.js";

function baseSummary(
  overrides: Partial<PlatformRuntimeCheckpointSummary>,
): PlatformRuntimeCheckpointSummary {
  return {
    id: "cp-1",
    runId: "run-1",
    boundary: "exec_approval",
    status: "blocked",
    createdAtMs: 1,
    updatedAtMs: 2,
    target: { approvalId: "a1", operation: "closure.recovery" },
    ...overrides,
  };
}

describe("deriveRecoveryOperatorHint", () => {
  it("returns undefined for non-recovery checkpoints", () => {
    expect(
      deriveRecoveryOperatorHint(
        baseSummary({ target: { approvalId: "a1", operation: "system.run" } }),
      ),
    ).toBeUndefined();
  });

  it("describes blocked approval wait", () => {
    expect(deriveRecoveryOperatorHint(baseSummary({ status: "blocked" }))).toContain(
      "Awaiting operator approval",
    );
  });

  it("describes resumed running continuation", () => {
    expect(
      deriveRecoveryOperatorHint(
        baseSummary({
          status: "resumed",
          continuation: { kind: "closure_recovery", state: "running", attempts: 1 },
        }),
      ),
    ).toContain("dispatching");
  });

  it("describes cancelled recovery with error", () => {
    expect(
      deriveRecoveryOperatorHint(
        baseSummary({
          status: "cancelled",
          continuation: {
            kind: "closure_recovery",
            state: "failed",
            lastError: "enqueue failed",
          },
        }),
      ),
    ).toContain("enqueue failed");
  });
});
