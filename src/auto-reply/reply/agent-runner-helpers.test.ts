import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../types.js";
import type { TypingSignaler } from "./typing-mode.js";

const hoisted = vi.hoisted(() => {
  const loadSessionStoreMock = vi.fn();
  const scheduleFollowupDrainMock = vi.fn();
  return { loadSessionStoreMock, scheduleFollowupDrainMock };
});

vi.mock("../../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions.js")>();
  return {
    ...actual,
    loadSessionStore: (...args: unknown[]) => hoisted.loadSessionStoreMock(...args),
  };
});

vi.mock("./queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./queue.js")>();
  return {
    ...actual,
    scheduleFollowupDrain: (...args: unknown[]) => hoisted.scheduleFollowupDrainMock(...args),
  };
});

let createShouldEmitToolOutput: typeof import("./agent-runner-helpers.js").createShouldEmitToolOutput;
let createShouldEmitToolResult: typeof import("./agent-runner-helpers.js").createShouldEmitToolResult;
let buildAcceptanceFallbackPayload: typeof import("./agent-runner-helpers.js").buildAcceptanceFallbackPayload;
let enqueueSemanticRetryFollowup: typeof import("./agent-runner-helpers.js").enqueueSemanticRetryFollowup;
let finalizeWithFollowup: typeof import("./agent-runner-helpers.js").finalizeWithFollowup;
let isAudioPayload: typeof import("./agent-runner-helpers.js").isAudioPayload;
let signalTypingIfNeeded: typeof import("./agent-runner-helpers.js").signalTypingIfNeeded;

