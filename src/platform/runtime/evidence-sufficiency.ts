import type {
  OutcomeContract,
  QualificationExecutionContract,
  RequestedEvidenceKind,
} from "../decision/qualification-contract.js";
import type { ArtifactKind } from "../schemas/index.js";
import type {
  PlatformRuntimeAcceptanceEvidence,
  PlatformRuntimeExecutionContract,
  PlatformRuntimeExecutionIntent,
  PlatformRuntimeExecutionReceipt,
  PlatformRuntimeRunOutcome,
} from "./contracts.js";

const STRUCTURED_ARTIFACT_KINDS = new Set<ArtifactKind>([
  "document",
  "estimate",
  "image",
  "video",
  "audio",
  "archive",
  "release",
  "binary",
]);

const STRUCTURED_ARTIFACT_TOOL_NAMES_BY_KIND: Partial<Record<ArtifactKind, readonly string[]>> = {
  document: ["pdf"],
  image: ["image_generate", "image"],
  video: ["video_generate", "video"],
  audio: ["audio_generate", "audio", "tts", "voiceover"],
  archive: ["exec", "write", "apply_patch"],
  release: ["exec", "write", "apply_patch"],
  binary: ["exec", "write", "apply_patch"],
};

const PROCESS_TOOL_NAMES = new Set(["exec", "process", "write", "apply_patch"]);

export type CompletionEvidenceRequirements = {
  outcomeContract: OutcomeContract;
  executionContract: QualificationExecutionContract;
  requestedEvidence: RequestedEvidenceKind[];
  requiresStructuredEvidence: boolean;
};

export type ObservedCompletionEvidence = {
  assistantText: boolean;
  toolReceipt: boolean;
  artifactDescriptor: boolean;
  processReceipt: boolean;
  deliveryReceipt: boolean;
  capabilityReceipt: boolean;
  matchingArtifactToolReceipt: boolean;
};

export type CompletionEvidenceSufficiency = {
  sufficient: boolean;
  requirements: CompletionEvidenceRequirements;
  observed: ObservedCompletionEvidence;
  missingEvidence: RequestedEvidenceKind[];
  reasons: string[];
};

function hasStructuredArtifactKinds(artifactKinds?: readonly string[]): boolean {
  return Boolean(
    artifactKinds?.some((kind) => STRUCTURED_ARTIFACT_KINDS.has(kind as ArtifactKind)),
  );
}

