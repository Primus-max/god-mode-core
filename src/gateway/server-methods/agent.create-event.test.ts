import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testState, writeSessionStore } from "../test-helpers.js";

const mocks = vi.hoisted(() => ({
  agentCommandFromIngress: vi.fn(),
}));

vi.mock("../../commands/agent.js", () => ({
  agentCommandFromIngress: mocks.agentCommandFromIngress,
}));

type AgentModule = typeof import("./agent.js");

describe("agent handler session create events", () => {
  let tempDir: string;
  let storePath: string;
  let agentHandlers: AgentModule["agentHandlers"];

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-create-event-"));
    storePath = path.join(tempDir, "sessions.json");
    testState.sessionStorePath = storePath;
    await writeSessionStore({ entries: {} });
    ({ agentHandlers } = await import("./agent.js"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("emits sessions.changed with reason create for new agent sessions", async () => {
    mocks.agentCommandFromIngress.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 1 },
    });
    const broadcastToConnIds = vi.fn();
    const respond = vi.fn();

    await agentHandlers.agent({
      params: {
        message: "hi",
        sessionKey: "agent:main:subagent:create-test",
        idempotencyKey: "idem-agent-create-event",
      },
      respond,
      context: {
        dedupe: new Map(),
        deps: {} as never,
        logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
        chatAbortControllers: new Map(),
        addChatRun: vi.fn(),
        registerToolEventRecipient: vi.fn(),
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
        broadcastToConnIds,
      } as never,
      client: null,
      isWebchatConnect: () => false,
      req: { id: "req-agent-create-event" } as never,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        status: "accepted",
        runId: "idem-agent-create-event",
      }),
      undefined,
      { runId: "idem-agent-create-event" },
    );
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({
        sessionKey: "agent:main:subagent:create-test",
        reason: "create",
      }),
      new Set(["conn-1"]),
      { dropIfSlow: true },
    );
  });
});
