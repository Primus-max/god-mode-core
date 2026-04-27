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

const UUID_V4_REGEX =
  /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const SUBAGENT_KEY_REGEX = /agent:[a-z0-9_-]+:subagent:/i;

function expectSanitizedFailure(result: unknown): void {
  const text = JSON.stringify(result);
  expect(text).not.toContain("childSessionKey");
  expect(text).not.toContain("subagent_spawning");
  expect(text).not.toContain("subagent_delivery_target");
  expect(text).not.toMatch(SUBAGENT_KEY_REGEX);
  expect(text).not.toMatch(UUID_V4_REGEX);
}

function createBaseConfig(overrides?: { agents?: Record<string, unknown> }): OpenClawConfig {
  return {
    session: { mainKey: "main", scope: "per-sender" },
    agents: {
      list: [{ id: "main", workspace: "/tmp/workspace-main" }],
      ...(overrides?.agents ?? {}),
    },
  } as unknown as OpenClawConfig;
}

const requesterCtx = {
  agentSessionKey: "agent:main:main",
  agentChannel: "discord" as const,
  agentAccountId: "acct-1",
  agentTo: "channel:42",
  agentThreadId: "thread-7",
};

function setHookRunner(impl: Partial<{
  hasHooks: (name: string) => boolean;
  runSubagentSpawning: (...args: unknown[]) => Promise<unknown>;
  runSubagentSpawned: (...args: unknown[]) => Promise<unknown>;
  runSubagentEnded: (...args: unknown[]) => Promise<unknown>;
}>): void {
  getGlobalHookRunnerSpy.mockReturnValue({
    hasHooks: impl.hasHooks ?? (() => false),
    runSubagentSpawning: impl.runSubagentSpawning ?? (async () => undefined),
    runSubagentSpawned: impl.runSubagentSpawned ?? (async () => undefined),
    runSubagentEnded: impl.runSubagentEnded ?? (async () => undefined),
  } as unknown as ReturnType<typeof hookRunnerGlobal.getGlobalHookRunner>);
}

beforeEach(() => {
  callGatewaySpy.mockReset().mockImplementation((async ({ method }: { method?: string }) => {
    if (method === "agent") {
      return { runId: "run-1" };
    }
    return {};
  }) as unknown as typeof gatewayCall.callGateway);
  registerSubagentRunSpy.mockReset().mockImplementation((() => undefined) as unknown as typeof subagentRegistry.registerSubagentRun);
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
  getGlobalHookRunnerSpy.mockReset();
  setHookRunner({});
  setRuntimeConfigSnapshot(createBaseConfig());
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
});

