import { describe, expect, it, vi } from "vitest";
import {
  linkMachineCurrentDevice,
  loadMachineControl,
  setMachineKillSwitch,
  unlinkMachineDevice,
  type MachineState,
} from "./machine.ts";

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;

function createState(request: RequestFn, overrides: Partial<MachineState> = {}): MachineState {
  return {
    client: { request } as unknown as MachineState["client"],
    connected: true,
    machineLoading: false,
    machineError: null,
    machineActionBusy: false,
    machineStatus: null,
    ...overrides,
  };
}

describe("machine controller", () => {
  it("loads machine status", async () => {
    const request = vi.fn(async (method: string) => {
      expect(method).toBe("platform.machine.status");
      return {
        killSwitch: { enabled: false, updatedAtMs: 0 },
        linkedDevices: [{ deviceId: "dev-1", linkedAtMs: 1, updatedAtMs: 2 }],
        currentDevice: {
          deviceId: "dev-1",
          access: {
            allowed: true,
            code: "allowed",
            message: "ok",
          },
        },
      };
    });
    const state = createState(request);

    await loadMachineControl(state);

    expect(state.machineStatus?.currentDevice?.deviceId).toBe("dev-1");
    expect(state.machineStatus?.linkedDevices).toHaveLength(1);
  });

  it("links current device and refreshes status", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "platform.machine.link") {
        expect(params).toEqual({ deviceId: "dev-1" });
        return { link: { deviceId: "dev-1", linkedAtMs: 1, updatedAtMs: 2 } };
      }
      if (method === "platform.machine.status") {
        return {
          killSwitch: { enabled: false, updatedAtMs: 0 },
          linkedDevices: [{ deviceId: "dev-1", linkedAtMs: 1, updatedAtMs: 2 }],
          currentDevice: {
            deviceId: "dev-1",
            access: {
              allowed: true,
              code: "allowed",
              message: "linked",
            },
          },
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request, {
      machineStatus: {
        killSwitch: { enabled: false, updatedAtMs: 0 },
        linkedDevices: [],
        currentDevice: {
          deviceId: "dev-1",
          access: {
            allowed: false,
            code: "device_not_linked",
            message: "not linked",
          },
        },
      },
    });

    await linkMachineCurrentDevice(state);

    expect(state.machineStatus?.currentDevice?.access.code).toBe("allowed");
  });

  it("toggles kill switch and unlinks device", async () => {
    let killSwitchEnabled = false;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "platform.machine.setKillSwitch") {
        killSwitchEnabled = Boolean((params as { enabled?: boolean }).enabled);
        return {};
      }
      if (method === "platform.machine.unlink") {
        expect(params).toEqual({ deviceId: "dev-1" });
        return { removed: true };
      }
      if (method === "platform.machine.status") {
        return {
          killSwitch: { enabled: killSwitchEnabled, updatedAtMs: 10 },
          linkedDevices: killSwitchEnabled
            ? [{ deviceId: "dev-1", linkedAtMs: 1, updatedAtMs: 2 }]
            : [],
          currentDevice: {
            deviceId: "dev-1",
            access: {
              allowed: !killSwitchEnabled,
              code: killSwitchEnabled ? "kill_switch_enabled" : "device_not_linked",
              message: killSwitchEnabled ? "blocked" : "not linked",
            },
          },
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request, {
      machineStatus: {
        killSwitch: { enabled: false, updatedAtMs: 0 },
        linkedDevices: [{ deviceId: "dev-1", linkedAtMs: 1, updatedAtMs: 2 }],
        currentDevice: {
          deviceId: "dev-1",
          access: {
            allowed: true,
            code: "allowed",
            message: "ok",
          },
        },
      },
    });

    await setMachineKillSwitch(state, true);
    expect(state.machineStatus?.killSwitch.enabled).toBe(true);

    killSwitchEnabled = false;
    await unlinkMachineDevice(state, "dev-1");
    expect(state.machineStatus?.linkedDevices).toHaveLength(0);
  });
});
