/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { renderNodes, type NodesProps } from "./nodes.ts";

function baseProps(overrides: Partial<NodesProps> = {}): NodesProps {
  return {
    loading: false,
    nodes: [],
    devicesLoading: false,
    devicesError: null,
    devicesList: {
      pending: [],
      paired: [],
    },
    configForm: null,
    configLoading: false,
    configSaving: false,
    configDirty: false,
    configFormMode: "form",
    execApprovalsLoading: false,
    execApprovalsSaving: false,
    execApprovalsDirty: false,
    execApprovalsSnapshot: null,
    execApprovalsForm: null,
    execApprovalsSelectedAgent: null,
    execApprovalsTarget: "gateway",
    execApprovalsTargetNodeId: null,
    onRefresh: () => undefined,
    onDevicesRefresh: () => undefined,
    onDeviceApprove: () => undefined,
    onDeviceReject: () => undefined,
    onDeviceRotate: () => undefined,
    onDeviceRevoke: () => undefined,
    onLoadConfig: () => undefined,
    onLoadExecApprovals: () => undefined,
    onBindDefault: () => undefined,
    onBindAgent: () => undefined,
    onSaveBindings: () => undefined,
    onExecApprovalsTargetChange: () => undefined,
    onExecApprovalsSelectAgent: () => undefined,
    buildExecApprovalsScopeHref: (agentId) => `/ui/nodes?execAgent=${encodeURIComponent(agentId)}`,
    onExecApprovalsPatch: () => undefined,
    onExecApprovalsRemove: () => undefined,
    onSaveExecApprovals: () => undefined,
    ...overrides,
  };
}

