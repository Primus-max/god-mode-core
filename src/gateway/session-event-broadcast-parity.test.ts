import { describe, expect, it } from "vitest";
import { buildGatewaySessionBroadcastSnapshot } from "./session-broadcast-snapshot.js";
import {
  buildSessionMessageSnapshot,
  buildSessionsChangedLifecycleEvent,
  buildSessionsChangedMutationEvent,
  buildSessionsChangedTranscriptEvent,
} from "./session-event-hub.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

/**
 * Canonical row with all recovery, closure, and handoff fields populated.
 * Mirrors what a stable v1 session looks like after confirmed delivery + closure.
 */
const fullRow: GatewaySessionRow = {
  key: "agent:dev:main",
  kind: "direct",
  updatedAt: 1_700_100_000,
  sessionId: "sess-broadcast",
  channel: "webchat",
  label: "Dev Main",
  displayName: "Dev Main display",
  status: "done",
  startedAt: 1_700_000_000,
  endedAt: 1_700_100_000,
  runtimeMs: 100_000,
  totalTokens: 500,
  totalTokensFresh: true,
  contextTokens: 80_000,
  estimatedCostUsd: 0.05,
  modelProvider: "anthropic",
  model: "claude-opus-4-6",
  runClosureSummary: { action: "close" } as GatewaySessionRow["runClosureSummary"],
  recoveryCheckpointId: "ckpt-broadcast",
  recoveryStatus: "completed",
  recoveryContinuationState: "idle",
  recoveryOperation: "resume",
  recoveryBlockedReason: undefined,
  recoveryUpdatedAt: 1_700_050_000,
  recoveryAttempts: 1,
  recoveryOperatorHint: "resolved after retry",
  handoffRequestRunId: "req-broadcast",
  handoffRunId: "run-broadcast",
  handoffTruthSource: "closure",
  handoffHint: "closure aligned",
};

/**
 * Minimal row: no optional recovery, closure, or handoff fields.
 * Represents a fresh or in-flight session that has not yet reached closure.
 */
const minimalRow: GatewaySessionRow = {
  key: "agent:dev:minimal",
  kind: "direct",
  updatedAt: 1_700_000_000,
  sessionId: "sess-minimal",
  channel: "webchat",
  label: "Minimal",
  displayName: "Minimal",
  status: "running",
  totalTokens: 0,
  totalTokensFresh: false,
  contextTokens: 10_000,
  estimatedCostUsd: 0,
  modelProvider: "openai",
  model: "gpt-5.4",
};

