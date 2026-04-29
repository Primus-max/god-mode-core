import type { CommitmentPreflightRuntime } from "./preflight.js";

export interface CommandPreflightContextHints {
  openQuestions?: string[];
}

// This command adapter keeps the first production slice auditable while the
// broader runtime wiring is still being connected.
export function createCommandPreflightRuntime(
  hints?: CommandPreflightContextHints,
): CommitmentPreflightRuntime {
  return {
    async observeSessionWorldState({ sessionId, userMessage }) {
      return {
        sessionId,
        latestUserMessage: userMessage,
        openQuestions: hints?.openQuestions?.length
          ? [...hints.openQuestions]
          : userMessage.trim()
            ? []
            : ["user-message"],
        expectedDelta: null,
        delivery: null,
      };
    },
    clarificationPolicy(worldState) {
      return worldState.latestUserMessage.trim() && worldState.openQuestions.length === 0
        ? { kind: "proceed" as const }
        : {
            kind: "clarify" as const,
            reason: worldState.openQuestions[0] ?? "empty-user-message",
          };
    },
    cutoverPolicy() {
      return { kind: "proceed" as const };
    },
  };
}
