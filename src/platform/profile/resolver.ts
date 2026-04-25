import type {
  ActiveProfileState,
  Profile,
  ProfileId,
  ProfileScoringSignal,
} from "../schemas/index.js";
import { ActiveProfileStateSchema, PROFILE_IDS } from "../schemas/index.js";
import type {
  CandidateExecutionFamily,
  OutcomeContract,
  QualificationExecutionContract,
} from "../decision/qualification-contract.js";
import type { ResolutionContract } from "../decision/resolution-contract.js";
import { getInitialProfile, INITIAL_PROFILES } from "./defaults.js";
import {
  applyTaskOverlay,
  resolveTaskOverlay,
  type EffectiveProfilePreference,
} from "./overlay.js";
import { extractProfileSignals, type ProfileSignalInput } from "./signals.js";

export type ProfileResolverInput = ProfileSignalInput & {
  baseProfile?: ProfileId;
  sessionProfile?: ProfileId;
  profiles?: Profile[];
  contractFirst?: boolean;
  outcomeContract?: OutcomeContract;
  executionContract?: QualificationExecutionContract;
  candidateFamilies?: CandidateExecutionFamily[];
  resolutionContract?: Pick<
    ResolutionContract,
    "candidateFamilies" | "routing" | "selectedFamily" | "toolBundles"
  >;
};

export type ProfileResolution = {
  activeProfile: ActiveProfileState;
  selectedProfile: Profile;
  effective: EffectiveProfilePreference;
  scores: Record<ProfileId, number>;
  signals: ProfileScoringSignal[];
};

function createScoreMap(): Record<ProfileId, number> {
  return Object.fromEntries(PROFILE_IDS.map((id) => [id, 0])) as Record<ProfileId, number>;
}

