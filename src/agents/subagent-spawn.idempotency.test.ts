import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  type OpenClawConfig,
  setRuntimeConfigSnapshot,
} from "../config/config.js";
import * as sessionsModule from "../config/sessions.js";
import type { SessionEntry } from "../config/sessions.js";
import * as gatewayCall from "../gateway/call.js";
import * as gatewaySessionUtils from "../gateway/session-utils.js";
import * as hookRunnerGlobal from "../plugins/hook-runner-global.js";
import * as sandboxRuntimeStatus from "./sandbox/runtime-status.js";
import * as subagentAttachments from "./subagent-attachments.js";
import * as subagentDepth from "./subagent-depth.js";
import * as subagentRegistry from "./subagent-registry.js";

/**
 * Idempotency guard for the `persistent_session.created` commitment effect.
 *
 * These tests were rewritten as part of PR-4a / commit 1
 * (commitment_kernel_idempotency_fix.plan.md §3.2.2). The previous version
 * mocked `subagentRegistry.findActiveSubagentByLabel` via `vi.spyOn`, which
 * exercised only the early-return branch in `spawnSubagentDirect` and would
 * silently mask a regression where `endedAt` re-becomes the source of
 * "liveness" (Gap G3, G4 — "tests do not actually prove the fix").
 *
 * The rewrite:
 *   - Stops spying on the guard itself.
 *   - Drives the real code path through `findLivePersistentSessionByLabel`
 *     against an in-memory `loadSessionStore` fixture.
 *   - Pins the store-target resolver so `resolveGatewaySessionStoreTarget`
 *     does not depend on disk layout or runtime config defaults.
 *   - Includes a dedicated G3 regression case: an entry with `endedAt` set
 *     must still be reused (live-by-presence in the gateway store).
 */

const callGatewaySpy = vi.spyOn(gatewayCall, "callGateway");
const registerSubagentRunSpy = vi.spyOn(subagentRegistry, "registerSubagentRun");
const countActiveRunsSpy = vi.spyOn(subagentRegistry, "countActiveRunsForSession");
const getSubagentDepthSpy = vi.spyOn(subagentDepth, "getSubagentDepthFromSessionStore");
const resolveSandboxSpy = vi.spyOn(sandboxRuntimeStatus, "resolveSandboxRuntimeStatus");
const materializeAttachmentsSpy = vi.spyOn(subagentAttachments, "materializeSubagentAttachments");
const getGlobalHookRunnerSpy = vi.spyOn(hookRunnerGlobal, "getGlobalHookRunner");
const loadSessionStoreSpy = vi.spyOn(sessionsModule, "loadSessionStore");
const resolveStoreTargetSpy = vi.spyOn(
  gatewaySessionUtils,
  "resolveGatewaySessionStoreTarget",
);

const { spawnSubagentDirect } = await import("./subagent-spawn.js");

function createBaseConfig(): OpenClawConfig {
  return {
    session: { mainKey: "main", scope: "per-sender" },
    agents: {
      list: [{ id: "main", workspace: "/tmp/workspace-main" }],
    },
  } as unknown as OpenClawConfig;
}

const tgRequesterCtx = {
  agentSessionKey: "agent:main:main",
  agentChannel: "telegram" as const,
  agentAccountId: "acc-1",
  agentTo: "chat-1",
  agentThreadId: 0,
};

const TG_DELIVERY_CONTEXT = {
  channel: "telegram" as const,
  accountId: "acc-1",
  to: "chat-1",
  threadId: 0,
};

const REUSED_CHILD_KEY = "agent:main:subagent:reused-uuid";

function makeEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  const base: SessionEntry = {
    sessionId: "sess-id",
    updatedAt: 1_000,
    label: "Валера",
    deliveryContext: TG_DELIVERY_CONTEXT,
    spawnedBy: "agent:main:main",
    subagentRole: "leaf",
  } as SessionEntry;
  return { ...base, ...overrides };
}

