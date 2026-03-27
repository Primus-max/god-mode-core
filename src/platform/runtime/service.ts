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
  PlatformRuntimeExecutionContractSchema,
  PlatformRuntimeExecutionReceiptCountsSchema,
  PlatformRuntimeExecutionReceiptProofCountsSchema,
  PlatformRuntimeExecutionReceiptSchema,
  PlatformRuntimeExecutionSurfaceSchema,
  PlatformRuntimeExecutionVerificationSchema,
  PlatformRuntimeRunOutcomeSchema,
  PlatformRuntimeSupervisorVerdictSchema,
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
  type PlatformRuntimeExecutionContract,
  type PlatformRuntimeExecutionReceipt,
  type PlatformRuntimeExecutionReceiptCounts,
  type PlatformRuntimeExecutionReceiptKind,
  type PlatformRuntimeExecutionReceiptProofCounts,
  type PlatformRuntimeExecutionSurface,
  type PlatformRuntimeExecutionVerification,
  type PlatformRuntimeNextAction,
  type PlatformRuntimeRunOutcome,
  type PlatformRuntimeSupervisorVerdict,
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
  buildAcceptanceEvidence: (params: {
    outcome: PlatformRuntimeRunOutcome;
    evidence?: PlatformRuntimeAcceptanceEvidence;
    executionVerification?: PlatformRuntimeExecutionVerification;
    executionSurface?: PlatformRuntimeExecutionSurface;
  }) => PlatformRuntimeAcceptanceEvidence;
  buildExecutionReceipts: (params: {
    runId: string;
    outcome?: PlatformRuntimeRunOutcome;
    receipts?: PlatformRuntimeExecutionReceipt[];
  }) => PlatformRuntimeExecutionReceipt[];
  verifyExecutionContract: (params: {
    contract: PlatformRuntimeExecutionContract;
    outcome?: PlatformRuntimeRunOutcome;
    evidence?: PlatformRuntimeAcceptanceEvidence;
  }) => PlatformRuntimeExecutionVerification;
  evaluateAcceptance: (params: {
    runId: string;
    outcome: PlatformRuntimeRunOutcome;
    evidence?: PlatformRuntimeAcceptanceEvidence;
  }) => PlatformRuntimeAcceptanceResult;
  evaluateSupervisorVerdict: (params: {
    runId: string;
    acceptance?: PlatformRuntimeAcceptanceResult;
    verification?: PlatformRuntimeExecutionVerification;
    surface?: PlatformRuntimeExecutionSurface;
  }) => PlatformRuntimeSupervisorVerdict;
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

function normalizeReasons(values: string[] | undefined): string[] | undefined {
  if (!values?.length) {
    return undefined;
  }
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
}

function buildExecutionReceiptCounts(
  receipts: PlatformRuntimeExecutionReceipt[],
): PlatformRuntimeExecutionReceiptCounts {
  const counts = {
    success: 0,
    warning: 0,
    partial: 0,
    degraded: 0,
    failed: 0,
    blocked: 0,
  } satisfies PlatformRuntimeExecutionReceiptCounts;
  for (const receipt of receipts) {
    counts[receipt.status] += 1;
  }
  return PlatformRuntimeExecutionReceiptCountsSchema.parse(counts);
}

function buildExecutionReceiptProofCounts(
  receipts: PlatformRuntimeExecutionReceipt[],
): PlatformRuntimeExecutionReceiptProofCounts {
  const counts = {
    derived: 0,
    reported: 0,
    verified: 0,
  } satisfies PlatformRuntimeExecutionReceiptProofCounts;
  for (const receipt of receipts) {
    counts[receipt.proof] += 1;
  }
  return PlatformRuntimeExecutionReceiptProofCountsSchema.parse(counts);
}

function classifyProviderEvidence(
  evidence: PlatformRuntimeAcceptanceEvidence,
): "auth_refresh" | "provider_fallback" | undefined {
  if (evidence.providerAuthFailed === true || evidence.modelFallbackFinalReason === "auth") {
    return "auth_refresh";
  }
  if (
    evidence.modelFallbackExhausted === true ||
    evidence.providerRateLimited === true ||
    evidence.providerModelNotFound === true
  ) {
    return "provider_fallback";
  }
  const finalReason = evidence.modelFallbackFinalReason;
  if (
    finalReason === "rate_limit" ||
    finalReason === "overloaded" ||
    finalReason === "model_not_found" ||
    finalReason === "billing" ||
    finalReason === "no_profiles_available"
  ) {
    return "provider_fallback";
  }
  return undefined;
}