describe("nodes devices pending rendering", () => {
  it("shows pending role and scopes from effective pending auth", () => {
    const container = document.createElement("div");
    render(
      renderNodes(
        baseProps({
          devicesList: {
            pending: [
              {
                requestId: "req-1",
                deviceId: "device-1",
                displayName: "Device One",
                role: "operator",
                scopes: ["operator.admin", "operator.read"],
                ts: Date.now(),
              },
            ],
            paired: [],
          },
        }),
      ),
      container,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("role: operator");
    expect(text).toContain("scopes: operator.admin, operator.read");
  });

  it("falls back to roles when role is absent", () => {
    const container = document.createElement("div");
    render(
      renderNodes(
        baseProps({
          devicesList: {
            pending: [
              {
                requestId: "req-2",
                deviceId: "device-2",
                roles: ["node", "operator"],
                scopes: ["operator.read"],
                ts: Date.now(),
              },
            ],
            paired: [],
          },
        }),
      ),
      container,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("role: node, operator");
    expect(text).toContain("scopes: operator.read");
  });

  it("renders Russian device and node headings", async () => {
    const container = document.createElement("div");
    await i18n.setLocale("ru");

    render(renderNodes(baseProps()), container);

    const text = container.textContent ?? "";
    expect(text).toContain("Устройства и узлы");
    expect(text).toContain("Сопряженных устройств нет.");

    await i18n.setLocale("en");
  });

  it("reflects the preselected exec approvals target and scope", () => {
    const container = document.createElement("div");
    render(
      renderNodes(
        baseProps({
          nodes: [
            {
              nodeId: "node-1",
              displayName: "Mac mini",
              commands: ["system.execApprovals.get", "system.execApprovals.set"],
            },
          ],
          configForm: {
            agents: {
              list: [{ id: "main", name: "Main agent", default: true }],
            },
          },
          execApprovalsForm: {
            version: 1,
            agents: {
              main: {
                allowlist: [],
              },
            },
          },
          execApprovalsTarget: "node",
          execApprovalsTargetNodeId: "node-1",
          execApprovalsSelectedAgent: "main",
        }),
      ),
      container,
    );

    const selects = Array.from(container.querySelectorAll("select")).filter(
      (el): el is HTMLSelectElement => el instanceof HTMLSelectElement,
    );
    expect(selects[0]?.value).toBe("node");
    expect(selects[1]?.value).toBe("node-1");

    const activeScopes = Array.from(container.querySelectorAll(".btn.active")).map((entry) =>
      entry.textContent?.trim(),
    );
    expect(activeScopes).toContain("Main agent (main)");
  });

  it("renders canonical hrefs for exec approvals scope links", () => {
    const container = document.createElement("div");
    render(
      renderNodes(
        baseProps({
          configForm: {
            agents: {
              list: [{ id: "main", name: "Main agent", default: true }],
            },
          },
          execApprovalsForm: {
            version: 1,
            agents: {
              main: {
                allowlist: [],
              },
            },
          },
          buildExecApprovalsScopeHref: (agentId) => `/ui/nodes?execAgent=${encodeURIComponent(agentId)}`,
        }),
      ),
      container,
    );

    const defaultLink = Array.from(container.querySelectorAll("a")).find((link) =>
      link.textContent?.includes("Defaults"),
    ) as HTMLAnchorElement | undefined;
    const agentLink = Array.from(container.querySelectorAll("a")).find((link) =>
      link.textContent?.includes("Main agent (main)"),
    ) as HTMLAnchorElement | undefined;

    expect(defaultLink?.getAttribute("href")).toBe("/ui/nodes?execAgent=__defaults__");
    expect(agentLink?.getAttribute("href")).toBe("/ui/nodes?execAgent=main");
  });

  it("uses JS handoff for primary clicks on exec approvals scope links", () => {
    const onExecApprovalsSelectAgent = vi.fn();
    const container = document.createElement("div");
    render(
      renderNodes(
        baseProps({
          configForm: {
            agents: {
              list: [{ id: "main", name: "Main agent", default: true }],
            },
          },
          execApprovalsForm: {
            version: 1,
            agents: {
              main: {
                allowlist: [],
              },
            },
          },
          onExecApprovalsSelectAgent,
          buildExecApprovalsScopeHref: (agentId) => `/ui/nodes?execAgent=${encodeURIComponent(agentId)}`,
        }),
      ),
      container,
    );

    const defaultLink = Array.from(container.querySelectorAll("a")).find((link) =>
      link.textContent?.includes("Defaults"),
    ) as HTMLAnchorElement | undefined;
    const agentLink = Array.from(container.querySelectorAll("a")).find((link) =>
      link.textContent?.includes("Main agent (main)"),
    ) as HTMLAnchorElement | undefined;

    const defaultEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    defaultLink?.dispatchEvent(defaultEvent);
    const agentEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    agentLink?.dispatchEvent(agentEvent);

    expect(onExecApprovalsSelectAgent).toHaveBeenNthCalledWith(1, "__defaults__");
    expect(onExecApprovalsSelectAgent).toHaveBeenNthCalledWith(2, "main");
    expect(defaultEvent.defaultPrevented).toBe(true);
    expect(agentEvent.defaultPrevented).toBe(true);
  });

  it("lets modified clicks fall through to the browser href for exec approvals scope links", () => {
    const onExecApprovalsSelectAgent = vi.fn();
    const container = document.createElement("div");
    render(
      renderNodes(
        baseProps({
          configForm: {
            agents: {
              list: [{ id: "main", name: "Main agent", default: true }],
            },
          },
          execApprovalsForm: {
            version: 1,
            agents: {
              main: {
                allowlist: [],
              },
            },
          },
          onExecApprovalsSelectAgent,
          buildExecApprovalsScopeHref: (agentId) => `/ui/nodes?execAgent=${encodeURIComponent(agentId)}`,
        }),
      ),
      container,
    );

    const agentLink = Array.from(container.querySelectorAll("a")).find((link) =>
      link.textContent?.includes("Main agent (main)"),
    ) as HTMLAnchorElement | undefined;
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    agentLink?.dispatchEvent(event);

    expect(onExecApprovalsSelectAgent).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
