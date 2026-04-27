import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";

describe("agent defaults schema", () => {
  it("accepts subagent archiveAfterMinutes=0 to disable archiving", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        subagents: {
          archiveAfterMinutes: 0,
        },
      }),
    ).not.toThrow();
  });

  it("accepts task classifier backend and model overrides", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        embeddedPi: {
          taskClassifier: {
            backend: "stub-backend",
            model: "ollama/qwen3:14b",
            timeoutMs: 10_000,
            maxTokens: 256,
          },
        },
      }),
    ).not.toThrow();
  });

  it("accepts intent contractor shadow-mode overrides", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        embeddedPi: {
          intentContractor: {
            backend: "stub-backend",
            model: "ollama/qwen3:14b",
            timeoutMs: 15_000,
            maxTokens: 400,
            confidenceThreshold: 0.6,
          },
        },
      }),
    ).not.toThrow();
  });
});
