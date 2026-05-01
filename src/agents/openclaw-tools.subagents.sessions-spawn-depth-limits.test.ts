import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getCallGatewayMock,
  getSessionsSpawnTool,
  resetSessionsSpawnConfigOverride,
  setSessionsSpawnConfigOverride,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";
import { createPerSenderSessionConfig } from "./test-helpers/session-config.js";

let storeTemplatePath = "";

const callGatewayMock = getCallGatewayMock();

function writeStore(agentId: string, store: Record<string, unknown>) {
  const storePath = storeTemplatePath.replaceAll("{agentId}", agentId);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
}

function setSubagentLimits(subagents: Record<string, unknown>) {
  setSessionsSpawnConfigOverride({
    session: createPerSenderSessionConfig({ store: storeTemplatePath }),
    agents: {
      defaults: {
        subagents,
      },
    },
  });
}

function seedDepthTwoAncestryStore(params?: { sessionIds?: boolean }) {
  const depth1 = "agent:main:subagent:depth-1";
  const callerKey = "agent:main:subagent:depth-2";
  writeStore("main", {
    [depth1]: {
      sessionId: params?.sessionIds ? "depth-1-session" : "depth-1",
      updatedAt: Date.now(),
      spawnedBy: "agent:main:main",
    },
    [callerKey]: {
      sessionId: params?.sessionIds ? "depth-2-session" : "depth-2",
      updatedAt: Date.now(),
      spawnedBy: depth1,
    },
  });
  return { depth1, callerKey };
}