function resolveAcceptanceRemediation(params: {
  action: PlatformRuntimeAcceptanceResult["action"];
  reasonCode: PlatformRuntimeAcceptanceResult["reasonCode"];
  evidence: PlatformRuntimeAcceptanceEvidence;
}): PlatformRuntimeAcceptanceResult["remediation"] {
  if (
    params.reasonCode === "pending_approval" ||
    params.reasonCode === "runtime_blocked" ||
    params.action === "escalate"
  ) {
    return "needs_human";
  }
  if (
    params.reasonCode === "bootstrap_required" ||
    params.evidence.executionSurfaceStatus === "bootstrap_required" ||
    params.evidence.executionUnattendedBoundary === "bootstrap"
  ) {
    return "bootstrap";
  }
  const providerRecovery = classifyProviderEvidence(params.evidence);
  if (providerRecovery) {
    return providerRecovery;
  }
  if (params.reasonCode === "delivery_failed" || params.reasonCode === "delivery_partial") {
    return "delivery_retry";
  }
  if (params.action === "stop") {
    return "stop";
  }
  if (params.action === "close") {
    return "none";
  }
  return "semantic_retry";
}

function parseAcceptanceResult(params: {
  runId: string;
  status: PlatformRuntimeAcceptanceResult["status"];
  action: PlatformRuntimeAcceptanceResult["action"];
  reasonCode: PlatformRuntimeAcceptanceResult["reasonCode"];
  reasons: string[];
  outcome: PlatformRuntimeRunOutcome;
  evidence: PlatformRuntimeAcceptanceEvidence;
}): PlatformRuntimeAcceptanceResult {
  return PlatformRuntimeAcceptanceResultSchema.parse({
    ...params,
    remediation: resolveAcceptanceRemediation({
      action: params.action,
      reasonCode: params.reasonCode,
      evidence: params.evidence,
    }),
  });
}

function resolveSupervisorReasonCode(params: {
  acceptance?: PlatformRuntimeAcceptanceResult;
  verification?: PlatformRuntimeExecutionVerification;
  surface?: PlatformRuntimeExecutionSurface;
  fallbackReasonCode:
    | "verified_execution"
    | "contract_mismatch"
    | "execution_no_progress"
    | "execution_degraded"
    | "transient_recoverable"
    | "needs_human"
    | "runtime_failed";
}): PlatformRuntimeSupervisorVerdict["reasonCode"] {
  const remediation =
    params.acceptance?.remediation ??
    resolveAcceptanceRemediation({
      action: params.acceptance?.action ?? "close",
      reasonCode: params.acceptance?.reasonCode ?? "completed_with_output",
      evidence: params.acceptance?.evidence ?? {},
    });
  if (remediation === "bootstrap") {
    return "bootstrap_recovery";
  }
  if (remediation === "auth_refresh") {
    return "auth_recovery";
  }
  if (remediation === "provider_fallback") {
    return "provider_recovery";
  }
  return params.fallbackReasonCode;
}

function parseSupervisorVerdict(params: {
  runId: string;
  status: PlatformRuntimeSupervisorVerdict["status"];
  action: PlatformRuntimeSupervisorVerdict["action"];
  reasonCode: PlatformRuntimeSupervisorVerdict["reasonCode"];
  reasons: string[];
  acceptance?: PlatformRuntimeAcceptanceResult;
  verification?: PlatformRuntimeExecutionVerification;
  surface?: PlatformRuntimeExecutionSurface;
}): PlatformRuntimeSupervisorVerdict {
  return PlatformRuntimeSupervisorVerdictSchema.parse({
    ...params,
    remediation:
      params.acceptance?.remediation ??
      resolveAcceptanceRemediation({
        action: params.action,
        reasonCode: params.acceptance?.reasonCode ?? "completed_with_output",
        evidence: params.acceptance?.evidence ?? {},
      }),
  });
}

function buildExecutionReceiptKey(receipt: PlatformRuntimeExecutionReceipt): string {
  const actionId =
    receipt.metadata && typeof receipt.metadata.actionId === "string"
      ? receipt.metadata.actionId
      : "";
  return [receipt.kind, receipt.name, receipt.status, receipt.proof, actionId].join("::");
}

