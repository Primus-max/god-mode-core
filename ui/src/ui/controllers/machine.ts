import type { GatewayBrowserClient } from "../gateway.ts";
import type { MachineControlStatus } from "../types.ts";

export type MachineState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  machineLoading: boolean;
  machineError: string | null;
  machineActionBusy: boolean;
  machineStatus: MachineControlStatus | null;
};

export async function loadMachineControl(state: MachineState) {
  if (!state.client || !state.connected || state.machineLoading) {
    return;
  }
  state.machineLoading = true;
  state.machineError = null;
  try {
    const res = await state.client.request<MachineControlStatus>("platform.machine.status", {});
    state.machineStatus = res ?? null;
  } catch (err) {
    state.machineError = String(err);
  } finally {
    state.machineLoading = false;
  }
}

export async function linkMachineCurrentDevice(state: MachineState) {
  const deviceId = state.machineStatus?.currentDevice?.deviceId;
  if (!state.client || !state.connected || state.machineActionBusy || !deviceId) {
    return;
  }
  state.machineActionBusy = true;
  state.machineError = null;
  try {
    await state.client.request("platform.machine.link", { deviceId });
    await loadMachineControl(state);
  } catch (err) {
    state.machineError = String(err);
  } finally {
    state.machineActionBusy = false;
  }
}

export async function unlinkMachineDevice(state: MachineState, deviceId: string) {
  if (!state.client || !state.connected || state.machineActionBusy) {
    return;
  }
  state.machineActionBusy = true;
  state.machineError = null;
  try {
    await state.client.request("platform.machine.unlink", { deviceId });
    await loadMachineControl(state);
  } catch (err) {
    state.machineError = String(err);
  } finally {
    state.machineActionBusy = false;
  }
}

export async function setMachineKillSwitch(state: MachineState, enabled: boolean) {
  if (!state.client || !state.connected || state.machineActionBusy) {
    return;
  }
  state.machineActionBusy = true;
  state.machineError = null;
  try {
    await state.client.request("platform.machine.setKillSwitch", {
      enabled,
      reason: enabled ? "control-ui" : "control-ui-clear",
    });
    await loadMachineControl(state);
  } catch (err) {
    state.machineError = String(err);
  } finally {
    state.machineActionBusy = false;
  }
}
