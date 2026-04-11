import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type { ModelFallbackSummary } from "../../agents/model-fallback.types.js";
import { loadSessionStore } from "../../config/sessions.js";
import { isAudioFileName } from "../../media/mime.js";
import {
  getPlatformRuntimeCheckpointService,
  PlatformRuntimeRunOutcomeSchema,
  type PlatformRuntimeAcceptanceEvidence,
  type PlatformRuntimeAcceptanceResult,
  type PlatformRuntimeExecutionIntent,
  type PlatformRuntimeExecutionSurface,
  type PlatformRuntimeExecutionVerification,
  type PlatformRuntimeRunOutcome,
  type PlatformRuntimeRunClosure,
  type PlatformRuntimeSupervisorVerdict,
} from "../../platform/runtime/index.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { normalizeVerboseLevel, type VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import { dispatchMessagingClosureOutcome } from "./closure-outcome-dispatcher.js";
import { scheduleFollowupDrain, type FollowupRun, type QueueSettings } from "./queue.js";
import type { TypingSignaler } from "./typing-mode.js";

export {
  enqueueSemanticRetryFollowup,
  finalizeClosureRecoveryCheckpoint,
  markClosureRecoveryCheckpointFailed,
} from "./closure-outcome-dispatcher.js";

const hasAudioMedia = (urls?: string[]): boolean =>
  Boolean(urls?.some((url) => isAudioFileName(url)));

export const isAudioPayload = (payload: ReplyPayload): boolean =>
  hasAudioMedia(resolveSendableOutboundReplyParts(payload).mediaUrls);

type VerboseGateParams = {
  sessionKey?: string;
  storePath?: string;
  resolvedVerboseLevel: VerboseLevel;
};

function resolveCurrentVerboseLevel(params: VerboseGateParams): VerboseLevel | undefined {
  if (!params.sessionKey || !params.storePath) {
    return undefined;
  }
  try {
    const store = loadSessionStore(params.storePath);
    const entry = store[params.sessionKey];
    return normalizeVerboseLevel(String(entry?.verboseLevel ?? ""));
  } catch {
    // ignore store read failures
    return undefined;
  }
}

function createVerboseGate(
  params: VerboseGateParams,
  shouldEmit: (level: VerboseLevel) => boolean,
): () => boolean {
  // Normalize verbose values from session store/config so false/"false" still means off.
  const fallbackVerbose = normalizeVerboseLevel(String(params.resolvedVerboseLevel ?? "")) ?? "off";
  return () => {
    return shouldEmit(resolveCurrentVerboseLevel(params) ?? fallbackVerbose);
  };
}

export const createShouldEmitToolResult = (params: VerboseGateParams): (() => boolean) => {
  return createVerboseGate(params, (level) => level !== "off");
};

export const createShouldEmitToolOutput = (params: VerboseGateParams): (() => boolean) => {
  return createVerboseGate(params, (level) => level === "full");
};

export const finalizeWithFollowup = <T>(
  value: T,
  queueKey: string,
  runFollowupTurn: Parameters<typeof scheduleFollowupDrain>[1],
): T => {
  scheduleFollowupDrain(queueKey, runFollowupTurn);
  return value;
};

export type MessagingDeliveryReceipt = {
  stagedReplyCount: number;
  attemptedDeliveryCount: number;
  confirmedDeliveryCount: number;
  failedDeliveryCount: number;
  partialDelivery: boolean;
};

type CompletionOutcome = PlatformRuntimeRunOutcome & {
  hadToolError?: boolean;
  deterministicApprovalPromptSent?: boolean;
};