describe("spawnSubagentDirect error surface", () => {
  it("forbids when caller exceeds spawn depth without leaking internals", async () => {
    getSubagentDepthSpy.mockReturnValue(99);
    const result = await spawnSubagentDirect({ task: "x" }, requesterCtx);
    expect(result.status).toBe("forbidden");
    expect(result.error).toContain("depth");
    expectSanitizedFailure(result);
  });

  it("forbids when active children quota is reached", async () => {
    countActiveRunsSpy.mockReturnValue(1000);
    const result = await spawnSubagentDirect({ task: "x" }, requesterCtx);
    expect(result.status).toBe("forbidden");
    expectSanitizedFailure(result);
  });

  it("rejects malformed agentId", async () => {
    const result = await spawnSubagentDirect(
      { task: "x", agentId: "Bad Id With Spaces" },
      requesterCtx,
    );
    expect(result.status).toBe("error");
    expectSanitizedFailure(result);
  });

  it("rejects mode=session without thread=true", async () => {
    const result = await spawnSubagentDirect(
      { task: "x", mode: "session", thread: false },
      requesterCtx,
    );
    expect(result.status).toBe("error");
    expectSanitizedFailure(result);
  });

  it("forbids unsandboxed target from sandboxed requester", async () => {
    resolveSandboxSpy.mockImplementation(((args: { sessionKey?: string }) => ({
      sandboxed: args.sessionKey === requesterCtx.agentSessionKey,
    })) as unknown as typeof sandboxRuntimeStatus.resolveSandboxRuntimeStatus);
    const result = await spawnSubagentDirect({ task: "x" }, requesterCtx);
    expect(result.status).toBe("forbidden");
    expectSanitizedFailure(result);
  });

  it("forbids sandbox=require when target runtime is unsandboxed", async () => {
    resolveSandboxSpy.mockReturnValue({ sandboxed: false } as ReturnType<
      typeof sandboxRuntimeStatus.resolveSandboxRuntimeStatus
    >);
    const result = await spawnSubagentDirect(
      { task: "x", sandbox: "require" },
      requesterCtx,
    );
    expect(result.status).toBe("forbidden");
    expectSanitizedFailure(result);
  });

  it("rejects invalid thinking level", async () => {
    const result = await spawnSubagentDirect(
      { task: "x", thinking: "not-a-real-level" },
      requesterCtx,
    );
    expect(result.status).toBe("error");
    expectSanitizedFailure(result);
  });

  it("returns sanitized error when initial sessions.patch fails", async () => {
    callGatewaySpy.mockImplementation((async ({ method }: { method?: string }) => {
      if (method === "sessions.patch") {
        throw new Error(
          "internal patch boom for agent:main:subagent:11111111-1111-4111-8111-111111111111",
        );
      }
      return {};
    }) as unknown as typeof gatewayCall.callGateway);
    const result = await spawnSubagentDirect({ task: "x" }, requesterCtx);
    expect(result.status).toBe("error");
    expect(result.error).toBe("Cannot start a subagent right now.");
    expectSanitizedFailure(result);
  });

  it("returns sanitized error when no channel plugin registered subagent_spawning hook", async () => {
    setHookRunner({ hasHooks: () => false });
    const result = await spawnSubagentDirect(
      { task: "x", thread: true, mode: "session" },
      requesterCtx,
    );
    expect(result.status).toBe("error");
    expect(result.error).toBe(
      "Persistent subagent sessions are not available in this channel yet.",
    );
    expectSanitizedFailure(result);
  });

  it("returns sanitized error when subagent_spawning hook errors", async () => {
    setHookRunner({
      hasHooks: (name) => name === "subagent_spawning",
      runSubagentSpawning: async () => ({
        status: "error",
        error:
          "delivery target subagent_delivery_target failed for agent:main:subagent:22222222-2222-4222-8222-222222222222",
      }),
    });
    const result = await spawnSubagentDirect(
      { task: "x", thread: true, mode: "session" },
      requesterCtx,
    );
    expect(result.status).toBe("error");
    expect(result.error).toBe(
      "Persistent subagent sessions are not available in this channel yet.",
    );
    expectSanitizedFailure(result);
  });

  it("returns sanitized error when subagent_spawning hook throws", async () => {
    setHookRunner({
      hasHooks: (name) => name === "subagent_spawning",
      runSubagentSpawning: async () => {
        throw new Error(
          "boom 33333333-3333-4333-8333-333333333333 in subagent_spawning",
        );
      },
    });
    const result = await spawnSubagentDirect(
      { task: "x", thread: true, mode: "session" },
      requesterCtx,
    );
    expect(result.status).toBe("error");
    expect(result.error).toBe("Cannot start a subagent right now.");
    expectSanitizedFailure(result);
  });

  it("returns sanitized error when materializeSubagentAttachments fails", async () => {
    materializeAttachmentsSpy.mockResolvedValue({
      status: "error",
      error: "Attachment too large.",
    } as unknown as Awaited<
      ReturnType<typeof subagentAttachments.materializeSubagentAttachments>
    >);
    const result = await spawnSubagentDirect(
      {
        task: "x",
        attachments: [{ name: "f.txt", content: "a", encoding: "utf8" }],
      },
      requesterCtx,
    );
    expect(result.status).toBe("error");
    expectSanitizedFailure(result);
  });

  it("returns sanitized error when spawn lineage patch fails", async () => {
    let patchCount = 0;
    callGatewaySpy.mockImplementation((async ({
      method,
      params,
    }: {
      method?: string;
      params?: Record<string, unknown>;
    }) => {
      if (method === "sessions.patch") {
        patchCount += 1;
        if (typeof params?.spawnedBy === "string") {
          throw new Error(
            "lineage patch failed for agent:main:subagent:44444444-4444-4444-8444-444444444444",
          );
        }
        return {};
      }
      if (method === "agent") {
        return { runId: "run-1" };
      }
      return {};
    }) as unknown as typeof gatewayCall.callGateway);
    const result = await spawnSubagentDirect({ task: "x" }, requesterCtx);
    expect(patchCount).toBeGreaterThanOrEqual(2);
    expect(result.status).toBe("error");
    expect(result.error).toBe("Cannot start a subagent right now.");
    expectSanitizedFailure(result);
  });

  it("returns sanitized error when gateway dispatch fails", async () => {
    callGatewaySpy.mockImplementation((async ({ method }: { method?: string }) => {
      if (method === "agent") {
        throw new Error(
          "dispatch failure for run 55555555-5555-4555-8555-555555555555",
        );
      }
      return {};
    }) as unknown as typeof gatewayCall.callGateway);
    const result = await spawnSubagentDirect({ task: "x" }, requesterCtx);
    expect(result.status).toBe("error");
    expect(result.error).toBe("Cannot start a subagent right now.");
    expectSanitizedFailure(result);
  });

  it("returns sanitized error when registerSubagentRun throws", async () => {
    registerSubagentRunSpy.mockImplementation((() => {
      throw new Error(
        "registry blew up for agent:main:subagent:66666666-6666-4666-8666-666666666666",
      );
    }) as unknown as typeof subagentRegistry.registerSubagentRun);
    const result = await spawnSubagentDirect({ task: "x" }, requesterCtx);
    expect(result.status).toBe("error");
    expect(result.error).toBe("Cannot start a subagent right now.");
    expectSanitizedFailure(result);
  });

  it("success path keeps childSessionKey on status=accepted", async () => {
    const result = await spawnSubagentDirect({ task: "x" }, requesterCtx);
    expect(result.status).toBe("accepted");
    expect(result.childSessionKey).toMatch(SUBAGENT_KEY_REGEX);
    expect(result.runId).toBeTruthy();
  });

  // PR-1.5 — runtime result schema extension. The boundary now carries
  // `agentId` (branded AgentId) and `parentSessionKey` (branded SessionKey
  // | null) on status=accepted. PR-3 observer reads these as pure values
  // from the followupRegistry; on error/forbidden both fields stay
  // undefined (dropped by sanitization).
  describe("PR-1.5 spawn boundary metadata", () => {
    it("populates agentId from the resolved targetAgentId on accepted spawn", async () => {
      const result = await spawnSubagentDirect(
        { task: "x", agentId: "main" },
        requesterCtx,
      );
      expect(result.status).toBe("accepted");
      expect(result.agentId).toBe("main");
    });

    it("populates parentSessionKey from the requester internal session key", async () => {
      const result = await spawnSubagentDirect({ task: "x" }, requesterCtx);
      expect(result.status).toBe("accepted");
      // requesterCtx.agentSessionKey == "agent:main:main" -> resolved to the
      // canonical main alias by resolveInternalSessionKey. The exact alias
      // value depends on the resolver, but it must be a non-empty string
      // (never undefined or null on accepted with an explicit caller).
      expect(typeof result.parentSessionKey).toBe("string");
      expect(result.parentSessionKey).toBeTruthy();
    });

    it("does not surface agentId or parentSessionKey on forbidden spawn", async () => {
      getSubagentDepthSpy.mockReturnValue(99);
      const result = await spawnSubagentDirect({ task: "x" }, requesterCtx);
      expect(result.status).toBe("forbidden");
      expect(result.agentId).toBeUndefined();
      expect(result.parentSessionKey).toBeUndefined();
    });

    it("does not surface agentId or parentSessionKey on error spawn", async () => {
      const result = await spawnSubagentDirect(
        { task: "x", agentId: "Bad Id With Spaces" },
        requesterCtx,
      );
      expect(result.status).toBe("error");
      expect(result.agentId).toBeUndefined();
      expect(result.parentSessionKey).toBeUndefined();
    });
  });
});
