// The preflight slice intentionally defines its own narrow types instead of
// reusing the kernel's `SessionWorldStateObserver` / `CutoverPolicy` shapes.
// Those kernel types describe the cutover-2 commitment pipeline and are not
// callable as policies on a free-form world-state object. Keeping these types
// local makes the slice's scope explicit at audit time (master plan §0.5.2).

export interface CommitmentPreflightInput {
  readonly sessionId: string;
  readonly userMessage: string;
}

export type PreflightWorldStateSnapshot = {
  readonly sessionId: string;
  readonly latestUserMessage: string;
  readonly openQuestions: readonly string[];
  readonly expectedDelta: null;
  readonly delivery: null;
};

export type PreflightClarificationDecision =
  | { readonly kind: "proceed" }
  | { readonly kind: "clarify"; readonly reason: string };

export type PreflightCutoverDecision =
  | { readonly kind: "proceed" }
  | { readonly kind: "defer"; readonly reason: string };

export type PreflightSessionWorldStateObserver = (
  input: CommitmentPreflightInput,
) => Promise<PreflightWorldStateSnapshot> | PreflightWorldStateSnapshot;

export type PreflightClarificationPolicy = (
  worldState: PreflightWorldStateSnapshot,
) => PreflightClarificationDecision;

export type PreflightCutoverPolicy = (
  worldState: PreflightWorldStateSnapshot,
) => PreflightCutoverDecision;

export interface CommitmentPreflightDecision {
  readonly worldState: PreflightWorldStateSnapshot;
  readonly clarification: PreflightClarificationDecision;
  readonly cutover: PreflightCutoverDecision;
}

export interface CommitmentPreflightRuntime {
  readonly observeSessionWorldState: PreflightSessionWorldStateObserver;
  readonly clarificationPolicy: PreflightClarificationPolicy;
  readonly cutoverPolicy: PreflightCutoverPolicy;
}

export async function runCommitmentPreflight(
  runtime: CommitmentPreflightRuntime,
  input: CommitmentPreflightInput,
): Promise<CommitmentPreflightDecision> {
  const worldState = await runtime.observeSessionWorldState({
    sessionId: input.sessionId,
    userMessage: input.userMessage,
  });

  return {
    worldState,
    clarification: runtime.clarificationPolicy(worldState),
    cutover: runtime.cutoverPolicy(worldState),
  };
}
