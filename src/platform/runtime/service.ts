import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveStateDir } from "../../config/paths.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import {
  PlatformRuntimeCheckpointSchema,
  PlatformRuntimeCheckpointStoreSchema,
  PlatformRuntimeCheckpointSummarySchema,
  type PlatformRuntimeBoundary,
  type PlatformRuntimeCheckpoint,
  type PlatformRuntimeCheckpointStatus,
  type PlatformRuntimeCheckpointSummary,
  type PlatformRuntimeNextAction,
  type PlatformRuntimeTarget,
} from "./contracts.js";

const PLATFORM_RUNTIME_SERVICE_KEY = Symbol.for("openclaw.platform.runtime.service");
const PLATFORM_RUNTIME_CHECKPOINTS_FILENAME = "platform-runtime-checkpoints.json";

export type PlatformRuntimeCheckpointService = {
  configure: (params: { stateDir?: string }) => void;
  createCheckpoint: (params: {
    id?: string;
    runId: string;
    sessionKey?: string;
    boundary: PlatformRuntimeBoundary;
    blockedReason?: string;
    policyReasons?: string[];
    deniedReasons?: string[];
    nextActions?: PlatformRuntimeNextAction[];
    target?: PlatformRuntimeTarget;
    executionContext?: PlatformRuntimeCheckpoint["executionContext"];
  }) => PlatformRuntimeCheckpoint;
  updateCheckpoint: (
    id: string,
    patch: Partial<Omit<PlatformRuntimeCheckpoint, "id" | "createdAtMs">>,
  ) => PlatformRuntimeCheckpoint | undefined;
  get: (id: string) => PlatformRuntimeCheckpoint | undefined;
  findByApprovalId: (approvalId: string) => PlatformRuntimeCheckpoint | undefined;
  list: (params?: { sessionKey?: string; status?: PlatformRuntimeCheckpointStatus }) => PlatformRuntimeCheckpointSummary[];
  rehydrate: () => number;
  reset: () => void;
};

function resolveRuntimeCheckpointStorePath(stateDir: string): string {
  return path.join(stateDir, PLATFORM_RUNTIME_CHECKPOINTS_FILENAME);
}

function buildStorePayload(checkpoints: Map<string, PlatformRuntimeCheckpoint>) {
  return PlatformRuntimeCheckpointStoreSchema.parse({
    version: 1,
    checkpoints: Array.from(checkpoints.values()).sort((left, right) => right.updatedAtMs - left.updatedAtMs),
  });
}

export function createPlatformRuntimeCheckpointService(params?: {
  stateDir?: string;
}): PlatformRuntimeCheckpointService {
  const checkpoints = new Map<string, PlatformRuntimeCheckpoint>();
  let stateDir = params?.stateDir;

  const persist = () => {
    if (!stateDir) {
      return;
    }
    const filePath = resolveRuntimeCheckpointStorePath(stateDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    const payload = buildStorePayload(checkpoints);
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  };

  return {
    configure(config) {
      if (config.stateDir) {
        stateDir = config.stateDir;
      }
    },
    createCheckpoint(checkpointParams) {
      const now = Date.now();
      const id =
        typeof checkpointParams.id === "string" && checkpointParams.id.trim()
          ? checkpointParams.id.trim()
          : randomUUID();
      const existing = checkpoints.get(id);
      const checkpoint = PlatformRuntimeCheckpointSchema.parse({
        id,
        runId: checkpointParams.runId,
        ...(checkpointParams.sessionKey ? { sessionKey: checkpointParams.sessionKey } : {}),
        boundary: checkpointParams.boundary,
        status: "blocked",
        ...(checkpointParams.blockedReason ? { blockedReason: checkpointParams.blockedReason } : {}),
        ...(checkpointParams.policyReasons?.length ? { policyReasons: checkpointParams.policyReasons } : {}),
        ...(checkpointParams.deniedReasons?.length ? { deniedReasons: checkpointParams.deniedReasons } : {}),
        ...(checkpointParams.nextActions?.length ? { nextActions: checkpointParams.nextActions } : {}),
        ...(checkpointParams.target ? { target: checkpointParams.target } : {}),
        ...(checkpointParams.executionContext
          ? { executionContext: checkpointParams.executionContext }
          : {}),
        createdAtMs: existing?.createdAtMs ?? now,
        updatedAtMs: now,
        approvedAtMs: existing?.approvedAtMs,
        resumedAtMs: existing?.resumedAtMs,
        completedAtMs: existing?.completedAtMs,
      });
      checkpoints.set(id, checkpoint);
      persist();
      return checkpoint;
    },
    updateCheckpoint(id, patch) {
      const existing = checkpoints.get(id);
      if (!existing) {
        return undefined;
      }
      const next = PlatformRuntimeCheckpointSchema.parse({
        ...existing,
        ...patch,
        id: existing.id,
        createdAtMs: existing.createdAtMs,
        updatedAtMs:
          typeof patch.updatedAtMs === "number" ? patch.updatedAtMs : Date.now(),
      });
      checkpoints.set(id, next);
      persist();
      return next;
    },
    get(id) {
      return checkpoints.get(id);
    },
    findByApprovalId(approvalId) {
      const normalized = approvalId.trim();
      if (!normalized) {
        return undefined;
      }
      for (const checkpoint of checkpoints.values()) {
        if (checkpoint.target?.approvalId === normalized) {
          return checkpoint;
        }
      }
      return undefined;
    },
    list(listParams) {
      return Array.from(checkpoints.values())
        .filter((checkpoint) =>
          listParams?.sessionKey ? checkpoint.sessionKey === listParams.sessionKey : true,
        )
        .filter((checkpoint) => (listParams?.status ? checkpoint.status === listParams.status : true))
        .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
        .map((checkpoint) => PlatformRuntimeCheckpointSummarySchema.parse(checkpoint));
    },
    rehydrate() {
      if (!stateDir) {
        return 0;
      }
      const filePath = resolveRuntimeCheckpointStorePath(stateDir);
      let loaded = 0;
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = PlatformRuntimeCheckpointStoreSchema.parse(JSON.parse(raw));
        checkpoints.clear();
        for (const checkpoint of parsed.checkpoints) {
          checkpoints.set(checkpoint.id, checkpoint);
          loaded += 1;
        }
      } catch {
        return 0;
      }
      return loaded;
    },
    reset() {
      checkpoints.clear();
      if (stateDir) {
        try {
          fs.rmSync(resolveRuntimeCheckpointStorePath(stateDir), { force: true });
        } catch {
          // Ignore reset cleanup failures in tests.
        }
      }
    },
  };
}

export function getPlatformRuntimeCheckpointService(params?: {
  stateDir?: string;
}): PlatformRuntimeCheckpointService {
  const service = resolveGlobalSingleton(PLATFORM_RUNTIME_SERVICE_KEY, () =>
    createPlatformRuntimeCheckpointService({
      stateDir: params?.stateDir ?? resolveStateDir(process.env),
    }),
  );
  if (params?.stateDir) {
    service.configure({ stateDir: params.stateDir });
  }
  return service;
}

export function resetPlatformRuntimeCheckpointService() {
  getPlatformRuntimeCheckpointService().reset();
}
