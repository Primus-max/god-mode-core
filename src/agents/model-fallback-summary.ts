import type { FallbackAttempt, ModelFallbackSummary } from "./model-fallback.types.js";
import type { FailoverReason } from "./pi-embedded-helpers.js";

function getTerminalAttemptReason(attempts: readonly FallbackAttempt[]): {
  reason?: FailoverReason;
  status?: number;
  code?: string;
} {
  const terminal = attempts.at(-1);
  return {
    reason: terminal?.reason,
    status: terminal?.status,
    code: terminal?.code,
  };
}

export function buildModelFallbackSummary(params: {
  requestedProvider: string;
  requestedModel: string;
  selectedProvider: string;
  selectedModel: string;
  attempts?: readonly FallbackAttempt[];
}): ModelFallbackSummary {
  const attempts = [...(params.attempts ?? [])];
  const terminal = getTerminalAttemptReason(attempts);
  return {
    requestedProvider: params.requestedProvider,
    requestedModel: params.requestedModel,
    selectedProvider: params.selectedProvider,
    selectedModel: params.selectedModel,
    attempts,
    attemptCount: attempts.length,
    fallbackConfigured: attempts.length > 0,
    exhausted: false,
    ...(terminal.reason ? { finalReason: terminal.reason } : {}),
    ...(terminal.status !== undefined ? { finalStatus: terminal.status } : {}),
    ...(terminal.code ? { finalCode: terminal.code } : {}),
  };
}
