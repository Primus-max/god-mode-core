import type { PlatformRuntimeRunClosureSummary } from "../platform/runtime/index.js";
import type { SessionRunStatus } from "./session-utils.types.js";

export function resolveSessionRunStatusFromClosureSummary(
  summary: PlatformRuntimeRunClosureSummary,
): SessionRunStatus {
  return summary.action === "close" ? "done" : summary.action === "stop" ? "failed" : "blocked";
}
