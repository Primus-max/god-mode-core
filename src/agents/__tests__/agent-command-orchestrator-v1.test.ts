/**
 * V1-CUTOVER S9.5 — Universal `agentCommandFromIngress` short-circuit
 * unit tests.
 *
 * Mirrors S9 (extensions/telegram) and S10 (src/plugin-sdk/inbound-reply-
 * dispatch) test shape. The helper
 * `executeOrchestratorV1AgentCommandShortCircuit` is the production
 * intercept at the `agentCommandFromIngress` entry point and must:
 *
 *   1. Return `{ handled: false, reason: "env_flag_unset" }` when
 *      `OPENCLAW_USE_V1_ORCHESTRATOR` is unset → legacy
 *      `agentCommandInternal` runs UNCHANGED.
 *   2. Return `{ handled: false, reason: "empty_user_text" }` when
 *      env flag is set but `opts.message` is empty/whitespace —
 *      don't waste a v1 turn on no-op input.
 *   3. Call `runOrchestratorTurn` with the right inputs (chatKey,
 *      userMessage, runTool, runConversationLLM, cfg, agentDir) when
 *      flag is set.
 *   4. Forward `cfg` and `agentDir` as truthy values (NOT undefined) —
 *      the regression that S9.1 fixed for Telegram MUST also be
 *      covered here. Without these the classifier loads from a global
 *      config that lacks the agent-scoped provider table → "Сервис
 *      временно недоступен (классификатор не загружен)".
 *   5. Synthesise the legacy `{ payloads: [{ text: <reply> }], meta:
 *      { durationMs } }` return shape so the four direct callers
 *      (gateway JSON-RPC, server-node-events, Discord voice, ACPx)
 *      do not need to change.
 *   6. NOT throw on orchestrator failure — synthesise an error
 *      payload so downstream delivery has something to render.
 *   7. Emit `[orch-v1] turn started/completed` telemetry to stderr.
 *
 * Stubs are passed via the helper's documented `overrides` test seam —
 * same shape as the S9/S10 tests, same rationale (heavyweight
 * top-level imports make `vi.mock("openclaw/...")` flaky against the
 * agent-command graph).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { executeOrchestratorV1AgentCommandShortCircuit } from "../agent-command-orchestrator-v1.js";
import type { AgentCommandIngressOpts } from "../command/types.js";

function baseIngressOpts(
  overrides: Partial<AgentCommandIngressOpts> = {},
): AgentCommandIngressOpts {
  return {
    message: "пиши /tmp/foo.txt 'hi'",
    sessionKey: "agent:main:main",
    senderIsOwner: false,
    allowModelOverride: false,
    ...overrides,
  };
}

function buildOrchResult(reply: string) {
  return {
    reply,
    contract: { intent: "tool_calls", tool_calls: [], sequencing: "sequential" },
    stageA: { routing: { intent: "tool_calls" }, fallbackReason: null, latencyMs: 12 },
    dispatch: { reply, allOk: true, actions: [] },
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe("S9.5 — executeOrchestratorV1AgentCommandShortCircuit", () => {
  it("returns handled:false (env_flag_unset) when OPENCLAW_USE_V1_ORCHESTRATOR is unset", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "");
    const runOrchestratorTurn = vi.fn();
    const outcome = await executeOrchestratorV1AgentCommandShortCircuit(baseIngressOpts(), {
      runOrchestratorTurn: runOrchestratorTurn as never,
      loadConfig: () => ({}) as OpenClawConfig,
      resolveAgentDir: () => "/tmp/test-agent",
    });
    expect(outcome).toEqual({ handled: false, reason: "env_flag_unset" });
    expect(runOrchestratorTurn).not.toHaveBeenCalled();
  });

  it("returns handled:false (empty_user_text) when env is set but message is empty/whitespace", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const runOrchestratorTurn = vi.fn();
    const outcome = await executeOrchestratorV1AgentCommandShortCircuit(
      baseIngressOpts({ message: "   \n\t   " }),
      {
        runOrchestratorTurn: runOrchestratorTurn as never,
        loadConfig: () => ({}) as OpenClawConfig,
        resolveAgentDir: () => "/tmp/test-agent",
      },
    );
    expect(outcome).toEqual({ handled: false, reason: "empty_user_text" });
    expect(runOrchestratorTurn).not.toHaveBeenCalled();
  });

  it("env set + valid message → calls runOrchestratorTurn once with chatKey, userMessage, runTool, runConversationLLM", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const runOrchestratorTurn = vi.fn(async () => buildOrchResult("Записал /tmp/foo.txt."));
    const buildRunToolFromRegistry = vi.fn(() => vi.fn());
    const callConversationLLM = vi.fn(async () => "stub");
    const outcome = await executeOrchestratorV1AgentCommandShortCircuit(
      baseIngressOpts({
        message: "запиши /tmp/foo.txt 'hi'",
        sessionKey: "agent:main:main",
        messageChannel: "discord",
        senderIsOwner: false,
        allowModelOverride: false,
      }),
      {
        runOrchestratorTurn: runOrchestratorTurn as never,
        buildRunToolFromRegistry: buildRunToolFromRegistry as never,
        callConversationLLM: callConversationLLM as never,
        loadConfig: () => ({}) as OpenClawConfig,
        resolveAgentDir: () => "/tmp/test-agent-dir",
      },
    );
    expect(outcome.handled).toBe(true);
    expect(runOrchestratorTurn).toHaveBeenCalledTimes(1);
    const turnCalls = runOrchestratorTurn.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const call = turnCalls[0]![0];
    // chatKey encodes the channel + session identity so per-channel locking works.
    expect(typeof call.chatKey).toBe("string");
    expect(call.chatKey).toMatch(/^universal:discord:/);
    expect(call.userMessage).toBe("запиши /tmp/foo.txt 'hi'");
    expect(typeof call.runTool).toBe("function");
    expect(typeof call.runConversationLLM).toBe("function");
    // Registry was constructed with deps containing send + scheduling.
    expect(buildRunToolFromRegistry).toHaveBeenCalledTimes(1);
    const regCalls = buildRunToolFromRegistry.mock.calls as unknown as Array<
      [{ send: unknown; scheduling: { scheduleCron: unknown; createPersistentWorker: unknown } }]
    >;
    const regDeps = regCalls[0]![0];
    expect(typeof regDeps.send).toBe("function");
    expect(typeof regDeps.scheduling.scheduleCron).toBe("function");
    expect(typeof regDeps.scheduling.createPersistentWorker).toBe("function");
  });

  it("returns synthesised legacy { payloads, meta } shape so callers do not change", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const runOrchestratorTurn = vi.fn(async () => buildOrchResult("Готово."));
    let nowCount = 0;
    const outcome = await executeOrchestratorV1AgentCommandShortCircuit(baseIngressOpts(), {
      runOrchestratorTurn: runOrchestratorTurn as never,
      loadConfig: () => ({}) as OpenClawConfig,
      resolveAgentDir: () => "/tmp/agent",
      // Deterministic clock: 1000 → 1100 → durationMs=100.
      now: () => {
        nowCount += 1;
        return nowCount === 1 ? 1000 : 1100;
      },
    });
    expect(outcome.handled).toBe(true);
    if (outcome.handled) {
      expect(outcome.result.payloads).toEqual([{ text: "Готово." }]);
      expect(outcome.result.meta.durationMs).toBe(100);
    }
  });

  it("REGRESSION (S9.1 mirror): forwards cfg + agentDir as TRUTHY values to runOrchestratorTurn", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const cfgSentinel = { sentinel: "cfg-must-be-forwarded" } as unknown as OpenClawConfig;
    const runOrchestratorTurn = vi.fn(async () => buildOrchResult("ok"));
    await executeOrchestratorV1AgentCommandShortCircuit(baseIngressOpts({ agentId: "main" }), {
      runOrchestratorTurn: runOrchestratorTurn as never,
      loadConfig: () => cfgSentinel,
      resolveAgentDir: () => "/sentinel/agent/dir",
    });
    const turnCalls = runOrchestratorTurn.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const call = turnCalls[0]![0];
    // Symptom S9.1 fixed: cfg + agentDir threading. If either is dropped,
    // Stage A model resolution falls back to a global config without the
    // agent-scoped provider table → "Сервис временно недоступен
    // (классификатор не загружен)".
    expect(call.cfg).toBe(cfgSentinel);
    expect(call.cfg).toBeTruthy();
    expect(call.agentDir).toBe("/sentinel/agent/dir");
    expect(typeof call.agentDir).toBe("string");
    expect((call.agentDir as string).length).toBeGreaterThan(0);
  });

  it("registry deps: cron + persistent_worker_push placeholders fail-closed with explicit S9.5 message", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    let capturedScheduling:
      | { scheduleCron: () => Promise<unknown>; createPersistentWorker: () => Promise<unknown> }
      | undefined;
    const buildRunToolFromRegistry = vi.fn((deps: { scheduling: typeof capturedScheduling }) => {
      capturedScheduling = deps.scheduling;
      return vi.fn();
    });
    const runOrchestratorTurn = vi.fn(async () => buildOrchResult("ok"));
    await executeOrchestratorV1AgentCommandShortCircuit(baseIngressOpts(), {
      runOrchestratorTurn: runOrchestratorTurn as never,
      buildRunToolFromRegistry: buildRunToolFromRegistry as never,
      loadConfig: () => ({}) as OpenClawConfig,
      resolveAgentDir: () => "/tmp/agent",
    });
    expect(capturedScheduling).toBeDefined();
    await expect(capturedScheduling!.scheduleCron()).rejects.toThrow(/cron not yet wired in S9\.5/);
    await expect(capturedScheduling!.createPersistentWorker()).rejects.toThrow(
      /persistent_worker_push not yet wired in S9\.5/,
    );
  });

  it("orchestrator throws → does NOT crash; returns handled:true with synthesised error payload (isError=true)", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const runOrchestratorTurn = vi.fn(async () => {
      throw new Error("kaboom");
    });
    const outcome = await executeOrchestratorV1AgentCommandShortCircuit(baseIngressOpts(), {
      runOrchestratorTurn: runOrchestratorTurn as never,
      loadConfig: () => ({}) as OpenClawConfig,
      resolveAgentDir: () => "/tmp/agent",
    });
    expect(outcome.handled).toBe(true);
    if (outcome.handled) {
      expect(outcome.result.payloads).toHaveLength(1);
      expect(outcome.result.payloads[0]!.isError).toBe(true);
      expect(outcome.result.payloads[0]!.text).toContain("kaboom");
    }
  });

  it("PR #350 wiring: passes the process-scoped TurnStateStore singleton to runOrchestratorTurn (multi-turn activation)", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const runOrchestratorTurn = vi.fn(async () => buildOrchResult("ok"));
    const sentinelStore = {
      get: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    };
    const getProcessTurnStateStoreStub = vi.fn(() => sentinelStore);
    const outcome = await executeOrchestratorV1AgentCommandShortCircuit(
      baseIngressOpts({ messageChannel: "discord" }),
      {
        runOrchestratorTurn: runOrchestratorTurn as never,
        loadConfig: () => ({}) as OpenClawConfig,
        resolveAgentDir: () => "/tmp/agent",
        getProcessTurnStateStore: getProcessTurnStateStoreStub as never,
      },
    );
    expect(outcome.handled).toBe(true);
    expect(getProcessTurnStateStoreStub).toHaveBeenCalledTimes(1);
    expect(runOrchestratorTurn).toHaveBeenCalledTimes(1);
    const turnCalls = runOrchestratorTurn.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const call = turnCalls[0]![0];
    // Identity check: same object the singleton accessor returned. The 3
    // dispatch sites (Telegram / plugin-sdk / agent-command) must all
    // forward THIS exact instance for cross-channel multi-turn resume to
    // work.
    expect(call.turnState).toBe(sentinelStore);
    expect(typeof (call.turnState as { get: unknown }).get).toBe("function");
    expect(typeof (call.turnState as { put: unknown }).put).toBe("function");
    expect(typeof (call.turnState as { clear: unknown }).clear).toBe("function");
  });

  it("emits [orch-v1] start + completion telemetry to stderr", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const runOrchestratorTurn = vi.fn(async () => buildOrchResult("Готово."));
    const writeSpy = vi.spyOn(process.stderr, "write");
    await executeOrchestratorV1AgentCommandShortCircuit(
      baseIngressOpts({ messageChannel: "discord", sessionKey: "agent:main:main" }),
      {
        runOrchestratorTurn: runOrchestratorTurn as never,
        loadConfig: () => ({}) as OpenClawConfig,
        resolveAgentDir: () => "/tmp/agent",
      },
    );
    const lines = writeSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.startsWith("[orch-v1] turn started"))).toBe(true);
    expect(lines.some((l) => l.startsWith("[orch-v1] turn completed"))).toBe(true);
    // The chatKey on the started line matches the universal:<channel>:<session> shape.
    const startedLine = lines.find((l) => l.startsWith("[orch-v1] turn started"));
    expect(startedLine).toMatch(/chatKey=universal:discord:agent:main:main/);
    writeSpy.mockRestore();
  });

  it("chatKey falls back to runId/to/session-unknown when sessionKey + sessionId are absent", async () => {
    // Covers the gateway server-node-events 'agent.voice.transcript' path
    // which can dispatch with sessionKey resolved from a node-{nodeId}
    // synthetic key — sometimes a turn arrives with only `runId` set.
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const runOrchestratorTurn = vi.fn(async () => buildOrchResult("ok"));
    const ingressNoSessionInfo: AgentCommandIngressOpts = {
      message: "hello",
      runId: "voice-fallback-1",
      senderIsOwner: false,
      allowModelOverride: false,
    };
    await executeOrchestratorV1AgentCommandShortCircuit(ingressNoSessionInfo, {
      runOrchestratorTurn: runOrchestratorTurn as never,
      loadConfig: () => ({}) as OpenClawConfig,
      resolveAgentDir: () => "/tmp/agent",
    });
    const turnCalls = runOrchestratorTurn.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const call = turnCalls[0]![0];
    expect(call.chatKey).toBe("universal:ingress:voice-fallback-1");
  });

  it("env unset wins over empty message — returns env_flag_unset (precedence)", async () => {
    // Negative coverage: even with empty text, the env-flag-unset short-circuit
    // resolves first so legacy behavior remains the default.
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "");
    const runOrchestratorTurn = vi.fn();
    const outcome = await executeOrchestratorV1AgentCommandShortCircuit(
      baseIngressOpts({ message: "   " }),
      {
        runOrchestratorTurn: runOrchestratorTurn as never,
        loadConfig: () => ({}) as OpenClawConfig,
        resolveAgentDir: () => "/tmp/agent",
      },
    );
    expect(outcome).toEqual({ handled: false, reason: "env_flag_unset" });
  });
});

describe("S9.5 — agentCommandFromIngress integration", () => {
  // Integration smoke test: when env is set + valid message, the
  // short-circuit short-circuits — agentCommandInternal is NOT
  // executed. We test this by mocking the helper module so we don't
  // need to load the full agentCommandInternal heavy-mock graph.

  it("env set + valid message → returns synthesised result without calling agentCommandInternal", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    vi.resetModules();
    const stubResult = {
      payloads: [{ text: "ok-from-orch" }],
      meta: { durationMs: 1 },
    };
    const helperSpy = vi.fn(async () => ({ handled: true, result: stubResult }));
    vi.doMock("../agent-command-orchestrator-v1.js", () => ({
      executeOrchestratorV1AgentCommandShortCircuit: helperSpy,
    }));
    // If `agentCommandInternal` ran, it would attempt to load config + open
    // the session store, which without a temp home would throw. Reaching
    // the orchestrator short-circuit and returning early avoids all of
    // that. The fact that the call resolves with our stub result is the
    // proof.
    const { agentCommandFromIngress } = await import("../agent-command.js");
    const out = await agentCommandFromIngress({
      message: "пиши /tmp/x.txt",
      sessionKey: "agent:main:main",
      senderIsOwner: false,
      allowModelOverride: false,
    });
    expect(helperSpy).toHaveBeenCalledTimes(1);
    expect(out).toEqual(stubResult);
    vi.doUnmock("../agent-command-orchestrator-v1.js");
  });
});
