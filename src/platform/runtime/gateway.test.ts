import { describe, expect, it } from "vitest";
import {
  createRuntimeCheckpointGetGatewayMethod,
  createRuntimeCheckpointListGatewayMethod,
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

    const listHandler = createRuntimeCheckpointListGatewayMethod(service);
    const getHandler = createRuntimeCheckpointGetGatewayMethod(service);

    let listed: unknown;
    let fetched: unknown;
    listHandler({
      params: {},
      respond: (_ok: boolean, result: unknown) => {
        listed = result;
      },
    } as never);
    getHandler({
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
        continuation: expect.objectContaining({
          kind: "closure_recovery",
          state: "idle",
          attempts: 0,
        }),
      }),
    });
    expect((fetched as { checkpoint: { continuation?: { input?: unknown } } }).checkpoint.continuation?.input)
      .toBeUndefined();
  });
});