function clampConfidence(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function rankProfiles(scores: Record<ProfileId, number>, allowedIds: Set<ProfileId>): ProfileId[] {
  return Object.entries(scores)
    .filter(([id]) => allowedIds.has(id as ProfileId))
    .toSorted((a, b) => b[1] - a[1])
    .map(([id]) => id as ProfileId);
}

function pushSignal(
  signals: ProfileScoringSignal[],
  profileId: ProfileId,
  weight: number,
  reason: string,
  source: ProfileScoringSignal["source"] = "config",
) {
  signals.push({ source, profileId, weight, reason });
}

function getCandidateFamilies(input: ProfileResolverInput): CandidateExecutionFamily[] {
  const families =
    input.resolutionContract?.candidateFamilies?.length
      ? input.resolutionContract.candidateFamilies
      : input.candidateFamilies ?? [];
  return Array.from(new Set(families));
}

function hasAnyArtifact(input: ProfileResolverInput, kinds: string[]): boolean {
  return (input.artifactKinds ?? []).some((kind) => kinds.includes(kind));
}

function extractProfileSignalsFromContracts(input: ProfileResolverInput): ProfileScoringSignal[] {
  const signals: ProfileScoringSignal[] = [];
  const bundles = new Set(input.resolutionContract?.toolBundles ?? []);
  const candidateFamilies = getCandidateFamilies(input);
  const selectedFamily = input.resolutionContract?.selectedFamily;
  const outcomeContract = input.outcomeContract;
  const executionContract = input.executionContract;
  const routing = input.resolutionContract?.routing;
  const hasDocumentArtifact = hasAnyArtifact(input, ["document", "estimate", "report", "data"]);
  const hasMediaArtifact = hasAnyArtifact(input, ["image", "video", "audio"]);
  const hasAnalysisFamily =
    selectedFamily === "analysis_transform" || candidateFamilies.includes("analysis_transform");
  const hasDocumentFamily =
    selectedFamily === "document_render" || candidateFamilies.includes("document_render");
  const hasMediaFamily =
    selectedFamily === "media_generation" || candidateFamilies.includes("media_generation");
  const hasCodeFamily =
    selectedFamily === "code_build" || candidateFamilies.includes("code_build");
  const hasOpsFamily =
    selectedFamily === "ops_execution" || candidateFamilies.includes("ops_execution");

  if (bundles.has("document_extraction") || hasDocumentFamily || hasAnalysisFamily) {
    pushSignal(signals, "builder", 0.85, "document or analysis contract selected");
  }
  if (bundles.has("artifact_authoring") && outcomeContract === "structured_artifact") {
    if (hasDocumentArtifact || !hasMediaArtifact) {
      pushSignal(signals, "builder", 0.7, "structured artifact contract favors builder delivery");
    }
    if (hasMediaArtifact && !hasDocumentArtifact) {
      pushSignal(signals, "media_creator", 0.85, "structured media artifact contract selected");
    }
  }
  if (hasMediaFamily) {
    pushSignal(signals, "media_creator", 0.95, "media generation family selected");
  }
  if (
    bundles.has("repo_mutation") ||
    hasCodeFamily ||
    outcomeContract === "workspace_change" ||
    executionContract?.requiresWorkspaceMutation
  ) {
    pushSignal(signals, "developer", 0.95, "workspace or repository contract selected");
  }
  if (bundles.has("external_delivery") || outcomeContract === "external_operation") {
    if (executionContract?.requiresLocalProcess && !executionContract.requiresWorkspaceMutation) {
      pushSignal(signals, "operator", 0.9, "local operations delivery contract selected");
    } else if (
      bundles.has("repo_mutation") ||
      hasCodeFamily ||
      routing?.remoteProfile === "code"
    ) {
      pushSignal(signals, "developer", 0.95, "code-oriented delivery contract selected");
    } else {
      pushSignal(signals, "integrator", 0.9, "integration delivery contract selected");
    }
  }
  if (bundles.has("session_orchestration")) {
    pushSignal(signals, "operator", 1, "session orchestration contract selected");
  }
  if (
    executionContract?.requiresLocalProcess &&
    !bundles.has("external_delivery") &&
    (hasOpsFamily || outcomeContract === "interactive_local_result")
  ) {
    pushSignal(signals, "operator", 0.9, "local process contract selected");
  }
  if (
    outcomeContract === "text_response" &&
    bundles.has("respond_only") &&
    executionContract?.requiresTools === false
  ) {
    pushSignal(signals, "general", 1, "respond-only text contract selected");
  }
  if (signals.length === 0) {
    const hasContractSignals =
      Boolean(input.outcomeContract) ||
      Boolean(input.executionContract) ||
      (input.resolutionContract?.toolBundles?.length ?? 0) > 0 ||
      (input.candidateFamilies?.length ?? 0) > 0 ||
      (input.resolutionContract?.candidateFamilies?.length ?? 0) > 0;
    if (hasContractSignals) {
      pushSignal(signals, "general", 0.2, "default general profile");
    } else {
      return extractProfileSignals(input);
    }
  }
  return signals;
}

export function scoreProfiles(
  signals: ProfileScoringSignal[],
  baseProfile?: ProfileId,
  sessionProfile?: ProfileId,
): Record<ProfileId, number> {
  const scores = createScoreMap();
  for (const signal of signals) {
    scores[signal.profileId] += signal.weight;
  }
  if (baseProfile) {
    scores[baseProfile] += 0.2;
  }
  if (sessionProfile) {
    scores[sessionProfile] += 0.1;
  }
  return scores;
}

export function resolveProfile(input: ProfileResolverInput): ProfileResolution {
  const profiles = input.profiles ?? INITIAL_PROFILES;
  const allowedIds = new Set(profiles.map((profile) => profile.id));
  const signals = extractProfileSignalsFromContracts(input);
  const scores = scoreProfiles(signals, input.baseProfile, input.sessionProfile);
  const ranked = rankProfiles(scores, allowedIds);

  const inferredBaseProfile = input.baseProfile ?? ranked[0] ?? "general";
  const inferredSessionProfile =
    input.sessionProfile ?? input.baseProfile ?? ranked[0] ?? inferredBaseProfile;
  const pinnedProfile = input.sessionProfile ?? input.baseProfile;
  const selectedProfileId = pinnedProfile ?? inferredSessionProfile;
  const selectedProfile =
    profiles.find((profile) => profile.id === selectedProfileId) ??
    getInitialProfile(selectedProfileId) ??
    getInitialProfile("general") ??
    INITIAL_PROFILES[0];

  const taskOverlay = resolveTaskOverlay(selectedProfile, input);
  const totalScore = ranked.reduce((sum, id) => sum + scores[id], 0);
  const topScore = scores[inferredSessionProfile] ?? 0;
  const confidence = clampConfidence(totalScore > 0 ? topScore / totalScore : 0.2);

  const activeProfile = ActiveProfileStateSchema.parse({
    baseProfile: inferredBaseProfile,
    sessionProfile: inferredSessionProfile,
    taskOverlay: taskOverlay?.id,
    confidence,
    signals,
  });

  return {
    activeProfile,
    selectedProfile,
    effective: applyTaskOverlay(selectedProfile, taskOverlay),
    scores,
    signals,
  };
}