function mergeCompletionOutcomeWithRuntimeOutcome(params: {
  completionOutcome: CompletionOutcome;
  runtimeOutcome?: PlatformRuntimeRunOutcome;
}): PlatformRuntimeRunOutcome {
  const completionOutcome = params.completionOutcome;
  const baseOutcome = PlatformRuntimeRunOutcomeSchema.parse({
    runId: completionOutcome?.runId ?? "",
    status: completionOutcome?.status ?? "partial",
    checkpointIds: completionOutcome?.checkpointIds ?? [],
    blockedCheckpointIds: completionOutcome?.blockedCheckpointIds ?? [],
    completedCheckpointIds: completionOutcome?.completedCheckpointIds ?? [],
    deniedCheckpointIds: completionOutcome?.deniedCheckpointIds ?? [],
    pendingApprovalIds: completionOutcome?.pendingApprovalIds ?? [],
    artifactIds: completionOutcome?.artifactIds ?? [],
    bootstrapRequestIds: completionOutcome?.bootstrapRequestIds ?? [],
    actionIds: completionOutcome?.actionIds ?? [],
    attemptedActionIds: completionOutcome?.attemptedActionIds ?? [],
    confirmedActionIds: completionOutcome?.confirmedActionIds ?? [],
    failedActionIds: completionOutcome?.failedActionIds ?? [],
    boundaries: completionOutcome?.boundaries ?? [],
  });
  const runtimeOutcome = params.runtimeOutcome;
  if (!runtimeOutcome) {
    return baseOutcome;
  }
  const status =
    baseOutcome.status === "blocked" || runtimeOutcome.status === "blocked"
      ? "blocked"
      : baseOutcome.status === "failed" || runtimeOutcome.status === "failed"
        ? "failed"
        : baseOutcome.status === "completed" || runtimeOutcome.status === "completed"
          ? "completed"
          : "partial";
  return PlatformRuntimeRunOutcomeSchema.parse({
    runId: baseOutcome.runId,
    status,
    checkpointIds: Array.from(
      new Set([...baseOutcome.checkpointIds, ...runtimeOutcome.checkpointIds]),
    ),
    blockedCheckpointIds: Array.from(
      new Set([...baseOutcome.blockedCheckpointIds, ...runtimeOutcome.blockedCheckpointIds]),
    ),
    completedCheckpointIds: Array.from(
      new Set([...baseOutcome.completedCheckpointIds, ...runtimeOutcome.completedCheckpointIds]),
    ),
    deniedCheckpointIds: Array.from(
      new Set([...baseOutcome.deniedCheckpointIds, ...runtimeOutcome.deniedCheckpointIds]),
    ),
    pendingApprovalIds: Array.from(
      new Set([...baseOutcome.pendingApprovalIds, ...runtimeOutcome.pendingApprovalIds]),
    ),
    artifactIds: Array.from(new Set([...baseOutcome.artifactIds, ...runtimeOutcome.artifactIds])),
    bootstrapRequestIds: Array.from(
      new Set([...baseOutcome.bootstrapRequestIds, ...runtimeOutcome.bootstrapRequestIds]),
    ),
    actionIds: Array.from(new Set([...baseOutcome.actionIds, ...runtimeOutcome.actionIds])),
    attemptedActionIds: Array.from(
      new Set([...baseOutcome.attemptedActionIds, ...runtimeOutcome.attemptedActionIds]),
    ),
    confirmedActionIds: Array.from(
      new Set([...baseOutcome.confirmedActionIds, ...runtimeOutcome.confirmedActionIds]),
    ),
    failedActionIds: Array.from(
      new Set([...baseOutcome.failedActionIds, ...runtimeOutcome.failedActionIds]),
    ),
    boundaries: Array.from(new Set([...baseOutcome.boundaries, ...runtimeOutcome.boundaries])),
  });
}

type MessagingDeliveryReceiptInput = Partial<MessagingDeliveryReceipt> | undefined;

function hasVerifiedMessagingDeliveryReceipt(
  receipts: PlatformRuntimeExecutionVerification["receipts"] | undefined,
): boolean {
  return Boolean(
    receipts?.some((receipt) => receipt.kind === "messaging_delivery" && receipt.proof === "verified"),
  );
}

function shouldDropAdvisoryReadFailure(params: {
  receipt: PlatformRuntimeExecutionVerification["receipts"][number];
  receipts: PlatformRuntimeExecutionVerification["receipts"];
  confirmedDeliveryCount: number;
}): boolean {
  if (params.confirmedDeliveryCount === 0) {
    return false;
  }
  if (
    params.receipt.kind !== "tool" ||
    params.receipt.name !== "read" ||
    params.receipt.status !== "failed"
  ) {
    return false;
  }
  return params.receipts.some(
    (candidate) =>
      candidate.kind === "tool" && candidate.name === "read" && candidate.status === "success",
  );
}

