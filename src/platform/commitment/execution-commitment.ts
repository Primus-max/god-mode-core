import type {
  CommitmentId,
  EffectId,
  ReadonlyRecord,
} from "./ids.js";
import type { TargetRef } from "./semantic-intent.js";

export type CommitmentTarget = TargetRef;

export type CommitmentBudgets = {
  readonly maxLatencyMs: number;
  readonly maxRetries: number;
  readonly maxCostUsd?: number;
};

export type EvidenceRequirement = {
  readonly kind: string;
  readonly mandatory: boolean;
};

export type TerminalPolicy = {
  readonly onTimeout: "rejected" | "unsupported";
  readonly onPolicyDenial: "rejected";
  readonly onUnsatisfiedSuccess: "rejected";
};

export type ExecutionCommitment = {
  readonly id: CommitmentId;
  readonly effect: EffectId;
  readonly target: CommitmentTarget;
  readonly constraints: ReadonlyRecord<string, unknown>;
  readonly budgets: CommitmentBudgets;
  readonly requiredEvidence: readonly EvidenceRequirement[];
  readonly terminalPolicy: TerminalPolicy;
};
