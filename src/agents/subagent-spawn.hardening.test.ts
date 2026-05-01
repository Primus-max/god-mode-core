import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  type OpenClawConfig,
  setRuntimeConfigSnapshot,
} from "../config/config.js";
import * as gatewayCall from "../gateway/call.js";
import * as hookRunnerGlobal from "../plugins/hook-runner-global.js";
import * as sandboxRuntimeStatus from "./sandbox/runtime-status.js";
import * as subagentAttachments from "./subagent-attachments.js";
import * as subagentDepth from "./subagent-depth.js";
import * as subagentRegistry from "./subagent-registry.js";

const callGatewaySpy = vi.spyOn(gatewayCall, "callGateway");
const registerSubagentRunSpy = vi.spyOn(subagentRegistry, "registerSubagentRun");
const countActiveRunsSpy = vi.spyOn(subagentRegistry, "countActiveRunsForSession");
const getSubagentDepthSpy = vi.spyOn(subagentDepth, "getSubagentDepthFromSessionStore");
const resolveSandboxSpy = vi.spyOn(sandboxRuntimeStatus, "resolveSandboxRuntimeStatus");
const materializeAttachmentsSpy = vi.spyOn(subagentAttachments, "materializeSubagentAttachments");
const getGlobalHookRunnerSpy = vi.spyOn(hookRunnerGlobal, "getGlobalHookRunner");

const { spawnSubagentDirect } = await import("./subagent-spawn.js");

type AgentEntryConfig = {
  id: string;
  workspace?: string;
  subagents?: { allowAgents?: string[] };
};

type AgentsBlock = {
  list?: AgentEntryConfig[];
  defaults?: {
    subagents?: { allowAgents?: string[] };
  };
  requireAgentId?: boolean;
};

function createBaseConfig(overrides: { agents?: AgentsBlock } = {}): OpenClawConfig {
  return {
    session: { mainKey: "main", scope: "per-sender" },
    agents: {
      list: [{ id: "main", workspace: "/tmp/workspace-main" }],
      ...overrides.agents,
    },
  } as unknown as OpenClawConfig;
}

function setConfig(cfg: OpenClawConfig): void {
  setRuntimeConfigSnapshot(cfg);
}

function gatewayAcceptingAll(): void {
  callGatewaySpy.mockImplementation((async ({ method }: { method?: string }) => {
    if (method === "agent") {
      return { runId: "run-1" };
    }
    return {};
  }) as unknown as typeof gatewayCall.callGateway);
}

const requesterCtx = {
  agentSessionKey: "agent:main:main",
  agentChannel: "telegram",
  agentAccountId: "123",
  agentTo: "456",
};

beforeEach(() => {
  callGatewaySpy.mockReset();
  registerSubagentRunSpy.mockReset();
  countActiveRunsSpy.mockReset().mockReturnValue(0);
  getSubagentDepthSpy.mockReset().mockReturnValue(0);
  resolveSandboxSpy
    .mockReset()
    .mockReturnValue({ sandboxed: false } as ReturnType<
      typeof sandboxRuntimeStatus.resolveSandboxRuntimeStatus
    >);
  materializeAttachmentsSpy
    .mockReset()
    .mockResolvedValue(undefined as unknown as Awaited<
      ReturnType<typeof subagentAttachments.materializeSubagentAttachments>
    >);
  getGlobalHookRunnerSpy.mockReset().mockReturnValue({
    hasHooks: () => false,
    runSubagentSpawned: async () => undefined,
    runSubagentEnded: async () => undefined,
  } as unknown as ReturnType<typeof hookRunnerGlobal.getGlobalHookRunner>);
  registerSubagentRunSpy.mockImplementation((() => undefined) as unknown as typeof subagentRegistry.registerSubagentRun);

  setConfig(createBaseConfig());
  gatewayAcceptingAll();
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
});

