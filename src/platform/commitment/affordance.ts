import type {
  AffordanceId,
  EffectId,
  ISO8601,
  PreconditionId,
  ReadonlyRecord,
} from "./ids.js";
import type {
  CommitmentBudgets,
  CommitmentTarget,
  EvidenceRequirement,
} from "./execution-commitment.js";
import type { ExpectedDelta } from "./expected-delta.js";
import type { WorldStateSnapshot } from "./world-state.js";

export type RiskTier = "low" | "medium" | "high";

export type ObserverHandle = {
  readonly id: string;
};

export type TargetMatcher = (target: CommitmentTarget) => boolean;

export type ReceiptEntry = {
  readonly kind: string;
  readonly payload: ReadonlyRecord<string, unknown>;
};

export type ReceiptsBundle = {
  readonly entries: readonly ReceiptEntry[];
};

export type ShadowTrace = {
  readonly steps: readonly { readonly at: ISO8601; readonly note: string }[];
};

export type EvidenceFact = {
  readonly kind: string;
  readonly value: unknown;
};

export type SatisfactionResult =
  | { readonly satisfied: true; readonly evidence: readonly EvidenceFact[] }
  | { readonly satisfied: false; readonly missing: readonly string[] };

export type DonePredicateCtx = {
  readonly stateBefore: WorldStateSnapshot;
  readonly stateAfter: WorldStateSnapshot;
  readonly expectedDelta: ExpectedDelta;
  readonly receipts: ReceiptsBundle;
  readonly trace: ShadowTrace;
};

export type DonePredicate = (ctx: DonePredicateCtx) => SatisfactionResult;

export type Affordance = {
  readonly id: AffordanceId;
  readonly effect: EffectId;
  readonly target: TargetMatcher;
  readonly requiredPreconditions: readonly PreconditionId[];
  readonly requiredEvidence: readonly EvidenceRequirement[];
  readonly riskTier: RiskTier;
  readonly defaultBudgets: CommitmentBudgets;
  readonly observerHandle: ObserverHandle;
  readonly donePredicate: DonePredicate;
};
