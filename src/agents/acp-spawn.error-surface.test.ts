import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as acpSessionManager from "../acp/control-plane/manager.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import * as sessionConfig from "../config/sessions.js";
import * as sessionTranscript from "../config/sessions/transcript.js";
import * as gatewayCall from "../gateway/call.js";
import * as heartbeatWake from "../infra/heartbeat-wake.js";
import {
  __testing as sessionBindingServiceTesting,
  registerSessionBindingAdapter,
  type SessionBindingAdapterCapabilities,
  type SessionBindingPlacement,
} from "../infra/outbound/session-binding-service.js";
import * as acpSpawnParentStream from "./acp-spawn-parent-stream.js";

const callGatewaySpy = vi.spyOn(gatewayCall, "callGateway");
const getAcpSessionManagerSpy = vi.spyOn(acpSessionManager, "getAcpSessionManager");
const loadSessionStoreSpy = vi.spyOn(sessionConfig, "loadSessionStore");
const resolveStorePathSpy = vi.spyOn(sessionConfig, "resolveStorePath");
const resolveSessionTranscriptFileSpy = vi.spyOn(sessionTranscript, "resolveSessionTranscriptFile");
const areHeartbeatsEnabledSpy = vi.spyOn(heartbeatWake, "areHeartbeatsEnabled");
const startAcpSpawnParentStreamRelaySpy = vi.spyOn(
  acpSpawnParentStream,
  "startAcpSpawnParentStreamRelay",
);
const resolveAcpSpawnStreamLogPathSpy = vi.spyOn(
  acpSpawnParentStream,
  "resolveAcpSpawnStreamLogPath",
);

const { spawnAcpDirect } = await import("./acp-spawn.js");

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

function createCfg(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    acp: {
      enabled: true,
      backend: "acpx",
      allowedAgents: ["codex"],
    },
    session: {
      mainKey: "main",
      scope: "per-sender",
    },
    channels: {
      discord: {
        threadBindings: {
          enabled: true,
          spawnAcpSessions: true,
        },
      },
    },
    ...overrides,
  } as OpenClawConfig;
}

function setCfg(cfg: OpenClawConfig): void {
  setRuntimeConfigSnapshot(cfg);
}

function createBindingCapabilities(): SessionBindingAdapterCapabilities {
  return {
    bindSupported: true,
    unbindSupported: true,
    placements: ["current", "child"] satisfies SessionBindingPlacement[],
  };
}

function registerHappyDiscordAdapter(): void {
  registerSessionBindingAdapter({
    channel: "discord",
    accountId: "default",
    capabilities: createBindingCapabilities(),
    bind: async (input) => ({
      bindingId: "default:child-thread",
      targetSessionKey: input.targetSessionKey,
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: input.conversation.accountId,
        conversationId: "child-thread",
        parentConversationId: "parent-channel",
      },
      status: "active",
      boundAt: Date.now(),
      metadata: { agentId: "codex", boundBy: "system" },
    }),
    listBySession: () => [],
    resolveByConversation: () => null,
    unbind: async () => [],
  });
}

beforeEach(() => {
  setCfg(createCfg());
  callGatewaySpy.mockReset().mockImplementation((async ({ method }: { method?: string }) => {
    if (method === "agent") {
      return { runId: "run-1" };
    }
    return {};
  }) as unknown as typeof gatewayCall.callGateway);
  getAcpSessionManagerSpy.mockReset().mockReturnValue({
    initializeSession: vi.fn(async (args: unknown) => {
      const typed = args as { sessionKey: string; agent: string; mode: string; cwd?: string };
      return {
        runtime: { close: vi.fn().mockResolvedValue(undefined) },
        handle: {
          sessionKey: typed.sessionKey,
          backend: "acpx",
          runtimeSessionName: `${typed.sessionKey}:runtime`,
          agentSessionId: "codex-inner-1",
          backendSessionId: "acpx-1",
        },
        meta: {
          backend: "acpx",
          agent: typed.agent,
          runtimeSessionName: `${typed.sessionKey}:runtime`,
          identity: {
            state: "pending",
            source: "ensure",
            acpxSessionId: "acpx-1",
            agentSessionId: "codex-inner-1",
            lastUpdatedAt: Date.now(),
          },
          mode: typed.mode,
          state: "idle",
          lastActivityAt: Date.now(),
        },
      };
    }),
    closeSession: vi.fn().mockResolvedValue({ runtimeClosed: true, metaCleared: false }),
  } as unknown as ReturnType<typeof acpSessionManager.getAcpSessionManager>);
  loadSessionStoreSpy.mockReset().mockReturnValue(
    new Proxy({} as Record<string, { sessionId: string; updatedAt: number }>, {
      get(_t, prop) {
        if (typeof prop === "string" && prop.startsWith("agent:codex:acp:")) {
          return { sessionId: "sess-123", updatedAt: Date.now() };
        }
        return undefined;
      },
    }),
  );
  resolveStorePathSpy.mockReset().mockReturnValue("/tmp/codex-sessions.json");
  resolveSessionTranscriptFileSpy.mockReset().mockImplementation(async (params) => {
    const typed = params as { threadId?: string };
    const sessionFile = typed.threadId
      ? `/tmp/agents/codex/sessions/sess-123-topic-${typed.threadId}.jsonl`
      : "/tmp/agents/codex/sessions/sess-123.jsonl";
    return {
      sessionFile,
      sessionEntry: { sessionId: "sess-123", updatedAt: Date.now(), sessionFile },
    };
  });
  areHeartbeatsEnabledSpy.mockReset().mockReturnValue(true);
  startAcpSpawnParentStreamRelaySpy
    .mockReset()
    .mockReturnValue({ dispose: vi.fn(), notifyStarted: vi.fn() } as unknown as ReturnType<
      typeof acpSpawnParentStream.startAcpSpawnParentStreamRelay
    >);
  resolveAcpSpawnStreamLogPathSpy.mockReset().mockReturnValue("/tmp/sess.acp-stream.jsonl");
  sessionBindingServiceTesting.resetSessionBindingAdaptersForTests();
});

