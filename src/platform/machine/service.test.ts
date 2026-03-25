import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMachineControlService } from "./service.js";

describe("createMachineControlService", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function createService() {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-machine-service-"));
    tempDirs.push(stateDir);
    const devicesDir = path.join(stateDir, "devices");
    fs.mkdirSync(devicesDir, { recursive: true });
    fs.writeFileSync(
      path.join(devicesDir, "paired.json"),
      JSON.stringify({
        "dev-1": {
          deviceId: "dev-1",
          publicKey: "pk-dev-1",
          approvedAtMs: Date.now(),
          createdAtMs: Date.now(),
        },
      }),
    );
    return createMachineControlService({ baseDir: stateDir });
  }

  it("denies machine control until the device is explicitly linked", () => {
    const service = createService();
    expect(service.evaluateDeviceAccess("dev-1")).toEqual(
      expect.objectContaining({
        allowed: false,
        code: "device_not_linked",
      }),
    );
    const link = service.linkDevice({ deviceId: "dev-1" });
    expect(link.deviceId).toBe("dev-1");
    expect(service.evaluateDeviceAccess("dev-1")).toEqual(
      expect.objectContaining({
        allowed: true,
        code: "allowed",
      }),
    );
  });

  it("reverts to deny-by-default after unlink", () => {
    const service = createService();
    service.linkDevice({ deviceId: "dev-1" });
    expect(service.unlinkDevice({ deviceId: "dev-1" })).toEqual({ removed: true });
    expect(service.evaluateDeviceAccess("dev-1")).toEqual(
      expect.objectContaining({
        allowed: false,
        code: "device_not_linked",
      }),
    );
  });

  it("enforces kill switch immediately for linked devices", () => {
    const service = createService();
    service.linkDevice({ deviceId: "dev-1" });
    service.setKillSwitch({ enabled: true, reason: "panic stop" });
    expect(service.evaluateDeviceAccess("dev-1")).toEqual(
      expect.objectContaining({
        allowed: false,
        code: "kill_switch_enabled",
      }),
    );
  });
});
