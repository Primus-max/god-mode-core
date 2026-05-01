import type { QueueSettings } from "./queue.js";

export type ActiveRunQueueAction = "run-now" | "enqueue-followup" | "drop";

export function resolveActiveRunQueueAction(params: {
  isActive: boolean;
  isHeartbeat: boolean;
  shouldFollowup: boolean;
  queueMode: QueueSettings["mode"];
  /**
   * True when a deferred ack-then-defer bg-job is currently owning this
   * queue key. When set, new non-heartbeat user messages are routed through
   * the steer/enqueue-followup path so the background job can consume them
   * as steer signals instead of spawning a parallel turn. (P1.4 D.2)
   */
  isDeferredJobRunning?: boolean;
}): ActiveRunQueueAction {
  if (!params.isActive && !params.isDeferredJobRunning) {
    return "run-now";
  }
  if (params.isHeartbeat) {
    return "drop";
  }
  if (params.isDeferredJobRunning) {
    return "enqueue-followup";
  }
  if (params.shouldFollowup || params.queueMode === "steer") {
    return "enqueue-followup";
  }
  return "run-now";
}