function normalizeMessagingClosureReceipts(params: {
  receipts: PlatformRuntimeExecutionVerification["receipts"] | undefined;
  deliveryReceipt?: Partial<MessagingDeliveryReceipt>;
}): PlatformRuntimeExecutionVerification["receipts"] {
  const confirmedDeliveryCount = Math.max(params.deliveryReceipt?.confirmedDeliveryCount ?? 0, 0);
  const receipts = (params.receipts ?? []).filter(
    (receipt) =>
      !shouldDropAdvisoryReadFailure({
        receipt,
        receipts: params.receipts ?? [],
        confirmedDeliveryCount,
      }),
  );
  if (confirmedDeliveryCount > 0 && !hasVerifiedMessagingDeliveryReceipt(receipts)) {
    receipts.push({
      kind: "messaging_delivery",
      name: "delivery.webchat",
      status: "success",
      proof: "verified",
      summary: "confirmed by reply dispatcher",
    });
  }
  return receipts;
}

export type MessagingDeliveryClosureCandidate = {
  runResult: {
    meta?: {
      completionOutcome?: PlatformRuntimeRunOutcome & {
        hadToolError?: boolean;
        deterministicApprovalPromptSent?: boolean;
      };
      executionIntent?: PlatformRuntimeExecutionIntent;
      executionVerification?: PlatformRuntimeExecutionVerification;
      executionSurface?: PlatformRuntimeExecutionSurface;
      acceptanceOutcome?: PlatformRuntimeAcceptanceResult;
      supervisorVerdict?: PlatformRuntimeSupervisorVerdict;
      runClosure?: PlatformRuntimeRunClosure;
      modelFallback?: ModelFallbackSummary;
    };
    didSendViaMessagingTool?: boolean;
    successfulCronAdds?: number;
  };
  sourceRun: FollowupRun;
  queueKey?: string;
  settings: QueueSettings;
};

type MessagingClosureDecision = PlatformRuntimeAcceptanceResult | PlatformRuntimeSupervisorVerdict;

type MessagingClosurePresentation = {
  title: string;
  text: string;
  details: string[];
  isError?: boolean;
};

const STRUCTURED_CLOSURE_CHANNELS = new Set(["discord", "slack"]);

function hasStructuredReplyPayload(payload: ReplyPayload): boolean {
  const parts = resolveSendableOutboundReplyParts(payload);
  return (
    parts.mediaUrls.length > 0 ||
    (payload.interactive?.blocks?.length ?? 0) > 0 ||
    Object.keys(payload.channelData ?? {}).length > 0
  );
}

function isDeliverableReplyPayload(payload: ReplyPayload): boolean {
  return hasOutboundReplyContent(payload, { trimText: true }) || hasStructuredReplyPayload(payload);
}

export function countDeliverableReplyPayloads(payloads: ReplyPayload[] | undefined): number {
  return (payloads ?? []).filter(isDeliverableReplyPayload).length;
}

export function buildMessagingDeliveryReceipt(params: {
  stagedReplyPayloads?: ReplyPayload[];
  attemptedDeliveries?: number;
  confirmedDeliveries?: number;
  failedDeliveries?: number;
}): MessagingDeliveryReceipt {
  const stagedReplyCount = (params.stagedReplyPayloads ?? []).filter(
    isDeliverableReplyPayload,
  ).length;
  const attemptedDeliveryCount = Math.max(params.attemptedDeliveries ?? 0, 0);
  const confirmedDeliveryCount = Math.max(params.confirmedDeliveries ?? 0, 0);
  const failedDeliveryCount = Math.max(params.failedDeliveries ?? 0, 0);
  return {
    stagedReplyCount,
    attemptedDeliveryCount,
    confirmedDeliveryCount,
    failedDeliveryCount,
    partialDelivery: confirmedDeliveryCount > 0 && failedDeliveryCount > 0,
  };
}

