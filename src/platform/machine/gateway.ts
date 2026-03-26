import { z } from "zod";
import type { GatewayRequestHandler } from "../../gateway/server-methods/types.js";
import type { MachineControlService } from "./service.js";

const MachineStatusParamsSchema = z.object({}).partial();
const MachineLinkParamsSchema = z.object({
  deviceId: z.string().min(1),
  note: z.string().min(1).optional(),
});
const MachineUnlinkParamsSchema = z.object({
  deviceId: z.string().min(1),
});
const MachineKillSwitchParamsSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().min(1).optional(),
});

export function createMachineStatusGatewayMethod(
  service: MachineControlService,
): GatewayRequestHandler {
  return ({ params, respond, client }) => {
    const parsed = MachineStatusParamsSchema.safeParse(params ?? {});
    if (!parsed.success) {
      respond(false, { error: "invalid platform.machine.status params" });
      return;
    }
    const snapshot = service.getSnapshot();
    const currentDeviceId = client?.connect?.device?.id ?? undefined;
    respond(true, {
      ...snapshot,
      currentDevice: currentDeviceId
        ? {
            deviceId: currentDeviceId,
            access: service.evaluateDeviceAccess(currentDeviceId),
          }
        : undefined,
    });
  };
}

export function createMachineLinkGatewayMethod(
  service: MachineControlService,
): GatewayRequestHandler {
  return ({ params, respond, client, context }) => {
    const parsed = MachineLinkParamsSchema.safeParse(params);
    if (!parsed.success) {
      respond(false, { error: "invalid platform.machine.link params" });
      return;
    }
    try {
      const link = service.linkDevice({
        deviceId: parsed.data.deviceId,
        linkedByDeviceId: client?.connect?.device?.id,
        note: parsed.data.note,
      });
      context.broadcast(
        "platform.machine.changed",
        {
          kind: "link",
          deviceId: link.deviceId,
          ts: Date.now(),
        },
        { dropIfSlow: true },
      );
      respond(true, { link });
    } catch (error) {
      respond(false, { error: String(error) });
    }
  };
}

export function createMachineUnlinkGatewayMethod(
  service: MachineControlService,
): GatewayRequestHandler {
  return ({ params, respond, context }) => {
    const parsed = MachineUnlinkParamsSchema.safeParse(params);
    if (!parsed.success) {
      respond(false, { error: "invalid platform.machine.unlink params" });
      return;
    }
    const payload = service.unlinkDevice({ deviceId: parsed.data.deviceId });
    context.broadcast(
      "platform.machine.changed",
      {
        kind: "unlink",
        deviceId: parsed.data.deviceId,
        removed: payload.removed,
        ts: Date.now(),
      },
      { dropIfSlow: true },
    );
    respond(true, payload);
  };
}

export function createMachineKillSwitchGatewayMethod(
  service: MachineControlService,
): GatewayRequestHandler {
  return ({ params, respond, client, context }) => {
    const parsed = MachineKillSwitchParamsSchema.safeParse(params);
    if (!parsed.success) {
      respond(false, { error: "invalid platform.machine.setKillSwitch params" });
      return;
    }
    const snapshot = service.setKillSwitch({
      enabled: parsed.data.enabled,
      updatedByDeviceId: client?.connect?.device?.id,
      reason: parsed.data.reason,
    });
    context.broadcast(
      "platform.machine.changed",
      {
        kind: "kill-switch",
        enabled: parsed.data.enabled,
        ts: Date.now(),
      },
      { dropIfSlow: true },
    );
    respond(true, snapshot);
  };
}
