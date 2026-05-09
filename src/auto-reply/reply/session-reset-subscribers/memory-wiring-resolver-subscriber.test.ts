import { describe, expect, it } from "vitest";

import type { SessionId } from "../../../platform/identity/branded-ids.js";
import {
  createSessionResetSubscriberRegistry,
  resetTurnSession,
  type SessionResetEvent,
} from "../../../platform/session/reset.js";

import { createMemoryWiringResolverSubscriber } from "./memory-wiring-resolver-subscriber.js";

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

describe("subscriber:memory-wiring-resolver-clear — default no-op posture", () => {
  it("emits kind=skipped with the audit-confirmed reason when no cache dep is bound", async () => {
    const subscriber = createMemoryWiringResolverSubscriber();
    expect(subscriber.id).toBe("subscriber:memory-wiring-resolver-clear");
    expect(subscriber.category).toBe("misc");
    const outcome = await subscriber.onReset(buildEvent());
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toContain("pure factory");
      expect(outcome.reason).toContain("audit §a row 10");
    }
  });
});

describe("subscriber:memory-wiring-resolver-clear — future-flip path", () => {
  it("emits kind=cleared when clearCache is bound and reports >0 entries", async () => {
    const calls: string[] = [];
    const subscriber = createMemoryWiringResolverSubscriber({
      clearCache: (sessionId) => {
        calls.push(sessionId);
        return 2;
      },
    });
    const outcome = await subscriber.onReset(buildEvent());
    expect(outcome.kind).toBe("cleared");
    if (outcome.kind === "cleared") {
      expect(outcome.details).toEqual({
        sessionId: PREV_SESSION_ID,
        entriesCleared: 2,
      });
    }
    expect(calls).toEqual([PREV_SESSION_ID]);
  });

  it("falls back to sessionId when previousSessionId is absent", async () => {
    const calls: string[] = [];
    const subscriber = createMemoryWiringResolverSubscriber({
      clearCache: (sessionId) => {
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

  it("emits kind=skipped reason=no_cache_entries_for_session when dep returns 0", async () => {
    const subscriber = createMemoryWiringResolverSubscriber({
      clearCache: () => 0,
    });
    const outcome = await subscriber.onReset(buildEvent());
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("no_cache_entries_for_session");
    }
  });
});

describe("subscriber:memory-wiring-resolver-clear — failure isolation", () => {
  it("converts a thrown clearCache into kind=failed without rethrow", async () => {
    const subscriber = createMemoryWiringResolverSubscriber({
      clearCache: () => {
        throw new Error("cache_corrupt");
      },
    });
    const outcome = await subscriber.onReset(buildEvent());
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.reason).toBe("cache_corrupt");
    }
  });

  it("does not block other subscribers when the dep throws", async () => {
    const registry = createSessionResetSubscriberRegistry();
    let secondRan = false;
    registry.register(
      createMemoryWiringResolverSubscriber({
        clearCache: () => {
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
