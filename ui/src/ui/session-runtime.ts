import type { GatewaySessionRow } from "./types.ts";

export function resolveSessionRuntimeInspectRunId(
  row: Pick<
    GatewaySessionRow,
    "handoffTruthSource" | "handoffRunId" | "handoffRequestRunId" | "runClosureSummary"
  > | null | undefined,
): string | undefined {
  const closureRunId = row?.runClosureSummary?.runId;
  if (row?.handoffTruthSource === "recovery") {
    return row.handoffRunId ?? row.handoffRequestRunId ?? closureRunId;
  }
  if (row?.handoffTruthSource === "closure") {
    return row.handoffRunId ?? closureRunId ?? row.handoffRequestRunId;
  }
  return row?.handoffRunId ?? row?.handoffRequestRunId ?? closureRunId;
}
