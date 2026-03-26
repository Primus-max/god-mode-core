import { z } from "zod";

export const MachineControlLinkRecordSchema = z
  .object({
    deviceId: z.string().min(1),
    linkedAtMs: z.number().int().nonnegative(),
    updatedAtMs: z.number().int().nonnegative(),
    linkedByDeviceId: z.string().min(1).optional(),
    note: z.string().min(1).optional(),
  })
  .strict();
export type MachineControlLinkRecord = z.infer<typeof MachineControlLinkRecordSchema>;

export const MachineControlKillSwitchSchema = z
  .object({
    enabled: z.boolean(),
    updatedAtMs: z.number().int().nonnegative(),
    updatedByDeviceId: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
  })
  .strict();
export type MachineControlKillSwitch = z.infer<typeof MachineControlKillSwitchSchema>;

export const MachineControlStateSchema = z
  .object({
    version: z.literal(1),
    killSwitch: MachineControlKillSwitchSchema,
    linksByDeviceId: z.record(z.string(), MachineControlLinkRecordSchema),
  })
  .strict();
export type MachineControlState = z.infer<typeof MachineControlStateSchema>;

export const MachineControlAccessResultSchema = z
  .object({
    allowed: z.boolean(),
    code: z.enum([
      "allowed",
      "missing_device_identity",
      "kill_switch_enabled",
      "device_not_linked",
    ]),
    message: z.string().min(1),
    link: MachineControlLinkRecordSchema.optional(),
  })
  .strict();
export type MachineControlAccessResult = z.infer<typeof MachineControlAccessResultSchema>;

export const MachineControlSnapshotSchema = z
  .object({
    killSwitch: MachineControlKillSwitchSchema,
    linkedDevices: z.array(MachineControlLinkRecordSchema),
  })
  .strict();
export type MachineControlSnapshot = z.infer<typeof MachineControlSnapshotSchema>;