describe("session event broadcast parity", () => {
  it("flat payload: top-level sessions.changed fields mirror canonical session row truth", () => {
    const snapshot = buildGatewaySessionBroadcastSnapshot(fullRow, { includeFullSession: false });

    // Core identity and runtime fields are present at the top level
    expect(snapshot).toMatchObject({
      sessionId: fullRow.sessionId,
      kind: fullRow.kind,
      channel: fullRow.channel,
      label: fullRow.label,
      displayName: fullRow.displayName,
      status: fullRow.status,
      modelProvider: fullRow.modelProvider,
      model: fullRow.model,
      totalTokens: fullRow.totalTokens,
      startedAt: fullRow.startedAt,
      endedAt: fullRow.endedAt,
      runtimeMs: fullRow.runtimeMs,
    });

    // No nested session wrapper at this surface
    expect(snapshot).not.toHaveProperty("session");

    // Mutation event produced from the same row preserves flat parity
    const mutEvent = buildSessionsChangedMutationEvent({
      sessionKey: fullRow.key,
      reason: "status_change",
      ts: 1_700_100_001,
      row: fullRow,
    });
    expect(mutEvent).toMatchObject({
      sessionKey: fullRow.key,
      sessionId: fullRow.sessionId,
      status: fullRow.status,
      modelProvider: fullRow.modelProvider,
      model: fullRow.model,
    });
    expect(mutEvent).not.toHaveProperty("session");
  });

  it("omission semantics: absent optional fields disappear after JSON roundtrip and are not treated as contract drift", () => {
    const snapshot = buildGatewaySessionBroadcastSnapshot(minimalRow, {
      includeFullSession: false,
    });

    // Simulate what JSON.stringify does on the wire: undefined values are dropped
    const wirePayload = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;

    // Optional closure/recovery/handoff keys must be absent, not null or undefined
    expect(wirePayload).not.toHaveProperty("runClosureSummary");
    expect(wirePayload).not.toHaveProperty("recoveryCheckpointId");
    expect(wirePayload).not.toHaveProperty("recoveryStatus");
    expect(wirePayload).not.toHaveProperty("recoveryContinuationState");
    expect(wirePayload).not.toHaveProperty("recoveryOperation");
    expect(wirePayload).not.toHaveProperty("recoveryBlockedReason");
    expect(wirePayload).not.toHaveProperty("handoffRequestRunId");
    expect(wirePayload).not.toHaveProperty("handoffRunId");
    expect(wirePayload).not.toHaveProperty("handoffTruthSource");
    expect(wirePayload).not.toHaveProperty("handoffHint");

    // Core fields are still present after roundtrip
    expect(wirePayload.sessionId).toBe(minimalRow.sessionId);
    expect(wirePayload.status).toBe(minimalRow.status);

    // Mutation event wire representation also omits absent optional fields
    const mutEvent = buildSessionsChangedMutationEvent({
      sessionKey: minimalRow.key,
      reason: "heartbeat",
      ts: 1_700_000_001,
      row: minimalRow,
    });
    const wireMutEvent = JSON.parse(JSON.stringify(mutEvent)) as Record<string, unknown>;
    expect(wireMutEvent).not.toHaveProperty("runClosureSummary");
    expect(wireMutEvent).not.toHaveProperty("handoffTruthSource");
    expect(wireMutEvent.sessionId).toBe(minimalRow.sessionId);
  });

  it("variant policy: mutation and lifecycle surfaces omit nested session; transcript and message surfaces include it", () => {
    // Mutation — flat only
    const mutEvent = buildSessionsChangedMutationEvent({
      sessionKey: fullRow.key,
      reason: "patch",
      ts: 1_700_100_002,
      row: fullRow,
    });
    expect(mutEvent).not.toHaveProperty("session");
    expect(mutEvent.sessionId).toBe(fullRow.sessionId);

    // Lifecycle — flat only
    const lifecycleEvent = buildSessionsChangedLifecycleEvent({
      sessionKey: fullRow.key,
      phase: "end",
      runId: "run-broadcast",
      ts: 1_700_100_003,
      row: fullRow,
      lifecycleEvent: {
        stream: "lifecycle",
        ts: 1_700_100_003,
        data: {
          phase: "end",
          startedAt: fullRow.startedAt,
          endedAt: 1_700_100_003,
        },
      },
    });
    expect(lifecycleEvent).not.toHaveProperty("session");
    expect(lifecycleEvent.sessionKey).toBe(fullRow.key);
    expect(lifecycleEvent.phase).toBe("end");
    expect(lifecycleEvent.runId).toBe("run-broadcast");

    // Transcript — includes nested session for downstream message consumers
    const transcriptEvent = buildSessionsChangedTranscriptEvent({
      sessionKey: fullRow.key,
      ts: 1_700_100_004,
      messageId: "msg-broadcast",
      messageSeq: 7,
      row: fullRow,
    });
    expect(transcriptEvent.session).toBeDefined();
    expect((transcriptEvent.session as GatewaySessionRow).key).toBe(fullRow.key);
    expect(transcriptEvent.phase).toBe("message");
    expect(transcriptEvent.messageId).toBe("msg-broadcast");
    expect(transcriptEvent.messageSeq).toBe(7);

    // Session.message snapshot — includes nested session
    const msgSnapshot = buildSessionMessageSnapshot({
      sessionKey: fullRow.key,
      message: { role: "assistant", content: "parity confirmed" },
      messageId: "msg-broadcast-2",
      messageSeq: 8,
      row: fullRow,
    });
    expect(msgSnapshot.session).toBeDefined();
    expect((msgSnapshot.session as GatewaySessionRow).key).toBe(fullRow.key);
    expect(msgSnapshot.messageId).toBe("msg-broadcast-2");
    expect(msgSnapshot.messageSeq).toBe(8);
  });

  it("recovery-aligned broadcast: recovery/closure/handoff fields from Stage 82 travel through the broadcast layer at the top level", () => {
    const snapshot = buildGatewaySessionBroadcastSnapshot(fullRow, { includeFullSession: false });

    // All recovery fields present at the top level
    expect(snapshot).toMatchObject({
      recoveryCheckpointId: fullRow.recoveryCheckpointId,
      recoveryStatus: fullRow.recoveryStatus,
      recoveryContinuationState: fullRow.recoveryContinuationState,
      recoveryOperation: fullRow.recoveryOperation,
      recoveryUpdatedAt: fullRow.recoveryUpdatedAt,
      recoveryAttempts: fullRow.recoveryAttempts,
      recoveryOperatorHint: fullRow.recoveryOperatorHint,
    });

    // All handoff fields present at the top level
    expect(snapshot).toMatchObject({
      handoffRequestRunId: fullRow.handoffRequestRunId,
      handoffRunId: fullRow.handoffRunId,
      handoffTruthSource: fullRow.handoffTruthSource,
      handoffHint: fullRow.handoffHint,
    });

    // runClosureSummary is present at the top level (not buried inside session)
    expect(snapshot.runClosureSummary).toEqual(fullRow.runClosureSummary);
    expect(snapshot).not.toHaveProperty("session");

    // Mutation event preserves all of these fields through the hub layer
    const mutEvent = buildSessionsChangedMutationEvent({
      sessionKey: fullRow.key,
      reason: "recovery_resolved",
      ts: 1_700_100_005,
      row: fullRow,
    });
    expect(mutEvent).toMatchObject({
      recoveryCheckpointId: fullRow.recoveryCheckpointId,
      recoveryStatus: fullRow.recoveryStatus,
      recoveryContinuationState: fullRow.recoveryContinuationState,
      handoffTruthSource: fullRow.handoffTruthSource,
      handoffRequestRunId: fullRow.handoffRequestRunId,
      handoffRunId: fullRow.handoffRunId,
      runClosureSummary: fullRow.runClosureSummary,
    });
    expect(mutEvent).not.toHaveProperty("session");
  });
});
