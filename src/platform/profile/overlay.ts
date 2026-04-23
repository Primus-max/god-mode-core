import type { ArtifactKind, Profile, TaskOverlay } from "../schemas/index.js";
import type {
  CandidateExecutionFamily,
  OutcomeContract,
  QualificationExecutionContract,
} from "../decision/qualification-contract.js";
import type { ResolutionContract } from "../decision/resolution-contract.js";
import { getTaskOverlay } from "./defaults.js";
import { normalizeProfileHintList } from "./hints.js";
import type { ProfileSignalInput } from "./signals.js";

export type EffectiveProfilePreference = {
  profile: Profile;
  activeProfileId: Profile["id"];
  taskOverlay?: TaskOverlay;
  preferredTools: string[];
  preferredPublishTargets: string[];
  modelHints: string[];
  timeoutSeconds?: number;
};

export type ProfileOverlayInput = ProfileSignalInput & {
  outcomeContract?: OutcomeContract;
  executionContract?: QualificationExecutionContract;
  candidateFamilies?: CandidateExecutionFamily[];
  resolutionContract?: Pick<
    ResolutionContract,
    "candidateFamilies" | "selectedFamily" | "toolBundles"
  >;
};

function hasArtifactKinds(input: ProfileSignalInput, kinds: ArtifactKind[]): boolean {
  return (input.artifactKinds ?? []).some((kind) => kinds.includes(kind));
}

function getCandidateFamilies(input: ProfileOverlayInput): CandidateExecutionFamily[] {
  const families =
    input.resolutionContract?.candidateFamilies?.length
      ? input.resolutionContract.candidateFamilies
      : input.candidateFamilies ?? [];
  return Array.from(new Set(families));
}

export function resolveTaskOverlay(
  profile: Profile,
  input: ProfileOverlayInput,
): TaskOverlay | undefined {
  const bundles = new Set(input.resolutionContract?.toolBundles ?? []);
  const candidateFamilies = getCandidateFamilies(input);
  const selectedFamily = input.resolutionContract?.selectedFamily;
  const outcomeContract = input.outcomeContract;
  const executionContract = input.executionContract;
  const hasDocumentArtifact = hasArtifactKinds(input, ["document", "estimate", "report", "data"]);
  const hasMediaArtifact = hasArtifactKinds(input, ["image", "video", "audio"]);
  const hasDocumentFamily =
    selectedFamily === "document_render" || candidateFamilies.includes("document_render");
  const hasAnalysisFamily =
    selectedFamily === "analysis_transform" || candidateFamilies.includes("analysis_transform");
  const hasMediaFamily =
    selectedFamily === "media_generation" || candidateFamilies.includes("media_generation");

  if (
    outcomeContract === "text_response" &&
    bundles.has("respond_only") &&
    getTaskOverlay(profile, "general_chat")
  ) {
    return getTaskOverlay(profile, "general_chat");
  }

  if (
    (bundles.has("repo_mutation") ||
      bundles.has("repo_run") ||
      outcomeContract === "workspace_change") &&
    getTaskOverlay(profile, "code_first")
  ) {
    return getTaskOverlay(profile, "code_first");
  }

  if (
    (bundles.has("external_delivery") || outcomeContract === "external_operation") &&
    getTaskOverlay(profile, "integration_first")
  ) {
    return getTaskOverlay(profile, "integration_first");
  }

  if (
    executionContract?.mayNeedBootstrap &&
    getTaskOverlay(profile, "bootstrap_capability")
  ) {
    return getTaskOverlay(profile, "bootstrap_capability");
  }

  if (
    executionContract?.requiresLocalProcess &&
    !executionContract.mayNeedBootstrap &&
    getTaskOverlay(profile, "machine_control")
  ) {
    return getTaskOverlay(profile, "machine_control");
  }

  if (
    executionContract?.requiresLocalProcess &&
    getTaskOverlay(profile, "ops_first")
  ) {
    return getTaskOverlay(profile, "ops_first");
  }

  if (
    ((bundles.has("artifact_authoring") && hasMediaArtifact && !hasDocumentArtifact) ||
      hasMediaFamily) &&
    getTaskOverlay(profile, "media_first")
  ) {
    return getTaskOverlay(profile, "media_first");
  }

  if (
    (bundles.has("document_extraction") ||
      hasDocumentFamily ||
      hasAnalysisFamily ||
      (bundles.has("artifact_authoring") && outcomeContract === "structured_artifact") ||
      hasDocumentArtifact)
  ) {
    return getTaskOverlay(profile, "document_first");
  }

  if (
    bundles.has("external_delivery") &&
    (getTaskOverlay(profile, "publish_release") ||
      getTaskOverlay(profile, "publish_brief") ||
      getTaskOverlay(profile, "media_publish"))
  ) {
    return (
      getTaskOverlay(profile, "publish_release") ??
      getTaskOverlay(profile, "publish_brief") ??
      getTaskOverlay(profile, "media_publish")
    );
  }

  return undefined;
}

export function applyTaskOverlay(
  profile: Profile,
  taskOverlay: TaskOverlay | undefined,
): EffectiveProfilePreference {
  return {
    profile,
    activeProfileId: profile.id,
    taskOverlay,
    preferredTools: normalizeProfileHintList([
      ...(profile.preferredTools ?? []),
      ...(taskOverlay?.toolHints ?? []),
    ]),
    preferredPublishTargets: normalizeProfileHintList([
      ...(profile.preferredPublishTargets ?? []),
      ...(taskOverlay?.publishTargets ?? []),
    ]),
    modelHints: normalizeProfileHintList(taskOverlay?.modelHints ?? []),
    timeoutSeconds: taskOverlay?.timeoutSeconds,
  };
}
