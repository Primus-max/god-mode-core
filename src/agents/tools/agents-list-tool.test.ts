import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createAgentsListTool } from "./agents-list-tool.js";

describe("agents list tool", () => {
  it("returns allowlisted targets from injected config", async () => {
    const cfg: OpenClawConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        list: [
          {
            id: "main",
            subagents: { allowAgents: ["research"] },
          },
          {
            id: "research",
            name: "Research",
          },
        ],
      },
    };

    const tool = createAgentsListTool({
      agentSessionKey: "main",
      config: cfg,
    });
    const result = await tool.execute("call-1", {});
    const details = result.details as {
      requester: string;
      allowAny: boolean;
      agents: Array<{ id: string; configured: boolean }>;
    };

    expect(details.requester).toBe("main");
    expect(details.allowAny).toBe(false);
    expect(details.agents.map((agent) => agent.id)).toEqual(["main", "research"]);
  });
});
