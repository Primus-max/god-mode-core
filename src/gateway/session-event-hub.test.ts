import { describe, expect, it } from "vitest";
import {
  buildSessionMessageSnapshot,
  buildSessionsChangedLifecycleEvent,
  buildSessionsChangedMutationEvent,
  buildSessionsChangedTranscriptEvent,
} from "./session-event-hub.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

describe("session event hub", () => {
  const baseRow: GatewaySessionRow = {
    key: "agent:main:main",
    kind: "direct",
    updatedAt: 1_700_000_000,
    sessionId: "sess-1",
    channel: "webchat",
    label: "Main",
    displayName: "Main display",
    status: "running",
    startedAt: 1_700_000_000,
    totalTokens: 100,
    totalTokensFresh: true,
    contextTokens: 50_000,
    estimatedCostUsd: 0.01,
    modelProvider: "openai",
    model: "gpt-5.4",
  };

  it("builds mutation events from the flat snapshot without nested session compatibility", () => {
    const event = buildSessionsChangedMutationEvent({
      sessionKey: baseRow.key,
      reason: "patch",
      ts: 123,
      row: baseRow,
    });

    expect(event).toMatchObject({
      sessionKey: baseRow.key,
      reason: "patch",
      ts: 123,
      sessionId: "sess-1",
      status: "running",
      modelProvider: "openai",
      model: "gpt-5.4",
    });
    expect(event).not.toHaveProperty("session");
  });

  it("applies lifecycle-derived status changes before broadcasting", () => {
    const event = buildSessionsChangedLifecycleEvent({
      sessionKey: baseRow.key,
      phase: "error",
      runId: "run-1",
      ts: 2_000,
      row: baseRow,
      lifecycleEvent: {
        stream: "lifecycle",
        ts: 2_000,
        data: {
          phase: "error",
          startedAt: 1_000,
          endedAt: 2_000,
        },
      },
    });

    expect(event).toMatchObject({
      sessionKey: baseRow.key,
      phase: "error",
      runId: "run-1",
      status: "failed",
      startedAt: 1_000,
      endedAt: 2_000,
      runtimeMs: 1_000,
      updatedAt: 2_000,
    });
    expect(event).not.toHaveProperty("session");
  });

  it("emits fallback lifecycle fields when no row is available", () => {
    const event = buildSessionsChangedLifecycleEvent({
      sessionKey: "agent:main:missing",
      phase: "start",
      ts: 400,
      lifecycleEvent: {
        stream: "lifecycle",
        ts: 400,
        data: {
          phase: "start",
          startedAt: 350,
        },
      },
      overrides: {
        label: "Late bound",
      },
    });

    expect(event).toMatchObject({
      sessionKey: "agent:main:missing",
      phase: "start",
      label: "Late bound",
      status: "running",
      startedAt: 350,
      updatedAt: 350,
    });
    expect(event).not.toHaveProperty("session");
  });

  it("keeps nested session compatibility for transcript-driven sessions.changed events", () => {
    const event = buildSessionsChangedTranscriptEvent({
      sessionKey: baseRow.key,
      ts: 456,
      messageId: "msg-1",
      messageSeq: 2,
      row: baseRow,
    });

    expect(event).toMatchObject({
      sessionKey: baseRow.key,
      phase: "message",
      ts: 456,
      messageId: "msg-1",
      messageSeq: 2,
      session: expect.objectContaining({ key: baseRow.key }),
    });
  });

  it("keeps nested session compatibility for session.message snapshots", () => {
    const event = buildSessionMessageSnapshot({
      sessionKey: baseRow.key,
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      messageId: "msg-2",
      messageSeq: 3,
      row: baseRow,
    });

    expect(event).toMatchObject({
      sessionKey: baseRow.key,
      messageId: "msg-2",
      messageSeq: 3,
      session: expect.objectContaining({ key: baseRow.key }),
      message: {
        role: "assistant",
      },
    });
  });
});
