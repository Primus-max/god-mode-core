import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPlatformRuntimeCheckpointService,
  resetPlatformRuntimeCheckpointService,
} from "./index.js";

const tempDirs: string[] = [];

afterEach(() => {
  resetPlatformRuntimeCheckpointService();
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("platform runtime checkpoint service", () => {
  it("creates, updates, and persists checkpoints", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-checkpoints-"));
    tempDirs.push(stateDir);
    const service = createPlatformRuntimeCheckpointService({ stateDir });

    const blocked = service.createCheckpoint({
      id: "checkpoint-1",
      runId: "run-1",
      sessionKey: "session-1",
      boundary: "exec_approval",
      blockedReason: "approval required",
      nextActions: [{ method: "exec.approval.resolve", label: "Resolve approval", phase: "approve" }],
      target: { approvalId: "approval-1", operation: "system.run" },
    });
    expect(blocked.status).toBe("blocked");
    expect(service.findByApprovalId("approval-1")?.id).toBe("checkpoint-1");

    const approved = service.updateCheckpoint("checkpoint-1", {
      status: "approved",
      approvedAtMs: 123,
    });
    expect(approved?.status).toBe("approved");

    const next = createPlatformRuntimeCheckpointService({ stateDir });
    expect(next.rehydrate()).toBe(1);
    expect(next.get("checkpoint-1")).toEqual(
      expect.objectContaining({
        status: "approved",
        sessionKey: "session-1",
      }),
    );
  });
});
