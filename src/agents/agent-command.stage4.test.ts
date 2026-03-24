import { describe, expect, it } from "vitest";
import { buildPlatformPlannerInput } from "./agent-command.js";

describe("agent-command Stage 4 planner input helpers", () => {
  it("infers publish intent, targets, integrations, and artifacts from developer prompts", () => {
    const input = buildPlatformPlannerInput({
      prompt:
        "Build the app, run tests, deploy a preview to Vercel, then publish release notes to GitHub.",
      opts: {
        messageChannel: "webchat",
        channel: undefined,
        replyChannel: undefined,
      },
    });

    expect(input).toMatchObject({
      baseProfile: "general",
      intent: "publish",
      publishTargets: ["github", "vercel"],
      integrations: ["github", "vercel", "webchat"],
      requestedTools: ["exec", "apply_patch", "process"],
    });
    expect(input.artifactKinds).toEqual(["site", "release", "binary"]);
  });

  it("keeps general prompts lightweight when no developer signals are present", () => {
    const input = buildPlatformPlannerInput({
      prompt: "Tell me a joke about compilers.",
      opts: {
        messageChannel: "webchat",
        channel: undefined,
        replyChannel: undefined,
      },
    });

    expect(input.intent).toBeUndefined();
    expect(input.publishTargets).toBeUndefined();
    expect(input.requestedTools).toBeUndefined();
    expect(input.artifactKinds).toBeUndefined();
  });
});
