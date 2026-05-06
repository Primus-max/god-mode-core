import { describe, expect, it } from "vitest";

import type { SessionId } from "../../../platform/commitment/ids.js";
import {
  createSessionResetSubscriberRegistry,
  resetTurnSession,
  type SessionResetEvent,
} from "../../../platform/session/reset.js";
import type {
  PluginHookSessionContext,
  PluginHookSessionEndEvent,
  PluginHookSessionStartEvent,
} from "../../../plugins/types.js";

import {
  createPluginHooksSubscriber,
  type PluginHookFanOut,
} from "./plugin-hooks-subscriber.js";

const VALID_ISO = "2026-05-06T18:25:00.000Z";
const SESSION_ID = "f71784c5-aaaa-bbbb-cccc-111111111111" as SessionId;
const PREV_SESSION_ID = "99f9e4f2-82be-4148-bd79-ffb80a2e07e3" as SessionId;

function buildEvent(overrides: Partial<SessionResetEvent> = {}): SessionResetEvent {
  return {
    sessionId: SESSION_ID,
    sessionKey: "telegram:6533456892",
    previousSessionId: PREV_SESSION_ID,
    reason: "reset_trigger",
    occurredAt: VALID_ISO,
    ...overrides,
  };
}

type RecordedCall =
  | { kind: "end"; event: PluginHookSessionEndEvent; ctx: PluginHookSessionContext }
  | {
      kind: "start";
      event: PluginHookSessionStartEvent;
      ctx: PluginHookSessionContext;
    };

function buildFakeHookRunner(): {
  runner: PluginHookFanOut;
  calls: RecordedCall[];
  registered: Set<"session_start" | "session_end">;
} {
  const calls: RecordedCall[] = [];
  const registered = new Set<"session_start" | "session_end">([
    "session_start",
    "session_end",
  ]);
  const runner: PluginHookFanOut = {
    hasHooks: (name) => registered.has(name),
    async runSessionStart(event, ctx) {
      calls.push({ kind: "start", event, ctx });
    },
    async runSessionEnd(event, ctx) {
      calls.push({ kind: "end", event, ctx });
    },
  };
  return { runner, calls, registered };
}

describe("subscriber:plugin-hooks — round-trip with both hooks registered", () => {
  it("fires session_end for previousSessionId and session_start for sessionId", async () => {
    const fake = buildFakeHookRunner();
    const subscriber = createPluginHooksSubscriber({
      resolveHookRunner: () => fake.runner,
      resolveAgentId: () => "agent:demo",
    });
    const outcome = await subscriber.onReset(buildEvent());
    expect(outcome.kind).toBe("cleared");
    if (outcome.kind === "cleared") {
      expect(outcome.details).toEqual({
        firedSessionEnd: true,
        firedSessionStart: true,
      });
    }
    const endCall = fake.calls.find((c) => c.kind === "end");
    expect(endCall?.event.sessionId).toBe(PREV_SESSION_ID);
    expect(endCall?.ctx.agentId).toBe("agent:demo");
    const startCall = fake.calls.find((c) => c.kind === "start");
    expect(startCall?.event.sessionId).toBe(SESSION_ID);
    expect(startCall?.event.resumedFrom).toBe(PREV_SESSION_ID);
  });

  it("does NOT fire session_end when previousSessionId is missing", async () => {
    const fake = buildFakeHookRunner();
    const subscriber = createPluginHooksSubscriber({
      resolveHookRunner: () => fake.runner,
    });
    const outcome = await subscriber.onReset(
      buildEvent({ previousSessionId: undefined }),
    );
    expect(outcome.kind).toBe("cleared");
    expect(fake.calls.find((c) => c.kind === "end")).toBeUndefined();
    expect(fake.calls.find((c) => c.kind === "start")).toBeDefined();
  });

  it("does NOT fire session_end when previousSessionId equals new sessionId", async () => {
    const fake = buildFakeHookRunner();
    const subscriber = createPluginHooksSubscriber({
      resolveHookRunner: () => fake.runner,
    });
    const outcome = await subscriber.onReset(
      buildEvent({ previousSessionId: SESSION_ID }),
    );
    expect(outcome.kind).toBe("cleared");
    expect(fake.calls.find((c) => c.kind === "end")).toBeUndefined();
  });
});

describe("subscriber:plugin-hooks — degenerate paths", () => {
  it("emits skipped when getGlobalHookRunner returns null (early-boot window)", async () => {
    const subscriber = createPluginHooksSubscriber({
      resolveHookRunner: () => null,
    });
    const outcome = await subscriber.onReset(buildEvent());
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("no_global_hook_runner");
    }
  });

  it("emits skipped when neither session_start nor session_end is registered", async () => {
    const fake = buildFakeHookRunner();
    fake.registered.clear();
    const subscriber = createPluginHooksSubscriber({
      resolveHookRunner: () => fake.runner,
    });
    const outcome = await subscriber.onReset(buildEvent());
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("no_session_hooks_registered");
    }
    expect(fake.calls.length).toBe(0);
  });
});

describe("subscriber:plugin-hooks — failure isolation", () => {
  it("converts a thrown runSessionStart into kind=failed without rethrow", async () => {
    const fake = buildFakeHookRunner();
    const subscriber = createPluginHooksSubscriber({
      resolveHookRunner: () => ({
        ...fake.runner,
        runSessionStart: async () => {
          throw new Error("plugin_blew_up");
        },
      }),
    });
    const outcome = await subscriber.onReset(buildEvent());
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.reason).toBe("plugin_blew_up");
    }
  });

  it("does not block other subscribers when the dep throws", async () => {
    const fake = buildFakeHookRunner();
    let secondRan = false;
    const registry = createSessionResetSubscriberRegistry();
    registry.register(
      createPluginHooksSubscriber({
        resolveHookRunner: () => ({
          ...fake.runner,
          runSessionStart: async () => {
            throw new Error("explode");
          },
        }),
      }),
    );
    registry.register({
      id: "subscriber:second-test" as never,
      category: "misc",
      async onReset() {
        secondRan = true;
        return { kind: "skipped" as const, reason: "test" };
      },
    });
    const summary = await resetTurnSession({ event: buildEvent(), registry });
    expect(summary.failedCount).toBe(1);
    expect(secondRan).toBe(true);
  });
});
