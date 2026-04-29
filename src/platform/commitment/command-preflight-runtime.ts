import type { CommitmentPreflightRuntime } from "./preflight.js";

// This command adapter keeps the first production slice auditable while the
// broader runtime wiring is still being connected.
export function createCommandPreflightRuntime(): CommitmentPreflightRuntime {
  return {
    async observeSessionWorldState({ sessionId, userMessage }) {
      return {
        sessionId,
        latestUserMessage: userMessage,
        openQuestions: userMessage.trim() ? [] : ["user-message"],
        expectedDelta: null,
        delivery: null,
      };
    },
    clarificationPolicy(worldState) {
      return worldState.latestUserMessage.trim()
        ? { kind: "proceed" as const }
        : { kind: "clarify" as const, reason: "empty-user-message" };
    },
    cutoverPolicy() {
      return { kind: "proceed" as const };
    },
  };
}
