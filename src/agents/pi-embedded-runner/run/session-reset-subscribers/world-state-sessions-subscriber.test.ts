import { describe, expect, it } from "vitest";

import type { SessionId } from "../../../../platform/commitment/ids.js";
import {
  createSessionResetSubscriberRegistry,
  resetTurnSession,
  type SessionResetEvent,
} from "../../../../platform/session/reset.js";

import { createWorldStateSessionsSubscriber } from "./world-state-sessions-subscriber.js";

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

describe("subscriber:world-state-sessions-current-flip — default no-op posture", () => {
  it("emits kind=skipped when flipCurrentSession is unbound (audit derived view)", async () => {
    const subscriber = createWorldStateSessionsSubscriber();
    expect(subscriber.id).toBe("subscriber:world-state-sessions-current-flip");
    expect(subscriber.category).toBe("world-state");
    const outcome = await subscriber.onReset(buildEvent());
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toContain("derived projection");
    }
  });
});

describe("subscriber:world-state-sessions-current-flip — future-flip path", () => {
  it("emits kind=cleared when flipCurrentSession returns true", async () => {
    const captured: string[] = [];
    const subscriber = createWorldStateSessionsSubscriber({
      flipCurrentSession: (sessionId) => {
        captured.push(sessionId);
        return true;
      },
    });
    const outcome = await subscriber.onReset(buildEvent());
    expect(outcome.kind).toBe("cleared");
    if (outcome.kind === "cleared") {
      expect(outcome.details).toEqual({ sessionId: SESSION_ID });
    }
    expect(captured).toEqual([SESSION_ID]);
  });

  it("emits kind=skipped reason=no_pointer_change when dep returns false", async () => {
    const subscriber = createWorldStateSessionsSubscriber({
      flipCurrentSession: () => false,
    });
    const outcome = await subscriber.onReset(buildEvent());
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("no_pointer_change");
    }
  });
});

describe("subscriber:world-state-sessions-current-flip — failure isolation", () => {
  it("converts a thrown dep into kind=failed", async () => {
    const subscriber = createWorldStateSessionsSubscriber({
      flipCurrentSession: () => {
        throw new Error("registry_unavailable");
      },
    });
    const outcome = await subscriber.onReset(buildEvent());
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.reason).toBe("registry_unavailable");
    }
  });

  it("does not block other subscribers when the dep throws", async () => {
    const registry = createSessionResetSubscriberRegistry();
    let secondRan = false;
    registry.register(
      createWorldStateSessionsSubscriber({
        flipCurrentSession: () => {
          throw new Error("explode");
        },
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