describe("agent runner helpers", () => {
  beforeEach(async () => {
    vi.resetModules();
    hoisted.loadSessionStoreMock.mockClear();
    hoisted.scheduleFollowupDrainMock.mockClear();
    ({
      createShouldEmitToolOutput,
      createShouldEmitToolResult,
      buildAcceptanceFallbackPayload,
      enqueueSemanticRetryFollowup,
      finalizeWithFollowup,
      isAudioPayload,
      signalTypingIfNeeded,
    } = await import("./agent-runner-helpers.js"));
  });

  it("detects audio payloads from mediaUrl/mediaUrls", () => {
    expect(isAudioPayload({ mediaUrl: "https://example.test/audio.mp3" })).toBe(true);
    expect(isAudioPayload({ mediaUrls: ["https://example.test/video.mp4"] })).toBe(false);
    expect(isAudioPayload({ mediaUrls: ["https://example.test/voice.m4a"] })).toBe(true);
  });

  it("uses fallback verbose level when session context is missing", () => {
    expect(createShouldEmitToolResult({ resolvedVerboseLevel: "off" })()).toBe(false);
    expect(createShouldEmitToolResult({ resolvedVerboseLevel: "on" })()).toBe(true);
    expect(createShouldEmitToolOutput({ resolvedVerboseLevel: "on" })()).toBe(false);
    expect(createShouldEmitToolOutput({ resolvedVerboseLevel: "full" })()).toBe(true);
  });

  it("uses session verbose level when present", () => {
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": { verboseLevel: "full" },
    });
    const shouldEmitResult = createShouldEmitToolResult({
      sessionKey: "agent:main:main",
      storePath: "/tmp/store.json",
      resolvedVerboseLevel: "off",
    });
    const shouldEmitOutput = createShouldEmitToolOutput({
      sessionKey: "agent:main:main",
      storePath: "/tmp/store.json",
      resolvedVerboseLevel: "off",
    });
    expect(shouldEmitResult()).toBe(true);
    expect(shouldEmitOutput()).toBe(true);
  });

  it("falls back when store read fails or session value is invalid", () => {
    hoisted.loadSessionStoreMock.mockImplementation(() => {
      throw new Error("boom");
    });
    const fallbackOn = createShouldEmitToolResult({
      sessionKey: "agent:main:main",
      storePath: "/tmp/store.json",
      resolvedVerboseLevel: "on",
    });
    expect(fallbackOn()).toBe(true);

    hoisted.loadSessionStoreMock.mockClear();
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": { verboseLevel: "weird" },
    });
    const fallbackFull = createShouldEmitToolOutput({
      sessionKey: "agent:main:main",
      storePath: "/tmp/store.json",
      resolvedVerboseLevel: "full",
    });
    expect(fallbackFull()).toBe(true);
  });

  it("schedules followup drain and returns the original value", () => {
    const runFollowupTurn = vi.fn();
    const value = { ok: true };
    expect(finalizeWithFollowup(value, "queue-key", runFollowupTurn)).toBe(value);
    expect(hoisted.scheduleFollowupDrainMock).toHaveBeenCalledWith("queue-key", runFollowupTurn);
  });

  it("signals typing only when any payload has text or media", async () => {
    const signalRunStart = vi.fn().mockResolvedValue(undefined);
    const typingSignals = { signalRunStart } as unknown as TypingSignaler;
    const emptyPayloads: ReplyPayload[] = [{ text: "   " }, {}];
    await signalTypingIfNeeded(emptyPayloads, typingSignals);
    expect(signalRunStart).not.toHaveBeenCalled();

    await signalTypingIfNeeded([{ mediaUrl: "https://example.test/img.png" }], typingSignals);
    expect(signalRunStart).toHaveBeenCalledOnce();
  });

  it("queues at most one supervisor-driven retry for retryable verdicts", () => {
    const queued = enqueueSemanticRetryFollowup({
      queueKey: "queue-1",
      sourceRun: {
        prompt: "do work",
        summaryLine: "original",
        enqueuedAt: 1,
        run: {
          agentId: "agent",
          agentDir: "/tmp/agent",
          sessionId: "session",
          sessionFile: "/tmp/session.json",
          workspaceDir: "/tmp/workspace",
          config: {},
          provider: "openai",
          model: "gpt-5.4",
          timeoutMs: 30_000,
          blockReplyBreak: "message_end",
        },
      },
      settings: {} as never,
      acceptance: undefined,
      supervisorVerdict: {
        runId: "run-1",
        status: "retryable",
        action: "retry",
        remediation: "semantic_retry",
        recoveryPolicy: {
          remediation: "semantic_retry",
          recoveryClass: "semantic",
          cadence: "immediate",
          continuous: false,
          attemptCount: 0,
          maxAttempts: 1,
          remainingAttempts: 1,
          exhausted: false,
          exhaustedAction: "stop",
          nextAttemptDelayMs: 0,
        },
        reasonCode: "contract_mismatch",
        reasons: ["missing verified output"],
      },
    });
    expect(queued).toBe(true);

    const skipped = enqueueSemanticRetryFollowup({
      queueKey: "queue-1",
      sourceRun: {
        prompt: "do work",
        summaryLine: "original",
        enqueuedAt: 1,
        run: {
          agentId: "agent",
          agentDir: "/tmp/agent",
          sessionId: "session",
          sessionFile: "/tmp/session.json",
          workspaceDir: "/tmp/workspace",
          config: {},
          provider: "openai",
          model: "gpt-5.4",
          timeoutMs: 30_000,
          blockReplyBreak: "message_end",
        },
        automation: {
          source: "acceptance_retry",
          retryCount: 1,
        },
      },
      settings: {} as never,
      acceptance: undefined,
      supervisorVerdict: {
        runId: "run-1",
        status: "retryable",
        action: "retry",
        remediation: "semantic_retry",
        recoveryPolicy: {
          remediation: "semantic_retry",
          recoveryClass: "semantic",
          cadence: "immediate",
          continuous: false,
          attemptCount: 1,
          maxAttempts: 1,
          remainingAttempts: 0,
          exhausted: true,
          exhaustedAction: "stop",
          nextAttemptDelayMs: 0,
        },
        reasonCode: "execution_no_progress",
        reasons: ["tool reported no progress"],
      },
    });
    expect(skipped).toBe(false);
  });

  it("does not queue semantic retry for bootstrap remediation and surfaces a specific fallback payload", () => {
    const skipped = enqueueSemanticRetryFollowup({
      queueKey: "queue-1",
      sourceRun: {
        prompt: "do work",
        summaryLine: "original",
        enqueuedAt: 1,
        run: {
          agentId: "agent",
          agentDir: "/tmp/agent",
          sessionId: "session",
          sessionFile: "/tmp/session.json",
          workspaceDir: "/tmp/workspace",
          config: {},
          provider: "openai",
          model: "gpt-5.4",
          timeoutMs: 30_000,
          blockReplyBreak: "message_end",
        },
      },
      settings: {} as never,
      acceptance: {
        runId: "run-bootstrap",
        status: "retryable",
        action: "retry",
        remediation: "bootstrap",
        recoveryPolicy: {
          remediation: "bootstrap",
          recoveryClass: "bootstrap",
          cadence: "manual",
          continuous: false,
          attemptCount: 0,
          maxAttempts: 2,
          remainingAttempts: 2,
          exhausted: false,
          exhaustedAction: "escalate",
        },
        reasonCode: "bootstrap_required",
        reasons: ["bootstrap still required"],
        outcome: {
          runId: "run-bootstrap",
          status: "completed",
          checkpointIds: [],
          blockedCheckpointIds: [],
          completedCheckpointIds: [],
          deniedCheckpointIds: [],
          pendingApprovalIds: [],
          artifactIds: [],
          bootstrapRequestIds: [],
          actionIds: [],
          attemptedActionIds: [],
          confirmedActionIds: [],
          failedActionIds: [],
          boundaries: [],
        },
        evidence: {
          executionSurfaceStatus: "bootstrap_required",
          executionUnattendedBoundary: "bootstrap",
        },
      },
    });
    expect(skipped).toBe(false);
    expect(
      buildAcceptanceFallbackPayload({
        runId: "run-bootstrap",
        status: "retryable",
        action: "retry",
        remediation: "bootstrap",
        recoveryPolicy: {
          remediation: "bootstrap",
          recoveryClass: "bootstrap",
          cadence: "manual",
          continuous: false,
          attemptCount: 0,
          maxAttempts: 2,
          remainingAttempts: 2,
          exhausted: false,
          exhaustedAction: "escalate",
        },
        reasonCode: "bootstrap_required",
        reasons: ["bootstrap still required"],
        outcome: {
          runId: "run-bootstrap",
          status: "completed",
          checkpointIds: [],
          blockedCheckpointIds: [],
          completedCheckpointIds: [],
          deniedCheckpointIds: [],
          pendingApprovalIds: [],
          artifactIds: [],
          bootstrapRequestIds: [],
          actionIds: [],
          attemptedActionIds: [],
          confirmedActionIds: [],
          failedActionIds: [],
          boundaries: [],
        },
        evidence: {
          executionSurfaceStatus: "bootstrap_required",
          executionUnattendedBoundary: "bootstrap",
        },
      }),
    ).toEqual(
      expect.objectContaining({
        text: expect.stringContaining("bootstrap recovery"),
      }),
    );
  });

  it("surfaces an exhausted-recovery fallback instead of requeueing semantic retries", () => {
    const skipped = enqueueSemanticRetryFollowup({
      queueKey: "queue-1",
      sourceRun: {
        prompt: "do work",
        summaryLine: "original",
        enqueuedAt: 1,
        run: {
          agentId: "agent",
          agentDir: "/tmp/agent",
          sessionId: "session",
          sessionFile: "/tmp/session.json",
          workspaceDir: "/tmp/workspace",
          config: {},
          provider: "openai",
          model: "gpt-5.4",
          timeoutMs: 30_000,
          blockReplyBreak: "message_end",
        },
        automation: {
          source: "acceptance_retry",
          retryCount: 1,
        },
      },
      settings: {} as never,
      acceptance: undefined,
      supervisorVerdict: {
        runId: "run-exhausted",
        status: "failed",
        action: "stop",
        remediation: "semantic_retry",
        recoveryPolicy: {
          remediation: "semantic_retry",
          recoveryClass: "semantic",
          cadence: "immediate",
          continuous: false,
          attemptCount: 1,
          maxAttempts: 1,
          remainingAttempts: 0,
          exhausted: true,
          exhaustedAction: "stop",
          nextAttemptDelayMs: 0,
        },
        reasonCode: "recovery_budget_exhausted",
        reasons: ["Recovery budget exhausted after 1/1 attempts."],
      },
    });
    expect(skipped).toBe(false);
    expect(
      buildAcceptanceFallbackPayload({
        runId: "run-exhausted",
        status: "retryable",
        action: "retry",
        remediation: "semantic_retry",
        recoveryPolicy: {
          remediation: "semantic_retry",
          recoveryClass: "semantic",
          cadence: "immediate",
          continuous: false,
          attemptCount: 1,
          maxAttempts: 1,
          remainingAttempts: 0,
          exhausted: true,
          exhaustedAction: "stop",
          nextAttemptDelayMs: 0,
        },
        reasonCode: "contract_mismatch",
        reasons: ["missing verified output"],
        outcome: {
          runId: "run-exhausted",
          status: "completed",
          checkpointIds: [],
          blockedCheckpointIds: [],
          completedCheckpointIds: [],
          deniedCheckpointIds: [],
          pendingApprovalIds: [],
          artifactIds: [],
          bootstrapRequestIds: [],
          actionIds: [],
          attemptedActionIds: [],
          confirmedActionIds: [],
          failedActionIds: [],
          boundaries: [],
        },
        evidence: {
          recoveryAttemptCount: 1,
          recoveryMaxAttempts: 1,
          recoveryBudgetExhausted: true,
        },
      }),
    ).toEqual(
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("exhausted the automatic recovery budget"),
      }),
    );
  });
});
