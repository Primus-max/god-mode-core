import type { FailoverReason } from "./pi-embedded-helpers.js";

export type ModelCandidate = {
  provider: string;
  model: string;
};

export type FallbackAttempt = {
  provider: string;
  model: string;
  error: string;
  reason?: FailoverReason;
  status?: number;
  code?: string;
};

export type ModelFallbackSummary = {
  requestedProvider: string;
  requestedModel: string;
  selectedProvider: string;
  selectedModel: string;
  attempts: FallbackAttempt[];
  attemptCount: number;
  fallbackConfigured: boolean;
  exhausted: boolean;
  finalReason?: FailoverReason;
  finalStatus?: number;
  finalCode?: string;
};
