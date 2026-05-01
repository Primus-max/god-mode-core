/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderInstances, type InstancesProps } from "./instances.ts";

function createProps(overrides: Partial<InstancesProps> = {}): InstancesProps {
  return {
    loading: false,
    entries: [
      {
        instanceId: "instance-1",
        host: "workstation.local",
        ip: "192.168.1.20",
        mode: "gateway",
        version: "1.0.0",
        lastInputSeconds: 12,
        roles: ["operator"],
        scopes: ["operator.read"],
        reason: "healthy",
      },
    ],
    lastError: null,
    statusMessage: null,
    revealed: false,
    onToggleReveal: () => undefined,
    onRefresh: () => undefined,
    ...overrides,
  };
}

describe("instances view", () => {
  it("renders restored reveal state through aria-pressed and unmasked host details", async () => {
    const container = document.createElement("div");

    render(renderInstances(createProps({ revealed: true })), container);
    await Promise.resolve();

    const toggle = container.querySelector('button[aria-label="Toggle host visibility"]');
    const host = container.querySelector(".list-title span");
    const ip = container.querySelector(".list-sub span");

    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    expect(host?.classList.contains("redacted")).toBe(false);
    expect(ip?.classList.contains("redacted")).toBe(false);
    expect(host?.textContent).toContain("workstation.local");
    expect(ip?.textContent).toContain("192.168.1.20");
  });

  it("forwards visibility toggles without reusing module-local state", async () => {
    const onToggleReveal = vi.fn();
    const onRefresh = vi.fn();
    const container = document.createElement("div");

    render(renderInstances(createProps({ onToggleReveal, onRefresh })), container);
    await Promise.resolve();

    const toggle = container.querySelector('button[aria-label="Toggle host visibility"]');
    toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onToggleReveal).toHaveBeenCalledTimes(1);
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