export function buildCanonicalMessagingDeliveryReceipt(params: {
  replyPayloads?: ReplyPayload[];
  receipts?: MessagingDeliveryReceiptInput[];
}): MessagingDeliveryReceipt {
  const receipts = params.receipts ?? [];
  const stagedReplyCount =
    params.replyPayloads !== undefined
      ? countDeliverableReplyPayloads(params.replyPayloads)
      : receipts.reduce(
          (max, receipt) => Math.max(max, Math.max(receipt?.stagedReplyCount ?? 0, 0)),
          0,
        );
  const attemptedDeliveryCount = receipts.reduce(
    (sum, receipt) => sum + Math.max(receipt?.attemptedDeliveryCount ?? 0, 0),
    0,
  );
  const confirmedDeliveryCount = receipts.reduce(
    (sum, receipt) => sum + Math.max(receipt?.confirmedDeliveryCount ?? 0, 0),
    0,
  );
  const failedDeliveryCount = receipts.reduce(
    (sum, receipt) => sum + Math.max(receipt?.failedDeliveryCount ?? 0, 0),
    0,
  );
  return {
    stagedReplyCount,
    attemptedDeliveryCount,
    confirmedDeliveryCount,
    failedDeliveryCount,
    partialDelivery: confirmedDeliveryCount > 0 && failedDeliveryCount > 0,
  };
}

export function buildMessagingAcceptanceEvidence(params: {
  runResult: MessagingDeliveryClosureCandidate["runResult"];
  replyPayloads?: ReplyPayload[];
  runPayloadsForEvidence?: ReplyPayload[];
  deliveryReceipt?: Partial<MessagingDeliveryReceipt>;
  recoveryAttemptCount?: number;
}): PlatformRuntimeAcceptanceEvidence {
  const evidencePayloads = [
    ...(params.runPayloadsForEvidence ?? []),
    ...(params.replyPayloads ?? []),
  ];
  const deliveryReceipt = buildCanonicalMessagingDeliveryReceipt({
    replyPayloads: evidencePayloads,
    receipts: [params.deliveryReceipt],
  });
  return {
    ...(params.runResult.meta?.completionOutcome?.hadToolError !== undefined
      ? { hadToolError: params.runResult.meta.completionOutcome.hadToolError }
      : {}),
    ...(params.runResult.meta?.completionOutcome?.deterministicApprovalPromptSent !== undefined
      ? {
          deterministicApprovalPromptSent:
            params.runResult.meta.completionOutcome.deterministicApprovalPromptSent,
        }
      : {}),
    ...(params.runResult.didSendViaMessagingTool !== undefined
      ? { didSendViaMessagingTool: params.runResult.didSendViaMessagingTool }
      : {}),
    hasOutput: evidencePayloads.some(isDeliverableReplyPayload),
    hasStructuredReplyPayload: evidencePayloads.some(hasStructuredReplyPayload),
    deliveredReplyCount: deliveryReceipt.confirmedDeliveryCount,
    stagedReplyCount: deliveryReceipt.stagedReplyCount,
    attemptedDeliveryCount: deliveryReceipt.attemptedDeliveryCount,
    confirmedDeliveryCount: deliveryReceipt.confirmedDeliveryCount,
    failedDeliveryCount: deliveryReceipt.failedDeliveryCount,
    partialDelivery: deliveryReceipt.partialDelivery,
    ...(params.runResult.meta?.modelFallback
      ? {
          modelFallbackAttemptCount: params.runResult.meta.modelFallback.attemptCount,
          modelFallbackExhausted: params.runResult.meta.modelFallback.exhausted,
          ...(params.runResult.meta.modelFallback.finalReason
            ? { modelFallbackFinalReason: params.runResult.meta.modelFallback.finalReason }
            : {}),
          ...(params.runResult.meta.modelFallback.finalStatus !== undefined
            ? { modelFallbackFinalStatus: params.runResult.meta.modelFallback.finalStatus }
            : {}),
          ...(params.runResult.meta.modelFallback.finalCode
            ? { modelFallbackFinalCode: params.runResult.meta.modelFallback.finalCode }
            : {}),
          providerAuthFailed: params.runResult.meta.modelFallback.finalReason === "auth",
          providerRateLimited:
            params.runResult.meta.modelFallback.finalReason === "rate_limit" ||
            params.runResult.meta.modelFallback.finalReason === "overloaded",
          providerModelNotFound:
            params.runResult.meta.modelFallback.finalReason === "model_not_found",
        }
      : {}),
    ...(params.runResult.successfulCronAdds !== undefined
      ? { successfulCronAdds: params.runResult.successfulCronAdds }
      : {}),
    ...(params.recoveryAttemptCount !== undefined
      ? { recoveryAttemptCount: params.recoveryAttemptCount }
      : {}),
  };
}