function setHookRunner(): void {
  getGlobalHookRunnerSpy.mockReturnValue({
    hasHooks: () => false,
    runSubagentSpawning: async () => undefined,
    runSubagentSpawned: async () => undefined,
    runSubagentEnded: async () => undefined,
  } as unknown as ReturnType<typeof hookRunnerGlobal.getGlobalHookRunner>);
}

function pinStore(store: Record<string, SessionEntry>): void {
  loadSessionStoreSpy
    .mockReset()
    .mockReturnValue(store as unknown as ReturnType<typeof sessionsModule.loadSessionStore>);
}

beforeEach(() => {
  callGatewaySpy.mockReset().mockImplementation((async ({ method }: { method?: string }) => {
    if (method === "agent") {
      return { runId: "run-1" };
    }
    return {};
  }) as unknown as typeof gatewayCall.callGateway);
  registerSubagentRunSpy
    .mockReset()
    .mockImplementation((() => undefined) as unknown as typeof subagentRegistry.registerSubagentRun);
  countActiveRunsSpy.mockReset().mockReturnValue(0);
  getSubagentDepthSpy.mockReset().mockReturnValue(0);
  resolveSandboxSpy
    .mockReset()
    .mockReturnValue({ sandboxed: false } as ReturnType<
      typeof sandboxRuntimeStatus.resolveSandboxRuntimeStatus
    >);
  materializeAttachmentsSpy
    .mockReset()
    .mockResolvedValue(
      undefined as unknown as Awaited<
        ReturnType<typeof subagentAttachments.materializeSubagentAttachments>
      >,
    );
  getGlobalHookRunnerSpy.mockReset();
  setHookRunner();
  resolveStoreTargetSpy.mockReset().mockReturnValue({
    agentId: "main",
    storePath: "/tmp/test-session-store.json",
    canonicalKey: "agent:main:main",
    storeKeys: ["agent:main:main"],
  });
  pinStore({});
  setRuntimeConfigSnapshot(createBaseConfig());
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
});

