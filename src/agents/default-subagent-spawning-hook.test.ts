/**
 * Tests for the gateway's default subagent thread-binding hooks.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHookRunner } from "../plugins/hooks.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type {
  PluginHookSubagentContext,
  PluginHookSubagentDeliveryTargetEvent,
  PluginHookSubagentEndedEvent,
  PluginHookSubagentSpawningEvent,
  PluginHookSubagentSpawningResult,
} from "../plugins/types.js";
import {
  __getRecordedRequesterOriginForTests,
  __resetDefaultSubagentSpawningStateForTests,
  DEFAULT_SUBAGENT_HOOKS_PLUGIN_ID,
  defaultSubagentDeliveryTargetHandler,
  defaultSubagentEndedHandler,
  defaultSubagentSpawningHandler,
  registerDefaultSubagentHooksIfMissing,
} from "./default-subagent-spawning-hook.js";

const CHILD_SESSION_KEY = "agent:main:subagent:11111111-2222-3333-4444-555555555555";
const REQUESTER_SESSION_KEY = "agent:main:main";

const baseSubagentCtx: PluginHookSubagentContext = {
  runId: "run-1",
  childSessionKey: CHILD_SESSION_KEY,
  requesterSessionKey: REQUESTER_SESSION_KEY,
};

function makeSpawningEvent(
  overrides: Partial<PluginHookSubagentSpawningEvent> = {},
): PluginHookSubagentSpawningEvent {
  return {
    childSessionKey: CHILD_SESSION_KEY,
    agentId: "main",
    label: "research",
    mode: "session",
    requester: {
      channel: "telegram",
      accountId: "a",
      to: "u",
      threadId: "t",
    },
    threadRequested: true,
    ...overrides,
  };
}

function makeDeliveryEvent(
  overrides: Partial<PluginHookSubagentDeliveryTargetEvent> = {},
): PluginHookSubagentDeliveryTargetEvent {
  return {
    childSessionKey: CHILD_SESSION_KEY,
    requesterSessionKey: REQUESTER_SESSION_KEY,
    requesterOrigin: undefined,
    childRunId: "run-1",
    spawnMode: "session",
    expectsCompletionMessage: true,
    ...overrides,
  };
}

function makeEndedEvent(
  overrides: Partial<PluginHookSubagentEndedEvent> = {},
): PluginHookSubagentEndedEvent {
  return {
    targetSessionKey: CHILD_SESSION_KEY,
    targetKind: "subagent",
    reason: "subagent-complete",
    outcome: "ok",
    runId: "run-1",
    ...overrides,
  };
}

afterEach(() => {
  __resetDefaultSubagentSpawningStateForTests();
});

describe("registerDefaultSubagentHooksIfMissing", () => {
  it("registers all three default hooks on a registry that has none, and exposes them via the hook runner", () => {
    const registry = createEmptyPluginRegistry();

    const result = registerDefaultSubagentHooksIfMissing({ registry });

    expect(result).toEqual({
      registeredSpawning: true,
      registeredDeliveryTarget: true,
      registeredEnded: true,
    });

    const runner = createHookRunner(registry);
    expect(runner.hasHooks("subagent_spawning")).toBe(true);
    expect(runner.hasHooks("subagent_delivery_target")).toBe(true);
    expect(runner.hasHooks("subagent_ended")).toBe(true);

    const ours = registry.typedHooks.filter(
      (h) => h.pluginId === DEFAULT_SUBAGENT_HOOKS_PLUGIN_ID,
    );
    expect(ours.map((h) => h.hookName).sort()).toEqual([
      "subagent_delivery_target",
      "subagent_ended",
      "subagent_spawning",
    ]);
  });

  it("does NOT register the default when a plugin already provided a subagent_spawning hook", () => {
    const registry = createEmptyPluginRegistry();
    registry.typedHooks.push({
      pluginId: "channel-X",
      hookName: "subagent_spawning",
      handler: vi.fn(),
      priority: 0,
      source: "test",
    });

    const result = registerDefaultSubagentHooksIfMissing({ registry });

    expect(result).toEqual({
      registeredSpawning: false,
      registeredDeliveryTarget: false,
      registeredEnded: false,
    });

    const ours = registry.typedHooks.filter(
      (h) => h.pluginId === DEFAULT_SUBAGENT_HOOKS_PLUGIN_ID,
    );
    expect(ours).toEqual([]);

    const runner = createHookRunner(registry);
    expect(runner.hasHooks("subagent_spawning")).toBe(true);
    // No double-handling: only the channel plugin's hook is wired.
    expect(
      registry.typedHooks.filter((h) => h.hookName === "subagent_spawning"),
    ).toHaveLength(1);
    expect(runner.hasHooks("subagent_delivery_target")).toBe(false);
  });

  it("does NOT register the default when a plugin already provided a subagent_delivery_target hook", () => {
    const registry = createEmptyPluginRegistry();
    registry.typedHooks.push({
      pluginId: "channel-Y",
      hookName: "subagent_delivery_target",
      handler: vi.fn(),
      priority: 0,
      source: "test",
    });

    const result = registerDefaultSubagentHooksIfMissing({ registry });

    expect(result).toEqual({
      registeredSpawning: false,
      registeredDeliveryTarget: false,
      registeredEnded: false,
    });

    const ours = registry.typedHooks.filter(
      (h) => h.pluginId === DEFAULT_SUBAGENT_HOOKS_PLUGIN_ID,
    );
    expect(ours).toEqual([]);
  });
});

describe("defaultSubagentSpawningHandler", () => {
  it("records the requester origin and reports thread binding ready for thread-bound spawns", async () => {
    const registry = createEmptyPluginRegistry();
    registerDefaultSubagentHooksIfMissing({ registry });
    const runner = createHookRunner(registry);

    const event = makeSpawningEvent({
      requester: {
        channel: "telegram",
        accountId: "a",
        to: "u",
        threadId: "t",
      },
    });

    const result = (await runner.runSubagentSpawning(
      event,
      baseSubagentCtx,
    )) as PluginHookSubagentSpawningResult;

    expect(result).toEqual({ status: "ok", threadBindingReady: true });

    const recorded = __getRecordedRequesterOriginForTests(CHILD_SESSION_KEY);
    expect(recorded).toEqual({
      channel: "telegram",
      accountId: "a",
      to: "u",
      threadId: "t",
    });
  });

  it("returns undefined and records nothing when threadRequested is false", () => {
    const event = makeSpawningEvent({ threadRequested: false });
    const result = defaultSubagentSpawningHandler(event, baseSubagentCtx);
    expect(result).toBeUndefined();
    expect(__getRecordedRequesterOriginForTests(CHILD_SESSION_KEY)).toBeUndefined();
  });

  it("still reports ok when there is no requester origin to record", () => {
    const event = makeSpawningEvent({ requester: undefined });
    const result = defaultSubagentSpawningHandler(event, baseSubagentCtx);
    expect(result).toEqual({ status: "ok", threadBindingReady: true });
    expect(__getRecordedRequesterOriginForTests(CHILD_SESSION_KEY)).toBeUndefined();
  });
});

describe("defaultSubagentDeliveryTargetHandler", () => {
  it("returns the recorded origin keyed by childSessionKey after a spawn", async () => {
    const registry = createEmptyPluginRegistry();
    registerDefaultSubagentHooksIfMissing({ registry });
    const runner = createHookRunner(registry);

    await runner.runSubagentSpawning(
      makeSpawningEvent({
        requester: {
          channel: "telegram",
          accountId: "a",
          to: "u",
          threadId: "t",
        },
      }),
      baseSubagentCtx,
    );

    const result = await runner.runSubagentDeliveryTarget(
      makeDeliveryEvent(),
      baseSubagentCtx,
    );

    expect(result).toEqual({
      origin: {
        channel: "telegram",
        accountId: "a",
        to: "u",
        threadId: "t",
      },
    });
  });

  it("falls back to the event's requesterOrigin when no recorded mapping exists", () => {
    const result = defaultSubagentDeliveryTargetHandler(
      makeDeliveryEvent({
        childSessionKey: "agent:main:subagent:unknown",
        requesterOrigin: {
          channel: "webchat",
          accountId: "wc-acct",
          to: "session:42",
          threadId: undefined,
        },
      }),
      baseSubagentCtx,
    );
    expect(result).toEqual({
      origin: {
        channel: "webchat",
        accountId: "wc-acct",
        to: "session:42",
      },
    });
  });

  it("returns undefined when neither a recorded mapping nor a usable event origin is available", () => {
    const result = defaultSubagentDeliveryTargetHandler(
      makeDeliveryEvent({
        childSessionKey: "agent:main:subagent:unknown",
        requesterOrigin: undefined,
      }),
      baseSubagentCtx,
    );
    expect(result).toBeUndefined();
  });
});

describe("defaultSubagentEndedHandler", () => {
  it("removes the recorded mapping so the in-memory map cannot leak", async () => {
    const registry = createEmptyPluginRegistry();
    registerDefaultSubagentHooksIfMissing({ registry });
    const runner = createHookRunner(registry);

    await runner.runSubagentSpawning(makeSpawningEvent(), baseSubagentCtx);
    expect(__getRecordedRequesterOriginForTests(CHILD_SESSION_KEY)).toBeDefined();

    await runner.runSubagentEnded(makeEndedEvent(), baseSubagentCtx);

    expect(__getRecordedRequesterOriginForTests(CHILD_SESSION_KEY)).toBeUndefined();

    const post = await runner.runSubagentDeliveryTarget(
      makeDeliveryEvent({ requesterOrigin: undefined }),
      baseSubagentCtx,
    );
    expect(post).toBeUndefined();
  });

  it("ignores ended events with a missing/blank targetSessionKey", () => {
    requesterOriginByChildSessionKeySet({
      channel: "telegram",
      accountId: "a",
      to: "u",
      threadId: "t",
    });
    expect(__getRecordedRequesterOriginForTests(CHILD_SESSION_KEY)).toBeDefined();

    defaultSubagentEndedHandler(
      makeEndedEvent({ targetSessionKey: "" }),
      baseSubagentCtx,
    );

    expect(__getRecordedRequesterOriginForTests(CHILD_SESSION_KEY)).toBeDefined();
  });
});

// --- helpers -------------------------------------------------------------

function requesterOriginByChildSessionKeySet(origin: {
  channel: string;
  accountId: string;
  to: string;
  threadId: string;
}): void {
  // Re-use the public spawning handler so we don't reach into module
  // internals just to seed the map for the "blank targetSessionKey" assertion.
  defaultSubagentSpawningHandler(
    {
      childSessionKey: CHILD_SESSION_KEY,
      agentId: "main",
      mode: "session",
      requester: origin,
      threadRequested: true,
    },
    baseSubagentCtx,
  );
}