function resolveActionExecutionReceiptKind(
  action: PlatformRuntimeAction,
): PlatformRuntimeExecutionReceiptKind {
  if (action.kind === "messaging_delivery") {
    return "messaging_delivery";
  }
  if (action.kind === "bootstrap") {
    return "capability";
  }
  return "platform_action";
}

function resolveActionExecutionReceiptName(action: PlatformRuntimeAction): string {
  if (action.kind === "bootstrap") {
    return action.receipt?.operation?.trim() || "bootstrap.run";
  }
  if (action.kind === "artifact_publish") {
    const operation = action.receipt?.operation?.trim() || action.target?.operation?.trim();
    return operation ? `artifact.${operation}` : "artifact.transition";
  }
  if (action.kind === "messaging_delivery") {
    const deliveryChannel = action.receipt?.deliveryResults?.[0]?.channel?.trim();
    return deliveryChannel ? `delivery.${deliveryChannel}` : "delivery";
  }
  if (action.kind === "node_invoke") {
    return action.receipt?.operation?.trim() || "node.invoke";
  }
  if (action.kind === "machine_control") {
    return action.receipt?.operation?.trim() || "machine.control";
  }
  if (action.kind === "privileged_tool") {
    return (
      action.receipt?.command?.trim() || action.receipt?.operation?.trim() || "privileged_tool"
    );
  }
  return action.kind;
}

function hasStructuredActionReceipt(action: PlatformRuntimeAction): boolean {
  if (!action.receipt) {
    return false;
  }
  if ((action.receipt.deliveryResults?.length ?? 0) > 0) {
    return true;
  }
  if (
    action.kind === "bootstrap" &&
    action.receipt.bootstrapRequestId &&
    action.receipt.capabilityId &&
    action.receipt.operation &&
    action.receipt.resultStatus
  ) {
    return true;
  }
  if (
    action.kind === "artifact_publish" &&
    action.receipt.artifactId &&
    action.receipt.operation &&
    action.receipt.resultStatus
  ) {
    return true;
  }
  if (
    action.kind === "node_invoke" &&
    (action.receipt.nodeId || action.receipt.nodeInvokeResult || action.receipt.operation)
  ) {
    return true;
  }
  if (
    (action.kind === "machine_control" || action.kind === "privileged_tool") &&
    (action.receipt.command || action.receipt.operation || action.receipt.resultStatus)
  ) {
    return true;
  }
  return false;
}

