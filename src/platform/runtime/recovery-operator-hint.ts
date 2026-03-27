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
  const st = checkpoint.status;
  const cont = checkpoint.continuation?.state;
  if (st === "blocked" || st === "approved") {
    return "Awaiting operator approval to resume messaging recovery.";
  }
  if (st === "resumed" && cont === "running") {
    return "Recovery continuation is dispatching.";
  }
  if (st === "resumed" && (cont === "idle" || cont === undefined)) {
    return "Recovery followup is in progress or queued.";
  }
  if (st === "completed") {
    return "Recovery completed successfully.";
  }
  if (st === "denied") {
    return "Recovery was denied by the operator.";
  }
  if (st === "cancelled") {
    const err = checkpoint.continuation?.lastError?.trim();
    return err ? `Recovery ended: ${err}` : "Recovery ended without success.";
  }
  return undefined;
}
