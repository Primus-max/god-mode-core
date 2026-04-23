import type {
  OutcomeContract,
  QualificationExecutionContract,
  RequestedEvidenceKind,
} from "../decision/qualification-contract.js";
import {
  artifactSatisfiesDeliverable,
  type DeliverableSpec,
  listProducerEntries,
} from "../produce/registry.js";
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

const WORKSPACE_TOOL_NAMES = new Set(["exec", "process", "write", "apply_patch"]);
const PROCESS_EVIDENCE_TOOL_NAMES = new Set(["exec", "process"]);

export type CompletionEvidenceRequirements = {
  outcomeContract: OutcomeContract;
  executionContract: QualificationExecutionContract;
  requestedEvidence: RequestedEvidenceKind[];
  requiresStructuredEvidence: boolean;
};

export type PriorEvidenceProbe = {
  kind: "ledger";
  receipts: PlatformRuntimeExecutionReceipt[];
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
  sufficiencyReason?: "current_evidence" | "prior_evidence";
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

function readReceiptNumericMetadata(
  metadata: PlatformRuntimeExecutionReceipt["metadata"] | undefined,
  key: string,
): number | undefined {
  const value = metadata?.[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function readReceiptStringMetadata(
  metadata: PlatformRuntimeExecutionReceipt["metadata"] | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function hasExecReceiptRuntimeEvidence(receipt: PlatformRuntimeExecutionReceipt): boolean {
  if (receipt.kind !== "tool" || receipt.status !== "success") {
    return false;
  }
  const toolName = normalizeToolName(receipt.name);
  if (!PROCESS_EVIDENCE_TOOL_NAMES.has(toolName)) {
    return false;
  }
  const exitCode = readReceiptNumericMetadata(receipt.metadata, "exitCode");
  if (exitCode !== 0) {
    return false;
  }
  const stdout = readReceiptStringMetadata(receipt.metadata, "stdout");
  const url = readReceiptStringMetadata(receipt.metadata, "url");
  const pid = readReceiptNumericMetadata(receipt.metadata, "pid");
  return Boolean(stdout || url || (typeof pid === "number" && pid > 0));
}

/**
 * When a deliverable is declared, resolve the tool names that can produce it from the
 * ProducerRegistry — no hardcoded mapping. Returns an empty set when the deliverable
 * is missing or has no registered producer (in which case the caller falls back to
 * artifact-based matching).
 */
function resolveDeliverableToolNames(
  deliverable: DeliverableSpec | undefined,
): ReadonlySet<string> {
  if (!deliverable) {
    return new Set();
  }
  const accepted = new Set(
    deliverable.acceptedFormats.map((f) => f.trim().toLowerCase()),
  );
  const toolNames = new Set<string>();
  for (const entry of listProducerEntries()) {
    if (entry.kind !== deliverable.kind) {
      continue;
    }
    if (accepted.has(entry.format.toLowerCase())) {
      toolNames.add(normalizeToolName(entry.toolName));
    }
  }
  return toolNames;
}

/**
 * Generic acceptance check: do any of the receipts carry a producedArtifact that
 * satisfies the declared deliverable? This replaces the legacy tool-name whitelist
 * and works uniformly for pdf / docx / xlsx / csv / image / site — whatever the
 * classifier declared.
 */
function hasAcceptableProducedArtifact(params: {
  receipts: PlatformRuntimeExecutionReceipt[];
  deliverable: DeliverableSpec | undefined;
}): boolean {
  if (!params.deliverable) {
    return false;
  }
  for (const receipt of params.receipts) {
    if (receipt.kind !== "tool" || receipt.status !== "success") {
      continue;
    }
    for (const artifact of receipt.producedArtifacts ?? []) {
      if (artifactSatisfiesDeliverable(params.deliverable, artifact)) {
        return true;
      }
    }
  }
  return false;
}

function hasMatchingStructuredArtifactToolReceipt(params: {
  receipts: PlatformRuntimeExecutionReceipt[];
  deliverable?: DeliverableSpec;
  artifactKinds?: readonly string[];
}): boolean {
  // Contract-first: when deliverable is declared, the producedArtifact MUST satisfy it.
  // No kind-only fallback — that would accept a pdf for a docx deliverable.
  if (params.deliverable) {
    return hasAcceptableProducedArtifact({
      receipts: params.receipts,
      deliverable: params.deliverable,
    });
  }
  // Legacy path: deliverable not set. Accept any successful tool receipt that produced
  // ANY artifact whose kind matches the declared artifactKinds. Callers migrating to
  // the contract-first model should populate deliverable instead.
  const structuredKinds = new Set(
    (params.artifactKinds ?? []).filter((kind) =>
      STRUCTURED_ARTIFACT_KINDS.has(kind as ArtifactKind),
    ),
  );
  if (structuredKinds.size === 0) {
    return false;
  }
  return params.receipts.some((receipt) => {
    if (receipt.kind !== "tool" || receipt.status !== "success") {
      return false;
    }
    return (receipt.producedArtifacts ?? []).some((artifact) =>
      structuredKinds.has(artifact.kind),
    );
  });
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
  executionIntent?: PlatformRuntimeExecutionIntent,
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
  const hasDeclaredBootstrapNeed =
    (executionIntent?.requiredCapabilities?.length ?? 0) > 0 ||
    (executionIntent?.bootstrapRequiredCapabilities?.length ?? 0) > 0;
  if (executionContract.mayNeedBootstrap && hasDeclaredBootstrapNeed) {
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

function buildEffectiveReceipts(params: {
  receipts: PlatformRuntimeExecutionReceipt[];
  priorEvidence?: PriorEvidenceProbe[];
}): PlatformRuntimeExecutionReceipt[] {
  const effectiveReceipts = [...params.receipts];
  for (const probe of params.priorEvidence ?? []) {
    effectiveReceipts.push(...probe.receipts);
  }
  return effectiveReceipts;
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
      ? [...params.executionIntent.requestedEvidence].filter(
          (kind) =>
            kind !== "capability_receipt" ||
            (params.executionIntent?.requiredCapabilities?.length ?? 0) > 0 ||
            (params.executionIntent?.bootstrapRequiredCapabilities?.length ?? 0) > 0,
        )
      : buildDefaultRequestedEvidence(outcomeContract, executionContract, params.executionIntent);

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
  deliverable?: DeliverableSpec;
  receipts: PlatformRuntimeExecutionReceipt[];
  priorEvidence?: PriorEvidenceProbe[];
  evidence: PlatformRuntimeAcceptanceEvidence;
  outcome?: PlatformRuntimeRunOutcome;
}): ObservedCompletionEvidence {
  const effectiveReceipts = buildEffectiveReceipts({
    receipts: params.receipts,
    priorEvidence: params.priorEvidence,
  });
  const matchingArtifactToolReceipt = hasMatchingStructuredArtifactToolReceipt({
    receipts: effectiveReceipts,
    deliverable: params.deliverable,
    artifactKinds: params.artifactKinds,
  });

  // Block the verifiedExecution shortcut only when we have actual receipts to inspect, a deliverable
  // is declared AND none of the receipts carry a producedArtifact that satisfies it. This prevents
  // generic exec/write completions from masquerading as structured artifact evidence.
  //
  // When receipts is empty (evaluateAcceptance always passes []), we trust verifiedExecution as a
  // proxy — it is only set to true when verifyExecutionContract already confirmed the right tools
  // ran. Blocking it there would break the acceptance path for legitimate artifact runs.
  const deliverableExpectsArtifact =
    Boolean(params.deliverable) ||
    (params.artifactKinds ?? []).some((k) => STRUCTURED_ARTIFACT_KINDS.has(k as ArtifactKind));
  const wrongToolReceiptsPresent =
    effectiveReceipts.length > 0 && deliverableExpectsArtifact && !matchingArtifactToolReceipt;
  const canUseVerifiedExecutionShortcut =
    !wrongToolReceiptsPresent &&
    params.evidence.verifiedExecution === true &&
    (params.evidence.verifiedExecutionReceiptCount ?? 0) > 0 &&
    params.evidence.hasOutput === true;

  const verifiedDeliveryReceiptCount = effectiveReceipts.filter(
    (receipt) =>
      receipt.kind === "messaging_delivery" &&
      receipt.status === "success" &&
      receipt.proof === "verified",
  ).length;
  const successfulToolReceiptCount = effectiveReceipts.filter(
    (receipt) => receipt.kind === "tool" && receipt.status === "success",
  ).length;
  const successfulWorkspaceToolReceiptCount = effectiveReceipts.filter(
    (receipt) =>
      receipt.kind === "tool" &&
      receipt.status === "success" &&
      WORKSPACE_TOOL_NAMES.has(normalizeToolName(receipt.name)),
  ).length;
  const successfulProcessReceiptCount = Math.max(
    params.evidence.confirmedActionCount ?? 0,
    params.outcome?.confirmedActionIds.length ?? 0,
    effectiveReceipts.filter(
      (receipt) =>
        hasExecReceiptRuntimeEvidence(receipt) ||
        (receipt.kind === "platform_action" &&
          receipt.status === "success" &&
          receipt.proof === "verified"),
    ).length,
  );
  const successfulCapabilityReceiptCount =
    effectiveReceipts.filter(
      (receipt) => receipt.kind === "capability" && receipt.status === "success",
    ).length +
    (params.outcome?.bootstrapRequestIds.length ?? 0);

  return {
    assistantText: params.evidence.hasOutput === true,
    toolReceipt:
      params.requirements.outcomeContract === "structured_artifact"
        ? matchingArtifactToolReceipt || canUseVerifiedExecutionShortcut
        : params.requirements.outcomeContract === "workspace_change"
          ? successfulWorkspaceToolReceiptCount > 0
          : successfulToolReceiptCount > 0,
    artifactDescriptor:
      params.evidence.hasStructuredReplyPayload === true ||
      (params.outcome?.artifactIds.length ?? 0) > 0 ||
      matchingArtifactToolReceipt ||
      canUseVerifiedExecutionShortcut,
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
  priorEvidence?: PriorEvidenceProbe[];
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
    ...(params.executionIntent?.deliverable
      ? { deliverable: params.executionIntent.deliverable }
      : {}),
    receipts: params.receipts,
    priorEvidence: params.priorEvidence,
    evidence: params.evidence ?? {},
    outcome: params.outcome,
  });
  const observedFromCurrentReceipts = observeEvidence({
    requirements,
    artifactKinds: params.executionIntent?.artifactKinds ?? params.evidence?.declaredArtifactKinds,
    ...(params.executionIntent?.deliverable
      ? { deliverable: params.executionIntent.deliverable }
      : {}),
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

  const missingCurrentEvidence = requirements.requestedEvidence.filter((kind) => {
    switch (kind) {
      case "assistant_text":
        return !observedFromCurrentReceipts.assistantText;
      case "tool_receipt":
        return !observedFromCurrentReceipts.toolReceipt;
      case "artifact_descriptor":
        return !observedFromCurrentReceipts.artifactDescriptor;
      case "process_receipt":
        return !observedFromCurrentReceipts.processReceipt;
      case "delivery_receipt":
        return !observedFromCurrentReceipts.deliveryReceipt;
      case "capability_receipt":
        return !observedFromCurrentReceipts.capabilityReceipt;
      default:
        return true;
    }
  });

  const sufficient = missingEvidence.length === 0;
  const hasPriorEvidence = (params.priorEvidence?.some((probe) => probe.receipts.length > 0) ?? false) === true;
  const sufficiencyReason =
    !sufficient
      ? undefined
      : hasPriorEvidence && missingCurrentEvidence.length > 0
        ? "prior_evidence"
        : "current_evidence";

  return {
    sufficient,
    ...(sufficiencyReason ? { sufficiencyReason } : {}),
    requirements,
    observed,
    missingEvidence,
    reasons,
  };
}

export function hasStructuredArtifactToolOutputReceipt(params: {
  receipts: PlatformRuntimeExecutionReceipt[];
  deliverable?: DeliverableSpec;
  artifactKinds?: readonly string[];
  /** @deprecated kept for backward compatibility; no longer used for tool-name heuristics. */
  requestedToolNames?: readonly string[];
}): boolean {
  return hasMatchingStructuredArtifactToolReceipt({
    receipts: params.receipts,
    ...(params.deliverable ? { deliverable: params.deliverable } : {}),
    ...(params.artifactKinds ? { artifactKinds: params.artifactKinds } : {}),
  });
}

export { hasAcceptableProducedArtifact, resolveDeliverableToolNames };
