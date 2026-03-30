import { afterEach, describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  getPlatformRuntimeCheckpointService,
  resetPlatformRuntimeCheckpointService,
} from "../platform/runtime/index.js";
import { buildGatewaySessionRow, listSessionsFromStore } from "./session-utils.js";

afterEach(() => {
  resetPlatformRuntimeCheckpointService();
});

describe("gateway session recovery state", () => {
  test("buildGatewaySessionRow surfaces active closure recovery progress", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    const entry = {
      sessionId: "sess-recovery",
      updatedAt: 2_000,
      status: "blocked",
    } as SessionEntry;
    getPlatformRuntimeCheckpointService().createCheckpoint({
      id: "closure:run-recovery:auth_refresh:escalate",
      runId: "run-recovery",
      sessionKey: "agent:main:main",
      boundary: "exec_approval",
      blockedReason: "provider authentication refresh requires operator attention",
      target: {
        approvalId: "closure:run-recovery:auth_refresh:escalate",
        operation: "closure.recovery",
      },
      continuation: {
        kind: "closure_recovery",
        state: "idle",
        attempts: 1,
      },
    });

    const row = buildGatewaySessionRow({
      cfg,
      storePath: "/tmp/sessions.json",
      store: { "agent:main:main": entry },
      key: "agent:main:main",
      entry,
      recoveryCheckpoint:
        getPlatformRuntimeCheckpointService().list({ sessionKey: "agent:main:main" })[0],
    });

    expect(row.status).toBe("blocked");
    expect(row.recoveryCheckpointId).toBe("closure:run-recovery:auth_refresh:escalate");
    expect(row.recoveryStatus).toBe("blocked");
    expect(row.recoveryContinuationState).toBe("idle");
    expect(row.recoveryAttempts).toBe(1);
    expect(row.recoveryBlockedReason).toContain("authentication refresh");
    expect(row.recoveryOperatorHint).toContain("Awaiting operator approval");
    expect(row.handoffTruthSource).toBe("recovery");
    expect(row.handoffRequestRunId).toBe("run-recovery");
    expect(row.handoffRunId).toBe("run-recovery");
    expect(row.handoffHint).toContain("current handoff truth");
  });

  test("listSessionsFromStore treats resumed closure recovery as running session truth", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    const store = {
      "agent:main:main": {
        sessionId: "sess-recovery",
        updatedAt: 2_000,
        status: "blocked",
        runClosureSummary: {
          runId: "run-old",
          requestRunId: "request-old",
          sessionKey: "agent:main:main",
          updatedAtMs: 1_900,
          outcomeStatus: "partial",
          verificationStatus: "mismatch",
          acceptanceStatus: "retryable",
          action: "retry",
          remediation: "semantic_retry",
          reasonCode: "contract_mismatch",
          reasons: ["retry"],
        },
      } as SessionEntry,
    };
    getPlatformRuntimeCheckpointService().createCheckpoint({
      id: "closure:run-recovery:resume",
      runId: "run-recovery",
      sessionKey: "agent:main:main",
      boundary: "exec_approval",
      target: {
        approvalId: "closure:run-recovery:resume",
        operation: "closure.recovery",
      },
      continuation: {
        kind: "closure_recovery",
        state: "running",
        attempts: 2,
      },
    });
    getPlatformRuntimeCheckpointService().updateCheckpoint("closure:run-recovery:resume", {
      status: "resumed",
      resumedAtMs: 2_100,
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });
    const row = result.sessions.find((session) => session.key === "agent:main:main");

    expect(row?.status).toBe("running");
    expect(row?.recoveryStatus).toBe("resumed");
    expect(row?.recoveryContinuationState).toBe("running");
    expect(row?.recoveryAttempts).toBe(2);
    expect(row?.recoveryOperatorHint).toContain("dispatching");
    expect(row?.runClosureSummary?.runId).toBe("run-old");
    expect(row?.handoffTruthSource).toBe("recovery");
    expect(row?.handoffRequestRunId).toBe("request-old");
    expect(row?.handoffRunId).toBe("run-recovery");
    expect(row?.handoffHint).toContain("overrides durable closure run run-old");
  });
});
