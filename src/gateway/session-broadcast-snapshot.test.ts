import { describe, expect, it } from "vitest";
import { buildGatewaySessionBroadcastSnapshot } from "./session-broadcast-snapshot.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

describe("buildGatewaySessionBroadcastSnapshot", () => {
  const baseRow: GatewaySessionRow = {
    key: "agent:main:main",
    kind: "direct",
    updatedAt: 1_700_000_000,
    sessionId: "sess-1",
    channel: "webchat",
    label: "Main",
    displayName: "Main display",
    status: "running",
    totalTokens: 100,
    totalTokensFresh: true,
    contextTokens: 50_000,
    estimatedCostUsd: 0.01,
    modelProvider: "openai",
    model: "gpt-5.4",
    runClosureSummary: { action: "close" } as GatewaySessionRow["runClosureSummary"],
    recoveryCheckpointId: "ckpt-1",
    recoveryStatus: "blocked",
    recoveryContinuationState: "idle",
    recoveryOperation: "resume",
    recoveryBlockedReason: undefined,
    recoveryUpdatedAt: 1_700_000_001,
    recoveryAttempts: 2,
    recoveryOperatorHint: "retry",
    handoffRequestRunId: "run-req",
    handoffRunId: "run-truth",
    handoffTruthSource: "recovery",
    handoffHint: "recovery overrides stale closure",
  };

  it("returns empty object for null/undefined row", () => {
    expect(buildGatewaySessionBroadcastSnapshot(null)).toEqual({});
    expect(buildGatewaySessionBroadcastSnapshot(undefined)).toEqual({});
  });

  it("includes closure, recovery, and handoff fields at the flat top level", () => {
    const flat = buildGatewaySessionBroadcastSnapshot(baseRow, { includeFullSession: false });
    expect(flat).toMatchObject({
      sessionId: "sess-1",
      kind: "direct",
      runClosureSummary: baseRow.runClosureSummary,
      recoveryCheckpointId: "ckpt-1",
      recoveryStatus: "blocked",
      recoveryContinuationState: "idle",
      recoveryOperation: "resume",
      recoveryUpdatedAt: 1_700_000_001,
      recoveryAttempts: 2,
      recoveryOperatorHint: "retry",
      handoffRequestRunId: "run-req",
      handoffRunId: "run-truth",
      handoffTruthSource: "recovery",
      handoffHint: "recovery overrides stale closure",
    });
    expect(flat).not.toHaveProperty("session");
  });

  it("adds session when includeFullSession is true", () => {
    const withSession = buildGatewaySessionBroadcastSnapshot(baseRow, { includeFullSession: true });
    expect(withSession.session).toBe(baseRow);
    expect(withSession.handoffTruthSource).toBe("recovery");
  });
});
