import { describe, expect, it } from "vitest";

import type { SessionId } from "../../../platform/identity/branded-ids.js";
import {
  createSessionResetSubscriberRegistry,
  resetTurnSession,
  type SessionResetEvent,
} from "../../../platform/session/reset.js";
import {
  DEFAULT_QUEUE_CAP,
  DEFAULT_QUEUE_DEBOUNCE_MS,
  DEFAULT_QUEUE_DROP,
  FOLLOWUP_QUEUES,
  clearFollowupQueue,
  resetInMemoryFollowupQueuesForTests,
} from "../queue/state.js";

import { createFollowupQueueClearSubscriber } from "./followup-queue-clear-subscriber.js";

/**
 * NEW-B Phase 4 — fail-first round-trip + reverse-test for
 * `subscriber:followup-queue-clear` (PRIMARY fix).
 *
 * Per Phase 1 audit §f, the live evidence (gateway-pr211.log
 * 2026-05-06 18:25-18:27) is the auto-reply `/new` path NOT clearing
 * `FOLLOWUP_QUEUES` while the gateway-RPC reset path DOES. The
 * round-trip test populates the queue with a real entry, runs the
 * subscriber, and asserts the queue is empty. The reverse-test omits
 * the subscriber and asserts the entry survives — that is the bug
 * reproduction at subscriber granularity.
 *
 * Tests use the REAL `FOLLOWUP_QUEUES` map and the REAL
 * `clearFollowupQueue` API (no `vi.spyOn` on the subscriber's own
 * function). The fail-isolation test injects a thrown-from-dep stub to
 * assert the subscriber returns `kind: 'failed'` without rethrowing.
 */

const VALID_ISO = "2026-05-06T18:25:00.000Z";
const SESSION_ID = "f71784c5-aaaa-bbbb-cccc-111111111111" as SessionId;

function buildEvent(overrides: Partial<SessionResetEvent> = {}): SessionResetEvent {
  return {
    sessionId: SESSION_ID,
    sessionKey: "telegram:6533456892",
    reason: "reset_trigger",
    occurredAt: VALID_ISO,
    ...overrides,
  };
}

function seedQueueWithCorrectiveFollowup(sessionKey: string): void {
  // Mirror the real shape produced by closure-outcome-dispatcher.ts:842-847
  // (a queued followup that embeds the prior turn's user prompt verbatim).
  FOLLOWUP_QUEUES.set(sessionKey, {
    items: [
      {
        run: {
          attemptId: "attempt-001",
          promptText: "запомни мне рецепт борща: свекла, капуста, картошка",
        } as unknown as never,
        prompt:
          "[Original task - preserve exact task intent below]\n\nзапомни мне рецепт борща: свекла, капуста, картошка",
      } as unknown as never,
    ],
    draining: false,
    lastEnqueuedAt: 1_000,
    mode: "followup",
    debounceMs: DEFAULT_QUEUE_DEBOUNCE_MS,
    cap: DEFAULT_QUEUE_CAP,
    dropPolicy: DEFAULT_QUEUE_DROP,
    droppedCount: 0,
    summaryLines: ["queued #1: corrective re-run"],
  });
}

describe("subscriber:followup-queue-clear — round-trip", () => {
  it("clears the followup queue keyed by sessionKey and returns kind=cleared", async () => {
    resetInMemoryFollowupQueuesForTests();
    seedQueueWithCorrectiveFollowup("telegram:6533456892");
    expect(FOLLOWUP_QUEUES.get("telegram:6533456892")?.items.length).toBe(1);

    const subscriber = createFollowupQueueClearSubscriber({
      clearFollowupQueue,
    });
    const outcome = await subscriber.onReset(
      buildEvent({ sessionKey: "telegram:6533456892" }),
    );

    expect(outcome.kind).toBe("cleared");
    if (outcome.kind === "cleared") {
      expect(outcome.details).toEqual({
        sessionKey: "telegram:6533456892",
        entriesCleared: 1,
      });
    }
    expect(FOLLOWUP_QUEUES.get("telegram:6533456892")).toBeUndefined();
    resetInMemoryFollowupQueuesForTests();
  });

  it("returns kind=skipped with reason=no_queued_followups when the queue is absent", async () => {
    resetInMemoryFollowupQueuesForTests();
    const subscriber = createFollowupQueueClearSubscriber({
      clearFollowupQueue,
    });
    const outcome = await subscriber.onReset(
      buildEvent({ sessionKey: "telegram:7777777777" }),
    );
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("no_queued_followups");
    }
  });
});

describe("subscriber:followup-queue-clear — reverse-test (bug reproduction)", () => {
  it("queue survives /new when subscriber NOT registered", async () => {
    resetInMemoryFollowupQueuesForTests();
    seedQueueWithCorrectiveFollowup("telegram:6533456892");
    const registry = createSessionResetSubscriberRegistry();
    // Intentionally NO register() — this reproduces the live leak.
    const summary = await resetTurnSession({
      event: buildEvent({ sessionKey: "telegram:6533456892" }),
      registry,
    });
    expect(summary.subscribers.length).toBe(0);
    expect(FOLLOWUP_QUEUES.get("telegram:6533456892")?.items.length).toBe(1);
    resetInMemoryFollowupQueuesForTests();
  });

  it("queue is cleared when subscriber IS registered (positive control)", async () => {
    resetInMemoryFollowupQueuesForTests();
    seedQueueWithCorrectiveFollowup("telegram:6533456892");
    const registry = createSessionResetSubscriberRegistry();
    registry.register(
      createFollowupQueueClearSubscriber({ clearFollowupQueue }),
    );
    const summary = await resetTurnSession({
      event: buildEvent({ sessionKey: "telegram:6533456892" }),
      registry,
    });
    expect(summary.clearedCount).toBe(1);
    expect(FOLLOWUP_QUEUES.get("telegram:6533456892")).toBeUndefined();
    resetInMemoryFollowupQueuesForTests();
  });
});

describe("subscriber:followup-queue-clear — failure isolation", () => {
  it("returns kind=failed when the dep throws and does not propagate", async () => {
    const subscriber = createFollowupQueueClearSubscriber({
      clearFollowupQueue: () => {
        throw new Error("simulated_backend_outage");
      },
    });
    const outcome = await subscriber.onReset(buildEvent());
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.reason).toBe("simulated_backend_outage");
    }
  });

  it("non-Error throws are stringified into reason without rethrow", async () => {
    const subscriber = createFollowupQueueClearSubscriber({
      clearFollowupQueue: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "raw_string_error";
      },
    });
    const outcome = await subscriber.onReset(buildEvent());
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.reason).toBe("non_error_throw:raw_string_error");
    }
  });

  it("subscriber failure does NOT block other registry members", async () => {
    resetInMemoryFollowupQueuesForTests();
    let secondRan = false;
    const registry = createSessionResetSubscriberRegistry();
    registry.register(
      createFollowupQueueClearSubscriber({
        clearFollowupQueue: () => {
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
    const summary = await resetTurnSession({
      event: buildEvent(),
      registry,
    });
    expect(summary.failedCount).toBe(1);
    expect(summary.skippedCount).toBe(1);
    expect(secondRan).toBe(true);
  });
});