function reevaluateMessagingDecision(params: {
  runResult: MessagingDeliveryClosureCandidate["runResult"];
  replyPayloads: ReplyPayload[];
  runPayloadsForEvidence?: ReplyPayload[];
  deliveryReceipt?: Partial<MessagingDeliveryReceipt>;
  recoveryAttemptCount?: number;
  sourceRun?: FollowupRun;
}):
  | {
      runClosure?: PlatformRuntimeRunClosure;
      acceptanceOutcome?: PlatformRuntimeAcceptanceResult;
      executionVerification?: PlatformRuntimeExecutionVerification;
      supervisorVerdict?: PlatformRuntimeSupervisorVerdict;
    }
  | undefined {
  const completionOutcome = params.runResult.meta?.completionOutcome;
  if (!completionOutcome?.runId) {
    return {
      acceptanceOutcome: params.runResult.meta?.acceptanceOutcome,
      executionVerification: params.runResult.meta?.executionVerification,
      supervisorVerdict: params.runResult.meta?.supervisorVerdict,
    };
  }
  const runtimeService = getPlatformRuntimeCheckpointService();
  const outcome = mergeCompletionOutcomeWithRuntimeOutcome({
    completionOutcome,
    runtimeOutcome: runtimeService.buildRunOutcome(completionOutcome.runId),
  });
  const normalizedReceipts = normalizeMessagingClosureReceipts({
    receipts: params.runResult.meta?.executionVerification?.receipts,
    deliveryReceipt: params.deliveryReceipt,
  });
  const baseEvidence = buildMessagingAcceptanceEvidence({
    runResult: params.runResult,
    replyPayloads: params.replyPayloads,
    runPayloadsForEvidence: params.runPayloadsForEvidence,
    deliveryReceipt: params.deliveryReceipt,
    recoveryAttemptCount: params.recoveryAttemptCount,
  });
  const runClosure = runtimeService.buildRunClosure({
    runId: outcome.runId,
    requestRunId: params.sourceRun?.requestRunId ?? outcome.runId,
    ...(params.sourceRun?.parentRunId ? { parentRunId: params.sourceRun.parentRunId } : {}),
    outcome,
    receipts: normalizedReceipts,
    evidence: baseEvidence,
    executionSurface: params.runResult.meta?.executionSurface,
    executionIntent: params.runResult.meta?.executionIntent,
  });
  runtimeService.recordRunClosure(runClosure);
  return {
    runClosure,
    acceptanceOutcome: runClosure.acceptanceOutcome,
    executionVerification: runClosure.executionVerification,
    supervisorVerdict: runClosure.supervisorVerdict,
  };
}

export function reevaluateMessagingDecisionForMessagingRun(params: {
  runResult: MessagingDeliveryClosureCandidate["runResult"];
  replyPayloads: ReplyPayload[];
  runPayloadsForEvidence?: ReplyPayload[];
  deliveryReceipt?: Partial<MessagingDeliveryReceipt>;
  recoveryAttemptCount?: number;
  sourceRun?: FollowupRun;
}):
  | {
      runClosure?: PlatformRuntimeRunClosure;
      acceptanceOutcome?: PlatformRuntimeAcceptanceResult;
      executionVerification?: PlatformRuntimeExecutionVerification;
      supervisorVerdict?: PlatformRuntimeSupervisorVerdict;
    }
  | undefined {
  return reevaluateMessagingDecision(params);
}

export function reevaluateAcceptanceForMessagingRun(params: {
  runResult: MessagingDeliveryClosureCandidate["runResult"];
  replyPayloads: ReplyPayload[];
  runPayloadsForEvidence?: ReplyPayload[];
  deliveryReceipt?: Partial<MessagingDeliveryReceipt>;
  recoveryAttemptCount?: number;
  sourceRun?: FollowupRun;
}): PlatformRuntimeAcceptanceResult | undefined {
  return reevaluateMessagingDecision(params)?.acceptanceOutcome;
}

