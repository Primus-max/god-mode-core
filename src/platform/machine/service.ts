import fs from "node:fs";
import path from "node:path";
import { resolvePairingPaths } from "../../infra/pairing-files.js";
import {
  MachineControlAccessResultSchema,
  MachineControlSnapshotSchema,
  MachineControlStateSchema,
  type MachineControlAccessResult,
  type MachineControlLinkRecord,
  type MachineControlSnapshot,
  type MachineControlState,
} from "./contracts.js";

export type MachineRunSnapshot = {
  runId: string;
  sessionId: string;
  prompt: string;
  profileId?: string;
  recipeId?: string;
  recordedAtMs: number;
};

const MAX_RUN_SNAPSHOTS = 128;

export type MachineControlService = {
  getSnapshot: () => MachineControlSnapshot;
  getLink: (deviceId: string) => MachineControlLinkRecord | undefined;
  linkDevice: (params: {
    deviceId: string;
    linkedByDeviceId?: string | null;
    note?: string | null;
  }) => MachineControlLinkRecord;
  unlinkDevice: (params: { deviceId: string }) => { removed: boolean };
  setKillSwitch: (params: {
    enabled: boolean;
    updatedByDeviceId?: string | null;
    reason?: string | null;
  }) => MachineControlSnapshot;
  evaluateDeviceAccess: (deviceId?: string | null) => MachineControlAccessResult;
  recordRunSnapshot: (params: MachineRunSnapshot) => void;
  getRunSnapshot: (runId: string) => MachineRunSnapshot | undefined;
  clearRunSnapshot: (runId: string) => void;
  resetForTests: () => void;
};

function resolveMachineControlStatePath(baseDir?: string): string {
  return path.join(resolvePairingPaths(baseDir, "devices").dir, "machine-control.json");
}

function defaultState(): MachineControlState {
  return MachineControlStateSchema.parse({
    version: 1,
    killSwitch: {
      enabled: false,
      updatedAtMs: 0,
    },
    linksByDeviceId: {},
  });
}

function loadStateSync(baseDir?: string): MachineControlState {
  const filePath = resolveMachineControlStatePath(baseDir);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const result = MachineControlStateSchema.safeParse(parsed);
    return result.success ? result.data : defaultState();
  } catch {
    return defaultState();
  }
}