function buildExecutionReceiptFromAction(
  action: PlatformRuntimeAction,
): PlatformRuntimeExecutionReceipt | undefined {
  if (action.state === "staged") {
    return undefined;
  }
  const reasons: string[] = [];
  const structuredReceipt = hasStructuredActionReceipt(action);
  const proof = structuredReceipt ? "verified" : "derived";
  let status: PlatformRuntimeExecutionReceipt["status"];
  if (action.state === "failed") {
    status = "failed";
  } else if (action.state === "partial" || action.state === "attempted") {
    status = structuredReceipt ? "partial" : "warning";
  } else {
    status = structuredReceipt ? "success" : "warning";
  }
  if (!structuredReceipt) {
    reasons.push("runtime action completed without a structured receipt payload");
  }
  if (action.lastError) {
    reasons.push(action.lastError);
  }
  if (action.state === "attempted") {
    reasons.push("runtime action was attempted but not yet confirmed");
  }
  return PlatformRuntimeExecutionReceiptSchema.parse({
    kind: resolveActionExecutionReceiptKind(action),
    name: resolveActionExecutionReceiptName(action),
    status,
    proof,
    summary:
      action.state === "confirmed"
        ? "runtime action confirmed"
        : action.state === "failed"
          ? "runtime action failed"
          : "runtime action remains in progress",
    ...(normalizeReasons(reasons) ? { reasons: normalizeReasons(reasons) } : {}),
    metadata: {
      actionId: action.actionId,
      actionKind: action.kind,
      actionState: action.state,
      ...(action.checkpointId ? { checkpointId: action.checkpointId } : {}),
      ...(action.boundary ? { boundary: action.boundary } : {}),
      ...(action.receipt?.artifactId ? { artifactId: action.receipt.artifactId } : {}),
      ...(action.receipt?.bootstrapRequestId
        ? { bootstrapRequestId: action.receipt.bootstrapRequestId }
        : {}),
      ...(action.receipt?.capabilityId ? { capabilityId: action.receipt.capabilityId } : {}),
      ...(action.receipt?.nodeId ? { nodeId: action.receipt.nodeId } : {}),
      ...(action.receipt?.operation ? { operation: action.receipt.operation } : {}),
      ...(action.receipt?.resultStatus ? { resultStatus: action.receipt.resultStatus } : {}),
    },
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
    buildAcceptanceEvidence(params) {
      const merged = {
        ...params.evidence,
      };
      if (params.executionVerification) {
        const receiptCounts = params.executionVerification.receiptCounts;
        const proofCounts = params.executionVerification.receiptProofCounts;
        merged.executionReceiptCount = params.executionVerification.receipts.length;
        merged.structuredExecutionReceiptCount = proofCounts.reported + proofCounts.verified;
        merged.verifiedExecutionReceiptCount = proofCounts.verified;
        merged.verifiedExecution =
          params.executionVerification.status === "verified" ||
          params.executionVerification.status === "warning";
        merged.executionWarningCount = receiptCounts.warning;
        merged.executionPartialCount = receiptCounts.partial;
        merged.degradedExecutionCount = receiptCounts.degraded;
        merged.executionContractMismatch =
          params.executionVerification.status === "mismatch" ||
          params.executionVerification.status === "failed";
        merged.noProgressSignals =
          params.executionVerification.status === "no_progress"
            ? Math.max(receiptCounts.blocked, 1)
            : receiptCounts.blocked;
      }
      if (params.executionSurface) {
        merged.executionSurfaceStatus = params.executionSurface.status;
        merged.executionSurfaceDegraded =
          params.executionSurface.status === "degraded" ||
          params.executionSurface.status === "unavailable";
        if (params.executionSurface.unattendedBoundary) {
          merged.executionUnattendedBoundary = params.executionSurface.unattendedBoundary;
        }
      }
      return merged;
    },
    buildExecutionReceipts(params) {
      const normalizedRunId = params.runId.trim();
      if (!normalizedRunId) {
        return [];
      }
      const explicitReceipts = (params.receipts ?? []).map((receipt) =>
        PlatformRuntimeExecutionReceiptSchema.parse({
          ...receipt,
          ...(normalizeReasons(receipt.reasons)
            ? { reasons: normalizeReasons(receipt.reasons) }
            : {}),
        }),
      );
      const actionIds = new Set(params.outcome?.actionIds ?? []);
      const actionReceipts = Array.from(actions.values())
        .filter((action) => action.runId === normalizedRunId)
        .filter((action) => actionIds.size === 0 || actionIds.has(action.actionId))
        .map((action) => buildExecutionReceiptFromAction(action))
        .filter((receipt): receipt is PlatformRuntimeExecutionReceipt => Boolean(receipt));
      return [...explicitReceipts, ...actionReceipts]
        .toSorted((left, right) =>
          buildExecutionReceiptKey(left).localeCompare(buildExecutionReceiptKey(right)),
        )
        .filter((receipt, index, all) => {
          if (index === 0) {
            return true;
          }
          return buildExecutionReceiptKey(receipt) !== buildExecutionReceiptKey(all[index - 1]);
        });
    },
    verifyExecutionContract(params) {
      const contract = PlatformRuntimeExecutionContractSchema.parse(params.contract);
      const receipts = contract.receipts.map((receipt) =>
        PlatformRuntimeExecutionReceiptSchema.parse({
          ...receipt,
          ...(normalizeReasons(receipt.reasons)
            ? { reasons: normalizeReasons(receipt.reasons) }
            : {}),
        }),
      );
      const evidence = params.evidence ?? {};
      const counts = buildExecutionReceiptCounts(receipts);
      const proofCounts = buildExecutionReceiptProofCounts(receipts);
      const reasons: string[] = [];
      const expectations = contract.expectations;
      const hasBlockedNoProgress = receipts.some((receipt) => receipt.status === "blocked");
      const hasFailedReceipt = counts.failed > 0;
      const hasDegradedReceipt = counts.degraded > 0;
      const hasPartialReceipt = counts.partial > 0;
      const hasWarningReceipt = counts.warning > 0;
      const missingReceiptKinds = Array.from(
        new Set(
          (expectations?.requiredReceiptKinds ?? []).filter(
            (kind) =>
              !receipts.some((receipt) => receipt.kind === kind && receipt.proof === "verified"),
          ),
        ),
      );
      const allowStandaloneEvidence = expectations?.allowStandaloneEvidence === true;
      const confirmedDeliveryCount =
        evidence.confirmedDeliveryCount ?? evidence.deliveredReplyCount ?? 0;
      const hasOutput = evidence.hasOutput === true || evidence.hasStructuredReplyPayload === true;
      const confirmedActionCount =
        evidence.confirmedActionCount ?? params.outcome?.confirmedActionIds.length ?? 0;
      const hasStandaloneOutcomeEvidence =
        hasOutput ||
        confirmedDeliveryCount > 0 ||
        confirmedActionCount > 0 ||
        (params.outcome?.artifactIds.length ?? 0) > 0 ||
        (params.outcome?.bootstrapRequestIds.length ?? 0) > 0 ||
        (evidence.successfulCronAdds ?? 0) > 0;

      if (hasBlockedNoProgress) {
        reasons.push("Execution receipts show no_progress on one or more tool or runtime paths.");
      }
      if (hasFailedReceipt) {
        reasons.push("Execution receipts contain a failed outcome.");
      }
      if (expectations?.requiresMessagingDelivery && confirmedDeliveryCount === 0) {
        reasons.push(
          "Execution contract expected confirmed delivery, but no delivery receipt was verified.",
        );
      }
      if (expectations?.requiresOutput && !hasOutput) {
        reasons.push("Execution contract expected output, but no output evidence was observed.");
      }
      if (expectations?.requiresConfirmedAction && confirmedActionCount === 0) {
        reasons.push(
          "Execution contract expected a confirmed runtime action, but none was observed.",
        );
      }
      if (expectations?.requireStructuredReceipts && proofCounts.derived === receipts.length) {
        reasons.push(
          "Execution contract required structured receipts, but only derived or fallback receipts were available.",
        );
      }
      if (
        (expectations?.minimumVerifiedReceiptCount ?? 0) > 0 &&
        proofCounts.verified < (expectations?.minimumVerifiedReceiptCount ?? 0)
      ) {
        reasons.push(
          `Execution contract expected at least ${String(
            expectations?.minimumVerifiedReceiptCount ?? 0,
          )} verified receipt(s), but only ${String(proofCounts.verified)} were observed.`,
        );
      }
      if (missingReceiptKinds.length > 0) {
        reasons.push(
          `Execution contract is missing verified receipt kind(s): ${missingReceiptKinds.join(", ")}.`,
        );
      }

      let status: PlatformRuntimeExecutionVerification["status"] = "verified";
      if (hasBlockedNoProgress) {
        status = "no_progress";
      } else if (hasFailedReceipt || reasons.length > 0) {
        status = "mismatch";
      } else if (hasDegradedReceipt) {
        status = "degraded";
        reasons.push("Execution completed in a degraded state.");
      } else if (hasPartialReceipt) {
        status = expectations?.allowPartial ? "warning" : "mismatch";
        reasons.push(
          expectations?.allowPartial
            ? "Execution completed partially but the contract allows partial receipts."
            : "Execution contract was only partially satisfied.",
        );
      } else if (hasWarningReceipt) {
        status = expectations?.allowWarnings ? "warning" : "mismatch";
        reasons.push(
          expectations?.allowWarnings
            ? "Execution completed with warnings allowed by the contract."
            : "Execution receipts contain warnings that the contract does not allow.",
        );
      } else if (receipts.length === 0) {
        if (hasStandaloneOutcomeEvidence && allowStandaloneEvidence) {
          status = "verified";
          reasons.push(
            "Execution closed on standalone output or delivery evidence without explicit receipts.",
          );
        } else {
          status = "mismatch";
          reasons.push(
            allowStandaloneEvidence
              ? "Execution contract verification had no receipts to verify."
              : "Execution contract requires receipts and cannot close on standalone evidence alone.",
          );
        }
      } else if (proofCounts.verified === 0 && proofCounts.reported === 0) {
        if (allowStandaloneEvidence && hasStandaloneOutcomeEvidence) {
          status = "warning";
          reasons.push(
            "Execution relied on derived receipts plus standalone evidence instead of verified runtime receipts.",
          );
        } else {
          status = "mismatch";
          reasons.push(
            "Execution receipts were only derived and cannot verify closure on their own.",
          );
        }
      }

      return PlatformRuntimeExecutionVerificationSchema.parse({
        runId: contract.runId,
        status,
        reasons: Array.from(new Set(reasons)),
        receipts,
        receiptCounts: counts,
        receiptProofCounts: proofCounts,
        ...(missingReceiptKinds.length > 0 ? { missingReceiptKinds } : {}),
        ...(receipts.length === 0 && hasStandaloneOutcomeEvidence && allowStandaloneEvidence
          ? { usedStandaloneEvidence: true }
          : {}),
        checkedAtMs: contract.checkedAtMs ?? Date.now(),
      });
    },
    evaluateAcceptance(params) {
      const evidence = this.buildAcceptanceEvidence({
        outcome: params.outcome,
        evidence: params.evidence,
      });
      const reasons: string[] = [];
      if (params.outcome.pendingApprovalIds.length > 0) {
        reasons.push("Run still requires operator approval before the task can finish.");
        return parseAcceptanceResult({
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
        return parseAcceptanceResult({
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
        return parseAcceptanceResult({
          runId: params.runId,
          status: "failed",
          action: "stop",
          reasonCode:
            classifyProviderEvidence(evidence) === "auth_refresh"
              ? "provider_auth_required"
              : classifyProviderEvidence(evidence) === "provider_fallback"
                ? "provider_fallback_exhausted"
                : "runtime_failed",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      if (evidence.noProgressSignals && evidence.noProgressSignals > 0) {
        reasons.push("Run hit a bounded no-progress path and needs supervisor recovery.");
        return parseAcceptanceResult({
          runId: params.runId,
          status: "retryable",
          action: "retry",
          reasonCode: "execution_no_progress",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      if (evidence.executionContractMismatch === true) {
        reasons.push(
          "Run completed, but the verified execution contract does not match the requested outcome.",
        );
        return parseAcceptanceResult({
          runId: params.runId,
          status: "retryable",
          action: "retry",
          reasonCode:
            evidence.executionSurfaceStatus === "bootstrap_required" ||
            evidence.executionUnattendedBoundary === "bootstrap"
              ? "bootstrap_required"
              : classifyProviderEvidence(evidence) === "auth_refresh"
                ? "provider_auth_required"
                : classifyProviderEvidence(evidence) === "provider_fallback"
                  ? "provider_fallback_exhausted"
                  : "contract_mismatch",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      if (
        (evidence.degradedExecutionCount ?? 0) > 0 ||
        evidence.executionSurfaceDegraded === true
      ) {
        reasons.push("Run completed, but execution truth remained degraded.");
        return parseAcceptanceResult({
          runId: params.runId,
          status: "partial",
          action: "retry",
          reasonCode:
            evidence.executionSurfaceStatus === "bootstrap_required" ||
            evidence.executionUnattendedBoundary === "bootstrap"
              ? "bootstrap_required"
              : classifyProviderEvidence(evidence) === "auth_refresh"
                ? "provider_auth_required"
                : classifyProviderEvidence(evidence) === "provider_fallback"
                  ? "provider_fallback_exhausted"
                  : "execution_degraded",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      if (params.outcome.status === "partial") {
        reasons.push("Run finished with only a partial runtime outcome.");
        return parseAcceptanceResult({
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
        return parseAcceptanceResult({
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
        return parseAcceptanceResult({
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
      const requiresVerifiedNonMessagingClosure =
        attemptedDeliveryCount === 0 &&
        confirmedDeliveryCount === 0 &&
        ((evidence.artifactReceiptCount ?? params.outcome.artifactIds.length) > 0 ||
          (evidence.bootstrapReceiptCount ?? params.outcome.bootstrapRequestIds.length) > 0 ||
          attemptedActionCount > 0 ||
          confirmedActionCount > 0 ||
          failedActionCount > 0);
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
        return parseAcceptanceResult({
          runId: params.runId,
          status: "retryable",
          action: "retry",
          reasonCode: "completed_without_evidence",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      if (
        requiresVerifiedNonMessagingClosure &&
        (evidence.verifiedExecutionReceiptCount ?? 0) === 0
      ) {
        reasons.push(
          "Run completed on a non-messaging execution path, but no verified structured receipt proved the final closure.",
        );
        return parseAcceptanceResult({
          runId: params.runId,
          status: "retryable",
          action: "retry",
          reasonCode:
            evidence.executionSurfaceStatus === "bootstrap_required" ||
            evidence.executionUnattendedBoundary === "bootstrap"
              ? "bootstrap_required"
              : classifyProviderEvidence(evidence) === "auth_refresh"
                ? "provider_auth_required"
                : classifyProviderEvidence(evidence) === "provider_fallback"
                  ? "provider_fallback_exhausted"
                  : "contract_mismatch",
          reasons,
          outcome: params.outcome,
          evidence,
        });
      }
      if (evidence.hadToolError === true && hasDeliverableEvidence) {
        reasons.push(
          "Run completed with deliverable evidence, but one or more tool errors were observed.",
        );
        return parseAcceptanceResult({
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
        return parseAcceptanceResult({
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
        return parseAcceptanceResult({
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
        return parseAcceptanceResult({
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
      return parseAcceptanceResult({
        runId: params.runId,
        status: "retryable",
        action: "retry",
        reasonCode: "completed_without_evidence",
        reasons,
        outcome: params.outcome,
        evidence,
      });
    },
    evaluateSupervisorVerdict(params) {
      if (params.surface) {
        PlatformRuntimeExecutionSurfaceSchema.parse(params.surface);
      }
      const acceptance = params.acceptance;
      const verification = params.verification;
      const reasons: string[] = [];
      if (acceptance?.status === "needs_human") {
        return parseSupervisorVerdict({
          runId: params.runId,
          status: "needs_human",
          action: "escalate",
          reasonCode: "needs_human",
          reasons: acceptance.reasons,
          acceptance,
          verification,
          surface: params.surface,
        });
      }
      if (acceptance?.status === "failed") {
        return parseSupervisorVerdict({
          runId: params.runId,
          status: "failed",
          action: "stop",
          reasonCode: resolveSupervisorReasonCode({
            acceptance,
            verification,
            surface: params.surface,
            fallbackReasonCode: "runtime_failed",
          }),
          reasons: acceptance.reasons,
          acceptance,
          verification,
          surface: params.surface,
        });
      }
      if (verification?.status === "no_progress") {
        reasons.push(...verification.reasons);
        return parseSupervisorVerdict({
          runId: params.runId,
          status: "retryable",
          action: "retry",
          reasonCode: resolveSupervisorReasonCode({
            acceptance,
            verification,
            surface: params.surface,
            fallbackReasonCode: "execution_no_progress",
          }),
          reasons: Array.from(new Set(reasons)),
          acceptance,
          verification,
          surface: params.surface,
        });
      }
      if (verification?.status === "mismatch" || verification?.status === "failed") {
        reasons.push(...verification.reasons);
        return parseSupervisorVerdict({
          runId: params.runId,
          status: acceptance?.status ?? "retryable",
          action: acceptance?.action === "escalate" ? "escalate" : "retry",
          reasonCode: resolveSupervisorReasonCode({
            acceptance,
            verification,
            surface: params.surface,
            fallbackReasonCode: "contract_mismatch",
          }),
          reasons: Array.from(new Set(reasons)),
          acceptance,
          verification,
          surface: params.surface,
        });
      }
      if (
        verification?.status === "degraded" ||
        params.surface?.status === "degraded" ||
        params.surface?.status === "unavailable"
      ) {
        reasons.push(...(verification?.reasons ?? []));
        reasons.push(...(params.surface?.reasons ?? []));
        return parseSupervisorVerdict({
          runId: params.runId,
          status: "retryable",
          action: acceptance?.action === "escalate" ? "escalate" : "retry",
          reasonCode: resolveSupervisorReasonCode({
            acceptance,
            verification,
            surface: params.surface,
            fallbackReasonCode: "execution_degraded",
          }),
          reasons: Array.from(new Set(reasons)),
          acceptance,
          verification,
          surface: params.surface,
        });
      }
      return parseSupervisorVerdict({
        runId: params.runId,
        status: acceptance?.status ?? "satisfied",
        action: acceptance?.action ?? "close",
        reasonCode: resolveSupervisorReasonCode({
          acceptance,
          verification,
          surface: params.surface,
          fallbackReasonCode:
            acceptance && acceptance.action !== "close"
              ? "transient_recoverable"
              : "verified_execution",
        }),
        reasons: acceptance?.reasons ??
          verification?.reasons ?? ["Execution contract was verified before final closure."],
        acceptance,
        verification,
        surface: params.surface,
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
