import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSharedExecApprovalManager,
  resetSharedExecApprovalManager,
} from "../../gateway/exec-approval-manager.js";
import {
  getPlatformRuntimeCheckpointService,
  resetPlatformRuntimeCheckpointService,
} from "../../platform/runtime/index.js";
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
let buildCanonicalMessagingDeliveryReceipt: typeof import("./agent-runner-helpers.js").buildCanonicalMessagingDeliveryReceipt;
let enqueueSemanticRetryFollowup: typeof import("./agent-runner-helpers.js").enqueueSemanticRetryFollowup;
let finalizeClosureRecoveryCheckpoint: typeof import("./agent-runner-helpers.js").finalizeClosureRecoveryCheckpoint;
let finalizeMessagingDeliveryClosure: typeof import("./agent-runner-helpers.js").finalizeMessagingDeliveryClosure;
let finalizeWithFollowup: typeof import("./agent-runner-helpers.js").finalizeWithFollowup;
let getPlatformBootstrapService: typeof import("../../platform/bootstrap/index.js").getPlatformBootstrapService;
let resetPlatformBootstrapService: typeof import("../../platform/bootstrap/index.js").resetPlatformBootstrapService;
let isAudioPayload: typeof import("./agent-runner-helpers.js").isAudioPayload;
let reconcileClosureRecoveryOnStartup: typeof import("./closure-outcome-dispatcher.js").reconcileClosureRecoveryOnStartup;
let reevaluateAcceptanceForMessagingRun: typeof import("./agent-runner-helpers.js").reevaluateAcceptanceForMessagingRun;
let signalTypingIfNeeded: typeof import("./agent-runner-helpers.js").signalTypingIfNeeded;

