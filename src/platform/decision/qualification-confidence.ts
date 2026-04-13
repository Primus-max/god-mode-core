import type {
  CandidateExecutionFamily,
  OutcomeContract,
  QualificationConfidence,
  QualificationExecutionContract,
  QualificationLowConfidenceStrategy,
} from "./qualification-contract.js";

type QualificationSignalSnapshot = {
  outcomeContract: OutcomeContract;
  executionContract: QualificationExecutionContract;
  candidateFamilies: CandidateExecutionFamily[];
  intent?: string;
  artifactKinds?: string[];
  requestedTools?: string[];
  publishTargets?: string[];
};

function classifyArtifactSurfaces(artifactKinds: string[]): string[] {
  const surfaces = new Set<string>();
  if (artifactKinds.some((kind) => ["document", "estimate"].includes(kind))) {
    surfaces.add("document");
  }
  if (artifactKinds.some((kind) => ["image", "video", "audio"].includes(kind))) {
    surfaces.add("media");
  }
  if (artifactKinds.some((kind) => ["site", "binary", "archive"].includes(kind))) {
    surfaces.add("workspace");
  }
  if (artifactKinds.some((kind) => ["release"].includes(kind))) {
    surfaces.add("delivery");
  }
  return Array.from(surfaces);
}

function ambiguityPenalty(reason: string): number {
  if (
    reason.includes("without an explicit publish target") ||
    reason.includes("without an explicit execution tool") ||
    reason.includes("without explicit artifact kinds")
  ) {
    return 2;
  }
  return 1;
}

export function inferQualificationAmbiguityReasons(
  params: QualificationSignalSnapshot,
): string[] {
  const reasons: string[] = [];
  const artifactKinds = params.artifactKinds ?? [];
  const requestedTools = params.requestedTools ?? [];
  const publishTargets = params.publishTargets ?? [];
  const artifactSurfaces = classifyArtifactSurfaces(artifactKinds);

  if (params.candidateFamilies.length > 1 && !params.intent) {
    reasons.push(
      `multiple candidate families remain without an explicit intent anchor (${params.candidateFamilies.join(", ")})`,
    );
  }
  if (artifactSurfaces.length > 1) {
    reasons.push(
      `requested artifacts span multiple execution surfaces (${artifactSurfaces.join(", ")})`,
    );
  }
  if (params.outcomeContract === "external_operation" && publishTargets.length === 0) {
    reasons.push("external operation is inferred without an explicit publish target");
  }
  if (
    params.outcomeContract === "workspace_change" &&
    !requestedTools.some((tool) => tool === "exec" || tool === "apply_patch" || tool === "process")
  ) {
    reasons.push("workspace change is inferred without an explicit execution tool");
  }
  if (params.outcomeContract === "structured_artifact" && artifactKinds.length === 0) {
    reasons.push("structured artifact is inferred without explicit artifact kinds");
  }

  return reasons;
}

export function computeQualificationConfidence(
  params: QualificationSignalSnapshot & { ambiguityReasons?: string[] },
): QualificationConfidence {
  const artifactKinds = params.artifactKinds ?? [];
  const requestedTools = params.requestedTools ?? [];
  const publishTargets = params.publishTargets ?? [];
  const ambiguityReasons = params.ambiguityReasons ?? [];

  let score = 0;
  if (params.intent) {
    score += 2;
  }
  if (artifactKinds.length > 0) {
    score += 2;
  }
  if (requestedTools.length > 0) {
    score += 1;
  }
  if (publishTargets.length > 0) {
    score += 1;
  }
  if (params.candidateFamilies.length === 1) {
    score += 2;
  } else if (params.candidateFamilies.length === 2) {
    score += 1;
  }
  if (
    params.executionContract.requiresArtifactEvidence ||
    params.executionContract.requiresWorkspaceMutation ||
    params.executionContract.requiresLocalProcess
  ) {
    score += 1;
  }
  score -= ambiguityReasons.reduce((sum, reason) => sum + ambiguityPenalty(reason), 0);

  if (
    params.outcomeContract === "text_response" &&
    params.candidateFamilies.length === 1 &&
    ambiguityReasons.length === 0
  ) {
    return params.intent === "general" || score >= 3 ? "high" : "medium";
  }
  if (score >= 6) {
    return "high";
  }
  if (score >= 3) {
    return "medium";
  }
  return "low";
}

export function resolveLowConfidenceStrategy(
  params: QualificationSignalSnapshot & {
    confidence: QualificationConfidence;
    ambiguityReasons?: string[];
  },
): QualificationLowConfidenceStrategy | undefined {
  const ambiguityReasons = params.ambiguityReasons ?? [];
  if (params.confidence === "high" && ambiguityReasons.length === 0) {
    return undefined;
  }

  if (
    ambiguityReasons.some((reason) => reason.includes("without an explicit publish target")) ||
    (params.confidence === "low" &&
      !params.executionContract.requiresArtifactEvidence &&
      !params.executionContract.requiresWorkspaceMutation &&
      !params.executionContract.requiresLocalProcess)
  ) {
    return "clarify";
  }

  if (
    params.executionContract.requiresArtifactEvidence ||
    params.executionContract.requiresWorkspaceMutation ||
    params.executionContract.requiresLocalProcess
  ) {
    return "bounded_attempt_with_strict_verification";
  }

  if (params.candidateFamilies.length > 1 || ambiguityReasons.length > 0) {
    return "safe_broad_family_execution";
  }

  return params.confidence === "low" ? "clarify" : undefined;
}
