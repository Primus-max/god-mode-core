import { describe, expect, it, vi } from "vitest";

import { runCommitmentPreflight } from "../preflight.js";

describe("runCommitmentPreflight", () => {
  it("observes world state before evaluating policies", async () => {
    const worldState = Object.freeze({
      sessionId: "session-1",
      latestUserMessage: "book a flight",
      openQuestions: ["destination"],
      expectedDelta: null,
      delivery: null,
    });

    const observeSessionWorldState = vi.fn().mockResolvedValue(worldState);
    const clarificationPolicy = vi.fn().mockReturnValue({
      kind: "clarify",
      reason: "missing-destination",
    });
    const cutoverPolicy = vi.fn().mockReturnValue({
      kind: "defer",
      reason: "needs-clarification-first",
    });

    const decision = await runCommitmentPreflight(
      {
        observeSessionWorldState,
        clarificationPolicy,
        cutoverPolicy,
      },
      {
        sessionId: "session-1",
        userMessage: "book a flight",
      },
    );

    expect(observeSessionWorldState).toHaveBeenCalledWith({
      sessionId: "session-1",
      userMessage: "book a flight",
    });
    expect(clarificationPolicy).toHaveBeenCalledWith(worldState);
    expect(cutoverPolicy).toHaveBeenCalledWith(worldState);
    expect(decision).toEqual({
      worldState,
      clarification: {
        kind: "clarify",
        reason: "missing-destination",
      },
      cutover: {
        kind: "defer",
        reason: "needs-clarification-first",
      },
    });
  });
});
