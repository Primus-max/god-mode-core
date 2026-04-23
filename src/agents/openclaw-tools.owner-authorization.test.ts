import { describe, expect, it } from "vitest";
import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

function readToolByName() {
  return new Map(createOpenClawTools().map((tool) => [tool.name, tool]));
}

describe("createOpenClawTools owner authorization", () => {
  it("marks owner-only core tools in raw registration", () => {
    const tools = readToolByName();
    expect(tools.get("cron")?.ownerOnly).toBe(true);
    expect(tools.get("gateway")?.ownerOnly).toBe(true);
    expect(tools.get("nodes")?.ownerOnly).toBe(true);
  });

  it("keeps canvas non-owner-only in raw registration", () => {
    const tools = readToolByName();
    expect(tools.get("canvas")).toBeDefined();
    expect(tools.get("canvas")?.ownerOnly).not.toBe(true);
  });

  it("keeps cron visible for non-owner scoped reminder runtimes", () => {
    const tools = new Map(
      createOpenClawTools({
        agentSessionKey: "agent:main:telegram:direct:123",
        senderIsOwner: false,
      }).map((tool) => [tool.name, tool]),
    );
    expect(tools.get("cron")).toBeDefined();
    expect(tools.get("cron")?.ownerOnly).not.toBe(true);
    expect(tools.get("gateway")?.ownerOnly).toBe(true);
  });
});
