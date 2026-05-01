import type {
  CommitmentPreflightInput,
  CommitmentPreflightRuntime,
  PreflightWorldStateSnapshot,
} from "./preflight.js";

export interface CommandPreflightContextHints {
  openQuestions?: string[];
}

// This command adapter keeps the first production slice auditable while the
// broader runtime wiring is still being connected.
export function createCommandPreflightRuntime(
  hints?: CommandPreflightContextHints,
): CommitmentPreflightRuntime {
  return {
    async observeSessionWorldState({
      sessionId,
      userMessage,
    }: CommitmentPreflightInput): Promise<PreflightWorldStateSnapshot> {
      return {
        sessionId,
        latestUserMessage: userMessage,
        openQuestions: hints?.openQuestions?.length
          ? [...hints.openQuestions]
          : userMessage.trim()
            ? []
            : ["empty-user-message"],
        expectedDelta: null,
        delivery: null,
      };
    },
    clarificationPolicy(worldState: PreflightWorldStateSnapshot) {
      return worldState.latestUserMessage.trim() && worldState.openQuestions.length === 0
        ? { kind: "proceed" as const }
        : {
            kind: "clarify" as const,
            reason: worldState.openQuestions[0] ?? "empty-user-message",
          };
    },
    cutoverPolicy(_worldState: PreflightWorldStateSnapshot) {
      return { kind: "proceed" as const };
    },
  };
}