function resolveMessagingClosureDecision(params: {
  acceptance: PlatformRuntimeAcceptanceResult | undefined;
  supervisorVerdict?: PlatformRuntimeSupervisorVerdict;
}): MessagingClosureDecision | undefined {
  // Supervisor verdict is the final closure truth when present, so user-facing
  // fallback copy should align with the same decision used by durable summaries.
  return params.supervisorVerdict ?? params.acceptance;
}

function shouldAttachStructuredClosurePresentation(channel?: string): boolean {
  const normalized = normalizeMessageChannel(channel);
  return normalized ? STRUCTURED_CLOSURE_CHANNELS.has(normalized) : false;
}

function resolveMessagingClosureTitle(decision: MessagingClosureDecision): string {
  if (decision.recoveryPolicy.exhausted) {
    return decision.recoveryPolicy.exhaustedAction === "escalate"
      ? "Human intervention required"
      : "Automatic recovery exhausted";
  }
  if (decision.remediation === "bootstrap") {
    return "Task paused for capability install";
  }
  if (decision.remediation === "auth_refresh") {
    return "Authentication attention required";
  }
  if (decision.remediation === "provider_fallback") {
    return "Alternate runtime path required";
  }
  if (decision.action === "retry") {
    return "Automatic recovery continuing";
  }
  if (decision.action === "escalate") {
    return "Approval or input required";
  }
  if (decision.action === "stop") {
    return "Task could not be completed";
  }
  return "Task needs additional handling";
}

function resolveMessagingClosureNextStep(decision: MessagingClosureDecision): string | undefined {
  if (decision.recoveryPolicy.exhausted) {
    return decision.recoveryPolicy.exhaustedAction === "escalate"
      ? "Waiting for human intervention before continuing."
      : "No further automatic recovery will be attempted.";
  }
  if (decision.remediation === "bootstrap") {
    return "Approve the capability in Control UI → Bootstrap, run the installer, then the paused task resumes automatically.";
  }
  if (decision.remediation === "auth_refresh") {
    return "Provider authentication must be refreshed before retrying.";
  }
  if (decision.remediation === "provider_fallback") {
    return "A different provider or model path is needed before retrying.";
  }
  if (decision.action === "retry") {
    return "One more automatic pass is required to finish reliably.";
  }
  if (decision.action === "escalate") {
    return "Waiting for human approval or guidance before continuing.";
  }
  if (decision.action === "stop") {
    return "The task has stopped without another automatic retry.";
  }
  return undefined;
}

function buildMessagingClosurePresentation(
  decision: MessagingClosureDecision,
): MessagingClosurePresentation | undefined {
  const reason = decision.reasons[0] ?? "The task needs additional handling.";
  const text = decision.recoveryPolicy.exhausted
    ? decision.recoveryPolicy.exhaustedAction === "escalate"
      ? `I could not finish automatically and now need human intervention. ${reason}`.trim()
      : `I exhausted the automatic recovery budget and could not complete this task. ${reason}`.trim()
    : decision.remediation === "bootstrap"
      ? `Your task is paused while a capability install is pending. Approve it in Control UI → Bootstrap, run bootstrap, and I will resume this task when the platform allows. ${reason}`.trim()
      : decision.remediation === "auth_refresh"
        ? `I could not finish because provider authentication needs attention. ${reason}`.trim()
        : decision.remediation === "provider_fallback"
          ? `I hit a provider/model execution problem and need a different runtime path before I can finish. ${reason}`.trim()
          : decision.action === "retry"
            ? `Still working on this. I need one more pass to finish reliably. ${reason}`.trim()
            : decision.action === "escalate"
              ? `I need human input or approval before I can finish this. ${reason}`.trim()
              : decision.action === "stop"
                ? `I could not complete this task. ${reason}`.trim()
                : undefined;
  if (!text) {
    return undefined;
  }
  const additionalReasons =
    decision.reasons.length > 1
      ? `Additional details:\n- ${decision.reasons.slice(1).join("\n- ")}`
      : undefined;
  const nextStep = resolveMessagingClosureNextStep(decision);
  return {
    title: resolveMessagingClosureTitle(decision),
    text,
    details: [
      `Reason: ${reason}`,
      ...(additionalReasons ? [additionalReasons] : []),
      ...(nextStep ? [`Next step: ${nextStep}`] : []),
    ],
    isError:
      decision.recoveryPolicy.exhausted ||
      decision.remediation === "auth_refresh" ||
      decision.remediation === "provider_fallback" ||
      decision.action === "escalate" ||
      decision.action === "stop"
        ? true
        : undefined,
  };
}

