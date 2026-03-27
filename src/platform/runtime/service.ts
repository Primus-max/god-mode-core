import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import {
  PlatformRuntimeAcceptanceResultSchema,
  PlatformRuntimeActionSchema,
  PlatformRuntimeActionStoreSchema,
  PlatformRuntimeActionSummarySchema,
  PlatformRuntimeCheckpointSchema,
  PlatformRuntimeCheckpointStoreSchema,
  PlatformRuntimeCheckpointSummarySchema,
  PlatformRuntimeRunOutcomeSchema,
  type PlatformRuntimeAcceptanceEvidence,
  type PlatformRuntimeAcceptanceResult,
  type PlatformRuntimeAction,
  type PlatformRuntimeActionKind,
  type PlatformRuntimeActionReceipt,
  type PlatformRuntimeActionState,
  type PlatformRuntimeActionSummary,
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
const PLATFORM_RUNTIME_ACTIONS_FILENAME = "platform-runtime-actions.json";

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
  stageAction: (params: {
    actionId: string;
    runId?: string;
    sessionKey?: string;
    kind: PlatformRuntimeActionKind;
    boundary?: PlatformRuntimeBoundary;
    checkpointId?: string;
    idempotencyKey?: string;
    target?: PlatformRuntimeTarget;
    receipt?: PlatformRuntimeActionReceipt;
  }) => PlatformRuntimeAction;
  updateAction: (
    actionId: string,
    patch: Partial<Omit<PlatformRuntimeAction, "actionId" | "createdAtMs">>,
  ) => PlatformRuntimeAction | undefined;
  markActionAttempted: (
    actionId: string,
    patch?: Partial<Pick<PlatformRuntimeAction, "receipt" | "lastError" | "retryable">>,
  ) => PlatformRuntimeAction | undefined;
  markActionConfirmed: (
    actionId: string,
    patch?: Partial<Pick<PlatformRuntimeAction, "receipt" | "lastError" | "retryable">>,
  ) => PlatformRuntimeAction | undefined;
  markActionFailed: (
    actionId: string,
    patch?: Partial<Pick<PlatformRuntimeAction, "receipt" | "lastError" | "retryable">>,
  ) => PlatformRuntimeAction | undefined;
  getAction: (actionId: string) => PlatformRuntimeAction | undefined;
  listActions: (params?: {
    runId?: string;
    sessionKey?: string;
    kind?: PlatformRuntimeActionKind;
    state?: PlatformRuntimeActionState;
    checkpointId?: string;
  }) => PlatformRuntimeActionSummary[];
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

function resolveRuntimeActionStorePath(stateDir: string): string {
  return path.join(stateDir, PLATFORM_RUNTIME_ACTIONS_FILENAME);
}

function buildStorePayload(checkpoints: Map<string, PlatformRuntimeCheckpoint>) {
  return PlatformRuntimeCheckpointStoreSchema.parse({
    version: 1,
    checkpoints: Array.from(checkpoints.values()).toSorted(
      (left, right) => right.updatedAtMs - left.updatedAtMs,
    ),
  });
}

function buildActionStorePayload(actions: Map<string, PlatformRuntimeAction>) {
  return PlatformRuntimeActionStoreSchema.parse({
    version: 1,
    actions: Array.from(actions.values()).toSorted(
      (left, right) => right.updatedAtMs - left.updatedAtMs,
    ),
  });
}

export function createPlatformRuntimeCheckpointService(params?: {
  stateDir?: string;
}): PlatformRuntimeCheckpointService {
  const checkpoints = new Map<string, PlatformRuntimeCheckpoint>();
  const actions = new Map<string, PlatformRuntimeAction>();
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
    const actionPath = resolveRuntimeActionStorePath(stateDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    const actionTmpPath = `${actionPath}.${process.pid}.tmp`;
    const payload = buildStorePayload(checkpoints);
    const actionPayload = buildActionStorePayload(actions);
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.writeFileSync(actionTmpPath, JSON.stringify(actionPayload, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmpPath, filePath);
    fs.renameSync(actionTmpPath, actionPath);
  };

  const saveAction = (action: PlatformRuntimeAction) => {
    actions.set(action.actionId, action);
    persist();
    return action;
  };

  const mergeAction = (
    actionId: string,
    patch: Partial<Omit<PlatformRuntimeAction, "actionId" | "createdAtMs">>,
  ): PlatformRuntimeAction | undefined => {
    const existing = actions.get(actionId);
    if (!existing) {
      return undefined;
    }
    const next = PlatformRuntimeActionSchema.parse({
      ...existing,
      ...patch,
      actionId: existing.actionId,
      createdAtMs: existing.createdAtMs,
      updatedAtMs: typeof patch.updatedAtMs === "number" ? patch.updatedAtMs : Date.now(),
    });
    return saveAction(next);
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
        ...(checkpointParams.blockedReason
          ? { blockedReason: checkpointParams.blockedReason }
          : {}),
        ...(checkpointParams.policyReasons?.length
          ? { policyReasons: checkpointParams.policyReasons }
          : {}),
        ...(checkpointParams.deniedReasons?.length
          ? { deniedReasons: checkpointParams.deniedReasons }
          : {}),
        ...(checkpointParams.nextActions?.length
          ? { nextActions: checkpointParams.nextActions }
          : {}),
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
        updatedAtMs: typeof patch.updatedAtMs === "number" ? patch.updatedAtMs : Date.now(),
      });
      checkpoints.set(id, next);
      persist();
      return next;
    },
    get(id) {
      return checkpoints.get(id);
    },
    stageAction(actionParams) {
      const now = Date.now();
      const existing = actions.get(actionParams.actionId);
      const action = PlatformRuntimeActionSchema.parse({
        actionId: actionParams.actionId,
        ...(actionParams.runId ? { runId: actionParams.runId } : {}),
        ...(actionParams.sessionKey ? { sessionKey: actionParams.sessionKey } : {}),
        kind: actionParams.kind,
        state: existing?.state ?? "staged",
        ...(actionParams.boundary ? { boundary: actionParams.boundary } : {}),
        ...(actionParams.checkpointId ? { checkpointId: actionParams.checkpointId } : {}),
        ...(actionParams.idempotencyKey ? { idempotencyKey: actionParams.idempotencyKey } : {}),
        ...(actionParams.target ? { target: actionParams.target } : {}),
        ...((actionParams.receipt ?? existing?.receipt)
          ? { receipt: actionParams.receipt ?? existing?.receipt }
          : {}),
        attemptCount: existing?.attemptCount ?? 0,
        retryable: existing?.retryable,
        lastError: existing?.lastError,
        createdAtMs: existing?.createdAtMs ?? now,
        updatedAtMs: now,
        stagedAtMs: existing?.stagedAtMs ?? now,
        attemptedAtMs: existing?.attemptedAtMs,
        confirmedAtMs: existing?.confirmedAtMs,
        failedAtMs: existing?.failedAtMs,
      });
      return saveAction(action);
    },
    updateAction(actionId, patch) {
      return mergeAction(actionId, patch);
    },
    markActionAttempted(actionId, patch) {
      const existing = actions.get(actionId);
      if (!existing) {
        return undefined;
      }
      return mergeAction(actionId, {
        state: "attempted",
        attemptCount: existing.attemptCount + 1,
        attemptedAtMs: Date.now(),
        lastError: patch?.lastError,
        retryable: patch?.retryable,
        ...(patch?.receipt ? { receipt: patch.receipt } : {}),
      });
    },
    markActionConfirmed(actionId, patch) {
      return mergeAction(actionId, {
        state: "confirmed",
        confirmedAtMs: Date.now(),
        retryable: false,
        lastError: patch?.lastError,
        ...(patch?.receipt ? { receipt: patch.receipt } : {}),
      });
    },
    markActionFailed(actionId, patch) {
      return mergeAction(actionId, {
        state: "failed",
        failedAtMs: Date.now(),
        retryable: patch?.retryable,
        lastError: patch?.lastError,
        ...(patch?.receipt ? { receipt: patch.receipt } : {}),
      });
    },
    getAction(actionId) {
      return actions.get(actionId);
    },
    listActions(listParams) {
      return Array.from(actions.values())
        .filter((action) => (listParams?.runId ? action.runId === listParams.runId : true))
        .filter((action) =>
          listParams?.sessionKey ? action.sessionKey === listParams.sessionKey : true,
        )
        .filter((action) => (listParams?.kind ? action.kind === listParams.kind : true))
        .filter((action) => (listParams?.state ? action.state === listParams.state : true))
        .filter((action) =>
          listParams?.checkpointId ? action.checkpointId === listParams.checkpointId : true,
        )
        .toSorted((left, right) => right.updatedAtMs - left.updatedAtMs)
        .map((action) =>
          PlatformRuntimeActionSummarySchema.parse({
            actionId: action.actionId,
            runId: action.runId,
            sessionKey: action.sessionKey,
            kind: action.kind,
            state: action.state,
            boundary: action.boundary,
            checkpointId: action.checkpointId,
            target: action.target,
            attemptCount: action.attemptCount,
            retryable: action.retryable,
            lastError: action.lastError,
            createdAtMs: action.createdAtMs,
            updatedAtMs: action.updatedAtMs,
            stagedAtMs: action.stagedAtMs,
            attemptedAtMs: action.attemptedAtMs,
            confirmedAtMs: action.confirmedAtMs,
            failedAtMs: action.failedAtMs,
          }),
        );
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
        .filter((checkpoint) =>
          listParams?.status ? checkpoint.status === listParams.status : true,
        )
        .toSorted((left, right) => right.updatedAtMs - left.updatedAtMs)
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
      const runActions = Array.from(actions.values()).filter(
        (action) => action.runId === normalized,
      );
      if (runCheckpoints.length === 0 && runActions.length === 0) {
        return undefined;
      }
      const blockedCheckpointIds = runCheckpoints
        .filter(
          (checkpoint) =>
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
        .filter(
          (checkpoint) =>
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
      const actionIds = runActions.map((action) => action.actionId);
      const attemptedActionIds = runActions
        .filter((action) => action.state === "attempted" || action.state === "partial")
        .map((action) => action.actionId);
      const confirmedActionIds = runActions
        .filter((action) => action.state === "confirmed")
        .map((action) => action.actionId);
      const failedActionIds = runActions
        .filter((action) => action.state === "failed")
        .map((action) => action.actionId);
      const status =
        blockedCheckpointIds.length > 0
          ? "blocked"
          : deniedCheckpointIds.length > 0
            ? "failed"
            : completedCheckpointIds.length > 0 || confirmedActionIds.length > 0
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
        actionIds: Array.from(new Set(actionIds)),
        attemptedActionIds: Array.from(new Set(attemptedActionIds)),
        confirmedActionIds: Array.from(new Set(confirmedActionIds)),
        failedActionIds: Array.from(new Set(failedActionIds)),
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
      const confirmedDeliveryCount =
        evidence.confirmedDeliveryCount ?? evidence.deliveredReplyCount ?? 0;
      const attemptedDeliveryCount = evidence.attemptedDeliveryCount ?? 0;
      const failedDeliveryCount = evidence.failedDeliveryCount ?? 0;
      const attemptedActionCount =
        evidence.attemptedActionCount ?? params.outcome.attemptedActionIds.length;
      const confirmedActionCount =
        evidence.confirmedActionCount ?? params.outcome.confirmedActionIds.length;
      const failedActionCount = evidence.failedActionCount ?? params.outcome.failedActionIds.length;
      if (attemptedDeliveryCount > 0 && confirmedDeliveryCount === 0 && failedDeliveryCount > 0) {
        reasons.push(
          "Run completed, but delivery attempts failed before any message was confirmed.",
        );
        return PlatformRuntimeAcceptanceResultSchema.parse({
          runId: params.runId,
          status: "retryable",
          action: "retry",
          reasonCode: "delivery_failed",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      if (
        evidence.partialDelivery === true ||
        (confirmedDeliveryCount > 0 && failedDeliveryCount > 0)
      ) {
        reasons.push("Run completed, but delivery only partially succeeded.");
        return PlatformRuntimeAcceptanceResultSchema.parse({
          runId: params.runId,
          status: "partial",
          action: "retry",
          reasonCode: "delivery_partial",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      const hasDeliverableEvidence =
        (evidence.artifactReceiptCount ?? params.outcome.artifactIds.length) > 0 ||
        (evidence.bootstrapReceiptCount ?? params.outcome.bootstrapRequestIds.length) > 0 ||
        evidence.didSendViaMessagingTool === true ||
        evidence.hasOutput === true ||
        evidence.hasStructuredReplyPayload === true ||
        confirmedDeliveryCount > 0 ||
        confirmedActionCount > 0 ||
        (evidence.successfulCronAdds ?? 0) > 0;
      if (
        attemptedDeliveryCount === 0 &&
        confirmedDeliveryCount === 0 &&
        attemptedActionCount > 0 &&
        confirmedActionCount === 0 &&
        failedActionCount > 0
      ) {
        reasons.push(
          "Run completed, but replay-sensitive actions failed before any receipt was confirmed.",
        );
        return PlatformRuntimeAcceptanceResultSchema.parse({
          runId: params.runId,
          status: "retryable",
          action: "retry",
          reasonCode: "completed_without_evidence",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      if (evidence.hadToolError === true && hasDeliverableEvidence) {
        reasons.push(
          "Run completed with deliverable evidence, but one or more tool errors were observed.",
        );
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
      if (
        (evidence.artifactReceiptCount ?? params.outcome.artifactIds.length) > 0 ||
        (evidence.bootstrapReceiptCount ?? params.outcome.bootstrapRequestIds.length) > 0
      ) {
        reasons.push(
          "Run completed and produced structured platform artifacts or bootstrap output.",
        );
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
      if (confirmedDeliveryCount > 0) {
        reasons.push("Run completed and delivery was confirmed by the outbound runtime.");
        return PlatformRuntimeAcceptanceResultSchema.parse({
          runId: params.runId,
          status: "satisfied",
          action: "close",
          reasonCode: "completed_with_confirmed_delivery",
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
        latest.status === "completed" ||
        latest.status === "denied" ||
        latest.status === "cancelled";
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
      let loaded = 0;
      try {
        const checkpointRaw = fs.readFileSync(resolveRuntimeCheckpointStorePath(stateDir), "utf8");
        const parsed = PlatformRuntimeCheckpointStoreSchema.parse(JSON.parse(checkpointRaw));
        checkpoints.clear();
        for (const checkpoint of parsed.checkpoints) {
          checkpoints.set(checkpoint.id, checkpoint);
          loaded += 1;
        }
      } catch {
        checkpoints.clear();
      }
      try {
        const actionRaw = fs.readFileSync(resolveRuntimeActionStorePath(stateDir), "utf8");
        const parsed = PlatformRuntimeActionStoreSchema.parse(JSON.parse(actionRaw));
        actions.clear();
        for (const action of parsed.actions) {
          actions.set(action.actionId, action);
          loaded += 1;
        }
      } catch {
        actions.clear();
      }
      return loaded;
    },
    reset() {
      checkpoints.clear();
      actions.clear();
      continuationHandlers.clear();
      if (stateDir) {
        try {
          fs.rmSync(resolveRuntimeCheckpointStorePath(stateDir), { force: true });
        } catch {
          // Ignore reset cleanup failures in tests.
        }
        try {
          fs.rmSync(resolveRuntimeActionStorePath(stateDir), { force: true });
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