describe("agent runner helpers", () => {
  beforeEach(async () => {
    vi.resetModules();
    hoisted.loadSessionStoreMock.mockClear();
    hoisted.scheduleFollowupDrainMock.mockClear();
    resetPlatformRuntimeCheckpointService();
    resetSharedExecApprovalManager();
    ({ getPlatformBootstrapService, resetPlatformBootstrapService } =
      await import("../../platform/bootstrap/index.js"));
    resetPlatformBootstrapService();
    ({
      createShouldEmitToolOutput,
      createShouldEmitToolResult,
      buildAcceptanceFallbackPayload,
      buildCanonicalMessagingDeliveryReceipt,
      enqueueSemanticRetryFollowup,
      finalizeClosureRecoveryCheckpoint,
      finalizeMessagingDeliveryClosure,
      finalizeWithFollowup,
      isAudioPayload,
      reevaluateAcceptanceForMessagingRun,
      signalTypingIfNeeded,
    } = await import("./agent-runner-helpers.js"));
    ({ reconcileClosureRecoveryOnStartup } = await import("./closure-outcome-dispatcher.js"));
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

  it("builds canonical delivery receipts from payload truth plus merged counters", () => {
    expect(
      buildCanonicalMessagingDeliveryReceipt({
        replyPayloads: [{ text: "final" }, { text: "   " }],
        receipts: [
          {
            stagedReplyCount: 99,
            attemptedDeliveryCount: 1,
            confirmedDeliveryCount: 0,
            failedDeliveryCount: 1,
          },
          {
            attemptedDeliveryCount: 2,
            confirmedDeliveryCount: 2,
            failedDeliveryCount: 0,
          },
        ],
      }),
    ).toEqual({
      stagedReplyCount: 1,
      attemptedDeliveryCount: 3,
      confirmedDeliveryCount: 2,
      failedDeliveryCount: 1,
      partialDelivery: true,
    });
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
        text: expect.stringMatching(/paused|Capability install/i),
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

  it("prefers supervisor verdict semantics when building fallback payloads", () => {
    expect(
      buildAcceptanceFallbackPayload(
        {
          runId: "run-supervisor-fallback",
          status: "retryable",
          action: "retry",
          remediation: "semantic_retry",
          recoveryPolicy: {
            remediation: "semantic_retry",
            recoveryClass: "semantic",
            cadence: "immediate",
            continuous: false,
            attemptCount: 0,
            maxAttempts: 2,
            remainingAttempts: 2,
            exhausted: false,
            exhaustedAction: "stop",
            nextAttemptDelayMs: 0,
          },
          reasonCode: "runtime_partial",
          reasons: ["delivery still pending"],
          outcome: {
            runId: "run-supervisor-fallback",
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
          evidence: {},
        },
        {
          runId: "run-supervisor-fallback",
          status: "failed",
          action: "escalate",
          remediation: "none",
          reasonCode: "needs_human",
          reasons: ["A human needs to confirm the irreversible step."],
          recoveryPolicy: {
            remediation: "none",
            recoveryClass: "none",
            cadence: "manual",
            continuous: false,
            attemptCount: 0,
            maxAttempts: 0,
            remainingAttempts: 0,
            exhausted: false,
            exhaustedAction: "escalate",
          },
        },
      ),
    ).toEqual(
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("human input or approval"),
      }),
    );
  });

  it("adds structured closure blocks for rich-capable channels only", () => {
    const slackPayload = buildAcceptanceFallbackPayload(
      {
        runId: "run-rich-closure",
        status: "retryable",
        action: "retry",
        remediation: "semantic_retry",
        recoveryPolicy: {
          remediation: "semantic_retry",
          recoveryClass: "semantic",
          cadence: "immediate",
          continuous: false,
          attemptCount: 0,
          maxAttempts: 2,
          remainingAttempts: 2,
          exhausted: false,
          exhaustedAction: "stop",
          nextAttemptDelayMs: 0,
        },
        reasonCode: "contract_mismatch",
        reasons: [
          "The delivered output did not satisfy the request.",
          "A second pass should tighten the final answer.",
        ],
        outcome: {
          runId: "run-rich-closure",
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
        evidence: {},
      },
      undefined,
      { channel: "slack" },
    );
    const whatsappPayload = buildAcceptanceFallbackPayload(
      {
        runId: "run-rich-closure",
        status: "retryable",
        action: "retry",
        remediation: "semantic_retry",
        recoveryPolicy: {
          remediation: "semantic_retry",
          recoveryClass: "semantic",
          cadence: "immediate",
          continuous: false,
          attemptCount: 0,
          maxAttempts: 2,
          remainingAttempts: 2,
          exhausted: false,
          exhaustedAction: "stop",
          nextAttemptDelayMs: 0,
        },
        reasonCode: "contract_mismatch",
        reasons: [
          "The delivered output did not satisfy the request.",
          "A second pass should tighten the final answer.",
        ],
        outcome: {
          runId: "run-rich-closure",
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
        evidence: {},
      },
      undefined,
      { channel: "whatsapp" },
    );

    expect(slackPayload).toEqual(
      expect.objectContaining({
        text: expect.stringContaining("one more pass"),
        interactive: {
          blocks: expect.arrayContaining([
            expect.objectContaining({ type: "text", text: "Automatic recovery continuing" }),
            expect.objectContaining({
              type: "text",
              text: expect.stringContaining(
                "Reason: The delivered output did not satisfy the request.",
              ),
            }),
          ]),
        },
      }),
    );
    expect(whatsappPayload).toEqual(
      expect.objectContaining({
        text: expect.stringContaining("one more pass"),
      }),
    );
    expect(whatsappPayload?.interactive).toBeUndefined();
  });

  it("creates a shared approval control object for auth refresh closure outcomes", () => {
    const result = finalizeMessagingDeliveryClosure({
      candidate: {
        runResult: {
          meta: {
            acceptanceOutcome: {
              runId: "run-auth-closure",
              status: "failed",
              action: "stop",
              remediation: "auth_refresh",
              reasonCode: "provider_auth_required",
              reasons: ["Provider authentication expired before delivery could complete."],
              recoveryPolicy: {
                remediation: "auth_refresh",
                recoveryClass: "auth",
                cadence: "manual",
                continuous: false,
                attemptCount: 1,
                maxAttempts: 1,
                remainingAttempts: 0,
                exhausted: true,
                exhaustedAction: "escalate",
              },
              outcome: {
                runId: "run-auth-closure",
                status: "failed",
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
                providerAuthFailed: true,
              },
            },
            supervisorVerdict: {
              runId: "run-auth-closure",
              status: "needs_human",
              action: "escalate",
              remediation: "auth_refresh",
              reasonCode: "auth_recovery",
              reasons: ["Provider authentication expired before delivery could complete."],
              recoveryPolicy: {
                remediation: "auth_refresh",
                recoveryClass: "auth",
                cadence: "manual",
                continuous: false,
                attemptCount: 1,
                maxAttempts: 1,
                remainingAttempts: 0,
                exhausted: true,
                exhaustedAction: "escalate",
              },
            },
          },
        },
        sourceRun: {
          prompt: "finish auth-sensitive task",
          enqueuedAt: 1,
          run: {
            agentId: "agent",
            agentDir: "/tmp/agent",
            sessionId: "session",
            sessionKey: "agent:main:main",
            sessionFile: "/tmp/session.json",
            workspaceDir: "/tmp/workspace",
            config: {},
            provider: "openai",
            model: "gpt-5.4",
            timeoutMs: 30_000,
            blockReplyBreak: "message_end",
          },
        },
        queueKey: "queue-1",
        settings: { mode: "followup", debounceMs: 0, cap: 20 },
      },
      replyPayloads: [{ text: "Auth failed." }],
      deliveryReceipt: {},
    });

    expect(result).toEqual(
      expect.objectContaining({
        queuedSemanticRetry: false,
        supervisorVerdict: expect.objectContaining({
          remediation: "auth_refresh",
          action: "escalate",
        }),
      }),
    );
    expect(
      getSharedExecApprovalManager().getSnapshot("closure:run-auth-closure:auth_refresh:escalate"),
    ).toEqual(
      expect.objectContaining({
        request: expect.objectContaining({
          runtimeRunId: "run-auth-closure",
          runtimeCheckpointId: "closure:run-auth-closure:auth_refresh:escalate",
          blockedReason: "provider authentication refresh requires operator attention",
        }),
      }),
    );
    expect(
      getPlatformRuntimeCheckpointService().get("closure:run-auth-closure:auth_refresh:escalate"),
    ).toEqual(
      expect.objectContaining({
        runId: "run-auth-closure",
        boundary: "exec_approval",
        target: expect.objectContaining({
          approvalId: "closure:run-auth-closure:auth_refresh:escalate",
          operation: "closure.recovery",
        }),
        continuation: expect.objectContaining({
          kind: "closure_recovery",
          state: "idle",
          attempts: 0,
        }),
      }),
    );
  });

  it("dispatches closure recovery continuations through the followup queue", async () => {
    finalizeMessagingDeliveryClosure({
      candidate: {
        runResult: {
          meta: {
            acceptanceOutcome: {
              runId: "run-auth-resume",
              status: "retryable",
              action: "escalate",
              remediation: "auth_refresh",
              reasonCode: "provider_auth_required",
              reasons: ["Provider authentication expired."],
              recoveryPolicy: {
                remediation: "auth_refresh",
                recoveryClass: "human",
                cadence: "manual",
                continuous: false,
                attemptCount: 0,
                maxAttempts: 1,
                remainingAttempts: 1,
                exhausted: false,
                exhaustedAction: "stop",
              },
              outcome: {
                runId: "run-auth-resume",
                status: "blocked",
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
                providerAuthFailed: true,
                deliveredReplyCount: 1,
              },
            },
            supervisorVerdict: {
              runId: "run-auth-resume",
              status: "retryable",
              action: "escalate",
              remediation: "auth_refresh",
              reasonCode: "auth_recovery",
              reasons: ["Provider authentication expired."],
              recoveryPolicy: {
                remediation: "auth_refresh",
                recoveryClass: "human",
                cadence: "manual",
                continuous: false,
                attemptCount: 0,
                maxAttempts: 1,
                remainingAttempts: 1,
                exhausted: false,
                exhaustedAction: "stop",
              },
            },
          },
        },
        sourceRun: {
          prompt: "finish the task after auth refresh",
          enqueuedAt: 1,
          originatingChannel: "slack",
          originatingTo: "C123",
          originatingThreadId: "thread-1",
          run: {
            agentId: "agent",
            agentDir: "/tmp/agent",
            sessionId: "session",
            sessionKey: "agent:main:main",
            messageProvider: "slack",
            sessionFile: "/tmp/session.json",
            workspaceDir: "/tmp/workspace",
            config: {},
            provider: "openai",
            model: "gpt-5.4",
            timeoutMs: 30_000,
            blockReplyBreak: "message_end",
          },
        },
        queueKey: "queue-auth-resume",
        settings: { mode: "followup", debounceMs: 0, cap: 20 },
      },
      replyPayloads: [{ text: "Please refresh auth." }],
      deliveryReceipt: {},
    });

    await getPlatformRuntimeCheckpointService().dispatchContinuation(
      "closure:run-auth-resume:auth_refresh:escalate",
    );

    expect(hoisted.scheduleFollowupDrainMock).toHaveBeenCalledWith(
      "queue-auth-resume",
      expect.any(Function),
    );
    expect(
      getPlatformRuntimeCheckpointService().get("closure:run-auth-resume:auth_refresh:escalate"),
    ).toEqual(
      expect.objectContaining({
        status: "blocked",
        continuation: expect.objectContaining({
          kind: "closure_recovery",
          state: "idle",
          attempts: 1,
        }),
      }),
    );
  });

  it("restores blocked closure recovery approvals on startup reconcile", async () => {
    finalizeMessagingDeliveryClosure({
      candidate: {
        runResult: {
          meta: {
            acceptanceOutcome: {
              runId: "run-auth-restart",
              status: "retryable",
              action: "escalate",
              remediation: "auth_refresh",
              reasonCode: "provider_auth_required",
              reasons: ["Provider authentication expired."],
              recoveryPolicy: {
                remediation: "auth_refresh",
                recoveryClass: "human",
                cadence: "manual",
                continuous: false,
                attemptCount: 0,
                maxAttempts: 1,
                remainingAttempts: 1,
                exhausted: false,
                exhaustedAction: "stop",
              },
              outcome: {
                runId: "run-auth-restart",
                status: "blocked",
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
                providerAuthFailed: true,
              },
            },
            supervisorVerdict: {
              runId: "run-auth-restart",
              status: "retryable",
              action: "escalate",
              remediation: "auth_refresh",
              reasonCode: "auth_recovery",
              reasons: ["Provider authentication expired."],
              recoveryPolicy: {
                remediation: "auth_refresh",
                recoveryClass: "human",
                cadence: "manual",
                continuous: false,
                attemptCount: 0,
                maxAttempts: 1,
                remainingAttempts: 1,
                exhausted: false,
                exhaustedAction: "stop",
              },
            },
          },
        },
        sourceRun: {
          prompt: "resume after restart",
          enqueuedAt: 1,
          originatingChannel: "slack",
          originatingTo: "C123",
          run: {
            agentId: "agent",
            agentDir: "/tmp/agent",
            sessionId: "session",
            sessionKey: "agent:main:main",
            messageProvider: "slack",
            sessionFile: "/tmp/session.json",
            workspaceDir: "/tmp/workspace",
            config: {},
            provider: "openai",
            model: "gpt-5.4",
            timeoutMs: 30_000,
            blockReplyBreak: "message_end",
          },
        },
        queueKey: "queue-auth-restart",
        settings: { mode: "followup", debounceMs: 0, cap: 20 },
      },
      replyPayloads: [{ text: "Please re-authenticate." }],
      deliveryReceipt: {},
    });

    resetSharedExecApprovalManager();

    const reconciled = await reconcileClosureRecoveryOnStartup();

    expect(reconciled.restoredApprovalCount).toBe(1);
    expect(
      getSharedExecApprovalManager().getSnapshot("closure:run-auth-restart:auth_refresh:escalate"),
    ).toEqual(
      expect.objectContaining({
        request: expect.objectContaining({
          runtimeCheckpointId: "closure:run-auth-restart:auth_refresh:escalate",
          blockedReason: "provider authentication refresh requires operator attention",
        }),
      }),
    );
  });

  it("completes closure recovery checkpoints only after a successful resumed outcome", () => {
    finalizeMessagingDeliveryClosure({
      candidate: {
        runResult: {
          meta: {
            acceptanceOutcome: {
              runId: "run-auth-complete",
              status: "retryable",
              action: "escalate",
              remediation: "auth_refresh",
              reasonCode: "provider_auth_required",
              reasons: ["Provider authentication expired."],
              recoveryPolicy: {
                remediation: "auth_refresh",
                recoveryClass: "human",
                cadence: "manual",
                continuous: false,
                attemptCount: 0,
                maxAttempts: 1,
                remainingAttempts: 1,
                exhausted: false,
                exhaustedAction: "stop",
              },
              outcome: {
                runId: "run-auth-complete",
                status: "blocked",
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
                providerAuthFailed: true,
              },
            },
            supervisorVerdict: {
              runId: "run-auth-complete",
              status: "retryable",
              action: "escalate",
              remediation: "auth_refresh",
              reasonCode: "auth_recovery",
              reasons: ["Provider authentication expired."],
              recoveryPolicy: {
                remediation: "auth_refresh",
                recoveryClass: "human",
                cadence: "manual",
                continuous: false,
                attemptCount: 0,
                maxAttempts: 1,
                remainingAttempts: 1,
                exhausted: false,
                exhaustedAction: "stop",
              },
            },
          },
        },
        sourceRun: {
          prompt: "finish task",
          enqueuedAt: 1,
          run: {
            agentId: "agent",
            agentDir: "/tmp/agent",
            sessionId: "session",
            sessionKey: "agent:main:main",
            sessionFile: "/tmp/session.json",
            workspaceDir: "/tmp/workspace",
            config: {},
            provider: "openai",
            model: "gpt-5.4",
            timeoutMs: 30_000,
            blockReplyBreak: "message_end",
          },
        },
        queueKey: "queue-auth-complete",
        settings: { mode: "followup", debounceMs: 0, cap: 20 },
      },
      replyPayloads: [{ text: "Please re-authenticate." }],
      deliveryReceipt: {},
    });

    const checkpointId = "closure:run-auth-complete:auth_refresh:escalate";
    expect(getPlatformRuntimeCheckpointService().get(checkpointId)?.status).toBe("blocked");

    finalizeClosureRecoveryCheckpoint({
      sourceRun: {
        prompt: "finish task",
        enqueuedAt: 2,
        automation: {
          source: "closure_recovery",
          retryCount: 0,
          persisted: true,
          runtimeCheckpointId: checkpointId,
        },
        run: {
          agentId: "agent",
          agentDir: "/tmp/agent",
          sessionId: "session",
          sessionKey: "agent:main:main",
          sessionFile: "/tmp/session.json",
          workspaceDir: "/tmp/workspace",
          config: {},
          provider: "openai",
          model: "gpt-5.4",
          timeoutMs: 30_000,
          blockReplyBreak: "message_end",
        },
      },
      acceptance: undefined,
      supervisorVerdict: {
        runId: "run-auth-complete-followup",
        status: "satisfied",
        action: "close",
        remediation: "none",
        reasonCode: "verified_execution",
        reasons: ["Recovered successfully."],
        recoveryPolicy: {
          remediation: "none",
          recoveryClass: "none",
          cadence: "manual",
          continuous: false,
          attemptCount: 0,
          maxAttempts: 0,
          remainingAttempts: 0,
          exhausted: false,
          exhaustedAction: "stop",
        },
      },
      queuedSemanticRetry: false,
    });

    expect(getPlatformRuntimeCheckpointService().get(checkpointId)).toEqual(
      expect.objectContaining({
        status: "completed",
        continuation: expect.objectContaining({
          kind: "closure_recovery",
          state: "completed",
        }),
      }),
    );
  });

  it("creates bootstrap requests from closure bootstrap remediation", () => {
    const result = finalizeMessagingDeliveryClosure({
      candidate: {
        runResult: {
          meta: {
            acceptanceOutcome: {
              runId: "run-bootstrap-closure",
              status: "retryable",
              action: "retry",
              remediation: "bootstrap",
              reasonCode: "bootstrap_required",
              reasons: ["Bootstrap is still required before the run can complete."],
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
              outcome: {
                runId: "run-bootstrap-closure",
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
            supervisorVerdict: {
              runId: "run-bootstrap-closure",
              status: "retryable",
              action: "retry",
              remediation: "bootstrap",
              reasonCode: "bootstrap_recovery",
              reasons: ["Bootstrap is still required before the run can complete."],
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
            },
            executionIntent: {
              runId: "run-bootstrap-closure",
              profileId: "developer",
              recipeId: "code_build_publish",
              intent: "code",
              bootstrapRequiredCapabilities: ["pdf-renderer"],
              policyAutonomy: "guarded",
              expectations: {},
            },
          },
        },
        sourceRun: {
          prompt: "finish build task",
          enqueuedAt: 1,
          run: {
            agentId: "agent",
            agentDir: "/tmp/agent",
            sessionId: "session",
            sessionKey: "agent:main:main",
            sessionFile: "/tmp/session.json",
            workspaceDir: "/tmp/workspace",
            config: {},
            provider: "openai",
            model: "gpt-5.4",
            timeoutMs: 30_000,
            blockReplyBreak: "message_end",
          },
        },
        queueKey: "queue-1",
        settings: { mode: "followup", debounceMs: 0, cap: 20 },
      },
      replyPayloads: [{ text: "Bootstrap required." }],
      deliveryReceipt: {},
    });

    expect(result.queuedSemanticRetry).toBe(false);
    expect(getPlatformBootstrapService().list()).toEqual([
      expect.objectContaining({
        capabilityId: "pdf-renderer",
        sourceRecipeId: "code_build_publish",
        state: "pending",
      }),
    ]);
    const requestId = getPlatformBootstrapService().list()[0]?.id;
    expect(requestId).toBeTruthy();
    expect(requestId ? getPlatformBootstrapService().get(requestId)?.request.blockedRunResume : undefined).toEqual(
      expect.objectContaining({
        blockedRunId: "run-bootstrap-closure",
        queueKey: "queue-1",
        settings: expect.objectContaining({ mode: "followup" }),
      }),
    );
    expect(requestId ? getPlatformRuntimeCheckpointService().get(requestId) : undefined).toEqual(
      expect.objectContaining({
        runId: requestId,
        boundary: "bootstrap",
        target: expect.objectContaining({
          bootstrapRequestId: requestId,
          operation: "bootstrap.run",
        }),
      }),
    );
  });

  it("reuses declared execution intent when messaging closure is reevaluated", () => {
    const acceptance = reevaluateAcceptanceForMessagingRun({
      runResult: {
        meta: {
          completionOutcome: {
            runId: "run-messaging-intent",
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
            hadToolError: false,
            deterministicApprovalPromptSent: false,
          },
          executionVerification: {
            runId: "run-messaging-intent",
            status: "verified",
            reasons: [],
            receipts: [
              {
                kind: "messaging_delivery",
                name: "delivery.telegram",
                status: "success",
                proof: "verified",
              },
            ],
            receiptCounts: {
              success: 1,
              warning: 0,
              partial: 0,
              degraded: 0,
              failed: 0,
              blocked: 0,
            },
            receiptProofCounts: {
              derived: 0,
              reported: 0,
              verified: 1,
            },
            checkedAtMs: 1,
          },
          executionIntent: {
            runId: "run-messaging-intent",
            recipeId: "code_build_publish",
            profileId: "developer",
            intent: "publish",
            artifactKinds: ["site"],
            expectations: {
              requiresOutput: true,
            },
          },
        },
      },
      replyPayloads: [{ text: "Preview deployed." }],
      deliveryReceipt: {
        attemptedDeliveryCount: 1,
        confirmedDeliveryCount: 1,
        failedDeliveryCount: 0,
      },
    });

    expect(acceptance).toEqual(
      expect.objectContaining({
        status: "satisfied",
        reasonCode: "completed_with_confirmed_delivery",
        evidence: expect.objectContaining({
          declaredRecipeId: "code_build_publish",
          declaredIntent: "publish",
          declaredRequiresOutput: true,
        }),
      }),
    );
  });
});
