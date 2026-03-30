import type { PlatformRuntimeCheckpointSummary } from "./contracts.js";

/**
 * Human-readable recovery state for operator surfaces. Derived only from
 * checkpoint summary (no second source of truth).
 */
export function deriveRecoveryOperatorHint(
  checkpoint: PlatformRuntimeCheckpointSummary | undefined,
): string | undefined {
  if (!checkpoint || checkpoint.target?.operation !== "closure.recovery") {
    return undefined;
  }
  const runRef = checkpoint.runId.trim();
  const st = checkpoint.status;
  const cont = checkpoint.continuation?.state;
  if (st === "blocked" || st === "approved") {
    return `Awaiting operator approval to resume messaging recovery for run ${runRef}.`;
  }
  if (st === "resumed" && cont === "running") {
    return `Recovery continuation for run ${runRef} is dispatching.`;
  }
  if (st === "resumed" && (cont === "idle" || cont === undefined)) {
    return `Recovery followup for run ${runRef} is in progress or queued.`;
  }
  if (st === "completed") {
    return `Recovery for run ${runRef} completed successfully.`;
  }
  if (st === "denied") {
    return `Recovery for run ${runRef} was denied by the operator.`;
  }
  if (st === "cancelled") {
    const err = checkpoint.continuation?.lastError?.trim();
    return err ? `Recovery ended: ${err}` : "Recovery ended without success.";
  }
  return undefined;
}
