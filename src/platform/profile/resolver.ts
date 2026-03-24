import type {
  ActiveProfileState,
  Profile,
  ProfileId,
  ProfileScoringSignal,
} from "../schemas/index.js";
import { ActiveProfileStateSchema, PROFILE_IDS } from "../schemas/index.js";
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
  const signals = extractProfileSignals(input);
  const scores = scoreProfiles(signals, input.baseProfile, input.sessionProfile);
  const ranked = rankProfiles(scores, allowedIds);

  const inferredBaseProfile = input.baseProfile ?? ranked[0] ?? "general";
  const inferredSessionProfile = ranked[0] ?? inferredBaseProfile;
  const selectedProfile =
    profiles.find((profile) => profile.id === inferredSessionProfile) ??
    getInitialProfile(inferredSessionProfile) ??
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
