import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveStateDir } from "../../config/paths.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import {
  PlatformRuntimeAcceptanceResultSchema,
  PlatformRuntimeCheckpointSchema,
  PlatformRuntimeCheckpointStoreSchema,
  PlatformRuntimeCheckpointSummarySchema,
  PlatformRuntimeRunOutcomeSchema,
  type PlatformRuntimeAcceptanceEvidence,
  type PlatformRuntimeAcceptanceResult,
  type PlatformRuntimeBoundary,
  type PlatformRuntimeCheckpoint,
  type PlatformRuntimeContinuation,
  type PlatformRuntimeContinuationKind,
  type PlatformRuntimeCheckpointStatus,
  type PlatformRuntimeCheckpointSummary,
  type PlatformRuntimeNextAction,
  type PlatformRuntimeRunOutcome,
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
    continuation?: PlatformRuntimeContinuation;
    executionContext?: PlatformRuntimeCheckpoint["executionContext"];
  }) => PlatformRuntimeCheckpoint;
  updateCheckpoint: (
    id: string,
    patch: Partial<Omit<PlatformRuntimeCheckpoint, "id" | "createdAtMs">>,
  ) => PlatformRuntimeCheckpoint | undefined;
  get: (id: string) => PlatformRuntimeCheckpoint | undefined;
  findByApprovalId: (approvalId: string) => PlatformRuntimeCheckpoint | undefined;
  list: (params?: {
    sessionKey?: string;
    runId?: string;
    status?: PlatformRuntimeCheckpointStatus;
  }) => PlatformRuntimeCheckpointSummary[];
  buildRunOutcome: (runId: string) => PlatformRuntimeRunOutcome | undefined;
  evaluateAcceptance: (params: {
    runId: string;
    outcome: PlatformRuntimeRunOutcome;
    evidence?: PlatformRuntimeAcceptanceEvidence;
  }) => PlatformRuntimeAcceptanceResult;
  registerContinuationHandler: (
    kind: PlatformRuntimeContinuationKind,
    handler: (checkpoint: PlatformRuntimeCheckpoint) => Promise<void> | void,
  ) => void;
  dispatchContinuation: (checkpointId: string) => Promise<PlatformRuntimeCheckpoint | undefined>;
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
  const continuationHandlers = new Map<
    PlatformRuntimeContinuationKind,
    (checkpoint: PlatformRuntimeCheckpoint) => Promise<void> | void
  >();
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
        ...(checkpointParams.continuation ? { continuation: checkpointParams.continuation } : {}),
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
        .filter((checkpoint) => (listParams?.runId ? checkpoint.runId === listParams.runId : true))
        .filter((checkpoint) => (listParams?.status ? checkpoint.status === listParams.status : true))
        .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
        .map((checkpoint) => PlatformRuntimeCheckpointSummarySchema.parse(checkpoint));
    },
    buildRunOutcome(runId) {
      const normalized = runId.trim();
      if (!normalized) {
        return undefined;
      }
      const runCheckpoints = Array.from(checkpoints.values()).filter(
        (checkpoint) => checkpoint.runId === normalized,
      );
      if (runCheckpoints.length === 0) {
        return undefined;
      }
      const blockedCheckpointIds = runCheckpoints
        .filter((checkpoint) =>
          checkpoint.status === "blocked" ||
          checkpoint.status === "approved" ||
          checkpoint.status === "resumed",
        )
        .map((checkpoint) => checkpoint.id);
      const completedCheckpointIds = runCheckpoints
        .filter((checkpoint) => checkpoint.status === "completed")
        .map((checkpoint) => checkpoint.id);
      const deniedCheckpointIds = runCheckpoints
        .filter((checkpoint) => checkpoint.status === "denied" || checkpoint.status === "cancelled")
        .map((checkpoint) => checkpoint.id);
      const pendingApprovalIds = runCheckpoints
        .filter((checkpoint) =>
          checkpoint.status === "blocked" ||
          checkpoint.status === "approved" ||
          checkpoint.status === "resumed",
        )
        .map((checkpoint) => checkpoint.target?.approvalId)
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
      const artifactIds = runCheckpoints
        .map((checkpoint) => checkpoint.target?.artifactId)
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
      const bootstrapRequestIds = runCheckpoints
        .map((checkpoint) => checkpoint.target?.bootstrapRequestId)
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
      const status =
        blockedCheckpointIds.length > 0
          ? "blocked"
          : deniedCheckpointIds.length > 0
            ? "failed"
            : completedCheckpointIds.length > 0
              ? "completed"
              : "partial";
      return PlatformRuntimeRunOutcomeSchema.parse({
        runId: normalized,
        status,
        checkpointIds: runCheckpoints.map((checkpoint) => checkpoint.id),
        blockedCheckpointIds,
        completedCheckpointIds,
        deniedCheckpointIds,
        pendingApprovalIds: Array.from(new Set(pendingApprovalIds)),
        artifactIds: Array.from(new Set(artifactIds)),
        bootstrapRequestIds: Array.from(new Set(bootstrapRequestIds)),
        boundaries: Array.from(new Set(runCheckpoints.map((checkpoint) => checkpoint.boundary))),
      });
    },
    evaluateAcceptance(params) {
      const evidence = params.evidence ?? {};
      const reasons: string[] = [];
      if (params.outcome.pendingApprovalIds.length > 0) {
        reasons.push("Run still requires operator approval before the task can finish.");
        return PlatformRuntimeAcceptanceResultSchema.parse({
          runId: params.runId,
          status: "needs_human",
          action: "escalate",
          reasonCode: "pending_approval",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      if (params.outcome.status === "blocked") {
        reasons.push("Run is blocked on a runtime boundary and cannot safely auto-complete.");
        return PlatformRuntimeAcceptanceResultSchema.parse({
          runId: params.runId,
          status: "needs_human",
          action: "escalate",
          reasonCode: "runtime_blocked",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      if (params.outcome.status === "failed") {
        reasons.push("Run reached a failed runtime outcome.");
        return PlatformRuntimeAcceptanceResultSchema.parse({
          runId: params.runId,
          status: "failed",
          action: "stop",
          reasonCode: "runtime_failed",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      if (params.outcome.status === "partial") {
        reasons.push("Run finished with only a partial runtime outcome.");
        return PlatformRuntimeAcceptanceResultSchema.parse({
          runId: params.runId,
          status: "retryable",
          action: "retry",
          reasonCode: "runtime_partial",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      const hasDeliverableEvidence =
        params.outcome.artifactIds.length > 0 ||
        params.outcome.bootstrapRequestIds.length > 0 ||
        evidence.didSendViaMessagingTool === true ||
        evidence.hasOutput === true ||
        evidence.hasStructuredReplyPayload === true ||
        (evidence.deliveredReplyCount ?? 0) > 0 ||
        (evidence.successfulCronAdds ?? 0) > 0;
      if (evidence.hadToolError === true && hasDeliverableEvidence) {
        reasons.push("Run completed with deliverable evidence, but one or more tool errors were observed.");
        return PlatformRuntimeAcceptanceResultSchema.parse({
          runId: params.runId,
          status: "partial",
          action: "stop",
          reasonCode: "completed_with_warnings",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      if (params.outcome.artifactIds.length > 0 || params.outcome.bootstrapRequestIds.length > 0) {
        reasons.push("Run completed and produced structured platform artifacts or bootstrap output.");
        return PlatformRuntimeAcceptanceResultSchema.parse({
          runId: params.runId,
          status: "satisfied",
          action: "close",
          reasonCode: "completed_with_artifacts",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      if (hasDeliverableEvidence) {
        reasons.push("Run completed with user-visible or automation-visible output.");
        return PlatformRuntimeAcceptanceResultSchema.parse({
          runId: params.runId,
          status: "satisfied",
          action: "close",
          reasonCode: "completed_with_output",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      reasons.push("Run completed but no machine-checkable delivery evidence was observed.");
      return PlatformRuntimeAcceptanceResultSchema.parse({
        runId: params.runId,
        status: "retryable",
        action: "retry",
        reasonCode: "completed_without_evidence",
        reasons,
        outcome: params.outcome,
        evidence,
      });
    },
    registerContinuationHandler(kind, handler) {
      continuationHandlers.set(kind, handler);
    },
    async dispatchContinuation(checkpointId) {
      const checkpoint = checkpoints.get(checkpointId);
      if (!checkpoint?.continuation?.kind) {
        return checkpoint;
      }
      const handler = continuationHandlers.get(checkpoint.continuation.kind);
      if (!handler) {
        return checkpoint;
      }
      const currentContinuation = checkpoint.continuation;
      const running = this.updateCheckpoint(checkpointId, {
        continuation: {
          ...currentContinuation,
          state: "running",
          attempts: (currentContinuation.attempts ?? 0) + 1,
          lastError: undefined,
          lastDispatchedAtMs: Date.now(),
        },
      });
      try {
        await handler(running ?? checkpoint);
      } catch (error) {
        return this.updateCheckpoint(checkpointId, {
          continuation: {
            ...(running?.continuation ?? currentContinuation),
            state: "failed",
            lastError: error instanceof Error ? error.message : String(error),
          },
        });
      }
      const latest = checkpoints.get(checkpointId);
      if (!latest?.continuation) {
        return latest;
      }
      const completed =
        latest.status === "completed" || latest.status === "denied" || latest.status === "cancelled";
      return this.updateCheckpoint(checkpointId, {
        continuation: {
          ...latest.continuation,
          state: completed ? "completed" : "idle",
          ...(completed ? { lastCompletedAtMs: Date.now() } : {}),
        },
      });
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
      continuationHandlers.clear();
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