export function requiresStructuredEvidence(params: {
  outcomeContract?: OutcomeContract;
  artifactKinds?: readonly string[];
  executionContract?: Partial<QualificationExecutionContract>;
}): boolean {
  if (params.executionContract?.requiresArtifactEvidence === true) {
    return true;
  }
  if (params.outcomeContract === "structured_artifact") {
    return true;
  }
  return hasStructuredArtifactKinds(params.artifactKinds);
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

function hasMatchingStructuredArtifactToolReceipt(params: {
  receipts: PlatformRuntimeExecutionReceipt[];
  artifactKinds?: readonly string[];
}): boolean {
  const expectedToolNames = new Set<string>();
  for (const kind of params.artifactKinds ?? []) {
    for (const toolName of STRUCTURED_ARTIFACT_TOOL_NAMES_BY_KIND[kind as ArtifactKind] ?? []) {
      expectedToolNames.add(toolName);
    }
  }
  if (expectedToolNames.size === 0) {
    return false;
  }
  return params.receipts.some(
    (receipt) =>
      receipt.kind === "tool" &&
      receipt.status === "success" &&
      expectedToolNames.has(normalizeToolName(receipt.name)),
  );
}

function inferOutcomeContract(executionIntent?: PlatformRuntimeExecutionIntent): OutcomeContract {
  if (executionIntent?.outcomeContract) {
    return executionIntent.outcomeContract;
  }

  const artifactKinds = executionIntent?.artifactKinds ?? [];
  if (artifactKinds.includes("site")) {
    return "interactive_local_result";
  }
  if (hasStructuredArtifactKinds(artifactKinds)) {
    return "structured_artifact";
  }
  if (executionIntent?.intent === "publish" || (executionIntent?.publishTargets?.length ?? 0) > 0) {
    return "external_operation";
  }
  if (executionIntent?.intent === "code") {
    return "workspace_change";
  }
  return "text_response";
}

function buildFallbackExecutionContract(params: {
  outcomeContract: OutcomeContract;
  executionIntent?: PlatformRuntimeExecutionIntent;
}): QualificationExecutionContract {
  const maybeBootstrap =
    (params.executionIntent?.bootstrapRequiredCapabilities?.length ?? 0) > 0 ||
    (params.executionIntent?.requiredCapabilities?.length ?? 0) > 0;

  switch (params.outcomeContract) {
    case "structured_artifact":
      return {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: true,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: maybeBootstrap,
      };
    case "workspace_change":
      return {
        requiresTools: true,
        requiresWorkspaceMutation: true,
        requiresLocalProcess: false,
        requiresArtifactEvidence: false,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: maybeBootstrap,
      };
    case "interactive_local_result":
      return {
        requiresTools: true,
        requiresWorkspaceMutation: true,
        requiresLocalProcess: true,
        requiresArtifactEvidence: false,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: maybeBootstrap,
      };
    case "external_operation":
      return {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: false,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: maybeBootstrap,
      };
    case "text_response":
    default:
      return {
        requiresTools: false,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: false,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: maybeBootstrap,
      };
  }
}

function mergeExecutionContract(params: {
  outcomeContract: OutcomeContract;
  executionIntent?: PlatformRuntimeExecutionIntent;
  expectations?: PlatformRuntimeExecutionContract["expectations"];
}): QualificationExecutionContract {
  const fallback = buildFallbackExecutionContract(params);
  const declared = params.executionIntent?.executionContract;
  return {
    ...fallback,
    ...(declared ?? {}),
    requiresLocalProcess:
      declared?.requiresLocalProcess ??
      fallback.requiresLocalProcess ??
      params.expectations?.requiresConfirmedAction === true,
    requiresDeliveryEvidence:
      declared?.requiresDeliveryEvidence ??
      fallback.requiresDeliveryEvidence ??
      params.expectations?.requiresMessagingDelivery === true,
  };
}

function buildDefaultRequestedEvidence(
  outcomeContract: OutcomeContract,
  executionContract: QualificationExecutionContract,
): RequestedEvidenceKind[] {
  const evidence = new Set<RequestedEvidenceKind>();

  switch (outcomeContract) {
    case "structured_artifact":
      evidence.add("tool_receipt");
      evidence.add("artifact_descriptor");
      break;
    case "workspace_change":
      evidence.add("tool_receipt");
      break;
    case "interactive_local_result":
      evidence.add("tool_receipt");
      evidence.add("process_receipt");
      break;
    case "external_operation":
      evidence.add("tool_receipt");
      break;
    case "text_response":
    default:
      evidence.add("assistant_text");
      break;
  }

  if (executionContract.requiresDeliveryEvidence) {
    evidence.add("delivery_receipt");
  }
  if (executionContract.mayNeedBootstrap) {
    evidence.add("capability_receipt");
  }

  return Array.from(evidence);
}

function buildClarificationTurnRequirements(): CompletionEvidenceRequirements {
  const outcomeContract: OutcomeContract = "text_response";
  const executionContract: QualificationExecutionContract = {
    requiresTools: false,
    requiresWorkspaceMutation: false,
    requiresLocalProcess: false,
    requiresArtifactEvidence: false,
    requiresDeliveryEvidence: false,
    mayNeedBootstrap: false,
  };
  return {
    outcomeContract,
    executionContract,
    requestedEvidence: buildDefaultRequestedEvidence(outcomeContract, executionContract),
    requiresStructuredEvidence: false,
  };
}

export function mapQualificationToEvidenceRequirements(params: {
  executionIntent?: PlatformRuntimeExecutionIntent;
  expectations?: PlatformRuntimeExecutionContract["expectations"];
}): CompletionEvidenceRequirements {
  if (params.executionIntent?.lowConfidenceStrategy === "clarify") {
    return buildClarificationTurnRequirements();
  }
  const outcomeContract = inferOutcomeContract(params.executionIntent);
  const executionContract = mergeExecutionContract({
    outcomeContract,
    executionIntent: params.executionIntent,
    expectations: params.expectations,
  });
  const requestedEvidence =
    params.executionIntent?.requestedEvidence?.length
      ? [...params.executionIntent.requestedEvidence]
      : buildDefaultRequestedEvidence(outcomeContract, executionContract);

  return {
    outcomeContract,
    executionContract,
    requestedEvidence,
    requiresStructuredEvidence: requiresStructuredEvidence({
      outcomeContract,
      artifactKinds: params.executionIntent?.artifactKinds,
      executionContract,
    }),
  };
}

function observeEvidence(params: {
  requirements: CompletionEvidenceRequirements;
  artifactKinds?: readonly string[];
  receipts: PlatformRuntimeExecutionReceipt[];
  evidence: PlatformRuntimeAcceptanceEvidence;
  outcome?: PlatformRuntimeRunOutcome;
}): ObservedCompletionEvidence {
  const matchingArtifactToolReceipt = hasMatchingStructuredArtifactToolReceipt({
    receipts: params.receipts,
    artifactKinds: params.artifactKinds,
  });
  const verifiedDeliveryReceiptCount = params.receipts.filter(
    (receipt) =>
      receipt.kind === "messaging_delivery" &&
      receipt.status === "success" &&
      receipt.proof === "verified",
  ).length;
  const successfulToolReceiptCount = params.receipts.filter(
    (receipt) => receipt.kind === "tool" && receipt.status === "success",
  ).length;
  const successfulProcessReceiptCount =
    params.evidence.confirmedActionCount ??
    params.outcome?.confirmedActionIds.length ??
    params.receipts.filter(
      (receipt) =>
        (receipt.kind === "tool" && PROCESS_TOOL_NAMES.has(normalizeToolName(receipt.name))) ||
        (receipt.kind === "platform_action" &&
          receipt.status === "success" &&
          receipt.proof === "verified"),
    ).length;
  const successfulCapabilityReceiptCount =
    params.receipts.filter(
      (receipt) => receipt.kind === "capability" && receipt.status === "success",
    ).length +
    (params.outcome?.bootstrapRequestIds.length ?? 0);

  return {
    assistantText: params.evidence.hasOutput === true,
    toolReceipt:
      params.requirements.outcomeContract === "structured_artifact"
        ? matchingArtifactToolReceipt ||
          (params.evidence.verifiedExecution === true &&
            (params.evidence.verifiedExecutionReceiptCount ?? 0) > 0 &&
            params.evidence.hasOutput === true)
        : successfulToolReceiptCount > 0,
    artifactDescriptor:
      params.evidence.hasStructuredReplyPayload === true ||
      (params.outcome?.artifactIds.length ?? 0) > 0 ||
      matchingArtifactToolReceipt ||
      (params.evidence.verifiedExecution === true &&
        (params.evidence.verifiedExecutionReceiptCount ?? 0) > 0 &&
        params.evidence.hasOutput === true),
    processReceipt: successfulProcessReceiptCount > 0,
    deliveryReceipt:
      Math.max(
        params.evidence.confirmedDeliveryCount ?? 0,
        params.evidence.deliveredReplyCount ?? 0,
        verifiedDeliveryReceiptCount,
      ) > 0,
    capabilityReceipt: successfulCapabilityReceiptCount > 0,
    matchingArtifactToolReceipt,
  };
}

export function isCompletionEvidenceSufficient(params: {
  executionIntent?: PlatformRuntimeExecutionIntent;
  expectations?: PlatformRuntimeExecutionContract["expectations"];
  receipts: PlatformRuntimeExecutionReceipt[];
  evidence?: PlatformRuntimeAcceptanceEvidence;
  outcome?: PlatformRuntimeRunOutcome;
}): CompletionEvidenceSufficiency {
  const requirements = mapQualificationToEvidenceRequirements({
    executionIntent: params.executionIntent,
    expectations: params.expectations,
  });
  const observed = observeEvidence({
    requirements,
    artifactKinds: params.executionIntent?.artifactKinds ?? params.evidence?.declaredArtifactKinds,
    receipts: params.receipts,
    evidence: params.evidence ?? {},
    outcome: params.outcome,
  });

  const missingEvidence = requirements.requestedEvidence.filter((kind) => {
    switch (kind) {
      case "assistant_text":
        return !observed.assistantText;
      case "tool_receipt":
        return !observed.toolReceipt;
      case "artifact_descriptor":
        return !observed.artifactDescriptor;
      case "process_receipt":
        return !observed.processReceipt;
      case "delivery_receipt":
        return !observed.deliveryReceipt;
      case "capability_receipt":
        return !observed.capabilityReceipt;
      default:
        return true;
    }
  });

  const reasons = missingEvidence.map((kind) => {
    switch (kind) {
      case "assistant_text":
        return "Execution did not produce assistant text evidence.";
      case "tool_receipt":
        return requirements.outcomeContract === "structured_artifact"
          ? "Structured artifact completion requires a matching successful tool receipt."
          : "Execution did not produce a successful tool receipt.";
      case "artifact_descriptor":
        return "Structured artifact completion requires a tangible artifact descriptor or attachment evidence.";
      case "process_receipt":
        return "Interactive or process-backed completion requires process evidence, not just text.";
      case "delivery_receipt":
        return "Execution required a confirmed delivery receipt before closure.";
      case "capability_receipt":
        return "Execution still lacks capability/bootstrap evidence.";
      default:
        return "Execution evidence is incomplete.";
    }
  });

  return {
    sufficient: missingEvidence.length === 0,
    requirements,
    observed,
    missingEvidence,
    reasons,
  };
}

export function hasStructuredArtifactToolOutputReceipt(params: {
  receipts: PlatformRuntimeExecutionReceipt[];
  artifactKinds?: readonly string[];
}): boolean {
  return hasMatchingStructuredArtifactToolReceipt(params);
}