export function buildMessagingClosurePresentationPayload(params: {
  acceptance: PlatformRuntimeAcceptanceResult | undefined;
  supervisorVerdict?: PlatformRuntimeSupervisorVerdict;
  channel?: string;
}): ReplyPayload | undefined {
  const decision = resolveMessagingClosureDecision(params);
  if (!decision) {
    return undefined;
  }
  const presentation = buildMessagingClosurePresentation(decision);
  if (!presentation) {
    return undefined;
  }
  const blocks = shouldAttachStructuredClosurePresentation(params.channel)
    ? [
        { type: "text" as const, text: presentation.title },
        ...presentation.details.map((text) => ({ type: "text" as const, text })),
      ]
    : undefined;
  return {
    text: presentation.text,
    ...(presentation.isError ? { isError: true } : {}),
    ...(blocks?.length ? { interactive: { blocks } } : {}),
  };
}

export function buildAcceptanceFallbackPayload(
  acceptance: PlatformRuntimeAcceptanceResult | undefined,
  supervisorVerdict?: PlatformRuntimeSupervisorVerdict,
  options?: { channel?: string },
): ReplyPayload | undefined {
  return buildMessagingClosurePresentationPayload({
    acceptance,
    supervisorVerdict,
    channel: options?.channel,
  });
}

export function captureMessagingDeliveryClosureCandidate(params: {
  onCandidate?: (candidate: MessagingDeliveryClosureCandidate) => void;
  runResult: MessagingDeliveryClosureCandidate["runResult"];
  sourceRun: FollowupRun;
  queueKey?: string;
  settings: QueueSettings;
}): void {
  params.onCandidate?.({
    runResult: params.runResult,
    sourceRun: params.sourceRun,
    queueKey: params.queueKey,
    settings: params.settings,
  });
}

export function finalizeMessagingDeliveryClosure(params: {
  candidate: MessagingDeliveryClosureCandidate | undefined;
  replyPayloads: ReplyPayload[];
  deliveryReceipt: Partial<MessagingDeliveryReceipt>;
}): {
  acceptanceOutcome?: PlatformRuntimeAcceptanceResult;
  supervisorVerdict?: PlatformRuntimeSupervisorVerdict;
  queuedSemanticRetry: boolean;
} {
  if (!params.candidate) {
    return { queuedSemanticRetry: false };
  }
  const reevaluated = reevaluateMessagingDecision({
    runResult: params.candidate.runResult,
    replyPayloads: params.replyPayloads,
    deliveryReceipt: params.deliveryReceipt,
    recoveryAttemptCount: params.candidate.sourceRun.automation?.retryCount ?? 0,
  });
  const acceptanceOutcome = reevaluated?.acceptanceOutcome;
  const supervisorVerdict = reevaluated?.supervisorVerdict;
  const dispatched = dispatchMessagingClosureOutcome({
    queueKey: params.candidate.queueKey,
    sourceRun: params.candidate.sourceRun,
    settings: params.candidate.settings,
    acceptance: acceptanceOutcome,
    supervisorVerdict,
    executionIntent: params.candidate.runResult.meta?.executionIntent,
  });
  return {
    acceptanceOutcome,
    supervisorVerdict,
    queuedSemanticRetry: dispatched.queuedSemanticRetry,
  };
}

export const signalTypingIfNeeded = async (
  payloads: ReplyPayload[],
  typingSignals: TypingSignaler,
): Promise<void> => {
  const shouldSignalTyping = payloads.some((payload) =>
    hasOutboundReplyContent(payload, { trimText: true }),
  );
  if (shouldSignalTyping) {
    await typingSignals.signalRunStart();
  }
};
