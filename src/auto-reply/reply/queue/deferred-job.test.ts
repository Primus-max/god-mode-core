import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearDeferredJob,
  isDeferredJobRunningForQueue,
  markDeferredJobComplete,
  markDeferredJobRunning,
  resetInMemoryFollowupQueuesForTests,
} from "./state.js";

const KEY = "test-queue:deferred-job";

describe("deferred_job queue state (P1.4 D.2)", () => {
  beforeEach(() => {
    resetInMemoryFollowupQueuesForTests();
  });
  afterEach(() => {
    resetInMemoryFollowupQueuesForTests();
  });

  it("returns false when no deferred job has been registered", () => {
    expect(isDeferredJobRunningForQueue(KEY)).toBe(false);
  });

  it("marks a deferred job as running and reports it", () => {
    markDeferredJobRunning(KEY, { turnId: "turn-1", ackMessage: "ok" });
    expect(isDeferredJobRunningForQueue(KEY)).toBe(true);
  });

  it("treats queueKey as empty string safely (no throw)", () => {
    expect(() =>
      markDeferredJobRunning("", { turnId: "turn-x" }),
    ).not.toThrow();
    expect(isDeferredJobRunningForQueue("")).toBe(false);
  });

  it("transitions through running → done and drops the running flag after clear", () => {
    markDeferredJobRunning(KEY, { turnId: "turn-2" });
    expect(isDeferredJobRunningForQueue(KEY)).toBe(true);

    markDeferredJobComplete(KEY, { turnId: "turn-2", status: "done" });
    expect(isDeferredJobRunningForQueue(KEY)).toBe(false);

    clearDeferredJob(KEY);
    expect(isDeferredJobRunningForQueue(KEY)).toBe(false);
  });

  it("does not alter state when complete targets a different turnId", () => {
    markDeferredJobRunning(KEY, { turnId: "turn-real" });
    markDeferredJobComplete(KEY, { turnId: "turn-stale", status: "failed" });
    expect(isDeferredJobRunningForQueue(KEY)).toBe(true);
  });

  it("supports failed outcome as a terminal state", () => {
    markDeferredJobRunning(KEY, { turnId: "turn-3" });
    markDeferredJobComplete(KEY, { turnId: "turn-3", status: "failed" });
    expect(isDeferredJobRunningForQueue(KEY)).toBe(false);
  });
});
