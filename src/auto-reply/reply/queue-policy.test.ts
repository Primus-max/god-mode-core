import { describe, expect, it } from "vitest";
import { resolveActiveRunQueueAction } from "./queue-policy.js";

describe("resolveActiveRunQueueAction", () => {
  it("runs immediately when there is no active run", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: false,
        isHeartbeat: false,
        shouldFollowup: true,
        queueMode: "collect",
      }),
    ).toBe("run-now");
  });

  it("drops heartbeat runs while another run is active", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: true,
        isHeartbeat: true,
        shouldFollowup: true,
        queueMode: "collect",
      }),
    ).toBe("drop");
  });

  it("enqueues followups for non-heartbeat active runs", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: true,
        isHeartbeat: false,
        shouldFollowup: true,
        queueMode: "collect",
      }),
    ).toBe("enqueue-followup");
  });

  it("enqueues steer mode runs while active", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: true,
        isHeartbeat: false,
        shouldFollowup: false,
        queueMode: "steer",
      }),
    ).toBe("enqueue-followup");
  });

  it("enqueues non-heartbeat user messages while a deferred bg-job owns the turn", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: true,
        isHeartbeat: false,
        shouldFollowup: false,
        queueMode: "collect",
        isDeferredJobRunning: true,
      }),
    ).toBe("enqueue-followup");
  });

  it("still drops heartbeats while a deferred bg-job is running", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: true,
        isHeartbeat: true,
        shouldFollowup: false,
        queueMode: "collect",
        isDeferredJobRunning: true,
      }),
    ).toBe("drop");
  });

  it("treats deferred_job as active even when isActive is false", () => {
    // A bg-job may have released the active run flag but still own the
    // queue key; we must still steer follow-ups into that job instead of
    // spawning a parallel turn.
    expect(
      resolveActiveRunQueueAction({
        isActive: false,
        isHeartbeat: false,
        shouldFollowup: false,
        queueMode: "collect",
        isDeferredJobRunning: true,
      }),
    ).toBe("enqueue-followup");
  });

  it("does NOT run-now when a deferred bg-job is running, even with no other active run", () => {
    // Regression guard: the presence of deferred_job must never fall
    // through to "run-now", otherwise a second user message during a
    // deferred job would spawn a parallel turn.
    const action = resolveActiveRunQueueAction({
      isActive: false,
      isHeartbeat: false,
      shouldFollowup: false,
      queueMode: "collect",
      isDeferredJobRunning: true,
    });
    expect(action).not.toBe("run-now");
  });
});
