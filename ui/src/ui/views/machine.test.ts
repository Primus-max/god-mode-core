/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { renderMachine, type MachineProps } from "./machine.ts";

function createProps(overrides: Partial<MachineProps> = {}): MachineProps {
  return {
    loading: false,
    actionBusy: false,
    error: null,
    status: {
      killSwitch: { enabled: false, updatedAtMs: 0 },
      linkedDevices: [{ deviceId: "dev-1", linkedAtMs: 1, updatedAtMs: 2 }],
      currentDevice: {
        deviceId: "dev-1",
        access: {
          allowed: true,
          code: "allowed",
          message: "machine control allowed for linked device",
        },
      },
    },
    onRefresh: () => undefined,
    onLinkCurrentDevice: () => undefined,
    onUnlink: () => undefined,
    onSetKillSwitch: () => undefined,
    ...overrides,
  };
}

describe("machine view", () => {
  it("renders unlink action for linked current device", async () => {
    const onUnlink = vi.fn();
    const container = document.createElement("div");

    render(renderMachine(createProps({ onUnlink })), container);
    await Promise.resolve();

    expect(container.textContent).toContain("Machine Access");
    const button = Array.from(container.querySelectorAll("button")).find(
      (entry) => entry.textContent?.trim() === "Unlink current device",
    );
    expect(button).toBeTruthy();
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onUnlink).toHaveBeenCalledWith("dev-1");
  });

  it("renders link action for unlinked current device and kill switch controls", async () => {
    const onLinkCurrentDevice = vi.fn();
    const onSetKillSwitch = vi.fn();
    const container = document.createElement("div");

    render(
      renderMachine(
        createProps({
          status: {
            killSwitch: { enabled: false, updatedAtMs: 0 },
            linkedDevices: [],
            currentDevice: {
              deviceId: "dev-2",
              access: {
                allowed: false,
                code: "device_not_linked",
                message: "not linked",
              },
            },
          },
          onLinkCurrentDevice,
          onSetKillSwitch,
        }),
      ),
      container,
    );
    await Promise.resolve();

    const linkButton = Array.from(container.querySelectorAll("button")).find(
      (entry) => entry.textContent?.trim() === "Link current device",
    );
    expect(linkButton).toBeTruthy();
    linkButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onLinkCurrentDevice).toHaveBeenCalled();

    const killButton = Array.from(container.querySelectorAll("button")).find(
      (entry) => entry.textContent?.trim() === "Enable kill switch",
    );
    expect(killButton).toBeTruthy();
    killButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSetKillSwitch).toHaveBeenCalledWith(true);
  });

  it("renders localized Russian machine controls", async () => {
    const container = document.createElement("div");
    await i18n.setLocale("ru");

    render(renderMachine(createProps()), container);
    await Promise.resolve();

    expect(container.textContent).toContain("Доступ к машине");
    expect(container.textContent).toContain("Отвязать текущее устройство");

    await i18n.setLocale("en");
  });
});
