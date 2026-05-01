import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPerSenderSessionConfig } from "./test-helpers/session-config.js";
import type { OpenClawConfig } from "../config/config.js";

let configOverride: ReturnType<(typeof import("../config/config.js"))["loadConfig"]> = {
  session: createPerSenderSessionConfig(),
};

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configOverride,
    resolveGatewayPort: () => 18789,
  };
});

import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { createAgentsListTool } from "./tools/agents-list-tool.js";

describe("agents_list", () => {
  type AgentConfig = NonNullable<NonNullable<typeof configOverride.agents>["list"]>[number];

  function setConfigWithAgentList(agentList: AgentConfig[]) {
    configOverride = {
      session: createPerSenderSessionConfig(),
      agents: {
        list: agentList,
      },
    };
  }

  function requireAgentsListTool() {
    const tool = createOpenClawTools({
      agentSessionKey: "main",
      config: configOverride as OpenClawConfig,
    }).find((candidate) => candidate.name === "agents_list");
    if (!tool) {
      throw new Error("missing agents_list tool");
    }
    return tool;
  }

  function readAgentList(result: unknown) {
    return (result as { details?: { agents?: Array<{ id: string; configured?: boolean }> } })
      .details?.agents;
  }

  function readToolDetails(result: unknown) {
    return (result as {
      details?: {
        requester?: string;
        allowAny?: boolean;
        configuredIds?: string[];
        allowAgents?: string[];
        agents?: Array<{ id: string; name?: string; configured: boolean }>;
      };
    }).details;
  }

  beforeEach(() => {
    configOverride = {
      session: createPerSenderSessionConfig(),
    };
  });

  it("defaults to the requester agent only", async () => {
    const tool = requireAgentsListTool();
    const result = await tool.execute("call1", {});
    expect(result.details).toMatchObject({
      requester: "main",
      allowAny: false,
    });
    const agents = readAgentList(result);
    expect(agents?.map((agent) => agent.id)).toEqual(["main"]);
  });

  it("includes allowlisted targets plus requester", async () => {
    setConfigWithAgentList([
      {
        id: "main",
        name: "Main",
        subagents: {
          allowAgents: ["research"],
        },
      },
      {
        id: "research",
        name: "Research",
      },
    ]);

    const tool = requireAgentsListTool();
    const result = await tool.execute("call2", {});
    const agents = readAgentList(result);
    expect(agents?.map((agent) => agent.id)).toEqual(["main", "research"]);
  });

  it("matches direct agents_list tool behavior for the same config snapshot", async () => {
    setConfigWithAgentList([
      {
        id: "main",
        name: "Main",
        subagents: {
          allowAgents: ["research"],
        },
      },
      {
        id: "research",
        name: "Research",
      },
    ]);

    const direct = createAgentsListTool({
      agentSessionKey: "main",
      config: configOverride,
    });
    expect(direct.label).toBe("Agents");
    const directResult = await direct.execute("direct", {});
    expect(readToolDetails(directResult)).toEqual({
      requester: "main",
      allowAny: false,
      configuredIds: ["main", "research"],
      allowAgents: ["research"],
      agents: [
        { id: "main", name: "Main", configured: true },
        { id: "research", name: "Research", configured: true },
      ],
    });
    expect(readAgentList(directResult)?.map((agent) => agent.id)).toEqual(["main", "research"]);

    const composed = requireAgentsListTool();
    expect(composed.label).toBe("Agents");
    expect(composed.description).toBe(direct.description);
    expect(composed.parameters).toEqual(direct.parameters);
    expect(composed.execute).not.toBe(direct.execute);
    const composedResult = await composed.execute("composed", {});
    expect(readToolDetails(composedResult)).toEqual(readToolDetails(directResult));
    expect(readAgentList(composedResult)?.map((agent) => agent.id)).toEqual(["main", "research"]);
  });

  it("returns configured agents when allowlist is *", async () => {
    setConfigWithAgentList([
      {
        id: "main",
        subagents: {
          allowAgents: ["*"],
        },
      },
      {
        id: "research",
        name: "Research",
      },
      {
        id: "coder",
        name: "Coder",
      },
    ]);

    const tool = requireAgentsListTool();
    const result = await tool.execute("call3", {});
    expect(result.details).toMatchObject({
      allowAny: true,
    });
    const agents = readAgentList(result);
    expect(agents?.map((agent) => agent.id)).toEqual(["main", "coder", "research"]);
  });

  it("marks allowlisted-but-unconfigured agents", async () => {
    setConfigWithAgentList([
      {
        id: "main",
        subagents: {
          allowAgents: ["research"],
        },
      },
    ]);

    const tool = requireAgentsListTool();
    const result = await tool.execute("call4", {});
    const agents = readAgentList(result);
    expect(agents?.map((agent) => agent.id)).toEqual(["main", "research"]);
    const research = agents?.find((agent) => agent.id === "research");
    expect(research?.configured).toBe(false);
  });
});
