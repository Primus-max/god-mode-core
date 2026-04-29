import { describe, expect, it } from "vitest";

import { createCommandPreflightRuntime } from "../command-preflight-runtime.js";

describe("createCommandPreflightRuntime", () => {
  it("requests clarification for empty user messages", async () => {
    const runtime = createCommandPreflightRuntime();
    const worldState = await runtime.observeSessionWorldState({
      sessionId: "session-1",
      userMessage: "   ",
    });

    expect(runtime.clarificationPolicy(worldState)).toEqual({
      kind: "clarify",
      reason: "empty-user-message",
    });
    expect(runtime.cutoverPolicy(worldState)).toEqual({ kind: "proceed" });
  });
});
