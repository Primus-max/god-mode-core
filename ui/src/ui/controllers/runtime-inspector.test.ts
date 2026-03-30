import { describe, expect, it, vi } from "vitest";
import {
  clearRuntimeInspectorScope,
  loadRuntimeCheckpointDetail,
  loadRuntimeInspector,
  type RuntimeInspectorState,
} from "./runtime-inspector.ts";

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;

function createState(
  request: RequestFn,
  overrides: Partial<RuntimeInspectorState> = {},
): RuntimeInspectorState {
  return {
    client: { request } as unknown as RuntimeInspectorState["client"],
    connected: true,
    runtimeLoading: false,
    runtimeDetailLoading: false,
    runtimeError: null,
    runtimeSessionKey: null,
    runtimeRunId: null,
    runtimeStatus: "",
    runtimeCheckpoints: [],
    runtimeSelectedCheckpointId: null,
    runtimeCheckpointDetail: null,
    runtimeActions: [],
    runtimeSelectedActionId: null,
    runtimeActionDetail: null,
    runtimeClosures: [],
    runtimeSelectedClosureRunId: null,
    runtimeClosureDetail: null,
    ...overrides,
  };
}

describe("runtime inspector controller", () => {
  it("loads checkpoints plus related action and closure details", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "platform.runtime.checkpoints.list") {
        expect(params).toEqual({ sessionKey: "agent:main:main" });
        return {
          checkpoints: [
            {
              id: "cp-1",
              runId: "run-1",
              sessionKey: "agent:main:main",
              boundary: "bootstrap",
              status: "blocked",
              createdAtMs: 1,
              updatedAtMs: 2,
              operatorHint: "Awaiting operator approval.",
            },
          ],
        };
      }
      if (method === "platform.runtime.checkpoints.get") {
        expect(params).toEqual({ checkpointId: "cp-1" });
        return {
          checkpoint: {
            id: "cp-1",
            runId: "run-1",
            sessionKey: "agent:main:main",
            boundary: "bootstrap",
            status: "blocked",
            createdAtMs: 1,
            updatedAtMs: 2,
            operatorHint: "Awaiting operator approval.",
            continuation: {
              kind: "bootstrap_run",
              state: "idle",
              attempts: 0,
            },
          },
        };
      }
      if (method === "platform.runtime.actions.list") {
        expect(params).toEqual({ checkpointId: "cp-1", runId: "run-1" });
        return {
          actions: [
            {
              actionId: "action-1",
              runId: "run-1",
              kind: "bootstrap",
              state: "attempted",
              attemptCount: 1,
              createdAtMs: 1,
              updatedAtMs: 2,
            },
          ],
        };
      }
      if (method === "platform.runtime.actions.get") {
        expect(params).toEqual({ actionId: "action-1" });
        return {
          action: {
            actionId: "action-1",
            runId: "run-1",
            kind: "bootstrap",
            state: "attempted",
            attemptCount: 1,
            createdAtMs: 1,
            updatedAtMs: 2,
            receipt: {
              resultStatus: "attempted",
            },
          },
        };
      }
      if (method === "platform.runtime.closures.list") {
        expect(params).toEqual({ sessionKey: "agent:main:main" });
        return {
          closures: [
            {
              runId: "run-1",
              sessionKey: "agent:main:main",
              updatedAtMs: 2,
              outcomeStatus: "completed",
              verificationStatus: "success",
              acceptanceStatus: "accepted",
              action: "allow",
              remediation: "none",
              reasonCode: "completed",
              reasons: [],
            },
          ],
        };
      }
      if (method === "platform.runtime.closures.get") {
        expect(params).toEqual({ runId: "run-1" });
        return {
          closure: {
            runId: "run-1",
            sessionKey: "agent:main:main",
            updatedAtMs: 2,
            outcome: {
              runId: "run-1",
              status: "completed",
              checkpointIds: ["cp-1"],
              blockedCheckpointIds: [],
              completedCheckpointIds: ["cp-1"],
              deniedCheckpointIds: [],
              pendingApprovalIds: [],
              artifactIds: [],
              bootstrapRequestIds: [],
              actionIds: ["action-1"],
              attemptedActionIds: ["action-1"],
              confirmedActionIds: [],
              failedActionIds: [],
              boundaries: ["bootstrap"],
            },
            executionIntent: {
              intent: "general",
            },
            executionVerification: {
              status: "success",
              receipts: [],
            },
            acceptanceOutcome: {
              status: "accepted",
              action: "allow",
              remediation: "none",
              reasons: [],
            },
            supervisorVerdict: {
              action: "allow",
              remediation: "none",
              reasonCode: "completed",
              reasons: [],
              recoveryPolicy: {
                maxAttempts: 0,
                strategy: "stop",
              },
            },
          },
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request);

    await loadRuntimeInspector(state, { sessionKey: "agent:main:main" });

    expect(state.runtimeSessionKey).toBe("agent:main:main");
    expect(state.runtimeCheckpoints).toHaveLength(1);
    expect(state.runtimeCheckpointDetail?.id).toBe("cp-1");
    expect(state.runtimeActions[0]?.actionId).toBe("action-1");
    expect(state.runtimeActionDetail?.receipt?.resultStatus).toBe("attempted");
    expect(state.runtimeClosures[0]?.runId).toBe("run-1");
    expect(state.runtimeClosureDetail?.runId).toBe("run-1");
  });

  it("can clear runtime scope back to global", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "platform.runtime.checkpoints.list") {
        return { checkpoints: [] };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request, {
      runtimeSessionKey: "agent:main:main",
      runtimeRunId: "run-1",
    });

    await clearRuntimeInspectorScope(state);

    expect(state.runtimeSessionKey).toBeNull();
    expect(state.runtimeRunId).toBeNull();
  });

  it("stores detail errors without throwing", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "platform.runtime.checkpoints.get") {
        throw new Error("checkpoint failed");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request);

    await loadRuntimeCheckpointDetail(state, "cp-1");

    expect(state.runtimeCheckpointDetail).toBeNull();
    expect(state.runtimeError).toContain("checkpoint failed");
  });
});
