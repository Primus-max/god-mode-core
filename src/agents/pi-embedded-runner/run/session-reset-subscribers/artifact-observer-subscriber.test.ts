import { describe, expect, it } from "vitest";

import type { SessionId } from "../../../../platform/commitment/ids.js";
import {
  createSessionResetSubscriberRegistry,
  resetTurnSession,
  type SessionResetEvent,
} from "../../../../platform/session/reset.js";

import { createArtifactObserverSubscriber } from "./artifact-observer-subscriber.js";

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

describe("subscriber:artifact-observer-clear — default no-op posture", () => {
  it("emits kind=skipped when no clearForSession API is bound (audit §g)", async () => {
    const subscriber = createArtifactObserverSubscriber();
    expect(subscriber.id).toBe("subscriber:artifact-observer-clear");
    expect(subscriber.category).toBe("observer");
    const outcome = await subscriber.onReset(buildEvent());
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toContain("naturally orphans");
    }
  });
});

describe("subscriber:artifact-observer-clear — future-flip path", () => {
  it("emits kind=cleared when clearForSession is bound and reports >0 buckets", async () => {
    const calls: string[] = [];
    const subscriber = createArtifactObserverSubscriber({
      clearForSession: (sessionId) => {
        calls.push(sessionId);
        return 3;
      },
    });
    const outcome = await subscriber.onReset(buildEvent());
    expect(outcome.kind).toBe("cleared");
    if (outcome.kind === "cleared") {
      expect(outcome.details).toEqual({
        sessionId: PREV_SESSION_ID,
        bucketsCleared: 3,
      });
    }
    expect(calls).toEqual([PREV_SESSION_ID]);
  });

  it("falls back to sessionId when previousSessionId is absent", async () => {
    const calls: string[] = [];
    const subscriber = createArtifactObserverSubscriber({
      clearForSession: (sessionId) => {
        calls.push(sessionId);
        return 1;
      },
    });
    const outcome = await subscriber.onReset(
      buildEvent({ previousSessionId: undefined }),
    );
    expect(outcome.kind).toBe("cleared");
    expect(calls).toEqual([SESSION_ID]);
  });

  it("emits kind=skipped reason=no_buckets_for_session when clearForSession returns 0", async () => {
    const subscriber = createArtifactObserverSubscriber({
      clearForSession: () => 0,
    });
    const outcome = await subscriber.onReset(buildEvent());
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("no_buckets_for_session");
    }
  });
});

describe("subscriber:artifact-observer-clear — failure isolation", () => {
  it("converts a thrown clearForSession into kind=failed without rethrow", async () => {
    const subscriber = createArtifactObserverSubscriber({
      clearForSession: () => {
        throw new Error("collector_outage");
      },
    });
    const outcome = await subscriber.onReset(buildEvent());
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.reason).toBe("collector_outage");
    }
  });

  it("does not block other subscribers when the dep throws", async () => {
    const registry = createSessionResetSubscriberRegistry();
    let secondRan = false;
    registry.register(
      createArtifactObserverSubscriber({
        clearForSession: () => {
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