function writeStateSync(baseDir: string | undefined, state: MachineControlState): void {
  const filePath = resolveMachineControlStatePath(baseDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

function isPairedDevice(deviceId: string, baseDir?: string): boolean {
  const { pairedPath } = resolvePairingPaths(baseDir, "devices");
  try {
    const raw = fs.readFileSync(pairedPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Boolean(parsed?.[deviceId]);
  } catch {
    return false;
  }
}

function normalizeDeviceId(value?: string | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function createMachineControlService(params?: {
  baseDir?: string;
}): MachineControlService {
  const baseDir = params?.baseDir;
  const runSnapshots = new Map<string, MachineRunSnapshot>();
  const service: MachineControlService = {
    getSnapshot() {
      const state = loadStateSync(baseDir);
      return MachineControlSnapshotSchema.parse({
        killSwitch: state.killSwitch,
        linkedDevices: Object.values(state.linksByDeviceId).toSorted((left, right) =>
          left.deviceId.localeCompare(right.deviceId),
        ),
      });
    },
    getLink(deviceId) {
      const normalized = normalizeDeviceId(deviceId);
      if (!normalized) {
        return undefined;
      }
      return loadStateSync(baseDir).linksByDeviceId[normalized];
    },
    linkDevice(linkParams) {
      const deviceId = normalizeDeviceId(linkParams.deviceId);
      if (!deviceId) {
        throw new Error("deviceId required");
      }
      if (!isPairedDevice(deviceId, baseDir)) {
        throw new Error("paired device required before machine-control link");
      }
      const state = loadStateSync(baseDir);
      const now = Date.now();
      const existing = state.linksByDeviceId[deviceId];
      const next = MachineControlStateSchema.parse({
        ...state,
        linksByDeviceId: {
          ...state.linksByDeviceId,
          [deviceId]: {
            deviceId,
            linkedAtMs: existing?.linkedAtMs ?? now,
            updatedAtMs: now,
            ...(normalizeDeviceId(linkParams.linkedByDeviceId ?? undefined)
              ? { linkedByDeviceId: normalizeDeviceId(linkParams.linkedByDeviceId ?? undefined) ?? undefined }
              : {}),
            ...(typeof linkParams.note === "string" && linkParams.note.trim()
              ? { note: linkParams.note.trim() }
              : {}),
          },
        },
      });
      writeStateSync(baseDir, next);
      return next.linksByDeviceId[deviceId]!;
    },
    unlinkDevice(unlinkParams) {
      const deviceId = normalizeDeviceId(unlinkParams.deviceId);
      if (!deviceId) {
        return { removed: false };
      }
      const state = loadStateSync(baseDir);
      if (!state.linksByDeviceId[deviceId]) {
        return { removed: false };
      }
      const nextLinks = { ...state.linksByDeviceId };
      delete nextLinks[deviceId];
      writeStateSync(
        baseDir,
        MachineControlStateSchema.parse({
          ...state,
          linksByDeviceId: nextLinks,
        }),
      );
      return { removed: true };
    },
    setKillSwitch(killSwitchParams) {
      const state = loadStateSync(baseDir);
      const next = MachineControlStateSchema.parse({
        ...state,
        killSwitch: {
          enabled: killSwitchParams.enabled,
          updatedAtMs: Date.now(),
          ...(normalizeDeviceId(killSwitchParams.updatedByDeviceId ?? undefined)
            ? {
                updatedByDeviceId:
                  normalizeDeviceId(killSwitchParams.updatedByDeviceId ?? undefined) ?? undefined,
              }
            : {}),
          ...(typeof killSwitchParams.reason === "string" && killSwitchParams.reason.trim()
            ? { reason: killSwitchParams.reason.trim() }
            : {}),
        },
      });
      writeStateSync(baseDir, next);
      return service.getSnapshot();
    },
    evaluateDeviceAccess(deviceId) {
      const normalizedDeviceId = normalizeDeviceId(deviceId);
      const snapshot = this.getSnapshot();
      if (!normalizedDeviceId) {
        return MachineControlAccessResultSchema.parse({
          allowed: false,
          code: "missing_device_identity",
          message: "machine control requires an authenticated operator device",
        });
      }
      if (snapshot.killSwitch.enabled) {
        return MachineControlAccessResultSchema.parse({
          allowed: false,
          code: "kill_switch_enabled",
          message: "machine control is disabled by kill switch",
        });
      }
      const link = snapshot.linkedDevices.find((entry) => entry.deviceId === normalizedDeviceId);
      if (!link) {
        return MachineControlAccessResultSchema.parse({
          allowed: false,
          code: "device_not_linked",
          message: "machine control is not linked for this device",
        });
      }
      return MachineControlAccessResultSchema.parse({
        allowed: true,
        code: "allowed",
        message: "machine control allowed for linked device",
        link,
      });
    },
    recordRunSnapshot(snapshot) {
      // Bound snapshot retention so long-lived gateways do not accumulate stale runs forever.
      if (!runSnapshots.has(snapshot.runId) && runSnapshots.size >= MAX_RUN_SNAPSHOTS) {
        const oldestRunId = runSnapshots.keys().next().value;
        if (typeof oldestRunId === "string") {
          runSnapshots.delete(oldestRunId);
        }
      }
      runSnapshots.set(snapshot.runId, snapshot);
    },
    getRunSnapshot(runId) {
      const normalized = normalizeDeviceId(runId);
      if (!normalized) {
        return undefined;
      }
      return runSnapshots.get(normalized);
    },
    clearRunSnapshot(runId) {
      const normalized = normalizeDeviceId(runId);
      if (!normalized) {
        return;
      }
      runSnapshots.delete(normalized);
    },
    resetForTests() {
      runSnapshots.clear();
      try {
        fs.rmSync(resolveMachineControlStatePath(baseDir), { force: true });
      } catch {
        // ignore
      }
    },
  };
  return service;
}

let sharedMachineControlService: MachineControlService | null = null;

export function getPlatformMachineControlService(): MachineControlService {
  if (!sharedMachineControlService) {
    sharedMachineControlService = createMachineControlService({
      baseDir: process.env.OPENCLAW_STATE_DIR,
    });
  }
  return sharedMachineControlService;
}

export function resetPlatformMachineControlService(): void {
  sharedMachineControlService?.resetForTests();
  sharedMachineControlService = null;
}
