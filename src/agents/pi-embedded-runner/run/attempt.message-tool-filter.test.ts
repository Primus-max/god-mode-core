import { describe, expect, it } from "vitest";
import {
  filterDeliveryManagedClientTools,
  filterDeliveryManagedTools,
  suppressDeliveryManagedMessageTool,
  suppressUnavailableMemoryTools,
} from "./attempt.js";

describe("delivery-managed tool filtering", () => {
  it("removes message from sdk tool lists when delivery is command-managed", () => {
    expect(
      filterDeliveryManagedTools([{ name: "message" }, { name: "pdf" }, { name: "write" }], true),
    ).toEqual([{ name: "pdf" }, { name: "write" }]);
  });

  it("removes message from hosted client tools when delivery is command-managed", () => {
    expect(
      filterDeliveryManagedClientTools(
        [{ function: { name: "message" } }, { function: { name: "web_search" } }],
        true,
      ),
    ).toEqual([{ function: { name: "web_search" } }]);
  });

  it("keeps tools unchanged when delivery is not command-managed", () => {
    const tools = [{ name: "message" }, { name: "pdf" }];
    const clientTools = [{ function: { name: "message" } }];

    expect(filterDeliveryManagedTools(tools, false)).toEqual(tools);
    expect(filterDeliveryManagedClientTools(clientTools, false)).toEqual(clientTools);
  });

  it("removes message from the active session tool set when a downstream runtime reintroduces it", () => {
    const seen: string[][] = [];
    const session = {
      getActiveToolNames: () => ["read", "message", "pdf"],
      setActiveToolsByName: (toolNames: string[]) => {
        seen.push(toolNames);
      },
    };

    suppressDeliveryManagedMessageTool(session, true);

    expect(seen).toEqual([["read", "pdf"]]);
  });

  it("removes memory tools from the active session tool set when memory is unavailable", () => {
    const seen: string[][] = [];
    const session = {
      getActiveToolNames: () => ["read", "memory_search", "memory_get", "pdf"],
      setActiveToolsByName: (toolNames: string[]) => {
        seen.push(toolNames);
      },
    };

    suppressUnavailableMemoryTools(session, false);

    expect(seen).toEqual([["read", "pdf"]]);
  });
});