describe("spawnSubagentDirect — allowAgents fallback (a57766bad0)", () => {
  it("falls back to defaults.subagents.allowAgents when per-agent entry is missing", async () => {
    setConfig(
      createBaseConfig({
        agents: {
          list: [
            { id: "main", workspace: "/tmp/workspace-main" },
            { id: "ops", workspace: "/tmp/workspace-ops" },
          ],
          defaults: { subagents: { allowAgents: ["*"] } },
        },
      }),
    );

    const result = await spawnSubagentDirect({ task: "do thing", agentId: "ops" }, requesterCtx);

    expect(result.status).toBe("accepted");
  });

  it("forbids cross-agent spawn when neither per-agent nor defaults set allowAgents", async () => {
    setConfig(
      createBaseConfig({
        agents: {
          list: [
            { id: "main", workspace: "/tmp/workspace-main" },
            { id: "ops", workspace: "/tmp/workspace-ops" },
          ],
        },
      }),
    );

    const result = await spawnSubagentDirect({ task: "do thing", agentId: "ops" }, requesterCtx);

    expect(result.status).toBe("forbidden");
    expect(result.error ?? "").toMatch(/agentId is not allowed/);
  });
});

describe("spawnSubagentDirect — non-thread spawn cleanup (b72d0c8459)", () => {
  it("calls sessions.delete when a non-thread spawn fails after the child session is created", async () => {
    const deletes: string[] = [];
    const patches: string[] = [];
    callGatewaySpy.mockImplementation((async ({
      method,
      params,
    }: {
      method?: string;
      params?: { key?: string };
    }) => {
      if (method === "sessions.patch") {
        if (params?.key) {
          patches.push(params.key);
        }
        return {};
      }
      if (method === "agent") {
        throw new Error("simulated post-create spawn failure");
      }
      if (method === "sessions.delete") {
        if (params?.key) {
          deletes.push(params.key);
        }
        return {};
      }
      return {};
    }) as unknown as typeof gatewayCall.callGateway);

    const result = await spawnSubagentDirect({ task: "fail-me", thread: false }, requesterCtx);

    expect(result.status).toBe("error");
    // After error-surface hardening, internal child session keys must NOT be
    // returned to the LLM; capture the key from the patch call instead.
    expect(result.childSessionKey).toBeUndefined();
    expect(patches.length).toBeGreaterThan(0);
    const childKey = patches[0];
    expect(deletes).toContain(childKey);
  });
});

describe("spawnSubagentDirect — register-failure cleanup (79ef86c305)", () => {
  it("tears down the provisional session when registry.register throws and returns a sanitized error", async () => {
    const deletes: string[] = [];
    callGatewaySpy.mockImplementation((async ({
      method,
      params,
    }: {
      method?: string;
      params?: { key?: string };
    }) => {
      if (method === "agent") {
        return { runId: "run-1" };
      }
      if (method === "sessions.delete") {
        if (params?.key) {
          deletes.push(params.key);
        }
        return {};
      }
      return {};
    }) as unknown as typeof gatewayCall.callGateway);
    registerSubagentRunSpy.mockImplementation((() => {
      throw new Error("registry blew up");
    }) as unknown as typeof subagentRegistry.registerSubagentRun);

    const result = await spawnSubagentDirect({ task: "register-fail" }, requesterCtx);

    expect(result.status).toBe("error");
    expect(result.childSessionKey).toBeUndefined();
    expect(result.runId).toBeUndefined();
    expect(result.error ?? "").not.toContain("agent:");
    expect(result.error ?? "").not.toContain("subagent:");
    expect(deletes.length).toBeGreaterThan(0);
  });
});

describe("spawnSubagentDirect — requireAgentId guard (d4cccda570)", () => {
  it("forbids spawn when cfg.agents.requireAgentId is true and no agentId can be resolved", async () => {
    setConfig(
      createBaseConfig({
        agents: {
          list: [{ id: "main", workspace: "/tmp/workspace-main" }],
          requireAgentId: true,
        },
      }),
    );

    const result = await spawnSubagentDirect(
      { task: "no-agent" },
      { agentChannel: "telegram", agentAccountId: "1", agentTo: "2" },
    );

    expect(result.status).toBe("forbidden");
    expect(result.error ?? "").toMatch(/explicit agentId/i);
  });

  it("does not affect behavior when the flag is unset", async () => {
    setConfig(
      createBaseConfig({
        agents: {
          list: [{ id: "main", workspace: "/tmp/workspace-main" }],
        },
      }),
    );

    const result = await spawnSubagentDirect(
      { task: "no-agent" },
      { agentChannel: "telegram", agentAccountId: "1", agentTo: "2" },
    );

    expect(result.status).toBe("accepted");
  });
});