describe("sessions_spawn depth + child limits", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    resetSessionsSpawnConfigOverride();
    callGatewayMock.mockClear();
    storeTemplatePath = path.join(
      os.tmpdir(),
      `openclaw-subagent-depth-${Date.now()}-${Math.random().toString(16).slice(2)}-{agentId}.json`,
    );
    setSessionsSpawnConfigOverride({
      session: createPerSenderSessionConfig({ store: storeTemplatePath }),
    });

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const req = opts as { method?: string };
      if (req.method === "agent") {
        return { runId: "run-depth" };
      }
      if (req.method === "agent.wait") {
        return { status: "running" };
      }
      return {};
    });
  });

  it("rejects spawning when caller depth reaches maxSpawnDepth", async () => {
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "agent:main:subagent:parent",
      workspaceDir: "/parent/workspace",
    });
    const result = await tool.execute("call-depth-reject", { task: "hello" });

    expect(result.details).toMatchObject({
      status: "forbidden",
      error:
        "sessions_spawn is not allowed at this depth (current depth: 1, max: 1). Subagent nesting stays intentionally bounded—raise maxSpawnDepth only for a controlled extra hop, not deep planner stacks.",
    });
  });

  it("allows depth-1 callers when maxSpawnDepth is 2", async () => {
    setSubagentLimits({ maxSpawnDepth: 2 });

    const tool = await getSessionsSpawnTool({ agentSessionKey: "agent:main:subagent:parent" });
    const result = await tool.execute("call-depth-allow", { task: "hello" });

    expect(result.details).toMatchObject({
      status: "accepted",
      childSessionKey: expect.stringMatching(/^agent:main:subagent:/),
      runId: "run-depth",
    });

    const calls = callGatewayMock.mock.calls.map(
      (call) => call[0] as { method?: string; params?: Record<string, unknown> },
    );
    const spawnedByPatch = calls.find(
      (entry) =>
        entry.method === "sessions.patch" &&
        entry.params?.spawnedBy === "agent:main:subagent:parent",
    );
    expect(spawnedByPatch?.params?.key).toMatch(/^agent:main:subagent:/);
    expect(typeof spawnedByPatch?.params?.spawnedWorkspaceDir).toBe("string");

    const spawnDepthPatch = calls.find(
      (entry) => entry.method === "sessions.patch" && entry.params?.spawnDepth === 2,
    );
    expect(spawnDepthPatch?.params?.key).toMatch(/^agent:main:subagent:/);
    expect(spawnDepthPatch?.params?.subagentRole).toBe("leaf");
    expect(spawnDepthPatch?.params?.subagentControlScope).toBe("none");
  });

  it("rejects depth-2 callers when maxSpawnDepth is 2 (using stored spawnDepth on flat keys)", async () => {
    setSubagentLimits({ maxSpawnDepth: 2 });

    const callerKey = "agent:main:subagent:flat-depth-2";
    writeStore("main", {
      [callerKey]: {
        sessionId: "flat-depth-2",
        updatedAt: Date.now(),
        spawnDepth: 2,
      },
    });

    const tool = await getSessionsSpawnTool({ agentSessionKey: callerKey });
    const result = await tool.execute("call-depth-2-reject", { task: "hello" });

    expect(result.details).toMatchObject({
      status: "forbidden",
      error:
        "sessions_spawn is not allowed at this depth (current depth: 2, max: 2). Subagent nesting stays intentionally bounded—raise maxSpawnDepth only for a controlled extra hop, not deep planner stacks.",
    });
  });

  it("rejects depth-2 callers when spawnDepth is missing but spawnedBy ancestry implies depth 2", async () => {
    setSubagentLimits({ maxSpawnDepth: 2 });
    const { callerKey } = seedDepthTwoAncestryStore();

    const tool = await getSessionsSpawnTool({ agentSessionKey: callerKey });
    const result = await tool.execute("call-depth-ancestry-reject", { task: "hello" });

    expect(result.details).toMatchObject({
      status: "forbidden",
      error:
        "sessions_spawn is not allowed at this depth (current depth: 2, max: 2). Subagent nesting stays intentionally bounded—raise maxSpawnDepth only for a controlled extra hop, not deep planner stacks.",
    });
  });

  it("rejects depth-2 callers when the requester key is a sessionId", async () => {
    setSubagentLimits({ maxSpawnDepth: 2 });
    seedDepthTwoAncestryStore({ sessionIds: true });

    const tool = await getSessionsSpawnTool({ agentSessionKey: "depth-2-session" });
    const result = await tool.execute("call-depth-sessionid-reject", { task: "hello" });

    expect(result.details).toMatchObject({
      status: "forbidden",
      error:
        "sessions_spawn is not allowed at this depth (current depth: 2, max: 2). Subagent nesting stays intentionally bounded—raise maxSpawnDepth only for a controlled extra hop, not deep planner stacks.",
    });
  });

  it("rejects when active children for requester session reached maxChildrenPerAgent", async () => {
    setSessionsSpawnConfigOverride({
      session: createPerSenderSessionConfig({ store: storeTemplatePath }),
      agents: {
        defaults: {
          subagents: {
            maxSpawnDepth: 2,
            maxChildrenPerAgent: 1,
          },
        },
      },
    });

    const tool = await getSessionsSpawnTool({ agentSessionKey: "agent:main:subagent:parent" });
    // getSessionsSpawnTool resets modules; use the same registry instance spawn reads.
    const { addSubagentRunForTests: addRun } = await import("./subagent-registry.js");
    addRun({
      runId: "existing-run",
      childSessionKey: "agent:main:subagent:existing",
      requesterSessionKey: "agent:main:subagent:parent",
      requesterDisplayKey: "agent:main:subagent:parent",
      task: "existing",
      cleanup: "keep",
      createdAt: Date.now(),
      startedAt: Date.now(),
    });

    const result = await tool.execute("call-max-children", { task: "hello" });

    expect(result.details).toMatchObject({
      status: "forbidden",
      error:
        "sessions_spawn has reached max active children for this session (1/1). This caps fan-out per session; finish or kill in-flight children before spawning more.",
    });
  });

  it("does not use subagent maxConcurrent as a per-parent spawn gate", async () => {
    setSessionsSpawnConfigOverride({
      session: createPerSenderSessionConfig({ store: storeTemplatePath }),
      agents: {
        defaults: {
          subagents: {
            maxSpawnDepth: 2,
            maxChildrenPerAgent: 5,
            maxConcurrent: 1,
          },
        },
      },
    });

    const tool = await getSessionsSpawnTool({ agentSessionKey: "agent:main:subagent:parent" });
    const result = await tool.execute("call-max-concurrent-independent", { task: "hello" });

    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-depth",
    });
  });

  it("fails spawn when sessions.patch rejects the model", async () => {
    setSubagentLimits({ maxSpawnDepth: 2 });
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const req = opts as { method?: string; params?: { model?: string } };
      if (req.method === "sessions.patch" && req.params?.model === "bad-model") {
        throw new Error("invalid model: bad-model");
      }
      if (req.method === "agent") {
        return { runId: "run-depth" };
      }
      if (req.method === "agent.wait") {
        return { status: "running" };
      }
      return {};
    });

    const tool = await getSessionsSpawnTool({ agentSessionKey: "main" });
    const result = await tool.execute("call-model-reject", {
      task: "hello",
      model: "bad-model",
    });

    expect(result.details).toMatchObject({
      status: "error",
    });
    expect(String((result.details as { error?: string }).error ?? "")).toContain("invalid model");
    expect(
      callGatewayMock.mock.calls.some(
        (call) => (call[0] as { method?: string }).method === "agent",
      ),
    ).toBe(false);
  });
});
