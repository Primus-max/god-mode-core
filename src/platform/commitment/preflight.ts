import type {
  ClarificationDecision,
  ClarificationPolicy,
} from "./clarification-policy.js";
import type { CutoverDecision, CutoverPolicy } from "./cutover-policy.js";
import type { SessionWorldStateObserver } from "./session-world-state-observer.js";
import type { SessionWorldStateSnapshot } from "./world-state.js";

export interface CommitmentPreflightInput {
  sessionId: string;
  userMessage: string;
}

export interface CommitmentPreflightDecision {
  worldState: SessionWorldStateSnapshot;
  clarification: ClarificationDecision;
  cutover: CutoverDecision;
}

export interface CommitmentPreflightRuntime {
  observeSessionWorldState: SessionWorldStateObserver;
  clarificationPolicy: ClarificationPolicy;
  cutoverPolicy: CutoverPolicy;
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
