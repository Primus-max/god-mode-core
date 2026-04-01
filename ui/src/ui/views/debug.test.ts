/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderDebug, type DebugProps } from "./debug.ts";

function createProps(overrides: Partial<DebugProps> = {}): DebugProps {
  return {
    loading: false,
    status: { ok: true },
    health: { status: "ok" },
    models: [],
    heartbeat: { ts: 123 },
    eventLog: [],
    methods: ["models.list", "status"],
    callMethod: "",
    callParams: "{}",
    callResult: null,
    callError: null,
    onCallMethodChange: () => undefined,
    onCallParamsChange: () => undefined,
    onRefresh: () => undefined,
    onCall: () => undefined,
    ...overrides,
  };
}

describe("debug view", () => {
  it("renders the restored manual RPC method and params", async () => {
    const container = document.createElement("div");

    render(
      renderDebug(
        createProps({
          callMethod: "models.list",
          callParams: '{"limit":10}',
        }),
      ),
      container,
    );
    await Promise.resolve();

    const method = container.querySelector("select") as HTMLSelectElement | null;
    const params = container.querySelector("textarea") as HTMLTextAreaElement | null;

    expect(method?.value).toBe("models.list");
    expect(params?.value).toBe('{"limit":10}');
  });

  it("forwards manual RPC field edits", async () => {
    const onCallMethodChange = vi.fn();
    const onCallParamsChange = vi.fn();
    const container = document.createElement("div");

    render(
      renderDebug(
        createProps({
          onCallMethodChange,
          onCallParamsChange,
        }),
      ),
      container,
    );
    await Promise.resolve();

    const method = container.querySelector("select");
    const params = container.querySelector("textarea");

    Object.defineProperty(method, "value", { value: "status", configurable: true });
    method?.dispatchEvent(new Event("change", { bubbles: true }));

    Object.defineProperty(params, "value", { value: '{"scope":"gateway"}', configurable: true });
    params?.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onCallMethodChange).toHaveBeenLastCalledWith("status");
    expect(onCallParamsChange).toHaveBeenLastCalledWith('{"scope":"gateway"}');
  });
});
