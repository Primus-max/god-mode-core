import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { loadSessionStore } from "../../config/sessions.js";
import {
  getPlatformRuntimeCheckpointService,
  type PlatformRuntimeAcceptanceEvidence,
  type PlatformRuntimeAcceptanceResult,
  type PlatformRuntimeRunOutcome,
} from "../../platform/runtime/index.js";
import { isAudioFileName } from "../../media/mime.js";
import { normalizeVerboseLevel, type VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import { enqueueFollowupRun, scheduleFollowupDrain, type FollowupRun, type QueueSettings } from "./queue.js";
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

const MAX_SEMANTIC_RETRY_COUNT = 1;

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
      acceptanceOutcome?: PlatformRuntimeAcceptanceResult;
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
  const stagedReplyCount = (params.stagedReplyPayloads ?? []).filter(isDeliverableReplyPayload).length;
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
    ...(params.runResult.successfulCronAdds !== undefined
      ? { successfulCronAdds: params.runResult.successfulCronAdds }
      : {}),
  };
}

export function reevaluateAcceptanceForMessagingRun(params: {
  runResult: MessagingDeliveryClosureCandidate["runResult"];
  replyPayloads: ReplyPayload[];
  deliveryReceipt?: Partial<MessagingDeliveryReceipt>;
}): PlatformRuntimeAcceptanceResult | undefined {
  const completionOutcome = params.runResult.meta?.completionOutcome;
  if (!completionOutcome?.runId) {
    return params.runResult.meta?.acceptanceOutcome;
  }
  return getPlatformRuntimeCheckpointService().evaluateAcceptance({
    runId: completionOutcome.runId,
    outcome: completionOutcome,
    evidence: buildMessagingAcceptanceEvidence({
      runResult: params.runResult,
      replyPayloads: params.replyPayloads,
      deliveryReceipt: params.deliveryReceipt,
    }),
  });
}

export function buildAcceptanceFallbackPayload(
  acceptance: PlatformRuntimeAcceptanceResult | undefined,
): ReplyPayload | undefined {
  if (!acceptance) {
    return undefined;
  }
  const reason = acceptance.reasons[0] ?? "The task needs additional handling.";
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
}): boolean {
  if (!params.queueKey || params.acceptance?.action !== "retry") {
    return false;
  }
  const retryCount = params.sourceRun.automation?.retryCount ?? 0;
  if (retryCount >= MAX_SEMANTIC_RETRY_COUNT) {
    return false;
  }
  const prompt = [
    "The previous run did not satisfy the task well enough.",
    params.acceptance.reasons.length > 0 ? `Observed issues: ${params.acceptance.reasons.join(" ")}` : undefined,
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
      summaryLine: params.acceptance.reasons[0] ?? "semantic retry",
      enqueuedAt: Date.now(),
      automation: {
        source: "acceptance_retry",
        retryCount: retryCount + 1,
        persisted: true,
        reasonCode: params.acceptance.reasonCode,
        reasonSummary: params.acceptance.reasons.join(" "),
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
  queuedSemanticRetry: boolean;
} {
  if (!params.candidate) {
    return { queuedSemanticRetry: false };
  }
  const acceptanceOutcome = reevaluateAcceptanceForMessagingRun({
    runResult: params.candidate.runResult,
    replyPayloads: params.replyPayloads,
    deliveryReceipt: params.deliveryReceipt,
  });
  return {
    acceptanceOutcome,
    queuedSemanticRetry: enqueueSemanticRetryFollowup({
      queueKey: params.candidate.queueKey,
      sourceRun: params.candidate.sourceRun,
      settings: params.candidate.settings,
      acceptance: acceptanceOutcome,
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