describe("spawnSubagentDirect persistent_session.created idempotency", () => {
  it("[G3 regression] reuses a live persistent subagent session even when entry.endedAt is set", async () => {
    pinStore({
      [REUSED_CHILD_KEY]: makeEntry({
        endedAt: 5_000,
        updatedAt: 5_000,
      }),
    });

    const result = await spawnSubagentDirect(
      {
        task: "create Валера again",
        label: "Валера",
        thread: true,
        mode: "session",
        agentId: "main",
      },
      tgRequesterCtx,
    );

    expect(result.status).toBe("accepted");
    expect(result.childSessionKey).toBe(REUSED_CHILD_KEY);
    expect(result.mode).toBe("session");
    expect(result.note ?? "").toMatch(/Reused existing persistent session/);
    expect(callGatewaySpy).not.toHaveBeenCalled();
    expect(registerSubagentRunSpy).not.toHaveBeenCalled();
  });

  it("reuses a live persistent subagent session with a fresh entry (no endedAt)", async () => {
    pinStore({
      [REUSED_CHILD_KEY]: makeEntry({ updatedAt: 2_000 }),
    });

    const result = await spawnSubagentDirect(
      {
        task: "follow-up to Валера",
        label: "Валера",
        thread: true,
        mode: "session",
        agentId: "main",
      },
      tgRequesterCtx,
    );

    expect(result.status).toBe("accepted");
    expect(result.childSessionKey).toBe(REUSED_CHILD_KEY);
    expect(result.note ?? "").toMatch(/Reused existing persistent session/);
    expect(callGatewaySpy).not.toHaveBeenCalled();
    expect(registerSubagentRunSpy).not.toHaveBeenCalled();
  });

  it("picks the latest entry by updatedAt when multiple subagent entries share the label and origin", async () => {
    pinStore({
      "agent:main:subagent:older": makeEntry({ updatedAt: 100 }),
      "agent:main:subagent:latest": makeEntry({ updatedAt: 5_000 }),
      "agent:main:subagent:middle": makeEntry({ updatedAt: 1_000 }),
    });

    const result = await spawnSubagentDirect(
      {
        task: "ping Валера",
        label: "Валера",
        thread: true,
        mode: "session",
        agentId: "main",
      },
      tgRequesterCtx,
    );

    expect(result.childSessionKey).toBe("agent:main:subagent:latest");
  });

  it("does not reuse when no live persistent session matches (empty store -> guard misses, normal spawn path)", async () => {
    pinStore({});

    const result = await spawnSubagentDirect(
      {
        task: "create Валера",
        label: "Валера",
        thread: true,
        mode: "session",
        agentId: "main",
      },
      tgRequesterCtx,
    );

    expect(result.note ?? "").not.toMatch(/Reused existing persistent session/);
    expect(loadSessionStoreSpy).toHaveBeenCalled();
  });

  it("does not reuse when origin (to) differs (cross-chat protection)", async () => {
    pinStore({
      [REUSED_CHILD_KEY]: makeEntry({
        deliveryContext: { ...TG_DELIVERY_CONTEXT, to: "chat-other" },
      }),
    });

    const result = await spawnSubagentDirect(
      {
        task: "create Валера here",
        label: "Валера",
        thread: true,
        mode: "session",
        agentId: "main",
      },
      tgRequesterCtx,
    );

    expect(result.note ?? "").not.toMatch(/Reused existing persistent session/);
    expect(loadSessionStoreSpy).toHaveBeenCalled();
  });

  it("does not reuse when label differs", async () => {
    pinStore({
      [REUSED_CHILD_KEY]: makeEntry({ label: "Петя" }),
    });

    const result = await spawnSubagentDirect(
      {
        task: "create Валера",
        label: "Валера",
        thread: true,
        mode: "session",
        agentId: "main",
      },
      tgRequesterCtx,
    );

    expect(result.note ?? "").not.toMatch(/Reused existing persistent session/);
    expect(loadSessionStoreSpy).toHaveBeenCalled();
  });

  it("does not consult the session store for one-shot spawns (thread=false)", async () => {
    pinStore({
      [REUSED_CHILD_KEY]: makeEntry(),
    });

    const result = await spawnSubagentDirect(
      {
        task: "fire and forget",
        label: "Валера",
        thread: false,
        agentId: "main",
      },
      tgRequesterCtx,
    );

    expect(loadSessionStoreSpy).not.toHaveBeenCalled();
    expect(result.note ?? "").not.toMatch(/Reused existing persistent session/);
  });

  it("does not consult the session store when label is empty", async () => {
    pinStore({
      [REUSED_CHILD_KEY]: makeEntry(),
    });

    const result = await spawnSubagentDirect(
      {
        task: "do work",
        thread: true,
        mode: "session",
        agentId: "main",
      },
      tgRequesterCtx,
    );

    expect(loadSessionStoreSpy).not.toHaveBeenCalled();
    expect(result.note ?? "").not.toMatch(/Reused existing persistent session/);
  });

  it("ignores non-subagent entries in the store (main / group keys)", async () => {
    pinStore({
      "agent:main:main": makeEntry(),
      "agent:main:tg:group:chat-1": makeEntry(),
      global: makeEntry(),
    });

    const result = await spawnSubagentDirect(
      {
        task: "create Валера",
        label: "Валера",
        thread: true,
        mode: "session",
        agentId: "main",
      },
      tgRequesterCtx,
    );

    expect(result.note ?? "").not.toMatch(/Reused existing persistent session/);
    expect(loadSessionStoreSpy).toHaveBeenCalled();
  });

  it("ignores subagent entries belonging to a different agentId", async () => {
    pinStore({
      "agent:other:subagent:foreign": makeEntry(),
    });

    const result = await spawnSubagentDirect(
      {
        task: "create Валера on main",
        label: "Валера",
        thread: true,
        mode: "session",
        agentId: "main",
      },
      tgRequesterCtx,
    );

    expect(result.note ?? "").not.toMatch(/Reused existing persistent session/);
    expect(loadSessionStoreSpy).toHaveBeenCalled();
  });
});
