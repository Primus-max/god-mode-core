/**
 * V1-CUTOVER S10 — Universal inbound dispatch cutover unit tests.
 *
 * Mirrors the S9 Telegram tests for the channel-agnostic dispatcher in
 * `inbound-reply-dispatch.ts`. The helper (
 * `executeOrchestratorV1UniversalShortCircuit`) is the production
 * replacement for the env-gated `diagnoseTurn` short-circuit and must:
 *
 *   1. Skip (return false) when `OPENCLAW_USE_V1_ORCHESTRATOR` is unset
 *      → legacy flow stays unchanged.
 *   2. Call `runOrchestratorTurn` with the right inputs (chatKey,
 *      userMessage, runTool, runConversationLLM, cfg, agentDir) when flag
 *      is set.
 *   3. Forward `cfg` and `agentDir` as truthy values (NOT undefined) —
 *      the regression that S9.1 fixed for Telegram MUST also be covered
 *      here. Without these the classifier loads from a global config
 *      that lacks the agent-scoped provider table.
 *   4. Deliver the orchestrator's `result.reply` via the inbound
 *      `deliver` callback so the originating channel sees the rendered
 *      template.
 *   5. NOT crash on orchestrator throw — log + send a generic error
 *      message via `deliver` instead.
 *   6. Skip when the user message is empty/whitespace.
 *
 * Stubs are passed via the helper's documented `overrides` test seam —
 * same shape as the S9 Telegram tests, same rationale (heavyweight
 * top-level imports make `vi.mock("openclaw/...")` flaky).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

type DeliverCall = { text: string };

function makeDeliverStub(): {
  deliver: (payload: { text?: string }) => Promise<void>;
  delivers: DeliverCall[];
} {
  const delivers: DeliverCall[] = [];
  const deliver = vi.fn(async (payload: { text?: string }) => {
    delivers.push({ text: payload.text ?? "" });
  });
  return { deliver, delivers };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe("S10 — executeOrchestratorV1UniversalShortCircuit", () => {
  it("returns false when OPENCLAW_USE_V1_ORCHESTRATOR is unset (legacy fallthrough)", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "");
    const { executeOrchestratorV1UniversalShortCircuit } = await import(
      "./inbound-reply-dispatch.js"
    );
    const { deliver } = makeDeliverStub();
    const runOrchestratorTurn = vi.fn();
    const handled = await executeOrchestratorV1UniversalShortCircuit(
      {
        userText: "пиши /tmp/foo.txt текст",
        chatKey: "discord:123",
        cfg: {} as OpenClawConfig,
        agentId: "main",
        channel: "discord",
        deliver,
      },
      { runOrchestratorTurn: runOrchestratorTurn as never },
    );
    expect(handled).toBe(false);
    expect(runOrchestratorTurn).not.toHaveBeenCalled();
  });

  it("returns false when env flag is set but userText is empty/whitespace", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const { executeOrchestratorV1UniversalShortCircuit } = await import(
      "./inbound-reply-dispatch.js"
    );
    const { deliver } = makeDeliverStub();
    const runOrchestratorTurn = vi.fn();
    const handled = await executeOrchestratorV1UniversalShortCircuit(
      {
        userText: "   \n\t   ",
        chatKey: "discord:1",
        cfg: {} as OpenClawConfig,
        agentId: "main",
        channel: "discord",
        deliver,
      },
      { runOrchestratorTurn: runOrchestratorTurn as never },
    );
    expect(handled).toBe(false);
    expect(runOrchestratorTurn).not.toHaveBeenCalled();
  });

  it("flag set + valid userText → calls runOrchestratorTurn with chatKey/userMessage/runTool/runConversationLLM", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const { executeOrchestratorV1UniversalShortCircuit } = await import(
      "./inbound-reply-dispatch.js"
    );
    const { deliver, delivers } = makeDeliverStub();
    const runOrchestratorTurn = vi.fn(async () => ({
      reply: "Записал в /tmp/foo.txt.",
      contract: { intent: "tool_calls", tool_calls: [], sequencing: "sequential" },
      stageA: { routing: { intent: "tool_calls" }, fallbackReason: null, latencyMs: 12 },
      dispatch: { reply: "Записал в /tmp/foo.txt.", allOk: true, actions: [] },
    }));
    const buildRunToolFromRegistry = vi.fn(() => vi.fn());
    const callConversationLLM = vi.fn(async () => "stub");
    const handled = await executeOrchestratorV1UniversalShortCircuit(
      {
        userText: "запиши /tmp/foo.txt 'hi'",
        chatKey: "discord:42",
        cfg: {} as OpenClawConfig,
        agentId: "main",
        channel: "discord",
        deliver,
      },
      {
        runOrchestratorTurn: runOrchestratorTurn as never,
        buildRunToolFromRegistry: buildRunToolFromRegistry as never,
        callConversationLLM: callConversationLLM as never,
        // override agentDir resolution so the test does not touch the FS.
        resolveAgentDir: () => "/tmp/test-agent-dir",
      },
    );
    expect(handled).toBe(true);
    expect(runOrchestratorTurn).toHaveBeenCalledTimes(1);
    const turnCalls = runOrchestratorTurn.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    const call = turnCalls[0]![0];
    expect(call.chatKey).toBe("discord:42");
    expect(call.userMessage).toBe("запиши /tmp/foo.txt 'hi'");
    expect(typeof call.runTool).toBe("function");
    expect(typeof call.runConversationLLM).toBe("function");
    // Reply text was delivered via the inbound deliver callback.
    expect(delivers).toHaveLength(1);
    expect(delivers[0]!.text).toBe("Записал в /tmp/foo.txt.");
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

  it("REGRESSION (S9.1 mirror): forwards cfg + agentDir as truthy values to runOrchestratorTurn", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const { executeOrchestratorV1UniversalShortCircuit } = await import(
      "./inbound-reply-dispatch.js"
    );
    const { deliver } = makeDeliverStub();
    const cfgSentinel = { sentinel: "cfg-must-be-forwarded" } as unknown as OpenClawConfig;
    const runOrchestratorTurn = vi.fn(async () => ({
      reply: "ok",
      contract: { intent: "conversation" },
      stageA: { routing: { intent: "conversation" } },
      dispatch: { reply: "ok", allOk: true },
    }));
    await executeOrchestratorV1UniversalShortCircuit(
      {
        userText: "привет",
        chatKey: "discord:1",
        cfg: cfgSentinel,
        agentId: "main",
        channel: "discord",
        deliver,
      },
      {
        runOrchestratorTurn: runOrchestratorTurn as never,
        resolveAgentDir: () => "/sentinel/agent/dir",
      },
    );
    const turnCalls = runOrchestratorTurn.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    const call = turnCalls[0]![0];
    // The actual symptom that S9.1 fixed: cfg + agentDir threaded through
    // the dispatcher reach the orchestrator. If they were dropped, Stage
    // A model resolution falls back to a global config without the
    // agent-scoped provider entry → "Сервис временно недоступен
    // (классификатор не загружен)".
    expect(call.cfg).toBe(cfgSentinel);
    expect(call.cfg).toBeTruthy();
    expect(call.agentDir).toBe("/sentinel/agent/dir");
    expect(typeof call.agentDir).toBe("string");
    expect((call.agentDir as string).length).toBeGreaterThan(0);
  });

  it("registry deps: cron + persistent_worker_push placeholders fail-closed with explicit S10 message", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const { executeOrchestratorV1UniversalShortCircuit } = await import(
      "./inbound-reply-dispatch.js"
    );
    const { deliver } = makeDeliverStub();
    let capturedScheduling:
      | { scheduleCron: () => Promise<unknown>; createPersistentWorker: () => Promise<unknown> }
      | undefined;
    const buildRunToolFromRegistry = vi.fn(
      (deps: { scheduling: typeof capturedScheduling }) => {
        capturedScheduling = deps.scheduling;
        return vi.fn();
      },
    );
    const runOrchestratorTurn = vi.fn(async () => ({
      reply: "ok",
      contract: { intent: "conversation" },
      stageA: { routing: { intent: "conversation" } },
      dispatch: { reply: "ok", allOk: true },
    }));
    await executeOrchestratorV1UniversalShortCircuit(
      {
        userText: "hi",
        chatKey: "discord:1",
        cfg: {} as OpenClawConfig,
        agentId: "main",
        channel: "discord",
        deliver,
      },
      {
        runOrchestratorTurn: runOrchestratorTurn as never,
        buildRunToolFromRegistry: buildRunToolFromRegistry as never,
        resolveAgentDir: () => "/tmp/agent",
      },
    );
    await expect(capturedScheduling!.scheduleCron()).rejects.toThrow(
      /cron not yet wired in S10/,
    );
    await expect(capturedScheduling!.createPersistentWorker()).rejects.toThrow(
      /persistent_worker_push not yet wired in S10/,
    );
  });

  it("orchestrator throws → does NOT crash, calls onDispatchError + delivers a generic error reply", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const { executeOrchestratorV1UniversalShortCircuit } = await import(
      "./inbound-reply-dispatch.js"
    );
    const { deliver, delivers } = makeDeliverStub();
    const onDispatchError = vi.fn();
    const runOrchestratorTurn = vi.fn(async () => {
      throw new Error("kaboom");
    });
    const handled = await executeOrchestratorV1UniversalShortCircuit(
      {
        userText: "do something",
        chatKey: "discord:1",
        cfg: {} as OpenClawConfig,
        agentId: "main",
        channel: "discord",
        deliver,
        onDispatchError,
      },
      {
        runOrchestratorTurn: runOrchestratorTurn as never,
        resolveAgentDir: () => "/tmp/agent",
      },
    );
    expect(handled).toBe(true);
    expect(onDispatchError).toHaveBeenCalled();
    expect(delivers).toHaveLength(1);
    expect(delivers[0]!.text).toContain("kaboom");
  });

  it("emits [orch-v1] start + completion telemetry to stderr", async () => {
    vi.stubEnv("OPENCLAW_USE_V1_ORCHESTRATOR", "1");
    const { executeOrchestratorV1UniversalShortCircuit } = await import(
      "./inbound-reply-dispatch.js"
    );
    const { deliver } = makeDeliverStub();
    const runOrchestratorTurn = vi.fn(async () => ({
      reply: "Готово.",
      contract: { intent: "conversation" },
      stageA: { routing: { intent: "conversation" } },
      dispatch: { reply: "Готово.", allOk: true },
    }));
    const writeSpy = vi.spyOn(process.stderr, "write");
    await executeOrchestratorV1UniversalShortCircuit(
      {
        userText: "привет",
        chatKey: "discord:7",
        cfg: {} as OpenClawConfig,
        agentId: "main",
        channel: "discord",
        deliver,
      },
      {
        runOrchestratorTurn: runOrchestratorTurn as never,
        resolveAgentDir: () => "/tmp/agent",
      },
    );
    const lines = writeSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.startsWith("[orch-v1] turn started"))).toBe(true);
    expect(lines.some((l) => l.startsWith("[orch-v1] turn completed"))).toBe(true);
    writeSpy.mockRestore();
  });
});