afterEach(() => {
  sessionBindingServiceTesting.resetSessionBindingAdaptersForTests();
  clearRuntimeConfigSnapshot();
});

describe("spawnAcpDirect error surface", () => {
  const baseRequest = { task: "x", agentId: "codex" } as const;
  const baseCtx = {
    agentSessionKey: "agent:main:main",
    agentChannel: "discord" as const,
    agentAccountId: "default",
    agentTo: "channel:parent",
    agentThreadId: "1",
  };

  it("forbids when ACP disabled by policy", async () => {
    setCfg(createCfg({ acp: { enabled: false } }));
    const result = await spawnAcpDirect(baseRequest, baseCtx);
    expect(result.status).toBe("forbidden");
    expectSanitizedFailure(result);
  });

  it("rejects streamTo=parent without requester session", async () => {
    const result = await spawnAcpDirect(
      { ...baseRequest, streamTo: "parent" },
      { ...baseCtx, agentSessionKey: undefined },
    );
    expect(result.status).toBe("error");
    expectSanitizedFailure(result);
  });

  it("rejects mode=session without thread=true", async () => {
    const result = await spawnAcpDirect(
      { ...baseRequest, mode: "session" },
      baseCtx,
    );
    expect(result.status).toBe("error");
    expectSanitizedFailure(result);
  });

  it("rejects unknown agentId", async () => {
    const result = await spawnAcpDirect(
      { ...baseRequest, agentId: "unknown-agent" },
      baseCtx,
    );
    expect(["error", "forbidden"]).toContain(result.status);
    expectSanitizedFailure(result);
  });

  it("forbids agent disallowed by policy", async () => {
    setCfg(createCfg({ acp: { enabled: true, backend: "acpx", allowedAgents: ["other"] } }));
    const result = await spawnAcpDirect(baseRequest, baseCtx);
    expect(result.status).toBe("forbidden");
    expectSanitizedFailure(result);
  });

  it("returns sanitized error when init throws with internal session id", async () => {
    callGatewaySpy.mockImplementation((async ({ method }: { method?: string }) => {
      if (method === "sessions.patch") {
        throw new Error(
          "patch failed for agent:codex:subagent:11111111-1111-4111-8111-111111111111",
        );
      }
      if (method === "agent") {
        return { runId: "run-1" };
      }
      return {};
    }) as unknown as typeof gatewayCall.callGateway);

    const result = await spawnAcpDirect(baseRequest, baseCtx);
    expect(result.status).toBe("error");
    expect(result.error).toBe("Cannot start a subagent right now.");
    expectSanitizedFailure(result);
  });

  it("returns sanitized error when initial dispatch fails", async () => {
    registerHappyDiscordAdapter();
    callGatewaySpy.mockImplementation((async ({ method }: { method?: string }) => {
      if (method === "agent") {
        throw new Error(
          "dispatch failed for agent:codex:subagent:22222222-2222-4222-8222-222222222222",
        );
      }
      return {};
    }) as unknown as typeof gatewayCall.callGateway);

    const result = await spawnAcpDirect(
      { ...baseRequest, mode: "session", thread: true },
      baseCtx,
    );
    expect(result.status).toBe("error");
    expect(result.error).toBe("Cannot start a subagent right now.");
    expectSanitizedFailure(result);
  });

  it("success path keeps childSessionKey on status=accepted", async () => {
    registerHappyDiscordAdapter();
    const result = await spawnAcpDirect(
      { ...baseRequest, mode: "session", thread: true },
      baseCtx,
    );
    expect(result.status).toBe("accepted");
    expect(result.childSessionKey).toMatch(/^agent:codex:acp:/);
    expect(result.runId).toBeTruthy();
  });
});
