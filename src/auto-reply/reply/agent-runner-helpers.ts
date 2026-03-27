import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type { ModelFallbackSummary } from "../../agents/model-fallback.types.js";
import { loadSessionStore } from "../../config/sessions.js";
import { isAudioFileName } from "../../media/mime.js";
import {
  getPlatformRuntimeCheckpointService,
  type PlatformRuntimeAcceptanceEvidence,
  type PlatformRuntimeAcceptanceResult,
  type PlatformRuntimeExecutionSurface,
  type PlatformRuntimeExecutionVerification,
  type PlatformRuntimeRunOutcome,
  type PlatformRuntimeSupervisorVerdict,
} from "../../platform/runtime/index.js";
import { normalizeVerboseLevel, type VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import {
  enqueueFollowupRun,
  scheduleFollowupDrain,
  type FollowupRun,
  type QueueSettings,
} from "./queue.js";
import type { TypingSignaler } from "./typing-mode.js";

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

export type MessagingDeliveryClosureCandidate = {
  runResult: {
    meta?: {
      completionOutcome?: PlatformRuntimeRunOutcome & {
        hadToolError?: boolean;
        deterministicApprovalPromptSent?: boolean;
      };
      executionVerification?: PlatformRuntimeExecutionVerification;
      executionSurface?: PlatformRuntimeExecutionSurface;
      acceptanceOutcome?: PlatformRuntimeAcceptanceResult;
      supervisorVerdict?: PlatformRuntimeSupervisorVerdict;
      modelFallback?: ModelFallbackSummary;
    };
    didSendViaMessagingTool?: boolean;
    successfulCronAdds?: number;
  };
  sourceRun: FollowupRun;
  queueKey?: string;
  settings: QueueSettings;
};

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

export function buildMessagingAcceptanceEvidence(params: {
  runResult: MessagingDeliveryClosureCandidate["runResult"];
  replyPayloads?: ReplyPayload[];
  deliveryReceipt?: Partial<MessagingDeliveryReceipt>;
  recoveryAttemptCount?: number;
}): PlatformRuntimeAcceptanceEvidence {
  const deliveryReceipt = buildMessagingDeliveryReceipt({
    stagedReplyPayloads: params.replyPayloads,
    attemptedDeliveries: params.deliveryReceipt?.attemptedDeliveryCount,
    confirmedDeliveries: params.deliveryReceipt?.confirmedDeliveryCount,
    failedDeliveries: params.deliveryReceipt?.failedDeliveryCount,
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
    hasOutput: Boolean(params.replyPayloads?.some((payload) => Boolean(payload.text?.trim()))),
    hasStructuredReplyPayload: Boolean(params.replyPayloads?.some(hasStructuredReplyPayload)),
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
  deliveryReceipt?: Partial<MessagingDeliveryReceipt>;
  recoveryAttemptCount?: number;
}):
  | {
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
  const baseEvidence = buildMessagingAcceptanceEvidence({
    runResult: params.runResult,
    replyPayloads: params.replyPayloads,
    deliveryReceipt: params.deliveryReceipt,
    recoveryAttemptCount: params.recoveryAttemptCount,
  });
  const executionReceipts = runtimeService.buildExecutionReceipts({
    runId: completionOutcome.runId,
    outcome: completionOutcome,
    receipts: params.runResult.meta?.executionVerification?.receipts,
  });
  const executionVerification = runtimeService.verifyExecutionContract({
    contract: {
      runId: completionOutcome.runId,
      receipts: executionReceipts,
      expectations: {
        requiresOutput:
          baseEvidence.hasOutput === true || baseEvidence.hasStructuredReplyPayload === true,
        requiresMessagingDelivery: (baseEvidence.stagedReplyCount ?? 0) > 0,
        requiresConfirmedAction: completionOutcome.actionIds.length > 0,
        requireStructuredReceipts: completionOutcome.actionIds.length > 0,
        minimumVerifiedReceiptCount: completionOutcome.actionIds.length > 0 ? 1 : 0,
        requiredReceiptKinds:
          (baseEvidence.stagedReplyCount ?? 0) > 0 ? ["messaging_delivery"] : undefined,
        allowStandaloneEvidence: false,
        allowWarnings: true,
      },
    },
    outcome: completionOutcome,
    evidence: baseEvidence,
  });
  const evidence = runtimeService.buildAcceptanceEvidence({
    outcome: completionOutcome,
    evidence: baseEvidence,
    executionVerification,
    executionSurface: params.runResult.meta?.executionSurface,
  });
  const acceptanceOutcome = runtimeService.evaluateAcceptance({
    runId: completionOutcome.runId,
    outcome: completionOutcome,
    evidence,
  });
  const supervisorVerdict = runtimeService.evaluateSupervisorVerdict({
    runId: completionOutcome.runId,
    acceptance: acceptanceOutcome,
    verification: executionVerification,
    surface: params.runResult.meta?.executionSurface,
  });
  return { acceptanceOutcome, executionVerification, supervisorVerdict };
}

export function reevaluateAcceptanceForMessagingRun(params: {
  runResult: MessagingDeliveryClosureCandidate["runResult"];
  replyPayloads: ReplyPayload[];
  deliveryReceipt?: Partial<MessagingDeliveryReceipt>;
  recoveryAttemptCount?: number;
}): PlatformRuntimeAcceptanceResult | undefined {
  return reevaluateMessagingDecision(params)?.acceptanceOutcome;
}

export function buildAcceptanceFallbackPayload(
  acceptance: PlatformRuntimeAcceptanceResult | undefined,
): ReplyPayload | undefined {
  if (!acceptance) {
    return undefined;
  }
  const reason = acceptance.reasons[0] ?? "The task needs additional handling.";
  if (acceptance.recoveryPolicy.exhausted) {
    return acceptance.recoveryPolicy.exhaustedAction === "escalate"
      ? {
          text: `I could not finish automatically and now need human intervention. ${reason}`.trim(),
          isError: true,
        }
      : {
          text: `I exhausted the automatic recovery budget and could not complete this task. ${reason}`.trim(),
          isError: true,
        };
  }
  if (acceptance.remediation === "bootstrap") {
    return {
      text: `Still working on this. I need to finish bootstrap recovery before I can complete it. ${reason}`.trim(),
    };
  }
  if (acceptance.remediation === "auth_refresh") {
    return {
      text: `I could not finish because provider authentication needs attention. ${reason}`.trim(),
      isError: true,
    };
  }
  if (acceptance.remediation === "provider_fallback") {
    return {
      text: `I hit a provider/model execution problem and need a different runtime path before I can finish. ${reason}`.trim(),
      isError: true,
    };
  }
  if (acceptance.action === "retry") {
    return {
      text: `Still working on this. I need one more pass to finish reliably. ${reason}`.trim(),
    };
  }
  if (acceptance.action === "escalate") {
    return {
      text: `I need human input or approval before I can finish this. ${reason}`.trim(),
      isError: true,
    };
  }
  if (acceptance.action === "stop") {
    return {
      text: `I could not complete this task. ${reason}`.trim(),
      isError: true,
    };
  }
  return undefined;
}

export function enqueueSemanticRetryFollowup(params: {
  queueKey?: string;
  sourceRun: FollowupRun;
  settings: QueueSettings;
  acceptance: PlatformRuntimeAcceptanceResult | undefined;
  supervisorVerdict?: PlatformRuntimeSupervisorVerdict;
}): boolean {
  const decision = params.supervisorVerdict ?? params.acceptance;
  if (
    !params.queueKey ||
    decision?.action !== "retry" ||
    decision.remediation !== "semantic_retry" ||
    decision.recoveryPolicy.exhausted
  ) {
    return false;
  }
  const retryCount = params.sourceRun.automation?.retryCount ?? 0;
  const prompt = [
    "The previous run did not satisfy the task well enough.",
    decision.reasons.length > 0 ? `Observed issues: ${decision.reasons.join(" ")}` : undefined,
    "Continue the same task and return only the final completed result.",
    "Do not send an acknowledgement-only update.",
  ]
    .filter(Boolean)
    .join(" ");
  return enqueueFollowupRun(
    params.queueKey,
    {
      ...params.sourceRun,
      prompt,
      messageId: undefined,
      summaryLine: decision.reasons[0] ?? "semantic retry",
      enqueuedAt: Date.now(),
      automation: {
        source: "acceptance_retry",
        retryCount: retryCount + 1,
        persisted: true,
        reasonCode: "reasonCode" in decision ? decision.reasonCode : undefined,
        reasonSummary: decision.reasons.join(" "),
      },
    },
    params.settings,
    "prompt",
  );
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
  return {
    acceptanceOutcome,
    supervisorVerdict,
    queuedSemanticRetry: enqueueSemanticRetryFollowup({
      queueKey: params.candidate.queueKey,
      sourceRun: params.candidate.sourceRun,
      settings: params.candidate.settings,
      acceptance: acceptanceOutcome,
      supervisorVerdict,
    }),
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
