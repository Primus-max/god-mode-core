import { describe, expect, it } from "vitest";
import {
  createRuntimeActionGetGatewayMethod,
  createRuntimeActionListGatewayMethod,
  createRuntimeCheckpointDispatchGatewayMethod,
  createRuntimeCheckpointGetGatewayMethod,
  createRuntimeCheckpointListGatewayMethod,
  createRuntimeClosureListGatewayMethod,
} from "./gateway.js";
import { createPlatformRuntimeCheckpointService } from "./service.js";

describe("platform runtime gateway", () => {
  it("strips continuation input from checkpoint inspection surfaces", () => {
    const service = createPlatformRuntimeCheckpointService();
    service.createCheckpoint({
      id: "checkpoint-1",
      runId: "run-1",
      sessionKey: "agent:main:main",
      boundary: "exec_approval",
      blockedReason: "awaiting recovery approval",
      target: {
        approvalId: "approval-1",
        operation: "closure.recovery",
      },
      continuation: {
        kind: "closure_recovery",
        state: "idle",
        attempts: 0,
        input: {
          queueKey: "queue-1",
          sourceRun: {
            prompt: "secret prompt",
          },
        },
      },
    });
    service.updateCheckpoint("checkpoint-1", {
      lastOperatorDecision: {
        action: "approve",
        atMs: 5,
        actor: {
          displayName: "Operator Tanya",
        },
        source: "exec.approval.resolve",
      },
    });

    const listHandler = createRuntimeCheckpointListGatewayMethod(service);
    const getHandler = createRuntimeCheckpointGetGatewayMethod(service);

    let listed: unknown;
    let fetched: unknown;
    void listHandler({
      params: {},
      respond: (_ok: boolean, result: unknown) => {
        listed = result;
      },
    } as never);
    void getHandler({
      params: { checkpointId: "checkpoint-1" },
      respond: (_ok: boolean, result: unknown) => {
        fetched = result;
      },
    } as never);

    expect(listed).toEqual({
      checkpoints: [
        expect.objectContaining({
          id: "checkpoint-1",
          operatorHint: expect.stringContaining("Awaiting operator approval"),
          lastOperatorDecision: expect.objectContaining({
            action: "approve",
            actor: expect.objectContaining({
              displayName: "Operator Tanya",
            }),
          }),
          continuation: expect.objectContaining({
            kind: "closure_recovery",
            state: "idle",
            attempts: 0,
          }),
        }),
      ],
    });
    expect(fetched).toEqual({
      checkpoint: expect.objectContaining({
        id: "checkpoint-1",
        operatorHint: expect.stringContaining("Awaiting operator approval"),
        lastOperatorDecision: expect.objectContaining({
          action: "approve",
          actor: expect.objectContaining({
            displayName: "Operator Tanya",
          }),
        }),
        continuation: expect.objectContaining({
          kind: "closure_recovery",
          state: "idle",
          attempts: 0,
        }),
      }),
    });
    expect(
      (fetched as { checkpoint: { continuation?: { input?: unknown } } }).checkpoint.continuation
        ?.input,
    ).toBeUndefined();
  });

  it("lists runtime actions with summary filters and fetches full action receipts", () => {
    const service = createPlatformRuntimeCheckpointService();
    service.stageAction({
      actionId: "action-1",
      runId: "run-1",
      sessionKey: "agent:main:main",
      kind: "messaging_delivery",
      checkpointId: "checkpoint-1",
      idempotencyKey: "request-1",
      target: {
        operation: "reply.send",
      },
    });
    service.markActionAttempted("action-1", {
      retryable: true,
    });
    service.markActionConfirmed("action-1", {
      receipt: {
        operation: "reply.send",
        resultStatus: "confirmed",
        deliveryResults: [
          {
            channel: "telegram",
            messageId: "msg-1",
            chatId: "chat-1",
          },
        ],
      },
    });

    const listHandler = createRuntimeActionListGatewayMethod(service);
    const getHandler = createRuntimeActionGetGatewayMethod(service);

    let listed: unknown;
    let fetched: unknown;
    void listHandler({
      params: {
        runId: "run-1",
        kind: "messaging_delivery",
        state: "confirmed",
        idempotencyKey: "request-1",
      },
      respond: (_ok: boolean, result: unknown) => {
        listed = result;
      },
    } as never);
    void getHandler({
      params: { actionId: "action-1" },
      respond: (_ok: boolean, result: unknown) => {
        fetched = result;
      },
    } as never);

    expect(listed).toEqual({
      actions: [
        expect.objectContaining({
          actionId: "action-1",
          runId: "run-1",
          kind: "messaging_delivery",
          state: "confirmed",
          checkpointId: "checkpoint-1",
          idempotencyKey: "request-1",
          attemptCount: 1,
          retryable: false,
        }),
      ],
    });
    expect(fetched).toEqual({
      action: expect.objectContaining({
        actionId: "action-1",
        state: "confirmed",
        receipt: expect.objectContaining({
          resultStatus: "confirmed",
          deliveryResults: [
            expect.objectContaining({
              channel: "telegram",
              messageId: "msg-1",
            }),
          ],
        }),
      }),
    });
  });

  it("filters runtime closure lists by request run id", () => {
    const service = createPlatformRuntimeCheckpointService();
    service.recordRunClosure(
      service.buildRunClosure({
        runId: "run-final",
        requestRunId: "request-1",
        parentRunId: "run-initial",
        sessionKey: "agent:main:main",
        outcome: {
          runId: "run-final",
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
        evidence: { hasOutput: true },
      }),
    );

    const listHandler = createRuntimeClosureListGatewayMethod(service);
    let listed: unknown;
    void listHandler({
      params: { requestRunId: "request-1" },
      respond: (_ok: boolean, result: unknown) => {
        listed = result;
      },
    } as never);

    expect(listed).toEqual({
      closures: [
        expect.objectContaining({
          runId: "run-final",
          requestRunId: "request-1",
          parentRunId: "run-initial",
        }),
      ],
    });
  });

  it("dispatches approved checkpoint continuations through the runtime gateway", async () => {
    const service = createPlatformRuntimeCheckpointService();
    service.registerContinuationHandler("bootstrap_run", async (checkpoint) => {
      service.updateCheckpoint(checkpoint.id, {
        status: "completed",
        completedAtMs: 123,
      });
    });
    service.createCheckpoint({
      id: "bootstrap-checkpoint",
      runId: "run-bootstrap",
      boundary: "bootstrap",
      status: "approved",
      target: {
        bootstrapRequestId: "bootstrap-1",
        operation: "bootstrap.run",
      },
      continuation: {
        kind: "bootstrap_run",
        state: "idle",
        attempts: 0,
      },
    } as never);

    const handler = createRuntimeCheckpointDispatchGatewayMethod(service);
    let ok = false;
    let result: unknown;
    await handler({
      params: { checkpointId: "bootstrap-checkpoint" },
      client: {
        connId: "conn-1",
        connect: {
          client: {
            id: "control-ui",
            displayName: "Operator Tanya",
          },
          device: {
            id: "device-1",
          },
        },
      } as never,
      respond: (success: boolean, payload: unknown) => {
        ok = success;
        result = payload;
      },
    } as never);

    expect(ok).toBe(true);
    expect(result).toEqual({
      checkpoint: expect.objectContaining({
        id: "bootstrap-checkpoint",
        status: "completed",
        lastOperatorDecision: expect.objectContaining({
          action: "dispatch",
          actor: expect.objectContaining({
            displayName: "Operator Tanya",
            deviceId: "device-1",
            connId: "conn-1",
          }),
        }),
        continuation: expect.objectContaining({
          kind: "bootstrap_run",
          state: "completed",
          attempts: 1,
        }),
      }),
    });
  });

  it("rejects dispatch when a checkpoint still requires explicit approval", async () => {
    const service = createPlatformRuntimeCheckpointService();
    service.createCheckpoint({
      id: "approval-checkpoint",
      runId: "run-approval",
      boundary: "exec_approval",
      status: "blocked",
      target: {
        approvalId: "approval-1",
        operation: "closure.recovery",
      },
      continuation: {
        kind: "closure_recovery",
        state: "idle",
        attempts: 0,
      },
    } as never);

    const handler = createRuntimeCheckpointDispatchGatewayMethod(service);
    let ok = true;
    let result: unknown;
    await handler({
      params: { checkpointId: "approval-checkpoint" },
      respond: (success: boolean, payload: unknown) => {
        ok = success;
        result = payload;
      },
    } as never);

    expect(ok).toBe(false);
    expect(result).toEqual({ error: "checkpoint still requires explicit approval" });
  });
});
